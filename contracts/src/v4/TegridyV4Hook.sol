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
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
// Battle-tested verbatim bases / utils (OpenZeppelin/uniswap-hooks v1.1.1, pinned)
import {LiquidityPenaltyHook} from "@openzeppelin/uniswap-hooks/src/general/LiquidityPenaltyHook.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/src/utils/CurrencySettler.sol";

/// @title  TegridyV4Hook — bundled Uniswap V4 hook for the TOWELI pool
/// @notice **BATCHES 1-3c of the V4 implementation** (gate overridden 2026-05-30).
///
///         ARCHITECTURE (see V4_MIGRATION_PLAN.md "Architecture correction"):
///         OZ hooks cannot be bundled by multiple inheritance — every one derives
///         from `BaseHook(poolManager)`, so two of them collide (Solc 3364 + 6480).
///         Resolution: inherit the ONE heavy hook verbatim (`LiquidityPenaltyHook`,
///         the JIT fee-withholding accounting) and hand-write the lightweight
///         concerns as overrides, copying OZ patterns verbatim where they exist.
///
///         Modules present:
///           • JIT        — OZ `LiquidityPenaltyHook` (VERBATIM, inherited)
///           • FeeModule  — 6-line verbatim copy of OZ `BaseOverrideFee` +
///                          admin-configurable bounded fee
///           • Allowlist  — pool-key allowlist in `_beforeInitialize` (Cork defense)
///           • POL        — `_afterSwap` skim of the unspecified currency, accrued
///                          as ERC-6909 claims (custody stays in the PoolManager);
///                          swept to the treasury. take/delta mechanics copied
///                          verbatim from OZ `BaseDynamicAfterFee`.
///
///         DROPPED (no verbatim source; too much custom surface): internal oracle
///         + volatility fee. The admin-bounded base fee stands.
///
/// @dev    NOT YET DEPLOYABLE. Deferred:
///           - Batch 4: TegridyV4HookAdmin timelock becomes `paramAdmin`;
///                      redeem swept ERC-6909 claims → native ETH → RevenueDistributor
///           - Batch 5: HookMiner CREATE2 mining + DeployV4/VerifyV4 + tests
///         BaseHook validates the hook-address permission bits AT CONSTRUCTION,
///         so this only deploys from a HookMiner-mined CREATE2 address.
///
/// @dev    AntiSandwichHook / LimitOrderHook cannot share this pool (both drive
///         `_beforeSwap`/fee). If adopted, each runs on its OWN pool.
contract TegridyV4Hook is LiquidityPenaltyHook {
    using LPFeeLibrary for uint24;
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using CurrencySettler for Currency;
    using SafeCast for uint256;
    using SafeCast for int256;

    /// @dev Basis-points denominator.
    uint16 private constant BPS = 10_000;

    // ─── Errors ───────────────────────────────────────────────────────
    error NotDynamicFee();
    error PoolNotAllowed();
    error NotParamAdmin();
    error FeeOutOfBounds();
    error InvalidFeeBounds();
    error SkimOutOfBounds();
    error ZeroAddress();

    // ─── Events ───────────────────────────────────────────────────────
    event PoolAllowed(PoolId indexed id, bool allowed);
    event BaseFeeSet(uint24 oldFeePips, uint24 newFeePips);
    event PolSkimSet(uint16 oldBps, uint16 newBps);
    event PolRecipientSet(address indexed recipient);
    event PolAccrued(Currency indexed currency, uint256 amount);
    event PolSwept(Currency indexed currency, address indexed to, uint256 amount);

    // ─── Params (mutated only by paramAdmin; hook code itself is immutable) ──
    /// @notice Becomes the TegridyV4HookAdmin timelock in Batch 4. Set at construction.
    address public immutable paramAdmin;

    /// @notice Immutable fee bounds (hundredths of a bip). Even a compromised
    ///         paramAdmin cannot push the fee outside these.
    uint24 public immutable minFeePips;
    uint24 public immutable maxFeePips;
    /// @notice Immutable POL skim ceiling (bps of swap output). Hard upper bound.
    uint16 public immutable maxPolSkimBps;

    /// @notice Current base LP fee (hundredths of a bip; 3000 = 0.30%).
    uint24 public baseFeePips;
    /// @notice POL skim, in bps of the swap's unspecified (output) amount.
    uint16 public polSkimBps;
    /// @notice Destination for swept POL (treasury / RevenueDistributor).
    address public polRecipient;

    /// @notice Pool-key allowlist by PoolId — `_beforeInitialize` rejects any pool
    ///         not pre-registered here (Cork defense).
    mapping(PoolId => bool) public allowedPools;

    modifier onlyParamAdmin() {
        if (msg.sender != paramAdmin) revert NotParamAdmin();
        _;
    }

    constructor(
        IPoolManager poolManager_,
        uint48 blockNumberOffset_,
        address paramAdmin_,
        uint24 minFeePips_,
        uint24 maxFeePips_,
        uint24 baseFeePips_,
        uint16 maxPolSkimBps_,
        uint16 polSkimBps_,
        address polRecipient_
    ) LiquidityPenaltyHook(poolManager_, blockNumberOffset_) {
        if (paramAdmin_ == address(0) || polRecipient_ == address(0)) revert ZeroAddress();
        if (minFeePips_ > maxFeePips_ || maxFeePips_ > LPFeeLibrary.MAX_LP_FEE) revert InvalidFeeBounds();
        if (baseFeePips_ < minFeePips_ || baseFeePips_ > maxFeePips_) revert FeeOutOfBounds();
        if (maxPolSkimBps_ > BPS || polSkimBps_ > maxPolSkimBps_) revert SkimOutOfBounds();
        paramAdmin = paramAdmin_;
        minFeePips = minFeePips_;
        maxFeePips = maxFeePips_;
        baseFeePips = baseFeePips_;
        maxPolSkimBps = maxPolSkimBps_;
        polSkimBps = polSkimBps_;
        polRecipient = polRecipient_;
    }

    // ─── Allowlist (Cork defense) ─────────────────────────────────────

    /// @notice Pre-register (or revoke) a pool key permitted to use this hook.
    function setPoolAllowed(PoolKey calldata key, bool allowed) external onlyParamAdmin {
        PoolId id = key.toId();
        allowedPools[id] = allowed;
        emit PoolAllowed(id, allowed);
    }

    function _beforeInitialize(address, PoolKey calldata key, uint160)
        internal
        virtual
        override
        returns (bytes4)
    {
        if (!allowedPools[key.toId()]) revert PoolNotAllowed();
        return this.beforeInitialize.selector;
    }

    // ─── FeeModule (verbatim copy of OZ BaseOverrideFee) ──────────────

    function setBaseFee(uint24 newFeePips) external onlyParamAdmin {
        if (newFeePips < minFeePips || newFeePips > maxFeePips) revert FeeOutOfBounds();
        emit BaseFeeSet(baseFeePips, newFeePips);
        baseFeePips = newFeePips;
    }

    function _afterInitialize(address, PoolKey calldata key, uint160, int24)
        internal
        virtual
        override
        returns (bytes4)
    {
        if (!key.fee.isDynamicFee()) revert NotDynamicFee();
        return this.afterInitialize.selector;
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        virtual
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint24 fee = _getFee(sender, key, params, hookData);
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev Fee seam (kept for forward-compat: a future surge plugs in here).
    function _getFee(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        internal
        view
        virtual
        returns (uint24)
    {
        return baseFeePips;
    }

    // ─── POLModule (afterSwap skim) ───────────────────────────────────

    function setPolSkimBps(uint16 newBps) external onlyParamAdmin {
        if (newBps > maxPolSkimBps) revert SkimOutOfBounds();
        emit PolSkimSet(polSkimBps, newBps);
        polSkimBps = newBps;
    }

    function setPolRecipient(address newRecipient) external onlyParamAdmin {
        if (newRecipient == address(0)) revert ZeroAddress();
        polRecipient = newRecipient;
        emit PolRecipientSet(newRecipient);
    }

    /// @dev Skim `polSkimBps` of the swap's unspecified (output) currency as a
    ///      protocol fee, accrued to this hook as ERC-6909 claims (custody stays
    ///      in the PoolManager). take/delta mechanics are copied verbatim from OZ
    ///      `BaseDynamicAfterFee._afterSwap`.
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        virtual
        override
        returns (bytes4, int128)
    {
        uint16 bps = polSkimBps;
        if (bps == 0) return (this.afterSwap.selector, 0);

        // Fee taken on the unspecified currency of the swap (OZ pattern).
        (Currency unspecified, int128 unspecifiedAmount) = (params.amountSpecified < 0 == params.zeroForOne)
            ? (key.currency1, delta.amount1())
            : (key.currency0, delta.amount0());
        if (unspecifiedAmount < 0) unspecifiedAmount = -unspecifiedAmount;

        uint256 feeAmount = (uint256(uint128(unspecifiedAmount)) * bps) / BPS;
        if (feeAmount == 0) return (this.afterSwap.selector, 0);

        // Mint ERC-6909 claims of `unspecified` to this hook (claims = true).
        unspecified.take(poolManager, address(this), feeAmount, true);
        emit PolAccrued(unspecified, feeAmount);

        return (this.afterSwap.selector, feeAmount.toInt256().toInt128());
    }

    /// @notice Sweep accrued POL claims of `currency` to the fixed `polRecipient`.
    ///         Permissionless — destination is admin-set, so anyone may trigger.
    ///         (Redeeming claims → native ETH for RevenueDistributor lands in Batch 4.)
    function sweepPOL(Currency currency) external {
        uint256 id = currency.toId();
        uint256 bal = poolManager.balanceOf(address(this), id);
        if (bal == 0) return;
        poolManager.transfer(polRecipient, id, bal);
        emit PolSwept(currency, polRecipient, bal);
    }

    // ─── Permissions ──────────────────────────────────────────────────

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
        permissions.afterSwap = true; // POL skim
        permissions.afterSwapReturnDelta = true; // POL skim takes a delta
        permissions.afterAddLiquidity = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterRemoveLiquidity = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterAddLiquidityReturnDelta = true; // LiquidityPenaltyHook (verbatim)
        permissions.afterRemoveLiquidityReturnDelta = true; // LiquidityPenaltyHook (verbatim)
    }
}
