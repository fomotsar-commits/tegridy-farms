// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @title LPFarming — Stake LP tokens, earn TOWELI rewards
/// @notice Direct adaptation of Synthetix StakingRewards.sol — the most battle-tested
///         staking contract in DeFi, used by Curve, Sushi, Yearn, and hundreds of protocols.
///
///         Synthetix reward math (verbatim):
///           rewardPerToken += (elapsed × rewardRate × 1e18) / totalSupply
///           earned = balance × (rewardPerToken - userRewardPerTokenPaid) / 1e18 + rewards
///
///         Tegridy additions on top of Synthetix:
///           - OwnableNoRenounce (Ownable2Step, no renounce)
///           - TimelockAdmin (propose→execute→cancel for admin changes)
///           - Pausable (stake blocked when paused, withdraw/claim always allowed)
///           - emergencyWithdraw (MasterChef safety hatch — return LP, forfeit rewards)
///           - recoverERC20 (sweep accidentally sent tokens)
///
/// @dev Source: https://github.com/Synthetixio/synthetix/blob/develop/contracts/StakingRewards.sol
contract LPFarming is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Immutables ─────────────────────────────────────────────────
    IERC20 public immutable rewardToken;
    IERC20 public immutable stakingToken;

    // ─── Synthetix StakingRewards State ─────────────────────────────
    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public rewardsDuration;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    // ─── Tegridy Admin State ────────────────────────────────────────
    address public treasury;
    uint256 public totalRewardsFunded;

    // Timelocked pending values
    uint256 public pendingRewardsDuration;
    address public pendingTreasury;

    // ─── Constants ──────────────────────────────────────────────────
    uint256 public constant MAX_REWARDS_DURATION = 90 days;
    uint256 public constant MIN_REWARDS_DURATION = 1 days;
    uint256 public constant MIN_NOTIFY_AMOUNT = 1000e18;

    bytes32 public constant REWARDS_DURATION_CHANGE = keccak256("LP_REWARDS_DURATION_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("LP_TREASURY_CHANGE");

    uint256 public constant REWARDS_DURATION_TIMELOCK = 24 hours;
    uint256 public constant TREASURY_TIMELOCK = 48 hours;

    // ─── Events ─────────────────────────────────────────────────────
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event EmergencyWithdraw(address indexed user, uint256 amount, uint256 rewardsForfeited);
    event RewardAdded(uint256 reward);
    event RewardsDurationProposed(uint256 newDuration, uint256 executeAfter);
    event RewardsDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event RewardsDurationProposalCancelled(uint256 cancelledDuration);
    event TreasuryProposed(address newTreasury, uint256 executeAfter);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event TreasuryProposalCancelled(address cancelledTreasury);
    event Recovered(address token, uint256 amount);

    // ─── Errors ─────────────────────────────────────────────────────
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance();
    error RewardTooHigh();
    error DurationOutOfRange();
    error NotifyAmountTooSmall();
    error CannotRecoverStakingToken();
    error CannotRecoverRewardToken();
    error PreviousPeriodNotComplete();

    // ─── Constructor ────────────────────────────────────────────────
    constructor(
        address _rewardToken,
        address _stakingToken,
        address _treasury,
        uint256 _rewardsDuration
    ) OwnableNoRenounce(msg.sender) {
        if (_rewardToken == address(0)) revert ZeroAddress();
        if (_stakingToken == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_rewardsDuration < MIN_REWARDS_DURATION || _rewardsDuration > MAX_REWARDS_DURATION) {
            revert DurationOutOfRange();
        }

        if (_rewardToken == _stakingToken) revert CannotRecoverRewardToken();

        rewardToken = IERC20(_rewardToken);
        stakingToken = IERC20(_stakingToken);
        treasury = _treasury;
        rewardsDuration = _rewardsDuration;
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  SYNTHETIX STAKINGREWARDS — VERBATIM REWARD MATH           ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Accumulated reward per staked token (Synthetix formula)
    function rewardPerToken() public view returns (uint256) {
        if (_totalSupply == 0) {
            return rewardPerTokenStored;
        }
        return rewardPerTokenStored + (
            (lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18 / _totalSupply
        );
    }

    /// @notice Pending rewards for a user (Synthetix formula)
    function earned(address account) public view returns (uint256) {
        return (
            _balances[account] * (rewardPerToken() - userRewardPerTokenPaid[account]) / 1e18
        ) + rewards[account];
    }

    /// @notice Min of block.timestamp and periodFinish (Synthetix)
    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    /// @notice Remaining rewards for the current period
    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration;
    }

    /// @dev Synthetix updateReward modifier
    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  USER ACTIONS                                               ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Stake LP tokens to earn TOWELI rewards
    function stake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        _totalSupply += amount;
        _balances[msg.sender] += amount;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @notice Withdraw staked LP tokens (also harvests pending rewards)
    function withdraw(uint256 amount) external nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        if (amount > _balances[msg.sender]) revert InsufficientBalance();
        _totalSupply -= amount;
        _balances[msg.sender] -= amount;
        stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Claim pending TOWELI rewards
    function getReward() public nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    /// @notice Withdraw all + claim rewards (Synthetix convenience function)
    function exit() external nonReentrant updateReward(msg.sender) {
        uint256 amount = _balances[msg.sender];
        if (amount > 0) {
            _totalSupply -= amount;
            _balances[msg.sender] = 0;
            stakingToken.safeTransfer(msg.sender, amount);
            emit Withdrawn(msg.sender, amount);
        }
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    /// @notice Emergency withdraw — return LP tokens, forfeit ALL pending rewards
    /// @dev MasterChef safety hatch. No updateReward modifier. If reward math breaks,
    ///      users can always recover their principal.
    function emergencyWithdraw() external nonReentrant {
        uint256 amount = _balances[msg.sender];
        if (amount == 0) revert ZeroAmount();

        uint256 forfeited = earned(msg.sender);

        // Zero out user state (CEI)
        _totalSupply -= amount;
        _balances[msg.sender] = 0;
        rewards[msg.sender] = 0;
        userRewardPerTokenPaid[msg.sender] = rewardPerTokenStored;

        stakingToken.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, amount, forfeited);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  REWARD FUNDING (Synthetix notifyRewardAmount)              ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Fund rewards for the current/next period (Synthetix pattern)
    /// @dev Only owner can notify — matches canonical Synthetix StakingRewards pattern
    ///      where only the rewards distribution contract can notify.
    ///      If called before period ends, remaining rewards are rolled into the new period.
    function notifyRewardAmount(uint256 reward) external onlyOwner nonReentrant updateReward(address(0)) {
        if (reward < MIN_NOTIFY_AMOUNT) revert NotifyAmountTooSmall();

        // Transfer reward tokens in (SafeERC20 handles FoT-safe balance diff)
        uint256 balanceBefore = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), reward);
        uint256 actualReward = rewardToken.balanceOf(address(this)) - balanceBefore;

        // Synthetix reward rate calculation
        if (block.timestamp >= periodFinish) {
            rewardRate = actualReward / rewardsDuration;
        } else {
            uint256 remaining = periodFinish - block.timestamp;
            uint256 leftover = remaining * rewardRate;
            rewardRate = (leftover + actualReward) / rewardsDuration;
        }

        // Ensure the contract has enough tokens to pay the new rate
        uint256 balance = rewardToken.balanceOf(address(this));
        if (rewardRate > balance / rewardsDuration) revert RewardTooHigh();

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        totalRewardsFunded += actualReward;

        emit RewardAdded(actualReward);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  TIMELOCKED ADMIN                                           ║
    // ═══════════════════════════════════════════════════════════════

    // ─── Rewards Duration (24h timelock) ────────────────────────────

    function proposeRewardsDurationChange(uint256 _newDuration) external onlyOwner {
        if (_newDuration < MIN_REWARDS_DURATION || _newDuration > MAX_REWARDS_DURATION) {
            revert DurationOutOfRange();
        }
        if (block.timestamp < periodFinish) revert PreviousPeriodNotComplete();
        pendingRewardsDuration = _newDuration;
        _propose(REWARDS_DURATION_CHANGE, REWARDS_DURATION_TIMELOCK);
        emit RewardsDurationProposed(_newDuration, block.timestamp + REWARDS_DURATION_TIMELOCK);
    }

    function executeRewardsDurationChange() external onlyOwner {
        _execute(REWARDS_DURATION_CHANGE);
        uint256 old = rewardsDuration;
        rewardsDuration = pendingRewardsDuration;
        pendingRewardsDuration = 0;
        emit RewardsDurationUpdated(old, rewardsDuration);
    }

    function cancelRewardsDurationProposal() external onlyOwner {
        _cancel(REWARDS_DURATION_CHANGE);
        emit RewardsDurationProposalCancelled(pendingRewardsDuration);
        pendingRewardsDuration = 0;
    }

    // ─── Treasury (48h timelock) ────────────────────────────────────

    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_TIMELOCK);
        emit TreasuryProposed(_newTreasury, block.timestamp + TREASURY_TIMELOCK);
    }

    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address old = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryUpdated(old, treasury);
    }

    function cancelTreasuryProposal() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        emit TreasuryProposalCancelled(pendingTreasury);
        pendingTreasury = address(0);
    }

    // ─── Pause / Unpause ────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Recover accidentally sent tokens ───────────────────────────

    /// @notice Sweep tokens accidentally sent to this contract
    /// @dev Cannot recover stakingToken or rewardToken — protects user deposits and rewards
    function recoverERC20(address tokenAddress, uint256 tokenAmount) external onlyOwner {
        if (tokenAddress == address(stakingToken)) revert CannotRecoverStakingToken();
        if (tokenAddress == address(rewardToken)) revert CannotRecoverRewardToken();
        IERC20(tokenAddress).safeTransfer(treasury, tokenAmount);
        emit Recovered(tokenAddress, tokenAmount);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  VIEW HELPERS                                               ║
    // ═══════════════════════════════════════════════════════════════

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }
}
