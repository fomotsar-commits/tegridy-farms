// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TegridyStaking — Unified Lock + Stake + Boost + Governance + NFT Positions
/// @notice Single contract replacing TegridyFarm + VotingEscrow.
///
///         Features:
///         1. Lock TOWELI for 7 days to 4 years → boost from 0.4x to 4.0x (linear)
///         2. JBAC NFT holders get +0.5x bonus boost
///         3. Each staking position is an ERC721 NFT — tradeable on secondary markets
///         4. Auto-max-lock: opt in to keep max boost perpetually
///         5. Early withdrawal: 25% penalty (always available), goes to remaining stakers
///         6. Voting power = amount × boost (for governance)
///
///         NFT Positions:
///         - Each stake mints an NFT to the staker
///         - Transferring the NFT transfers the entire staking position
///         - Buyer of an NFT inherits the lock, boost, and rewards
///         - This means users can sell their locked position instead of paying the 25% penalty
contract TegridyStaking is ERC721, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ────────────────────────────────────────────────────

    uint256 public constant MIN_LOCK_DURATION = 7 days;
    uint256 public constant MAX_LOCK_DURATION = 4 * 365 days;
    uint256 public constant MIN_BOOST_BPS = 4000;   // 0.4x
    uint256 public constant MAX_BOOST_BPS = 40000;  // 4.0x
    uint256 public constant BOOST_PRECISION = 10000;
    uint256 public constant EARLY_WITHDRAWAL_PENALTY_BPS = 2500; // 25%
    uint256 public constant JBAC_BONUS_BPS = 5000; // +0.5x
    uint256 public constant BPS = 10000;
    uint256 private constant ACC_PRECISION = 1e12;

    // ─── State ────────────────────────────────────────────────────────

    IERC20 public immutable rewardToken;
    IERC721 public immutable jbacNFT;
    address public treasury;

    uint256 public rewardPerSecond;
    uint256 public lastRewardTime;
    uint256 public accRewardPerShare;
    uint256 public totalBoostedStake;
    uint256 public totalStaked;
    uint256 public totalLocked;

    uint256 private _nextTokenId = 1;

    struct Position {
        uint256 amount;
        uint256 boostedAmount;
        int256 rewardDebt;
        uint256 lockEnd;
        uint256 boostBps;
        uint256 lockDuration;
        bool autoMaxLock;  // If true, lock auto-extends to max on every interaction
    }

    mapping(uint256 => Position) public positions; // tokenId => position
    mapping(address => uint256) public userTokenId; // user => their tokenId (0 = no position)

    uint256 public totalPenaltiesCollected;
    uint256 public totalPenaltiesRedistributed;
    uint256 public totalRewardsFunded;

    // ─── Events ───────────────────────────────────────────────────────

    event Staked(address indexed user, uint256 indexed tokenId, uint256 amount, uint256 lockDuration, uint256 boostBps);
    event Withdrawn(address indexed user, uint256 indexed tokenId, uint256 amount);
    event EarlyWithdrawn(address indexed user, uint256 indexed tokenId, uint256 amount, uint256 penalty);
    event Claimed(address indexed user, uint256 indexed tokenId, uint256 reward);
    event AutoMaxLockToggled(uint256 indexed tokenId, bool enabled);
    event Funded(uint256 amount);
    event RewardRateUpdated(uint256 newRate);

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error LockTooShort();
    error LockTooLong();
    error AlreadyStaked();
    error NoPosition();
    error NotPositionOwner();
    error LockNotExpired();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(
        address _rewardToken,
        address _jbacNFT,
        address _treasury,
        uint256 _rewardPerSecond
    ) ERC721("Tegridy Staking Position", "tsTOWELI") Ownable(msg.sender) {
        if (_rewardToken == address(0) || _jbacNFT == address(0) || _treasury == address(0)) revert ZeroAddress();
        rewardToken = IERC20(_rewardToken);
        jbacNFT = IERC721(_jbacNFT);
        treasury = _treasury;
        rewardPerSecond = _rewardPerSecond;
        lastRewardTime = block.timestamp;
    }

    // ─── View Functions ───────────────────────────────────────────────

    /// @notice Calculate boost for a lock duration (linear: 0.4x at 7d, 4.0x at 4yr)
    function calculateBoost(uint256 _duration) public pure returns (uint256) {
        if (_duration <= MIN_LOCK_DURATION) return MIN_BOOST_BPS;
        if (_duration >= MAX_LOCK_DURATION) return MAX_BOOST_BPS;
        uint256 range = MAX_LOCK_DURATION - MIN_LOCK_DURATION;
        uint256 boostRange = MAX_BOOST_BPS - MIN_BOOST_BPS;
        uint256 elapsed = _duration - MIN_LOCK_DURATION;
        return MIN_BOOST_BPS + (elapsed * boostRange) / range;
    }

    /// @notice Voting power for governance = amount × boost (including JBAC bonus)
    function votingPowerOf(address user) public view returns (uint256) {
        uint256 tokenId = userTokenId[user];
        if (tokenId == 0) return 0;
        Position memory p = positions[tokenId];
        if (p.amount == 0 || block.timestamp >= p.lockEnd) return 0;
        return (p.amount * p.boostBps) / BOOST_PRECISION;
    }

    /// @notice Pending rewards for a position
    function pendingReward(uint256 tokenId) public view returns (uint256) {
        Position memory p = positions[tokenId];
        if (p.boostedAmount == 0) return 0;
        uint256 currentAcc = accRewardPerShare;
        if (block.timestamp > lastRewardTime && totalBoostedStake > 0) {
            uint256 elapsed = block.timestamp - lastRewardTime;
            uint256 reward = elapsed * rewardPerSecond;
            uint256 available = rewardToken.balanceOf(address(this));
            if (available > totalStaked) {
                uint256 rewardPool = available - totalStaked;
                if (reward > rewardPool) reward = rewardPool;
            } else {
                reward = 0;
            }
            currentAcc += (reward * ACC_PRECISION) / totalBoostedStake;
        }
        int256 accumulated = int256((p.boostedAmount * currentAcc) / ACC_PRECISION);
        return uint256(accumulated - p.rewardDebt);
    }

    /// @notice Pending rewards by user address
    function pendingRewardOf(address user) external view returns (uint256) {
        uint256 tokenId = userTokenId[user];
        if (tokenId == 0) return 0;
        return pendingReward(tokenId);
    }

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

    modifier updateRewards() {
        if (block.timestamp > lastRewardTime && totalBoostedStake > 0) {
            uint256 elapsed = block.timestamp - lastRewardTime;
            uint256 reward = elapsed * rewardPerSecond;
            uint256 available = rewardToken.balanceOf(address(this));
            if (available > totalStaked) {
                uint256 rewardPool = available - totalStaked;
                if (reward > rewardPool) reward = rewardPool;
            } else {
                reward = 0;
            }
            if (reward > 0) {
                accRewardPerShare += (reward * ACC_PRECISION) / totalBoostedStake;
            }
        }
        lastRewardTime = block.timestamp;
        _;
    }

    // ─── User Functions ───────────────────────────────────────────────

    /// @notice Stake TOWELI. Mints an NFT representing the position.
    function stake(uint256 _amount, uint256 _lockDuration) external nonReentrant updateRewards {
        if (_amount == 0) revert ZeroAmount();
        if (_lockDuration < MIN_LOCK_DURATION) revert LockTooShort();
        if (_lockDuration > MAX_LOCK_DURATION) revert LockTooLong();
        if (userTokenId[msg.sender] != 0) revert AlreadyStaked();

        uint256 boost = calculateBoost(_lockDuration);
        if (jbacNFT.balanceOf(msg.sender) > 0) {
            boost += JBAC_BONUS_BPS;
        }
        uint256 boosted = (_amount * boost) / BOOST_PRECISION;

        uint256 tokenId = _nextTokenId++;
        positions[tokenId] = Position({
            amount: _amount,
            boostedAmount: boosted,
            rewardDebt: int256((boosted * accRewardPerShare) / ACC_PRECISION),
            lockEnd: block.timestamp + _lockDuration,
            boostBps: boost,
            lockDuration: _lockDuration,
            autoMaxLock: false
        });

        userTokenId[msg.sender] = tokenId;
        totalStaked += _amount;
        totalBoostedStake += boosted;
        totalLocked += _amount;

        _mint(msg.sender, tokenId);
        rewardToken.safeTransferFrom(msg.sender, address(this), _amount);

        emit Staked(msg.sender, tokenId, _amount, _lockDuration, boost);
    }

    /// @notice Toggle auto-max-lock. When enabled, lock auto-extends on every claim.
    function toggleAutoMaxLock(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        p.autoMaxLock = !p.autoMaxLock;

        // If enabling, extend lock to max immediately
        if (p.autoMaxLock) {
            p.lockEnd = block.timestamp + MAX_LOCK_DURATION;
            p.lockDuration = MAX_LOCK_DURATION;
            // Recalculate boost at max
            uint256 newBoost = MAX_BOOST_BPS;
            if (jbacNFT.balanceOf(msg.sender) > 0) {
                newBoost += JBAC_BONUS_BPS;
            }
            totalBoostedStake -= p.boostedAmount;
            p.boostBps = newBoost;
            p.boostedAmount = (p.amount * newBoost) / BOOST_PRECISION;
            totalBoostedStake += p.boostedAmount;
        }

        emit AutoMaxLockToggled(tokenId, p.autoMaxLock);
    }

    /// @notice Withdraw after lock expires. No penalty.
    function withdraw(uint256 tokenId) external nonReentrant updateRewards {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();
        if (block.timestamp < p.lockEnd) revert LockNotExpired();

        _claimRewards(tokenId, p);

        uint256 amount = p.amount;
        totalStaked -= amount;
        totalBoostedStake -= p.boostedAmount;
        totalLocked -= amount;

        delete positions[tokenId];
        userTokenId[msg.sender] = 0;
        _burn(tokenId);

        rewardToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, tokenId, amount);
    }

    /// @notice Early withdrawal — 25% penalty redistributed to remaining stakers.
    function earlyWithdraw(uint256 tokenId) external nonReentrant updateRewards {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();

        _claimRewards(tokenId, p);

        uint256 amount = p.amount;
        uint256 penalty = (amount * EARLY_WITHDRAWAL_PENALTY_BPS) / BPS;
        uint256 userReceives = amount - penalty;

        totalStaked -= amount;
        totalBoostedStake -= p.boostedAmount;
        totalLocked -= amount;
        totalPenaltiesCollected += penalty;

        delete positions[tokenId];
        userTokenId[msg.sender] = 0;
        _burn(tokenId);

        // Penalty stays in contract as additional rewards for remaining stakers
        // It's already in the contract balance, so it'll be distributed via accRewardPerShare
        totalPenaltiesRedistributed += penalty;

        rewardToken.safeTransfer(msg.sender, userReceives);
        emit EarlyWithdrawn(msg.sender, tokenId, userReceives, penalty);
    }

    /// @notice Claim rewards without unstaking.
    function claim(uint256 tokenId) external nonReentrant updateRewards {
        if (ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        Position storage p = positions[tokenId];
        if (p.amount == 0) revert NoPosition();

        _claimRewards(tokenId, p);

        // Auto-max-lock: extend lock on every claim
        if (p.autoMaxLock) {
            p.lockEnd = block.timestamp + MAX_LOCK_DURATION;
        }
    }

    // ─── NFT Transfer Override ────────────────────────────────────────

    /// @dev When the NFT is transferred, update the userTokenId mapping
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);

        // Update ownership tracking
        if (from != address(0)) {
            userTokenId[from] = 0;
        }
        if (to != address(0)) {
            userTokenId[to] = tokenId;
        }

        return from;
    }

    // ─── Internal ─────────────────────────────────────────────────────

    function _claimRewards(uint256 tokenId, Position storage p) internal {
        int256 accumulated = int256((p.boostedAmount * accRewardPerShare) / ACC_PRECISION);
        uint256 pending = uint256(accumulated - p.rewardDebt);
        p.rewardDebt = accumulated;

        if (pending > 0) {
            rewardToken.safeTransfer(ownerOf(tokenId), pending);
            emit Claimed(ownerOf(tokenId), tokenId, pending);
        }
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function fund(uint256 _amount) external {
        rewardToken.safeTransferFrom(msg.sender, address(this), _amount);
        totalRewardsFunded += _amount;
        emit Funded(_amount);
    }

    function setRewardPerSecond(uint256 _rate) external onlyOwner updateRewards {
        rewardPerSecond = _rate;
        emit RewardRateUpdated(_rate);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }
}
