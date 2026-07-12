// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TegridyV4Hook} from "../../src/v4/TegridyV4Hook.sol";

/// @notice AUDIT 2026-07-12 [HIGH] regression: TegridyV4Hook must isolate its POL
///         skim pot from LiquidityPenaltyHook's *withheld JIT-fee* ERC-6909 claims,
///         which share the same `poolManager.balanceOf(hook, id)` slot.
///
///         BEFORE the fix, `distributeFees`/`sweepPOL` read the RAW balance and would
///         (1) route the LPs' withheld fees to the protocol sinks (theft) and
///         (2) then brick the LP's removal, because the base `_settleFeesFromHook`
///         burns claims that are no longer there (underflow revert → locked funds).
///
///         AFTER the fix, only the tracked `polAccrued[id]` is redeemable; the
///         withheld-fee claims survive and the LP removes cleanly.
contract Audit20260712_POLIsolationTest is Test, Deployers {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;

    TegridyV4Hook internal hook;
    PoolKey internal poolKey;
    address internal treasury = makeAddr("treasury");

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
        // First add — records lastAddedLiquidityBlock for this position at block.number.
        modifyLiquidityRouter.modifyLiquidity(
            poolKey, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100 ether, salt: 0}), ""
        );
    }

    /// @dev Mine a CREATE2 address whose low bits match the hook permissions, deploy there.
    function _mineAndDeployHook(address paramAdmin_) internal returns (TegridyV4Hook h) {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG
                | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG
                | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
        );
        bytes memory ctorArgs =
            abi.encode(manager, BLOCK_OFFSET, paramAdmin_, MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, treasury);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), flags, type(TegridyV4Hook).creationCode, ctorArgs);
        h = new TegridyV4Hook{salt: salt}(
            manager, BLOCK_OFFSET, paramAdmin_, MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, treasury
        );
        require(address(h) == hookAddr, "hook addr mismatch");
    }

    /// @dev Exact-OUTPUT zeroForOne: the unspecified (skimmed) currency is the INPUT
    ///      (currency0) — the SAME currency the LP swap fee accrues in — so the POL
    ///      skim and the withheld JIT fee collide in the currency0 claim slot.
    function _swapExactOutputZeroForOne(int256 amountOut) internal {
        swapRouter.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: amountOut, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Set up the collision: swap accrues LP fees + POL skim in currency0, then a
    ///      second add within the JIT window withholds those LP fees into the hook's
    ///      currency0 claim slot — alongside the POL skim. Returns the withheld amount.
    function _accrueWithheldPlusPOL() internal returns (uint256 id0, uint256 withheld, uint256 pol) {
        id0 = currency0.toId();

        // Swap generates LP fees (currency0) for the in-range position AND a POL skim
        // (currency0, because exact-output → unspecified = input).
        _swapExactOutputZeroForOne(0.5 ether);

        pol = hook.polAccrued(id0);
        assertGt(pol, 0, "POL skim should have accrued in currency0");

        uint256 balBeforeAdd = manager.balanceOf(address(hook), id0);

        // Second add to the SAME position, still within BLOCK_OFFSET of the first add
        // (no vm.roll) → LiquidityPenaltyHook withholds the freshly-accrued LP fees
        // into the hook's currency0 claim slot.
        modifyLiquidityRouter.modifyLiquidity(
            poolKey, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1 ether, salt: 0}), ""
        );

        uint256 balAfterAdd = manager.balanceOf(address(hook), id0);
        withheld = balAfterAdd - balBeforeAdd;
        assertGt(withheld, 0, "JIT fees should have been withheld into the hook");
        // The raw balance now mixes POL + withheld; polAccrued still tracks POL only.
        assertEq(balAfterAdd, pol + withheld, "raw balance = POL pot + withheld JIT fees");
        assertEq(hook.polAccrued(id0), pol, "polAccrued unchanged by the withholding");
    }

    // ── distributeFees must NOT drain the LPs' withheld JIT fees ──────────
    function test_distributeFees_leavesWithheldJITFeesIntact() public {
        (uint256 id0, uint256 withheld, uint256 pol) = _accrueWithheldPlusPOL();

        uint256 treasuryRealBefore = currency0.balanceOf(treasury);
        hook.distributeFees(currency0); // polRecipient/treasury == `treasury`

        // Only the POL pot was redeemed to real currency; the withheld claims remain.
        assertEq(currency0.balanceOf(treasury), treasuryRealBefore + pol, "only POL redeemed, withheld NOT stolen");
        assertEq(manager.balanceOf(address(hook), id0), withheld, "withheld JIT-fee claims survive in the hook");
        assertEq(hook.polAccrued(id0), 0, "POL pot consumed");
    }

    // ── sweepPOL must NOT drain the LPs' withheld JIT fees ────────────────
    function test_sweepPOL_leavesWithheldJITFeesIntact() public {
        (uint256 id0, uint256 withheld, uint256 pol) = _accrueWithheldPlusPOL();

        uint256 treasuryClaimsBefore = manager.balanceOf(treasury, id0);
        hook.sweepPOL(currency0);

        assertEq(manager.balanceOf(treasury, id0), treasuryClaimsBefore + pol, "only POL swept, withheld NOT stolen");
        assertEq(manager.balanceOf(address(hook), id0), withheld, "withheld JIT-fee claims survive in the hook");
        assertEq(hook.polAccrued(id0), 0, "POL pot consumed");
    }

    // ── The LP can still remove and reclaim its withheld fees after redemption ──
    //    Pre-fix, distributeFees burned the withheld claims too, so the base
    //    `_settleFeesFromHook` (settle with burn=true) underflowed and reverted here,
    //    trapping the LP's principal.
    function test_LPRemovalSucceedsAfterDistribute() public {
        _accrueWithheldPlusPOL();

        hook.distributeFees(currency0);

        // Move past the JIT window so removal itself is not penalized, then remove.
        vm.roll(block.number + BLOCK_OFFSET + 1);
        modifyLiquidityRouter.modifyLiquidity(
            poolKey, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: -50 ether, salt: 0}), ""
        );
        // Reaching here without a revert is the assertion: the withheld-fee settle
        // found its claims intact and the LP's principal was returned.
    }
}
