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
        require(initialOwner != address(0), "ZERO_OWNER");
        // AUDIT FIX: DEEP-LIB-M1 — opt-in contract enforcement at deploy.
        // Pure-EOA owners are the single largest single-key-compromise risk
        // in the protocol; subclasses that ALWAYS deploy behind a multisig
        // (e.g. mainnet-only governance contracts) opt in by overriding
        // `_ownerMustBeContract` to true. The check is gated on the override
        // return value so default-false consumers are not affected.
        // Note: OZ's Ownable constructor already calls `_transferOwnership`
        // which routes through our override below — but constructor-time
        // `super._transferOwnership` runs BEFORE our body executes, so we
        // also enforce here for defense-in-depth on the initial owner.
        if (_ownerMustBeContract() && initialOwner.code.length == 0) {
            revert OwnerNotContract(initialOwner);
        }
    }

    /// @notice Disabled. Cannot renounce ownership.
    /// @dev    AUDIT FIX: DEEP-LIB-L2 — declared `view` (was `pure`) so future
    ///         subclasses can override with state reads (e.g. emitting an
    ///         `OwnershipRenounceAttempted` telemetry event for compromised-key
    ///         detection). Behaviour is unchanged: every call still reverts.
    function renounceOwnership() public view override {
        revert("RENOUNCE_DISABLED");
    }

    /// @dev AUDIT FIX: DEEP-LIB-M1 — re-applies the contract-only enforcement
    ///      on every ownership rotation when the subclass has opted in. A
    ///      compromised owner cannot then `transferOwnership(new_eoa)` then
    ///      `new_eoa.acceptOwnership()` to escape multisig containment.
    ///      OZ Ownable2Step calls `_transferOwnership` from `acceptOwnership`,
    ///      so this guard catches both initial transfer and rotation. We
    ///      explicitly allow `address(0)` to flow through `super` so OZ's
    ///      internal book-keeping (e.g. `delete _pendingOwner` on accept)
    ///      isn't broken by our additional guard.
    function _transferOwnership(address newOwner) internal virtual override {
        if (_ownerMustBeContract() && newOwner != address(0) && newOwner.code.length == 0) {
            revert OwnerNotContract(newOwner);
        }
        super._transferOwnership(newOwner);
    }
}
