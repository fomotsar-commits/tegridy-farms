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
    /// @dev Anti-sandwich gate between successive reward notifications (V2
    ///      `TegridyLPFarming` F-93-2, ported verbatim). 24h prices out the
    ///      mempool-watching re-notify rate-jack while staying weekly-cadence friendly.
    uint256 public constant NOTIFY_COOLDOWN = 24 hours;

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
    uint256 public lastNotifyTime; // F-93-2: timestamp of last notify, for NOTIFY_COOLDOWN

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
    error NotifyCooldownActive();
    error DirectNFTTransferNotAllowed();

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

    // AUDIT 2026-05-31 [slither reentrancy-no-eth FP]: function is `nonReentrant`, and uses
    // ERC-721 `transferFrom` (NOT `safeTransferFrom` — no onERC721Received callback) against
    // Uniswap's canonical PositionManager. The post-transfer `_resync`/balance writes cannot
    // be re-entered. The pre-transfer pool/range/liquidity checks already validate the NFT.
    // slither-disable-next-line reentrancy-no-eth
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
        _resync(msg.sender, false);
        emit Deposited(msg.sender, tokenId, liq);
    }

    function withdraw(uint256 tokenId) external nonReentrant updateReward(msg.sender) {
        if (depositorOf[tokenId] != msg.sender) revert NotDepositor();
        uint256 liq = positionLiquidity[tokenId];
        delete depositorOf[tokenId];
        delete positionLiquidity[tokenId];
        liquidityOf[msg.sender] -= liq;
        _resync(msg.sender, true);
        positionManager.safeTransferFrom(address(this), msg.sender, tokenId);
        emit Withdrawn(msg.sender, tokenId, liq);
    }

    /// @notice Re-apply `lp`'s current boost (permissionless poke).
    function refreshBoost(address lp) external updateReward(lp) {
        _resync(lp, false);
    }

    /// @dev The active-boost read, made NON-REVERTING. (2026-08-27, principal-trap fix)
    ///
    ///      A staker's escrowed LP NFT must be withdrawable regardless of the boost
    ///      oracle's state. Synthetix `StakingRewards.withdraw` touches nothing external
    ///      but the staking-token transfer; here `withdraw` calls `_resync`, and if the
    ///      boost read reverted (staking paused, a checkpoint bug, a future ABI break)
    ///      `_resync` reverted and the NFT — the user's own principal — was TRAPPED.
    ///
    ///      A failed read now degrades to the 1x floor (no boost). That UNDER-credits
    ///      the account, which is the safe direction (it can never over-pay the pool),
    ///      and it self-heals: the next `refreshBoost`/`deposit`/`withdraw` re-reads a
    ///      healthy oracle. The one guarantee that matters — the NFT comes back — now
    ///      holds unconditionally.
    ///      TOLERANCE IS SCOPED TO THE SELF-EXIT PATH. (2026-08-27, hardened)
    ///      `tolerant` is true ONLY on `withdraw`, where msg.sender is removing THEIR
    ///      OWN position and the guarantee that matters is the NFT coming back. It is
    ///      false on `deposit` and `refreshBoost`.
    ///
    ///      Why not tolerant everywhere: `refreshBoost(lp)` is PERMISSIONLESS and can
    ///      target any account. If it degraded on an oracle revert, a stranger could
    ///      call `refreshBoost(victim)` during an oracle outage to drop the victim's
    ///      boost to 1x while keeping their own stale-high — deflating the victim's
    ///      FUTURE accrual and skimming the shared stream onto themselves. That is the
    ///      exact permissionless-write + degraded-read diversion the v2 distributor was
    ///      refactored to kill. So the non-exit paths REVERT on an oracle failure: a
    ///      failed `refreshBoost` is a harmless no-op that leaves the victim untouched,
    ///      and a failed `deposit` reverts atomically (the caller keeps their NFT and
    ///      retries). Only the caller's own exit is allowed to proceed on a bad read.
    function _activeBoostBps(address lp, bool tolerant) internal view returns (uint256 boost) {
        if (tolerant) {
            try staking.aggregateActiveBoostBps(lp) returns (uint256 b) {
                boost = b;
            } catch {
                boost = BPS; // 1x floor on a failed read — never trap the exiting position
            }
        } else {
            // Non-exit paths: a revert propagates, so no permissionless caller can
            // move another account's boost by forcing (or exploiting) an oracle failure.
            boost = staking.aggregateActiveBoostBps(lp);
        }
        if (boost > MAX_BOOST_BPS) boost = MAX_BOOST_BPS;
        if (boost < BPS) boost = BPS; // 1x floor
    }

    function _resync(address lp, bool tolerant) internal {
        uint256 raw = liquidityOf[lp];
        uint256 newEff = raw * _activeBoostBps(lp, tolerant) / BPS;
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
        // F-93-2 (ported from V2 TegridyLPFarming): cooldown gate against a same-block /
        // same-mempool re-notify that could compound a rate jack. Skipped on the
        // first-ever call (lastNotifyTime == 0) so initial funding can land.
        if (lastNotifyTime != 0 && block.timestamp < lastNotifyTime + NOTIFY_COOLDOWN) {
            revert NotifyCooldownActive();
        }
        uint256 balBefore = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 actual = rewardToken.balanceOf(address(this)) - balBefore;
        // DELIBERATE DIVERGENCE from V2 TegridyLPFarming (audit L-3): LPFarming captures
        // the integer-division residue (`budget - rate*duration`, < `duration` wei/cycle)
        // into a `forfeitedRewards` bucket reclaimable by the owner. There it is worth it
        // because that bucket's PRIMARY feed is emergencyWithdraw forfeitures (real value).
        // This staker has NO reward-forfeiting withdraw, so the bucket would only ever hold
        // sub-nano truncation dust — recovering it would mean adding an owner token-mover
        // (`reclaimForfeitedRewards`), i.e. exactly the rug-surface L-3 rejected. So the
        // dust is left stranded by design; no capture, no reclaim.
        if (block.timestamp >= periodFinish) {
            rewardRate = actual / duration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (leftover + actual) / duration;
        }
        // H-2: canonical Synthetix solvency bound — never schedule more than is held.
        // AUDIT 2026-05-31 [slither divide-before-multiply FP]: verbatim Synthetix
        // StakingRewards pattern — rewardRate is intentionally floored by the `/ duration`
        // division, and this `rewardRate * duration <= balance` check deliberately validates
        // the FLOORED rate against the balance (the rounding is in the protocol's favour).
        // slither-disable-next-line divide-before-multiply
        if (rewardRate * duration > rewardToken.balanceOf(address(this))) revert RewardTooHigh();
        rewardsDuration = duration;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        lastNotifyTime = block.timestamp; // F-93-2
        emit RewardAdded(actual, duration);
    }

    /// @dev AUDIT FIX 2026-05-31 [LOW-1]: positions MUST be staked via `deposit()`
    ///      (approve + `transferFrom`), which records the depositor and credits
    ///      liquidity. `deposit()` uses plain `transferFrom`, which does NOT invoke
    ///      this hook, so the happy path is unaffected. A raw `safeTransferFrom`
    ///      straight to this contract would otherwise escrow an NFT with NO depositor
    ///      and NO recovery path (orphaned forever) — so reject it: the transfer
    ///      reverts and the NFT stays with its owner instead of being stranded.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert DirectNFTTransferNotAllowed();
    }
}
