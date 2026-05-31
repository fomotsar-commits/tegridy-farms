// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title OwnableNoRenounce — Ownable2Step with renounceOwnership permanently disabled
/// @notice Universal best practice across all battle-tested DeFi protocols:
///         Convex, Aave, Curve gauges, and every Tegriddy contract disable renounceOwnership()
///         to prevent accidental admin bricking.
/// @dev Inherits OZ Ownable2Step (2-step transfer: propose → accept).
///      All 10 Tegriddy admin contracts previously overrode renounceOwnership individually.
///      This base contract eliminates that repetition.
abstract contract OwnableNoRenounce is Ownable2Step {
    /// @dev AUDIT FIX: DEEP-LIB-M1 — typed error for the opt-in
    ///      contract-only owner enforcement. Children that opt in by
    ///      overriding `_ownerMustBeContract()` to return `true` will revert
    ///      with this error if a constructor or `_transferOwnership` call
    ///      passes an EOA. Defaults to NOT enforced so existing tests and
    ///      deploy scripts that pass `msg.sender` (an EOA) continue to work.
    error OwnerNotContract(address proposed);
    /// @dev FRESH-EYES L: typed error replacing the legacy `revert("RENOUNCE_DISABLED")`
    ///      string. Brings this revert in line with every other rejection in the file
    ///      (typed selectors), so off-chain alerts and Tenderly filters can subscribe by
    ///      4-byte selector instead of fragile string parsing.
    error RenounceDisabled();
    /// @dev AUDIT FIX FRESH-2026: F-40-ONR-1 — typed error for the
    ///      pending-transfer expiry path. After `OWNERSHIP_TRANSFER_EXPIRY`
    ///      (14 days) elapses without `acceptOwnership`, the pending slot
    ///      auto-clears and any acceptance attempt reverts with this error.
    error OwnershipTransferExpired();
    /// @dev AUDIT FIX FRESH-2026: F-40-ONR-1 — caller of
    ///      `cancelOwnershipTransfer` must be the current owner.
    error NoPendingOwnershipTransfer();
    /// @dev AUDIT FIX FRESH-2026 [M-OWN-TRANSFER-ZERO-DESYNC]: reject zero in
    ///      `transferOwnership` so the OZ-zero "cancel" shortcut can't leave
    ///      `_pendingOwner == 0` + `expiry > 0` desynced. Use
    ///      `cancelOwnershipTransfer(reason)` as the canonical cancel path.
    ///      Distinct from child contracts' own `ZeroAddress` errors to avoid
    ///      inheritance-chain identifier collisions.
    error PendingOwnerZeroAddress();

    /// @notice AUDIT FIX FRESH-2026: F-40-ONR-1 — emitted when the owner
    ///         cancels a pending ownership transfer before acceptance.
    event OwnershipTransferCancelled(address indexed previousPendingOwner, string reason);

    /// @notice AUDIT FIX FRESH-2026: F-40-ONR-1 — pending-transfer expiry
    ///         window. After this period elapses without acceptance, the
    ///         pendingOwner slot is treated as auto-cleared. 14 days
    ///         matches the Compound Timelock GRACE_PERIOD pattern.
    uint256 public constant OWNERSHIP_TRANSFER_EXPIRY = 14 days;

    /// @notice AUDIT FIX FRESH-2026: F-40-ONR-1 — wall-clock at which the
    ///         current pending ownership transfer expires. Zero when no
    ///         pending transfer exists. Set on every successful
    ///         `transferOwnership(newOwner)` call AND cleared on
    ///         `acceptOwnership` / `cancelOwnershipTransfer`.
    uint256 public ownershipTransferExpiresAt;

    /// @dev AUDIT FIX: DEEP-LIB-M1 — opt-in flag (returned by the virtual
    ///      hook below). Children that need contract-only ownership
    ///      enforcement override this to return `true`. Default is `false`
    ///      to preserve compatibility with existing test suites and the
    ///      reference deploy scripts that bootstrap with an EOA owner that
    ///      is later 2-step-rotated to a multisig. Production-only contracts
    ///      that ALWAYS deploy behind a multisig can opt in.
    function _ownerMustBeContract() internal view virtual returns (bool) {
        return false;
    }

    constructor(address initialOwner) Ownable(initialOwner) {
        // AUDIT FIX: V2-LIB-L5 — body checks dropped as unreachable.
        //   OZ's `Ownable(initialOwner)` constructor invokes
        //   `_transferOwnership(initialOwner)` BEFORE this body runs.
        //   Solidity's virtual dispatch routes that call through the
        //   `_transferOwnership` override below even during construction,
        //   so the contract-only enforcement (and the OZ-typed
        //   `OwnableInvalidOwner(0)` revert for `initialOwner == 0`) both
        //   fire BEFORE control reaches this body. A duplicate check here
        //   was structurally unreachable defense-in-depth — pure dead code.
        //   Single source of truth: the `_transferOwnership` override.
    }

    /// @notice Disabled. Cannot renounce ownership.
    /// @dev    AUDIT FIX: DEEP-LIB-L2 — declared `view` (was `pure`) so future
    ///         subclasses can override with state reads (e.g. emitting an
    ///         `OwnershipRenounceAttempted` telemetry event for compromised-key
    ///         detection). Behaviour is unchanged: every call still reverts.
    /// @dev    AUDIT FIX: V2-LIB-I1 — `onlyOwner` re-added to preserve OZ's
    ///         contract surface (the L2 `pure → view` migration accidentally
    ///         dropped the modifier). The function still reverts unconditionally,
    ///         so the access-control change has no exploitable consequence today
    ///         — but a future subclass that emits a telemetry event before the
    ///         revert would otherwise log for ANY caller (event-stream spam by
    ///         arbitrary actors). `onlyOwner` is `view`-compatible since
    ///         `_checkOwner` is itself `view`.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// @dev AUDIT FIX: DEEP-LIB-M1 — re-applies the contract-only enforcement
    ///      on every ownership rotation when the subclass has opted in. A
    ///      compromised owner cannot then `transferOwnership(new_eoa)` then
    ///      `new_eoa.acceptOwnership()` to escape multisig containment.
    ///      OZ Ownable2Step calls `_transferOwnership` from `acceptOwnership`,
    ///      so this guard catches both initial transfer and rotation.
    /// @dev AUDIT FIX: V2-LIB-L1 — removed the `newOwner != address(0)`
    ///      carve-out. The only path that ever reaches `_transferOwnership(0)`
    ///      is `Ownable.renounceOwnership()`, which our override above
    ///      reverts unconditionally — so the carve-out was unreachable dead
    ///      code AND its rationale comment ("OZ's `delete _pendingOwner`
    ///      isn't broken by our guard") was factually wrong: OZ's
    ///      `Ownable2Step._transferOwnership` runs `delete _pendingOwner`
    ///      UNCONDITIONALLY at the start, with no dependence on `newOwner`.
    ///      Removing the carve-out tightens the invariant: any future child
    ///      that adds a "soft-renounce" path which calls `_transferOwnership(0)`
    ///      directly will now correctly trip `OwnerNotContract` when the
    ///      subclass opts in to contract-only ownership.
    function _transferOwnership(address newOwner) internal virtual override {
        if (_ownerMustBeContract()) {
            // AUDIT FIX (BATCH-H M29): EIP-7702 detection. Post-Pectra (live
            // 2025-05-07), an EOA can delegate to code via `0xef0100 ‖ addr`,
            // making `code.length == 23` (3-byte prefix + 20-byte address).
            // Pre-fix, a 7702-EOA passed the `code.length > 0` check, silently
            // defeating the multisig-only invariant the hook was meant to
            // enforce. Now we additionally reject `code.length == 23` which is
            // the 7702 delegation indicator length (genuine multisig contracts
            // have non-23-byte runtime bytecode). This is the conservative-
            // direction filter recommended by ERC-7702 §3. Length-only check
            // avoids inline assembly + stack pressure — sufficient because no
            // legitimate contract has exactly 23 bytes of runtime code.
            uint256 codeLen = newOwner.code.length;
            if (codeLen == 0 || codeLen == 23) revert OwnerNotContract(newOwner);
        }
        // AUDIT FIX FRESH-2026: F-40-ONR-1 — clear the pending-transfer
        // expiry slot whenever ownership is finalized (initial set during
        // construction OR `acceptOwnership` flow). The slot's invariant is
        // "non-zero iff a pending transfer is awaiting acceptance"; on
        // successful transition we collapse to zero.
        ownershipTransferExpiresAt = 0;
        super._transferOwnership(newOwner);
    }

    /// @notice AUDIT FIX FRESH-2026: F-40-ONR-1 — override
    ///         `transferOwnership` to stamp a 14-day expiry on the pending
    ///         slot. Without this, a malicious / misconfigured pendingOwner
    ///         (e.g. a contract whose `acceptOwnership` flow reverts) could
    ///         freeze the rotation surface indefinitely. After
    ///         `OWNERSHIP_TRANSFER_EXPIRY` elapses the pending slot is
    ///         treated as auto-cleared and `acceptOwnership` reverts with
    ///         `OwnershipTransferExpired()` — at which point the current
    ///         owner can `transferOwnership` to a different recipient
    ///         OR call `cancelOwnershipTransfer(reason)` to clear early.
    /// @dev    Calls super to preserve OZ Ownable2Step semantics
    ///         (`_pendingOwner = newOwner`, `OwnershipTransferStarted`).
    function transferOwnership(address newOwner) public virtual override onlyOwner {
        // AUDIT FIX FRESH-2026 [M-OWN-TRANSFER-ZERO-DESYNC]: reject the
        // `transferOwnership(0)` "cancel via OZ semantics" path. OZ
        // Ownable2Step documents `newOwner = address(0)` as the cancel
        // primitive, but our override unconditionally stamps
        // `ownershipTransferExpiresAt = now + 14d` regardless of newOwner.
        // Post-cancel the state pair `_pendingOwner == 0 + expiry > 0` is
        // inconsistent: `acceptOwnership` reverts on OZ pending-owner check
        // (correct), but `pokeOwnershipExpiryWarning` would emit
        // `OwnershipTransferExpiringIn(address(0), remaining)` during the
        // final 24h window — polluting indexers / on-chain alerting with
        // malformed pendingOwner == 0 events. The new
        // `cancelOwnershipTransfer` is the canonical cancel path; reject the
        // OZ-zero shortcut for clarity. ZeroAddress mirrors the existing
        // typed-error pattern.
        if (newOwner == address(0)) revert PendingOwnerZeroAddress();
        super.transferOwnership(newOwner);
        ownershipTransferExpiresAt = block.timestamp + OWNERSHIP_TRANSFER_EXPIRY;
    }

    /// @notice AUDIT FIX FRESH-2026: F-40-ONR-1 — override
    ///         `acceptOwnership` so the expiry guard fires before OZ's
    ///         pending-owner check.
    /// @dev    The current owner can pre-empt the expiry by calling
    ///         `cancelOwnershipTransfer(reason)` first; pendingOwner can
    ///         simply re-trigger by asking the owner to `transferOwnership`
    ///         again with a fresh window.
    function acceptOwnership() public virtual override {
        // Mirror OZ Ownable2Step.acceptOwnership() msg.sender == pendingOwner
        // gate ordering: expiry comes first so an expired-but-still-set
        // pending slot reverts with the typed `OwnershipTransferExpired`
        // (more diagnostic) rather than `OwnableUnauthorizedAccount`.
        uint256 expiry = ownershipTransferExpiresAt;
        if (expiry != 0 && block.timestamp > expiry) {
            revert OwnershipTransferExpired();
        }
        super.acceptOwnership();
    }

    /// @notice AUDIT FIX FRESH-2026: F-40-ONR-1 — current owner can
    ///         cancel a pending ownership transfer before the
    ///         pendingOwner accepts. Closes the bricked-rotation primitive
    ///         where a malicious / misconfigured pendingOwner could freeze
    ///         the rotation surface (OZ Ownable2Step has no native cancel
    ///         path — relies on the owner re-calling `transferOwnership` to
    ///         a different recipient, which may not be possible if the
    ///         pendingOwner is in a state where their reverts are
    ///         consuming gas before the new transfer lands).
    /// @param  reason Free-form string for off-chain audit trail; emitted
    ///                in the `OwnershipTransferCancelled` event.
    function cancelOwnershipTransfer(string calldata reason) external virtual onlyOwner {
        address prev = pendingOwner();
        if (prev == address(0)) revert NoPendingOwnershipTransfer();
        // Use OZ's internal API to clear the pending slot. Ownable2Step's
        // `_transferOwnership` deletes `_pendingOwner` unconditionally at
        // its head, so the safe way to "cancel" without rotating to a new
        // owner is to call `_transferOwnership(owner())` — same owner,
        // pendingOwner cleared as a side-effect. The `OwnershipTransferred`
        // event will fire with identical previous/new params; the
        // `OwnershipTransferCancelled` event below carries the diagnostic
        // breadcrumb (the cancelled pendingOwner address + reason).
        _transferOwnership(owner());
        // Note: `_transferOwnership` zeros `ownershipTransferExpiresAt` via
        // the override above, so the expiry slot is implicitly cleared.
        // We emit the cancellation event AFTER the clear for canonical
        // ordering (state → event).
        emit OwnershipTransferCancelled(prev, reason);
    }

    /// @notice AUDIT FIX 2026-05-26 [M-20]: too-early-to-warn typed revert.
    error PokeTooEarly();
    /// @notice [L1] Poke called before the global cooldown window has elapsed.
    error PokeRateLimited();
    /// @notice AUDIT FIX 2026-05-26 [M-20]: poke event for off-chain monitors.
    event OwnershipTransferExpiringIn(address indexed pendingOwner, uint256 secondsRemaining);

    /// @notice [L1] Global cooldown between successive poke events — 1 hour.
    ///         Prevents spammers from flooding indexers / alert queues at zero cost.
    ///         Pattern: Compound TimelockController rate-limited notification surface.
    uint256 public constant POKE_COOLDOWN = 1 hours;
    /// @notice Timestamp of the most recent successful poke (0 = never poked).
    uint256 public lastPokeTime;

    /// @notice AUDIT FIX 2026-05-26 [M-20]: permissionless poke for off-chain
    ///         alerting on impending 14-day expiry. Fires only in the last
    ///         24h of the window; allows monitors to subscribe to a single
    ///         event rather than poll `ownershipTransferExpiresAt` per-contract.
    ///         Pattern reference: Compound TimelockController surface for queue
    ///         visibility. [L1] Rate-limited to POKE_COOLDOWN (1 h) to prevent
    ///         event-log spam from permissionless callers.
    function pokeOwnershipExpiryWarning() external {
        uint256 expiry = ownershipTransferExpiresAt;
        // AUDIT 2026-05-31 [slither incorrect-equality FP]: zero-sentinel check — `0`
        // means no pending transfer. Standard sentinel pattern.
        // slither-disable-next-line incorrect-equality
        if (expiry == 0) revert NoPendingOwnershipTransfer();
        if (block.timestamp >= expiry) revert OwnershipTransferExpired();
        uint256 remaining = expiry - block.timestamp;
        if (remaining > 1 days) revert PokeTooEarly();
        // [L1] Rate-limit: one event per POKE_COOLDOWN regardless of caller.
        if (block.timestamp < lastPokeTime + POKE_COOLDOWN) revert PokeRateLimited();
        lastPokeTime = block.timestamp;
        emit OwnershipTransferExpiringIn(pendingOwner(), remaining);
    }
}
