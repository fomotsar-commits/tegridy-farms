// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TegridyV4Hook} from "../../src/v4/TegridyV4Hook.sol";
import {TegridyV4HookAdmin} from "../../src/v4/TegridyV4HookAdmin.sol";
import {TegridyBoostedLP} from "../../src/v4/TegridyBoostedLP.sol";
import {TegridyV4SwapRouter} from "../../src/v4/TegridyV4SwapRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "solmate/test/utils/mocks/MockERC20.sol";

/// @notice Behavioral tests for the custom surface of TegridyV4Hook (allowlist,
///         fee override wiring, admin gating, POL skim accrual + sweep/redeem
///         conservation) and the TegridyV4HookAdmin timelock. The verbatim JIT
///         logic is covered by OZ's own suite.
contract TegridyV4HookTest is Test, Deployers {
    using CurrencyLibrary for Currency;

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

        address pa = makeAddr("premiumAccess");
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

    // ─── #3 Boosted-LP reward module ──────────────────────────────────

    function _deployBoostedLP(address hook_, MockStaking ms) internal returns (TegridyBoostedLP m, MockERC20 rt) {
        rt = new MockERC20("Reward", "RWD", 18);
        m = new TegridyBoostedLP(hook_, IERC20(address(rt)), address(ms), address(this));
    }

    function test_boostedLP_onlyHookCanReport() public {
        MockStaking ms = new MockStaking();
        (TegridyBoostedLP m,) = _deployBoostedLP(address(this), ms); // this == "hook" for unit test
        vm.prank(makeAddr("notHook"));
        vm.expectRevert(TegridyBoostedLP.NotHook.selector);
        m.onLiquidityChange(makeAddr("lp"), int256(1 ether));
    }

    function test_boostedLP_accruesBoostedAndPays() public {
        MockStaking ms = new MockStaking();
        (TegridyBoostedLP m, MockERC20 rt) = _deployBoostedLP(address(this), ms);
        address lp = makeAddr("lp");
        ms.setBoost(lp, 20000); // 2x

        m.onLiquidityChange(lp, int256(100 ether)); // test acts as the hook
        assertEq(m.liquidityOf(lp), 100 ether, "raw liquidity tracked");
        assertEq(m.effectiveBalanceOf(lp), 200 ether, "2x boost applied");

        rt.mint(address(this), 1000 ether);
        rt.approve(address(m), type(uint256).max);
        m.notifyRewardAmount(700 ether, 7 days);
        vm.warp(block.timestamp + 7 days);

        uint256 earned = m.earned(lp);
        assertGt(earned, 0, "rewards accrue over time");
        vm.prank(lp);
        m.getReward();
        assertApproxEqAbs(rt.balanceOf(lp), earned, 1e12, "reward paid out");
    }

    function test_boostedLP_boostIsProportional() public {
        MockStaking ms = new MockStaking();
        (TegridyBoostedLP m, MockERC20 rt) = _deployBoostedLP(address(this), ms);
        address lp1 = makeAddr("lp1"); // 1x (no stake)
        address lp2 = makeAddr("lp2"); // 2x
        ms.setBoost(lp2, 20000);

        m.onLiquidityChange(lp1, int256(100 ether));
        m.onLiquidityChange(lp2, int256(100 ether));
        rt.mint(address(this), 1000 ether);
        rt.approve(address(m), type(uint256).max);
        m.notifyRewardAmount(900 ether, 7 days);
        vm.warp(block.timestamp + 7 days);

        // same raw liquidity, lp2 boosted 2x => ~2x the rewards
        assertApproxEqRel(m.earned(lp2), m.earned(lp1) * 2, 0.01e18, "2x boost => ~2x rewards");
    }

    function test_boostedLP_hookReportsRealLiquidity() public {
        MockStaking ms = new MockStaking();
        TegridyBoostedLP m = new TegridyBoostedLP(address(hook), IERC20(address(new MockERC20("R", "R", 18))), address(ms), address(this));
        hook.setBoostedLP(address(m)); // paramAdmin == this

        // a real add-liquidity op flows through the hook's afterAddLiquidity → module
        modifyLiquidityRouter.modifyLiquidity(
            poolKey, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 50 ether, salt: 0}), ""
        );
        // sender (the LP from the module's view) is the modifyLiquidity router
        assertEq(m.liquidityOf(address(modifyLiquidityRouter)), 50 ether, "hook reported real V4 liquidity");
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
            block.timestamp,
            address(this)
        );
        assertGt(currency1.balanceOf(address(this)), before, "premium swap via trusted router succeeds end-to-end");
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
