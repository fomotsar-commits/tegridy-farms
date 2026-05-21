// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @notice Minimal interface to VoteIncentives used by the admin's apply hooks
///         and validation reads. Each `apply*` setter on VoteIncentives is
///         `onlyAdmin`.
interface IVoteIncentivesApply {
    // ─── apply* setters (each `onlyAdmin` on the VoteIncentives side) ─
    function applyFeeChange(uint256 newFee) external;
    function applyTreasuryChange(address newTreasury) external;
    function applyWhitelistChange(address token, bool add) external;
    function applyMinBribeAmountChange(address token, uint256 amount) external;
    function applyEnableCommitReveal() external;

    // ─── view-side reads required for validation ──────────────────────
    function MAX_FEE_BPS() external view returns (uint256);
    function bribeFeeBps() external view returns (uint256);
    function commitRevealEnabled() external view returns (bool);
}

/// @title VoteIncentivesAdmin — Sister contract holding timelocked admin flow
/// @notice Holds the propose/execute/cancel triplets and pending state for every
///         timelocked parameter on VoteIncentives. Dispatches the actual writes
///         to VoteIncentives via its `applyXxx` setters (onlyAdmin gated).
/// @dev    AUDIT FIX (pass-8): EIP170-03 — created during the Phase 0.3 split
///         to bring VoteIncentives under the 24,576-byte EIP-170 limit.
///         Pre-fix bytecode was 26,350 bytes (1,774 over). Mirrors the exact
///         pattern used for `SwapFeeRouterAdmin` (Wave-1 sprint 2026-04-26)
///         and `TegridyLendingAdmin` (Phase 0.1, 2026-05-05).
contract VoteIncentivesAdmin is OwnableNoRenounce, TimelockAdmin {
    // ─── Errors ───────────────────────────────────────────────────────
    error ZeroAddress();
    error FeeTooHigh();
    error FeeCannotBeZero();

    // ─── Timelock keys (mirror what VoteIncentives previously held) ────
    bytes32 public constant FEE_CHANGE = keccak256("BRIBE_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("BRIBE_TREASURY_CHANGE");
    bytes32 public constant WHITELIST_CHANGE = keccak256("BRIBE_WHITELIST_CHANGE");
    bytes32 public constant MIN_BRIBE_CHANGE = keccak256("BRIBE_MIN_AMOUNT_CHANGE");
    bytes32 public constant COMMIT_REVEAL_ENABLE = keccak256("COMMIT_REVEAL_ENABLE");

    // ─── Delays (mirror what VoteIncentives previously enforced) ───────
    uint256 public constant FEE_CHANGE_DELAY = 24 hours;
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    uint256 public constant WHITELIST_CHANGE_DELAY = 24 hours;
    uint256 public constant MIN_BRIBE_CHANGE_DELAY = 24 hours;
    uint256 public constant COMMIT_REVEAL_ENABLE_DELAY = 24 hours;

    // ─── Pending storage ──────────────────────────────────────────────
    uint256 public pendingFeeBps;
    address public pendingTreasury;
    address public pendingWhitelistToken;
    bool public pendingWhitelistAction; // true = add, false = remove
    address public pendingMinBribeToken;
    uint256 public pendingMinBribeAmount;

    // ─── Wired VoteIncentives contract ────────────────────────────────
    IVoteIncentivesApply public immutable voteIncentives;

    // ─── Events (proposed/cancelled — "happened" events stay on incentives) ─
    event FeeChangeProposed(uint256 currentFee, uint256 proposedFee, uint256 executeAfter);
    event FeeChangeCancelled(uint256 cancelledFee);
    event TreasuryChangeProposed(address indexed newTreasury, uint256 executeAfter);
    event TreasuryChangeCancelled(address indexed cancelledTreasury);
    event WhitelistChangeProposed(address indexed token, bool add, uint256 executeAfter);
    event WhitelistChangeCancelled(address indexed token);
    event MinBribeAmountChangeProposed(address indexed token, uint256 amount, uint256 executeAfter);
    event MinBribeAmountChangeCancelled(address indexed token, uint256 amount);
    event EnableCommitRevealProposed(uint256 executeAfter);
    event EnableCommitRevealCancelled();

    constructor(address _voteIncentives) OwnableNoRenounce(msg.sender) {
        if (_voteIncentives == address(0)) revert ZeroAddress();
        voteIncentives = IVoteIncentivesApply(_voteIncentives);
    }

    // ─── Fee ──────────────────────────────────────────────────────────
    function proposeFeeChange(uint256 newFee) external onlyOwner {
        if (newFee > voteIncentives.MAX_FEE_BPS()) revert FeeTooHigh();
        if (newFee == 0) revert FeeCannotBeZero(); // M-08 FIX preserved
        pendingFeeBps = newFee;
        _propose(FEE_CHANGE, FEE_CHANGE_DELAY);
        emit FeeChangeProposed(voteIncentives.bribeFeeBps(), newFee, _executeAfter[FEE_CHANGE]);
    }
    function executeFeeChange() external onlyOwner {
        _execute(FEE_CHANGE);
        uint256 v = pendingFeeBps;
        pendingFeeBps = 0;
        voteIncentives.applyFeeChange(v);
    }
    function cancelFeeChange() external onlyOwner {
        _cancel(FEE_CHANGE);
        uint256 cancelled = pendingFeeBps;
        pendingFeeBps = 0;
        emit FeeChangeCancelled(cancelled);
    }
    function feeChangeTime() external view returns (uint256) {
        return _executeAfter[FEE_CHANGE];
    }

    // ─── Treasury ─────────────────────────────────────────────────────
    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(_newTreasury, _executeAfter[TREASURY_CHANGE]);
    }
    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address v = pendingTreasury;
        pendingTreasury = address(0);
        voteIncentives.applyTreasuryChange(v);
    }
    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }
    function treasuryChangeTime() external view returns (uint256) {
        return _executeAfter[TREASURY_CHANGE];
    }

    // ─── Whitelist ────────────────────────────────────────────────────
    function proposeWhitelistChange(address token, bool add) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        pendingWhitelistToken = token;
        pendingWhitelistAction = add;
        _propose(WHITELIST_CHANGE, WHITELIST_CHANGE_DELAY);
        emit WhitelistChangeProposed(token, add, _executeAfter[WHITELIST_CHANGE]);
    }
    function executeWhitelistChange() external onlyOwner {
        _execute(WHITELIST_CHANGE);
        address token = pendingWhitelistToken;
        bool add = pendingWhitelistAction;
        pendingWhitelistToken = address(0);
        pendingWhitelistAction = false; // DEEP-GOV-16 hygiene parity preserved
        voteIncentives.applyWhitelistChange(token, add);
    }
    function cancelWhitelistChange() external onlyOwner {
        _cancel(WHITELIST_CHANGE);
        address cancelled = pendingWhitelistToken;
        pendingWhitelistToken = address(0);
        pendingWhitelistAction = false;
        emit WhitelistChangeCancelled(cancelled);
    }
    function whitelistChangeTime() external view returns (uint256) {
        return _executeAfter[WHITELIST_CHANGE];
    }

    // ─── Min bribe amount ─────────────────────────────────────────────
    function proposeMinBribeAmount(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        pendingMinBribeToken = token;
        pendingMinBribeAmount = amount;
        _propose(MIN_BRIBE_CHANGE, MIN_BRIBE_CHANGE_DELAY);
        emit MinBribeAmountChangeProposed(token, amount, _executeAfter[MIN_BRIBE_CHANGE]);
    }
    function executeMinBribeAmount() external onlyOwner {
        _execute(MIN_BRIBE_CHANGE);
        address token = pendingMinBribeToken;
        uint256 amount = pendingMinBribeAmount;
        pendingMinBribeToken = address(0);
        pendingMinBribeAmount = 0;
        voteIncentives.applyMinBribeAmountChange(token, amount);
    }
    function cancelMinBribeAmount() external onlyOwner {
        address token = pendingMinBribeToken;
        uint256 amount = pendingMinBribeAmount;
        _cancel(MIN_BRIBE_CHANGE);
        pendingMinBribeToken = address(0);
        pendingMinBribeAmount = 0;
        emit MinBribeAmountChangeCancelled(token, amount);
    }
    function minBribeChangeTime() external view returns (uint256) {
        return _executeAfter[MIN_BRIBE_CHANGE];
    }

    // ─── Commit-reveal enable ─────────────────────────────────────────
    /// @notice One-way switch: once enabled there is no path to disable.
    ///         Forward-only by design — flipping back would let an attacker
    ///         race the toggle.
    function proposeEnableCommitReveal() external onlyOwner {
        if (voteIncentives.commitRevealEnabled()) return; // idempotent
        _propose(COMMIT_REVEAL_ENABLE, COMMIT_REVEAL_ENABLE_DELAY);
        emit EnableCommitRevealProposed(_executeAfter[COMMIT_REVEAL_ENABLE]);
    }
    function cancelEnableCommitReveal() external onlyOwner {
        _cancel(COMMIT_REVEAL_ENABLE);
        emit EnableCommitRevealCancelled();
    }
    /// @notice Permissionless execute (NOT onlyOwner) — preserves the original
    ///         contract's behavior where any party could fire the timelocked
    ///         enable once the delay had elapsed. The target is itself onlyAdmin
    ///         on the VoteIncentives side, so flow remains gated end-to-end:
    ///         only this admin contract (immutable wired post-deploy) can toggle.
    function executeEnableCommitReveal() external {
        _execute(COMMIT_REVEAL_ENABLE);
        voteIncentives.applyEnableCommitReveal();
    }
    function commitRevealEnableTime() external view returns (uint256) {
        return _executeAfter[COMMIT_REVEAL_ENABLE];
    }

    /// @notice AUDIT FIX 2026-05-21 M19-CLUSTER: override `acceptOwnership` so any
    ///         pending TIMELOCK_KEY proposals seeded by the outgoing owner are
    ///         CANCELLED automatically on handoff. Mirrors the canonical
    ///         TegridyNFTPoolFactory pattern (M19 fix, commit 0a08bff). Without
    ///         this override, a captured outgoing owner could `propose...`
    ///         immediately before `transferOwnership`, and the timer would silently
    ///         keep running under the new owner. A new-owner deploy/keeper script
    ///         reading `pending...()` could then execute the hostile change.
    /// @dev    Calls `super.acceptOwnership()` first so the pendingOwner→owner
    ///         promotion happens before the cancellations.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[FEE_CHANGE] != 0) {
            uint256 cancelled = pendingFeeBps;
            _cancel(FEE_CHANGE);
            pendingFeeBps = 0;
            emit FeeChangeCancelled(cancelled);
        }
        if (_executeAfter[TREASURY_CHANGE] != 0) {
            address cancelled = pendingTreasury;
            _cancel(TREASURY_CHANGE);
            pendingTreasury = address(0);
            emit TreasuryChangeCancelled(cancelled);
        }
        if (_executeAfter[WHITELIST_CHANGE] != 0) {
            address cancelled = pendingWhitelistToken;
            _cancel(WHITELIST_CHANGE);
            pendingWhitelistToken = address(0);
            pendingWhitelistAction = false;
            emit WhitelistChangeCancelled(cancelled);
        }
        if (_executeAfter[MIN_BRIBE_CHANGE] != 0) {
            address token = pendingMinBribeToken;
            uint256 amount = pendingMinBribeAmount;
            _cancel(MIN_BRIBE_CHANGE);
            pendingMinBribeToken = address(0);
            pendingMinBribeAmount = 0;
            emit MinBribeAmountChangeCancelled(token, amount);
        }
        if (_executeAfter[COMMIT_REVEAL_ENABLE] != 0) {
            _cancel(COMMIT_REVEAL_ENABLE);
            emit EnableCommitRevealCancelled();
        }
    }
}
