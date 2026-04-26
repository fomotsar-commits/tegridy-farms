// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../../src/TegridyPair.sol";
import "../../src/TegridyFactory.sol";

/// @title Pair invariant suite (R061)
/// @notice Stateful invariants for `TegridyPair` covering K-grows-by-fees-only
///         and LP-supply conservation. Builds on top of (does not replace) the
///         FuzzInvariant.t.sol kNeverDecreases / minimumLiquidityLocked /
///         reservesMatchBalances trio identified by audit agent 036.
///
///         fail_on_revert is left at the foundry.toml default (false) so
///         handler-bound reverts (slippage, paused, bound limits) don't fail
///         the run — invariants assert post-state instead.

contract PairR061Token is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Narrow attack surface — only swap and mint, both bounded so they
///         don't trivially revert. burn/skim/sync excluded for now (existing
///         FuzzInvariant.t.sol covers donation paths once it lands).
contract PairR061Handler is Test {
    TegridyPair public pair;
    PairR061Token public t0;
    PairR061Token public t1;
    address public actor;

    // Recorded reserves immediately before each handler action — used by the
    // K-grows-by-fees invariant to prove the swap leg respected the fee curve.
    uint112 public lastR0;
    uint112 public lastR1;
    bool public didSwap;
    uint256 public lastAmount0In;
    uint256 public lastAmount1In;

    constructor(TegridyPair _pair, PairR061Token _t0, PairR061Token _t1, address _actor) {
        pair = _pair;
        t0 = _t0;
        t1 = _t1;
        actor = _actor;
    }

    function _snapshot() internal {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        lastR0 = r0;
        lastR1 = r1;
        didSwap = false;
        lastAmount0In = 0;
        lastAmount1In = 0;
    }

    function doMint(uint256 amount) external {
        _snapshot();
        amount = bound(amount, 1e15, 100_000 ether);
        vm.startPrank(actor);
        t0.transfer(address(pair), amount);
        t1.transfer(address(pair), amount);
        try pair.mint(actor) returns (uint256) {} catch {}
        vm.stopPrank();
    }

    function doSwapAForB(uint256 amountIn) external {
        _snapshot();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        if (r0 == 0 || r1 == 0) return;
        amountIn = bound(amountIn, 1e15, uint256(r0) / 3);
        // Compute expected out using the 0.3% fee curve.
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * uint256(r1);
        uint256 denominator = uint256(r0) * 1000 + amountInWithFee;
        uint256 amountOut = numerator / denominator;
        if (amountOut == 0) return;
        vm.startPrank(actor);
        t0.transfer(address(pair), amountIn);
        try pair.swap(0, amountOut, actor, "") {
            didSwap = true;
            lastAmount0In = amountIn;
        } catch {}
        vm.stopPrank();
    }

    function doSwapBForA(uint256 amountIn) external {
        _snapshot();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        if (r0 == 0 || r1 == 0) return;
        amountIn = bound(amountIn, 1e15, uint256(r1) / 3);
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * uint256(r0);
        uint256 denominator = uint256(r1) * 1000 + amountInWithFee;
        uint256 amountOut = numerator / denominator;
        if (amountOut == 0) return;
        vm.startPrank(actor);
        t1.transfer(address(pair), amountIn);
        try pair.swap(amountOut, 0, actor, "") {
            didSwap = true;
            lastAmount1In = amountIn;
        } catch {}
        vm.stopPrank();
    }
}

contract PairInvariantsTest is Test {
    TegridyFactory public factory;
    TegridyPair public pair;
    PairR061Token public t0;
    PairR061Token public t1;
    PairR061Handler public handler;
    address public actor = makeAddr("r061_pair_actor");

    function setUp() public {
        factory = new TegridyFactory(address(this), address(this));
        t0 = new PairR061Token("T0", "T0");
        t1 = new PairR061Token("T1", "T1");
        if (address(t0) > address(t1)) (t0, t1) = (t1, t0);

        pair = TegridyPair(factory.createPair(address(t0), address(t1)));

        // Seed actor with both tokens.
        t0.transfer(actor, 100_000_000 ether);
        t1.transfer(actor, 100_000_000 ether);

        // Initial liquidity so the curve is non-degenerate.
        t0.transfer(address(pair), 1_000_000 ether);
        t1.transfer(address(pair), 1_000_000 ether);
        pair.mint(address(this));

        handler = new PairR061Handler(pair, t0, t1, actor);
        targetContract(address(handler));
    }

    /// @notice invariant_LPBalanceSumEqTotalSupply — sum of LP holders' balances
    ///         (this contract, actor, dead address) equals totalSupply. Guards
    ///         against silent supply drift from a buggy mint/burn path.
    function invariant_LPBalanceSumEqTotalSupply() public view {
        uint256 sum =
            pair.balanceOf(address(this)) +
            pair.balanceOf(actor) +
            pair.balanceOf(address(0xdead)) +
            pair.balanceOf(address(pair));
        assertEq(sum, pair.totalSupply(), "R061 LP supply drift");
    }

    /// @notice invariant_kGrowsByFeesOnly — canonical Uniswap V2 K-invariant:
    ///         after any swap, balance0Adj * balance1Adj >= reserve0_old *
    ///         reserve1_old * 1000^2, where balanceXAdj = balanceX_new * 1000
    ///         - amountXIn * 3 (the 0.3% fee carved out of the input leg).
    ///         Catches fee-bypass bugs that a plain `K_after >= K_before` check
    ///         can't see: if the input bypassed the fee, kAdj would dip below
    ///         the old K * 1e6 even though raw K may have grown.
    function invariant_kGrowsByFeesOnly() public view {
        if (!handler.didSwap()) return; // only meaningful after a swap
        (uint112 r0After, uint112 r1After,) = pair.getReserves();
        uint256 b0Adj = uint256(r0After) * 1000 - handler.lastAmount0In() * 3;
        uint256 b1Adj = uint256(r1After) * 1000 - handler.lastAmount1In() * 3;
        uint256 kAdjAfter = b0Adj * b1Adj;
        uint256 kAdjBefore = uint256(handler.lastR0()) * uint256(handler.lastR1()) * 1_000_000;
        assertGe(kAdjAfter, kAdjBefore, "R061 K bypass detected");
    }

    /// @notice invariant_minLiquidityLocked — the dead-address lock minted on
    ///         the first deposit must remain (>=1000) for the lifetime of the
    ///         pair. Catches a regression where a future change drains it.
    function invariant_minLiquidityLocked() public view {
        assertGe(pair.balanceOf(address(0xdead)), 1000, "R061 min liquidity drained");
    }
}
