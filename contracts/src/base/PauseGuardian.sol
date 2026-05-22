// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  PauseGuardian — additive emergency-pause role distinct from owner
/// @notice Inspired by Aave V3's 5-of-9 Emergency Guardian and Lido's GateSeal.
///         The protocol owner (cold 4-of-7 multisig) holds Ownable role and can
///         pause AND unpause. The pause guardian (hot 3-of-5 multisig) can ONLY
///         pause — never unpause, never withdraw, never upgrade.
///
///         Threat model rationale:
///           - Cold owner multisig is slow on purpose: 4-of-7 cold-key signers
///             cannot react to an exploit-in-progress in time.
///           - Hot guardian is fast on purpose: 3-of-5 hot signers can pause in
///             minutes. Smaller blast radius if compromised (pause is recoverable
///             via owner's unpause; no funds at risk from the guardian alone).
///           - Owner is intentionally the strict superset of guardian's authority
///             so a compromised guardian can be re-set by the owner without an
///             upgrade.
///
///         Operational requirement: at deploy time, the guardian address MUST be
///         a multisig with a DISJOINT signer set from the owner multisig and the
///         treasury multisig. DeployMVP.s.sol asserts this address-level diversity
///         via the TREASURY / MULTISIG / PAUSE_GUARDIAN env-var disjoint check.
///
///         Pattern reference: Aave V3 EMERGENCY_ADMIN_ROLE (AccessControl.grantRole),
///         Lido GateSeal (limited-duration pause authority), MakerDAO ESM.
///
/// @dev    Mixin design: this contract carries the pauseGuardian state and the
///         `onlyPauseGuardian` modifier ONLY. It does not interact with OZ
///         Pausable directly — each consumer wires `guardianPause()` to its own
///         `_pause()` override. This keeps the change purely additive: existing
///         `pause()`/`unpause()` ownership semantics are untouched, the consumer
///         simply gains a second public entry-point that the guardian can call.
///
/// @dev    Owner can rotate the guardian instantly. The rationale is that if a
///         guardian's hot keys are compromised, the owner needs to be able to
///         react faster than any timelock would allow. The owner's own
///         rotation (acceptOwnership) is timelocked via OwnableNoRenounce, so
///         this asymmetry is intentional: guardian is faster to rotate than
///         owner. Compromising the guardian alone yields only nuisance-pause
///         risk (recoverable via owner.unpause), so a fast rotation is the
///         correct trade.
abstract contract PauseGuardian {
    /// @notice The pause-only emergency multisig. address(0) before deploy-time
    ///         wiring. Setter is owner-gated in each consumer contract.
    address public pauseGuardian;

    event PauseGuardianSet(address indexed oldGuardian, address indexed newGuardian);

    error NotPauseGuardian();
    error ZeroPauseGuardian();
    error PauseGuardianUnchanged();

    /// @dev Internal setter. Consumers expose an external `setPauseGuardian`
    ///      gated by their own `onlyOwner` modifier (cannot be defined here
    ///      because Ownable lives in the consumer's inheritance chain via
    ///      OwnableNoRenounce, which we deliberately do NOT depend on so the
    ///      lib stays usable by non-OZ contracts).
    function _setPauseGuardian(address _newGuardian) internal {
        if (_newGuardian == address(0)) revert ZeroPauseGuardian();
        address old = pauseGuardian;
        if (old == _newGuardian) revert PauseGuardianUnchanged();
        pauseGuardian = _newGuardian;
        emit PauseGuardianSet(old, _newGuardian);
    }

    /// @dev Used by consumers to gate the public `guardianPause()` entry-point.
    modifier onlyPauseGuardian() {
        if (msg.sender != pauseGuardian) revert NotPauseGuardian();
        _;
    }
}
