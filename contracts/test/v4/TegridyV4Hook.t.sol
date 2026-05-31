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

/// @notice Behavioral tests for the custom surface of TegridyV4Hook (allowlist,
///         fee override wiring, admin gating, POL skim accrual + sweep
///         conservation). The verbatim JIT logic is covered by OZ's own suite.
contract TegridyV4HookTest is Test, Deployers {
    using CurrencyLibrary for Currency;

    TegridyV4Hook internal hook;
    PoolKey internal poolKey;
    address internal treasury = makeAddr("treasury");
    address internal stranger = makeAddr("stranger");

    uint24 internal constant MIN_FEE = 500; // 0.05%
    uint24 internal constant MAX_FEE = 30_000; // 3%
    uint24 internal constant BASE_FEE = 3_000; // 0.30%
    uint16 internal constant MAX_POL_BPS = 1_000; // 10%
    uint16 internal constant POL_BPS = 100; // 1%
    uint48 internal constant BLOCK_OFFSET = 10;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        // Mine an address whose low bits match the hook's permission set.
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
                | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
        );
        bytes memory ctorArgs = abi.encode(
            manager, BLOCK_OFFSET, address(this), MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, treasury
        );
        (address hookAddr, bytes32 salt) = HookMiner.find(address(this), flags, type(TegridyV4Hook).creationCode, ctorArgs);
        hook = new TegridyV4Hook{salt: salt}(
            manager, BLOCK_OFFSET, address(this), MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, treasury
        );
        require(address(hook) == hookAddr, "hook addr mismatch");

        // Allowlist the intended dynamic-fee pool key (tickSpacing 60 = Deployers' dynamic default).
        poolKey = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, int24(60), IHooks(address(hook)));
        hook.setPoolAllowed(poolKey, true);

        manager.initialize(poolKey, SQRT_PRICE_1_1);

        // Seed liquidity across a wide range (ticks multiples of 60).
        modifyLiquidityRouter.modifyLiquidity(
            poolKey, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100 ether, salt: 0}), ""
        );
    }

    // ─── Allowlist (Cork defense) ─────────────────────────────────────

    function test_allowlist_blocksUnregisteredPool() public {
        // Same currencies, different fee/tickSpacing => different PoolId, never allowlisted.
        PoolKey memory rogue = PoolKey(currency0, currency1, uint24(3000), int24(60), IHooks(address(hook)));
        vm.expectRevert(); // wraps TegridyV4Hook.PoolNotAllowed via PoolManager
        manager.initialize(rogue, SQRT_PRICE_1_1);
    }

    function test_revert_staticFeePoolEvenIfAllowlisted() public {
        // Allowlist a static-fee key: beforeInitialize passes, afterInitialize must reject (NotDynamicFee).
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
        hook.setBaseFee(MIN_FEE); // within bounds: ok
        assertEq(hook.baseFeePips(), MIN_FEE);
    }

    function test_setPolSkim_respectsCeiling() public {
        vm.expectRevert(TegridyV4Hook.SkimOutOfBounds.selector);
        hook.setPolSkimBps(MAX_POL_BPS + 1);
        hook.setPolSkimBps(MAX_POL_BPS); // at ceiling: ok
        assertEq(hook.polSkimBps(), MAX_POL_BPS);
    }

    // ─── POL skim: accrual + sweep conservation (the high-risk path) ──

    function test_pol_accruesOnSwapAndSweepsWithoutLeak() public {
        uint256 id1 = currency1.toId();
        assertEq(manager.balanceOf(address(hook), id1), 0, "hook starts with no claims");

        // zeroForOne exact-input swap => unspecified (output) currency is currency1.
        swapRouter.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 accrued = manager.balanceOf(address(hook), id1);
        assertGt(accrued, 0, "POL skim accrued claims to the hook");

        // Sweep: all hook claims move to the treasury, hook left with zero (no stuck balance).
        uint256 treasuryBefore = manager.balanceOf(treasury, id1);
        hook.sweepPOL(currency1);
        assertEq(manager.balanceOf(address(hook), id1), 0, "hook swept to zero");
        assertEq(manager.balanceOf(treasury, id1), treasuryBefore + accrued, "treasury received exactly the accrued claims");
    }

    function test_pol_zeroSkimAccruesNothing() public {
        hook.setPolSkimBps(0);
        swapRouter.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertEq(manager.balanceOf(address(hook), currency1.toId()), 0, "no skim when polSkimBps == 0");
    }
}
