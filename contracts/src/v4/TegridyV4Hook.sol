// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// External imports (Uniswap V4 core)
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
// Battle-tested verbatim base (OpenZeppelin/uniswap-hooks v1.1.1, pinned)
import {LiquidityPenaltyHook} from "@openzeppelin/uniswap-hooks/src/general/LiquidityPenaltyHook.sol";

/// @title  TegridyV4Hook — bundled Uniswap V4 hook for the TOWELI pool
/// @notice **BATCH 1 of the V4 implementation** (gate overridden 2026-05-30).
///
///         ARCHITECTURE CORRECTION (discovered at compile-time, 2026-05-30):
///         the original plan to bundle several OZ hooks by multiple inheritance
///         is IMPOSSIBLE. Every OZ hook derives from `BaseHook`, whose constructor
///         takes the PoolManager — so inheriting two of them yields Solidity error
///         3364 "Base constructor arguments given twice", plus shared-callback
///         ambiguity (error 6480) on `_beforeSwap`/`_afterInitialize`. The OZ
///         library is built for ONE hook per pool, not bundling.
///
///         Minimal-surface resolution: inherit the ONE heavy hook verbatim
///         (`LiquidityPenaltyHook`, which carries the real JIT fee-withholding
///         accounting we must not reimplement) and hand-write only the TRIVIAL
///         fee-override — 6 lines copied verbatim from OZ `BaseOverrideFee`.
///         Net custom surface added vs. pure verbatim: the two overrides below.
///
/// @dev    NOT YET DEPLOYABLE. Deferred to later batches:
///           - Batch 2: pool-key allowlist in `_beforeInitialize` (Cork defense)
///           - Batch 2: volatility-aware fee (this batch returns a flat base fee)
///           - Batch 3: custom POL skim/mint in `_afterSwap` + oracle module
///           - Batch 4: TegridyV4HookAdmin timelock wiring + PauseGuardian
///           - Batch 5: HookMiner CREATE2 mining + DeployV4/VerifyV4
///         BaseHook validates the hook-address permission bits AT CONSTRUCTION,
///         so this only deploys from a HookMiner-mined CREATE2 address.
///
/// @dev    AntiSandwichHook is intentionally NOT here: it also drives `_beforeSwap`
///         + its own fee machinery (via BaseDynamicAfterFee) and collides with the
///         fee override. If adopted it runs on a SEPARATE pool. See V4_MIGRATION_PLAN.md.
contract TegridyV4Hook is LiquidityPenaltyHook {
    using LPFeeLibrary for uint24;

    /// @dev The pool was initialized without the dynamic-fee flag.
    error NotDynamicFee();

    /// @notice Flat base LP fee in hundredths of a bip (e.g. 3000 = 0.30%).
    ///         Batch 1 placeholder for the volatility-aware curve (Batch 2).
    uint24 private immutable _baseFeePips;

    /// @param poolManager_       canonical V4 PoolManager singleton
    /// @param blockNumberOffset_ JIT window for LiquidityPenaltyHook (larger for
    ///                           low-liquidity / long-tail pools)
    /// @param baseFeePips_       flat base fee (hundredths of a bip)
    constructor(IPoolManager poolManager_, uint48 blockNumberOffset_, uint24 baseFeePips_)
        LiquidityPenaltyHook(poolManager_, blockNumberOffset_)
    {
        _baseFeePips = baseFeePips_;
    }

    /// @dev Fee-override module — verbatim copy of OZ `BaseOverrideFee` behavior.
    ///      Require the pool to be a dynamic-fee pool so the override flag is honored.
    function _afterInitialize(address, PoolKey calldata key, uint160, int24)
        internal
        virtual
        override
        returns (bytes4)
    {
        if (!key.fee.isDynamicFee()) revert NotDynamicFee();
        return this.afterInitialize.selector;
    }

    /// @dev Fee-override module — return the LP fee with the OVERRIDE flag set.
    ///      Batch 1 = flat base fee. Batch 2 swaps the body for a volatility curve
    ///      read from the oracle module; this signature stays identical.
    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        virtual
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, _baseFeePips | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev Merge permissions: LiquidityPenaltyHook's add/remove set + the
    ///      afterInitialize/beforeSwap flags the fee override needs.
    function getHookPermissions()
        public
        pure
        virtual
        override
        returns (Hooks.Permissions memory permissions)
    {
        permissions.afterInitialize = true; // fee override: dynamic-fee assertion
        permissions.beforeSwap = true; // fee override
        permissions.afterAddLiquidity = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterRemoveLiquidity = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterAddLiquidityReturnDelta = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterRemoveLiquidityReturnDelta = true; // LiquidityPenaltyHook (verbatim)
        // beforeInitialize stays false until Batch 2 adds the pool-key allowlist.
    }
}
