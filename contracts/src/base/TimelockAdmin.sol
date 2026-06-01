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
///
/// AUDIT FIX FRESH-2026 — F-75-9..15 review (negative findings):
///   - F-75-9 (boundary check at exact expiration): verified safe — `_execute`
///     uses `block.timestamp > readyAt + validity` (strict-`>`), so execution
///     at the exact expiry instant succeeds and `>` ensures expiry exclusive.
///   - F-75-10 (MIN_DELAY-1 attack): mitigated by `if (minD < MIN_DELAY) minD = MIN_DELAY`
///     hard floor on the `_minDelay()` hook return. Cannot be triggered.
///   - F-75-11 (executeAfter overflow): unreachable — `delay > maxD` is
///     rejected, MAX_DELAY = 30 days, and Solidity 0.8+ checked-math
///     prevents `block.timestamp + delay` overflow.
///   - F-75-12 (queue same proposal twice): per-key uniqueness via
///     `_executeAfter[key] != 0 → revert ExistingProposalPending`.
///   - F-75-13 (stale slot via idempotent re-propose): no exploit; child
///     contracts that short-circuit `propose*` on idempotent state have
///     their `_executeAfter` slot cleared by the prior `_execute`.
///   - F-75-14 (pendingStakingAdmin race): unreachable due to ordering.
///   - F-75-15 (force-cancel migration): all in-tree direct-write paths
///     use `_forceCancel(KEY)` which fires the canonical
///     `ProposalCancelled` event.
/// AUDIT FIX FRESH-2026 — F-40-TLA-2 (`_maxDelay` fallback): documented
/// LOW. The `if (maxD < minD) maxD = MAX_DELAY` fallback uses MAX_DELAY
/// (30 days) directly. A future child override returning `_minDelay > 30 days`
/// would still trip `DelayTooShort` on every propose since `MAX_DELAY < minD`
/// would short-circuit. In-tree no child does this — flagged for future
/// auditors. The mitigation is "use `max(MAX_DELAY, minD * 2)` instead",
/// but that requires the override-hook contract to declare both `_minDelay`
/// and `_maxDelay` consistently, which is on the child author.
/// AUDIT FIX FRESH-2026 — F-40-TLA-3 (`_executeAfter` direct-write):
/// `_executeAfter` is `internal` (not `private`) so child contracts CAN
/// direct-write `_executeAfter[KEY] = 0` to bypass the `ProposalCancelled`
/// event. Mitigation: every in-tree child has been audited and uses
/// `_forceCancel(KEY)` for out-of-band clears (see F-75-15). New child
/// contracts MUST use `_forceCancel`; direct-writes are forbidden.
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
    /// @dev AUDIT FIX 2026-05-26 [M-19]: SECURITY INVARIANT — child contracts MUST
    ///      use `_forceCancel(KEY)` for cancellation paths to emit the canonical
    ///      `ProposalCancelled(KEY)` event. Direct writes (`_executeAfter[KEY] = 0`)
    ///      bypass observability for any indexer subscribed to that event. Verified
    ///      safe in current consumers as of the 2026-05-26 swarm audit; future
    ///      contributors MUST preserve this convention. CI lint recommendation:
    ///      grep for direct writes outside `_propose`/`_execute`/`_cancel`/
    ///      `_forceCancel` and block PRs that introduce them.
    mapping(bytes32 => uint256) internal _executeAfter;

    // ─── Internal API ────────────────────────────────────────────────

    /// @notice Create a timelocked proposal.
    /// @param key   Unique identifier for the operation (e.g., keccak256("FEE_CHANGE"))
    /// @param delay Minimum seconds before the proposal becomes executable
    /// @dev Reverts if a proposal for this key is already pending. Caller must cancel first.
    /// @dev AUDIT FIX FRESH-2026: F-40-TLA-1 — the emitted `expiresAt` now
    ///      uses the FLOORED validity (max(_proposalValidity(), MIN_DELAY))
    ///      rather than the raw hook return. Pre-fix a child overriding
    ///      `_proposalValidity()` to return below MIN_DELAY would emit a
    ///      misleading `expiresAt` to off-chain indexers (apparent expiry
    ///      = readyAt + 0) while `_execute` actually allowed execution up
    ///      to readyAt + MIN_DELAY (via the M30 floor). On-chain and
    ///      off-chain views were divergent — a footgun for any future
    ///      override.
    function _propose(bytes32 key, uint256 delay) internal {
        uint256 minD = _minDelay();
        // FRESH-EYES L: protocol-wide hard floor on the override-hook return value. Without
        // this, a malicious or buggy child could override `_minDelay()` to return 0 and
        // defeat the entire timelock invariant. The MIN_DELAY constant is the documented
        // protocol-wide minimum ("1 hour minimum" — see line 51); enforcing it here makes
        // the hook a UPPER-bound override (children can require longer delays via override,
        // never shorter). Pattern of record: Compound Timelock.MINIMUM_DELAY is hard-coded
        // and not overridable.
        if (minD < MIN_DELAY) minD = MIN_DELAY;
        uint256 maxD = _maxDelay();
        // AUDIT FIX (BATCH-H M30): symmetric protocol-wide floor on `_maxDelay()`
        // override. Pre-fix, a child returning maxD == 0 (or maxD < minD) would
        // make `delay > maxD` trip on EVERY proposal, permanently bricking the
        // child's admin surface. Mirror the MIN_DELAY hard-floor on minD above.
        if (maxD < minD) maxD = MAX_DELAY;
        if (delay < minD) revert DelayTooShort(delay, minD);
        // AUDIT MICROSCOPE_2026_04_30 M-Lib1: cap the per-call delay.
        if (delay > maxD) revert DelayTooLong(delay, maxD);
        if (_executeAfter[key] != 0) revert ExistingProposalPending(key);
        _executeAfter[key] = block.timestamp + delay;
        // AUDIT FIX FRESH-2026: F-40-TLA-1 — floor the validity used in
        // the event so off-chain indexers see the same window that
        // `_execute` actually enforces. Without the floor, a child that
        // overrides `_proposalValidity()` to return < MIN_DELAY would emit
        // a tighter window than the contract honors at execute time —
        // off-chain monitors would mark the proposal as expired before
        // the contract actually rejects it, masking the divergence.
        uint256 validityForEvent = _proposalValidity();
        if (validityForEvent < MIN_DELAY) validityForEvent = MIN_DELAY;
        emit ProposalCreated(key, _executeAfter[key], _executeAfter[key] + validityForEvent);
    }

    /// @notice Execute a previously proposed change.
    /// @param key Unique identifier for the operation
    /// @dev Reverts if no proposal exists, if the delay hasn't elapsed, or if the proposal expired.
    ///      Clears the pending state before returning so re-entrancy can't replay.
    function _execute(bytes32 key) internal {
        uint256 readyAt = _executeAfter[key];
        if (readyAt == 0) revert NoPendingProposal(key);
        if (block.timestamp < readyAt) revert ProposalNotReady(key);
        // AUDIT FIX (BATCH-H M30): floor _proposalValidity() at MIN_DELAY (1h).
        // Pre-fix, a child returning 0 would make this comparison `block.timestamp > readyAt`
        // — a 1-second execution window. Floor mirrors the minD floor in _propose.
        uint256 validity = _proposalValidity();
        if (validity < MIN_DELAY) validity = MIN_DELAY;
        if (block.timestamp > readyAt + validity) revert ProposalExpired(key);
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

    /// @notice Canonical read accessor for child contracts. Returns the
    ///         timestamp after which the pending proposal for `key` becomes
    ///         executable, or 0 if no proposal is pending.
    function _proposalReadyAt(bytes32 key) internal view returns (uint256) {
        return _executeAfter[key];
    }

    /// @notice DEPRECATED — use `_proposalReadyAt` instead.
    /// @dev    Kept for back-compat with test harnesses that call this name.
    // slither-disable-next-line dead-code
    function _executeAfterOf(bytes32 key) internal view returns (uint256) {
        return _executeAfter[key];
    }
}
