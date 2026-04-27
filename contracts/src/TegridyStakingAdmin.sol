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
    function applyExtendFee(uint256 _bps) external;
    function applyPenaltyRecycle(uint256 _bps) external;
    function MAX_REWARD_RATE() external view returns (uint256);
    function EXTEND_FEE_BPS_CEILING() external view returns (uint256);
    function rewardRate() external view returns (uint256);
    function treasury() external view returns (address);
    function restakingContract() external view returns (address);
    function maxUnsettledRewards() external view returns (uint256);
    function extendFeeBps() external view returns (uint256);
    function penaltyRecycleBps() external view returns (uint256);
}

/// @title TegridyStakingAdmin — Sister contract holding timelocked admin flow
/// @notice Holds the propose/execute/cancel triplets and pending state for every
///         timelocked parameter on TegridyStaking. Dispatches the actual writes
///         to TegridyStaking via its `applyXxx` setters (onlyAdmin gated).
/// @dev    Created during the Wave-1 size-reduction sprint (2026-04-26) to bring
///         TegridyStaking under the 24,576-byte EIP-170 limit. Functional
///         semantics (delays, ceilings, validity windows) are unchanged.
contract TegridyStakingAdmin is OwnableNoRenounce, TimelockAdmin {
    // ─── Errors ───────────────────────────────────────────────────────
    error ZeroAddress();
    error RateTooHigh();
    error CapTooLow();
    error ExtendFeeTooHigh();
    error PenaltyRecycleTooHigh();

    // ─── Timelock keys ────────────────────────────────────────────────
    bytes32 public constant REWARD_RATE_CHANGE = keccak256("REWARD_RATE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    bytes32 public constant RESTAKING_CHANGE = keccak256("RESTAKING_CHANGE");
    bytes32 public constant UNSETTLED_CAP_CHANGE = keccak256("UNSETTLED_CAP_CHANGE");
    bytes32 public constant LENDING_CONTRACT_CHANGE = keccak256("LENDING_CONTRACT_CHANGE");
    bytes32 public constant EXTEND_FEE_CHANGE = keccak256("EXTEND_FEE_CHANGE");
    bytes32 public constant PENALTY_RECYCLE_CHANGE = keccak256("PENALTY_RECYCLE_CHANGE");

    // ─── Delays (mirror what TegridyStaking previously enforced) ──────
    uint256 public constant REWARD_RATE_TIMELOCK = 48 hours;
    uint256 public constant TREASURY_CHANGE_TIMELOCK = 48 hours;
    uint256 public constant RESTAKING_CHANGE_TIMELOCK = 48 hours;
    uint256 public constant UNSETTLED_CAP_TIMELOCK = 48 hours;
    uint256 public constant LENDING_CONTRACT_CHANGE_TIMELOCK = 48 hours;
    uint256 public constant EXTEND_FEE_TIMELOCK = 48 hours;
    uint256 public constant PENALTY_RECYCLE_TIMELOCK = 48 hours;

    // ─── Pending storage ──────────────────────────────────────────────
    uint256 public pendingRewardRate;
    address public pendingTreasury;
    address public pendingRestakingContract;
    uint256 public pendingMaxUnsettledRewards;
    address public pendingLendingContract;
    bool public pendingLendingContractApproval;
    uint256 public pendingExtendFeeBps;
    uint256 public pendingPenaltyRecycleBps;

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
    event ExtendFeeProposed(uint256 newBps, uint256 executeAfter);
    event ExtendFeeUpdated(uint256 oldBps, uint256 newBps);
    event PenaltyRecycleProposed(uint256 newBps, uint256 executeAfter);
    event PenaltyRecycleUpdated(uint256 oldBps, uint256 newBps);

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
    function proposeMaxUnsettledRewards(uint256 _newCap) external onlyOwner {
        if (_newCap < 10_000e18) revert CapTooLow();
        pendingMaxUnsettledRewards = _newCap;
        _propose(UNSETTLED_CAP_CHANGE, UNSETTLED_CAP_TIMELOCK);
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

    // ─── Extend fee ───────────────────────────────────────────────────
    function proposeExtendFee(uint256 _newBps) external onlyOwner {
        if (_newBps > staking.EXTEND_FEE_BPS_CEILING()) revert ExtendFeeTooHigh();
        pendingExtendFeeBps = _newBps;
        _propose(EXTEND_FEE_CHANGE, EXTEND_FEE_TIMELOCK);
        emit ExtendFeeProposed(_newBps, _executeAfter[EXTEND_FEE_CHANGE]);
    }

    function executeExtendFeeChange() external onlyOwner {
        _execute(EXTEND_FEE_CHANGE);
        uint256 oldBps = staking.extendFeeBps();
        uint256 newBps = pendingExtendFeeBps;
        pendingExtendFeeBps = 0;
        staking.applyExtendFee(newBps);
        emit ExtendFeeUpdated(oldBps, newBps);
    }

    function cancelExtendFeeChange() external onlyOwner {
        _cancel(EXTEND_FEE_CHANGE);
        pendingExtendFeeBps = 0;
    }

    function extendFeeChangeReadyAt() external view returns (uint256) {
        return _executeAfter[EXTEND_FEE_CHANGE];
    }

    // ─── Penalty recycle ──────────────────────────────────────────────
    function proposePenaltyRecycle(uint256 _newBps) external onlyOwner {
        if (_newBps > 10_000) revert PenaltyRecycleTooHigh();
        pendingPenaltyRecycleBps = _newBps;
        _propose(PENALTY_RECYCLE_CHANGE, PENALTY_RECYCLE_TIMELOCK);
        emit PenaltyRecycleProposed(_newBps, _executeAfter[PENALTY_RECYCLE_CHANGE]);
    }

    function executePenaltyRecycleChange() external onlyOwner {
        _execute(PENALTY_RECYCLE_CHANGE);
        uint256 oldBps = staking.penaltyRecycleBps();
        uint256 newBps = pendingPenaltyRecycleBps;
        pendingPenaltyRecycleBps = 0;
        staking.applyPenaltyRecycle(newBps);
        emit PenaltyRecycleUpdated(oldBps, newBps);
    }

    function cancelPenaltyRecycleChange() external onlyOwner {
        _cancel(PENALTY_RECYCLE_CHANGE);
        pendingPenaltyRecycleBps = 0;
    }

    function penaltyRecycleChangeReadyAt() external view returns (uint256) {
        return _executeAfter[PENALTY_RECYCLE_CHANGE];
    }
}
