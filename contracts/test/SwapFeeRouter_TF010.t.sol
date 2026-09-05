// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/SwapFeeRouter.sol";
import "../src/SwapFeeRouterAdmin.sol";

/// @dev ERC20 with configurable decimals AND a configurable transfer fee in bps, burned
///      on every non-mint/non-burn transfer. `feeBps == 0` is a plain ERC20. The FoT
///      shape is copied from AuditFoTToken (FinalAudit_AMM.t.sol:51) — OZ v5 `_update`.
contract MockToken_TF is ERC20 {
    uint8 private immutable _dec;
    uint256 public immutable feeBps;

    constructor(string memory n, string memory s, uint8 d, uint256 f) ERC20(n, s) {
        _dec = d;
        feeBps = f;
    }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (amount * feeBps) / 10000;
            super._update(from, address(0), fee);
            super._update(from, to, amount - fee);
        } else {
            super._update(from, to, amount);
        }
    }
}

/// @dev UniV2 pair stub. Same shape as MockUniPair_R028 so the TWAP read is exercised
///      end to end through the real UniswapV2OracleLibrary bridge.
contract MockUniPair_TF {
    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint256 private constant Q112 = 2 ** 112;

    constructor(address t0, address t1) { token0 = t0; token1 = t1; }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }
    function setReserves(uint112 r0, uint112 r1) external {
        reserve0 = r0; reserve1 = r1;
        blockTimestampLast = uint32(block.timestamp % 2 ** 32);
    }
    function pokeCumulative(uint32 secondsElapsed) external {
        if (reserve0 == 0 || reserve1 == 0) return;
        uint256 spot0 = (uint256(reserve1) * Q112) / reserve0;
        uint256 spot1 = (uint256(reserve0) * Q112) / reserve1;
        unchecked {
            price0CumulativeLast += spot0 * uint256(secondsElapsed);
            price1CumulativeLast += spot1 * uint256(secondsElapsed);
        }
        blockTimestampLast = uint32(block.timestamp % 2 ** 32);
    }
}

contract MockUniFactory_TF {
    mapping(bytes32 => address) public pairs;
    function setPair(address t0, address t1, address pair) external {
        pairs[_key(t0, t1)] = pair;
        pairs[_key(t1, t0)] = pair;
    }
    function getPair(address a, address b) external view returns (address) { return pairs[_key(a, b)]; }
    function _key(address a, address b) internal pure returns (bytes32) { return keccak256(abi.encode(a, b)); }
}

/// @dev Router stub carrying BOTH swap variants.
///      VACUITY GUARD (the one that decides whether TF-015 is tested at all): the FoT
///      variant prices on the amount that ACTUALLY ARRIVES, measured as a balance delta
///      on itself. If it priced on `amountIn` instead, a gross-sized floor would still be
///      satisfiable and every TF-015 test would pass against un-patched code.
contract MockUniRouter_TF {
    address public immutable WETH_ADDR;
    address public immutable factoryAddr;

    constructor(address _weth, address _factory) { WETH_ADDR = _weth; factoryAddr = _factory; }
    function WETH() external view returns (address) { return WETH_ADDR; }
    function factory() external view returns (address) { return factoryAddr; }

    function _quoteAndPay(address tokenIn, uint256 received, uint256 amountOutMin, address to)
        internal
        returns (uint256 amountOut)
    {
        address pair = MockUniFactory_TF(factoryAddr).getPair(tokenIn, WETH_ADDR);
        require(pair != address(0), "NO_PAIR");
        MockUniPair_TF p = MockUniPair_TF(pair);
        (uint112 r0, uint112 r1,) = p.getReserves();
        bool tokenIs0 = p.token0() == tokenIn;
        uint256 reserveToken = tokenIs0 ? r0 : r1;
        uint256 reserveETH = tokenIs0 ? r1 : r0;
        amountOut = (received * reserveETH) / (reserveToken + received);
        require(amountOut >= amountOutMin, "INSUFFICIENT_OUTPUT");
        p.setReserves(
            uint112(tokenIs0 ? reserveToken + received : reserveETH - amountOut),
            uint112(tokenIs0 ? reserveETH - amountOut : reserveToken + received)
        );
        (bool ok,) = to.call{value: amountOut}("");
        require(ok, "ETH_SEND_FAIL");
    }

    function swapExactTokensForETH(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2 && path[path.length - 1] == WETH_ADDR, "BAD_PATH");
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = _quoteAndPay(path[0], amountIn, amountOutMin, to);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountOut;
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256
    ) external {
        require(path.length >= 2 && path[path.length - 1] == WETH_ADDR, "BAD_PATH");
        uint256 balBefore = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 received = IERC20(path[0]).balanceOf(address(this)) - balBefore;
        _quoteAndPay(path[0], received, amountOutMin, to);
    }

    receive() external payable {}
}

/// @title AUDIT TF-010 + TF-015 — conversion floors in the right dimension
/// @notice TF-010: the conversion entry gate was 1e18 RAW TOKEN UNITS (~1e12 USDC), so
///         low-decimal fees were unreachable while both owner exits reject any token with
///         a WETH pair. TF-015: `convertTokenFeesToETHFoT` sized its TWAP floor on GROSS
///         input, so any FoT fee above TWAP_SAFETY_BPS (1.5%) made it unreachable forever.
/// @dev    `convertTokenFeesToETHFoT` had ZERO test coverage before this file — verified,
///         `grep -rn "ToETHFoT"` returned three src hits and no test hits.
contract SwapFeeRouter_TF010 is Test {
    using stdStorage for StdStorage;

    address internal treasury = makeAddr("treasury");
    address internal keeper   = makeAddr("keeper");
    address internal attacker = makeAddr("attacker");
    uint256 internal constant FEE_BPS = 30;

    // 6-decimal rig: 200_000e6 : 100e18  =>  5e8 wei per RAW unit, 5e14 wei per whole
    // token (~$0.0005/unit at $2k ETH). 1 whole token is 1e6 raw — one MILLIONTH of the
    // deleted 1e18 raw gate.
    uint112 internal constant R6_TOKEN = 200_000e6;
    uint112 internal constant R6_WETH  = 100 ether;
    // 18-decimal rig: 100_000e18 : 100e18 => 1e15 wei per whole token.
    uint112 internal constant R18_TOKEN = 100_000 ether;
    uint112 internal constant R18_WETH  = 100 ether;

    struct Rig {
        SwapFeeRouter sfr;
        MockUniRouter_TF uniRouter;
        MockUniFactory_TF factory;
        MockUniPair_TF pair;
        MockToken_TF weth;
        MockToken_TF tok;
    }

    function setUp() public {
        // SequencerCheck is a no-op only for feed == address(0) on chainid 1.
        vm.chainId(1);
    }

    function _rig(uint8 dec, uint256 fotBps, uint112 resTok, uint112 resWeth)
        internal
        returns (Rig memory g)
    {
        g.weth = new MockToken_TF("Wrapped Ether", "WETH", 18, 0);
        g.factory = new MockUniFactory_TF();
        g.uniRouter = new MockUniRouter_TF(address(g.weth), address(g.factory));
        vm.deal(address(g.uniRouter), 10_000 ether);
        g.tok = new MockToken_TF("Fee Token", "FEE", dec, fotBps);

        address t0 = address(g.tok) < address(g.weth) ? address(g.tok) : address(g.weth);
        address t1 = address(g.tok) < address(g.weth) ? address(g.weth) : address(g.tok);
        g.pair = new MockUniPair_TF(t0, t1);
        g.factory.setPair(address(g.tok), address(g.weth), address(g.pair));
        _setReserves(g, resTok, resWeth);

        g.sfr = new SwapFeeRouter(
            address(g.uniRouter), treasury, FEE_BPS, address(0),
            address(uint160(uint256(keccak256("MOCK_REV_DIST"))))
        );
        g.sfr.setSwapFeeRouterAdmin(address(new SwapFeeRouterAdmin(address(g.sfr))));
    }

    function _setReserves(Rig memory g, uint112 resTok, uint112 resWeth) internal {
        if (g.pair.token0() == address(g.tok)) g.pair.setReserves(resTok, resWeth);
        else g.pair.setReserves(resWeth, resTok);
    }

    function _path(Rig memory g) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = address(g.tok);
        p[1] = address(g.weth);
    }

    function _dl() internal view returns (uint256) { return block.timestamp + 30 minutes; }

    /// @dev Book `amount` raw units of fees AND put the matching balance on hand.
    ///      stdstore, NOT a hardcoded slot: this change-set APPENDS state to
    ///      SwapFeeRouter, and a hardcoded `accumulatedTokenFees` slot is precisely the
    ///      scar the rest of this suite keeps re-opening. `mint` is fee-free on both
    ///      token kinds (OZ `_update` with from == address(0)).
    function _seed(Rig memory g, uint256 amount) internal {
        g.tok.mint(address(g.sfr), amount);
        stdstore.target(address(g.sfr)).sig("accumulatedTokenFees(address)")
            .with_key(address(g.tok)).checked_write(amount);
        assertEq(g.sfr.accumulatedTokenFees(address(g.tok)), amount, "fee seed failed");
    }

    /// @dev Owner bootstraps the snapshot, reserves are restored, 2h of cumulative are
    ///      poked. VACUITY GUARD: without reaching the POST-bootstrap priced path, both
    ///      owner-only early returns in `_enforceTWAPMinETHOut` hand back
    ///      `callerMinETHOut` and NEVER READ `amountIn`, so every TF-015 assertion would
    ///      pass regardless of the patch. Leaves the caller on the priced path.
    function _bootstrapPriced(Rig memory g, uint256 seedAmt, uint112 resTok, uint112 resWeth, bool fot)
        internal
    {
        // ORDER IS LOAD-BEARING: poke AFTER the skip, never before.
        // UniswapV2OracleLibrary.currentCumulativePrices EXTRAPOLATES - it adds
        // `spot * (block.timestamp - blockTimestampLast)` on top of the stored cumulative.
        // `pokeCumulative` stamps blockTimestampLast = now, so poking BEFORE the skip stores
        // an hour that has not elapsed yet and the library then extrapolates a SECOND hour
        // on top. The snapshot reads 2x, the delta reads 1x, and the TWAP comes out at
        // EXACTLY HALF SPOT - which is why every floor assertion written against this rig
        // before 2026-09-05 was vacuous, TF-015's included.
        skip(60 minutes);
        g.pair.pokeCumulative(uint32(60 minutes));
        _seed(g, seedAmt);
        if (fot) g.sfr.convertTokenFeesToETHFoT(address(g.tok), _path(g), 0, _dl());
        else     g.sfr.convertTokenFeesToETH(address(g.tok), _path(g), 0, _dl());
        assertGt(_snapshotTs(g), 0, "bootstrap did not seed the snapshot");
        _setReserves(g, resTok, resWeth);
        skip(2 hours);
        g.pair.pokeCumulative(uint32(2 hours));
    }

    function _snapshotTs(Rig memory g) internal view returns (uint32 ts) {
        (ts,) = g.sfr.lastConversionSnapshot(address(g.tok));
    }

    /// @dev The `effectiveMinETHOut` the contract actually enforced, straight off the
    ///      ConversionTWAPFloor event. Lets two rigs be compared EXACTLY without
    ///      re-implementing the TWAP formula in the test.
    function _lastFloor() internal returns (uint256) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("ConversionTWAPFloor(address,uint256,uint256,bool)");
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics.length > 0 && logs[i - 1].topics[0] == sig) {
                (uint256 eff,,) = abi.decode(logs[i - 1].data, (uint256, uint256, bool));
                return eff;
            }
        }
        revert("no ConversionTWAPFloor emitted");
    }


    // ─────────────────────────── TF-010 ───────────────────────────

    /// T1 — THE FINDING. A 6-decimal pile worth ~0.05 ETH converts. Pre-fix it could not:
    ///      100e6 < 1e18 raw, and withdrawTokenFees/sweepTokens both reject a token with a
    ///      WETH pair, so this value had NO exit.
    function test_TF010_lowDecimalPile_isReachable() public {
        Rig memory g = _rig(6, 0, R6_TOKEN, R6_WETH);
        _bootstrapPriced(g, 100e6, R6_TOKEN, R6_WETH, false);
        _seed(g, 100e6);
        uint256 ethBefore = g.sfr.accumulatedETHFees();

        vm.prank(keeper);
        g.sfr.convertTokenFeesToETH(address(g.tok), _path(g), 0, _dl());

        assertEq(g.sfr.accumulatedTokenFees(address(g.tok)), 0, "pile not consumed");
        assertGt(g.sfr.accumulatedETHFees(), ethBefore, "no ETH credited");
    }

    /// T2 — the anti-grief property SFR-M-02 exists for, re-expressed in wei of ETH, plus
    ///      the atomicity that replaces the old ordering. Pins the INVARIANT (the cooldown
    ///      is not entered) and not only the revert selector.
    function test_TF010_strangerDustPile_revertsAndDoesNotStampCooldown() public {
        Rig memory g = _rig(6, 0, R6_TOKEN, R6_WETH);
        _bootstrapPriced(g, 100e6, R6_TOKEN, R6_WETH, false);

        // 1e5 raw = 0.1 token ~= 5e13 wei, below MIN_MULTIHOP_ETH_OUT_WEI (1e14) but far
        // above what the swap needs to succeed — so the gate, not the swap, must reject.
        _seed(g, 1e5);
        uint256 cooldownBefore = g.sfr.lastConvertedAt(address(g.tok));
        vm.prank(attacker);
        vm.expectRevert(SwapFeeRouter.TokenFeesBelowMinimum.selector);
        g.sfr.convertTokenFeesToETH(address(g.tok), _path(g), 0, _dl());
        assertEq(g.sfr.lastConvertedAt(address(g.tok)), cooldownBefore, "cooldown was stamped");

        // ... and the keeper's legitimate conversion still lands IN THE SAME BLOCK.
        _seed(g, 100e6);
        vm.prank(keeper);
        g.sfr.convertTokenFeesToETH(address(g.tok), _path(g), 0, _dl());
        assertEq(g.sfr.accumulatedTokenFees(address(g.tok)), 0, "keeper conversion bricked");
    }

    /// T3 — THE STOP. The owner's first-ever conversion of a token, minETHOut = 0, no
    ///      snapshot: must SUCCEED. An unconditional value floor at this call site is the
    ///      relocated bootstrap deadlock — no conversion without a price, no price without
    ///      a conversion.
    function test_TF010_ownerBootstrap_isNotDeadlocked() public {
        Rig memory g = _rig(6, 0, R6_TOKEN, R6_WETH);
        g.pair.pokeCumulative(uint32(60 minutes));
        skip(60 minutes);
        _seed(g, 100e6);

        g.sfr.convertTokenFeesToETH(address(g.tok), _path(g), 0, _dl()); // owner, no snapshot
        assertEq(g.sfr.accumulatedTokenFees(address(g.tok)), 0, "bootstrap reverted or no-op'd");
        assertGt(_snapshotTs(g), 0, "snapshot not established");
    }

    /// T4 — the SECOND owner-only early return (`elapsed < MIN_TWAP_PERIOD`, lib:517) is
    ///      exempt too. Reached by zeroing the cooldown and re-converting in the same block,
    ///      which is the only way to get elapsed below 30 min under a 1h cooldown.
    function test_TF010_ownerShortIntegralReturn_isNotDeadlocked() public {
        Rig memory g = _rig(6, 0, R6_TOKEN, R6_WETH);
        g.pair.pokeCumulative(uint32(60 minutes));
        skip(60 minutes);
        _seed(g, 100e6);
        g.sfr.convertTokenFeesToETH(address(g.tok), _path(g), 0, _dl()); // seeds snapshot @ now

        stdstore.target(address(g.sfr)).sig("lastConvertedAt(address)")
            .with_key(address(g.tok)).checked_write(uint256(0));
        _seed(g, 100e6);
        g.sfr.convertTokenFeesToETH(address(g.tok), _path(g), 0, _dl()); // elapsed == 0
        assertEq(g.sfr.accumulatedTokenFees(address(g.tok)), 0, "short-integral owner path gated");
    }

    // ─────────────────────────── TF-015 ───────────────────────────









    // ───────────── convertTokenFeesToETHFoT — first coverage ─────────────
    //
    // This function is PERMISSIONLESS (SwapFeeRouter external, nonReentrant whenNotPaused;
    // the owner gate fires only for path.length > 2) and had ZERO tests before this block.
    //
    // ⚠️ WHAT IS DELIBERATELY *NOT* TESTED HERE, AND WHY. Nothing below asserts on the
    //    TWAP FLOOR VALUE, because this rig cannot yet produce a trustworthy one.
    //    Measured 2026-09-05: with reserves 100 WETH : 100_000 TOK (spot 1e-3 ETH/TOK) and
    //    a 100 TOK pile, the enforced floor came back 4.925e16 — exactly HALF the correct
    //    9.85e16. Cause: `_bootstrapPriced` pokes the cumulative once before the clock
    //    advances and once after, so the snapshot captures 7200s of accumulation while the
    //    delta over the consulted window is only 3600s worth. The floor therefore sits at
    //    half spot and never binds.
    //    That is why the withdrawn TF-015 tests were vacuous — its headline test passed
    //    under the mutation that restores the pre-fix source. DO NOT write a floor
    //    assertion against this rig until the poke sequence is fixed and a test proves the
    //    enforced floor matches spot. See docs/TODO_OPERATOR.md D1.

    function test_FoT_rejectsWETHAsTheFeeToken() public {
        Rig memory g = _rig(18, 500, R18_TOKEN, R18_WETH);
        vm.prank(keeper);
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        g.sfr.convertTokenFeesToETHFoT(address(g.weth), _path(g), 0, _dl());
    }

    function test_FoT_rejectsZeroToken() public {
        Rig memory g = _rig(18, 500, R18_TOKEN, R18_WETH);
        vm.prank(keeper);
        vm.expectRevert(SwapFeeRouter.ZeroAddress.selector);
        g.sfr.convertTokenFeesToETHFoT(address(0), _path(g), 0, _dl());
    }

    function test_FoT_rejectsAnExpiredDeadline() public {
        Rig memory g = _rig(18, 500, R18_TOKEN, R18_WETH);
        _seed(g, 10 ether);
        vm.prank(keeper);
        vm.expectRevert(bytes("DEADLINE_EXPIRED"));
        g.sfr.convertTokenFeesToETHFoT(address(g.tok), _path(g), 0, block.timestamp - 1);
    }

    function test_FoT_rejectsADeadlineBeyondTheCap() public {
        Rig memory g = _rig(18, 500, R18_TOKEN, R18_WETH);
        _seed(g, 10 ether);
        vm.prank(keeper);
        vm.expectRevert(SwapFeeRouter.DeadlineTooFar.selector);
        g.sfr.convertTokenFeesToETHFoT(address(g.tok), _path(g), 0, block.timestamp + 365 days);
    }

    /// An empty pile must not reach the swap. Without this the owner — exempt from the
    /// TF-010 value gate — would stamp the cooldown and rewrite the snapshot for nothing.
    function test_FoT_zeroPileReverts() public {
        Rig memory g = _rig(18, 500, R18_TOKEN, R18_WETH);
        vm.prank(keeper);
        vm.expectRevert(SwapFeeRouter.ZeroAmount.selector);
        g.sfr.convertTokenFeesToETHFoT(address(g.tok), _path(g), 0, _dl());
    }

    /// The per-token cooldown is the anti-grief property TF-010 re-dimensioned rather than
    /// removed: a second conversion inside the window is refused.
    function test_FoT_perTokenCooldownIsEnforced() public {
        // 50 bps, under TWAP_SAFETY_BPS (150). Above it the floor - which now BINDS
        // since the rig was corrected - is unreachable on gross sizing; that strand is
        // TF-015 and it has its own test below.
        Rig memory g = _rig(18, 50, R18_TOKEN, R18_WETH);
        _bootstrapPriced(g, 1 ether, R18_TOKEN, R18_WETH, true);
        _seed(g, 50 ether);
        vm.prank(keeper);
        g.sfr.convertTokenFeesToETHFoT(address(g.tok), _path(g), 0, _dl());

        _seed(g, 50 ether);
        vm.prank(keeper);
        vm.expectRevert();
        g.sfr.convertTokenFeesToETHFoT(address(g.tok), _path(g), 0, _dl());
    }

    /// Multi-hop stays owner-only on the FoT path too — a stranger cannot choose the route.
    function test_FoT_multiHopIsOwnerOnly() public {
        Rig memory g = _rig(18, 500, R18_TOKEN, R18_WETH);
        _seed(g, 10 ether);
        address[] memory hop3 = new address[](3);
        hop3[0] = address(g.tok);
        hop3[1] = makeAddr("middle");
        hop3[2] = address(g.weth);
        vm.prank(attacker);
        vm.expectRevert();
        g.sfr.convertTokenFeesToETHFoT(address(g.tok), hop3, 0, _dl());
    }

    /// The happy path, and the one property that makes this function exist: a
    /// fee-on-transfer token delivers LESS to the pair than the router sent, and the
    /// conversion still settles against what actually arrived.
    ///
    /// MUTATION: give MockToken_TF a zero fee (`_rig(18, 0, ...)`) and the strict
    /// inequality below fails — which is what proves the FoT shrink is real and not an
    /// artefact of the mock.
    function test_FoT_settlesAgainstWhatThePairActuallyReceived() public {
        // 50 bps, under TWAP_SAFETY_BPS (150). Above it the floor - which now BINDS
        // since the rig was corrected - is unreachable on gross sizing; that strand is
        // TF-015 and it has its own test below.
        Rig memory g = _rig(18, 50, R18_TOKEN, R18_WETH);
        _bootstrapPriced(g, 1 ether, R18_TOKEN, R18_WETH, true);
        _seed(g, 100 ether);

        uint256 ethBefore = g.sfr.accumulatedETHFees();
        // Measure the SAME address before and after. The mock router is what receives the
        // transfer, so its delta is what actually arrived downstream.
        uint256 downstreamBefore = g.tok.balanceOf(address(g.uniRouter));
        uint256 sentByFeeRouter = g.tok.balanceOf(address(g.sfr));

        vm.prank(keeper);
        g.sfr.convertTokenFeesToETHFoT(address(g.tok), _path(g), 0, _dl());

        assertEq(g.sfr.accumulatedTokenFees(address(g.tok)), 0, "the pile must be retired");
        assertGt(g.sfr.accumulatedETHFees(), ethBefore, "ETH fees must grow");

        // The FoT burn is real: strictly less arrived downstream than the fee router sent.
        uint256 delivered = g.tok.balanceOf(address(g.uniRouter)) - downstreamBefore;
        assertLt(delivered, sentByFeeRouter, "an FoT token must deliver less than was sent");
    }


    /// ⚠️ CHARACTERISATION OF A KNOWN, UNFIXED DEFECT — TF-015.
    ///
    /// This test asserts the CURRENT behaviour, which is WRONG. It exists because the
    /// behaviour was previously invisible: the rig's TWAP floor came out at half spot, so
    /// nothing bound and the strand could not be observed. With the poke order corrected
    /// (see `_bootstrapPriced`), it is observable, and pinning it is how the fix becomes
    /// verifiable instead of merely plausible.
    ///
    /// THE DEFECT: `convertTokenFeesToETHFoT` sizes its TWAP floor on the GROSS balance,
    /// but a fee-on-transfer token delivers less than gross to the pair. Any FoT fee above
    /// TWAP_SAFETY_BPS (150 bps = 1.5%) therefore makes the floor unreachable forever —
    /// and `withdrawTokenFees` / `sweepTokens` both reject any token WITH a WETH pair, so
    /// those fees have no exit at all. Real FoT tokens are 2-10%.
    ///
    /// ⛔ WHEN TF-015 LANDS, THIS TEST MUST BE INVERTED, not deleted. Its failure is the
    ///    signal that the fix works. See docs/TODO_OPERATOR.md D1.
    function test_TF015_KNOWNBUG_grossSizedFloorStrandsAnFoTToken() public {
        Rig memory g = _rig(18, 500, R18_TOKEN, R18_WETH); // 5%, a realistic FoT fee
        _bootstrapPriced(g, 1 ether, R18_TOKEN, R18_WETH, false);
        _seed(g, 100 ether);

        vm.prank(keeper);
        vm.expectRevert(bytes("INSUFFICIENT_OUTPUT"));
        g.sfr.convertTokenFeesToETHFoT(address(g.tok), _path(g), 0, _dl());

        assertEq(
            g.sfr.accumulatedTokenFees(address(g.tok)),
            100 ether,
            "the pile is stranded: nothing moved, and no other exit accepts this token"
        );
    }

    /// ⚠️ THIS TEST GUARDS EVERY OTHER TEST IN THIS FILE. Do not delete it.
    ///
    /// Every floor assertion here is worthless unless the rig produces a TWAP that matches
    /// reality. It did not, until 2026-09-05: `_bootstrapPriced` poked the pair's cumulative
    /// BEFORE the clock advanced, and `UniswapV2OracleLibrary.currentCumulativePrices`
    /// EXTRAPOLATES `spot * (block.timestamp - blockTimestampLast)` on top of the stored
    /// value — so the snapshot read twice the accumulation it should and the enforced floor
    /// came out at EXACTLY HALF SPOT. A floor at half spot never binds, so the whole TF-015
    /// test set passed against a fix that did nothing, including under the mutation that
    /// restores the pre-fix source.
    ///
    /// So: pin the rig, not just the contract. Reverse the two lines in `_bootstrapPriced`
    /// and this test fails immediately with `floor is half spot` — which is the only reason
    /// anyone would notice.
    function test_RIG_enforcedFloorMatchesSpot() public {
        Rig memory g = _rig(18, 0, R18_TOKEN, R18_WETH);
        _bootstrapPriced(g, 1 ether, R18_TOKEN, R18_WETH, false);
        _seed(g, 100 ether);

        vm.recordLogs();
        vm.prank(keeper);
        g.sfr.convertTokenFeesToETH(address(g.tok), _path(g), 0, _dl());

        // reserves 100 WETH : 100_000 TOK  ->  spot 1e-3 ETH/TOK
        // 100 TOK -> 1e17 wei, less TWAP_SAFETY_BPS (150) -> 9.85e16
        uint256 expected = (100 ether * 1e20 / 1e23) * (10_000 - 150) / 10_000;
        uint256 seen = _lastFloor();

        // 1 wei of integer rounding is fine; a factor of two is the bug this guards.
        assertApproxEqAbs(seen, expected, 2, "enforced floor must equal the spot-derived floor");
        assertGt(seen * 2, expected * 3 / 2, "floor is half spot - the poke order regressed");
    }
}
