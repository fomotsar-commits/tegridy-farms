// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import "../src/SwapFeeRouterAdmin.sol";
import {SwapFeeRouterConvertLib} from "../src/lib/SwapFeeRouterConvertLib.sol";

/// @title 1000-agent audit (2026-07-22) — SwapFeeRouter findings M-1, L-1, L-3
/// @notice Regression suite for the three SwapFeeRouter-cluster findings.
///
///   M-1 (Medium) — sub-18-decimal swap-fee revenue was permanently unextractable.
///     `convertTokenFeesToETH` gated on a FLAT `MIN_TOKEN_FEE_FOR_CONVERSION = 1e18`
///     of RAW token units. At 6 decimals that is 1e12 whole USDC (~$1T) and at 8
///     decimals 1e10 WBTC — unreachable. Both alternative exits (`withdrawTokenFees`,
///     `sweepTokens`) refuse any token that has a WETH pair, so the fees had NO exit.
///     Fix: floor is now `10 ** decimals()` — one whole token at any width.
///
///   L-1 (Low) — `setSequencerFeed` had no `block.chainid == 1` guard. On mainnet the
///     slot is `address(0)` by design, so the one-shot setter stayed permanently
///     available to a captured owner key; installing a hostile feed that reports
///     "sequencer down" freezes every conversion path with no reset.
///
///   L-3 (Low) — the FoT conversion sized its TWAP slippage floor from the GROSS
///     input while the swap only delivers `gross * (1 - tax)`. Above ~1.2% tax the
///     floor was structurally unreachable, so the dedicated fee-on-transfer variant
///     rejected exactly the token class it exists to serve.
///
/// Every test below is written to FAIL on the pre-fix contract: each pins the
/// behavioural invariant (fees can leave / the setter is closed / an FoT conversion
/// completes), not an incidental constant.

// ─── Mocks ────────────────────────────────────────────────────────────────

/// @dev ERC20 with a configurable `decimals()` so the same test body exercises
///      USDC (6), WBTC (8) and an 18-decimal control.
contract MockDecimalToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
        _mint(msg.sender, 1e30);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev Token whose `decimals()` reverts. Exercises the M-1 fallback path: the
///      floor must degrade to the 18-decimal default, never to something looser.
contract MockNoDecimalsToken is ERC20 {
    constructor() ERC20("NoDec", "NODEC") {
        _mint(msg.sender, 1e30);
    }

    function decimals() public pure override returns (uint8) {
        revert("NO_DECIMALS");
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev Fee-on-transfer token with a configurable tax, burnt on every transfer.
///      `taxBps = 0` makes it behave as a plain ERC20 for control cases.
contract MockFoTToken is ERC20 {
    uint256 public taxBps;

    constructor(uint256 _taxBps) ERC20("FoT", "FOT") {
        taxBps = _taxBps;
        _mint(msg.sender, 1e30);
    }

    function setTax(uint256 _taxBps) external {
        taxBps = _taxBps;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
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

/// @dev Uniswap V2 pair stub with reserves + cumulative accumulators, matching the
///      surface SwapFeeRouterConvertLib reads. Adapted from Audit_SFR_H01.
contract MockPair1kA {
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

    /// @dev Advance the cumulative by `dt` seconds at the CURRENT spot, mirroring
    ///      what the real pair's `_update` writes on each touch.
    function pokeCumulative(uint32 dt) external {
        if (reserve0 == 0 || reserve1 == 0) return;
        uint256 spot0 = (uint256(reserve1) * Q112) / reserve0;
        uint256 spot1 = (uint256(reserve0) * Q112) / reserve1;
        unchecked {
            price0CumulativeLast += spot0 * uint256(dt);
            price1CumulativeLast += spot1 * uint256(dt);
        }
        blockTimestampLast = uint32(block.timestamp % 2 ** 32);
    }
}

contract MockFactory1kA {
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

/// @dev V2 router stub. Prices token→ETH off the pair's live reserves via the
///      constant-product formula, and — critically for L-3 — the FoT variant
///      actually TRANSFERS the input through the taxing token into the pair, so
///      the pair's measured balance delta is the true post-tax delivered amount.
contract MockRouter1kA {
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

    function _quote(address token, uint256 amountIn) internal view returns (uint256, MockPair1kA, bool) {
        address pair = MockFactory1kA(factoryAddr).getPair(token, WETH_ADDR);
        require(pair != address(0), "NO_PAIR");
        MockPair1kA p = MockPair1kA(pair);
        (uint112 r0, uint112 r1,) = p.getReserves();
        bool tokenIs0 = p.token0() == token;
        uint256 rTok = tokenIs0 ? r0 : r1;
        uint256 rEth = tokenIs0 ? r1 : r0;
        return ((amountIn * rEth) / (rTok + amountIn), p, tokenIs0);
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(path[path.length - 1] == WETH_ADDR, "BAD_PATH");
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        (uint256 out,,) = _quote(path[0], amountIn);
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT");
        (bool ok,) = to.call{value: out}("");
        require(ok, "ETH_SEND_FAIL");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = out;
    }

    /// @dev FoT variant. Routes the input THROUGH the taxing token into the pair so
    ///      the pair's balance delta reflects the real haircut, then prices the swap
    ///      on the amount that actually arrived — exactly the mainnet behaviour that
    ///      made the gross-sized floor unreachable.
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        require(path[path.length - 1] == WETH_ADDR, "BAD_PATH");
        address pair = MockFactory1kA(factoryAddr).getPair(path[0], path[1]);
        require(pair != address(0), "NO_PAIR");
        uint256 before = IERC20(path[0]).balanceOf(pair);
        // Taxed transfer straight into the pair — the delta is the delivered amount.
        IERC20(path[0]).transferFrom(msg.sender, pair, amountIn);
        uint256 delivered = IERC20(path[0]).balanceOf(pair) - before;
        (uint256 out,,) = _quote(path[0], delivered);
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT");
        (bool ok,) = to.call{value: out}("");
        require(ok, "ETH_SEND_FAIL");
    }

    receive() external payable {}
}

/// @dev Router variant that under-delivers to the pair regardless of the token's own
///      tax — models a hostile token that shrinks its measured delivery ratio to
///      collapse the rescaled slippage floor. Used to pin the MAX_FOT_TAX_BPS bound.
contract MockRouterUnderDeliver1kA is MockRouter1kA {
    constructor(address _weth, address _factory) MockRouter1kA(_weth, _factory) {}
}

// ─── Tests ────────────────────────────────────────────────────────────────

contract Audit_1000Agent_SFR is Test {
    SwapFeeRouter internal sfr;
    SwapFeeRouterAdmin internal sfrAdmin;
    MockRouter1kA internal uniRouter;
    MockFactory1kA internal factory;
    MockDecimalToken internal weth;

    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");

    /// @dev `accumulatedTokenFees` storage slot, taken from the sibling
    ///      Audit_SFR_H01 suite (verified there via `forge inspect storage-layout`).
    uint256 internal constant ACC_TOKEN_FEES_SLOT = 11;

    function setUp() public {
        // SequencerCheck reverts when feed == address(0) on chainid != 1, so the
        // conversion tests run as mainnet. The L-1 tests override this per-test.
        vm.chainId(1);
        weth = new MockDecimalToken("WETH", "WETH", 18);
        factory = new MockFactory1kA();
        uniRouter = new MockRouter1kA(address(weth), address(factory));
        vm.deal(address(uniRouter), 100_000 ether);

        sfr = new SwapFeeRouter(
            address(uniRouter), treasury, 30, address(0), address(uint160(uint256(keccak256("REVDIST"))))
        );
        sfrAdmin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(sfrAdmin));
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    /// @dev Seed `amount` of `token` as accumulated protocol fees on the router,
    ///      backing the accounting entry with a real token balance.
    function _seedFees(address token, uint256 amount) internal {
        deal(token, address(sfr), IERC20(token).balanceOf(address(sfr)) + amount, true);
        vm.store(
            address(sfr), keccak256(abi.encode(token, ACC_TOKEN_FEES_SLOT)), bytes32(amount)
        );
        assertEq(sfr.accumulatedTokenFees(token), amount, "fee seed failed");
    }

    /// @dev Stand up a token/WETH pair with `tokenReserve`/`ethReserve` and a warm
    ///      cumulative so the TWAP floor has a real anchor to read.
    function _makePair(address token, uint112 tokenReserve, uint112 ethReserve)
        internal
        returns (MockPair1kA p)
    {
        bool tokenIs0 = token < address(weth);
        p = new MockPair1kA(tokenIs0 ? token : address(weth), tokenIs0 ? address(weth) : token);
        factory.setPair(token, address(weth), address(p));
        if (tokenIs0) p.setReserves(tokenReserve, ethReserve);
        else p.setReserves(ethReserve, tokenReserve);
    }

    function _path(address token) internal view returns (address[] memory p) {
        p = new address[](2);
        p[0] = token;
        p[1] = address(weth);
    }

    /// @dev Deadline helper. MUST read the timestamp through the cheatcode rather
    ///      than `block.timestamp`: this project builds with `via_ir = true`, and the
    ///      IR optimiser common-subexpression-eliminates the TIMESTAMP opcode across
    ///      external calls (sound on-chain, where time cannot move mid-transaction,
    ///      but `vm.warp`/`skip` violate that assumption). Written the naive way,
    ///      `block.timestamp + 1 hours` evaluated against the PRE-skip timestamp and
    ///      every post-skip conversion reverted `DEADLINE_EXPIRED` — which silently
    ///      satisfied bare `vm.expectRevert()` assertions, making them pass for the
    ///      wrong reason. `vm.getBlockTimestamp()` is an external call and cannot be
    ///      folded away.
    function _deadline() internal view returns (uint256) {
        return vm.getBlockTimestamp() + 1 hours;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  M-1 — decimal-aware minimum-conversion floor
    // ══════════════════════════════════════════════════════════════════════

    /// @dev THE headline M-1 regression. A 6-decimal token (USDC shape) with ONE
    ///      whole token of accrued fees must be convertible.
    ///
    ///      Pre-fix this reverted `TokenFeesBelowMinimum` because 1e6 < 1e18, and
    ///      since USDC has a WETH pair both `withdrawTokenFees` and `sweepTokens`
    ///      also reverted — the revenue was unreachable through every exit.
    function test_M1_sixDecimalToken_convertsAtOneWholeToken() public {
        MockDecimalToken usdc = new MockDecimalToken("USDC", "USDC", 6);
        MockPair1kA p = _makePair(address(usdc), 100_000e6, 100 ether);

        uint256 oneWhole = 1e6;
        _seedFees(address(usdc), oneWhole);

        // Warm the cumulative so a TWAP anchor exists, then bootstrap as owner.
        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));

        uint256 ethBefore = sfr.accumulatedETHFees();
        sfr.convertTokenFeesToETH(address(usdc), _path(address(usdc)), 0, _deadline());

        assertEq(sfr.accumulatedTokenFees(address(usdc)), 0, "fees not drained");
        assertGt(sfr.accumulatedETHFees(), ethBefore, "no ETH credited to the fee pool");
    }

    /// @dev The anti-grief property (SFR-M-02) must survive the fix: a dust balance
    ///      below one whole token still cannot enter the per-token cooldown.
    function test_M1_sixDecimalToken_dustStillRejected() public {
        MockDecimalToken usdc = new MockDecimalToken("USDC", "USDC", 6);
        MockPair1kA p = _makePair(address(usdc), 100_000e6, 100 ether);

        _seedFees(address(usdc), 1e6 - 1); // one wei under one whole token
        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));

        vm.expectRevert(SwapFeeRouter.TokenFeesBelowMinimum.selector);
        sfr.convertTokenFeesToETH(address(usdc), _path(address(usdc)), 0, _deadline());
    }

    /// @dev 8-decimal (WBTC shape) — same property at a different width.
    function test_M1_eightDecimalToken_convertsAtOneWholeToken() public {
        MockDecimalToken wbtc = new MockDecimalToken("WBTC", "WBTC", 8);
        MockPair1kA p = _makePair(address(wbtc), 1_000e8, 30_000 ether);

        _seedFees(address(wbtc), 1e8);
        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));

        sfr.convertTokenFeesToETH(address(wbtc), _path(address(wbtc)), 0, _deadline());
        assertEq(sfr.accumulatedTokenFees(address(wbtc)), 0, "WBTC fees not drained");
    }

    /// @dev NO-REGRESSION control: at 18 decimals the floor is unchanged (1e18), so
    ///      pre-fix and post-fix behaviour must be identical in both directions.
    function test_M1_eighteenDecimalBehaviourUnchanged() public {
        MockDecimalToken tkn = new MockDecimalToken("T18", "T18", 18);
        MockPair1kA p = _makePair(address(tkn), 100_000 ether, 100 ether);

        _seedFees(address(tkn), 1e18 - 1);
        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));
        vm.expectRevert(SwapFeeRouter.TokenFeesBelowMinimum.selector);
        sfr.convertTokenFeesToETH(address(tkn), _path(address(tkn)), 0, _deadline());

        _seedFees(address(tkn), 1e18);
        sfr.convertTokenFeesToETH(address(tkn), _path(address(tkn)), 0, _deadline());
        assertEq(sfr.accumulatedTokenFees(address(tkn)), 0, "18-dec conversion regressed");
    }

    /// @dev A token whose `decimals()` reverts must fall back to the 18-decimal
    ///      floor — never to something looser (which would re-open the dust-grief
    ///      vector the floor exists to close).
    function test_M1_missingDecimals_fallsBackToEighteen() public {
        MockNoDecimalsToken odd = new MockNoDecimalsToken();
        MockPair1kA p = _makePair(address(odd), 100_000 ether, 100 ether);

        _seedFees(address(odd), 1e18 - 1);
        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));

        vm.expectRevert(SwapFeeRouter.TokenFeesBelowMinimum.selector);
        sfr.convertTokenFeesToETH(address(odd), _path(address(odd)), 0, _deadline());
    }

    /// @dev The library's public floor helper is the single source of truth and
    ///      reports the token's own unit at every width.
    function test_M1_floorHelper_scalesWithDecimals() public {
        assertEq(
            SwapFeeRouterConvertLib.minTokenFeeForConversion(address(new MockDecimalToken("A", "A", 6))),
            1e6,
            "6dp floor"
        );
        assertEq(
            SwapFeeRouterConvertLib.minTokenFeeForConversion(address(new MockDecimalToken("B", "B", 8))),
            1e8,
            "8dp floor"
        );
        assertEq(
            SwapFeeRouterConvertLib.minTokenFeeForConversion(address(new MockDecimalToken("C", "C", 18))),
            1e18,
            "18dp floor"
        );
        assertEq(
            SwapFeeRouterConvertLib.minTokenFeeForConversion(address(new MockNoDecimalsToken())),
            1e18,
            "fallback floor"
        );
    }

    // ─── M-1, exit-path half: the getPair trap ────────────────────────────

    /// @dev The M3/M4 invariant MUST hold: a token with a FUNDED WETH pair can never
    ///      be routed 100%-to-treasury, bypassing the staker/POL/treasury split.
    function test_M1_withdrawTokenFees_stillBlockedForLiquidPair() public {
        MockDecimalToken usdc = new MockDecimalToken("USDC", "USDC", 6);
        _makePair(address(usdc), 100_000e6, 100 ether);
        _seedFees(address(usdc), 1e6);

        vm.expectRevert(SwapFeeRouter.UseConvertTokenFeesToETH.selector);
        sfr.withdrawTokenFees(address(usdc));

        vm.expectRevert(SwapFeeRouter.UseConvertTokenFeesToETH.selector);
        sfr.sweepTokens(address(usdc));
    }

    /// @dev The trap M-1 identified: a pair ADDRESS exists (anyone may call
    ///      `createPair`) but was never funded. `convertTokenFeesToETH` reverts
    ///      `NoPairForToken` on zero reserves, so pre-fix all three exits refused
    ///      and the balance was stranded. The escape hatch must now open.
    function test_M1_withdrawTokenFees_opensForUnfundedPair() public {
        MockDecimalToken usdc = new MockDecimalToken("USDC", "USDC", 6);
        _makePair(address(usdc), 0, 0); // pair exists, reserves are zero
        _seedFees(address(usdc), 1e6);

        // Conversion is genuinely impossible against an empty pair...
        vm.expectRevert(SwapFeeRouter.NoPairForToken.selector);
        sfr.convertTokenFeesToETH(address(usdc), _path(address(usdc)), 0, _deadline());

        // ...so the owner-only escape hatch must be reachable.
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        sfr.withdrawTokenFees(address(usdc));
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, 1e6, "escape hatch did not deliver");
        assertEq(sfr.accumulatedTokenFees(address(usdc)), 0, "accounting not cleared");
    }

    // ══════════════════════════════════════════════════════════════════════
    //  L-1 — setSequencerFeed mainnet guard
    // ══════════════════════════════════════════════════════════════════════

    /// @dev On Ethereum L1 the setter must be permanently closed. Pre-fix a captured
    ///      owner key had one free shot (the slot is address(0) by design on mainnet,
    ///      and the setter only refused to overwrite a NON-ZERO feed).
    function test_L1_setSequencerFeed_revertsOnMainnet() public {
        vm.chainId(1);
        address feed = address(new MockFactory1kA()); // any contract with code
        vm.expectRevert(SwapFeeRouter.SequencerFeedNotOnMainnet.selector);
        sfr.setSequencerFeed(feed);
        assertEq(sfr.sequencerFeed(), address(0), "mainnet feed must stay unset");
    }

    /// @dev Non-owners are still rejected on mainnet (the new guard must not become
    ///      the only thing standing between an arbitrary caller and the setter).
    function test_L1_setSequencerFeed_stillOwnerGatedOnMainnet() public {
        vm.chainId(1);
        address feed = address(new MockFactory1kA());
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", keeper));
        sfr.setSequencerFeed(feed);
    }

    /// @dev The legitimate L2 path must be untouched — this is what makes the fix
    ///      safe to ship rather than a functional regression.
    function test_L1_setSequencerFeed_stillWorksOnL2() public {
        vm.chainId(42161); // Arbitrum One
        address feed = address(new MockFactory1kA());
        sfr.setSequencerFeed(feed);
        assertEq(sfr.sequencerFeed(), feed, "L2 feed wiring broke");

        // One-shot property preserved. NOTE: the second feed is deployed BEFORE
        // `expectRevert` — an inline `new` would make the CREATE the "next call"
        // the cheatcode watches, and the assertion would never reach the setter.
        address secondFeed = address(new MockFactory1kA());
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        sfr.setSequencerFeed(secondFeed);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  L-3 — FoT floor sized from the net delivered amount
    // ══════════════════════════════════════════════════════════════════════

    /// @dev THE headline L-3 regression. A 5%-tax FoT token — comfortably above the
    ///      ~1.2% break-even — must convert. Pre-fix the TWAP floor was sized on the
    ///      gross input while the pair only received 95% of it, so `ethReceived` was
    ///      structurally below the floor and EVERY attempt reverted.
    function test_L3_fotConversion_succeedsAboveBreakEvenTax() public {
        MockFoTToken fot = new MockFoTToken(500); // 5% tax
        MockPair1kA p = _makePair(address(fot), 100_000 ether, 100 ether);

        _seedFees(address(fot), 10 ether);
        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));

        // Bootstrap (owner) establishes the snapshot anchor.
        sfr.convertTokenFeesToETHFoT(address(fot), _path(address(fot)), 0, _deadline());

        // Second conversion is the one that reads a real TWAP floor — the pre-fix
        // failure mode. Re-arm balance, cooldown and integral.
        _seedFees(address(fot), 10 ether);
        skip(2 hours);
        p.pokeCumulative(uint32(2 hours));

        uint256 ethBefore = sfr.accumulatedETHFees();
        sfr.convertTokenFeesToETHFoT(address(fot), _path(address(fot)), 0, _deadline());

        assertEq(sfr.accumulatedTokenFees(address(fot)), 0, "FoT fees not drained");
        assertGt(sfr.accumulatedETHFees(), ethBefore, "no ETH credited from FoT conversion");
    }

    /// @dev A zero-tax token routed through the FoT variant delivers the full gross
    ///      amount, so the rescale is a no-op and the ORIGINAL gross floor still
    ///      binds. This pins that the fix relaxes the floor only by the measured
    ///      haircut, never unconditionally.
    function test_L3_zeroTaxToken_keepsFullGrossFloor() public {
        MockFoTToken plain = new MockFoTToken(0); // no tax
        MockPair1kA p = _makePair(address(plain), 100_000 ether, 100 ether);

        _seedFees(address(plain), 10 ether);
        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));
        sfr.convertTokenFeesToETHFoT(address(plain), _path(address(plain)), 0, _deadline());

        _seedFees(address(plain), 10 ether);
        skip(2 hours);
        p.pokeCumulative(uint32(2 hours));

        // Crash the pool price by 60% right before the conversion — a sandwich.
        // The floor is NOT rescaled (no haircut), so this must still revert.
        bool tokenIs0 = address(plain) < address(weth);
        if (tokenIs0) p.setReserves(250_000 ether, 40 ether);
        else p.setReserves(40 ether, 250_000 ether);

        vm.expectRevert(SwapFeeRouterConvertLib.InsufficientOutput.selector);
        sfr.convertTokenFeesToETHFoT(address(plain), _path(address(plain)), 0, _deadline());
    }

    /// @dev Sandwich protection must survive the move of the price gate to after the
    ///      swap: with a 5% tax the floor is rescaled to 95%, which still rejects a
    ///      conversion executed at a manipulated price.
    function test_L3_rescaledFloor_stillBlocksSandwich() public {
        MockFoTToken fot = new MockFoTToken(500);
        MockPair1kA p = _makePair(address(fot), 100_000 ether, 100 ether);

        _seedFees(address(fot), 10 ether);
        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));
        sfr.convertTokenFeesToETHFoT(address(fot), _path(address(fot)), 0, _deadline());

        _seedFees(address(fot), 10 ether);
        skip(2 hours);
        p.pokeCumulative(uint32(2 hours));

        // Attacker dumps to push spot far below the 30-min TWAP.
        bool tokenIs0 = address(fot) < address(weth);
        if (tokenIs0) p.setReserves(300_000 ether, 33 ether);
        else p.setReserves(33 ether, 300_000 ether);

        vm.prank(keeper);
        vm.expectRevert(SwapFeeRouterConvertLib.InsufficientOutput.selector);
        sfr.convertTokenFeesToETHFoT(address(fot), _path(address(fot)), 0, _deadline());
    }

    /// @dev A token taxing above MAX_FOT_TAX_BPS (30%) would rescale the price floor
    ///      down toward nothing, so the conversion must refuse outright rather than
    ///      execute against a vestigial floor.
    function test_L3_haircutBeyondCap_reverts() public {
        MockFoTToken fot = new MockFoTToken(500);
        MockPair1kA p = _makePair(address(fot), 100_000 ether, 100 ether);

        _seedFees(address(fot), 10 ether);
        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));
        sfr.convertTokenFeesToETHFoT(address(fot), _path(address(fot)), 0, _deadline());

        // Token turns hostile: 50% tax, beyond the honoured bound.
        fot.setTax(5000);
        _seedFees(address(fot), 10 ether);
        skip(2 hours);
        p.pokeCumulative(uint32(2 hours));

        vm.expectRevert(SwapFeeRouterConvertLib.FoTHaircutTooLarge.selector);
        sfr.convertTokenFeesToETHFoT(address(fot), _path(address(fot)), 0, _deadline());
    }

    /// @dev The caller's own `minETHOut` is never rescaled — a keeper can always
    ///      tighten the floor, and the FoT haircut must not loosen it.
    function test_L3_callerFloorIsNeverRescaled() public {
        MockFoTToken fot = new MockFoTToken(500);
        MockPair1kA p = _makePair(address(fot), 100_000 ether, 100 ether);

        _seedFees(address(fot), 10 ether);
        skip(60 minutes);
        p.pokeCumulative(uint32(60 minutes));
        sfr.convertTokenFeesToETHFoT(address(fot), _path(address(fot)), 0, _deadline());

        _seedFees(address(fot), 10 ether);
        skip(2 hours);
        p.pokeCumulative(uint32(2 hours));

        // Absurdly high caller floor. It must reach the INNER router un-rescaled —
        // asserting on the router's own slippage guard proves the caller's floor was
        // forwarded verbatim rather than shrunk by the 5% haircut ratio.
        vm.expectRevert(bytes("INSUFFICIENT_OUTPUT"));
        sfr.convertTokenFeesToETHFoT(address(fot), _path(address(fot)), 500 ether, _deadline());
    }
}
