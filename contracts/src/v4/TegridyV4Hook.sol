// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// External imports (Uniswap V4 core)
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
// Battle-tested verbatim base (OpenZeppelin/uniswap-hooks v1.1.1, pinned)
import {LiquidityPenaltyHook} from "@openzeppelin/uniswap-hooks/src/general/LiquidityPenaltyHook.sol";

/// @title  TegridyV4Hook — bundled Uniswap V4 hook for the TOWELI pool
/// @notice **BATCHES 1-2 of the V4 implementation** (gate overridden 2026-05-30).
///
///         ARCHITECTURE (see V4_MIGRATION_PLAN.md "Architecture correction"):
///         OZ hooks cannot be bundled by multiple inheritance — every one derives
///         from `BaseHook(poolManager)`, so two of them collide (Solc 3364 + 6480).
///         Resolution: inherit the ONE heavy hook verbatim (`LiquidityPenaltyHook`,
///         the JIT fee-withholding accounting) and hand-write the lightweight
///         concerns as overrides in this contract.
///
///         Modules present:
///           • JIT          — OZ `LiquidityPenaltyHook` (VERBATIM, inherited)
///           • FeeModule    — 6-line verbatim copy of OZ `BaseOverrideFee`
///                            (Batch 1) + admin-configurable bounded fee (Batch 2)
///           • Allowlist    — pool-key allowlist in `_beforeInitialize` (Batch 2,
///                            Cork defense: only pre-registered pool keys may use
///                            this hook)
///
/// @dev    NOT YET DEPLOYABLE. Deferred to later batches:
///           - Batch 3: volatility-aware fee + custom POL `_afterSwap` + oracle
///                      (the volatility curve needs the oracle's price history;
///                       `_getFee` is the seam it plugs into)
///           - Batch 4: TegridyV4HookAdmin timelock becomes `paramAdmin`
///           - Batch 5: HookMiner CREATE2 mining + DeployV4/VerifyV4 + tests
///         BaseHook validates the hook-address permission bits AT CONSTRUCTION,
///         so this only deploys from a HookMiner-mined CREATE2 address.
///
/// @dev    AntiSandwichHook / LimitOrderHook cannot share this pool (both drive
///         `_beforeSwap`/fee). If adopted, each runs on its OWN pool.
contract TegridyV4Hook is LiquidityPenaltyHook {
    using LPFeeLibrary for uint24;
    using PoolIdLibrary for PoolKey;

    // ─── Errors ───────────────────────────────────────────────────────
    /// @dev The pool was initialized without the dynamic-fee flag.
    error NotDynamicFee();
    /// @dev The pool key is not on the allowlist (Cork defense).
    error PoolNotAllowed();
    /// @dev Caller is not the parameter admin.
    error NotParamAdmin();
    /// @dev Fee outside the immutable [min,max] bounds.
    error FeeOutOfBounds();
    /// @dev Constructor bounds are inconsistent.
    error InvalidFeeBounds();

    // ─── Events ───────────────────────────────────────────────────────
    event PoolAllowed(PoolId indexed id, bool allowed);
    event BaseFeeSet(uint24 oldFeePips, uint24 newFeePips);

    // ─── Params (mutated only by paramAdmin; hook code itself is immutable) ──
    /// @notice Address allowed to change parameters. In Batch 4 this becomes the
    ///         TegridyV4HookAdmin timelock contract. Set once at construction.
    address public immutable paramAdmin;

    /// @notice Hard fee bounds (hundredths of a bip). Immutable — even a
    ///         compromised paramAdmin cannot push the fee outside these.
    uint24 public immutable minFeePips;
    uint24 public immutable maxFeePips;

    /// @notice Current base LP fee (hundredths of a bip; 3000 = 0.30%).
    ///         Batch 3 adds a volatility surge on top via the `_getFee` seam.
    uint24 public baseFeePips;

    /// @notice Pool-key allowlist by PoolId. `_beforeInitialize` rejects any pool
    ///         not pre-registered here, defeating the Cork "attacker spins up a
    ///         pool with our hook + their malicious token" class.
    mapping(PoolId => bool) public allowedPools;

    modifier onlyParamAdmin() {
        if (msg.sender != paramAdmin) revert NotParamAdmin();
        _;
    }

    /// @param poolManager_       canonical V4 PoolManager singleton
    /// @param blockNumberOffset_ JIT window for LiquidityPenaltyHook (larger for
    ///                           low-liquidity / long-tail pools)
    /// @param paramAdmin_        parameter admin (TegridyV4HookAdmin in Batch 4)
    /// @param minFeePips_        immutable lower fee bound
    /// @param maxFeePips_        immutable upper fee bound
    /// @param baseFeePips_       initial base fee (must sit within the bounds)
    constructor(
        IPoolManager poolManager_,
        uint48 blockNumberOffset_,
        address paramAdmin_,
        uint24 minFeePips_,
        uint24 maxFeePips_,
        uint24 baseFeePips_
    ) LiquidityPenaltyHook(poolManager_, blockNumberOffset_) {
        if (paramAdmin_ == address(0)) revert NotParamAdmin();
        // Bounds must be ordered and within the V4 ceiling (MAX_LP_FEE = 1e6 = 100%).
        if (minFeePips_ > maxFeePips_ || maxFeePips_ > LPFeeLibrary.MAX_LP_FEE) revert InvalidFeeBounds();
        if (baseFeePips_ < minFeePips_ || baseFeePips_ > maxFeePips_) revert FeeOutOfBounds();
        paramAdmin = paramAdmin_;
        minFeePips = minFeePips_;
        maxFeePips = maxFeePips_;
        baseFeePips = baseFeePips_;
    }

    // ─── Allowlist (Cork defense) ─────────────────────────────────────

    /// @notice Pre-register (or revoke) a pool key permitted to use this hook.
    ///         The admin registers the exact intended key (currencies, fee,
    ///         tickSpacing, hooks == this), whose PoolId is then allowlisted.
    function setPoolAllowed(PoolKey calldata key, bool allowed) external onlyParamAdmin {
        PoolId id = key.toId();
        allowedPools[id] = allowed;
        emit PoolAllowed(id, allowed);
    }

    /// @dev Reject initialization of any pool not on the allowlist.
    function _beforeInitialize(address, PoolKey calldata key, uint160)
        internal
        virtual
        override
        returns (bytes4)
    {
        if (!allowedPools[key.toId()]) revert PoolNotAllowed();
        return this.beforeInitialize.selector;
    }

    // ─── FeeModule ────────────────────────────────────────────────────

    /// @notice Update the base fee within the immutable bounds.
    function setBaseFee(uint24 newFeePips) external onlyParamAdmin {
        if (newFeePips < minFeePips || newFeePips > maxFeePips) revert FeeOutOfBounds();
        emit BaseFeeSet(baseFeePips, newFeePips);
        baseFeePips = newFeePips;
    }

    /// @dev Fee-override module — verbatim copy of OZ `BaseOverrideFee` behavior.
    ///      Require a dynamic-fee pool so the override flag is honored.
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
    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        virtual
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint24 fee = _getFee(sender, key, params, hookData);
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev The fee seam. Batch 2 returns the bounded base fee. Batch 3 replaces
    ///      the body with `base + volatilitySurge` read from the oracle module,
    ///      clamped to `maxFeePips`. Signature stays identical.
    function _getFee(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        view
        virtual
        returns (uint24)
    {
        return baseFeePips;
    }

    // ─── Permissions ──────────────────────────────────────────────────

    /// @dev Merge permissions: LiquidityPenaltyHook's add/remove set + the
    ///      beforeInitialize (allowlist), afterInitialize + beforeSwap (fee) flags.
    function getHookPermissions()
        public
        pure
        virtual
        override
        returns (Hooks.Permissions memory permissions)
    {
        permissions.beforeInitialize = true; // pool-key allowlist (Cork defense)
        permissions.afterInitialize = true; // fee override: dynamic-fee assertion
        permissions.beforeSwap = true; // fee override
        permissions.afterAddLiquidity = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterRemoveLiquidity = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterAddLiquidityReturnDelta = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterRemoveLiquidityReturnDelta = true; // LiquidityPenaltyHook (verbatim)
    }
}
