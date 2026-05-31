// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OwnableNoRenounce} from "../base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "../base/TimelockAdmin.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @notice Minimal interface to TegridyV4Hook's paramAdmin-gated setters + bounds.
interface ITegridyV4HookApply {
    function setBaseFee(uint24 newFeePips) external;
    function setPolSkimBps(uint16 newBps) external;
    function setPolRecipient(address newRecipient) external;
    function setPoolAllowed(PoolKey calldata key, bool allowed) external;
    function setPaused(bool p) external;
    function setPauseGuardian(address newGuardian) external;
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

    // ─── Delays ───────────────────────────────────────────────────────
    uint256 public constant BASE_FEE_DELAY = 24 hours;
    uint256 public constant POL_SKIM_DELAY = 24 hours;
    uint256 public constant POL_RECIPIENT_DELAY = 48 hours;
    uint256 public constant POOL_ALLOW_DELAY = 48 hours;

    // ─── Wired hook (set once; hook.paramAdmin is immutable so admin precedes hook) ──
    ITegridyV4HookApply public hook;
    bool private _hookSet;

    // ─── Pending storage ──────────────────────────────────────────────
    uint24 public pendingBaseFee;
    uint16 public pendingPolSkimBps;
    address public pendingPolRecipient;
    PoolKey public pendingPoolKey;
    bool public pendingPoolAllowed;

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

    // ─── Emergency pause pass-throughs (INSTANT — not timelocked) ──────
    // Pausing/unpausing and rotating the guardian must be immediate; a timelock
    // would defeat emergency response. Param *changes* above stay timelocked.

    function hookSetPaused(bool p) external onlyOwner hookWired {
        hook.setPaused(p);
    }

    function hookSetPauseGuardian(address newGuardian) external onlyOwner hookWired {
        hook.setPauseGuardian(newGuardian);
    }
}
