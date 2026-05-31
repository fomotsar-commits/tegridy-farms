// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OwnableNoRenounce} from "../base/OwnableNoRenounce.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";

/// @dev veTOWELI boost source (TegridyStaking).
interface IStakingBoost {
    function aggregateActiveBoostBps(address user) external view returns (uint256);
}

/// @dev V4 PositionManager — escrowed NFT + its liquidity + pool/tick info.
interface IPositionMgr {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity);
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory, PositionInfo);
}

/// @title  TegridyBoostedLPStaker — #3 boosted-LP rewards, NFT-staker model (Part B)
/// @notice The CANONICAL #3 path (see V4_TRUSTED_ROUTER_DESIGN.md Part B). A V4 hook
///         can't attribute liquidity to the end user when liquidity is routed through
///         the PositionManager (`sender` = PM). So instead: the user DEPOSITS their V4
///         PositionManager NFT here; this contract escrows it and attributes rewards to
///         the depositor — a provable identity, no router, no hookData, no spoofing.
///         (Aerodrome/Curve gauge model; the V2 `TegridyLPFarming` analog for V4.)
///
/// @dev    Reward math is the Synthetix `rewardPerToken` pattern, copied verbatim from
///         the V2 `TegridyLPFarming`; the balance is the escrowed position's
///         liquidity × `aggregateActiveBoostBps`. While escrowed, only this contract
///         owns the NFT, so the position's liquidity cannot change → caching it at
///         deposit is safe.
///
/// @dev    This is the SOLE #3 path. The earlier hook-callback alternative
///         (`TegridyBoostedLP`) was DELETED (audit M-3) to remove the double-count
///         foot-gun and shrink the hook's hot path. v1: emissions-funded. **UNAUDITED.**
contract TegridyBoostedLPStaker is OwnableNoRenounce, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using PositionInfoLibrary for PositionInfo;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_BOOST_BPS = 45_000; // 4.5x ceiling (matches LPFarming)
    uint256 public constant MIN_NOTIFY_AMOUNT = 1e15;
    uint256 public constant MIN_REWARDS_DURATION = 1 days;
    uint256 public constant MAX_REWARDS_DURATION = 365 days;

    IERC20 public immutable rewardToken;
    IStakingBoost public immutable staking;
    IPositionMgr public immutable positionManager;
    /// @notice The ONLY pool whose positions may be staked here (C-1 fix). A
    ///         position from any other pool — or a worthless pair an attacker
    ///         controls — is rejected, so emissions always have real backing.
    bytes32 public immutable allowedPoolId;

    uint256 public rewardRate;
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardsDuration;
    uint256 public rewardPerTokenStored;
    uint256 public totalEffectiveSupply;

    mapping(address => uint256) public liquidityOf; // raw escrowed liquidity, per depositor
    mapping(address => uint256) public effectiveBalanceOf; // boosted
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;
    mapping(uint256 => address) public depositorOf; // tokenId → depositor
    mapping(uint256 => uint256) public positionLiquidity; // tokenId → cached liquidity

    error ZeroAddress();
    error NotDepositor();
    error NoLiquidity();
    error NotifyAmountTooSmall();
    error DurationOutOfRange();
    error WrongPool();
    error NotFullRange();
    error RewardTooHigh();

    event Deposited(address indexed lp, uint256 indexed tokenId, uint256 liquidity);
    event Withdrawn(address indexed lp, uint256 indexed tokenId, uint256 liquidity);
    event RewardAdded(uint256 amount, uint256 duration);
    event RewardPaid(address indexed lp, uint256 amount);

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    constructor(IERC20 rewardToken_, address staking_, address positionManager_, bytes32 allowedPoolId_, address owner_)
        OwnableNoRenounce(owner_)
    {
        if (address(rewardToken_) == address(0) || staking_ == address(0) || positionManager_ == address(0)) {
            revert ZeroAddress();
        }
        if (allowedPoolId_ == bytes32(0)) revert WrongPool();
        rewardToken = rewardToken_;
        staking = IStakingBoost(staking_);
        positionManager = IPositionMgr(positionManager_);
        allowedPoolId = allowedPoolId_;
    }

    // ─── Synthetix views (verbatim) ───────────────────────────────────
    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalEffectiveSupply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored
            + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18 / totalEffectiveSupply);
    }

    function earned(address account) public view returns (uint256) {
        return (effectiveBalanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account]) / 1e18)
            + rewards[account];
    }

    // ─── Deposit / withdraw the V4 position NFT ───────────────────────

    function deposit(uint256 tokenId) external nonReentrant updateReward(msg.sender) {
        // C-1: the position MUST belong to the canonical pool, else an attacker
        //      could stake a junk/foreign-pool NFT and farm emissions for free.
        (PoolKey memory pk, PositionInfo info) = positionManager.getPoolAndPositionInfo(tokenId);
        if (PoolId.unwrap(pk.toId()) != allowedPoolId) revert WrongPool();
        // C-1 (cont.): v1 accepts only FULL-RANGE positions, so out-of-range
        //      positions with huge `liquidity` units but ~0 capital can't farm.
        int24 spacing = pk.tickSpacing;
        if (info.tickLower() != TickMath.minUsableTick(spacing) || info.tickUpper() != TickMath.maxUsableTick(spacing)) {
            revert NotFullRange();
        }
        uint256 liq = positionManager.getPositionLiquidity(tokenId);
        if (liq == 0) revert NoLiquidity();
        // Pull the NFT (caller must have approved this contract).
        positionManager.transferFrom(msg.sender, address(this), tokenId);
        depositorOf[tokenId] = msg.sender;
        positionLiquidity[tokenId] = liq;
        liquidityOf[msg.sender] += liq;
        _resync(msg.sender);
        emit Deposited(msg.sender, tokenId, liq);
    }

    function withdraw(uint256 tokenId) external nonReentrant updateReward(msg.sender) {
        if (depositorOf[tokenId] != msg.sender) revert NotDepositor();
        uint256 liq = positionLiquidity[tokenId];
        delete depositorOf[tokenId];
        delete positionLiquidity[tokenId];
        liquidityOf[msg.sender] -= liq;
        _resync(msg.sender);
        positionManager.safeTransferFrom(address(this), msg.sender, tokenId);
        emit Withdrawn(msg.sender, tokenId, liq);
    }

    /// @notice Re-apply `lp`'s current boost (permissionless poke).
    function refreshBoost(address lp) external updateReward(lp) {
        _resync(lp);
    }

    function _resync(address lp) internal {
        uint256 raw = liquidityOf[lp];
        uint256 boost = staking.aggregateActiveBoostBps(lp);
        if (boost > MAX_BOOST_BPS) boost = MAX_BOOST_BPS;
        if (boost < BPS) boost = BPS; // 1x floor
        uint256 newEff = raw * boost / BPS;
        totalEffectiveSupply = totalEffectiveSupply - effectiveBalanceOf[lp] + newEff;
        effectiveBalanceOf[lp] = newEff;
    }

    // ─── Claim + funding ──────────────────────────────────────────────

    function getReward() external nonReentrant updateReward(msg.sender) {
        uint256 r = rewards[msg.sender];
        if (r > 0) {
            rewards[msg.sender] = 0;
            rewardToken.safeTransfer(msg.sender, r);
            emit RewardPaid(msg.sender, r);
        }
    }

    function notifyRewardAmount(uint256 amount, uint256 duration)
        external
        onlyOwner
        nonReentrant
        updateReward(address(0))
    {
        if (amount < MIN_NOTIFY_AMOUNT) revert NotifyAmountTooSmall();
        if (duration < MIN_REWARDS_DURATION || duration > MAX_REWARDS_DURATION) revert DurationOutOfRange();
        uint256 balBefore = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 actual = rewardToken.balanceOf(address(this)) - balBefore;
        if (block.timestamp >= periodFinish) {
            rewardRate = actual / duration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (leftover + actual) / duration;
        }
        // H-2: canonical Synthetix solvency bound — never schedule more than is held.
        if (rewardRate * duration > rewardToken.balanceOf(address(this))) revert RewardTooHigh();
        rewardsDuration = duration;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(actual, duration);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
