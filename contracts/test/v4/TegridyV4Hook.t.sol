// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TegridyV4Hook} from "../../src/v4/TegridyV4Hook.sol";
import {TegridyV4HookAdmin} from "../../src/v4/TegridyV4HookAdmin.sol";
import {TegridyV4SwapRouter} from "../../src/v4/TegridyV4SwapRouter.sol";
import {TegridyBoostedLPStaker} from "../../src/v4/TegridyBoostedLPStaker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "solmate/test/utils/mocks/MockERC20.sol";

/// @notice Behavioral tests for the custom surface of TegridyV4Hook (allowlist,
///         fee override wiring, admin gating, POL skim accrual + sweep/redeem
///         conservation) and the TegridyV4HookAdmin timelock. The verbatim JIT
///         logic is covered by OZ's own suite.
contract TegridyV4HookTest is Test, Deployers {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;

    TegridyV4Hook internal hook;
    PoolKey internal poolKey;
    address internal treasury = makeAddr("treasury");
    address internal stranger = makeAddr("stranger");
    address internal guardian = makeAddr("guardian");

    uint24 internal constant MIN_FEE = 500; // 0.05%
    uint24 internal constant MAX_FEE = 30_000; // 3%
    uint24 internal constant BASE_FEE = 3_000; // 0.30%
    uint16 internal constant MAX_POL_BPS = 1_000; // 10%
    uint16 internal constant POL_BPS = 100; // 1%
    uint48 internal constant BLOCK_OFFSET = 10;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        hook = _mineAndDeployHook(address(this));

        poolKey = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, int24(60), IHooks(address(hook)));
        hook.setPoolAllowed(poolKey, true);
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            poolKey, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100 ether, salt: 0}), ""
        );
    }

    /// @dev Mine a CREATE2 address whose low bits match the hook permissions, deploy there.
    function _mineAndDeployHook(address paramAdmin_) internal returns (TegridyV4Hook h) {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
                | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
        );
        bytes memory ctorArgs = abi.encode(
            manager, BLOCK_OFFSET, paramAdmin_, MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, treasury
        );
        (address hookAddr, bytes32 salt) = HookMiner.find(address(this), flags, type(TegridyV4Hook).creationCode, ctorArgs);
        h = new TegridyV4Hook{salt: salt}(
            manager, BLOCK_OFFSET, paramAdmin_, MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, treasury
        );
        require(address(h) == hookAddr, "hook addr mismatch");
    }

    function _swapOnceZeroForOne() internal {
        swapRouter.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ─── Allowlist (Cork defense) ─────────────────────────────────────

    function test_allowlist_blocksUnregisteredPool() public {
        PoolKey memory rogue = PoolKey(currency0, currency1, uint24(3000), int24(60), IHooks(address(hook)));
        vm.expectRevert();
        manager.initialize(rogue, SQRT_PRICE_1_1);
    }

    function test_revert_staticFeePoolEvenIfAllowlisted() public {
        PoolKey memory staticKey = PoolKey(currency0, currency1, uint24(3000), int24(60), IHooks(address(hook)));
        hook.setPoolAllowed(staticKey, true);
        vm.expectRevert();
        manager.initialize(staticKey, SQRT_PRICE_1_1);
    }

    // ─── Admin gating + bounds ────────────────────────────────────────

    function test_setBaseFee_onlyAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(TegridyV4Hook.NotParamAdmin.selector);
        hook.setBaseFee(1000);
    }

    function test_setBaseFee_respectsBounds() public {
        vm.expectRevert(TegridyV4Hook.FeeOutOfBounds.selector);
        hook.setBaseFee(MAX_FEE + 1);
        hook.setBaseFee(MIN_FEE);
        assertEq(hook.baseFeePips(), MIN_FEE);
    }

    function test_setPolSkim_respectsCeiling() public {
        vm.expectRevert(TegridyV4Hook.SkimOutOfBounds.selector);
        hook.setPolSkimBps(MAX_POL_BPS + 1);
        hook.setPolSkimBps(MAX_POL_BPS);
        assertEq(hook.polSkimBps(), MAX_POL_BPS);
    }

    // ─── POL skim: accrual + sweep + redeem (the high-risk path) ──────

    function test_pol_accruesOnSwapAndSweepsWithoutLeak() public {
        uint256 id1 = currency1.toId();
        assertEq(manager.balanceOf(address(hook), id1), 0, "hook starts with no claims");

        _swapOnceZeroForOne();

        uint256 accrued = manager.balanceOf(address(hook), id1);
        assertGt(accrued, 0, "POL skim accrued claims to the hook");

        uint256 treasuryBefore = manager.balanceOf(treasury, id1);
        hook.sweepPOL(currency1);
        assertEq(manager.balanceOf(address(hook), id1), 0, "hook swept to zero");
        assertEq(manager.balanceOf(treasury, id1), treasuryBefore + accrued, "treasury received exactly the accrued claims");
    }

    function test_pol_redeemConvertsClaimsToRealCurrency() public {
        _swapOnceZeroForOne();
        uint256 id1 = currency1.toId();
        uint256 accrued = manager.balanceOf(address(hook), id1);
        assertGt(accrued, 0);

        uint256 treasuryRealBefore = currency1.balanceOf(treasury);
        hook.redeemPOL(currency1);
        assertEq(manager.balanceOf(address(hook), id1), 0, "claims burned");
        assertEq(currency1.balanceOf(treasury), treasuryRealBefore + accrued, "treasury got real tokens, no leak");
    }

    /// @dev [LOW-4 2026-05-31] sweepPOL is now governance-gated (onlyParamAdmin), so it can
    ///      no longer be called permissionlessly to bypass the staker/treasury fee split.
    function test_LOW4_sweepPOL_onlyParamAdmin() public {
        _swapOnceZeroForOne();
        vm.prank(stranger);
        vm.expectRevert(TegridyV4Hook.NotParamAdmin.selector);
        hook.sweepPOL(currency1);
        // paramAdmin (this test contract) can still sweep.
        hook.sweepPOL(currency1);
        assertEq(manager.balanceOf(address(hook), currency1.toId()), 0, "paramAdmin swept");
    }

    function test_pol_zeroSkimAccruesNothing() public {
        hook.setPolSkimBps(0);
        _swapOnceZeroForOne();
        assertEq(manager.balanceOf(address(hook), currency1.toId()), 0, "no skim when polSkimBps == 0");
    }

    /// @dev exactOutput zeroForOne: the unspecified currency is the INPUT (currency0),
    ///      so the skim must accrue there.
    function test_pol_exactOutputAccruesInputCurrency() public {
        uint256 id0 = currency0.toId();
        assertEq(manager.balanceOf(address(hook), id0), 0);
        swapRouter.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: 0.5 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertGt(manager.balanceOf(address(hook), id0), 0, "exactOutput skims the unspecified (input) currency");
    }

    function test_pol_multiSwapAccumulates() public {
        _swapOnceZeroForOne();
        uint256 a1 = manager.balanceOf(address(hook), currency1.toId());
        _swapOnceZeroForOne();
        uint256 a2 = manager.balanceOf(address(hook), currency1.toId());
        assertGt(a1, 0);
        assertGt(a2, a1, "POL claims accumulate across multiple swaps");
    }

    /// @dev Fuzz the core conservation invariant across any skim rate / swap size:
    ///      whatever the hook accrues, redeemPOL moves EXACTLY that to the treasury
    ///      as real tokens — nothing created, nothing stuck.
    function testFuzz_polRedeemConservation(uint16 bps, uint96 swapAmt) public {
        bps = uint16(bound(bps, 1, MAX_POL_BPS));
        swapAmt = uint96(bound(swapAmt, 0.001 ether, 5 ether));
        hook.setPolSkimBps(bps);

        swapRouter.swap(
            poolKey,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(uint256(swapAmt)),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 id1 = currency1.toId();
        uint256 accrued = manager.balanceOf(address(hook), id1);
        uint256 tBefore = currency1.balanceOf(treasury);
        hook.redeemPOL(currency1);
        assertEq(manager.balanceOf(address(hook), id1), 0, "no stuck claims");
        assertEq(currency1.balanceOf(treasury), tBefore + accrued, "treasury credited exactly the accrued amount");
    }

    // ─── TegridyV4HookAdmin timelock ──────────────────────────────────

    function test_admin_baseFeeTimelockFlow() public {
        TegridyV4HookAdmin admin = new TegridyV4HookAdmin();
        TegridyV4Hook ahook = _mineAndDeployHook(address(admin));
        admin.setHook(address(ahook));

        admin.proposeBaseFee(MIN_FEE);
        vm.expectRevert(); // ProposalNotReady
        admin.executeBaseFee();

        vm.warp(block.timestamp + 24 hours + 1);
        admin.executeBaseFee();
        assertEq(ahook.baseFeePips(), MIN_FEE, "timelocked fee change applied");
    }

    function test_admin_onlyOwnerProposes() public {
        TegridyV4HookAdmin admin = new TegridyV4HookAdmin();
        TegridyV4Hook ahook = _mineAndDeployHook(address(admin));
        admin.setHook(address(ahook));

        vm.prank(stranger);
        vm.expectRevert();
        admin.proposeBaseFee(MIN_FEE);
    }

    function test_admin_setHookIsOneTime() public {
        TegridyV4HookAdmin admin = new TegridyV4HookAdmin();
        TegridyV4Hook ahook = _mineAndDeployHook(address(admin));
        admin.setHook(address(ahook));
        vm.expectRevert(TegridyV4HookAdmin.HookAlreadySet.selector);
        admin.setHook(address(ahook));
    }

    function test_admin_discountConfigTimelockFlow() public {
        TegridyV4HookAdmin admin = new TegridyV4HookAdmin();
        TegridyV4Hook ahook = _mineAndDeployHook(address(admin));
        admin.setHook(address(ahook));

        // `premiumAccess` must be a real contract: the 2026-06-07 audit fix makes
        // `setDiscountConfig` reject `code.length` 0 (EOA) or 23 (7702-delegated EOA)
        // — see test_setDiscountConfig_rejectsEOAPremiumAccess. The timelock route is
        // NOT a bypass, so this flow has to propose a deployed contract, not a bare
        // `makeAddr`. `trustedRouter` is only ever compared, never called, so it stays
        // a plain address.
        address pa = address(new MockPremiumAccess());
        address router = makeAddr("router");
        admin.proposeDiscountConfig(pa, router, 3000);
        vm.warp(block.timestamp + 24 hours + 1);
        admin.executeDiscountConfig();

        assertEq(ahook.premiumAccess(), pa);
        assertEq(ahook.trustedRouter(), router);
        assertEq(ahook.discountBps(), 3000);
    }

    function test_admin_feeSplitTimelockFlow() public {
        TegridyV4HookAdmin admin = new TegridyV4HookAdmin();
        TegridyV4Hook ahook = _mineAndDeployHook(address(admin));
        admin.setHook(address(ahook));

        admin.proposeFeeSplit(6000, 1000);
        admin.proposeFeeSinks(makeAddr("sSink"), makeAddr("tSink"));
        vm.warp(block.timestamp + 48 hours + 1);
        admin.executeFeeSplit();
        admin.executeFeeSinks();

        assertEq(ahook.stakerShareBps(), 6000);
        assertEq(ahook.treasuryShareBps(), 1000);
        assertEq(ahook.stakerSink(), makeAddr("sSink"));
    }

    // ─── Emergency pause ──────────────────────────────────────────────

    function test_pause_guardianHaltsSwapsThenAdminUnpauses() public {
        hook.setPauseGuardian(guardian); // as paramAdmin (== this)
        vm.prank(guardian);
        hook.guardianPause();
        assertTrue(hook.paused());

        vm.expectRevert(); // TradingPaused (wrapped by PoolManager)
        _swapOnceZeroForOne();

        hook.setPaused(false); // paramAdmin recovery
        assertFalse(hook.paused());
        _swapOnceZeroForOne(); // succeeds again
    }

    function test_pause_guardianIsPauseOnly() public {
        hook.setPauseGuardian(guardian);
        vm.prank(guardian);
        hook.guardianPause();
        // guardian cannot unpause — that's paramAdmin-only
        vm.prank(guardian);
        vm.expectRevert(TegridyV4Hook.NotParamAdmin.selector);
        hook.setPaused(false);
    }

    function test_pause_liquidityExitOpenWhilePaused() public {
        hook.setPauseGuardian(guardian);
        vm.roll(block.number + 11); // past JIT window so removal isn't penalized
        vm.prank(guardian);
        hook.guardianPause();
        // withdrawing liquidity must still work while paused (never trap funds)
        modifyLiquidityRouter.modifyLiquidity(
            poolKey, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: -10 ether, salt: 0}), ""
        );
    }

    // ─── Native-ETH currency pool (the real TOWELI/ETH redemption path) ──

    function test_pol_nativeEthRedemption() public {
        Currency native = CurrencyLibrary.ADDRESS_ZERO;
        PoolKey memory nativeKey = PoolKey(native, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, int24(60), IHooks(address(hook)));
        hook.setPoolAllowed(nativeKey, true);
        manager.initialize(nativeKey, SQRT_PRICE_1_1);

        deal(address(this), 100 ether);
        modifyLiquidityRouter.modifyLiquidity{value: 50 ether}(
            nativeKey, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100 ether, salt: 0}), ""
        );

        // oneForZero exact-input: pay currency1, receive native => unspecified = native (output).
        swapRouter.swap(
            nativeKey,
            SwapParams({zeroForOne: false, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 idN = native.toId();
        uint256 accrued = manager.balanceOf(address(hook), idN);
        assertGt(accrued, 0, "native POL accrued as claims");

        uint256 tBefore = treasury.balance;
        hook.redeemPOL(native);
        assertEq(manager.balanceOf(address(hook), idN), 0, "native claims burned");
        assertEq(treasury.balance, tBefore + accrued, "treasury received real ETH, no leak");
    }

    // ─── Invariant: base fee can never leave its immutable bounds ──────

    function testFuzz_baseFeeAlwaysWithinBounds(uint24 f) public {
        if (f < MIN_FEE || f > MAX_FEE) {
            vm.expectRevert(TegridyV4Hook.FeeOutOfBounds.selector);
            hook.setBaseFee(f);
        } else {
            hook.setBaseFee(f);
            assertGe(hook.baseFeePips(), MIN_FEE);
            assertLe(hook.baseFeePips(), MAX_FEE);
        }
    }

    // ─── #2 Premium fee discount (Gold Card "Reduced Fees") ───────────

    function test_discount_onlyViaTrustedRouterForPremium() public {
        MockPremiumAccess pa = new MockPremiumAccess();
        address user = makeAddr("premiumUser");
        pa.setPremium(user, true);
        address router = makeAddr("trustedRouter");
        hook.setDiscountConfig(address(pa), router, 5000); // 50% off

        // premium user, via the trusted router => discounted
        assertEq(hook.quoteFee(router, abi.encode(user)), BASE_FEE / 2, "premium via trusted router => 50% off");
        // non-premium user => full fee
        assertEq(hook.quoteFee(router, abi.encode(makeAddr("rando"))), BASE_FEE, "non-premium => full fee");
        // ANTI-SPOOF: an untrusted sender passing the premium user gets NO discount
        assertEq(hook.quoteFee(makeAddr("rawRouter"), abi.encode(user)), BASE_FEE, "untrusted router => no discount");
    }

    function test_discount_disabledByDefault() public {
        assertEq(hook.quoteFee(address(this), abi.encode(makeAddr("anyone"))), BASE_FEE, "no config => base fee");
    }

    // ── AUDIT 2026-06-07: premiumAccess is *called* (hasPremium) inside
    //    _discountedFee, so setDiscountConfig must reject an EOA / 7702-delegated
    //    EOA that could return true to grant the discount — mirrors
    //    SwapFeeRouter.applyPremiumAccess. address(0) stays the disable path. ──
    function test_setDiscountConfig_rejectsEOAPremiumAccess() public {
        address eoa = makeAddr("eoaPremium"); // code.length == 0
        vm.expectRevert(TegridyV4Hook.NotAContract.selector);
        hook.setDiscountConfig(eoa, makeAddr("router"), 5000);
    }

    function test_setDiscountConfig_allowsZeroToDisable() public {
        MockPremiumAccess pa = new MockPremiumAccess();
        hook.setDiscountConfig(address(pa), makeAddr("router"), 5000); // enable
        hook.setDiscountConfig(address(0), address(0), 0);             // disable — must not revert
        assertEq(hook.quoteFee(makeAddr("router"), abi.encode(makeAddr("u"))), BASE_FEE, "disabled => base fee");
    }

    function test_discount_flooredAtMinFee() public {
        MockPremiumAccess pa = new MockPremiumAccess();
        address user = makeAddr("p");
        pa.setPremium(user, true);
        address router = makeAddr("r");
        hook.setDiscountConfig(address(pa), router, 5000);
        hook.setBaseFee(MIN_FEE); // base already at the floor
        assertEq(hook.quoteFee(router, abi.encode(user)), MIN_FEE, "discount cannot push below minFee");
    }

    // ─── #1 Fee split → stakers / treasury / POL ──────────────────────

    function test_feeSplit_routesRealCurrencyToSinks() public {
        address stakerSink = makeAddr("stakerSink");
        address treasury2 = makeAddr("treasury2");
        hook.setFeeSplit(6000, 1000); // staker 60%, treasury 10%, POL 30%
        hook.setFeeSinks(stakerSink, treasury2);

        _swapOnceZeroForOne(); // accrues currency1 claims (polSkimBps default = 1%)
        uint256 id1 = currency1.toId();
        uint256 accrued = manager.balanceOf(address(hook), id1);
        assertGt(accrued, 0);

        uint256 sBefore = currency1.balanceOf(stakerSink);
        uint256 tBefore = currency1.balanceOf(treasury2);
        uint256 pBefore = currency1.balanceOf(treasury); // polRecipient == setUp `treasury`

        hook.distributeFees(currency1);

        uint256 sAmt = (accrued * 6000) / 10000;
        uint256 tAmt = (accrued * 1000) / 10000;
        uint256 pAmt = accrued - sAmt - tAmt;
        assertEq(currency1.balanceOf(stakerSink), sBefore + sAmt, "staker share routed");
        assertEq(currency1.balanceOf(treasury2), tBefore + tAmt, "treasury share routed");
        assertEq(currency1.balanceOf(treasury), pBefore + pAmt, "POL remainder routed");
        assertEq(manager.balanceOf(address(hook), id1), 0, "no stuck claims (conservation)");
    }

    // ─── Trusted swap router (Part A — user-identity for #2) ──────────

    function _approveRouter(TegridyV4SwapRouter r) internal {
        MockERC20(Currency.unwrap(currency0)).approve(address(r), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(r), type(uint256).max);
    }

    function test_trustedRouter_swapDeliversOutput() public {
        TegridyV4SwapRouter r = new TegridyV4SwapRouter(manager);
        _approveRouter(r);
        uint256 before = currency1.balanceOf(address(this));
        r.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            0,
            type(uint256).max,
            block.timestamp,
            address(this)
        );
        assertGt(currency1.balanceOf(address(this)), before, "router delivered swap output");
    }

    function test_trustedRouter_slippageReverts() public {
        TegridyV4SwapRouter r = new TegridyV4SwapRouter(manager);
        _approveRouter(r);
        vm.expectRevert(TegridyV4SwapRouter.TooLittleReceived.selector);
        r.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            100 ether, // absurd minOut
            type(uint256).max,
            block.timestamp,
            address(this)
        );
    }

    function test_trustedRouter_deadlineReverts() public {
        TegridyV4SwapRouter r = new TegridyV4SwapRouter(manager);
        _approveRouter(r);
        vm.expectRevert(TegridyV4SwapRouter.DeadlinePassed.selector);
        r.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            0,
            type(uint256).max,
            block.timestamp - 1, // expired
            address(this)
        );
    }

    /// @dev End-to-end: with the discount configured and this router wired as the
    ///      trustedRouter, a premium user's swap routes through and delivers output
    ///      (the discount path runs without breaking; discount math is unit-tested
    ///      separately via quoteFee).
    function test_trustedRouter_discountPathEndToEnd() public {
        TegridyV4SwapRouter r = new TegridyV4SwapRouter(manager);
        MockPremiumAccess pa = new MockPremiumAccess();
        pa.setPremium(address(this), true);
        hook.setDiscountConfig(address(pa), address(r), 5000); // router = trusted, 50% off
        _approveRouter(r);

        uint256 before = currency1.balanceOf(address(this));
        r.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            0,
            type(uint256).max,
            block.timestamp,
            address(this)
        );
        assertGt(currency1.balanceOf(address(this)), before, "premium swap via trusted router succeeds end-to-end");
    }

    // M-1: an exact-OUTPUT swap fixes the output leg, so `minOut` is trivially met;
    //      the variable INPUT leg must be bounded by `maxIn` or a sandwicher makes
    //      the victim overpay. A tiny maxIn must revert TooMuchSpent.
    function test_trustedRouter_exactOutputMaxInReverts() public {
        TegridyV4SwapRouter r = new TegridyV4SwapRouter(manager);
        _approveRouter(r);
        vm.expectRevert(TegridyV4SwapRouter.TooMuchSpent.selector);
        r.swap(
            poolKey,
            // positive amountSpecified ⇒ exact-output: receive 0.5 currency1 …
            SwapParams({zeroForOne: true, amountSpecified: 0.5 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            0,
            1, // … but refuse to spend more than 1 wei of currency0 input
            block.timestamp,
            address(this)
        );
    }

    // ─── #3 NFT-staker (Part B — canonical boosted-LP) ────────────────

    function _setupStaker()
        internal
        returns (MockStaking ms, MockERC20 rt, MockPositionManager pm, TegridyBoostedLPStaker s)
    {
        ms = new MockStaking();
        rt = new MockERC20("Reward", "RWD", 18);
        pm = new MockPositionManager();
        s = new TegridyBoostedLPStaker(
            IERC20(address(rt)), address(ms), address(pm), PoolId.unwrap(poolKey.toId()), address(this)
        );
    }

    function _mintFullRange(MockPositionManager pm, address to, uint256 id, uint128 liq) internal {
        pm.mint(to, id, liq, poolKey, TickMath.minUsableTick(60), TickMath.maxUsableTick(60));
    }

    function test_boostedStaker_depositEarnsBoostedAndWithdraws() public {
        (MockStaking ms, MockERC20 rt, MockPositionManager pm, TegridyBoostedLPStaker s) = _setupStaker();
        ms.setBoost(address(this), 20000); // 2x
        _mintFullRange(pm, address(this), 1, 100);
        s.deposit(1);
        assertEq(s.liquidityOf(address(this)), 100, "raw liquidity escrowed");
        assertEq(s.effectiveBalanceOf(address(this)), 200, "2x boost applied");
        assertEq(pm.ownerOf(1), address(s), "NFT held by staker");

        rt.mint(address(this), 1000 ether);
        rt.approve(address(s), type(uint256).max);
        s.notifyRewardAmount(700 ether, 7 days);
        vm.warp(block.timestamp + 7 days);
        assertGt(s.earned(address(this)), 0, "rewards accrue");
        s.getReward();

        s.withdraw(1);
        assertEq(pm.ownerOf(1), address(this), "NFT returned on withdraw");
        assertEq(s.liquidityOf(address(this)), 0, "balance cleared");
    }

    function test_boostedStaker_onlyDepositorWithdraws() public {
        (,, MockPositionManager pm, TegridyBoostedLPStaker s) = _setupStaker();
        _mintFullRange(pm, address(this), 7, 50);
        s.deposit(7);
        vm.prank(makeAddr("thief"));
        vm.expectRevert(TegridyBoostedLPStaker.NotDepositor.selector);
        s.withdraw(7);
    }

    // Notify-cooldown parity with V2 TegridyLPFarming (F-93-2): the first notify lands,
    // an immediate second is gated, and after NOTIFY_COOLDOWN it lands again.
    function test_boostedStaker_notifyCooldownReverts() public {
        (, MockERC20 rt,, TegridyBoostedLPStaker s) = _setupStaker();
        rt.mint(address(this), 1000 ether);
        rt.approve(address(s), type(uint256).max);
        s.notifyRewardAmount(100 ether, 7 days); // first call: cooldown skipped
        vm.expectRevert(TegridyBoostedLPStaker.NotifyCooldownActive.selector);
        s.notifyRewardAmount(100 ether, 7 days); // immediate re-notify: gated
        vm.warp(block.timestamp + 24 hours + 1);
        s.notifyRewardAmount(100 ether, 7 days); // after cooldown: lands again
        assertEq(s.lastNotifyTime(), block.timestamp, "lastNotifyTime stamped");
    }

    // C-1: a position from any OTHER pool (e.g. a worthless pair an attacker
    //      controls, with huge `liquidity` units) must be rejected → no free farming.
    function test_C1_boostedStaker_rejectsForeignPool() public {
        (,, MockPositionManager pm, TegridyBoostedLPStaker s) = _setupStaker();
        PoolKey memory rogue = PoolKey(currency0, currency1, uint24(3000), int24(60), IHooks(address(hook)));
        pm.mint(address(this), 9, 1e30, rogue, TickMath.minUsableTick(60), TickMath.maxUsableTick(60));
        vm.expectRevert(TegridyBoostedLPStaker.WrongPool.selector);
        s.deposit(9);
    }

    // C-1: even in the right pool, a tight out-of-range band (high liquidity units,
    //      ~0 capital) must be rejected.
    function test_C1_boostedStaker_rejectsNonFullRange() public {
        (,, MockPositionManager pm, TegridyBoostedLPStaker s) = _setupStaker();
        pm.mint(address(this), 11, 1e30, poolKey, int24(-120), int24(120));
        vm.expectRevert(TegridyBoostedLPStaker.NotFullRange.selector);
        s.deposit(11);
    }

    /// @dev [LOW-1 2026-05-31] a raw safeTransferFrom (bypassing deposit()) must REVERT
    ///      rather than silently orphan the NFT with no depositor and no recovery path.
    function test_LOW1_boostedStaker_rejectsDirectNFTTransfer() public {
        (,,, TegridyBoostedLPStaker s) = _setupStaker();
        vm.expectRevert(TegridyBoostedLPStaker.DirectNFTTransferNotAllowed.selector);
        s.onERC721Received(address(0), address(this), 1, "");
    }

}

/// @dev Minimal V4 PositionManager stand-in (ERC721 ownership + liquidity + pool/tick info).
contract MockPositionManager {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => uint128) internal _liq;
    mapping(uint256 => PoolKey) internal _key;
    mapping(uint256 => int24) internal _tickLower;
    mapping(uint256 => int24) internal _tickUpper;

    function mint(address to, uint256 id, uint128 liquidity, PoolKey memory key, int24 tickLower, int24 tickUpper)
        external
    {
        ownerOf[id] = to;
        _liq[id] = liquidity;
        _key[id] = key;
        _tickLower[id] = tickLower;
        _tickUpper[id] = tickUpper;
    }

    function getPositionLiquidity(uint256 id) external view returns (uint128) {
        return _liq[id];
    }

    function getPoolAndPositionInfo(uint256 id) external view returns (PoolKey memory, PositionInfo) {
        return (_key[id], PositionInfoLibrary.initialize(_key[id], _tickLower[id], _tickUpper[id]));
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(ownerOf[id] == from, "not owner");
        ownerOf[id] = to;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
    }
}

/// @dev Minimal staking-boost stand-in.
contract MockStaking {
    mapping(address => uint256) public boost;

    function setBoost(address u, uint256 bps) external {
        boost[u] = bps;
    }

    function aggregateActiveBoostBps(address u) external view returns (uint256) {
        return boost[u];
    }
}

/// @dev Minimal PremiumAccess stand-in for the discount tests.
contract MockPremiumAccess {
    mapping(address => bool) public premium;

    function setPremium(address u, bool v) external {
        premium[u] = v;
    }

    function hasPremium(address u) external view returns (bool) {
        return premium[u];
    }
}
