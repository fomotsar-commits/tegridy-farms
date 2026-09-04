// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {DecayingFeeHook} from "../../src/v4/DecayingFeeHook.sol";
import {OwnableNoRenounce} from "../../src/base/OwnableNoRenounce.sol";

/// @notice Behavioural tests for the anti-snipe decay schedule: the boundary values of the
///         decay itself, the adversarial cases around configuration and griefing, the
///         economic claim (block zero is not worth more than block N), and the honesty
///         guards on the read surface a trade UI would render.
contract DecayingFeeHookTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    DecayingFeeHook internal hook;
    PoolKey internal poolKey;

    address internal stranger = makeAddr("stranger");

    uint24 internal constant START_FEE = 990_000; // 99%
    uint24 internal constant BASELINE_FEE = 3_000; // 0.30%
    uint32 internal constant DECAY = 90 minutes;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        hook = _mineAndDeployHook(address(this));
        poolKey = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, int24(60), IHooks(address(hook)));

        hook.configurePool(poolKey, START_FEE, BASELINE_FEE, DECAY);
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            poolKey, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100 ether, salt: 0}), ""
        );
    }

    function _mineAndDeployHook(address initialOwner) internal returns (DecayingFeeHook h) {
        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        bytes memory ctorArgs = abi.encode(manager, initialOwner);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), flags, type(DecayingFeeHook).creationCode, ctorArgs);
        h = new DecayingFeeHook{salt: salt}(manager, initialOwner);
        require(address(h) == hookAddr, "hook addr mismatch");
    }

    function _swapTiny() internal returns (uint256 amountOut) {
        BalanceDelta delta = swapRouter.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -1e14, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        return uint256(uint128(delta.amount1()));
    }

    function _quoted() internal view returns (uint24) {
        (,, uint24 quotedFeePips,,,,,,) = hook.decaySchedule(poolKey);
        return quotedFeePips;
    }

    function _startedAt() internal view returns (uint64) {
        (,,,,,, uint64 startedAt,,) = hook.decaySchedule(poolKey);
        return startedAt;
    }

    // ─── Inert until configured ───────────────────────────────────────

    function test_PoolCannotBeInitializedWithoutAPublishedSchedule() public {
        // A second instance, mined against a different owner so it lands at a different
        // address than the one `setUp` already configured.
        DecayingFeeHook fresh = _mineAndDeployHook(stranger);
        PoolKey memory unconfigured =
            PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, int24(60), IHooks(address(fresh)));
        vm.expectRevert();
        manager.initialize(unconfigured, SQRT_PRICE_1_1);
    }

    // ─── AUDIT TF-016: only the launch may open the pool ──────────────
    //
    // `PoolManager.initialize` is permissionless and the configured key is
    // public — it is `configurePool`'s own calldata, and `ScheduleConfigured`
    // announces the poolId. So between configure and launch a stranger could
    // call `initialize` first. `_afterInitialize` took `sender` and ignored it,
    // which handed that stranger BOTH the decay clock and the opening price.
    //
    // These pin the economic outcome, not the revert selector: the anti-snipe
    // window must still be in front of the first real buyer.

    /// @dev A configured-but-uninitialized pool at a hook `owner` controls.
    ///      Mined against `owner` so it lands at a different address than the
    ///      hook `setUp` already initialized.
    function _freshConfiguredPool(address owner_)
        internal
        returns (DecayingFeeHook h, PoolKey memory k)
    {
        h = _mineAndDeployHook(owner_);
        k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, int24(60), IHooks(address(h)));
        vm.prank(owner_);
        h.configurePool(k, START_FEE, BASELINE_FEE, DECAY);
    }

    function test_AStrangerCannotStartTheDecayClock() public {
        (DecayingFeeHook h, PoolKey memory k) = _freshConfiguredPool(stranger);

        vm.prank(address(this)); // anyone who is not the owner
        vm.expectRevert();
        manager.initialize(k, SQRT_PRICE_1_1);

        // The clock must not have started. This is the load-bearing assertion:
        // a revert that still stamped startedAt would be no defence at all.
        (,,,,,, uint64 startedAt,,) = h.decaySchedule(k);
        assertEq(startedAt, 0, "a rejected initialize must not start the schedule");
    }

    function test_TheOwnerCanStillOpenItsOwnPool() public {
        // Non-vacuity: the gate must not have bricked the launch it protects.
        (DecayingFeeHook h, PoolKey memory k) = _freshConfiguredPool(stranger);
        vm.prank(stranger);
        manager.initialize(k, SQRT_PRICE_1_1);
        (,,,,,, uint64 startedAt,,) = h.decaySchedule(k);
        assertEq(startedAt, uint64(block.timestamp), "the owner's initialize must start the clock");
    }

    function test_AntiSnipeSurvivesAStrangerFrontRunningTheLaunch() public {
        (DecayingFeeHook h, PoolKey memory k) = _freshConfiguredPool(stranger);

        // The sniper front-runs the launch and tries to burn the decay window.
        vm.prank(address(this));
        try manager.initialize(k, SQRT_PRICE_1_1) {} catch {}

        // Time passes — the whole decay window, in fact. Pre-fix, the clock was
        // already running, so by now the fee would have reached BASELINE and the
        // sniper would buy the launch at 0.30% instead of 99%.
        skip(DECAY + 1);

        // The real launch opens the pool.
        vm.prank(stranger);
        manager.initialize(k, SQRT_PRICE_1_1);

        (,, uint24 quotedFeePips,,,,,,) = h.decaySchedule(k);
        assertEq(quotedFeePips, START_FEE, "the first buyer must still meet the full anti-snipe fee");
    }

    // ─── Configuration ────────────────────────────────────────────────

    function test_ConfigureRejectsStaticFeeKey() public {
        PoolKey memory staticKey = PoolKey(currency0, currency1, uint24(3000), int24(60), IHooks(address(hook)));
        vm.expectRevert(DecayingFeeHook.NotDynamicFeeKey.selector);
        hook.configurePool(staticKey, START_FEE, BASELINE_FEE, DECAY);
    }

    function test_ConfigureRejectsOutOfBoundsParameters() public {
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, int24(120), IHooks(address(hook)));

        vm.expectRevert(abi.encodeWithSelector(DecayingFeeHook.StartFeeTooHigh.selector, uint24(990_001)));
        hook.configurePool(k, 990_001, BASELINE_FEE, DECAY);

        vm.expectRevert(abi.encodeWithSelector(DecayingFeeHook.BaselineFeeTooHigh.selector, uint24(30_001)));
        hook.configurePool(k, START_FEE, 30_001, DECAY);

        vm.expectRevert(abi.encodeWithSelector(DecayingFeeHook.StartFeeBelowBaseline.selector, uint24(1_000), uint24(3_000)));
        hook.configurePool(k, 1_000, 3_000, DECAY);

        vm.expectRevert(abi.encodeWithSelector(DecayingFeeHook.DecayOutOfRange.selector, uint32(1 minutes)));
        hook.configurePool(k, START_FEE, BASELINE_FEE, 1 minutes);

        vm.expectRevert(abi.encodeWithSelector(DecayingFeeHook.DecayOutOfRange.selector, uint32(48 hours)));
        hook.configurePool(k, START_FEE, BASELINE_FEE, 48 hours);
    }

    function test_ConfigureIsOwnerOnly() public {
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, int24(120), IHooks(address(hook)));
        vm.prank(stranger);
        vm.expectRevert();
        hook.configurePool(k, START_FEE, BASELINE_FEE, DECAY);
    }

    function test_ScheduleIsWriteOnceAndImmutableOnceLive() public {
        vm.expectRevert(abi.encodeWithSelector(DecayingFeeHook.PoolAlreadyConfigured.selector, poolKey.toId()));
        hook.configurePool(poolKey, 500_000, 0, 10 minutes);

        // And there is no other path: the owner has no setter that reaches a live schedule.
        (, , , uint24 startFeePips, uint24 baselineFeePips, uint32 decaySeconds, , ,) = hook.decaySchedule(poolKey);
        assertEq(startFeePips, START_FEE);
        assertEq(baselineFeePips, BASELINE_FEE);
        assertEq(decaySeconds, DECAY);
    }

    function test_OwnerCannotRenounce() public {
        vm.expectRevert(OwnableNoRenounce.RenounceDisabled.selector);
        hook.renounceOwnership();
    }

    // ─── Decay boundaries ─────────────────────────────────────────────

    function test_DecayBoundaryValues() public {
        uint64 startedAt = _startedAt();
        assertEq(startedAt, uint64(block.timestamp));

        assertEq(_quoted(), START_FEE, "opening block pays exactly the start fee");

        vm.warp(startedAt + DECAY / 2);
        assertEq(_quoted(), START_FEE - (START_FEE - BASELINE_FEE) / 2, "midpoint is the exact midpoint");

        vm.warp(startedAt + DECAY - 1);
        uint24 lastTick = _quoted();
        assertGt(lastTick, BASELINE_FEE, "still above baseline one second before the end");

        vm.warp(startedAt + DECAY);
        assertEq(_quoted(), BASELINE_FEE, "baseline lands exactly at the published end");

        vm.warp(startedAt + DECAY + 365 days);
        assertEq(_quoted(), BASELINE_FEE, "and never moves again");
    }

    function test_DecayIsMonotonicNonIncreasing() public {
        uint64 startedAt = _startedAt();
        uint24 previous = type(uint24).max;
        for (uint256 i = 0; i <= 100; ++i) {
            vm.warp(startedAt + (uint256(DECAY) * i) / 100);
            uint24 fee = _quoted();
            assertLe(fee, previous, "fee must never rise");
            previous = fee;
        }
        assertEq(previous, BASELINE_FEE);
    }

    function testFuzz_DecayStaysWithinPublishedBounds(uint32 offset) public {
        offset = uint32(bound(offset, 0, 10 days));
        vm.warp(_startedAt() + offset);
        uint24 fee = _quoted();
        assertLe(fee, START_FEE);
        assertGe(fee, BASELINE_FEE);
    }

    // ─── The economic claim ───────────────────────────────────────────

    function test_BlockZeroSnipeIsUnprofitableRelativeToWaiting() public {
        uint64 startedAt = _startedAt();
        uint256 outAtBlockZero = _swapTiny();

        vm.warp(startedAt + DECAY);
        uint256 outAfterDecay = _swapTiny();

        // 99% vs 0.30% on the same input: waiting is worth roughly 100x. Anything close to
        // parity would mean the schedule is not actually being charged.
        assertGt(outAfterDecay, outAtBlockZero * 50, "sniping block zero must be strictly worse");
    }

    function test_NoCallerIsExemptFromTheDecay() public {
        uint256 outHere = _swapTiny();

        // Same block, a different caller with its own approvals: identical treatment.
        deal(Currency.unwrap(currency0), stranger, 1 ether);
        vm.startPrank(stranger);
        IApprovable(Currency.unwrap(currency0)).approve(address(swapRouter), type(uint256).max);
        IApprovable(Currency.unwrap(currency1)).approve(address(swapRouter), type(uint256).max);
        uint256 outStranger = _swapTiny();
        vm.stopPrank();

        // Tiny swaps against 100 ether of liquidity: the only difference is price drift.
        assertApproxEqRel(outStranger, outHere, 1e15, "the hook has no per-caller path");
    }

    // ─── Honesty gating on the read surface ───────────────────────────

    function test_Honesty_UnconfiguredKeyReportsNoScheduleNotAZeroFee() public {
        PoolKey memory unknown =
            PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, int24(200), IHooks(address(hook)));
        (
            bool configured,
            bool live,
            uint24 quotedFeePips,
            uint24 startFeePips,
            uint24 baselineFeePips,
            uint32 decaySeconds,
            uint64 startedAt,
            uint64 endsAt,
            bool decaying
        ) = hook.decaySchedule(unknown);

        assertFalse(configured, "no schedule was ever published for this key");
        assertFalse(live);
        assertFalse(decaying);
        assertEq(quotedFeePips, 0);
        assertEq(startFeePips, 0);
        assertEq(baselineFeePips, 0);
        assertEq(decaySeconds, 0);
        assertEq(startedAt, 0);
        assertEq(endsAt, 0);
    }

    function test_Honesty_ConfiguredButUninitialisedPoolQuotesNoFee() public {
        PoolKey memory pending =
            PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, int24(120), IHooks(address(hook)));
        hook.configurePool(pending, START_FEE, BASELINE_FEE, DECAY);

        (bool configured, bool live, uint24 quotedFeePips, uint24 startFeePips,,, uint64 startedAt, uint64 endsAt, bool decaying)
        = hook.decaySchedule(pending);

        assertTrue(configured, "terms are public before the pool exists");
        assertFalse(live, "but no fee has been quoted, because no pool exists");
        assertEq(quotedFeePips, 0, "zero here means unquoted; `live` is what says so");
        assertEq(startFeePips, START_FEE, "the honest number to show pre-launch is where it opens");
        assertEq(startedAt, 0);
        assertEq(endsAt, 0);
        assertFalse(decaying);
    }

    function test_Honesty_QuotedFeeIsWhatTheSwapActuallyPaysNotTheBaseline() public {
        uint64 startedAt = _startedAt();
        vm.warp(startedAt + DECAY / 2);

        (,, uint24 quotedFeePips,, uint24 baselineFeePips,,,, bool decaying) = hook.decaySchedule(poolKey);
        assertTrue(decaying);
        assertGt(quotedFeePips, baselineFeePips, "rendering the baseline mid-decay understates the cost");

        uint256 outMid = _swapTiny();

        vm.warp(startedAt + DECAY);
        (,, uint24 endFee,,,,,, bool stillDecaying) = hook.decaySchedule(poolKey);
        assertFalse(stillDecaying);
        assertEq(endFee, baselineFeePips);
        uint256 outBaseline = _swapTiny();

        // The mid-decay quote is ~49.65%, so the same input must return roughly half of
        // what it returns at the 0.30% baseline. A pool secretly charging baseline would
        // land near parity; a UI showing baseline would have been lying by ~2x.
        assertGt(outMid * 100, outBaseline * 45);
        assertLt(outMid * 100, outBaseline * 55);
    }

    function test_Honesty_ReferenceSpanIsPublished() public {
        assertEq(hook.REFERENCE_DECAY_SECONDS(), 90 minutes);
        assertEq(hook.MAX_START_FEE_PIPS(), 990_000);
    }
}

interface IApprovable {
    function approve(address spender, uint256 amount) external returns (bool);
}
