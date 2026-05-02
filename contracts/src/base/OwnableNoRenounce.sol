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
        revert("RENOUNCE_DISABLED");
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
        if (_ownerMustBeContract() && newOwner.code.length == 0) {
            revert OwnerNotContract(newOwner);
        }
        super._transferOwnership(newOwner);
    }
}
