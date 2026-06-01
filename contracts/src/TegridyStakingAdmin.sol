// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @notice Minimal interface to TegridyStaking for the admin's apply hooks.
///         Each `apply*` setter is `onlyAdmin` on the staking side.
interface ITegridyStakingApply {
    function applyRewardRate(uint256 _rate) external;
    function applyTreasury(address _treasury) external;
    function applyRestakingContract(address _restaking) external;
    function applyMaxUnsettledRewards(uint256 _cap) external;
    function applyLendingContract(address _lending, bool _approved) external;
    // NOTE: applyExtendFee / applyPenaltyRecycle / applyExtendFeeRecycle removed
    // with the extend-fee + penalty-recycle machinery (EIP-170 size on staking side).
    function MAX_REWARD_RATE() external view returns (uint256);
    // AUDIT FIX (pass-8 batch-14): BPS() and EXTEND_FEE_BPS_CEILING() removed
    // — both lowered to `internal` on staking to free auto-getter bytecode
    // under EIP-170. Admin-side checks hardcode the values.
    function rewardRate() external view returns (uint256);
    function treasury() external view returns (address);
    function restakingContract() external view returns (address);
    function maxUnsettledRewards() external view returns (uint256);
    // NOTE: extendFeeBps / penaltyRecycleBps / extendFeeRecycleBps getters removed
    // with the extend-fee + penalty-recycle machinery (EIP-170 size on staking side).
}

/// @title TegridyStakingAdmin — Sister contract holding timelocked admin flow
/// @notice Holds the propose/execute/cancel triplets and pending state for every
///         timelocked parameter on TegridyStaking. Dispatches the actual writes
///         to TegridyStaking via its `applyXxx` setters (onlyAdmin gated).
/// @dev    Created during the Wave-1 size-reduction sprint (2026-04-26) to bring
///         TegridyStaking under the 24,576-byte EIP-170 limit. Functional
///         semantics (delays, ceilings, validity windows) are unchanged.
/// @dev    AUDIT ADMIN-3 NAMING NOTE (2026-04-28): the legacy view helpers that
///         expose pending-execute timestamps use TWO naming conventions —
///         `*ChangeTime` for the older two (`rewardRateChangeTime`,
///         `treasuryChangeTime`) and `*ChangeReadyAt` for the newer ones
///         (restaking, lendingContract). The newer convention (`*ChangeReadyAt`) is the
///         intended forward style — it reads as "ready at this timestamp"
///         rather than the more ambiguous "change time". The older two are
///         retained for ABI compatibility with already-deployed test fixtures
///         and indexers; future helpers should prefer the `*ChangeReadyAt`
///         pattern. Renaming the legacy two would silently break consumers
///         and is intentionally NOT done.
contract TegridyStakingAdmin is OwnableNoRenounce, TimelockAdmin {
    // ─── Errors ───────────────────────────────────────────────────────
    error ZeroAddress();
    error RateTooHigh();
    error CapTooLow();
    /// @notice AUDIT FIX FRESH-2026: F-35-3 — sanity ceiling on maxUnsettledRewards.
    error CapTooHigh();
    // NOTE: ExtendFeeTooHigh / PenaltyRecycleTooHigh / ExtendFeeRecycleTooHigh
    // removed with the extend-fee + penalty-recycle flows (EIP-170 size on staking).
    /// @notice AUDIT FIX FRESH-2026: F-43-C / F-60-2 — proposed restaking address
    ///         is an EOA or EIP-7702 delegated EOA (code.length == 0 or 23).
    error NotAContract();

    // ─── Timelock keys ────────────────────────────────────────────────
    bytes32 public constant REWARD_RATE_CHANGE = keccak256("REWARD_RATE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    bytes32 public constant RESTAKING_CHANGE = keccak256("RESTAKING_CHANGE");
    bytes32 public constant UNSETTLED_CAP_CHANGE = keccak256("UNSETTLED_CAP_CHANGE");
    bytes32 public constant LENDING_CONTRACT_CHANGE = keccak256("LENDING_CONTRACT_CHANGE");
    // NOTE: EXTEND_FEE_CHANGE / PENALTY_RECYCLE_CHANGE / EXTEND_FEE_RECYCLE_CHANGE
    // keys removed with the extend-fee + penalty-recycle flows (EIP-170 size).

    // ─── Delays (mirror what TegridyStaking previously enforced) ──────
    uint256 public constant REWARD_RATE_TIMELOCK = 48 hours;
    uint256 public constant TREASURY_CHANGE_TIMELOCK = 48 hours;
    uint256 public constant RESTAKING_CHANGE_TIMELOCK = 48 hours;
    uint256 public constant UNSETTLED_CAP_TIMELOCK = 48 hours;
    uint256 public constant LENDING_CONTRACT_CHANGE_TIMELOCK = 48 hours;
    // NOTE: EXTEND_FEE_TIMELOCK / PENALTY_RECYCLE_TIMELOCK / EXTEND_FEE_RECYCLE_TIMELOCK
    // removed with the extend-fee + penalty-recycle flows (EIP-170 size).

    // ─── Pending storage ──────────────────────────────────────────────
    uint256 public pendingRewardRate;
    address public pendingTreasury;
    address public pendingRestakingContract;
    uint256 public pendingMaxUnsettledRewards;
    address public pendingLendingContract;
    bool public pendingLendingContractApproval;
    // NOTE: pendingExtendFeeBps / pendingPenaltyRecycleBps / pendingExtendFeeRecycleBps
    // removed with the extend-fee + penalty-recycle flows (EIP-170 size).

    // ─── Wired staking ────────────────────────────────────────────────
    ITegridyStakingApply public immutable staking;

    // ─── Events ───────────────────────────────────────────────────────
    event RewardRateProposed(uint256 newRate, uint256 executeAfter);
    event RewardRateExecuted(uint256 newRate);
    event TreasuryChangeProposed(address newTreasury, uint256 executeAfter);
    event TreasuryChangeExecuted(address oldTreasury, address newTreasury);
    event RestakingContractChangeProposed(address newRestaking, uint256 executeAfter);
    event RestakingContractChanged(address oldRestaking, address newRestaking);
    event LendingContractChangeProposed(address indexed lending, bool approved, uint256 executeAfter);
    event LendingContractUpdated(address indexed lending, bool approved);
    event MaxUnsettledRewardsUpdated(uint256 oldCap, uint256 newCap);
    // NOTE: ExtendFeeProposed/Updated, PenaltyRecycleProposed/Updated, and
    // ExtendFeeRecycleProposed/Updated events removed with the extend-fee +
    // penalty-recycle flows (EIP-170 size on staking side).
    /// @notice AUDIT ADMIN-1 (2026-04-28): event-parity fix — `proposeMaxUnsettledRewards`
    ///         was the only `propose*` function not emitting a typed proposal event.
    event MaxUnsettledRewardsProposed(uint256 newCap, uint256 executeAfter);

    constructor(address _staking) OwnableNoRenounce(msg.sender) {
        if (_staking == address(0)) revert ZeroAddress();
        staking = ITegridyStakingApply(_staking);
    }

    // ─── Reward rate ──────────────────────────────────────────────────
    function proposeRewardRate(uint256 _rate) external onlyOwner {
        if (_rate > staking.MAX_REWARD_RATE()) revert RateTooHigh();
        pendingRewardRate = _rate;
        _propose(REWARD_RATE_CHANGE, REWARD_RATE_TIMELOCK);
        emit RewardRateProposed(_rate, _executeAfter[REWARD_RATE_CHANGE]);
    }

    function executeRewardRateChange() external onlyOwner {
        _execute(REWARD_RATE_CHANGE);
        uint256 r = pendingRewardRate;
        pendingRewardRate = 0;
        staking.applyRewardRate(r);
        emit RewardRateExecuted(r);
    }

    function cancelRewardRateProposal() external onlyOwner {
        _cancel(REWARD_RATE_CHANGE);
        pendingRewardRate = 0;
    }

    function rewardRateChangeTime() external view returns (uint256) {
        return _executeAfter[REWARD_RATE_CHANGE];
    }

    // ─── Treasury ─────────────────────────────────────────────────────
    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_TIMELOCK);
        emit TreasuryChangeProposed(_newTreasury, _executeAfter[TREASURY_CHANGE]);
    }

    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address oldT = staking.treasury();
        address newT = pendingTreasury;
        pendingTreasury = address(0);
        staking.applyTreasury(newT);
        emit TreasuryChangeExecuted(oldT, newT);
    }

    function cancelTreasuryProposal() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        pendingTreasury = address(0);
    }

    function treasuryChangeTime() external view returns (uint256) {
        return _executeAfter[TREASURY_CHANGE];
    }

    // ─── Restaking contract ───────────────────────────────────────────
    function proposeRestakingContract(address _restaking) external onlyOwner {
        if (_restaking == address(0)) revert ZeroAddress();
        // AUDIT FIX FRESH-2026: F-43-C + F-60-2 — reject EOA / EIP-7702 delegated
        // EOAs at propose time. Mirrors TegridyStaking.setStakingAdmin /
        // proposeAdminReplacement contract-only enforcement.
        // AUDIT FIX 2026-05-26 [L-25] — Type-filter only (rejects EOAs and 7702-delegated
        // EOAs); NOT a capability check. Operator MUST verify the proposed restaking
        // contract implements ITegridyRestakingView (consumed by TegridyStaking for
        // depositor lookups in getReward / revalidateBoost / toggleAutoMaxLock /
        // extendLock JBAC re-validation paths).
        uint256 codeLen = _restaking.code.length;
        if (codeLen == 0 || codeLen == 23) revert NotAContract();
        pendingRestakingContract = _restaking;
        _propose(RESTAKING_CHANGE, RESTAKING_CHANGE_TIMELOCK);
        emit RestakingContractChangeProposed(_restaking, _executeAfter[RESTAKING_CHANGE]);
    }

    function executeRestakingContract() external onlyOwner {
        _execute(RESTAKING_CHANGE);
        address oldR = staking.restakingContract();
        address newR = pendingRestakingContract;
        pendingRestakingContract = address(0);
        staking.applyRestakingContract(newR);
        emit RestakingContractChanged(oldR, newR);
    }

    function cancelRestakingContract() external onlyOwner {
        _cancel(RESTAKING_CHANGE);
        pendingRestakingContract = address(0);
    }

    function restakingChangeReadyAt() external view returns (uint256) {
        return _executeAfter[RESTAKING_CHANGE];
    }

    // ─── Max unsettled rewards ────────────────────────────────────────
    /// @notice AUDIT FIX FRESH-2026: F-35-3 — sanity ceiling shared with staking-side.
    uint256 public constant MAX_MAX_UNSETTLED = 1e10 ether;

    function proposeMaxUnsettledRewards(uint256 _newCap) external onlyOwner {
        if (_newCap < 10_000e18) revert CapTooLow();
        // AUDIT FIX FRESH-2026: F-35-3 — fail-fast at propose time so the 48h
        // wait isn't burned on a doomed proposal. Mirrors the staking-side guard.
        if (_newCap > MAX_MAX_UNSETTLED) revert CapTooHigh();
        pendingMaxUnsettledRewards = _newCap;
        _propose(UNSETTLED_CAP_CHANGE, UNSETTLED_CAP_TIMELOCK);
        // AUDIT ADMIN-1 (2026-04-28): emit proposal event for parity with sister proposers.
        emit MaxUnsettledRewardsProposed(_newCap, _executeAfter[UNSETTLED_CAP_CHANGE]);
    }

    function executeMaxUnsettledRewards() external onlyOwner {
        _execute(UNSETTLED_CAP_CHANGE);
        uint256 oldCap = staking.maxUnsettledRewards();
        uint256 newCap = pendingMaxUnsettledRewards;
        pendingMaxUnsettledRewards = 0;
        staking.applyMaxUnsettledRewards(newCap);
        emit MaxUnsettledRewardsUpdated(oldCap, newCap);
    }

    function cancelMaxUnsettledRewards() external onlyOwner {
        _cancel(UNSETTLED_CAP_CHANGE);
        pendingMaxUnsettledRewards = 0;
    }

    // ─── Lending contract whitelist ───────────────────────────────────
    function proposeLendingContract(address _lending, bool _approved) external onlyOwner {
        if (_lending == address(0)) revert ZeroAddress();
        pendingLendingContract = _lending;
        pendingLendingContractApproval = _approved;
        _propose(LENDING_CONTRACT_CHANGE, LENDING_CONTRACT_CHANGE_TIMELOCK);
        emit LendingContractChangeProposed(_lending, _approved, _executeAfter[LENDING_CONTRACT_CHANGE]);
    }

    function executeLendingContract() external onlyOwner {
        _execute(LENDING_CONTRACT_CHANGE);
        address lending = pendingLendingContract;
        bool approved = pendingLendingContractApproval;
        pendingLendingContract = address(0);
        pendingLendingContractApproval = false;
        staking.applyLendingContract(lending, approved);
        emit LendingContractUpdated(lending, approved);
    }

    function cancelLendingContract() external onlyOwner {
        _cancel(LENDING_CONTRACT_CHANGE);
        pendingLendingContract = address(0);
        pendingLendingContractApproval = false;
    }

    function lendingContractChangeReadyAt() external view returns (uint256) {
        return _executeAfter[LENDING_CONTRACT_CHANGE];
    }

    // ─── REMOVED for EIP-170 size (deferred to a later version) ──────────
    // The extend-fee, penalty-recycle, and extend-fee-recycle propose/execute/
    // cancel/readyAt flows were removed alongside the matching machinery on
    // TegridyStaking (all governing bps defaulted to 0, so they were dormant at
    // launch and removal is behaviour-identical to the launch config).

    /// @notice AUDIT FIX 2026-05-21 M19-PORT: override `acceptOwnership` so that any
    ///         pending proposals queued by the outgoing owner are CANCELLED on handoff.
    ///         Mirrors `TegridyLaunchpadV2.acceptOwnership` (TegridyLaunchpadV2.sol:426-438).
    ///         Without this override, an outgoing/compromised owner could queue hostile
    ///         proposals immediately before `transferOwnership`; the timelock would silently
    ///         keep running and the new owner inherits an executable booby-trap.
    /// @dev    Calls `super.acceptOwnership()` first so the Ownable2Step pendingOwner→owner
    ///         promotion happens before the cancellations. Base `ProposalCancelled(KEY)`
    ///         events from `_cancel` provide the audit trail (this contract has no typed
    ///         per-key cancellation events — base event is sufficient).
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[REWARD_RATE_CHANGE] != 0) {
            _cancel(REWARD_RATE_CHANGE);
            pendingRewardRate = 0;
        }
        if (_executeAfter[TREASURY_CHANGE] != 0) {
            _cancel(TREASURY_CHANGE);
            pendingTreasury = address(0);
        }
        if (_executeAfter[RESTAKING_CHANGE] != 0) {
            _cancel(RESTAKING_CHANGE);
            pendingRestakingContract = address(0);
        }
        if (_executeAfter[UNSETTLED_CAP_CHANGE] != 0) {
            _cancel(UNSETTLED_CAP_CHANGE);
            pendingMaxUnsettledRewards = 0;
        }
        if (_executeAfter[LENDING_CONTRACT_CHANGE] != 0) {
            _cancel(LENDING_CONTRACT_CHANGE);
            pendingLendingContract = address(0);
            pendingLendingContractApproval = false;
        }
        // NOTE: EXTEND_FEE_CHANGE / PENALTY_RECYCLE_CHANGE / EXTEND_FEE_RECYCLE_CHANGE
        // cancel-on-handoff blocks removed with those flows (EIP-170 size).
    }
}
