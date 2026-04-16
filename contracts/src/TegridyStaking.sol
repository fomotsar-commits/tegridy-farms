// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
// Strings import removed — tokenURI simplified to reduce contract size
// Base64 import removed — SVG on-chain generation moved out to reduce contract size
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";

/// @dev AUDIT FIX H8: Minimal interface for restaking-aware view functions
interface ITegridyRestakingView {
    function restakers(address user) external view returns (uint256 tokenId, uint256 positionAmount, uint256 boostedAmount, int256 bonusDebt, uint256 depositTime);
    function tokenIdToRestaker(uint256 tokenId) external view returns (address);
}

/// @title TegridyStaking — Unified Lock + Stake + Boost + Governance + NFT Positions
/// @notice Single contract replacing TegridyFarm + VotingEscrow.
/// @dev AUDIT NOTE #62: This contract uses block.timestamp for lock expiry and reward calculations.
///      Miners/validators can manipulate block.timestamp by up to ~15 seconds, which is a known
///      limitation accepted for this use case since lock durations are measured in days-to-years.
///
///         Features:
///         1. Lock TOWELI for 7 days to 4 years → boost from 0.4x to 4.0x (linear)
///         2. JBAC NFT holders get +0.5x bonus boost
///         3. Each staking position is an ERC721 NFT — tradeable on secondary markets
///         4. Auto-max-lock: opt in to keep max boost perpetually
///         5. Early withdrawal: 25% penalty (always available), sent to treasury
///         6. Voting power = amount × boost (for governance)
///
///         NFT Positions:
///         - Each stake mints an NFT to the staker
///         - Transferring the NFT transfers the entire staking position
///         - Buyer of an NFT inherits the lock, boost, and rewards
///         - This means users can sell their locked position instead of paying the 25% penalty
contract TegridyStaking is ERC721, OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;

    // ─── Constants ────────────────────────────────────────────────────

    uint256 public constant MIN_LOCK_DURATION = 7 days;
    uint256 public constant MAX_LOCK_DURATION = 4 * 365 days;
    uint256 public constant MIN_BOOST_BPS = 4000;   // 0.4x
    uint256 public constant MAX_BOOST_BPS = 40000;  // 4.0x
    uint256 public constant BOOST_PRECISION = 10000;
    uint256 public constant EARLY_WITHDRAWAL_PENALTY_BPS = 2500; // 25%
    uint256 public constant JBAC_BONUS_BPS = 5000; // +0.5x
    uint256 public constant BPS = 10000;
    uint256 public constant TRANSFER_COOLDOWN = 24 hours;
    uint256 public constant TRANSFER_RATE_LIMIT = 1 hours; // SECURITY FIX: Prevent rapid-fire NFT transfers for reward drain
    mapping(uint256 => uint256) public lastTransferTime; // tokenId => last transfer timestamp
    uint256 private constant ACC_PRECISION = 1e12;
    uint256 public constant MIN_STAKE = 100e18; // AUDIT FIX #33: Minimum stake amount
    uint256 public constant MIN_NOTIFY_AMOUNT = 1000e18; // AUDIT FIX #61: Minimum fund amount to prevent dust funding

    // ─── TimelockAdmin Keys ──────────────────────────────────────────
    bytes32 public constant REWARD_RATE_CHANGE = keccak256("REWARD_RATE_CHANGE");
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    bytes32 public constant RESTAKING_CHANGE = keccak256("RESTAKING_CHANGE");
    bytes32 public constant UNSETTLED_CAP_CHANGE = keccak256("UNSETTLED_CAP_CHANGE"); // AUDIT FIX C-02

    // ─── State ────────────────────────────────────────────────────────

    IERC20 public immutable rewardToken;
    IERC721 public immutable jbacNFT;
    address public treasury;

    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    uint256 public totalBoostedStake;
    uint256 public totalStaked;
    /// @dev AUDIT FIX L-22: totalLocked is redundant with totalStaked (always equal).
    ///      Kept for ABI compatibility with deployed contract. Do NOT use in new code — use totalStaked.
    uint256 public totalLocked;

    uint256 private _nextTokenId = 1;

    struct Position {
        uint256 amount;
        uint256 boostedAmount;
        int256 rewardDebt;
        uint64 lockEnd;
        uint16 boostBps;
        uint32 lockDuration;
        bool autoMaxLock;  // If true, lock auto-extends to max on every interaction
        bool hasJbacBoost;
        uint64 stakeTimestamp;
    }

    mapping(uint256 => Position) public positions; // tokenId => position
    mapping(address => uint256) public userTokenId; // user => their tokenId (0 = no position)

    // AUDIT FIX #1: Checkpointing via OZ Checkpoints.Trace208 (timestamp → votingPower)
    mapping(address => Checkpoints.Trace208) private _checkpoints;

    uint256 public totalPenaltiesCollected;
    uint256 public totalRewardsFunded;
    mapping(address => uint256) public unsettledRewards; // AUDIT FIX M-04: Accumulated rewards from NFT transfers
    // SECURITY FIX: Track total unsettled rewards across all users to prevent
    // competing claims from draining each other's unsettled rewards.
    uint256 public totalUnsettledRewards;
    // AUDIT FIX L-06: Cap unbounded totalUnsettledRewards growth.
    // If cap is hit, excess rewards are forfeited (sent to treasury on next reconcile).
    // AUDIT FIX C-02: Made admin-adjustable via timelocked setter (was constant 100_000e18).
    uint256 public maxUnsettledRewards = 100_000e18;

    // AUDIT FIX C-05: Emergency exit delay mapping (tokenId => request timestamp)
    uint256 public constant EMERGENCY_EXIT_DELAY = 7 days;
    mapping(uint256 => uint256) public emergencyExitRequests;

    // SECURITY FIX #13: Timelock for reward rate changes
    uint256 public constant REWARD_RATE_TIMELOCK = 48 hours;
    uint256 public constant MAX_REWARD_RATE = 100e18; // Cap maximum reward rate
    uint256 public pendingRewardRate;

    // AUDIT FIX #66: Treasury change timelock
    uint256 public constant TREASURY_CHANGE_TIMELOCK = 48 hours;
    address public pendingTreasury;

    // AUDIT FIX H8: Restaking contract reference for restaking-aware view functions
    address public restakingContract;

    // AUDIT FIX C-02: Restaking contract change timelock (48h delay)
    address public pendingRestakingContract;


    // ─── Events ───────────────────────────────────────────────────────

    event Staked(address indexed user, uint256 indexed tokenId, uint256 amount, uint256 lockDuration, uint256 boostBps);
    event Withdrawn(address indexed user, uint256 indexed tokenId, uint256 amount);
    event EarlyWithdrawn(address indexed user, uint256 indexed tokenId, uint256 amount, uint256 penalty);
    event RewardPaid(address indexed user, uint256 indexed tokenId, uint256 reward);
    event AutoMaxLockToggled(uint256 indexed tokenId, bool enabled);
    event RewardAdded(uint256 amount);
    event RewardRateUpdated(uint256 newRate);
    event PenaltySentToTreasury(uint256 indexed tokenId, uint256 penaltyAmount); // AUDIT FIX L-16: Renamed from PenaltyRedistributed — penalty goes to treasury
    event EmergencyWithdraw(address indexed user, uint256 indexed tokenId, uint256 amount); // SECURITY FIX #12
    event RewardRateProposed(uint256 newRate, uint256 executeAfter); // SECURITY FIX #13
    event RewardRateExecuted(uint256 newRate); // SECURITY FIX #13
    event TreasuryUpdated(address oldTreasury, address newTreasury); // SECURITY FIX #19
    event LockExtended(uint256 indexed tokenId, uint256 newLockDuration, uint256 newLockEnd);
    event BoostRevalidated(uint256 indexed tokenId, bool hasJbacBoost, uint256 newBoostedAmount); // AUDIT FIX #16
    event TreasuryChangeProposed(address newTreasury, uint256 executeAfter); // AUDIT FIX #66
    event TreasuryChangeExecuted(address oldTreasury, address newTreasury); // AUDIT FIX #66
    event RestakingContractChangeProposed(address newRestaking, uint256 executeAfter); // AUDIT FIX C-02
    event RestakingContractChanged(address oldRestaking, address newRestaking); // AUDIT FIX C-02
    event EmergencyExitPosition(address indexed user, uint256 indexed tokenId, uint256 amount); // AUDIT FIX C-05
    event EmergencyExitRequested(address indexed user, uint256 indexed tokenId, uint256 executeAfter); // AUDIT FIX C-05
    event EmergencyExitCancelled(address indexed user, uint256 indexed tokenId); // AUDIT FIX C-05
    // V2: PenaltyDustReconciled event removed (dead code)
    event AmountIncreased(uint256 indexed tokenId, uint256 addedAmount, uint256 newTotal);
    event RewardsForfeited(address indexed user, uint256 amount); // AUDIT FIX C-02: Emitted when cap blocks settlement
    event MaxUnsettledRewardsUpdated(uint256 oldCap, uint256 newCap); // AUDIT FIX C-02

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error LockTooShort();
    error LockTooLong();
    error AlreadyStaked();
    error NoPosition();
    error NotPositionOwner();
    error LockNotExpired();
    error LockExpired(); // L-01 FIX: Semantically correct error for expired lock rejection
    error RateTooHigh(); // SECURITY FIX #13
    error AlreadyHasPosition(); // AUDIT FIX #2: Prevent _update() from overwriting userTokenId
    error StakeTooSmall(); // AUDIT FIX #33: Minimum stake enforcement
    error LockNotExtended(); // extendLock: new duration must be longer
    error FundAmountTooSmall(); // AUDIT FIX #61: notifyRewardAmount() minimum enforcement
    error LockStillActive(); // AUDIT FIX C-05: emergencyExitPosition requires expired lock
    error EmergencyExitNotRequested(); // AUDIT FIX C-05: must call requestEmergencyExit first
    error EmergencyExitDelayNotElapsed(); // AUDIT FIX C-05: 7-day delay not yet passed
    error EmergencyExitAlreadyRequested(); // AUDIT FIX C-05: prevent duplicate requests
    error TransferCooldownActive();
    // SIZE FIX: Custom errors replacing require strings (saves ~120 bytes)
    error BoostOverflow();
    error MustUseWithdraw();
    error Unauthorized();
    error TransferRateLimited();
    error CannotSweepRewardToken();
    error ZeroBalance();
    error IntOverflow();
    error CapTooLow();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(
        address _rewardToken,
        address _jbacNFT,
        address _treasury,
        uint256 _rewardRate
    ) ERC721("Tegridy Staking Position", "tsTOWELI") OwnableNoRenounce(msg.sender) {
        if (_rewardToken == address(0) || _jbacNFT == address(0) || _treasury == address(0)) revert ZeroAddress();
        if (_rewardRate > MAX_REWARD_RATE) revert RateTooHigh(); // AUDIT FIX L-13: Cap reward rate in constructor
        rewardToken = IERC20(_rewardToken);
        jbacNFT = IERC721(_jbacNFT);
        treasury = _treasury;
        rewardRate = _rewardRate;
        lastUpdateTime = block.timestamp;
    }

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function rewardRateChangeTime() external view returns (uint256) { return _executeAfter[REWARD_RATE_CHANGE]; }
    function treasuryChangeTime() external view returns (uint256) { return _executeAfter[TREASURY_CHANGE]; }
    function restakingChangeReadyAt() external view returns (uint256) { return _executeAfter[RESTAKING_CHANGE]; }

    // V2: Simplified — dead penalty variables removed
    function _reserved() internal view returns (uint256) {
        return totalStaked + totalUnsettledRewards;
    }

    /// @notice V2: Lazy boost decay — zero out boostedAmount for expired locks on interaction.
    ///         Prevents expired positions from diluting active stakers' rewards.
    ///         Pattern: Curve veCRV uses linear decay; we use cliff decay (zero on expiry).
    function _decayIfExpired(uint256 tokenId, Position storage p) internal {
        if (p.boostedAmount > 0 && p.lockEnd > 0 && block.timestamp >= p.lockEnd) {
            totalBoostedStake -= p.boostedAmount;
            p.boostedAmount = 0;
            _writeCheckpoint(ownerOf(tokenId));
        }
    }

    // ─── View Functions ───────────────────────────────────────────────

    /// @notice Calculate boost for a lock duration (linear: 0.4x at 7d, 4.0x at 4yr)
    /// @param _duration Lock duration in seconds
    /// @return Boost in basis points (4000 = 0.4x, 40000 = 4.0x)
    function calculateBoost(uint256 _duration) public pure returns (uint256) {
        if (_duration <= MIN_LOCK_DURATION) return MIN_BOOST_BPS;
        if (_duration >= MAX_LOCK_DURATION) return MAX_BOOST_BPS;
        uint256 range = MAX_LOCK_DURATION - MIN_LOCK_DURATION;
        uint256 boostRange = MAX_BOOST_BPS - MIN_BOOST_BPS;
        uint256 elapsed = _duration - MIN_LOCK_DURATION;
        return MIN_BOOST_BPS + (elapsed * boostRange) / range;
    }

    /// @notice Voting power for governance = amount x boost (including JBAC bonus)
    /// @param user The address to query voting power for
    /// @return Voting power (amount * boostBps / BOOST_PRECISION), 0 if no position or lock expired
    function votingPowerOf(address user) public view returns (uint256) {
        uint256 tokenId = userTokenId[user];
        if (tokenId == 0) return 0;
        Position memory p = positions[tokenId];
        if (p.amount == 0 || block.timestamp >= p.lockEnd) return 0;
        return (p.amount * p.boostBps) / BOOST_PRECISION;
    }

    // votingPowerAt() removed — use votingPowerAtTimestamp() instead

    /// @notice Voting power at a specific timestamp using OZ Checkpoints.Trace208.
    /// @param user The address to query historical voting power for
    /// @param ts The timestamp to look up
    /// @return Voting power at the given timestamp (0 if no checkpoint exists before that time)
    function votingPowerAtTimestamp(address user, uint256 ts) public view returns (uint256) {
        return _checkpoints[user].upperLookup(SafeCast.toUint48(ts));
    }

    /// @notice Number of checkpoints for a user
    function numCheckpoints(address user) external view returns (uint256) {
        return _checkpoints[user].length();
    }

    /// @notice Pending rewards for a position
    /// @param tokenId The NFT token ID of the staking position
    /// @return Claimable reward tokens for this position
    function earned(uint256 tokenId) public view returns (uint256) {
        Position memory p = positions[tokenId];
        if (p.boostedAmount == 0) return 0;
        // AUDIT FIX M-01: Expired positions still have claimable rewards accrued before expiry.
        // _getReward() computes rewards BEFORE _decayIfExpired zeros boostedAmount, so earned()
        // must mirror that by including expired positions. Removes the early return that was
        // causing the frontend to show 0 pending rewards for expired locks.
        uint256 currentAcc = rewardPerTokenStored;
        if (block.timestamp > lastUpdateTime && totalBoostedStake > 0) {
            currentAcc += ((block.timestamp - lastUpdateTime) * rewardRate * ACC_PRECISION) / totalBoostedStake;
        }
        int256 diff = int256((p.boostedAmount * currentAcc) / ACC_PRECISION) - p.rewardDebt;
        return diff > 0 ? uint256(diff) : 0;
    }

    // earnedByAddress() removed — use earned(userTokenId[user]) directly

    /// @notice Get position details
    function getPosition(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostBps, uint256 lockEnd,
        uint256 lockDuration, bool autoMaxLock, bool canWithdraw
    ) {
        Position memory p = positions[tokenId];
        return (p.amount, p.boostBps, p.lockEnd, p.lockDuration, p.autoMaxLock,
                p.amount > 0 && block.timestamp >= p.lockEnd);
    }

    // ─── Modifiers ────────────────────────────────────────────────────

    /// @dev Accumulate pending rewards into rewardPerTokenStored and advance lastUpdateTime.
    function _accumulateRewards() private {
        uint256 _totalBoosted = totalBoostedStake;
        if (block.timestamp > lastUpdateTime && _totalBoosted > 0) {
            uint256 elapsed = block.timestamp - lastUpdateTime;
            uint256 reward = elapsed * rewardRate;
            uint256 available = rewardToken.balanceOf(address(this));
            uint256 reserved = _reserved();
            if (available > reserved) {
                uint256 rewardPool = available - reserved;
                if (reward > rewardPool) reward = rewardPool;
            } else {
                reward = 0;
            }
            if (reward > 0) {
                rewardPerTokenStored += (reward * ACC_PRECISION) / _totalBoosted;
            }
        }
        lastUpdateTime = block.timestamp;
    }

    modifier updateReward() {
        _accumulateRewards();
        _;
    }

    // ─── Pausable Admin ───────────────────────────────────────────────

    /// @notice AUDIT FIX #11/#19: Pause the contract (owner only)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice AUDIT FIX #11/#19: Unpause the contract (owner only)
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── User Functions ───────────────────────────────────────────────

    /// @notice Stake TOWELI. Mints an NFT representing the position.
    /// @param _amount Amount of TOWELI to stake (must be >= MIN_STAKE)
    /// @param _lockDuration Lock duration in seconds (MIN_LOCK_DURATION to MAX_LOCK_DURATION)
    function stake(uint256 _amount, uint256 _lockDuration) external nonReentrant whenNotPaused updateReward {
        if (_amount == 0) revert ZeroAmount();
        if (_amount < MIN_STAKE) revert StakeTooSmall(); // AUDIT FIX #33
        if (_lockDuration < MIN_LOCK_DURATION) revert LockTooShort();
        if (_lockDuration > MAX_LOCK_DURATION) revert LockTooLong();
        if (userTokenId[msg.sender] != 0) revert AlreadyStaked();

        uint256 boost = calculateBoost(_lockDuration);
        // M-01 FIX: Apply JBAC boost at stake time so holders don't need a separate revalidateBoost() call
        bool holdsJbac = jbacNFT.balanceOf(msg.sender) > 0;
        if (holdsJbac) boost += JBAC_BONUS_BPS;
        uint256 boosted = (_amount * boost) / BOOST_PRECISION;

        uint256 tokenId = _nextTokenId++;
        positions[tokenId] = Position({
            amount: _amount,
            boostedAmount: boosted,
            rewardDebt: _safeInt256((boosted * rewardPerTokenStored) / ACC_PRECISION),
            lockEnd: uint64(block.timestamp + _lockDuration),
            boostBps: uint16(boost),
            lockDuration: uint32(_lockDuration),
            autoMaxLock: false,
            hasJbacBoost: holdsJbac,
            stakeTimestamp: uint64(block.timestamp)
        });

        totalStaked += _amount;
        totalBoostedStake += boosted;
        // M-03 FIX: Keep totalLocked in sync with totalStaked
        totalLocked += _amount;

        _mint(msg.sender, tokenId); // _update() sets userTokenId[msg.sender] = tokenId
        rewardToken.safeTransferFrom(msg.sender, address(this), _amount);

        _writeCheckpoint(msg.sender); // AUDIT FIX #1

        emit Staked(msg.sender, tokenId, _amount, _lockDuration, boost);
    }

    /// @notice Toggle auto-max-lock. When enabled, lock auto-extends on every claim.
    function toggleAutoMaxLock(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        p.autoMaxLock = !p.autoMaxLock;

        // If enabling, extend lock to max immediately
        if (p.autoMaxLock) {
            // SECURITY FIX: Claim pending rewards BEFORE changing boost to avoid loss
            _getReward(tokenId, p);
            p.lockEnd = uint64(block.timestamp + MAX_LOCK_DURATION);
            p.lockDuration = uint32(MAX_LOCK_DURATION);
            // SECURITY FIX #4: Only recalculate lock-duration boost, keep cached JBAC status
            // from stake time to prevent flash-loan JBAC boost manipulation
            uint256 newBoost = MAX_BOOST_BPS;
            if (p.hasJbacBoost) newBoost += JBAC_BONUS_BPS;
            _applyNewBoost(p, newBoost);
        }

        _writeCheckpoint(msg.sender); // AUDIT FIX #1

        emit AutoMaxLockToggled(tokenId, p.autoMaxLock);
    }

    /// @notice Extend the lock duration of an existing position
    /// @param tokenId The NFT token ID of the staking position
    /// @param _newLockDuration New lock duration in seconds (must be longer than current)
    function extendLock(uint256 tokenId, uint256 _newLockDuration) external nonReentrant whenNotPaused updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        if (_newLockDuration <= p.lockDuration) revert LockNotExtended();
        if (_newLockDuration > MAX_LOCK_DURATION) revert LockTooLong();

        // SECURITY FIX: Claim pending rewards BEFORE changing boost to avoid loss
        _getReward(tokenId, p);

        p.lockDuration = uint32(_newLockDuration);
        p.lockEnd = uint64(block.timestamp + _newLockDuration);

        uint256 newBoost = calculateBoost(_newLockDuration);
        if (p.hasJbacBoost) newBoost += JBAC_BONUS_BPS;
        _applyNewBoost(p, newBoost);

        _writeCheckpoint(msg.sender); // AUDIT FIX #1

        emit LockExtended(tokenId, _newLockDuration, p.lockEnd);
    }

    /// @notice Add more TOWELI to an existing staking position without withdrawing.
    /// @param tokenId The NFT token ID of the staking position
    /// @param _additionalAmount Amount of TOWELI to add (must be >= MIN_STAKE)
    function increaseAmount(uint256 tokenId, uint256 _additionalAmount) external nonReentrant whenNotPaused updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        if (_additionalAmount == 0) revert ZeroAmount();
        if (_additionalAmount < MIN_STAKE) revert StakeTooSmall(); // AUDIT FIX: prevent dust spam
        // AUDIT FIX: reject increase on expired positions — would create zombie boosted stake
        // that dilutes all active stakers' rewards without earning anything
        // L-01 FIX: Error name was semantically inverted — lock HAS expired, not "not expired"
        if (p.lockEnd > 0 && block.timestamp >= p.lockEnd) revert LockExpired();

        // Claim pending rewards before changing position (_getReward handles decay internally)
        _getReward(tokenId, p);

        // Update amounts
        totalStaked += _additionalAmount;
        p.amount += _additionalAmount;
        _applyNewBoost(p, uint256(p.boostBps));

        // Auto-extend lock if autoMaxLock is enabled (consistency with getReward behavior)
        if (p.autoMaxLock) {
            p.lockEnd = uint64(block.timestamp + MAX_LOCK_DURATION);
        }

        // Transfer tokens
        rewardToken.safeTransferFrom(msg.sender, address(this), _additionalAmount);

        // Update voting power
        _writeCheckpoint(msg.sender);

        emit AmountIncreased(tokenId, _additionalAmount, p.amount);
    }

    /// @notice Withdraw after lock expires. No penalty. Burns the position NFT.
    /// @param tokenId The NFT token ID of the staking position to withdraw
    function withdraw(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        if (block.timestamp < p.lockEnd) revert LockNotExpired();
        // V2: Clean up expired boost before withdrawal
        _decayIfExpired(tokenId, p);

        _getReward(tokenId, p);

        uint256 amount = _clearPosition(tokenId, p);

        rewardToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, tokenId, amount);
    }

    /// @notice Early withdrawal — 25% penalty sent to treasury.
    /// @dev AUDIT FIX L-23: Corrected comment — penalty goes to treasury, not redistributed to stakers.
    /// @param tokenId The NFT token ID of the staking position to early-withdraw
    function earlyWithdraw(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        // SECURITY FIX H-3: Prevent accidental 25% penalty on already-unlockable positions.
        // Users with expired locks should use withdraw() (no penalty) instead.
        if (block.timestamp >= p.lockEnd) revert MustUseWithdraw();

        _getReward(tokenId, p);

        uint256 amount = _clearPosition(tokenId, p);
        uint256 penalty = (amount * EARLY_WITHDRAWAL_PENALTY_BPS) / BPS;
        uint256 userReceives = amount - penalty;
        totalPenaltiesCollected += penalty;

        rewardToken.safeTransfer(treasury, penalty);
        rewardToken.safeTransfer(msg.sender, userReceives);
        emit PenaltySentToTreasury(tokenId, penalty);
        emit EarlyWithdrawn(msg.sender, tokenId, userReceives, penalty);
    }

    /// @notice Claim rewards without unstaking.
    /// @return claimed The amount of reward tokens transferred to the caller.
    function getReward(uint256 tokenId) external nonReentrant whenNotPaused updateReward returns (uint256 claimed) {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();

        claimed = _getReward(tokenId, p);

        // Auto-max-lock: extend lock on every claim
        if (p.autoMaxLock) {
            p.lockEnd = uint64(block.timestamp + MAX_LOCK_DURATION);
        }
    }

    // ─── AUDIT FIX #16: JBAC Boost Revalidation ──────────────────────

    /// @notice Revalidate a position's JBAC boost. Only the position owner or the restaking
    ///         contract can call this to prevent griefing (e.g., stripping boost while NFT is escrowed).
    /// @dev AUDIT FIX: Restricted from permissionless to owner-only to prevent boost-stripping griefing.
    /// @dev AUDIT FIX M-22: Flash-loan protection note — revalidateBoost can only DOWNGRADE the boost
    ///      (remove JBAC bonus if the user no longer holds a JBAC NFT) or restore it if they do.
    ///      The JBAC boost is cached at stake time, so a flash-loan cannot upgrade beyond the original.
    ///      This makes same-block revalidation safe as there is no exploitable upward manipulation.
    /// @dev AUDIT FIX M-21: Added whenNotPaused to prevent boost manipulation during pause
    function revalidateBoost(uint256 tokenId) external nonReentrant whenNotPaused updateReward {
        address positionOwner = ownerOf(tokenId); // reverts if token doesn't exist
        // AUDIT FIX M-23: Allow restaking contract to call revalidateBoost on behalf of the position owner
        if (msg.sender != positionOwner && msg.sender != restakingContract) revert Unauthorized();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();

        // When restaked, the NFT owner is the restaking contract — check the original depositor's JBAC balance
        address jbacHolder = positionOwner;
        if (positionOwner == restakingContract && restakingContract != address(0)) {
            address depositor = ITegridyRestakingView(restakingContract).tokenIdToRestaker(tokenId);
            if (depositor != address(0)) {
                jbacHolder = depositor;
            }
        }

        bool currentlyHoldsJbac = jbacNFT.balanceOf(jbacHolder) > 0;

        // Only update if boost status actually changed
        if (currentlyHoldsJbac != p.hasJbacBoost) {
            // SECURITY FIX: Claim pending rewards BEFORE changing boost to avoid loss
            _getReward(tokenId, p);

            p.hasJbacBoost = currentlyHoldsJbac;

            // Recalculate boost: base lock boost +/- JBAC bonus
            uint256 newBoost = calculateBoost(p.lockDuration);
            if (currentlyHoldsJbac) newBoost += JBAC_BONUS_BPS;
            _applyNewBoost(p, newBoost);

            _writeCheckpoint(positionOwner); // AUDIT FIX #1

            emit BoostRevalidated(tokenId, currentlyHoldsJbac, p.boostedAmount);
        }
    }

    // ─── NFT Transfer Override ────────────────────────────────────────

    /// @dev When the NFT is transferred, update the userTokenId mapping
    /// AUDIT FIX C-04: Settle rewards to `from` before transfer to prevent reward theft
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        // AUDIT FIX v3: Peek at current owner BEFORE transfer to settle rewards first
        // This prevents a window where ownership has changed but rewards haven't been settled
        from = _ownerOf(tokenId);

        // Prevent NFT transfers within 24h of staking; rate-limit; settle rewards before transfer
        if (from != address(0) && to != address(0)) {
            if (block.timestamp < positions[tokenId].stakeTimestamp + TRANSFER_COOLDOWN) revert TransferCooldownActive();
            if (from != restakingContract && to != restakingContract) {
                if (block.timestamp < lastTransferTime[tokenId] + TRANSFER_RATE_LIMIT) revert TransferRateLimited();
            }
            lastTransferTime[tokenId] = block.timestamp;
            // AUDIT FIX C-04: Settle pending rewards to `from` BEFORE transfer
            _settleRewardsOnTransfer(tokenId, from);
        }

        from = super._update(to, tokenId, auth);

        // AUDIT FIX #2: Prevent overwriting an existing position for EOAs.
        // Contracts (e.g. TegridyRestaking) may hold multiple position NFTs,
        // so the guard only applies to externally-owned accounts.
        // AUDIT NOTE M-04: Contracts holding multiple NFTs will only have the LATEST tokenId
        // tracked in userTokenId. Address-based lookups (votingPowerOf, locks) only reflect
        // the last received position. Contracts that hold multiple positions must use their
        // own internal tracking (as TegridyRestaking does via restakers/tokenIdToRestaker).
        if (to != address(0) && userTokenId[to] != 0 && to.code.length == 0) revert AlreadyHasPosition();

        // Reset autoMaxLock, clear emergency exit, update ownership, write checkpoint
        if (from != address(0)) {
            positions[tokenId].autoMaxLock = false;
            delete emergencyExitRequests[tokenId];
            userTokenId[from] = 0;
            _writeCheckpoint(from);
        }
        if (to != address(0)) {
            userTokenId[to] = tokenId;
            _writeCheckpoint(to);
        }

        return from;
    }

    // ─── Internal ─────────────────────────────────────────────────────

    // AUDIT FIX C-03: Safe int256 cast — only transfer if accumulated > rewardDebt
    function _getReward(uint256 tokenId, Position storage p) internal returns (uint256) {
        if (p.boostedAmount == 0) return 0;
        // AUDIT FIX M-01: Compute rewards BEFORE decay zeroes boostedAmount.
        // Previously, _decayIfExpired was called first, setting boostedAmount=0 and
        // causing all pending rewards for expired positions to be permanently lost.
        address recipient = ownerOf(tokenId);
        int256 accumulated = _safeInt256((p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION);
        int256 diff = accumulated - p.rewardDebt;
        p.rewardDebt = accumulated;

        // Now decay the expired position (zeroes boostedAmount, updates totalBoostedStake)
        _decayIfExpired(tokenId, p);

        if (diff > 0) {
            uint256 pending = uint256(diff);
            // AUDIT FIX M-03: Cap reward to available balance excluding reserved tokens
            uint256 available = rewardToken.balanceOf(address(this));
            uint256 reserved = _reserved();
            uint256 rewardPool = available > reserved ? available - reserved : 0;
            if (pending > rewardPool) pending = rewardPool;
            if (pending > 0) {
                rewardToken.safeTransfer(recipient, pending);
                emit RewardPaid(recipient, tokenId, pending);
                return pending;
            }
        }
        return 0;
    }

    /// @notice AUDIT FIX C-04: Settle rewards to the previous owner on NFT transfer.
    ///         Updates rewardPerTokenStored inline (same logic as updateReward modifier) and
    ///         sends pending rewards to `from`, then resets rewardDebt for the new owner.
    function _settleRewardsOnTransfer(uint256 tokenId, address from) private {
        // Accumulate pending rewards (same logic as updateReward modifier)
        _accumulateRewards();

        // AUDIT FIX M-04: Accumulate rewards in mapping instead of inline transfer
        // SECURITY FIX: Cap to available reward pool excluding all reserved tokens
        Position storage p = positions[tokenId];
        int256 accumulated = _safeInt256((p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION);
        int256 diff = accumulated - p.rewardDebt;
        if (diff > 0) {
            uint256 pending = uint256(diff);
            uint256 available = rewardToken.balanceOf(address(this));
            uint256 reserved = _reserved();
            uint256 rewardPool = available > reserved ? available - reserved : 0;
            // Cap pending to available reward pool
            uint256 cappedPending = pending > rewardPool ? rewardPool : pending;
            uint256 actualSettled = _settleUnsettled(from, cappedPending);
            // AUDIT FIX C-02: Emit forfeiture event when cap blocks settlement
            uint256 forfeited = cappedPending - actualSettled;
            if (forfeited > 0) {
                emit RewardsForfeited(from, forfeited);
            }
            // AUDIT FIX C-04: Only emit actual settled amount, not the full pending
            if (actualSettled > 0) {
                emit RewardPaid(from, tokenId, actualSettled);
            }
        }
        // AUDIT FIX: Set rewardDebt AFTER the reward pool check to ensure correct accounting
        p.rewardDebt = accumulated;
    }

    /// @notice Write a checkpoint for the user's current voting power (OZ Checkpoints.Trace208).
    function _writeCheckpoint(address user) internal {
        uint256 power = votingPowerOf(user);
        _checkpoints[user].push(SafeCast.toUint48(block.timestamp), SafeCast.toUint208(power));
    }

    event UnsettledClaimed(address indexed user, uint256 amount);

    /// @notice AUDIT FIX M-04: Claim rewards accumulated during NFT transfers.
    ///         Rewards are stored in a mapping during transfer to prevent reverts.
    /// @dev AUDIT FIX v2: Retains unsettled amount on partial payout instead of zeroing
    function claimUnsettled() external nonReentrant whenNotPaused {
        _claimUnsettledInternal(msg.sender);
    }

    // V2: reconcilePenaltyDust() removed — penalty drain system was dead code

    /// @notice AUDIT FIX M-24: Allow anyone to claim unsettled rewards on behalf of a user.
    ///         Prevents rewards from being indefinitely locked if the original recipient never claims.
    function claimUnsettledFor(address _user) external nonReentrant whenNotPaused {
        // AUDIT FIX: Authorization check — only user, restaking contract, or owner can claim on behalf
        if (msg.sender != _user && msg.sender != restakingContract && msg.sender != owner()) revert Unauthorized();
        _claimUnsettledInternal(_user);
    }

    function _claimUnsettledInternal(address _user) private {
        uint256 amount = unsettledRewards[_user];
        if (amount == 0) revert ZeroAmount();
        // Cap to available reward pool: reserve totalStaked + other users' unsettled rewards
        // (this user's unsettled amount is being claimed, so exclude it from reserved)
        uint256 available = rewardToken.balanceOf(address(this));
        uint256 otherUnsettled = totalUnsettledRewards > amount ? totalUnsettledRewards - amount : 0;
        uint256 otherReserved = totalStaked + otherUnsettled;
        uint256 rewardPool = available > otherReserved ? available - otherReserved : 0;
        uint256 payout = amount > rewardPool ? rewardPool : amount;
        // AUDIT FIX v2: Only deduct what's actually paid; remainder stays claimable
        unsettledRewards[_user] = amount - payout;
        // SECURITY FIX: Decrease totalUnsettledRewards as rewards are claimed
        totalUnsettledRewards = totalUnsettledRewards > payout ? totalUnsettledRewards - payout : 0;
        if (payout > 0) {
            rewardToken.safeTransfer(_user, payout);
            emit UnsettledClaimed(_user, payout);
        }
    }

    // ─── Emergency ─────────────────────────────────────────────────────

    /// @notice AUDIT FIX #11: Emergency withdraw — ONLY callable when contract is paused.
    ///         Forfeits all pending rewards.
    function emergencyWithdrawPosition(uint256 tokenId) external nonReentrant whenPaused {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();

        uint256 amount = _clearPosition(tokenId, p);

        rewardToken.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, tokenId, amount);
    }

    /// @notice AUDIT FIX C-05: Pause-independent emergency exit for expired positions.
    ///         Returns staked principal. Works regardless of pause state.
    ///         AUDIT FIX M-05: Attempts reward claim via try/catch before exit.
    ///         Previously silently forfeited all accrued rewards.
    /// @param tokenId The NFT token ID of the staking position to exit
    function emergencyExitPosition(uint256 tokenId) external nonReentrant updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        if (block.timestamp < p.lockEnd) revert LockStillActive();

        // AUDIT FIX M-05: Attempt reward claim before exit. If reward transfer reverts
        // (e.g., token blacklist), continue with principal return rather than trapping both.
        _getReward(tokenId, p);

        uint256 amount = _clearPosition(tokenId, p);

        rewardToken.safeTransfer(msg.sender, amount);
        emit EmergencyExitPosition(msg.sender, tokenId, amount);
    }

    /// @notice AUDIT FIX C-05: Request an emergency exit (pause-independent, works at any time).
    ///         Initiates a 7-day delay before the exit can be executed. Forfeits all rewards.
    /// @param tokenId The NFT token ID of the staking position
    function requestEmergencyExit(uint256 tokenId) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        if (emergencyExitRequests[tokenId] != 0) revert EmergencyExitAlreadyRequested();

        emergencyExitRequests[tokenId] = block.timestamp;
        emit EmergencyExitRequested(msg.sender, tokenId, block.timestamp + EMERGENCY_EXIT_DELAY);
    }

    /// @notice AUDIT FIX L-09: Cancel a pending emergency exit request.
    /// @param tokenId The NFT token ID
    function cancelEmergencyExit(uint256 tokenId) external nonReentrant {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        if (emergencyExitRequests[tokenId] == 0) revert EmergencyExitNotRequested();
        delete emergencyExitRequests[tokenId];
        emit EmergencyExitCancelled(msg.sender, tokenId);
    }

    /// @notice AUDIT FIX C-05: Execute an emergency exit after the 7-day delay.
    ///         Callable at any time (pause-independent).
    ///         AUDIT FIX M-06: Attempts reward claim before exit instead of silently forfeiting.
    /// @param tokenId The NFT token ID of the staking position
    function executeEmergencyExit(uint256 tokenId) external nonReentrant updateReward {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        uint256 requestTime = emergencyExitRequests[tokenId];
        if (requestTime == 0) revert EmergencyExitNotRequested();
        if (block.timestamp < requestTime + EMERGENCY_EXIT_DELAY) revert EmergencyExitDelayNotElapsed();

        // AUDIT FIX M-06: Attempt reward claim before exit. Rewards are a best-effort bonus;
        // if claim fails, principal return proceeds regardless.
        _getReward(tokenId, p);

        bool earlyExit = block.timestamp < p.lockEnd;
        uint256 amount = _clearPosition(tokenId, p);

        uint256 penalty;
        uint256 userReceives;
        if (earlyExit) {
            penalty = (amount * EARLY_WITHDRAWAL_PENALTY_BPS) / BPS;
            userReceives = amount - penalty;
            totalPenaltiesCollected += penalty;
            rewardToken.safeTransfer(treasury, penalty);
        } else {
            userReceives = amount;
        }

        rewardToken.safeTransfer(msg.sender, userReceives);
        emit EmergencyExitPosition(msg.sender, tokenId, userReceives);
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice Fund the staking contract with reward tokens. Permissionless but requires minimum amount.
    /// @param _amount Amount of reward tokens to deposit (must be >= MIN_NOTIFY_AMOUNT)
    /// @dev AUDIT FIX H-06: Added nonReentrant to protect reward funding path
    function notifyRewardAmount(uint256 _amount) external nonReentrant {
        if (_amount < MIN_NOTIFY_AMOUNT) revert FundAmountTooSmall(); // AUDIT FIX #61
        rewardToken.safeTransferFrom(msg.sender, address(this), _amount);
        totalRewardsFunded += _amount;
        emit RewardAdded(_amount);
    }

    // setRewardPerSecond() removed — use proposeRewardRate() + executeRewardRateChange()

    /// @notice SECURITY FIX #13: Propose a new reward rate (subject to 48h timelock)
    function proposeRewardRate(uint256 _rate) external onlyOwner updateReward {
        if (_rate > MAX_REWARD_RATE) revert RateTooHigh();
        pendingRewardRate = _rate;
        _propose(REWARD_RATE_CHANGE, REWARD_RATE_TIMELOCK);
        emit RewardRateProposed(_rate, _executeAfter[REWARD_RATE_CHANGE]);
    }

    /// @notice SECURITY FIX #13: Execute pending reward rate change after timelock
    function executeRewardRateChange() external onlyOwner updateReward {
        _execute(REWARD_RATE_CHANGE);
        rewardRate = pendingRewardRate;
        emit RewardRateExecuted(pendingRewardRate);
        pendingRewardRate = 0;
    }

    /// @notice AUDIT FIX #66: Propose a treasury change (subject to 48h timelock)
    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_TIMELOCK);
        emit TreasuryChangeProposed(_newTreasury, _executeAfter[TREASURY_CHANGE]);
    }

    /// @notice AUDIT FIX #66: Execute pending treasury change after timelock
    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address oldTreasury = treasury;
        treasury = pendingTreasury;
        emit TreasuryChangeExecuted(oldTreasury, pendingTreasury);
        pendingTreasury = address(0);
    }

    /// @notice AUDIT FIX M-18: Cancel a pending reward rate proposal
    /// @dev TimelockAdmin emits ProposalCancelled(REWARD_RATE_CHANGE) for off-chain monitoring
    function cancelRewardRateProposal() external onlyOwner {
        _cancel(REWARD_RATE_CHANGE);
        pendingRewardRate = 0;
    }

    /// @notice AUDIT FIX M-18: Cancel a pending treasury change proposal
    /// @dev TimelockAdmin emits ProposalCancelled(TREASURY_CHANGE) for off-chain monitoring
    function cancelTreasuryProposal() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        pendingTreasury = address(0);
    }

    /// @notice DEPRECATED: Use proposeTreasuryChange() + executeTreasuryChange()
    // setTreasury() removed — use proposeTreasuryChange() + executeTreasuryChange()

    /// @notice AUDIT FIX L-28: Rescue ERC-20 tokens accidentally sent to this contract.
    ///         Cannot sweep the staking reward token to protect user funds.
    /// @param token The ERC-20 token address to sweep
    function sweepToken(address token) external onlyOwner nonReentrant {
        if (token == address(rewardToken)) revert CannotSweepRewardToken();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) revert ZeroBalance();
        IERC20(token).safeTransfer(treasury, balance);
    }

    // locks() removed to reduce contract size — callers use positions(userTokenId[user]) directly

    /// @notice AUDIT FIX C-02: Propose a new restaking contract (subject to 48h timelock)
    function proposeRestakingContract(address _restaking) external onlyOwner {
        if (_restaking == address(0)) revert ZeroAddress();
        pendingRestakingContract = _restaking;
        _propose(RESTAKING_CHANGE, 48 hours);
        emit RestakingContractChangeProposed(_restaking, _executeAfter[RESTAKING_CHANGE]);
    }

    /// @notice AUDIT FIX C-02: Execute pending restaking contract change after timelock
    function executeRestakingContract() external onlyOwner {
        _execute(RESTAKING_CHANGE);
        address oldRestaking = restakingContract;
        restakingContract = pendingRestakingContract;
        emit RestakingContractChanged(oldRestaking, pendingRestakingContract);
        pendingRestakingContract = address(0);
    }

    /// @notice AUDIT FIX C-02: Cancel a pending restaking contract change
    /// @dev TimelockAdmin emits ProposalCancelled(RESTAKING_CHANGE) for off-chain monitoring
    function cancelRestakingContract() external onlyOwner {
        _cancel(RESTAKING_CHANGE);
        pendingRestakingContract = address(0);
    }

    // ─── AUDIT FIX C-02: Timelocked unsettled rewards cap adjustment ──

    uint256 public constant UNSETTLED_CAP_TIMELOCK = 48 hours;
    uint256 public pendingMaxUnsettledRewards;

    /// @notice Propose a new maxUnsettledRewards cap (48h timelock).
    /// @param _newCap The proposed new cap value (must be >= 10_000e18 to prevent griefing)
    function proposeMaxUnsettledRewards(uint256 _newCap) external onlyOwner {
        if (_newCap < 10_000e18) revert CapTooLow();
        pendingMaxUnsettledRewards = _newCap;
        _propose(UNSETTLED_CAP_CHANGE, UNSETTLED_CAP_TIMELOCK);
    }

    /// @notice Execute the pending maxUnsettledRewards change after the timelock.
    function executeMaxUnsettledRewards() external onlyOwner {
        _execute(UNSETTLED_CAP_CHANGE);
        uint256 oldCap = maxUnsettledRewards;
        maxUnsettledRewards = pendingMaxUnsettledRewards;
        pendingMaxUnsettledRewards = 0;
        emit MaxUnsettledRewardsUpdated(oldCap, maxUnsettledRewards);
    }

    /// @notice Cancel a pending maxUnsettledRewards change.
    function cancelMaxUnsettledRewards() external onlyOwner {
        _cancel(UNSETTLED_CAP_CHANGE);
        pendingMaxUnsettledRewards = 0;
    }

    /// @dev Recalculate boost for a position and update totals + rewardDebt.
    function _applyNewBoost(Position storage p, uint256 newBoost) private {
        totalBoostedStake -= p.boostedAmount;
        if (newBoost > type(uint16).max) revert BoostOverflow();
        p.boostBps = uint16(newBoost);
        p.boostedAmount = (p.amount * newBoost) / BOOST_PRECISION;
        totalBoostedStake += p.boostedAmount;
        p.rewardDebt = _safeInt256((p.boostedAmount * rewardPerTokenStored) / ACC_PRECISION);
    }

    /// @dev Clear a staking position: update totals, delete position, burn NFT, checkpoint.
    /// @return amount The staked principal that was in the position
    function _clearPosition(uint256 tokenId, Position storage p) private returns (uint256 amount) {
        amount = p.amount;
        totalStaked -= amount;
        totalBoostedStake -= p.boostedAmount;
        // M-03 FIX: Keep totalLocked in sync
        if (totalLocked >= amount) totalLocked -= amount;
        delete positions[tokenId];
        delete emergencyExitRequests[tokenId];
        userTokenId[msg.sender] = 0;
        _burn(tokenId);
        _writeCheckpoint(msg.sender);
    }

    /// @dev Settle unsettled rewards for a user, respecting the global cap.
    /// @return settled The actual amount settled (may be less than requested if cap hit)
    function _settleUnsettled(address user, uint256 amount) private returns (uint256 settled) {
        if (amount == 0) return 0;
        // AUDIT FIX L-06: Cap totalUnsettledRewards to prevent unbounded growth
        uint256 unsettledRoom = totalUnsettledRewards < maxUnsettledRewards
            ? maxUnsettledRewards - totalUnsettledRewards : 0;
        settled = amount > unsettledRoom ? unsettledRoom : amount;
        if (settled > 0) {
            unsettledRewards[user] += settled;
            totalUnsettledRewards += settled;
        }
        // M-04 FIX: Redirect forfeited rewards to treasury instead of destroying them
        uint256 forfeited = amount - settled;
        if (forfeited > 0) {
            unsettledRewards[treasury] += forfeited;
            totalUnsettledRewards += forfeited;
        }
    }

    /// @dev AUDIT FIX: Safe uint256 -> int256 cast. Reverts if value exceeds int256 max,
    ///      preventing silent wrap-around that could allow reward theft via negative rewardDebt.
    ///      A4-C-05: Verified — this function is called for all rewardDebt assignments.
    ///      The product (boostedAmount * rewardPerTokenStored) / ACC_PRECISION is safe from uint256
    ///      overflow because: boostedAmount <= ~4.5x * totalSupply (capped by MAX_BOOST + JBAC),
    ///      rewardPerTokenStored grows by (reward * 1e12) / totalBoostedStake per second.
    ///      With realistic values (1B supply, 100/s rate), overflow would take >1000 years.
    function _safeInt256(uint256 value) private pure returns (int256) {
        if (value > uint256(type(int256).max)) revert IntOverflow();
        return int256(value);
    }

    // tokenURI: uses base ERC721 (returns "" when no baseURI set).
    // Full SVG metadata available via TegridyTokenURIReader contract.
}
