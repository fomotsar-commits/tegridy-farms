// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TimelockAdmin — Generic inline timelock for admin parameter changes
/// @notice Inspired by MakerDAO DSPause propose/plot/exec pattern.
///         Provides a reusable propose → execute → cancel flow with configurable delays
///         and a universal 7-day proposal validity window.
/// @dev Each timelocked operation is identified by a bytes32 key. Inheriting contracts
///      wrap this with typed propose/execute/cancel functions for each parameter.
///
/// Source pattern: MakerDAO DSPause (billions TVL, never compromised)
/// - Mandatory delay between propose and execute
/// - Proposal expires after validity window (prevents stale proposals from lurking)
/// - Only one pending proposal per key (must cancel before re-proposing)
abstract contract TimelockAdmin {
    // ─── Errors ──────────────────────────────────────────────────────
    error NoPendingProposal(bytes32 key);
    error ProposalNotReady(bytes32 key);
    error ProposalExpired(bytes32 key);
    error ExistingProposalPending(bytes32 key);
    error DelayTooShort(uint256 delay, uint256 minimum);

    // ─── Events ──────────────────────────────────────────────────────
    event ProposalCreated(bytes32 indexed key, uint256 executeAfter, uint256 expiresAt);
    event ProposalExecuted(bytes32 indexed key);
    event ProposalCancelled(bytes32 indexed key);

    // ─── Constants ───────────────────────────────────────────────────
    /// @notice All proposals expire 7 days after they become executable.
    ///         Matches the universal validity window used across all Tegriddy contracts.
    uint256 public constant PROPOSAL_VALIDITY = 7 days;

    /// @notice Minimum delay to prevent instant execution bypass.
    ///         Child contracts should use delays >= 1 hour for any sensitive parameter.
    uint256 public constant MIN_DELAY = 1 hours;

    // ─── State ───────────────────────────────────────────────────────
    /// @notice Maps operation key → timestamp after which the proposal can be executed.
    ///         Zero means no pending proposal for that key.
    mapping(bytes32 => uint256) internal _executeAfter;

    // ─── Internal API ────────────────────────────────────────────────

    /// @notice Create a timelocked proposal.
    /// @param key   Unique identifier for the operation (e.g., keccak256("FEE_CHANGE"))
    /// @param delay Minimum seconds before the proposal becomes executable
    /// @dev Reverts if a proposal for this key is already pending. Caller must cancel first.
    function _propose(bytes32 key, uint256 delay) internal {
        if (delay < MIN_DELAY) revert DelayTooShort(delay, MIN_DELAY);
        if (_executeAfter[key] != 0) revert ExistingProposalPending(key);
        _executeAfter[key] = block.timestamp + delay;
        emit ProposalCreated(key, _executeAfter[key], _executeAfter[key] + PROPOSAL_VALIDITY);
    }

    /// @notice Execute a previously proposed change.
    /// @param key Unique identifier for the operation
    /// @dev Reverts if no proposal exists, if the delay hasn't elapsed, or if the proposal expired.
    ///      Clears the pending state before returning so re-entrancy can't replay.
    function _execute(bytes32 key) internal {
        uint256 readyAt = _executeAfter[key];
        if (readyAt == 0) revert NoPendingProposal(key);
        if (block.timestamp < readyAt) revert ProposalNotReady(key);
        if (block.timestamp > readyAt + PROPOSAL_VALIDITY) revert ProposalExpired(key);
        _executeAfter[key] = 0; // Clear before external effects (CEI)
        emit ProposalExecuted(key);
    }

    /// @notice Cancel a pending proposal.
    /// @param key Unique identifier for the operation
    /// @dev Reverts if no proposal exists for this key.
    function _cancel(bytes32 key) internal {
        if (_executeAfter[key] == 0) revert NoPendingProposal(key);
        _executeAfter[key] = 0;
        emit ProposalCancelled(key);
    }

    /// @notice Check whether a proposal is pending for a given key.
    function hasPendingProposal(bytes32 key) external view returns (bool) {
        return _executeAfter[key] != 0;
    }

    /// @notice Get the execute-after timestamp for a pending proposal.
    /// @return 0 if no proposal is pending, otherwise the timestamp.
    function proposalExecuteAfter(bytes32 key) external view returns (uint256) {
        return _executeAfter[key];
    }
}
