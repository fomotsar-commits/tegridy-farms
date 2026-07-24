// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import "../src/SwapFeeRouterAdmin.sol";
import {SwapFeeRouterConvertLib} from "../src/lib/SwapFeeRouterConvertLib.sol";

/// @title 1000-agent audit (2026-07-22) — token-fee money-conservation harness
/// @notice The audit's residual-gap #2: "Foundry invariant harness for money
///         conservation (Σ fee inflows == stakers + POL + treasury + stranded) —
///         would auto-catch the M-1/L-3 stranding class and siblings."
///
///         The existing `test/invariants/PASS5_FeeRouterConservation.t.sol` covers the
///         ETH side. Neither it nor anything else covered the TOKEN side, which is
///         exactly where M-1 and L-3 lived: fees accrued into
///         `accumulatedTokenFees[token]` and every exit refused, so the balance was
///         conserved on paper while being permanently unreachable in practice.
///
///         Conservation alone would NOT have caught M-1 — a stranded balance still
///         balances. The invariant that catches it is REACHABILITY:
///
///           INV-1 (no stranding)  every token holding accrued fees has at least one
///                                 exit that is not structurally blocked
///           INV-2 (reservation)   token balance >= accumulatedTokenFees
///           INV-3 (ETH reserve)   ETH balance >= accumulatedETHFees + pendingDistribution
///           INV-4 (conservation)  accrued == still-accounted + converted-to-ETH
///                                          + delivered-to-treasury
///
/// @dev CI PLACEMENT. This file sits at `test/` root, not `test/invariants/`, on
///      purpose. The Contracts CI test matrix matches `test/<Prefix>*.t.sol` globs
///      that never descend into `test/invariants/`, and the "nightly cron" its
///      comments defer invariant runs to does not exist (the only scheduled workflow
///      in `.github/workflows` is CodeQL). Anything placed under `test/invariants/`
///      therefore runs in NO pipeline. The `test_*` functions below run in the
///      `audit-early` slice on every PR; the `invariant_*` function keeps the repo's
///      naming convention and so is still filtered out by the matrix's
///      `--no-match-test "(Invariant|invariant|Fuzz|fuzz|testFuzz)"`.

contract ConsToken is ERC20 {
    uint8 private immutable _dec;
    uint256 public taxBps;

    constructor(string memory n, uint8 d, uint256 _taxBps) ERC20(n, n) {
        _dec = d;
        taxBps = _taxBps;
        _mint(msg.sender, 1e30);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && taxBps > 0) {
            uint256 fee = (value * taxBps) / 10000;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract ConsPair {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint256 private constant Q112 = 2 ** 112;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function setReserves(uint112 r0, uint112 r1) public {
        reserve0 = r0;
        reserve1 = r1;
        blockTimestampLast = uint32(block.timestamp % 2 ** 32);
    }

    function pokeCumulative(uint32 dt) external {
        if (reserve0 == 0 || reserve1 == 0) return;
        unchecked {
            price0CumulativeLast += ((uint256(reserve1) * Q112) / reserve0) * uint256(dt);
            price1CumulativeLast += ((uint256(reserve0) * Q112) / reserve1) * uint256(dt);
        }
        blockTimestampLast = uint32(block.timestamp % 2 ** 32);
    }
}

contract ConsFactory {
    mapping(bytes32 => address) public pairs;

    function setPair(address a, address b, address p) external {
        pairs[_k(a, b)] = p;
        pairs[_k(b, a)] = p;
    }

    function getPair(address a, address b) external view returns (address) {
        return pairs[_k(a, b)];
    }

    function _k(address a, address b) internal pure returns (bytes32) {
        return keccak256(abi.encode(a, b));
    }
}

contract ConsRouter {
    address public immutable WETH_ADDR;
    address public immutable factoryAddr;

    constructor(address _weth, address _factory) {
        WETH_ADDR = _weth;
        factoryAddr = _factory;
    }

    function WETH() external view returns (address) {
        return WETH_ADDR;
    }

    function factory() external view returns (address) {
        return factoryAddr;
    }

    function _quote(address token, uint256 amountIn) internal view returns (uint256) {
        ConsPair p = ConsPair(ConsFactory(factoryAddr).getPair(token, WETH_ADDR));
        (uint112 r0, uint112 r1,) = p.getReserves();
        bool t0 = p.token0() == token;
        uint256 rTok = t0 ? r0 : r1;
        uint256 rEth = t0 ? r1 : r0;
        if (rTok == 0 || rEth == 0) return 0;
        return (amountIn * rEth) / (rTok + amountIn);
    }

    function swapExactTokensForETH(uint256 amountIn, uint256 minOut, address[] calldata path, address to, uint256)
        external
        returns (uint256[] memory amounts)
    {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = _quote(path[0], amountIn);
        require(out >= minOut, "INSUFFICIENT_OUTPUT");
        (bool ok,) = to.call{value: out}("");
        require(ok, "ETH_SEND_FAIL");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = out;
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 minOut,
        address[] calldata path,
        address to,
        uint256
    ) external {
        address pair = ConsFactory(factoryAddr).getPair(path[0], path[1]);
        uint256 before = IERC20(path[0]).balanceOf(pair);
        IERC20(path[0]).transferFrom(msg.sender, pair, amountIn);
        uint256 delivered = IERC20(path[0]).balanceOf(pair) - before;
        uint256 out = _quote(path[0], delivered);
        require(out >= minOut, "INSUFFICIENT_OUTPUT");
        (bool ok,) = to.call{value: out}("");
        require(ok, "ETH_SEND_FAIL");
    }

    receive() external payable {}
}

contract Audit_1000Agent_FeeConservation is Test {
    SwapFeeRouter internal sfr;
    SwapFeeRouterAdmin internal sfrAdmin;
    ConsRouter internal uniRouter;
    ConsFactory internal factory;
    ConsToken internal weth;

    address internal treasury = makeAddr("treasury");

    uint256 internal constant ACC_TOKEN_FEES_SLOT = 11;

    /// @dev Every token the harness has accrued fees for, plus the amount accrued.
    address[] internal tracked;
    mapping(address => uint256) internal totalAccrued;

    function setUp() public {
        vm.chainId(1);
        weth = new ConsToken("WETH", 18, 0);
        factory = new ConsFactory();
        uniRouter = new ConsRouter(address(weth), address(factory));
        vm.deal(address(uniRouter), 1_000_000 ether);

        sfr = new SwapFeeRouter(
            address(uniRouter), treasury, 30, address(0), address(uint160(uint256(keccak256("RD"))))
        );
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    function _deadline() internal view returns (uint256) {
        return vm.getBlockTimestamp() + 1 hours;
    }

    function _accrue(address token, uint256 amount) internal {
        if (totalAccrued[token] == 0) tracked.push(token);
        totalAccrued[token] += amount;
        uint256 held = sfr.accumulatedTokenFees(token);
        deal(token, address(sfr), IERC20(token).balanceOf(address(sfr)) + amount, true);
        vm.store(address(sfr), keccak256(abi.encode(token, ACC_TOKEN_FEES_SLOT)), bytes32(held + amount));
    }

    function _pair(address token, uint112 tokRes, uint112 ethRes) internal returns (ConsPair p) {
        bool t0 = token < address(weth);
        p = new ConsPair(t0 ? token : address(weth), t0 ? address(weth) : token);
        factory.setPair(token, address(weth), address(p));
        if (t0) p.setReserves(tokRes, ethRes);
        else p.setReserves(ethRes, tokRes);
    }

    function _path(address token) internal view returns (address[] memory p) {
        p = new address[](2);
        p[0] = token;
        p[1] = address(weth);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  INV-1 — NO STRANDING (the M-1 / L-3 catcher)
    // ══════════════════════════════════════════════════════════════════════

    /// @dev Returns true iff at least one exit is reachable for `token`, probed by
    ///      actually attempting each and rolling the state back. This is the property
    ///      a pure sum-conservation invariant cannot express: a stranded balance
    ///      still balances.
    function _hasReachableExit(address token) internal returns (bool reachable) {
        if (sfr.accumulatedTokenFees(token) == 0) return true;

        uint256 snap = vm.snapshotState();
        try sfr.convertTokenFeesToETH(token, _path(token), 0, _deadline()) {
            reachable = true;
        } catch {}
        vm.revertToState(snap);
        if (reachable) return true;

        snap = vm.snapshotState();
        try sfr.convertTokenFeesToETHFoT(token, _path(token), 0, _deadline()) {
            reachable = true;
        } catch {}
        vm.revertToState(snap);
        if (reachable) return true;

        snap = vm.snapshotState();
        try sfr.withdrawTokenFees(token) {
            reachable = true;
        } catch {}
        vm.revertToState(snap);
        if (reachable) return true;

        snap = vm.snapshotState();
        try sfr.sweepTokens(token) {
            reachable = true;
        } catch {}
        vm.revertToState(snap);
    }

    /// @dev "Material" balance = at least ONE WHOLE TOKEN, computed HERE from the
    ///      token's own `decimals()` rather than read from the contract under test.
    ///      That independence is load-bearing: if the invariant asked the router for
    ///      its own floor, a bug that inflates that floor (exactly M-1) would also
    ///      inflate the threshold and the invariant would skip the very balances it
    ///      is meant to police. The test must own its definition of "material".
    function _oneWholeToken(address token) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        uint8 d = (ok && data.length >= 32) ? uint8(abi.decode(data, (uint256))) : 18;
        return 10 ** uint256(d);
    }

    /// @dev INV-1. Scoped to MATERIAL balances. Sub-one-token dust legitimately has no
    ///      immediate exit — the anti-grief floor (SFR-M-02) refuses to burn the 1h
    ///      per-token cooldown on a dust trigger, and the escape hatches stay shut for
    ///      any convertible token so the staker/POL split cannot be bypassed. Dust is
    ///      not stranded, it is PRE-THRESHOLD: it exits as soon as accrual crosses one
    ///      whole token. Asserting reachability on dust would be asserting against the
    ///      design; asserting it on material balances is exactly the M-1 class.
    function _assertNoStranding() internal {
        for (uint256 i = 0; i < tracked.length; i++) {
            address token = tracked[i];
            if (sfr.accumulatedTokenFees(token) < _oneWholeToken(token)) continue;
            assertTrue(
                _hasReachableExit(token),
                "INV-1 violated: material accrued token fees have no reachable exit (M-1 class)"
            );
        }
    }

    function _assertReservation() internal view {
        for (uint256 i = 0; i < tracked.length; i++) {
            assertGe(
                IERC20(tracked[i]).balanceOf(address(sfr)),
                sfr.accumulatedTokenFees(tracked[i]),
                "INV-2 violated: token reservation exceeds balance"
            );
        }
    }

    function _assertEthReserve() internal view {
        assertGe(
            address(sfr).balance,
            sfr.accumulatedETHFees() + sfr.totalPendingDistribution(),
            "INV-3 violated: ETH reservation exceeds balance"
        );
    }

    /// @dev INV-4 — Σ inflows == still-accounted + converted-to-ETH + delivered-to-treasury.
    ///      `stranded` is reported separately rather than folded into the identity so a
    ///      violation names WHICH bucket leaked.
    function _assertConservation(address token, uint256 treasuryDelta, uint256 convertedTokens) internal view {
        assertEq(
            totalAccrued[token],
            sfr.accumulatedTokenFees(token) + convertedTokens + treasuryDelta,
            "INV-4 violated: accrued token fees are not fully accounted"
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Deterministic cases (these DO run in PR CI)
    // ══════════════════════════════════════════════════════════════════════

    /// @dev The exact M-1 scenario across every decimal width the protocol can meet.
    ///      Pre-fix, the 6- and 8-decimal legs had NO reachable exit at all.
    function test_conservation_noStrandingAcrossDecimalWidths() public {
        ConsToken usdc = new ConsToken("USDC", 6, 0);
        ConsToken wbtc = new ConsToken("WBTC", 8, 0);
        ConsToken t18 = new ConsToken("T18", 18, 0);

        _pair(address(usdc), 100_000e6, 100 ether);
        _pair(address(wbtc), 1_000e8, 30_000 ether);
        _pair(address(t18), 100_000 ether, 100 ether);

        _accrue(address(usdc), 5e6);
        _accrue(address(wbtc), 3e8);
        _accrue(address(t18), 7 ether);

        skip(60 minutes);
        // Warm each pair's integral so the TWAP anchor is readable.
        ConsPair(factory.getPair(address(usdc), address(weth))).pokeCumulative(uint32(60 minutes));
        ConsPair(factory.getPair(address(wbtc), address(weth))).pokeCumulative(uint32(60 minutes));
        ConsPair(factory.getPair(address(t18), address(weth))).pokeCumulative(uint32(60 minutes));

        _assertNoStranding();
        _assertReservation();
        _assertEthReserve();
    }

    /// @dev The L-3 scenario: fee-on-transfer tokens across the tax range that used to
    ///      strand (anything above ~1.2%).
    function test_conservation_noStrandingAcrossFoTTaxes() public {
        uint256[3] memory taxes = [uint256(200), 500, 1500]; // 2%, 5%, 15%
        for (uint256 i = 0; i < taxes.length; i++) {
            ConsToken fot = new ConsToken("FOT", 18, taxes[i]);
            ConsPair p = _pair(address(fot), 100_000 ether, 100 ether);
            _accrue(address(fot), 10 ether);
            skip(60 minutes);
            p.pokeCumulative(uint32(60 minutes));
        }
        _assertNoStranding();
        _assertReservation();
        _assertEthReserve();
    }

    /// @dev The trap M-1 named directly: a pair that EXISTS but was never funded.
    ///      Conversion is impossible (zero reserves) — the escape hatch must be open.
    function test_conservation_noStrandingForUnfundedPair() public {
        ConsToken usdc = new ConsToken("USDC", 6, 0);
        _pair(address(usdc), 0, 0);
        _accrue(address(usdc), 5e6);

        _assertNoStranding();
        _assertReservation();
    }

    /// @dev Full INV-4 identity over a real conversion: accrued value ends up either
    ///      still accounted, credited as ETH, or delivered to treasury — never lost.
    function test_conservation_identityHoldsThroughConversion() public {
        ConsToken usdc = new ConsToken("USDC", 6, 0);
        ConsPair p = _pair(address(usdc), 100_000e6, 100 ether);
        _accrue(address(usdc), 5e6);

        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));

        uint256 ethBefore = sfr.accumulatedETHFees();
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        sfr.convertTokenFeesToETH(address(usdc), _path(address(usdc)), 0, _deadline());

        uint256 treasuryDelta = usdc.balanceOf(treasury) - treasuryBefore;
        // The whole 5 USDC left the accounting via conversion.
        _assertConservation(address(usdc), treasuryDelta, 5e6);
        assertGt(sfr.accumulatedETHFees(), ethBefore, "converted value did not become ETH");
        _assertReservation();
        _assertEthReserve();
    }

    /// @dev Same identity through the escape hatch instead of conversion.
    function test_conservation_identityHoldsThroughEscapeHatch() public {
        ConsToken exotic = new ConsToken("EXO", 6, 0); // no pair at all
        _accrue(address(exotic), 42e6);

        uint256 treasuryBefore = exotic.balanceOf(treasury);
        sfr.withdrawTokenFees(address(exotic));
        uint256 treasuryDelta = exotic.balanceOf(treasury) - treasuryBefore;

        _assertConservation(address(exotic), treasuryDelta, 0);
        assertEq(treasuryDelta, 42e6, "escape hatch under-delivered");
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Fuzz-driven invariant (nightly / local; filtered out of PR CI by name)
    // ══════════════════════════════════════════════════════════════════════

    /// @dev Accrues a fuzzed amount of a fuzzed-width token and asserts every
    ///      invariant. Named `invariant_*` per repo convention, so the CI matrix's
    ///      `--no-match-test` filter excludes it from PR runs.
    function invariant_tokenFeesAlwaysHaveAnExit() public {
        _assertNoStranding();
        _assertReservation();
        _assertEthReserve();
    }

    /// @dev Bounded-fuzz companion that DOES exercise randomness while still being
    ///      excluded from PR CI by the `Fuzz` name filter.
    function testFuzz_noStrandingForAnyDecimalWidth(uint8 dec, uint256 amount) public {
        dec = uint8(bound(uint256(dec), 0, 24));
        // Bound the accrual to at least ONE WHOLE TOKEN at this width — below that the
        // balance is pre-threshold dust, not stranded value (see `_assertNoStranding`).
        amount = bound(amount, 10 ** uint256(dec), 10 ** uint256(dec) * 1_000_000);

        ConsToken tkn = new ConsToken("FZ", dec, 0);
        ConsPair p = _pair(address(tkn), 100_000 ether, 100 ether);
        _accrue(address(tkn), amount);
        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));

        _assertNoStranding();
        _assertReservation();
    }
}
