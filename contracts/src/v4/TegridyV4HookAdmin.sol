// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OwnableNoRenounce} from "../base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "../base/TimelockAdmin.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @notice Minimal interface to TegridyV4Hook's paramAdmin-gated setters + bounds.
interface ITegridyV4HookApply {
    function setBaseFee(uint24 newFeePips) external;
    function setPolSkimBps(uint16 newBps) external;
    function setPolRecipient(address newRecipient) external;
    function setPoolAllowed(PoolKey calldata key, bool allowed) external;
    function setPaused(bool p) external;
    function setPauseGuardian(address newGuardian) external;
    function setDiscountConfig(address premiumAccess, address trustedRouter, uint16 discountBps) external;
    function setFeeSplit(uint16 stakerShareBps, uint16 treasuryShareBps) external;
    function setFeeSinks(address stakerSink, address treasury) external;
    function sweepPOL(Currency currency) external;
    function minFeePips() external view returns (uint24);
    function maxFeePips() external view returns (uint24);
    function maxPolSkimBps() external view returns (uint16);
    function baseFeePips() external view returns (uint24);
}

/// @title  TegridyV4HookAdmin — timelocked parameter governance for TegridyV4Hook
/// @notice Sister contract holding the propose → execute → cancel triplets for
///         every mutable TegridyV4Hook parameter. Mirrors the in-repo
///         SwapFeeRouterAdmin pattern verbatim (OwnableNoRenounce + TimelockAdmin),
///         dispatching the actual writes to the hook's `setX` setters, which are
///         `onlyParamAdmin == address(this)`.
///
/// @dev    Deploy order (the hook's `paramAdmin` is IMMUTABLE):
///           1. deploy TegridyV4HookAdmin (owner = multisig)
///           2. deploy TegridyV4Hook with paramAdmin = address(thisAdmin)
///           3. admin.setHook(hook)  — one-time wiring
///         The hook is immutable; only these bounded params change, behind the
///         48h/24h timelock + 7-day validity window from TimelockAdmin.
contract TegridyV4HookAdmin is OwnableNoRenounce, TimelockAdmin {
    // ─── Errors ───────────────────────────────────────────────────────
    error ZeroAddress();
    error HookAlreadySet();
    error HookNotSet();
    error FeeOutOfBounds();
    error SkimOutOfBounds();

    // ─── Timelock keys ────────────────────────────────────────────────
    bytes32 public constant BASE_FEE_CHANGE = keccak256("V4_BASE_FEE_CHANGE");
    bytes32 public constant POL_SKIM_CHANGE = keccak256("V4_POL_SKIM_CHANGE");
    bytes32 public constant POL_RECIPIENT_CHANGE = keccak256("V4_POL_RECIPIENT_CHANGE");
    bytes32 public constant POOL_ALLOW_CHANGE = keccak256("V4_POOL_ALLOW_CHANGE");
    bytes32 public constant DISCOUNT_CONFIG_CHANGE = keccak256("V4_DISCOUNT_CONFIG_CHANGE");
    bytes32 public constant FEE_SPLIT_CHANGE = keccak256("V4_FEE_SPLIT_CHANGE");
    bytes32 public constant FEE_SINKS_CHANGE = keccak256("V4_FEE_SINKS_CHANGE");

    // ─── Delays ───────────────────────────────────────────────────────
    uint256 public constant BASE_FEE_DELAY = 24 hours;
    uint256 public constant POL_SKIM_DELAY = 24 hours;
    uint256 public constant POL_RECIPIENT_DELAY = 48 hours;
    uint256 public constant POOL_ALLOW_DELAY = 48 hours;
    uint256 public constant DISCOUNT_CONFIG_DELAY = 24 hours;
    uint256 public constant FEE_SPLIT_DELAY = 48 hours; // economic routing
    uint256 public constant FEE_SINKS_DELAY = 48 hours; // changes where money flows

    // ─── Wired hook (set once; hook.paramAdmin is immutable so admin precedes hook) ──
    ITegridyV4HookApply public hook;
    bool private _hookSet;

    // ─── Pending storage ──────────────────────────────────────────────
    uint24 public pendingBaseFee;
    uint16 public pendingPolSkimBps;
    address public pendingPolRecipient;
    PoolKey public pendingPoolKey;
    bool public pendingPoolAllowed;
    address public pendingPremiumAccess;
    address public pendingTrustedRouter;
    uint16 public pendingDiscountBps;
    uint16 public pendingStakerShareBps;
    uint16 public pendingTreasuryShareBps;
    address public pendingStakerSink;
    address public pendingTreasuryAddr;

    // ─── Events ───────────────────────────────────────────────────────
    event HookSet(address indexed hook);
    event BaseFeeChangeProposed(uint24 newFeePips, uint256 executeAfter);
    event BaseFeeChangeCancelled(uint24 cancelledFeePips);
    event PolSkimChangeProposed(uint16 newBps, uint256 executeAfter);
    event PolSkimChangeCancelled(uint16 cancelledBps);
    event PolRecipientChangeProposed(address indexed newRecipient, uint256 executeAfter);
    event PolRecipientChangeCancelled(address indexed cancelledRecipient);
    event PoolAllowChangeProposed(bool allowed, uint256 executeAfter);
    event PoolAllowChangeCancelled();
    event DiscountConfigChangeProposed(address premiumAccess, address trustedRouter, uint16 discountBps, uint256 executeAfter);
    event DiscountConfigChangeCancelled();
    event FeeSplitChangeProposed(uint16 stakerShareBps, uint16 treasuryShareBps, uint256 executeAfter);
    event FeeSplitChangeCancelled();
    event FeeSinksChangeProposed(address stakerSink, address treasury, uint256 executeAfter);
    event FeeSinksChangeCancelled();

    constructor() OwnableNoRenounce(msg.sender) {}

    /// @notice One-time wiring of the hook this admin governs.
    function setHook(address hook_) external onlyOwner {
        if (_hookSet) revert HookAlreadySet();
        if (hook_ == address(0)) revert ZeroAddress();
        hook = ITegridyV4HookApply(hook_);
        _hookSet = true;
        emit HookSet(hook_);
    }

    modifier hookWired() {
        if (!_hookSet) revert HookNotSet();
        _;
    }

    // ─── Base fee ──────────────────────────────────────────────────────
    function proposeBaseFee(uint24 newFeePips) external onlyOwner hookWired {
        if (newFeePips < hook.minFeePips() || newFeePips > hook.maxFeePips()) revert FeeOutOfBounds();
        pendingBaseFee = newFeePips;
        _propose(BASE_FEE_CHANGE, BASE_FEE_DELAY);
        emit BaseFeeChangeProposed(newFeePips, _executeAfter[BASE_FEE_CHANGE]);
    }

    function executeBaseFee() external onlyOwner hookWired {
        _execute(BASE_FEE_CHANGE);
        uint24 v = pendingBaseFee;
        pendingBaseFee = 0;
        hook.setBaseFee(v);
    }

    function cancelBaseFee() external onlyOwner {
        _cancel(BASE_FEE_CHANGE);
        emit BaseFeeChangeCancelled(pendingBaseFee);
        pendingBaseFee = 0;
    }

    // ─── POL skim ──────────────────────────────────────────────────────
    function proposePolSkim(uint16 newBps) external onlyOwner hookWired {
        if (newBps > hook.maxPolSkimBps()) revert SkimOutOfBounds();
        pendingPolSkimBps = newBps;
        _propose(POL_SKIM_CHANGE, POL_SKIM_DELAY);
        emit PolSkimChangeProposed(newBps, _executeAfter[POL_SKIM_CHANGE]);
    }

    function executePolSkim() external onlyOwner hookWired {
        _execute(POL_SKIM_CHANGE);
        uint16 v = pendingPolSkimBps;
        pendingPolSkimBps = 0;
        hook.setPolSkimBps(v);
    }

    function cancelPolSkim() external onlyOwner {
        _cancel(POL_SKIM_CHANGE);
        emit PolSkimChangeCancelled(pendingPolSkimBps);
        pendingPolSkimBps = 0;
    }

    // ─── POL recipient ─────────────────────────────────────────────────
    function proposePolRecipient(address newRecipient) external onlyOwner hookWired {
        if (newRecipient == address(0)) revert ZeroAddress();
        pendingPolRecipient = newRecipient;
        _propose(POL_RECIPIENT_CHANGE, POL_RECIPIENT_DELAY);
        emit PolRecipientChangeProposed(newRecipient, _executeAfter[POL_RECIPIENT_CHANGE]);
    }

    function executePolRecipient() external onlyOwner hookWired {
        _execute(POL_RECIPIENT_CHANGE);
        address v = pendingPolRecipient;
        pendingPolRecipient = address(0);
        hook.setPolRecipient(v);
    }

    function cancelPolRecipient() external onlyOwner {
        _cancel(POL_RECIPIENT_CHANGE);
        emit PolRecipientChangeCancelled(pendingPolRecipient);
        pendingPolRecipient = address(0);
    }

    // ─── Pool allowlist ────────────────────────────────────────────────
    function proposePoolAllowed(PoolKey calldata key, bool allowed) external onlyOwner hookWired {
        pendingPoolKey = key;
        pendingPoolAllowed = allowed;
        _propose(POOL_ALLOW_CHANGE, POOL_ALLOW_DELAY);
        emit PoolAllowChangeProposed(allowed, _executeAfter[POOL_ALLOW_CHANGE]);
    }

    function executePoolAllowed() external onlyOwner hookWired {
        _execute(POOL_ALLOW_CHANGE);
        PoolKey memory k = pendingPoolKey;
        bool allowed = pendingPoolAllowed;
        delete pendingPoolKey;
        pendingPoolAllowed = false;
        hook.setPoolAllowed(k, allowed);
    }

    function cancelPoolAllowed() external onlyOwner {
        _cancel(POOL_ALLOW_CHANGE);
        delete pendingPoolKey;
        pendingPoolAllowed = false;
        emit PoolAllowChangeCancelled();
    }

    // ─── Premium discount config ──────────────────────────────────────
    function proposeDiscountConfig(address premiumAccess_, address trustedRouter_, uint16 discountBps_)
        external
        onlyOwner
        hookWired
    {
        pendingPremiumAccess = premiumAccess_;
        pendingTrustedRouter = trustedRouter_;
        pendingDiscountBps = discountBps_;
        _propose(DISCOUNT_CONFIG_CHANGE, DISCOUNT_CONFIG_DELAY);
        emit DiscountConfigChangeProposed(
            premiumAccess_, trustedRouter_, discountBps_, _executeAfter[DISCOUNT_CONFIG_CHANGE]
        );
    }

    function executeDiscountConfig() external onlyOwner hookWired {
        _execute(DISCOUNT_CONFIG_CHANGE);
        (address pa, address tr, uint16 d) = (pendingPremiumAccess, pendingTrustedRouter, pendingDiscountBps);
        pendingPremiumAccess = address(0);
        pendingTrustedRouter = address(0);
        pendingDiscountBps = 0;
        hook.setDiscountConfig(pa, tr, d); // hook re-validates discountBps <= MAX_DISCOUNT_BPS
    }

    function cancelDiscountConfig() external onlyOwner {
        _cancel(DISCOUNT_CONFIG_CHANGE);
        pendingPremiumAccess = address(0);
        pendingTrustedRouter = address(0);
        pendingDiscountBps = 0;
        emit DiscountConfigChangeCancelled();
    }

    // ─── Fee split (staker / treasury / POL shares) ───────────────────
    function proposeFeeSplit(uint16 stakerShareBps_, uint16 treasuryShareBps_) external onlyOwner hookWired {
        pendingStakerShareBps = stakerShareBps_;
        pendingTreasuryShareBps = treasuryShareBps_;
        _propose(FEE_SPLIT_CHANGE, FEE_SPLIT_DELAY);
        emit FeeSplitChangeProposed(stakerShareBps_, treasuryShareBps_, _executeAfter[FEE_SPLIT_CHANGE]);
    }

    function executeFeeSplit() external onlyOwner hookWired {
        _execute(FEE_SPLIT_CHANGE);
        (uint16 s, uint16 t) = (pendingStakerShareBps, pendingTreasuryShareBps);
        pendingStakerShareBps = 0;
        pendingTreasuryShareBps = 0;
        hook.setFeeSplit(s, t); // hook re-validates s + t <= BPS
    }

    function cancelFeeSplit() external onlyOwner {
        _cancel(FEE_SPLIT_CHANGE);
        pendingStakerShareBps = 0;
        pendingTreasuryShareBps = 0;
        emit FeeSplitChangeCancelled();
    }

    // ─── Fee sinks (where the split is routed) ────────────────────────
    function proposeFeeSinks(address stakerSink_, address treasury_) external onlyOwner hookWired {
        pendingStakerSink = stakerSink_;
        pendingTreasuryAddr = treasury_;
        _propose(FEE_SINKS_CHANGE, FEE_SINKS_DELAY);
        emit FeeSinksChangeProposed(stakerSink_, treasury_, _executeAfter[FEE_SINKS_CHANGE]);
    }

    function executeFeeSinks() external onlyOwner hookWired {
        _execute(FEE_SINKS_CHANGE);
        (address s, address t) = (pendingStakerSink, pendingTreasuryAddr);
        pendingStakerSink = address(0);
        pendingTreasuryAddr = address(0);
        hook.setFeeSinks(s, t);
    }

    function cancelFeeSinks() external onlyOwner {
        _cancel(FEE_SINKS_CHANGE);
        pendingStakerSink = address(0);
        pendingTreasuryAddr = address(0);
        emit FeeSinksChangeCancelled();
    }

    // ─── Emergency pause pass-throughs (INSTANT — not timelocked) ──────
    // Pausing/unpausing and rotating the guardian must be immediate; a timelock
    // would defeat emergency response. Param *changes* above stay timelocked.

    function hookSetPaused(bool p) external onlyOwner hookWired {
        hook.setPaused(p);
    }

    function hookSetPauseGuardian(address newGuardian) external onlyOwner hookWired {
        hook.setPauseGuardian(newGuardian);
    }

    /// @notice Emergency rescue pass-through — flush accrued fee claims of `currency`
    ///         to the hook's `polRecipient`. INSTANT (not timelocked): the hook gates
    ///         `sweepPOL` to `onlyParamAdmin == address(this)`, and this is a no-theft
    ///         escape hatch (fixed destination) needed when an ETH-rejecting sink would
    ///         brick `distributeFees`. AUDIT FIX 2026-05-31 [LOW-4].
    function hookSweepPOL(Currency currency) external onlyOwner hookWired {
        hook.sweepPOL(currency);
    }

    // ─── Ownership handoff (M19-PORT pending-proposal flush) ──────────
    /// @notice AUDIT FIX 2026-07-12 (due-diligence follow-up): flush every in-flight
    ///         timelock proposal on ownership handoff so the incoming owner inherits a
    ///         clean queue. Without this, a proposal queued by an outgoing/compromised
    ///         owner survives the handoff in `_executeAfter[]` (bounded only by the
    ///         7-day PROPOSAL_VALIDITY window) and could later mature under the new
    ///         owner. Restores the M19-PORT invariant already honored by
    ///         SwapFeeRouterAdmin / VoteIncentivesAdmin / POLAccumulator — replicates
    ///         each `cancelX` body verbatim under an `_executeAfter` guard (`_cancel`
    ///         reverts when nothing is pending, so the guard is required).
    /// @dev    `super.acceptOwnership()` runs first so the pendingOwner->owner promotion
    ///         (and the OwnableNoRenounce expiry guard) happens before the flush; the
    ///         typed `*Cancelled` events then emit under the NEW owner's authority.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[BASE_FEE_CHANGE] != 0) {
            _cancel(BASE_FEE_CHANGE);
            emit BaseFeeChangeCancelled(pendingBaseFee);
            pendingBaseFee = 0;
        }
        if (_executeAfter[POL_SKIM_CHANGE] != 0) {
            _cancel(POL_SKIM_CHANGE);
            emit PolSkimChangeCancelled(pendingPolSkimBps);
            pendingPolSkimBps = 0;
        }
        if (_executeAfter[POL_RECIPIENT_CHANGE] != 0) {
            _cancel(POL_RECIPIENT_CHANGE);
            emit PolRecipientChangeCancelled(pendingPolRecipient);
            pendingPolRecipient = address(0);
        }
        if (_executeAfter[POOL_ALLOW_CHANGE] != 0) {
            _cancel(POOL_ALLOW_CHANGE);
            delete pendingPoolKey;
            pendingPoolAllowed = false;
            emit PoolAllowChangeCancelled();
        }
        if (_executeAfter[DISCOUNT_CONFIG_CHANGE] != 0) {
            _cancel(DISCOUNT_CONFIG_CHANGE);
            pendingPremiumAccess = address(0);
            pendingTrustedRouter = address(0);
            pendingDiscountBps = 0;
            emit DiscountConfigChangeCancelled();
        }
        if (_executeAfter[FEE_SPLIT_CHANGE] != 0) {
            _cancel(FEE_SPLIT_CHANGE);
            pendingStakerShareBps = 0;
            pendingTreasuryShareBps = 0;
            emit FeeSplitChangeCancelled();
        }
        if (_executeAfter[FEE_SINKS_CHANGE] != 0) {
            _cancel(FEE_SINKS_CHANGE);
            pendingStakerSink = address(0);
            pendingTreasuryAddr = address(0);
            emit FeeSinksChangeCancelled();
        }
    }
}
