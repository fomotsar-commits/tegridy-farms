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
    // AUDIT H-1 (2026-04-20): Position struct extended with jbacTokenId + jbacDeposited.
    function positions(uint256 tokenId) external view returns (
        uint256 amount,
        uint256 boostedAmount,
        int256 rewardDebt,
        uint64 lockEnd,
        uint16 boostBps,
        uint32 lockDuration,
        bool autoMaxLock,
        bool hasJbacBoost,
        uint64 stakeTimestamp,
        uint256 jbacTokenId,
        bool jbacDeposited
    );
    // AUDIT H12: amount-weighted active boost across all of user's positions.
    function aggregateActiveBoostBps(address user) external view returns (uint256);
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
    // AUDIT FIX FRESH-2026 (post-fix scan3 C-1): tightened from 100e18 to 1e18
    //         to align with TegridyStaking's matching cap (Wave A F-35-2). Pre-fix
    //         the 100e18 ceiling was ~315%/yr — emergency-only, not sustainable.
    //         1e18 ≈ 31%/yr matches the sister contract; sibling-canonical port.
    uint256 public constant MAX_REWARD_RATE = 1e18;       // Cap: 1 TOWELI/sec (~31%/yr)
    uint256 public constant MAX_REWARDS_DURATION = 90 days;
    uint256 public constant MIN_REWARDS_DURATION = 1 days;
    uint256 public constant MIN_NOTIFY_AMOUNT = 1000e18;
    uint256 public constant BOOST_PRECISION = 10000;        // Matches TegridyStaking BPS
    uint256 public constant BASE_BOOST_BPS = 10000;         // 1.0x — no boost baseline
    /// @dev AUDIT FIX FRESH-2026: F-61-6 — minimum stake floor mirroring
    ///      TegridyStaking.MIN_STAKE = 100e18. Without this, sybil dust-stakers
    ///      could inflate `totalEffectiveSupply` 1 wei at a time, diluting honest
    ///      stakers' per-second slice. The per-call cost is amortised against the
    ///      reward dilution; with 100e18 LP minimum the attack is uneconomic.
    uint256 public constant MIN_STAKE = 100e18;
    /// @dev AUDIT FIX FRESH-2026: F-93-2 — minimum interval between notifyRewardAmount
    ///      invocations. Closes the same-block / same-mempool sandwich window where an
    ///      attacker watches the owner's pending notify tx and front-runs a `stake()`
    ///      to capture the new period's rate. For full immunity, route notifyRewardAmount
    ///      through a private mempool relay (Flashbots Protect / MEV-blocker).
    /// @dev AUDIT FIX FRESH-2026: LPFARM-NOTIFY-COOLDOWN [HIGH] — bumped 1h → 24h.
    ///      The 1h cooldown left the sandwich economically viable for a determined
    ///      whale: stake → wait 1h → top-up lands → unstake captures the rate-bump
    ///      share for ~1h of opportunity cost. At 24h the whale must commit LP for
    ///      a full day before each notify, multiplying the opportunity cost ~24×.
    ///      Most realistic reward distributions cadence weekly+; 24h is operationally
    ///      generous while pricing out the mempool-watching sandwich strategy.
    ///      Battle-tested precedent: Curve/Convex gauge emissions update weekly via
    ///      a queued RewardsDistribution contract — owners that need stronger
    ///      protection can deploy an external scheduler and rotate ownership of
    ///      notifyRewardAmount to it via the existing owner-rotation flow.
    uint256 public constant NOTIFY_COOLDOWN = 24 hours;
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

    /// @notice AUDIT M11: Tally of reward tokens forfeited by emergencyWithdraw users.
    ///         Without this counter the forfeited tokens accumulate as unrecoverable dust
    ///         (recoverERC20 blocks rewardToken sweeps, and the leftover formula in
    ///         notifyRewardAmount only carries the active rewardRate × remaining time).
    ///         Owner can sweep this dust to treasury via reclaimForfeitedRewards.
    uint256 public forfeitedRewards;

    mapping(address => uint256) public rawBalanceOf;       // Actual LP deposited
    mapping(address => uint256) public effectiveBalanceOf; // Boosted balance

    // ─── Admin State ────────────────────────────────────────────────
    address public treasury;
    uint256 public totalRewardsFunded;
    uint256 public pendingRewardsDuration;
    address public pendingTreasury;
    /// @dev AUDIT FIX FRESH-2026: F-93-2 — timestamp of last notifyRewardAmount.
    ///      Enforces NOTIFY_COOLDOWN between calls so a captured-mempool sandwich
    ///      cannot re-notify in the same block to compound a rate jack.
    uint256 public lastNotifyTime;

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
    event ForfeitedRewardsReclaimed(address indexed treasury, uint256 amount); // AUDIT M11
    /// @notice AUDIT FIX: DR2-03 — emitted when reward emission elapses while
    ///         `totalEffectiveSupply == 0`. The amount represents the (forfeit)
    ///         emission attributable to the empty period. Synthetix-style
    ///         empty-window forfeiture is preserved — this event closes the
    ///         observability gap that DR-09 v1 attempted to fix economically.
    event RewardsForfeitedDuringEmptyPeriod(uint256 amount);

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
    error RewardEqualsStakingToken();
    /// @dev AUDIT FIX FRESH-2026: F-93-2 — enforced cooldown gate.
    error NotifyCooldownActive();
    /// @dev AUDIT FIX FRESH-2026: F-61-6 — minimum stake floor.
    error StakeBelowMinimum();

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
        // FRESH-EYES H-1: reject the MasterChef-class footgun where rewardToken == stakingToken.
        // If both pointed at the same ERC20, `rewardToken.balanceOf(this)` would conflate user
        // deposits with the reward pool, letting `notifyRewardAmount` validate against deposits
        // and silently approve a rewardRate the contract cannot fund. Withdraws would then drain
        // the pool that should be paying rewards (insolvency).
        if (_rewardToken == _stakingToken) revert RewardEqualsStakingToken();
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

    /// @dev AUDIT FIX: DR2-03 — REVERTED the `if (totalEffectiveSupply > 0)`
    ///      gate added by DR-09 v1. Holding `lastUpdateTime` during an empty
    ///      window flipped the failure mode from "silent forfeit" to
    ///      "first-staker windfall" — a sandwich-extractable MEV vector where
    ///      an attacker stakes a tiny LP amount immediately after totalEffectiveSupply
    ///      decays to zero, then claims `(elapsed_empty * rewardRate)` of accrued
    ///      emission as the sole denominator. Pattern of record: Synthetix
    ///      `StakingRewards` deliberately forfeits empty-period emission to
    ///      prevent exactly this attack.
    ///
    ///      The legitimate concern DR-09 v1 raised — observability of the
    ///      forfeited amount — is now addressed by emitting a
    ///      `RewardsForfeitedDuringEmptyPeriod` event when the modifier detects
    ///      a non-zero elapsed empty period. Off-chain monitors can sum these
    ///      events and trigger refunds.
    modifier updateReward(address account) {
        // AUDIT FIX: DR2-03 — emit observability for the forfeited empty-window
        // emission BEFORE advancing `lastUpdateTime`. The forfeit calculation
        // matches Synthetix semantics: `elapsed * rewardRate` of emission is
        // dropped because `rewardPerToken()` returns `rewardPerTokenStored`
        // unchanged when the denominator is zero (no one to credit).
        if (totalEffectiveSupply == 0 && lastUpdateTime < lastTimeRewardApplicable()) {
            uint256 forfeit = (lastTimeRewardApplicable() - lastUpdateTime) * rewardRate;
            if (forfeit > 0) emit RewardsForfeitedDuringEmptyPeriod(forfeit);
        }
        rewardPerTokenStored = rewardPerToken();
        // AUDIT FIX: DR2-03 — restore unconditional `lastUpdateTime` advance
        // (Synthetix StakingRewards reference behavior). Empty-period emission
        // is forfeit, not banked for the next staker.
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            // AUDIT FIX FRESH-2026: C-1 / F-28-1 — anchor rewards FIRST under the
            // current (pre-refresh) boost cache, THEN refresh the cache for future
            // emissions. The previous order (cache refresh BEFORE earned) silently
            // applied any new boost retroactively to the entire un-checkpointed
            // delta `(rewardPerToken - userRewardPerTokenPaid)`, allowing an
            // attacker to wait while their staking-side boost grew, then trigger
            // any LP-farming function and capture the new boost on past emission.
            // PoC: 30d wait at 1.0x with 4.5x ratchet → ~4.5× over-credit on the
            // entire period (insolvent reward bucket). Reorder restores the
            // canonical Synthetix StakingRewards anchor pattern: rewards are
            // crystallised at the OLD boost, then the cache is updated so the new
            // boost applies only to future emissions.
            //
            // The remaining staleness (between staking-side mutation and the next
            // LP-farming interaction) is the same Curve-veCRV trade-off — the
            // proper cure is a `kick(user)` callback wired from TegridyStaking
            // into LP-farming, but the immediate retroactive credit must be fixed
            // first and that is the change made here.
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;

            // AUDIT FIX FRESH-2026: C-1 / F-28-1 — refresh boost cache AFTER
            // anchoring rewards/userPaid. Future emissions accrue at the new boost.
            uint256 raw = rawBalanceOf[account];
            if (raw > 0) {
                uint256 oldEff = effectiveBalanceOf[account];
                uint256 newEff = _getEffectiveBalance(account, raw);
                if (oldEff != newEff) {
                    totalEffectiveSupply = totalEffectiveSupply - oldEff + newEff;
                    effectiveBalanceOf[account] = newEff;
                    emit BoostUpdated(account, oldEff, newEff);
                }
            }
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
    /// @dev AUDIT H12: switched from single-pointer `userTokenId` to
    ///      `aggregateActiveBoostBps(user)`, which returns the amount-weighted average
    ///      boost across ALL of the user's active staking positions. Multi-NFT contract
    ///      holders (Safes, vaults) were previously undercounted because userTokenId
    ///      points only to the most-recently-received NFT. The aggregate view returns
    ///      the correct effective boost; the boost ceiling clamp is preserved as
    ///      defence-in-depth.
    ///
    /// @dev AUDIT R016 M-1 (MEDIUM): the legacy single-pointer fallback (try/catch on
    ///      `aggregateActiveBoostBps`, then `userTokenId(user)` + `positions(tokenId)`)
    ///      was removed. The fallback was dead code on the deployed staking ABI — the
    ///      aggregate view has been live since H12 — but it was actively harmful as a
    ///      contingency: in a hypothetical staking-upgrade scenario where the aggregate
    ///      view reverted, the catch path would have UNDERCOUNTED multi-NFT contract
    ///      holders by reading only the most-recently-received NFT's boost while the
    ///      user actually held N positions. That's the exact gap H12 was meant to close.
    ///      Keeping the fallback meant the silent-undercount regression could re-appear
    ///      under any future staking ABI breakage. With the fallback gone, an ABI
    ///      mismatch loudly reverts at the staking call instead of silently halving
    ///      reward boost for affected holders.
    ///
    /// @dev AUDIT FIX FRESH-2026: F-28-4 — BASE_BOOST_BPS (1.0×) floor is INTENTIONAL.
    ///      If `aggregateActiveBoostBps(user) <= BASE_BOOST_BPS`, the user is rewarded
    ///      as a non-staker (1.0×) rather than penalised below 1.0×. Sub-1.0× boost
    ///      values from the staking side are floored to 1.0× — there is no path by
    ///      which a staking position can REDUCE a user's LP-farming effective balance
    ///      below their raw deposit. This matches operator intent (staking should be
    ///      additive, not punitive) and aligns with TegridyStaking's documented
    ///      MIN_BOOST_BPS being for time-weighted lock decay, not reward floor.
    function _getEffectiveBalance(address user, uint256 rawAmount) internal view returns (uint256) {
        uint256 boostBps = BASE_BOOST_BPS;
        uint256 aggBps = tegridyStaking.aggregateActiveBoostBps(user);
        if (aggBps > BASE_BOOST_BPS) {
            boostBps = aggBps > MAX_BOOST_BPS_CEILING ? MAX_BOOST_BPS_CEILING : aggBps;
        }
        return (rawAmount * boostBps) / BOOST_PRECISION;
    }

    /// @notice Refresh a user's effective balance (call after staking NFT changes)
    /// @dev AUDIT FIX FRESH-2026: F-65-4 — Cross-state staleness: this contract has
    ///      no on-restake / on-unrestake / on-extend hook from TegridyStaking or
    ///      TegridyRestaking, so a user whose staking-side boost mutates between
    ///      LP-farming interactions carries a stale `effectiveBalanceOf` until the
    ///      next interaction. After C-1 / F-28-1, the stale cache only affects
    ///      FUTURE emissions (past emissions are anchored to the old cache when
    ///      `updateReward` runs at next interaction). Consumers and integrators
    ///      that mutate staking-side state (TegridyStaking.extendLock, .stake,
    ///      .restake on TegridyRestaking, .unrestake) SHOULD call this function
    ///      with `account = self` immediately after the staking-side action so
    ///      forward emissions accrue at the correct boost. This call is
    ///      permissionless — anyone can refresh anyone's cache.
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

    /// @notice Stake LP tokens to earn boosted TOWELI rewards.
    /// @dev Also refreshes the caller's effective balance against their current staking NFT
    ///      position so newly-acquired JBAC boost applies without a separate refreshBoost call.
    /// @dev AUDIT FIX FRESH-2026: F-28-3 — body-level reconcile is KEPT (not removed) by
    ///      design after C-1's modifier reorder. The modifier now anchors rewards under
    ///      the OLD boost and refreshes the cache for future emissions; the body-level
    ///      reconcile here is a no-op against the modifier's just-written cache for
    ///      existing balance, but is structurally retained as a defence-in-depth
    ///      checkpoint for the NEW deposit's boost (the `_getEffectiveBalance(amount)`
    ///      call below). The redundant external call to `_getEffectiveBalance(existing)`
    ///      is acceptable gas overhead (~2.6k) for the safety margin.
    function stake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        // AUDIT FIX FRESH-2026: F-61-6 — minimum stake to prevent sybil dust dilution.
        if (amount < MIN_STAKE) revert StakeBelowMinimum();

        // Reconcile any pre-existing effective balance with the current boost first.
        uint256 existingRaw = rawBalanceOf[msg.sender];
        if (existingRaw > 0) {
            uint256 oldEffective = effectiveBalanceOf[msg.sender];
            uint256 newEffective = _getEffectiveBalance(msg.sender, existingRaw);
            if (oldEffective != newEffective) {
                totalEffectiveSupply = totalEffectiveSupply - oldEffective + newEffective;
                effectiveBalanceOf[msg.sender] = newEffective;
                emit BoostUpdated(msg.sender, oldEffective, newEffective);
            }
        }

        uint256 effective = _getEffectiveBalance(msg.sender, amount);
        rawBalanceOf[msg.sender] += amount;
        effectiveBalanceOf[msg.sender] += effective;
        totalRawSupply += amount;
        totalEffectiveSupply += effective;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, effective);
    }

    /// @notice Convenience: withdraw full balance and claim all pending rewards in one tx.
    /// @dev Mirrors the Synthetix `exit()` helper. Uses internal helpers so msg.sender is
    ///      preserved and the nonReentrant guard is only taken once for the composite call.
    function exit() external nonReentrant updateReward(msg.sender) {
        uint256 raw = rawBalanceOf[msg.sender];
        if (raw > 0) {
            _withdrawInternal(msg.sender, raw);
        }
        if (rewards[msg.sender] > 0) {
            _getRewardInternal(msg.sender);
        }
    }

    /// @notice Withdraw staked LP tokens
    function withdraw(uint256 amount) external nonReentrant updateReward(msg.sender) {
        _withdrawInternal(msg.sender, amount);
    }

    function _withdrawInternal(address user, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        if (amount > rawBalanceOf[user]) revert InsufficientBalance();

        // AUDIT NEW-S4 (HIGH): recompute the user's effective balance from scratch on
        // the remaining raw amount instead of applying a proportional reduction.
        // The prior proportional-reduction path `(effective * amount) / raw` truncated
        // down each call, compressing the effective-per-raw ratio UPWARD on partial
        // withdraws. A whale doing many 1-wei withdraws could push their ratio past
        // the MAX_BOOST_BPS_CEILING clamp (because the clamp only applies inside
        // `_getEffectiveBalance`, not in the withdraw arithmetic). Result:
        // over-credited rewards on the retained LP + diluted pool for honest stakers.
        // Matches the stake() / refreshBoost() pattern already used elsewhere
        // (Curve LiquidityGaugeV4 model).
        // AUDIT FIX FRESH-2026: F-28-3 — body-level recompute is KEPT after C-1's
        // modifier reorder. The modifier now writes the post-refresh cache for the
        // OLD raw amount; this body recomputes for the NEW (smaller) raw amount.
        // Without this body-level reconcile, partial withdraws would leave
        // `effectiveBalanceOf[user]` reflecting the OLD raw — over-stated by the
        // withdrawn portion. The `_getEffectiveBalance` external call here is
        // accepted gas overhead for arithmetic correctness on partial withdraws.
        uint256 oldEff = effectiveBalanceOf[user];
        uint256 newRaw = rawBalanceOf[user] - amount;
        uint256 newEff = _getEffectiveBalance(user, newRaw);
        rawBalanceOf[user] = newRaw;
        effectiveBalanceOf[user] = newEff;
        totalRawSupply -= amount;
        totalEffectiveSupply = totalEffectiveSupply - oldEff + newEff;
        stakingToken.safeTransfer(user, amount);
        emit Withdrawn(user, amount);
    }

    /// @notice Claim pending TOWELI rewards
    function getReward() public nonReentrant updateReward(msg.sender) {
        _getRewardInternal(msg.sender);
    }

    function _getRewardInternal(address user) internal {
        uint256 reward = rewards[user];
        if (reward > 0) {
            rewards[user] = 0;
            rewardToken.safeTransfer(user, reward);
            emit RewardPaid(user, reward);
        }
    }

    /// @notice Emergency withdraw — return LP tokens, forfeit ALL pending rewards
    /// @dev AUDIT M11: forfeited reward total is tracked in `forfeitedRewards` so the
    ///      stranded tokens can later be swept to treasury via reclaimForfeitedRewards.
    ///      Without this, the forfeited amount silted up as unrecoverable dust
    ///      (recoverERC20 blocks rewardToken).
    /// @dev AUDIT FIX FRESH-2026: F-28-2 — DROPPED the `updateReward(msg.sender)`
    ///      modifier so this function never makes an external call to
    ///      `tegridyStaking.aggregateActiveBoostBps`. If the staking contract
    ///      ever returns malformed data, runs out of gas, or reverts on the
    ///      boost-query path, users would lose their last-resort exit. Pattern
    ///      of record: MasterChef-class `emergencyWithdraw` makes ZERO external
    ///      calls beyond the LP token transfer.
    ///
    ///      The original AUDIT NEW-S6 concern (subsequent claimers over-credited
    ///      because `totalEffectiveSupply` shrinks before `rewardPerTokenStored`
    ///      is synced) is addressed inline below: we sync rewardPerTokenStored
    ///      + lastUpdateTime under the OLD totalEffectiveSupply, then shrink it.
    ///      No boost cache refresh is needed — the user is exiting and zeros
    ///      their cache anyway.
    function emergencyWithdraw() external nonReentrant {
        uint256 amount = rawBalanceOf[msg.sender];
        if (amount == 0) revert ZeroAmount();
        uint256 effective = effectiveBalanceOf[msg.sender];

        // AUDIT FIX FRESH-2026: F-28-2 — inline minimal state sync (no external
        // calls). Anchor reward accumulator under the CURRENT totalEffectiveSupply
        // BEFORE shrinking it; otherwise the next claimer's per-second slice is
        // computed over the smaller denominator for the pre-emergency-withdraw
        // window, retroactively over-crediting them at this user's expense.
        // Empty-period observability event preserved for symmetry with
        // `updateReward`.
        if (totalEffectiveSupply == 0 && lastUpdateTime < lastTimeRewardApplicable()) {
            uint256 forfeit = (lastTimeRewardApplicable() - lastUpdateTime) * rewardRate;
            if (forfeit > 0) emit RewardsForfeitedDuringEmptyPeriod(forfeit);
        }
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();

        // AUDIT FIX FRESH-2026: F-28-2 — compute forfeited reward INLINE without
        // calling earned() first (earned() reads the not-yet-anchored userPaid).
        // Use the just-written rewardPerTokenStored against the user's stale
        // userRewardPerTokenPaid + their effective balance. This matches the
        // value `earned()` would have returned, but does it explicitly so the
        // dependency chain is auditable.
        uint256 forfeited = (
            effective * (rewardPerTokenStored - userRewardPerTokenPaid[msg.sender]) / 1e18
        ) + rewards[msg.sender];

        // Anchor userRewardPerTokenPaid so any latent re-entry path can't
        // double-count this user's slice (defence-in-depth; user state is
        // about to be zeroed anyway).
        userRewardPerTokenPaid[msg.sender] = rewardPerTokenStored;

        // Zero out user state (CEI).
        totalRawSupply -= amount;
        totalEffectiveSupply -= effective;
        rawBalanceOf[msg.sender] = 0;
        effectiveBalanceOf[msg.sender] = 0;
        rewards[msg.sender] = 0;

        // AUDIT M11: track forfeited reward dust for later treasury reclaim.
        if (forfeited > 0) {
            forfeitedRewards += forfeited;
        }

        stakingToken.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, amount, forfeited);
    }

    /// @notice AUDIT M11: Sweep accumulated forfeitedRewards dust to treasury.
    ///         Capped at the unencumbered balance (balance minus the active period's
    ///         remaining rewardRate × time) so this can never drain rewards owed to
    ///         active stakers. Treasury can re-fund via notifyRewardAmount.
    function reclaimForfeitedRewards() external onlyOwner nonReentrant {
        uint256 amount = forfeitedRewards;
        if (amount == 0) revert ZeroAmount();

        uint256 owedFutureRewards = block.timestamp < periodFinish
            ? (periodFinish - block.timestamp) * rewardRate
            : 0;
        uint256 balance = rewardToken.balanceOf(address(this));
        uint256 cap = balance > owedFutureRewards ? balance - owedFutureRewards : 0;
        if (amount > cap) amount = cap;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (amount == 0) revert ZeroAmount();

        forfeitedRewards -= amount;
        rewardToken.safeTransfer(treasury, amount);
        emit ForfeitedRewardsReclaimed(treasury, amount);
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
        // AUDIT FIX FRESH-2026: F-93-2 — cooldown gate against same-block / same-mempool
        // sandwich. Skip the gate on the first-ever call (lastNotifyTime == 0).
        if (lastNotifyTime != 0 && block.timestamp < lastNotifyTime + NOTIFY_COOLDOWN) {
            revert NotifyCooldownActive();
        }
        // AUDIT FIX M-3 (LP-Farming dead timelock): require the per-call duration
        // to match the timelocked `rewardsDuration`. Pre-fix this function
        // unconditionally OVERWROTE rewardsDuration on every call, making the
        // 24h propose/execute timelock (proposeRewardsDurationChange /
        // executeRewardsDurationChange) effectively dead code — owner could
        // silently change the distribution duration on any funding cycle.
        // First-ever call has rewardsDuration == 0 (storage default); allow
        // bootstrapping by skipping the equality check in that case so the
        // initial fund-and-rate-set can land without a separate proposeDuration
        // dance. After bootstrap, every subsequent change requires the
        // timelocked path.
        if (rewardsDuration != 0 && duration != rewardsDuration) revert DurationOutOfRange();

        uint256 balanceBefore = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualReward = rewardToken.balanceOf(address(this)) - balanceBefore;

        // AUDIT FIX FRESH-2026: F-61-1 — capture the integer-division residue from
        // `rewardRate = N / duration` into the existing `forfeitedRewards` bucket
        // so the up-to-(duration-1) wei stranded per cycle is reclaimable by the
        // owner via reclaimForfeitedRewards (rather than silting as unrecoverable
        // dust — recoverERC20 blocks the reward token).
        uint256 budget;
        if (block.timestamp >= periodFinish) {
            budget = actualReward;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            budget = leftover + actualReward;
        }
        // SLITHER 2026-05-18: precision/overflow tradeoff acceptable; combined-fraction form risks uint256 overflow on large inputs
        // slither-disable-next-line divide-before-multiply
        rewardRate = budget / duration;
        uint256 residue = budget - (rewardRate * duration);
        if (residue > 0) {
            forfeitedRewards += residue;
        }

        if (rewardRate > MAX_REWARD_RATE) revert RewardRateExceedsCap();
        uint256 balance = rewardToken.balanceOf(address(this));
        if (rewardRate > balance / duration) revert RewardTooHigh();

        rewardsDuration = duration;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        lastNotifyTime = block.timestamp; // AUDIT FIX FRESH-2026: F-93-2
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

    /// @dev AUDIT FIX: DEEP-DR-05 — mirror the `periodFinish` gate from
    ///      `proposeRewardsDurationChange`. Pre-fix the propose side enforced
    ///      "no active period" but the execute side did not, allowing the
    ///      sequence: propose during a quiet window → wait 24h → notifyRewardAmount
    ///      to start a new period → execute mid-period to rotate `rewardsDuration`
    ///      under a live period without the timelock that was supposed to gate
    ///      it. Pattern of record: Synthetix StakingRewards `setRewardsDuration`
    ///      requires `block.timestamp > periodFinish` at the SETTER side.
    function executeRewardsDurationChange() external onlyOwner {
        if (block.timestamp < periodFinish) revert PreviousPeriodNotComplete();
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

    /// @notice AUDIT FIX 2026-05-21 M19-PORT: override `acceptOwnership` so that any
    ///         pending proposals queued by the outgoing owner are CANCELLED on handoff.
    ///         Mirrors `TegridyLaunchpadV2.acceptOwnership` (TegridyLaunchpadV2.sol:426-438).
    ///         Without this override, an outgoing/compromised owner could queue hostile
    ///         proposals immediately before `transferOwnership`; the timelock would silently
    ///         keep running and the new owner inherits an executable booby-trap.
    /// @dev    Calls `super.acceptOwnership()` first so the Ownable2Step pendingOwner→owner
    ///         promotion happens before the cancellations. Base `ProposalCancelled(KEY)`
    ///         from `_cancel` provides the audit trail (no typed per-key events on this
    ///         contract — base event is sufficient).
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[REWARDS_DURATION_CHANGE] != 0) {
            _cancel(REWARDS_DURATION_CHANGE);
            pendingRewardsDuration = 0;
        }
        if (_executeAfter[TREASURY_CHANGE] != 0) {
            _cancel(TREASURY_CHANGE);
            pendingTreasury = address(0);
        }
    }
}
