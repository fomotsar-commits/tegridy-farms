// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OwnableNoRenounce} from "../base/OwnableNoRenounce.sol";

/// @dev veTOWELI boost source (TegridyStaking) — read by address, never imported.
interface IStakingBoost {
    function aggregateActiveBoostBps(address user) external view returns (uint256);
}

/// @title  TegridyBoostedLP — V4-native veTOWELI-boosted LP reward module (#3)
/// @notice The V4 rebuild of TegridyLPFarming. V4 has no ERC-20 LP token, so the
///         "balance" is the LP's V4 position liquidity, reported by TegridyV4Hook's
///         liquidity callbacks and amplified by `aggregateActiveBoostBps`. The
///         Synthetix `rewardPerToken` math is copied VERBATIM from TegridyLPFarming;
///         only the balance source changes.
///
/// @dev    Deliberately NOT folded into the immutable core hook — isolated here so
///         the heaviest custom surface (reward accounting) has a smaller blast
///         radius and its own audit. The hook only calls `onLiquidityChange`.
///
/// @dev    v1 scope (see V4_BOOSTED_LP_HOOK_DESIGN.md):
///           - per-LP AGGREGATE liquidity (not per-position)
///           - full-range pools assumed; in-range tick attribution deferred
///           - reward funded by external emissions (`notifyRewardAmount`)
///           - **UNAUDITED.** Built ahead of the audit gate at owner direction.
contract TegridyBoostedLP is OwnableNoRenounce, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_BOOST_BPS = 45_000; // 4.5x ceiling (matches LPFarming)
    uint256 public constant MIN_NOTIFY_AMOUNT = 1e15;
    uint256 public constant MIN_REWARDS_DURATION = 1 days;
    uint256 public constant MAX_REWARDS_DURATION = 365 days;

    IERC20 public immutable rewardToken;
    IStakingBoost public immutable staking;
    address public immutable hook;

    uint256 public rewardRate;
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardsDuration;
    uint256 public rewardPerTokenStored;
    uint256 public totalEffectiveSupply;

    mapping(address => uint256) public liquidityOf; // raw V4 liquidity, summed per LP
    mapping(address => uint256) public effectiveBalanceOf; // boosted
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    error NotHook();
    error NotifyAmountTooSmall();
    error DurationOutOfRange();
    error ZeroAddress();
    error RewardTooHigh();

    event RewardAdded(uint256 amount, uint256 duration);
    event LiquidityChanged(address indexed lp, uint256 rawLiquidity, uint256 effective);
    event RewardPaid(address indexed lp, uint256 amount);

    modifier onlyHook() {
        if (msg.sender != hook) revert NotHook();
        _;
    }

    /// @dev Verbatim Synthetix accrual modifier (TegridyLPFarming).
    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    constructor(address hook_, IERC20 rewardToken_, address staking_, address owner_) OwnableNoRenounce(owner_) {
        if (hook_ == address(0) || address(rewardToken_) == address(0) || staking_ == address(0)) revert ZeroAddress();
        hook = hook_;
        rewardToken = rewardToken_;
        staking = IStakingBoost(staking_);
    }

    // ─── Synthetix views (verbatim from TegridyLPFarming) ─────────────
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

    // ─── Hook-driven balance updates ──────────────────────────────────

    /// @notice Called by the hook on every liquidity add/remove for `lp`. Updates
    ///         the LP's raw liquidity and re-snapshots their current boost.
    function onLiquidityChange(address lp, int256 liquidityDelta) external onlyHook updateReward(lp) {
        uint256 raw = liquidityOf[lp];
        if (liquidityDelta > 0) {
            raw += uint256(liquidityDelta);
        } else if (liquidityDelta < 0) {
            uint256 dec = uint256(-liquidityDelta);
            raw = dec >= raw ? 0 : raw - dec;
        }
        liquidityOf[lp] = raw;
        _resync(lp, raw);
    }

    /// @notice Re-apply `lp`'s current boost (permissionless poke — e.g. after a
    ///         lock extension changes their boost).
    function refreshBoost(address lp) external updateReward(lp) {
        _resync(lp, liquidityOf[lp]);
    }

    function _resync(address lp, uint256 raw) internal {
        uint256 boost = staking.aggregateActiveBoostBps(lp);
        if (boost > MAX_BOOST_BPS) boost = MAX_BOOST_BPS;
        if (boost < BPS) boost = BPS; // base 1x floor for non/low stakers
        uint256 newEff = raw * boost / BPS;
        totalEffectiveSupply = totalEffectiveSupply - effectiveBalanceOf[lp] + newEff;
        effectiveBalanceOf[lp] = newEff;
        emit LiquidityChanged(lp, raw, newEff);
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

    /// @notice Fund a reward period. Owner transfers `amount` of rewardToken in.
    ///         Core Synthetix rate math (verbatim); v1 omits LPFarming's extra
    ///         cooldown/forfeit-residue guards — add before mainnet.
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
        // H-2: never schedule more rewards than the contract holds.
        if (rewardRate * duration > rewardToken.balanceOf(address(this))) revert RewardTooHigh();
        rewardsDuration = duration;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(actual, duration);
    }
}
