// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @dev Minimal interface for TegridyStaking boost queries.
/// @dev Audit C-01 (Spartan TF-01): struct field order MUST match TegridyStaking.Position
///      exactly. Solidity ABI-decodes return tuples by position, not by name — a mismatch
///      silently reads the wrong slot and was historically exploitable (rewardDebt was
///      being decoded into boostBps, giving unbounded boost). The canonical order in
///      TegridyStaking.sol:86-95 is:
///        uint256 amount
///        uint256 boostedAmount
///        int256  rewardDebt
///        uint64  lockEnd
///        uint16  boostBps
///        uint32  lockDuration
///        bool    autoMaxLock
///        bool    hasJbacBoost
///        uint64  stakeTimestamp
interface ITegridyStakingBoost {
    function userTokenId(address user) external view returns (uint256);
    function positions(uint256 tokenId) external view returns (
        uint256 amount,
        uint256 boostedAmount,
        int256 rewardDebt,
        uint64 lockEnd,
        uint16 boostBps,
        uint32 lockDuration,
        bool autoMaxLock,
        bool hasJbacBoost,
        uint64 stakeTimestamp
    );
}

/// @title TegridyLPFarming — Boosted Synthetix-style LP staking with TegridyStaking integration
/// @notice Users deposit Uniswap V2 LP tokens to earn TOWELI rewards. If the user holds a
///         TegridyStaking NFT position, their effective balance is boosted using the staking
///         contract's boostBps (0.4x-4.0x), amplifying reward earnings.
///
///         Core reward math (Synthetix StakingRewards):
///           rewardPerToken += (elapsed * rewardRate * 1e18) / totalEffectiveSupply
///           earned = effectiveBalance * (rewardPerToken - userPaid) / 1e18 + rewards
///
/// @dev Source: Synthetix StakingRewards + Curve boosted farming pattern.
contract TegridyLPFarming is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────────────────────
    uint256 public constant MAX_REWARD_RATE = 100e18;       // Cap: 100 TOWELI/sec
    uint256 public constant MAX_REWARDS_DURATION = 90 days;
    uint256 public constant MIN_REWARDS_DURATION = 1 days;
    uint256 public constant MIN_NOTIFY_AMOUNT = 1000e18;
    uint256 public constant BOOST_PRECISION = 10000;        // Matches TegridyStaking BPS
    uint256 public constant BASE_BOOST_BPS = 10000;         // 1.0x — no boost baseline
    /// @dev Audit C-01 defence-in-depth: cap boost at 4.5x (MAX_BOOST 40000 + JBAC bonus
    /// ceiling). Even if the interface is ever re-mis-aligned against TegridyStaking's
    /// Position struct in a future upgrade, this cap prevents unbounded reward capture.
    uint256 public constant MAX_BOOST_BPS_CEILING = 45000;

    bytes32 public constant REWARDS_DURATION_CHANGE = keccak256("BOOSTED_LP_REWARDS_DURATION");
    bytes32 public constant TREASURY_CHANGE = keccak256("BOOSTED_LP_TREASURY");
    uint256 public constant REWARDS_DURATION_TIMELOCK = 24 hours;
    uint256 public constant TREASURY_TIMELOCK = 48 hours;

    // ─── Immutables ─────────────────────────────────────────────────
    IERC20 public immutable rewardToken;
    IERC20 public immutable stakingToken;
    ITegridyStakingBoost public immutable tegridyStaking;

    // ─── Synthetix State ────────────────────────────────────────────
    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public rewardsDuration;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    uint256 public totalRawSupply;       // Sum of actual LP deposited
    uint256 public totalEffectiveSupply; // Sum of boosted balances (used for reward math)

    mapping(address => uint256) public rawBalanceOf;       // Actual LP deposited
    mapping(address => uint256) public effectiveBalanceOf; // Boosted balance

    // ─── Admin State ────────────────────────────────────────────────
    address public treasury;
    uint256 public totalRewardsFunded;
    uint256 public pendingRewardsDuration;
    address public pendingTreasury;

    // ─── Events ─────────────────────────────────────────────────────
    event Staked(address indexed user, uint256 amount, uint256 effectiveAmount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event EmergencyWithdraw(address indexed user, uint256 amount, uint256 rewardsForfeited);
    event RewardAdded(uint256 reward, uint256 duration);
    event BoostUpdated(address indexed user, uint256 oldEffective, uint256 newEffective);
    event RewardsDurationProposed(uint256 newDuration, uint256 executeAfter);
    event RewardsDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event TreasuryProposed(address newTreasury, uint256 executeAfter);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event Recovered(address token, uint256 amount);

    // ─── Errors ─────────────────────────────────────────────────────
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance();
    error RewardRateExceedsCap();
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
        address _tegridyStaking,
        address _treasury,
        uint256 _rewardsDuration
    ) OwnableNoRenounce(msg.sender) {
        if (_rewardToken == address(0) || _stakingToken == address(0)) revert ZeroAddress();
        if (_tegridyStaking == address(0) || _treasury == address(0)) revert ZeroAddress();
        if (_rewardsDuration < MIN_REWARDS_DURATION || _rewardsDuration > MAX_REWARDS_DURATION) {
            revert DurationOutOfRange();
        }

        rewardToken = IERC20(_rewardToken);
        stakingToken = IERC20(_stakingToken);
        tegridyStaking = ITegridyStakingBoost(_tegridyStaking);
        treasury = _treasury;
        rewardsDuration = _rewardsDuration;
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  SYNTHETIX REWARD MATH (boosted)                            ║
    // ═══════════════════════════════════════════════════════════════

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalEffectiveSupply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + (
            (lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18 / totalEffectiveSupply
        );
    }

    /// @notice Pending rewards for an account (Synthetix formula over boosted balance)
    function earned(address account) public view returns (uint256) {
        return (
            effectiveBalanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account]) / 1e18
        ) + rewards[account];
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  BOOST HELPERS                                              ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Compute the effective (boosted) balance for a user given their raw LP amount.
    /// @dev If the user has an active TegridyStaking position, applies boostBps / BOOST_PRECISION.
    ///      Otherwise, uses BASE_BOOST_BPS (1.0x).
    function _getEffectiveBalance(address user, uint256 rawAmount) internal view returns (uint256) {
        uint256 boostBps = BASE_BOOST_BPS;
        uint256 tokenId = tegridyStaking.userTokenId(user);
        if (tokenId != 0) {
            // Audit C-01: destructure matches TegridyStaking.Position struct order exactly.
            // We only need `amount`, `lockEnd`, and `boostBps` — ignore the rest.
            (uint256 amt,, , uint64 lockEnd, uint16 bps,,,,) = tegridyStaking.positions(tokenId);
            // Only apply boost if the staking position is active (has amount and lock not expired)
            if (amt > 0 && block.timestamp < lockEnd && bps > BASE_BOOST_BPS) {
                // Defence-in-depth: clamp to the ceiling before applying.
                boostBps = bps > MAX_BOOST_BPS_CEILING ? MAX_BOOST_BPS_CEILING : bps;
            }
        }
        return (rawAmount * boostBps) / BOOST_PRECISION;
    }

    /// @notice Refresh a user's effective balance (call after staking NFT changes)
    function refreshBoost(address account) external nonReentrant updateReward(account) {
        uint256 raw = rawBalanceOf[account];
        if (raw == 0) return;
        uint256 oldEffective = effectiveBalanceOf[account];
        uint256 newEffective = _getEffectiveBalance(account, raw);
        if (oldEffective != newEffective) {
            totalEffectiveSupply = totalEffectiveSupply - oldEffective + newEffective;
            effectiveBalanceOf[account] = newEffective;
            emit BoostUpdated(account, oldEffective, newEffective);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  USER ACTIONS                                               ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Stake LP tokens to earn boosted TOWELI rewards
    function stake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        uint256 effective = _getEffectiveBalance(msg.sender, amount);
        rawBalanceOf[msg.sender] += amount;
        effectiveBalanceOf[msg.sender] += effective;
        totalRawSupply += amount;
        totalEffectiveSupply += effective;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, effective);
    }

    /// @notice Withdraw staked LP tokens
    function withdraw(uint256 amount) external nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        if (amount > rawBalanceOf[msg.sender]) revert InsufficientBalance();
        // Proportionally reduce effective balance
        uint256 effectiveReduction = (effectiveBalanceOf[msg.sender] * amount) / rawBalanceOf[msg.sender];
        rawBalanceOf[msg.sender] -= amount;
        effectiveBalanceOf[msg.sender] -= effectiveReduction;
        totalRawSupply -= amount;
        totalEffectiveSupply -= effectiveReduction;
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

    /// @notice Emergency withdraw — return LP tokens, forfeit ALL pending rewards
    function emergencyWithdraw() external nonReentrant {
        uint256 amount = rawBalanceOf[msg.sender];
        if (amount == 0) revert ZeroAmount();
        uint256 forfeited = earned(msg.sender);
        uint256 effective = effectiveBalanceOf[msg.sender];

        // Zero out user state (CEI)
        totalRawSupply -= amount;
        totalEffectiveSupply -= effective;
        rawBalanceOf[msg.sender] = 0;
        effectiveBalanceOf[msg.sender] = 0;
        rewards[msg.sender] = 0;
        userRewardPerTokenPaid[msg.sender] = rewardPerTokenStored;

        stakingToken.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, amount, forfeited);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  REWARD FUNDING                                             ║
    // ═══════════════════════════════════════════════════════════════

    /// @notice Fund a reward period (Synthetix notifyRewardAmount with explicit duration)
    /// @param amount  TOWELI amount to distribute
    /// @param duration  Period length in seconds (must be within bounds)
    function notifyRewardAmount(uint256 amount, uint256 duration) external onlyOwner nonReentrant updateReward(address(0)) {
        if (amount < MIN_NOTIFY_AMOUNT) revert NotifyAmountTooSmall();
        if (duration < MIN_REWARDS_DURATION || duration > MAX_REWARDS_DURATION) revert DurationOutOfRange();

        uint256 balanceBefore = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualReward = rewardToken.balanceOf(address(this)) - balanceBefore;

        if (block.timestamp >= periodFinish) {
            rewardRate = actualReward / duration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (leftover + actualReward) / duration;
        }

        if (rewardRate > MAX_REWARD_RATE) revert RewardRateExceedsCap();
        uint256 balance = rewardToken.balanceOf(address(this));
        if (rewardRate > balance / duration) revert RewardTooHigh();

        rewardsDuration = duration;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        totalRewardsFunded += actualReward;
        emit RewardAdded(actualReward, duration);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  TIMELOCKED ADMIN                                           ║
    // ═══════════════════════════════════════════════════════════════

    function proposeRewardsDurationChange(uint256 _newDuration) external onlyOwner {
        if (_newDuration < MIN_REWARDS_DURATION || _newDuration > MAX_REWARDS_DURATION) revert DurationOutOfRange();
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
        pendingRewardsDuration = 0;
    }

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
        pendingTreasury = address(0);
    }

    // ─── Pause / Unpause ────────────────────────────────────────────
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Recover accidentally sent tokens ───────────────────────────
    function recoverERC20(address tokenAddress, uint256 tokenAmount) external onlyOwner {
        if (tokenAddress == address(stakingToken)) revert CannotRecoverStakingToken();
        if (tokenAddress == address(rewardToken)) revert CannotRecoverRewardToken();
        IERC20(tokenAddress).safeTransfer(treasury, tokenAmount);
        emit Recovered(tokenAddress, tokenAmount);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  VIEW HELPERS                                               ║
    // ═══════════════════════════════════════════════════════════════

    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration;
    }
}
