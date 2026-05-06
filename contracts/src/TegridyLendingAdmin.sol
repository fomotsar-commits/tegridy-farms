// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @notice Minimal interface to TegridyLending used by the admin's apply hooks
///         and validation reads. Each `apply*` setter on lending is `onlyAdmin`.
interface ITegridyLendingApply {
    // ─── apply* setters (each `onlyAdmin` on the lending side) ────────
    function applyProtocolFeeChange(uint256 newFee) external;
    function applyTreasuryChange(address newTreasury) external;
    function applyMaxPrincipalChange(uint256 newCap) external;
    function applyMaxAprBpsChange(uint256 newCap) external;
    function applyMinDurationChange(uint256 newValue) external;
    function applyMaxDurationChange(uint256 newValue) external;
    function applyOriginationFeeChange(uint256 newBps) external;
    function applyMinAprChange(uint256 newBps) external;
    function applySweepDonatedToweli(uint256 amount, address to) external;
    function applyMinPrincipalChange(uint256 newValue) external;
    function applyAcceptedCollateralChange(address collateral, bool add) external;

    // ─── view-side reads required for validation ──────────────────────
    function MAX_PROTOCOL_FEE_BPS() external view returns (uint256);
    function MAX_PRINCIPAL_CEILING() external view returns (uint256);
    function MAX_APR_BPS_CEILING() external view returns (uint256);
    function MIN_DURATION_FLOOR() external view returns (uint256);
    function MIN_DURATION_CEILING() external view returns (uint256);
    function MAX_DURATION_CEILING() external view returns (uint256);
    function MAX_ORIGINATION_FEE_BPS() external view returns (uint256);
    function MAX_MIN_APR_BPS() external view returns (uint256);
    function MAX_MIN_PRINCIPAL() external view returns (uint256);
    function COLLATERAL_REMOVAL_MAX_CANCELLATIONS() external view returns (uint256);

    function protocolFeeBps() external view returns (uint256);
    function treasury() external view returns (address);
    function maxPrincipal() external view returns (uint256);
    function maxAprBps() external view returns (uint256);
    function minAprBps() external view returns (uint256);
    function minDuration() external view returns (uint256);
    function maxDuration() external view returns (uint256);
    function originationFeeBps() external view returns (uint256);
    function minPrincipal() external view returns (uint256);

    function activeLoansAgainstCollateral(address coll) external view returns (uint256);
    function collateralRemovalRetryCount(address coll) external view returns (uint256);
    function bumpCollateralRemovalRetryCount(address coll) external; // onlyAdmin
    function resetCollateralRemovalRetryCount(address coll) external; // onlyAdmin (called via apply path)
}

/// @title TegridyLendingAdmin — Sister contract holding timelocked admin flow
/// @notice Holds the propose/execute/cancel triplets and pending state for every
///         timelocked parameter on TegridyLending. Dispatches the actual writes
///         to TegridyLending via its `applyXxx` setters (onlyAdmin gated).
/// @dev    AUDIT FIX (pass-8): EIP170-01 — created during the Phase 0.1 split
///         to bring TegridyLending under the 24,576-byte EIP-170 limit. The
///         pre-fix bytecode was 28,177 bytes (3,601 over). Functional semantics
///         (delays, ceilings, validity windows, gates, cancel-rate limits) are
///         preserved; the only behavioural change is that the propose/execute/
///         cancel call sites now live on this sister contract. Mirrors the
///         exact pattern used for `SwapFeeRouterAdmin` in the 2026-04-26
///         size-reduction sprint.
contract TegridyLendingAdmin is OwnableNoRenounce, TimelockAdmin {
    // ─── Errors ───────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh();
    error InvalidCapValue();
    error OriginationFeeTooHigh();
    error MinAprTooHigh();
    error ActiveLoansPresent(address collateral, uint256 count);
    error RemovalCancelLimitReached();

    // ─── Timelock keys (mirror what TegridyLending previously held) ────
    bytes32 public constant PROTOCOL_FEE_CHANGE = keccak256("PROTOCOL_FEE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    bytes32 public constant MAX_PRINCIPAL_CHANGE = keccak256("LENDING_MAX_PRINCIPAL_CHANGE");
    bytes32 public constant MAX_APR_CHANGE = keccak256("LENDING_MAX_APR_CHANGE");
    bytes32 public constant MIN_DURATION_CHANGE = keccak256("LENDING_MIN_DURATION_CHANGE");
    bytes32 public constant MAX_DURATION_CHANGE = keccak256("LENDING_MAX_DURATION_CHANGE");
    bytes32 public constant ORIGINATION_FEE_CHANGE = keccak256("LENDING_ORIGINATION_FEE_CHANGE");
    bytes32 public constant MIN_APR_CHANGE = keccak256("LENDING_MIN_APR_CHANGE");
    bytes32 public constant MIN_PRINCIPAL_CHANGE = keccak256("LENDING_MIN_PRINCIPAL_CHANGE");
    bytes32 public constant ACCEPTED_COLLATERAL_CHANGE = keccak256("LENDING_ACCEPTED_COLLATERAL_CHANGE");
    bytes32 public constant SWEEP_DONATED_TOWELI = keccak256("LENDING_SWEEP_DONATED_TOWELI");

    // ─── Delays (mirror what TegridyLending previously enforced) ───────
    uint256 public constant PROTOCOL_FEE_TIMELOCK = 48 hours;
    uint256 public constant TREASURY_TIMELOCK = 48 hours;
    uint256 public constant CAP_CHANGE_TIMELOCK = 48 hours;

    // ─── Pending storage ──────────────────────────────────────────────
    uint256 public pendingProtocolFeeBps;
    address public pendingTreasury;
    uint256 public pendingMaxPrincipal;
    uint256 public pendingMaxAprBps;
    uint256 public pendingMinDuration;
    uint256 public pendingMaxDuration;
    uint256 public pendingOriginationFeeBps;
    uint256 public pendingMinAprBps;
    uint256 public pendingMinPrincipal;
    address public pendingAcceptedCollateral;
    bool public pendingAcceptedCollateralAdd;
    uint256 public pendingSweepAmount;
    address public pendingSweepTo;

    // ─── Wired lending contract ───────────────────────────────────────
    ITegridyLendingApply public immutable lending;

    // ─── Events (proposed/cancelled — "happened" events stay on lending) ─
    event ProtocolFeeChangeProposed(uint256 currentBps, uint256 proposedBps, uint256 readyAt);
    event ProtocolFeeChangeCancelled(uint256 cancelledBps);
    event TreasuryChangeProposed(address indexed current, address indexed proposed, uint256 readyAt);
    event TreasuryChangeCancelled(address indexed cancelled);
    event MaxPrincipalProposed(uint256 newCap, uint256 readyAt);
    event MaxAprBpsProposed(uint256 newCap, uint256 readyAt);
    event MinDurationProposed(uint256 newValue, uint256 readyAt);
    event MaxDurationProposed(uint256 newValue, uint256 readyAt);
    event OriginationFeeProposed(uint256 newBps, uint256 readyAt);
    event MinAprProposed(uint256 newBps, uint256 readyAt);
    event SweepDonatedToweliProposed(uint256 amount, address to, uint256 readyAt);
    event SweepDonatedToweliCancelled();
    event MinPrincipalProposed(uint256 newValue, uint256 readyAt);
    event AcceptedCollateralProposed(address indexed collateral, bool add, uint256 readyAt);
    event AcceptedCollateralCancelled(address indexed collateral, bool wasAdd);

    constructor(address _lending) OwnableNoRenounce(msg.sender) {
        if (_lending == address(0)) revert ZeroAddress();
        lending = ITegridyLendingApply(_lending);
    }

    // ─── Protocol fee ─────────────────────────────────────────────────
    function proposeProtocolFeeChange(uint256 _newFeeBps) external onlyOwner {
        if (_newFeeBps > lending.MAX_PROTOCOL_FEE_BPS()) revert FeeTooHigh();
        pendingProtocolFeeBps = _newFeeBps;
        _propose(PROTOCOL_FEE_CHANGE, PROTOCOL_FEE_TIMELOCK);
        emit ProtocolFeeChangeProposed(lending.protocolFeeBps(), _newFeeBps, _executeAfter[PROTOCOL_FEE_CHANGE]);
    }
    function executeProtocolFeeChange() external onlyOwner {
        _execute(PROTOCOL_FEE_CHANGE);
        uint256 v = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;
        lending.applyProtocolFeeChange(v);
    }
    function cancelProtocolFeeChange() external onlyOwner {
        _cancel(PROTOCOL_FEE_CHANGE);
        uint256 cancelled = pendingProtocolFeeBps;
        pendingProtocolFeeBps = 0;
        emit ProtocolFeeChangeCancelled(cancelled);
    }
    function protocolFeeChangeReadyAt() external view returns (uint256) {
        return _executeAfter[PROTOCOL_FEE_CHANGE];
    }

    // ─── Treasury ─────────────────────────────────────────────────────
    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_TIMELOCK);
        emit TreasuryChangeProposed(lending.treasury(), _newTreasury, _executeAfter[TREASURY_CHANGE]);
    }
    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address v = pendingTreasury;
        pendingTreasury = address(0);
        lending.applyTreasuryChange(v);
    }
    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }
    function treasuryChangeReadyAt() external view returns (uint256) {
        return _executeAfter[TREASURY_CHANGE];
    }

    // ─── Max principal ────────────────────────────────────────────────
    function proposeMaxPrincipal(uint256 _new) external onlyOwner {
        if (_new == 0) revert ZeroAmount();
        if (_new > lending.MAX_PRINCIPAL_CEILING()) revert InvalidCapValue();
        pendingMaxPrincipal = _new;
        _propose(MAX_PRINCIPAL_CHANGE, CAP_CHANGE_TIMELOCK);
        emit MaxPrincipalProposed(_new, _executeAfter[MAX_PRINCIPAL_CHANGE]);
    }
    function executeMaxPrincipal() external onlyOwner {
        _execute(MAX_PRINCIPAL_CHANGE);
        uint256 v = pendingMaxPrincipal;
        pendingMaxPrincipal = 0;
        lending.applyMaxPrincipalChange(v);
    }
    function cancelMaxPrincipal() external onlyOwner {
        _cancel(MAX_PRINCIPAL_CHANGE);
        pendingMaxPrincipal = 0;
    }
    function maxPrincipalChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MAX_PRINCIPAL_CHANGE];
    }

    // ─── Max APR bps ──────────────────────────────────────────────────
    function proposeMaxAprBps(uint256 _new) external onlyOwner {
        if (_new == 0) revert ZeroAmount();
        if (_new > lending.MAX_APR_BPS_CEILING()) revert InvalidCapValue();
        // AUDIT FIX: DEEP-LD-L4 — refuse `_new < minAprBps` to avoid bricking
        // createLoanOffer (every APR would simultaneously fail < min AND > max).
        if (_new < lending.minAprBps()) revert InvalidCapValue();
        pendingMaxAprBps = _new;
        _propose(MAX_APR_CHANGE, CAP_CHANGE_TIMELOCK);
        emit MaxAprBpsProposed(_new, _executeAfter[MAX_APR_CHANGE]);
    }
    function executeMaxAprBps() external onlyOwner {
        _execute(MAX_APR_CHANGE);
        uint256 v = pendingMaxAprBps;
        pendingMaxAprBps = 0;
        lending.applyMaxAprBpsChange(v);
    }
    function cancelMaxAprBps() external onlyOwner {
        _cancel(MAX_APR_CHANGE);
        pendingMaxAprBps = 0;
    }
    function maxAprBpsChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MAX_APR_CHANGE];
    }

    // ─── Min duration ─────────────────────────────────────────────────
    function proposeMinDuration(uint256 _new) external onlyOwner {
        if (_new < lending.MIN_DURATION_FLOOR() || _new > lending.MIN_DURATION_CEILING()) revert InvalidCapValue();
        if (_new >= lending.maxDuration()) revert InvalidCapValue();
        pendingMinDuration = _new;
        _propose(MIN_DURATION_CHANGE, CAP_CHANGE_TIMELOCK);
        emit MinDurationProposed(_new, _executeAfter[MIN_DURATION_CHANGE]);
    }
    function executeMinDuration() external onlyOwner {
        _execute(MIN_DURATION_CHANGE);
        uint256 v = pendingMinDuration;
        pendingMinDuration = 0;
        lending.applyMinDurationChange(v);
    }
    function cancelMinDuration() external onlyOwner {
        _cancel(MIN_DURATION_CHANGE);
        pendingMinDuration = 0;
    }
    function minDurationChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MIN_DURATION_CHANGE];
    }

    // ─── Max duration ─────────────────────────────────────────────────
    function proposeMaxDuration(uint256 _new) external onlyOwner {
        if (_new > lending.MAX_DURATION_CEILING()) revert InvalidCapValue();
        if (_new <= lending.minDuration()) revert InvalidCapValue();
        pendingMaxDuration = _new;
        _propose(MAX_DURATION_CHANGE, CAP_CHANGE_TIMELOCK);
        emit MaxDurationProposed(_new, _executeAfter[MAX_DURATION_CHANGE]);
    }
    function executeMaxDuration() external onlyOwner {
        _execute(MAX_DURATION_CHANGE);
        uint256 v = pendingMaxDuration;
        pendingMaxDuration = 0;
        lending.applyMaxDurationChange(v);
    }
    function cancelMaxDuration() external onlyOwner {
        _cancel(MAX_DURATION_CHANGE);
        pendingMaxDuration = 0;
    }
    function maxDurationChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MAX_DURATION_CHANGE];
    }

    // ─── Origination fee ──────────────────────────────────────────────
    function proposeOriginationFee(uint256 _newBps) external onlyOwner {
        if (_newBps > lending.MAX_ORIGINATION_FEE_BPS()) revert OriginationFeeTooHigh();
        pendingOriginationFeeBps = _newBps;
        _propose(ORIGINATION_FEE_CHANGE, CAP_CHANGE_TIMELOCK);
        emit OriginationFeeProposed(_newBps, _executeAfter[ORIGINATION_FEE_CHANGE]);
    }
    function executeOriginationFeeChange() external onlyOwner {
        _execute(ORIGINATION_FEE_CHANGE);
        uint256 v = pendingOriginationFeeBps;
        pendingOriginationFeeBps = 0;
        lending.applyOriginationFeeChange(v);
    }
    function cancelOriginationFeeChange() external onlyOwner {
        _cancel(ORIGINATION_FEE_CHANGE);
        pendingOriginationFeeBps = 0;
    }
    function originationFeeChangeReadyAt() external view returns (uint256) {
        return _executeAfter[ORIGINATION_FEE_CHANGE];
    }

    // ─── Min APR ──────────────────────────────────────────────────────
    function proposeMinApr(uint256 _newBps) external onlyOwner {
        if (_newBps > lending.MAX_MIN_APR_BPS()) revert MinAprTooHigh();
        // Don't allow min > max — would brick createLoanOffer.
        require(_newBps <= lending.maxAprBps(), "MIN_EXCEEDS_MAX");
        pendingMinAprBps = _newBps;
        _propose(MIN_APR_CHANGE, CAP_CHANGE_TIMELOCK);
        emit MinAprProposed(_newBps, _executeAfter[MIN_APR_CHANGE]);
    }
    function executeMinAprChange() external onlyOwner {
        _execute(MIN_APR_CHANGE);
        uint256 v = pendingMinAprBps;
        pendingMinAprBps = 0;
        lending.applyMinAprChange(v);
    }
    function cancelMinAprChange() external onlyOwner {
        _cancel(MIN_APR_CHANGE);
        pendingMinAprBps = 0;
    }
    function minAprChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MIN_APR_CHANGE];
    }

    // ─── Sweep donated TOWELI ─────────────────────────────────────────
    function proposeSweepDonatedToweli(uint256 _amount, address _to) external onlyOwner {
        if (_amount == 0) revert ZeroAmount();
        if (_to == address(0)) revert ZeroAddress();
        pendingSweepAmount = _amount;
        pendingSweepTo = _to;
        _propose(SWEEP_DONATED_TOWELI, CAP_CHANGE_TIMELOCK);
        emit SweepDonatedToweliProposed(_amount, _to, _executeAfter[SWEEP_DONATED_TOWELI]);
    }
    function executeSweepDonatedToweli() external onlyOwner {
        _execute(SWEEP_DONATED_TOWELI);
        uint256 amount = pendingSweepAmount;
        address to = pendingSweepTo;
        pendingSweepAmount = 0;
        pendingSweepTo = address(0);
        // Reservation guard + actual transfer happen inside lending.applySweepDonatedToweli
        // (which is `nonReentrant` on the lending side).
        lending.applySweepDonatedToweli(amount, to);
    }
    function cancelSweepDonatedToweli() external onlyOwner {
        _cancel(SWEEP_DONATED_TOWELI);
        pendingSweepAmount = 0;
        pendingSweepTo = address(0);
        emit SweepDonatedToweliCancelled();
    }
    function sweepDonatedToweliReadyAt() external view returns (uint256) {
        return _executeAfter[SWEEP_DONATED_TOWELI];
    }

    // ─── Min principal ────────────────────────────────────────────────
    function proposeMinPrincipal(uint256 _new) external onlyOwner {
        if (_new == 0) revert ZeroAmount();
        if (_new > lending.MAX_MIN_PRINCIPAL()) revert InvalidCapValue();
        pendingMinPrincipal = _new;
        _propose(MIN_PRINCIPAL_CHANGE, CAP_CHANGE_TIMELOCK);
        emit MinPrincipalProposed(_new, _executeAfter[MIN_PRINCIPAL_CHANGE]);
    }
    function executeMinPrincipalChange() external onlyOwner {
        _execute(MIN_PRINCIPAL_CHANGE);
        uint256 v = pendingMinPrincipal;
        pendingMinPrincipal = 0;
        lending.applyMinPrincipalChange(v);
    }
    function cancelMinPrincipalChange() external onlyOwner {
        _cancel(MIN_PRINCIPAL_CHANGE);
        pendingMinPrincipal = 0;
    }
    function minPrincipalChangeReadyAt() external view returns (uint256) {
        return _executeAfter[MIN_PRINCIPAL_CHANGE];
    }

    // ─── Accepted collateral whitelist ────────────────────────────────
    function proposeAcceptedCollateral(address _collateral, bool _add) external onlyOwner {
        if (_collateral == address(0)) revert ZeroAddress();
        pendingAcceptedCollateral = _collateral;
        pendingAcceptedCollateralAdd = _add;
        _propose(ACCEPTED_COLLATERAL_CHANGE, CAP_CHANGE_TIMELOCK);
        emit AcceptedCollateralProposed(_collateral, _add, _executeAfter[ACCEPTED_COLLATERAL_CHANGE]);
    }

    /// @dev AUDIT FIX preserved: LD3-M5 — pre-flight active-loan gate BEFORE `_execute`.
    ///      Reads `lending.activeLoansAgainstCollateral` so the pre-fix invariant
    ///      ("refuse removal while loans in flight, before consuming the proposal slot")
    ///      remains intact across the contract split.
    function executeAcceptedCollateral() external onlyOwner {
        address collateral = pendingAcceptedCollateral;
        bool add = pendingAcceptedCollateralAdd;
        if (!add) {
            uint256 active = lending.activeLoansAgainstCollateral(collateral);
            if (active > 0) revert ActiveLoansPresent(collateral, active);
        }
        _execute(ACCEPTED_COLLATERAL_CHANGE);
        pendingAcceptedCollateral = address(0);
        pendingAcceptedCollateralAdd = false;
        // The `applyAcceptedCollateralChange` setter on lending also resets the
        // collateralRemovalRetryCount on successful removal (preserving LD3-M3).
        lending.applyAcceptedCollateralChange(collateral, add);
    }

    /// @dev AUDIT FIX preserved: LD3-M3 — cancel-rate-limit on REMOVAL proposals
    ///      (only). FRESH-EYES L carve-out: only count toward the cancel budget
    ///      when cancelling a STILL-LIVE proposal.
    function cancelAcceptedCollateral() external onlyOwner {
        address cancelled = pendingAcceptedCollateral;
        bool wasRemoval = !pendingAcceptedCollateralAdd;
        if (wasRemoval && cancelled != address(0)) {
            uint256 readyAt = _executeAfter[ACCEPTED_COLLATERAL_CHANGE];
            bool stillLive = readyAt != 0 && block.timestamp <= readyAt + _proposalValidity();
            if (stillLive) {
                if (lending.collateralRemovalRetryCount(cancelled) >= lending.COLLATERAL_REMOVAL_MAX_CANCELLATIONS()) {
                    revert RemovalCancelLimitReached();
                }
                lending.bumpCollateralRemovalRetryCount(cancelled);
            }
        }
        _cancel(ACCEPTED_COLLATERAL_CHANGE);
        pendingAcceptedCollateral = address(0);
        pendingAcceptedCollateralAdd = false;
        emit AcceptedCollateralCancelled(cancelled, !wasRemoval);
    }

    function acceptedCollateralChangeReadyAt() external view returns (uint256) {
        return _executeAfter[ACCEPTED_COLLATERAL_CHANGE];
    }

    /// @notice Helper view used by TegridyLending.createOffer to short-circuit
    ///         offer creation if a removal proposal is pending against the
    ///         requested collateral. Replaces the pre-split direct read of
    ///         `_executeAfter[ACCEPTED_COLLATERAL_CHANGE] != 0` &&
    ///         `pendingAcceptedCollateral == collateral` &&
    ///         `!pendingAcceptedCollateralAdd`.
    function acceptedCollateralRemovalPending(address _collateral) external view returns (bool) {
        return _executeAfter[ACCEPTED_COLLATERAL_CHANGE] != 0
            && pendingAcceptedCollateral == _collateral
            && !pendingAcceptedCollateralAdd;
    }
}
