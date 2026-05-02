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
    /// @dev AUDIT MICROSCOPE_2026_04_30 M-Lib1: caller passed a `delay` exceeding
    ///      `MAX_DELAY`. Closes the brief-key-compromise → indefinite-lockout
    ///      attack where a captured owner could call every typed propose with
    ///      `delay = type(uint256).max`, freezing the protocol's admin surface
    ///      for billions of years (since `_propose` rejects re-proposals while
    ///      a previous one is pending).
    error DelayTooLong(uint256 delay, uint256 maximum);

    // ─── Events ──────────────────────────────────────────────────────
    event ProposalCreated(bytes32 indexed key, uint256 executeAfter, uint256 expiresAt);
    event ProposalExecuted(bytes32 indexed key);
    event ProposalCancelled(bytes32 indexed key);

    // ─── Constants ───────────────────────────────────────────────────
    /// @notice All proposals expire 7 days after they become executable.
    ///         Matches the universal validity window used across all Tegriddy contracts.
    /// @dev    AUDIT FIX: DEEP-LIB-L5 — kept as `constant` for backward
    ///         compatibility with downstream contracts that read this value
    ///         without parens (e.g. RevenueDistributor.executeClaimRecovery).
    ///         Children that need a different validity window should override
    ///         the `_proposalValidity()` virtual hook below — `_propose` and
    ///         `_execute` use the hook so an override widens the window
    ///         consistently across propose / execute paths.
    uint256 public constant PROPOSAL_VALIDITY = 7 days;

    /// @notice Minimum delay to prevent instant execution bypass.
    ///         Child contracts should use delays >= 1 hour for any sensitive parameter.
    /// @dev    AUDIT FIX: DEEP-LIB-M-Lib1 (027 M-01) — see `_minDelay()`
    ///         virtual hook below for child-overridable behaviour.
    uint256 public constant MIN_DELAY = 1 hours;

    /// @notice AUDIT MICROSCOPE_2026_04_30 M-Lib1: maximum delay cap. 30 days
    ///         matches Compound's `Timelock.MAXIMUM_DELAY` and bounds the
    ///         worst-case lockout from a single captured-owner propose call
    ///         to one month — long enough to be inconvenient but recoverable
    ///         via guardian-cancel within the validity window.
    /// @dev    AUDIT FIX: DEEP-LIB-L4 — see `_maxDelay()` virtual hook
    ///         below for child-overridable behaviour. Constant exposed for
    ///         backward compatibility (downstream contracts may reference it
    ///         in tests or off-chain tooling).
    uint256 public constant MAX_DELAY = 30 days;

    // ─── Virtual hooks (DEEP-LIB-L4 / L5 / M-Lib1) ───────────────────
    // The lib uses these virtual hooks rather than the public constants so a
    // child contract with a more conservative or more permissive policy can
    // override without breaking external getters (constants stay as documented
    // protocol-wide defaults). Children override the hook, NOT the constant.

    /// @dev AUDIT FIX: DEEP-LIB-M-Lib1 — virtual minimum-delay hook.
    function _minDelay() internal view virtual returns (uint256) {
        return MIN_DELAY;
    }

    /// @dev AUDIT FIX: DEEP-LIB-L4 — virtual maximum-delay hook. Children
    ///      that genuinely need >30-day delays for treasury-class ops should
    ///      override this rather than encoding cap-evasion in their own typed
    ///      propose paths.
    function _maxDelay() internal view virtual returns (uint256) {
        return MAX_DELAY;
    }

    /// @dev AUDIT FIX: DEEP-LIB-L5 — virtual proposal-validity hook.
    ///      Emergency-class proposals (e.g. RevenueDistributor.executeEmergencyWithdrawExcess,
    ///      POLAccumulator.executeSweepETH) should override with a wider window
    ///      so a multisig-unavailability event doesn't expire the proposal
    ///      mid-incident-response.
    function _proposalValidity() internal view virtual returns (uint256) {
        return PROPOSAL_VALIDITY;
    }

    // ─── State ───────────────────────────────────────────────────────
    /// @notice Maps operation key → timestamp after which the proposal can be executed.
    ///         Zero means no pending proposal for that key.
    /// @dev    AUDIT FIX: DEEP-LIB-H4 / DEEP-LIB-M5 — slot remains `internal`
    ///         for backward compatibility with the 17 child contracts that
    ///         currently read `_executeAfter[KEY]` directly in legacy view
    ///         helpers and event-emit paths. The structural defense against
    ///         direct-write bypass-of-`ProposalCancelled` is the new
    ///         `_forceCancel` helper below — child contracts that need to
    ///         clear a pending proposal "out of band" (e.g.
    ///         TegridyFactory.acceptFeeToSetter clearing a queued
    ///         old-setter proposal) MUST call `_forceCancel(KEY)` rather
    ///         than direct-writing zero. New child contracts SHOULD use
    ///         `_proposalReadyAt(KEY)` for reads to keep the surface
    ///         consistent. A future major version may demote this slot to
    ///         `private` once all callsites have migrated.
    /// @dev    AUDIT FIX: v3-LIB-I1 — `_proposalReadyAt` is canonical (used
    ///         by all 5 in-tree callers across CommunityGrants, TegridyFeeHook,
    ///         and TegridyTWAP); `_executeAfterOf` is the deprecated alias
    ///         retained only for backward-compat. See the function-level
    ///         NatSpec on each accessor below.
    mapping(bytes32 => uint256) internal _executeAfter;

    // ─── Internal API ────────────────────────────────────────────────

    /// @notice Create a timelocked proposal.
    /// @param key   Unique identifier for the operation (e.g., keccak256("FEE_CHANGE"))
    /// @param delay Minimum seconds before the proposal becomes executable
    /// @dev Reverts if a proposal for this key is already pending. Caller must cancel first.
    function _propose(bytes32 key, uint256 delay) internal {
        uint256 minD = _minDelay();
        uint256 maxD = _maxDelay();
        if (delay < minD) revert DelayTooShort(delay, minD);
        // AUDIT MICROSCOPE_2026_04_30 M-Lib1: cap the per-call delay.
        if (delay > maxD) revert DelayTooLong(delay, maxD);
        if (_executeAfter[key] != 0) revert ExistingProposalPending(key);
        _executeAfter[key] = block.timestamp + delay;
        emit ProposalCreated(key, _executeAfter[key], _executeAfter[key] + _proposalValidity());
    }

    /// @notice Execute a previously proposed change.
    /// @param key Unique identifier for the operation
    /// @dev Reverts if no proposal exists, if the delay hasn't elapsed, or if the proposal expired.
    ///      Clears the pending state before returning so re-entrancy can't replay.
    function _execute(bytes32 key) internal {
        uint256 readyAt = _executeAfter[key];
        if (readyAt == 0) revert NoPendingProposal(key);
        if (block.timestamp < readyAt) revert ProposalNotReady(key);
        if (block.timestamp > readyAt + _proposalValidity()) revert ProposalExpired(key);
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

    /// @notice AUDIT FIX: DEEP-LIB-H4 / DEEP-LIB-M5 — best-effort cancel that
    ///         silently no-ops when no proposal is pending and ALWAYS emits
    ///         the canonical `ProposalCancelled(key)` event when it does
    ///         clear state. Use this from child-contract paths that
    ///         "transitively" need to invalidate a pending proposal —
    ///         the canonical case is TegridyFactory.acceptFeeToSetter,
    ///         which clears the previous setter's queued FEE_TO_CHANGE on
    ///         setter rotation. Pre-fix that direct-wrote
    ///         `_executeAfter[FEE_TO_CHANGE] = 0`, suppressing the
    ///         ProposalCancelled event that off-chain monitors / Tenderly
    ///         alerts subscribe to. New child contracts MUST use this
    ///         helper rather than direct-writing zero.
    /// @param  key Unique identifier for the operation.
    /// @return cancelled True iff a pending proposal was cleared by this call.
    function _forceCancel(bytes32 key) internal returns (bool cancelled) {
        if (_executeAfter[key] == 0) return false;
        _executeAfter[key] = 0;
        emit ProposalCancelled(key);
        return true;
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

    /// @notice AUDIT FIX: DEEP-LIB-H4 / DEEP-LIB-M5 — canonical read accessor
    ///         for child contracts. Returns the timestamp after which the
    ///         pending proposal for `key` becomes executable, or 0 if no
    ///         proposal is pending. Kept under the "force-cancel + getter"
    ///         pair so future migrations to `private _executeAfter` can be
    ///         performed by demoting the storage slot without breaking
    ///         downstream `_proposalReadyAt` callers.
    /// @dev    AUDIT FIX: v3-LIB-I1 — declared CANONICAL (over the deprecated
    ///         `_executeAfterOf` alias below). All 5 in-tree callers
    ///         (CommunityGrants:658,711, TegridyFeeHook:331, TegridyTWAP:546,575)
    ///         use this name. New child contracts MUST use `_proposalReadyAt`.
    function _proposalReadyAt(bytes32 key) internal view returns (uint256) {
        return _executeAfter[key];
    }

    /// @notice DEPRECATED — use `_proposalReadyAt` instead.
    /// @dev    AUDIT FIX: v3-LIB-I1 — kept as a back-compat alias only;
    ///         `_proposalReadyAt` is the canonical accessor (5 in-tree callers
    ///         vs 0 for this name). New code MUST NOT call `_executeAfterOf`.
    ///         A future major-version bump can drop this alias once all
    ///         downstream consumers (none in-tree today) have migrated.
    function _executeAfterOf(bytes32 key) internal view returns (uint256) {
        return _executeAfter[key];
    }
}
