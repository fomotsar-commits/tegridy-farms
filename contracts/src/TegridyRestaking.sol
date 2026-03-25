// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITegridyStaking {
    function claim(uint256 tokenId) external;
    function pendingReward(uint256 tokenId) external view returns (uint256);
    function positions(uint256 tokenId) external view returns (
        uint256 amount,
        uint256 boostedAmount,
        int256 rewardDebt,
        uint256 lockEnd,
        uint256 boostBps,
        uint256 lockDuration,
        bool autoMaxLock
    );
}

/// @title TegridyRestaking — Restake your tsTOWELI NFT for additional yield
/// @notice Deposit your TegridyStaking NFT (tsTOWELI) to earn BONUS rewards
///         on top of your base staking rewards.
///
///         How it works:
///         1. You stake TOWELI in TegridyStaking → get tsTOWELI NFT
///         2. You deposit that NFT here → this contract holds it
///         3. You earn base staking rewards (auto-claimed by this contract)
///            PLUS bonus restaking rewards from a separate reward pool
///         4. Withdraw anytime → get your NFT back
///
///         The bonus yield comes from protocol fees, incentive programs,
///         or funded reward pools — separate from base staking emissions.
///
///         Think of it like:
///         - Base staking = earning interest on a savings account
///         - Restaking = lending your savings certificate for extra yield
contract TegridyRestaking is Ownable2Step, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────────────────────
    uint256 private constant ACC_PRECISION = 1e12;

    // ─── State ──────────────────────────────────────────────────────
    IERC20 public immutable rewardToken;       // TOWELI
    IERC20 public immutable bonusRewardToken;  // ETH (WETH) or any ERC20 for bonus
    ITegridyStaking public immutable staking;  // TegridyStaking contract
    IERC721 public immutable stakingNFT;       // tsTOWELI NFT (same address as staking)

    uint256 public bonusRewardPerSecond;
    uint256 public lastBonusRewardTime;
    uint256 public accBonusPerShare;
    uint256 public totalRestaked;              // Sum of all deposited position amounts

    struct RestakeInfo {
        uint256 tokenId;          // The tsTOWELI NFT token ID
        uint256 positionAmount;   // Amount of TOWELI in the position (cached)
        uint256 boostedAmount;    // Boosted amount (cached for reward calc)
        int256 bonusDebt;         // Bonus reward debt
        uint256 depositTime;      // When NFT was deposited
    }

    mapping(address => RestakeInfo) public restakers;
    mapping(uint256 => address) public tokenIdToRestaker; // reverse lookup

    uint256 public totalBonusFunded;
    uint256 public totalBonusDistributed;

    // ─── Events ─────────────────────────────────────────────────────
    event Restaked(address indexed user, uint256 indexed tokenId, uint256 positionAmount);
    event Unrestaked(address indexed user, uint256 indexed tokenId);
    event BonusClaimed(address indexed user, uint256 bonusAmount);
    event BaseClaimed(address indexed user, uint256 baseAmount);
    event BonusFunded(uint256 amount);
    event BonusRateUpdated(uint256 newRate);

    // ─── Errors ─────────────────────────────────────────────────────
    error NotRestaked();
    error AlreadyRestaked();
    error NotNFTOwner();
    error InvalidNFT();
    error ZeroAmount();

    // ─── Constructor ────────────────────────────────────────────────
    constructor(
        address _staking,
        address _rewardToken,
        address _bonusRewardToken,
        uint256 _bonusRewardPerSecond
    ) Ownable(msg.sender) {
        staking = ITegridyStaking(_staking);
        stakingNFT = IERC721(_staking); // TegridyStaking IS the ERC721
        rewardToken = IERC20(_rewardToken);
        bonusRewardToken = IERC20(_bonusRewardToken);
        bonusRewardPerSecond = _bonusRewardPerSecond;
        lastBonusRewardTime = block.timestamp;
    }

    // ─── Modifiers ──────────────────────────────────────────────────
    modifier updateBonus() {
        if (block.timestamp > lastBonusRewardTime && totalRestaked > 0) {
            uint256 elapsed = block.timestamp - lastBonusRewardTime;
            uint256 reward = elapsed * bonusRewardPerSecond;
            uint256 available = bonusRewardToken.balanceOf(address(this));
            if (reward > available) reward = available;
            if (reward > 0) {
                accBonusPerShare += (reward * ACC_PRECISION) / totalRestaked;
            }
        }
        lastBonusRewardTime = block.timestamp;
        _;
    }

    // ─── View Functions ─────────────────────────────────────────────

    /// @notice Check pending bonus rewards for a user
    function pendingBonus(address _user) public view returns (uint256) {
        RestakeInfo memory info = restakers[_user];
        if (info.tokenId == 0) return 0;

        uint256 currentAcc = accBonusPerShare;
        if (block.timestamp > lastBonusRewardTime && totalRestaked > 0) {
            uint256 elapsed = block.timestamp - lastBonusRewardTime;
            uint256 reward = elapsed * bonusRewardPerSecond;
            uint256 available = bonusRewardToken.balanceOf(address(this));
            if (reward > available) reward = available;
            currentAcc += (reward * ACC_PRECISION) / totalRestaked;
        }

        // NOTE: Bonus is intentionally calculated on positionAmount (raw staked amount),
        // not boostedAmount. Boost multipliers affect base staking rewards only.
        // Restaking bonus rewards are distributed proportionally to raw TOWELI committed,
        // so a user who locks 1000 TOWELI for 7 days earns the same bonus rate as one
        // who locks 1000 TOWELI for 4 years. This is fair because both committed the same
        // capital — the lock duration bonus is already reflected in base staking APY.
        int256 accumulated = int256((info.positionAmount * currentAcc) / ACC_PRECISION);
        return uint256(accumulated - info.bonusDebt);
    }

    /// @notice Check pending base staking rewards for the deposited NFT
    function pendingBase(address _user) public view returns (uint256) {
        RestakeInfo memory info = restakers[_user];
        if (info.tokenId == 0) return 0;
        return staking.pendingReward(info.tokenId);
    }

    /// @notice Total pending rewards (base + bonus) for display
    function pendingTotal(address _user) external view returns (uint256 base, uint256 bonus) {
        base = pendingBase(_user);
        bonus = pendingBonus(_user);
    }

    // ─── User Functions ─────────────────────────────────────────────

    /// @notice Deposit your tsTOWELI NFT to earn bonus yield
    /// @dev Transfers the NFT from caller to this contract
    function restake(uint256 _tokenId) external nonReentrant updateBonus {
        if (restakers[msg.sender].tokenId != 0) revert AlreadyRestaked();

        // Verify caller owns the NFT
        if (stakingNFT.ownerOf(_tokenId) != msg.sender) revert NotNFTOwner();

        // Get position data from TegridyStaking
        (uint256 amount, uint256 boostedAmount,,,,, ) = staking.positions(_tokenId);
        if (amount == 0) revert ZeroAmount();

        // Transfer NFT to this contract
        stakingNFT.transferFrom(msg.sender, address(this), _tokenId);

        // Record restaking info
        restakers[msg.sender] = RestakeInfo({
            tokenId: _tokenId,
            positionAmount: amount,
            boostedAmount: boostedAmount,
            bonusDebt: int256((amount * accBonusPerShare) / ACC_PRECISION),
            depositTime: block.timestamp
        });

        tokenIdToRestaker[_tokenId] = msg.sender;
        totalRestaked += amount;

        emit Restaked(msg.sender, _tokenId, amount);
    }

    /// @notice Claim base staking rewards + bonus restaking rewards
    function claimAll() external nonReentrant updateBonus {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        // 1. Claim base rewards from TegridyStaking
        uint256 baseBefore = rewardToken.balanceOf(address(this));
        staking.claim(info.tokenId);
        uint256 baseEarned = rewardToken.balanceOf(address(this)) - baseBefore;

        // Forward base rewards to user
        if (baseEarned > 0) {
            rewardToken.safeTransfer(msg.sender, baseEarned);
            emit BaseClaimed(msg.sender, baseEarned);
        }

        // 2. Claim bonus rewards
        int256 accumulated = int256((info.positionAmount * accBonusPerShare) / ACC_PRECISION);
        uint256 bonusPending = uint256(accumulated - info.bonusDebt);
        info.bonusDebt = accumulated;

        if (bonusPending > 0) {
            bonusRewardToken.safeTransfer(msg.sender, bonusPending);
            totalBonusDistributed += bonusPending;
            emit BonusClaimed(msg.sender, bonusPending);
        }
    }

    /// @notice Withdraw your NFT and stop restaking
    function unrestake() external nonReentrant updateBonus {
        RestakeInfo storage info = restakers[msg.sender];
        if (info.tokenId == 0) revert NotRestaked();

        uint256 tokenId = info.tokenId;

        // Claim any remaining base rewards first (only if there are pending rewards)
        uint256 baseBefore = rewardToken.balanceOf(address(this));
        uint256 pending = staking.pendingReward(tokenId);
        if (pending > 0) {
            staking.claim(tokenId);
        }
        uint256 baseEarned = rewardToken.balanceOf(address(this)) - baseBefore;
        if (baseEarned > 0) {
            rewardToken.safeTransfer(msg.sender, baseEarned);
            emit BaseClaimed(msg.sender, baseEarned);
        }

        // Claim bonus rewards
        int256 accumulated = int256((info.positionAmount * accBonusPerShare) / ACC_PRECISION);
        uint256 bonusPending = uint256(accumulated - info.bonusDebt);
        if (bonusPending > 0) {
            bonusRewardToken.safeTransfer(msg.sender, bonusPending);
            totalBonusDistributed += bonusPending;
            emit BonusClaimed(msg.sender, bonusPending);
        }

        // Update state
        totalRestaked -= info.positionAmount;
        delete tokenIdToRestaker[tokenId];
        delete restakers[msg.sender];

        // Return NFT to user
        stakingNFT.transferFrom(address(this), msg.sender, tokenId);

        emit Unrestaked(msg.sender, tokenId);
    }

    // ─── Admin ──────────────────────────────────────────────────────

    /// @notice Fund the bonus reward pool
    function fundBonus(uint256 _amount) external {
        if (_amount == 0) revert ZeroAmount();
        bonusRewardToken.safeTransferFrom(msg.sender, address(this), _amount);
        totalBonusFunded += _amount;
        emit BonusFunded(_amount);
    }

    /// @notice Update bonus reward rate
    function setBonusRewardPerSecond(uint256 _rate) external onlyOwner updateBonus {
        bonusRewardPerSecond = _rate;
        emit BonusRateUpdated(_rate);
    }

    // ─── ERC721 Receiver ────────────────────────────────────────────

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
