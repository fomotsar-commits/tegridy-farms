// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TegridyFarm
/// @notice MasterChef-style yield farming with lock-boost and auto-throttle.
///         - Lock tiers: 7d (1x), 30d (2x), 90d (3x), 180d (5x)
///         - Mandatory minimum 7-day lock prevents MEV sandwich attacks
///         - Auto-throttle: emission rate tapers when rewards run low
///         - Distributes TOWELI from funded balance (no minting)
contract TegridyFarm is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Structs ───────────────────────────────────────────────────────

    struct PoolInfo {
        IERC20 lpToken;            // Address of LP token or TOWELI for single-sided
        uint256 allocPoint;        // Allocation points for this pool
        uint256 lastRewardTime;    // Last timestamp rewards were calculated
        uint256 accRewardPerShare; // Accumulated rewards per boosted share, scaled 1e12
        uint256 totalStaked;       // Total actual tokens staked in this pool
        uint256 totalBoostedStaked; // Total boosted stake (for reward distribution)
    }

    struct UserInfo {
        uint256 amount;        // Actual LP tokens staked
        uint256 boostedAmount; // amount * boostBps / BOOST_PRECISION
        int256 rewardDebt;     // Reward debt (based on boostedAmount)
        uint256 lockExpiry;    // Timestamp when lock expires
        uint256 boostBps;      // User's current boost multiplier in bps
    }

    // ─── Constants ────────────────────────────────────────────────────

    uint256 public constant MAX_REWARD_PER_SECOND = 10e18;
    uint256 public constant MAX_POOLS = 50;
    uint256 private constant ACC_PRECISION = 1e12;
    uint256 private constant BOOST_PRECISION = 10000; // 10000 = 1x

    // Lock tiers: [7 days, 30 days, 90 days, 180 days]
    uint256 public constant LOCK_TIER_COUNT = 4;
    uint256 private constant LOCK_7D  = 7 days;
    uint256 private constant LOCK_30D = 30 days;
    uint256 private constant LOCK_90D = 90 days;
    uint256 private constant LOCK_180D = 180 days;

    // Boost multipliers: [1x, 2x, 3x, 5x]
    uint256 private constant BOOST_7D  = 10000; // 1x
    uint256 private constant BOOST_30D = 20000; // 2x
    uint256 private constant BOOST_90D = 30000; // 3x
    uint256 private constant BOOST_180D = 50000; // 5x

    // Auto-throttle: start tapering when remaining < 7 days of rewards
    uint256 public constant THROTTLE_THRESHOLD = 7 days;

    // ─── State ─────────────────────────────────────────────────────────

    IERC20 public immutable rewardToken;

    PoolInfo[] public poolInfo;
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;
    mapping(address => bool) private poolExists;

    uint256 public totalAllocPoint;
    uint256 public rewardPerSecond;
    uint256 public totalRewardsRemaining;
    uint256 public startTime;

    // ─── Events ────────────────────────────────────────────────────────

    event PoolAdded(uint256 indexed pid, address indexed lpToken, uint256 allocPoint);
    event PoolSet(uint256 indexed pid, uint256 oldAllocPoint, uint256 newAllocPoint);
    event Deposit(address indexed user, uint256 indexed pid, uint256 amount, uint256 lockTier, uint256 lockExpiry, uint256 boostBps);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event Claim(address indexed user, uint256 indexed pid, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount, uint256 forfeitedRewards);
    event RewardPerSecondUpdated(uint256 oldRate, uint256 newRate);
    event Funded(address indexed funder, uint256 amount);
    event StartTimeSet(uint256 startTime);
    event ExcessRewardsWithdrawn(address indexed to, uint256 amount);

    // ─── Errors ────────────────────────────────────────────────────────

    error InvalidPool();
    error InvalidAmount();
    error InsufficientStake();
    error ExceedsMaxRewardRate();
    error DuplicatePool();
    error FarmNotStarted();
    error StartTimeAlreadySet();
    error InvalidStartTime();
    error ZeroAddress();
    error TooManyPools();
    error ZeroAllocPoint();
    error InvalidLockTier();
    error StillLocked();
    error CannotReduceLock();

    // ─── Constructor ───────────────────────────────────────────────────

    constructor(address _rewardToken, uint256 _rewardPerSecond) Ownable(msg.sender) {
        if (_rewardToken == address(0)) revert ZeroAddress();
        if (_rewardPerSecond > MAX_REWARD_PER_SECOND) revert ExceedsMaxRewardRate();

        rewardToken = IERC20(_rewardToken);
        rewardPerSecond = _rewardPerSecond;
    }

    // ─── Lock Tier Helpers ────────────────────────────────────────────

    function _lockDuration(uint256 _tier) internal pure returns (uint256) {
        if (_tier == 0) return LOCK_7D;
        if (_tier == 1) return LOCK_30D;
        if (_tier == 2) return LOCK_90D;
        if (_tier == 3) return LOCK_180D;
        revert InvalidLockTier();
    }

    function _boostForTier(uint256 _tier) internal pure returns (uint256) {
        if (_tier == 0) return BOOST_7D;
        if (_tier == 1) return BOOST_30D;
        if (_tier == 2) return BOOST_90D;
        if (_tier == 3) return BOOST_180D;
        revert InvalidLockTier();
    }

    /// @notice View lock tier details. Returns (duration, boostBps).
    function lockTierInfo(uint256 _tier) external pure returns (uint256 duration, uint256 boostBps) {
        return (_lockDuration(_tier), _boostForTier(_tier));
    }

    // ─── Owner Functions ───────────────────────────────────────────────

    function setStartTime(uint256 _startTime) external onlyOwner {
        if (startTime != 0) revert StartTimeAlreadySet();
        if (_startTime < block.timestamp) revert InvalidStartTime();
        startTime = _startTime;
        emit StartTimeSet(_startTime);
    }

    function fund(uint256 _amount) external {
        if (_amount == 0) revert InvalidAmount();
        rewardToken.safeTransferFrom(msg.sender, address(this), _amount);
        totalRewardsRemaining += _amount;
        emit Funded(msg.sender, _amount);
    }

    function addPool(uint256 _allocPoint, IERC20 _lpToken) external onlyOwner {
        if (address(_lpToken) == address(0)) revert ZeroAddress();
        if (_allocPoint == 0) revert ZeroAllocPoint();
        if (poolInfo.length >= MAX_POOLS) revert TooManyPools();
        if (poolExists[address(_lpToken)]) revert DuplicatePool();

        massUpdatePools();

        totalAllocPoint += _allocPoint;
        uint256 lastRewardTime = block.timestamp > startTime && startTime != 0
            ? block.timestamp
            : (startTime != 0 ? startTime : block.timestamp);

        poolInfo.push(PoolInfo({
            lpToken: _lpToken,
            allocPoint: _allocPoint,
            lastRewardTime: lastRewardTime,
            accRewardPerShare: 0,
            totalStaked: 0,
            totalBoostedStaked: 0
        }));

        poolExists[address(_lpToken)] = true;
        emit PoolAdded(poolInfo.length - 1, address(_lpToken), _allocPoint);
    }

    function setPool(uint256 _pid, uint256 _allocPoint) external onlyOwner {
        if (_pid >= poolInfo.length) revert InvalidPool();
        massUpdatePools();

        uint256 oldAllocPoint = poolInfo[_pid].allocPoint;
        uint256 newTotalAlloc = totalAllocPoint - oldAllocPoint + _allocPoint;
        if (newTotalAlloc == 0 && poolInfo.length > 0) revert ZeroAllocPoint();

        totalAllocPoint = newTotalAlloc;
        poolInfo[_pid].allocPoint = _allocPoint;
        emit PoolSet(_pid, oldAllocPoint, _allocPoint);
    }

    function setRewardPerSecond(uint256 _rewardPerSecond) external onlyOwner {
        if (_rewardPerSecond > MAX_REWARD_PER_SECOND) revert ExceedsMaxRewardRate();
        massUpdatePools();

        uint256 oldRate = rewardPerSecond;
        rewardPerSecond = _rewardPerSecond;
        emit RewardPerSecondUpdated(oldRate, _rewardPerSecond);
    }

    function withdrawExcessRewards(uint256 _amount) external onlyOwner {
        if (_amount == 0) revert InvalidAmount();

        uint256 totalBalance = rewardToken.balanceOf(address(this));
        uint256 stakedToweli = _getStakedRewardTokenAmount();
        uint256 committed = stakedToweli + totalRewardsRemaining;

        require(totalBalance >= committed + _amount, "Exceeds excess balance");

        rewardToken.safeTransfer(owner(), _amount);
        emit ExcessRewardsWithdrawn(owner(), _amount);
    }

    // ─── Core Functions ────────────────────────────────────────────────

    /// @notice Deposit LP tokens with a mandatory lock tier.
    /// @param _pid Pool ID
    /// @param _amount Amount of LP tokens to deposit
    /// @param _lockTier Lock tier: 0=7d(1x), 1=30d(2x), 2=90d(3x), 3=180d(5x)
    function deposit(uint256 _pid, uint256 _amount, uint256 _lockTier) external nonReentrant {
        if (_pid >= poolInfo.length) revert InvalidPool();
        if (_lockTier >= LOCK_TIER_COUNT) revert InvalidLockTier();
        _requireFarmStarted();

        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];

        updatePool(_pid);

        // Claim pending rewards if user has existing stake
        if (user.boostedAmount > 0) {
            uint256 pendingAmount = _safePendingReward(user.boostedAmount, pool.accRewardPerShare, user.rewardDebt);
            if (pendingAmount > 0) {
                _safeRewardTransfer(msg.sender, pendingAmount);
                emit Claim(msg.sender, _pid, pendingAmount);
            }
        }

        uint256 newBoostBps = _boostForTier(_lockTier);
        uint256 newLockDuration = _lockDuration(_lockTier);
        uint256 newExpiry = block.timestamp + newLockDuration;

        // If user has an active lock, new lock must not reduce expiry
        if (user.lockExpiry > block.timestamp && newExpiry < user.lockExpiry) {
            revert CannotReduceLock();
        }

        // Transfer tokens in
        if (_amount > 0) {
            uint256 balanceBefore = pool.lpToken.balanceOf(address(this));
            pool.lpToken.safeTransferFrom(msg.sender, address(this), _amount);
            uint256 received = pool.lpToken.balanceOf(address(this)) - balanceBefore;
            user.amount += received;
            pool.totalStaked += received;
        }

        // Update boost — apply new boost to ENTIRE position
        // Remove old boosted amount from pool total
        pool.totalBoostedStaked -= user.boostedAmount;

        // Recalculate boosted amount with new boost
        user.boostBps = newBoostBps;
        user.boostedAmount = (user.amount * newBoostBps) / BOOST_PRECISION;
        user.lockExpiry = newExpiry;

        // Add new boosted amount to pool total
        pool.totalBoostedStaked += user.boostedAmount;

        user.rewardDebt = int256(user.boostedAmount * pool.accRewardPerShare / ACC_PRECISION);

        emit Deposit(msg.sender, _pid, _amount, _lockTier, newExpiry, newBoostBps);
    }

    /// @notice Withdraw staked tokens and claim rewards. Lock must have expired.
    function withdraw(uint256 _pid, uint256 _amount) external nonReentrant {
        if (_pid >= poolInfo.length) revert InvalidPool();

        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];

        if (user.amount < _amount) revert InsufficientStake();
        if (block.timestamp < user.lockExpiry) revert StillLocked();

        updatePool(_pid);

        // Claim pending rewards
        uint256 pendingAmount = _safePendingReward(user.boostedAmount, pool.accRewardPerShare, user.rewardDebt);
        if (pendingAmount > 0) {
            _safeRewardTransfer(msg.sender, pendingAmount);
            emit Claim(msg.sender, _pid, pendingAmount);
        }

        if (_amount > 0) {
            // Remove old boosted amount
            pool.totalBoostedStaked -= user.boostedAmount;

            user.amount -= _amount;
            pool.totalStaked -= _amount;

            // Recalculate boosted amount for remaining stake
            user.boostedAmount = (user.amount * user.boostBps) / BOOST_PRECISION;
            pool.totalBoostedStaked += user.boostedAmount;

            pool.lpToken.safeTransfer(msg.sender, _amount);
        }

        user.rewardDebt = int256(user.boostedAmount * pool.accRewardPerShare / ACC_PRECISION);
        emit Withdraw(msg.sender, _pid, _amount);
    }

    /// @notice Claim pending rewards without modifying stake.
    function claim(uint256 _pid) external nonReentrant {
        if (_pid >= poolInfo.length) revert InvalidPool();

        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];

        updatePool(_pid);

        uint256 pendingAmount = _safePendingReward(user.boostedAmount, pool.accRewardPerShare, user.rewardDebt);

        user.rewardDebt = int256(user.boostedAmount * pool.accRewardPerShare / ACC_PRECISION);

        if (pendingAmount > 0) {
            _safeRewardTransfer(msg.sender, pendingAmount);
            emit Claim(msg.sender, _pid, pendingAmount);
        }
    }

    /// @notice Emergency withdraw: bypasses lock, forfeits all rewards.
    function emergencyWithdraw(uint256 _pid) external nonReentrant {
        if (_pid >= poolInfo.length) revert InvalidPool();

        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];

        uint256 amount = user.amount;
        uint256 forfeited = _safePendingReward(user.boostedAmount, pool.accRewardPerShare, user.rewardDebt);

        pool.totalBoostedStaked -= user.boostedAmount;
        pool.totalStaked -= amount;

        user.amount = 0;
        user.boostedAmount = 0;
        user.rewardDebt = 0;
        user.lockExpiry = 0;
        user.boostBps = 0;

        pool.lpToken.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, _pid, amount, forfeited);
    }

    // ─── View Functions ────────────────────────────────────────────────

    /// @notice Get the effective reward rate (may be throttled near depletion).
    function effectiveRewardPerSecond() public view returns (uint256) {
        return _effectiveRewardPerSecond();
    }

    /// @notice View pending rewards for a user in a pool.
    function pendingReward(uint256 _pid, address _user) external view returns (uint256) {
        if (_pid >= poolInfo.length) return 0;

        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][_user];

        uint256 accRewardPerShare = pool.accRewardPerShare;
        uint256 totalBoosted = pool.totalBoostedStaked;

        if (block.timestamp > pool.lastRewardTime && totalBoosted > 0 && totalAllocPoint > 0) {
            uint256 effectiveLastRewardTime = pool.lastRewardTime;
            if (startTime != 0 && effectiveLastRewardTime < startTime) {
                if (block.timestamp <= startTime) return 0;
                effectiveLastRewardTime = startTime;
            }

            uint256 timeElapsed = block.timestamp - effectiveLastRewardTime;
            uint256 effRate = _effectiveRewardPerSecond();
            uint256 reward = (timeElapsed * effRate * pool.allocPoint) / totalAllocPoint;

            if (reward > totalRewardsRemaining) {
                reward = totalRewardsRemaining;
            }

            accRewardPerShare += reward * ACC_PRECISION / totalBoosted;
        }

        int256 accumulatedReward = int256(user.boostedAmount * accRewardPerShare / ACC_PRECISION);
        if (accumulatedReward <= user.rewardDebt) return 0;
        return uint256(accumulatedReward - user.rewardDebt);
    }

    function poolLength() external view returns (uint256) {
        return poolInfo.length;
    }

    // ─── Internal Functions ────────────────────────────────────────────

    function _requireFarmStarted() internal view {
        if (startTime != 0 && block.timestamp < startTime) revert FarmNotStarted();
    }

    /// @notice Auto-throttle: taper emission rate when remaining rewards are low.
    ///         When remaining < rewardPerSecond * THROTTLE_THRESHOLD,
    ///         effective rate = rewardPerSecond * remaining / threshold.
    ///         Rewards asymptotically approach zero — never a sudden cliff.
    function _effectiveRewardPerSecond() internal view returns (uint256) {
        if (rewardPerSecond == 0) return 0;

        uint256 threshold = rewardPerSecond * THROTTLE_THRESHOLD;
        if (totalRewardsRemaining >= threshold) {
            return rewardPerSecond;
        }
        // Scale down proportionally
        return (rewardPerSecond * totalRewardsRemaining) / threshold;
    }

    function _safePendingReward(
        uint256 _boostedAmount,
        uint256 _accRewardPerShare,
        int256 _rewardDebt
    ) internal pure returns (uint256) {
        int256 accumulatedReward = int256(_boostedAmount * _accRewardPerShare / ACC_PRECISION);
        if (accumulatedReward <= _rewardDebt) return 0;
        return uint256(accumulatedReward - _rewardDebt);
    }

    function _getStakedRewardTokenAmount() internal view returns (uint256 staked) {
        for (uint256 i = 0; i < poolInfo.length; i++) {
            if (address(poolInfo[i].lpToken) == address(rewardToken)) {
                staked += poolInfo[i].totalStaked;
            }
        }
    }

    /// @notice Update reward variables for a pool. Uses auto-throttled rate.
    function updatePool(uint256 _pid) public {
        PoolInfo storage pool = poolInfo[_pid];

        if (block.timestamp <= pool.lastRewardTime) return;

        uint256 totalBoosted = pool.totalBoostedStaked;

        if (totalBoosted == 0 || totalAllocPoint == 0 || rewardPerSecond == 0) {
            pool.lastRewardTime = block.timestamp;
            return;
        }

        if (startTime != 0 && pool.lastRewardTime < startTime) {
            if (block.timestamp <= startTime) {
                pool.lastRewardTime = block.timestamp;
                return;
            }
            pool.lastRewardTime = startTime;
        }

        uint256 timeElapsed = block.timestamp - pool.lastRewardTime;
        uint256 effRate = _effectiveRewardPerSecond();
        uint256 reward = (timeElapsed * effRate * pool.allocPoint) / totalAllocPoint;

        if (reward > totalRewardsRemaining) {
            reward = totalRewardsRemaining;
        }

        if (reward > 0) {
            totalRewardsRemaining -= reward;
            pool.accRewardPerShare += reward * ACC_PRECISION / totalBoosted;
        }

        pool.lastRewardTime = block.timestamp;
    }

    function massUpdatePools() public {
        uint256 length = poolInfo.length;
        for (uint256 i = 0; i < length; i++) {
            updatePool(i);
        }
    }

    function _safeRewardTransfer(address _to, uint256 _amount) internal {
        uint256 rewardBalance = rewardToken.balanceOf(address(this));
        uint256 stakedToweli = _getStakedRewardTokenAmount();

        uint256 availableForRewards = rewardBalance > stakedToweli
            ? rewardBalance - stakedToweli
            : 0;

        uint256 transferAmount = _amount > availableForRewards ? availableForRewards : _amount;
        if (transferAmount > 0) {
            rewardToken.safeTransfer(_to, transferAmount);
        }
    }
}
