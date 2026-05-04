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
            // PASS7-LPFARM-M1 FIX: re-derive boost cache before computing rewards.
            // Pre-fix, `_getEffectiveBalance` was only re-derived on user-initiated
            // `stake / withdraw / refreshBoost`. After lock expiry or staking-NFT
            // transfer, `effectiveBalanceOf[account]` stayed inflated until
            // someone permissionlessly called `refreshBoost(account)` — and there
            // was no on-chain incentive to do so. This let an attacker continue
            // earning at the legacy boost ratio for the entire window between
            // boost-source removal and the next refresh (~29% over-credit on
            // 1y-lock 1.29x boost over 30 days, ~300% at MAX_BOOST = 4.5x).
            //
            // By refreshing INSIDE updateReward, every user-initiated state
            // change (stake, withdraw, getReward, exit, refreshBoost itself)
            // re-anchors the boost cache against the current staking-side state.
            // Pattern of record: Synthetix-style `updateReward` checkpoints all
            // cached state at every interaction.
            //
            // Refresh BEFORE `earned(account)` so the new effective balance
            // applies to the about-to-be-credited slice. Honest edge case: a
            // user who held a high boost for the elapsed period and dropped it
            // just before claiming gets credited at the LOWER boost — a small
            // under-credit in exchange for closing the much larger stale-boost
            // over-credit attack surface. This is the trade-off the F-1
            // restaking-side fix made and is mirrored here for symmetry.
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
    function _getEffectiveBalance(address user, uint256 rawAmount) internal view returns (uint256) {
        uint256 boostBps = BASE_BOOST_BPS;
        uint256 aggBps = tegridyStaking.aggregateActiveBoostBps(user);
        if (aggBps > BASE_BOOST_BPS) {
            boostBps = aggBps > MAX_BOOST_BPS_CEILING ? MAX_BOOST_BPS_CEILING : aggBps;
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

    /// @notice Stake LP tokens to earn boosted TOWELI rewards.
    /// @dev Also refreshes the caller's effective balance against their current staking NFT
    ///      position so newly-acquired JBAC boost applies without a separate refreshBoost call.
    function stake(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();

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
    /// @dev AUDIT NEW-S6 (MEDIUM): added `updateReward(msg.sender)` modifier so
    ///      `rewardPerTokenStored` + `lastUpdateTime` are synced to `now` BEFORE
    ///      `totalEffectiveSupply` shrinks. Otherwise, the next claimer's
    ///      `rewardPerToken()` divides the elapsed × rewardRate by the NEW smaller
    ///      denominator, over-crediting rewards for the pre-emergency-withdraw
    ///      period (during which this user was still in the denominator).
    function emergencyWithdraw() external nonReentrant updateReward(msg.sender) {
        uint256 amount = rawBalanceOf[msg.sender];
        if (amount == 0) revert ZeroAmount();
        uint256 forfeited = earned(msg.sender);
        uint256 effective = effectiveBalanceOf[msg.sender];

        // Zero out user state (CEI). AUDIT FIX D-LPF-L1: removed redundant
        // `userRewardPerTokenPaid[msg.sender] = rewardPerTokenStored` — the
        // updateReward(msg.sender) modifier already wrote that exact value.
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
}
