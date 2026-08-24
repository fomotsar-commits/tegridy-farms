// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "../base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "../base/TimelockAdmin.sol";
import {PauseGuardian} from "../base/PauseGuardian.sol";
import {WETHFallbackLib, IWETH} from "../lib/WETHFallbackLib.sol";

/// @dev Read-only surface of TegridyStaking consumed here. Deliberately a strict
///      SUBSET of `RevenueDistributor.IVotingEscrow`: the epoch distributor needs
///      the historical checkpoint views (`votingPowerAtTimestamp`,
///      `totalBoostedStakeAtTimestamp`) because it settles a past instant. This
///      contract settles the PRESENT on every touch, so it reads only live values
///      and never a historical lookup.
interface IVotingEscrow {
    function votingPowerOf(address user) external view returns (uint256);
    function userTokenId(address user) external view returns (uint256);
    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint256 lockEnd,
        uint256 boostBps, uint256 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        uint256 stakeTimestamp, uint256 jbacTokenId, bool jbacDeposited
    );
    function paused() external view returns (bool);
}

/// @dev Restaking surface. A restaker's staking-side `votingPowerOf` reads 0 because
///      the position NFT is custodied by TegridyRestaking, so without this fallback
///      every restaker mirrors in at zero and is paid nothing.
interface ITegridyRestaking {
    function restakers(address user) external view returns (
        uint256 tokenId, uint256 positionAmount, uint256 boostedAmount, int256 bonusDebt, uint256 depositTime
    );
    function boostedAmountAt(address user, uint256 timestamp) external view returns (uint256);
}

/// @title StreamingRevenueDistributor
/// @notice veTOWELI revenue distribution by continuous per-second accrual instead of
///         4-hour epoch snapshots. Successor design to `src/RevenueDistributor.sol`;
///         deployed nowhere, belongs to the audited v2 batch.
///
/// ─────────────────────────────────────────────────────────────────────────────
///  FORK PROVENANCE  (this is a money path — read this before the code)
/// ─────────────────────────────────────────────────────────────────────────────
///  Accrual core is the Synthetix `StakingRewards` pattern, taken from the
///  in-repo sibling that already carries it through this protocol's audit
///  history: `contracts/src/TegridyLPFarming.sol` (boosted Synthetix accrual over
///  a balance derived from an EXTERNAL TegridyStaking contract — structurally the
///  same problem this contract solves). Upstream of that sibling is
///  Synthetixio/synthetix `contracts/StakingRewards.sol` (MIT), attributed in
///  `NOTICE.md`.
///
///  Copied verbatim from the sibling, symbol-for-symbol:
///    `lastTimeRewardApplicable()`, `rewardPerToken()`, `earned()`, the
///    `updateReward(account)` body (empty-period forfeit observability, the
///    unconditional `lastUpdateTime` advance, and the FRESH-2026 C-1 / F-28-1
///    anchor ordering), and the Synthetix leftover-rollover in the notify path.
///
///  HONESTY NOTE ON THE PIN: `NOTICE.md` attributes Synthetix StakingRewards by
///  repository, not by commit. This file therefore pins to the in-repo sibling
///  (which is the actual byte source of the copy) rather than asserting an
///  upstream SHA that has not been verified against upstream here. An auditor
///  wanting the upstream diff should diff the four functions named above against
///  Synthetixio/synthetix `contracts/StakingRewards.sol` and record that commit
///  in `NOTICE.md` alongside the existing row.
///
///  DELTAS from the sibling — all periphery, none in the accrual integral:
///    D1. Reward asset is native ETH (arrives via `receive()`), not an ERC20
///        pulled by `safeTransferFrom`. Payouts route through
///        `WETHFallbackLib.safeTransferETHOrWrap`.
///    D2. `effectiveBalanceOf` is a MIRROR of veTOWELI boosted power, not
///        `deposit x boost`. It is moved ONLY by `_updateReward`, which is the
///        same place the sibling refreshes its boost cache.
///    D3. Reserve accounting (`reservedETH`) exists because the reward asset and
///        the contract's entire balance are the same asset; the sibling can lean
///        on `rewardToken.balanceOf` being disjoint from deposits.
///    D4. The `updateReward` modifier is factored into an internal
///        `_updateReward(address)` so `syncMany` can iterate. Body unchanged.
///
/// ─────────────────────────────────────────────────────────────────────────────
///  THE ANTI-FLASH PROPERTY  (the blocking question for this design)
/// ─────────────────────────────────────────────────────────────────────────────
///  `RevenueDistributor` pins each epoch's numerator AND denominator at
///  `block.timestamp - 1` (REV-M-01) so a stake landing in the same block as
///  `distribute()` cannot appear in that epoch. That is the property a continuous
///  scheme was not allowed to lose.
///
///  It is preserved here, and strictly strengthened:
///
///    (a) A mirrored balance NEVER applies retroactively. `_updateReward` anchors
///        `rewards[a] = earned(a)` and `userRewardPerTokenPaid[a] =
///        rewardPerTokenStored` under the OLD mirror, and only THEN raises the
///        mirror. This is the FRESH-2026 C-1 / F-28-1 ordering, ported verbatim
///        because reversing it is exactly the amplification bug it fixed.
///        Consequence: power that appears at time t earns over [t, infinity) and
///        over nothing before t.
///
///    (b) Same-block stake -> sync -> getReward pays exactly 0, because the
///        account's anchor is set to the current `rewardPerTokenStored` and
///        `rewardPerToken()` advances only with elapsed time (dt = 0).
///
///    (c) Under epochs, staking one block BEFORE `distribute()` captured a pro
///        rata share of four hours of accumulated revenue. Under streaming the
///        same capital captures one block of revenue. The window a flash-staker
///        can monetise shrinks from MIN_DISTRIBUTE_INTERVAL to one block.
///
///  What is NOT preserved — state this in any UI copy, do not paper over it:
///
///    (X) `RevenueDistributor` needs NO REGISTRATION: it reads each claimant's
///        historical checkpoint at the epoch instant, so a staker who never
///        touches the distributor is still paid. Continuous accrual cannot do
///        that in O(1) — reconstructing a user's share from the Trace208 history
///        means integrating over their checkpoint segments, which is bespoke core
///        math on a money path and is therefore refused here.
///
///        The consequence is real and must be surfaced honestly: an UNSYNCED
///        staker accrues NOTHING, and their share flows to the accounts that are
///        synced. Mitigations, all of them periphery:
///          - `sync(address)` is permissionless — anyone may sync anyone.
///          - `syncMany(address[])` exists for a keeper to cover the staker set.
///          - `getReward()` self-syncs the caller before paying.
///          - `isSynced(address)` is a view a UI MUST consult before rendering an
///            earnings figure. A zero from an unsynced account is NOT "no revenue
///            yet" and must never be rendered as one.
///        This is the same veCRV-family trade-off `TegridyLPFarming.refreshBoost`
///        already carries (see its F-65-4 note); the cure in both cases is a
///        `kick` callback from TegridyStaking, which needs a staking redeploy and
///        is out of scope for an immutable distributor.
///
/// ─────────────────────────────────────────────────────────────────────────────
///  SURFACE REDUCTION vs v1  (DELETE before ADD)
/// ─────────────────────────────────────────────────────────────────────────────
///  Epoch bookkeeping is what made v1 large: per-epoch arrays, claim cursors,
///  `epochClaimed`, owner claim-recovery with four separate caps, dust
///  auto-reconcile and its retirement, forfeit reclaim, token sweep, pending
///  withdrawals. None of it exists here. There is no `treasury` address and no
///  owner-side ETH exit at all: forfeited accruals recycle to the staker pool via
///  `totalForfeitedToPool`, never to the protocol. The protocol spends nothing it
///  has not earned; every wei that enters leaves through `getReward`.
///
/// ─────────────────────────────────────────────────────────────────────────────
///  MIGRATION — handing over from a live v1 with an OPEN EPOCH
/// ─────────────────────────────────────────────────────────────────────────────
///  v1 is immutable and stays deployed. This contract reads no v1 state and
///  writes none. The handover is entirely a matter of ORDER; the failure mode is
///  stranding, and it is always caused by redirecting the fee source first.
///
///  M1. Deploy v2. Owner = the same Safe that owns v1. Streaming stays DISABLED
///      (`streamingEnabled == false` at construction) — `notifyRewardAmount`
///      reverts, so ETH arriving early simply waits.
///  M2. CLOSE v1's open epoch BEFORE touching the fee source. Call
///      `RevenueDistributor.distributePermissionless()` once more so every wei
///      already sitting in v1 is earmarked into an epoch. v1 refuses to open an
///      epoch below `MIN_DISTRIBUTE_AMOUNT` (1 ETH) — so if the un-reserved
///      residue is under 1 ETH, either top v1 up to the threshold and distribute,
///      or accept that the residue is recoverable only through v1's 48h
///      `proposeEmergencyWithdrawExcess`. Redirecting the fee leg while that
///      residue is below threshold strands it permanently: no further inflow will
///      ever arrive to carry it over the minimum.
///  M3. Only now redirect the staker leg (`SwapFeeRouterAdmin`, 48h) from v1 to
///      v2's address.
///  M4. `proposeEnableStreaming()` (48h) so the enable cannot land before the
///      redirect it depends on.
///  M5. SYNC THE STAKER SET before, or in the same block as,
///      `executeEnableStreaming()`, then again immediately after the first
///      `notifyRewardAmount()`. Accrual is not retroactive (see (X) above): every
///      staker unsynced at the first notify earns nothing for the window in which
///      they stay unsynced, and that share is paid to the accounts that are
///      synced. This is the single operational obligation the epoch design did
///      not have.
///  M6. v1 claims never expire and are unaffected: `claim()` / `claimUpTo()` keep
///      working against the epochs that already exist. Stakers claim history from
///      v1 and stream from v2. Do NOT point the same fee leg at both — the
///      contracts do not know about each other and a split leg silently halves
///      both sides.
///  M7. The 7-day `CLAIM_GRACE_PERIOD` is per-contract. A staker whose lock
///      expires during the cutover has 7 days from their own `lockEnd` to drain
///      v1. Publish the cutover at least 7 days ahead of any clustered lock
///      cliff, or those epochs forfeit inside v1.
contract StreamingRevenueDistributor is
    OwnableNoRenounce,
    ReentrancyGuard,
    Pausable,
    TimelockAdmin,
    PauseGuardian
{
    // ─── Timelock keys ────────────────────────────────────────────────

    bytes32 public constant STREAMING_ENABLE = keccak256("V2_STREAMING_ENABLE");
    bytes32 public constant REWARDS_DURATION_CHANGE = keccak256("V2_STREAM_REWARDS_DURATION");
    bytes32 public constant RESTAKING_CHANGE = keccak256("V2_STREAM_RESTAKING");
    /// @notice Reclaiming abandoned accrual to the pool. Owner-timelocked BY DESIGN —
    ///         see `proposeForfeit`. v1's equivalent is `FORFEIT_RECLAIM`.
    bytes32 public constant FORFEIT_RECLAIM = keccak256("V2_STREAM_FORFEIT_RECLAIM");

    uint256 public constant STREAMING_ENABLE_DELAY = 48 hours;

    /// @dev Same 48 hours as v1's FORFEIT_RECLAIM_DELAY. The window is the point: a
    ///      forfeit is irreversible for the account it hits, so it must be observable
    ///      before it lands and cancellable while it is pending.
    uint256 public constant FORFEIT_RECLAIM_DELAY = 48 hours;

    // ── WHY THERE IS NO VALUE CAP, AND WHY THAT IS THE SAFER CHOICE ──────────
    //
    // A `MAX_LIFETIME_FORFEIT_BPS = 100` was tried here, copied from v1. It was WRONG,
    // and its own first test caught it: v1's 1% reclaims DUST — its window is literally
    // `DUST_RECLAIM_GRACE` — while a forfeit here takes ONE ACCOUNT'S ENTIRE ACCRUAL,
    // which can be a large slice of a stream. The first realistic fixture reverted
    // `ForfeitCapExceeded(1.75e18, 6.99e16)`. A safety mechanism that cannot be used is
    // not a safety mechanism; it is the thing someone deletes under pressure.
    //
    // The threat a cap would defend against does not exist here. THERE IS NO OWNER-SIDE
    // ETH EXIT IN THIS CONTRACT — no treasury address, no sweep to the owner. Forfeited
    // wei goes to `totalForfeitedToPool` and re-streams to remaining stakers, so a
    // compromised owner key can REDISTRIBUTE but cannot EXTRACT. The attack is grief,
    // not theft, and a value cap is a poor instrument against grief.
    //
    // ELIGIBILITY IS THE REAL CAP. `_isForfeitable` requires positive evidence of
    // abandonment: the escrow read back, the account is not restaked, and a determinable
    // claim window has closed. Nothing else can ever be touched — so even a fully
    // compromised owner can only reach accounts that provably walked away and left ETH
    // behind. Active stakers are unreachable by construction, which is a stronger
    // guarantee than any percentage.
    //
    // What the 48h window needed instead was OBSERVABILITY, and that was the actual gap:
    // `ForfeitProposed` emitted a count and not the accounts, so nobody could review a
    // pending proposal. It emits the list now. A timelock you cannot read is a delay, not
    // a control.

    /// @dev Bounds the propose payload so `executeForfeit` cannot be gas-bricked by a list
    ///      nobody can iterate. Mirrors MAX_SYNC_BATCH.
    uint256 public constant MAX_FORFEIT_BATCH = 100;
    uint256 public constant REWARDS_DURATION_DELAY = 24 hours;
    uint256 public constant RESTAKING_CHANGE_DELAY = 48 hours;

    // ─── Constants ────────────────────────────────────────────────────

    /// @dev Synthetix reward-per-token fixed-point scale. Must match the sibling.
    uint256 public constant ACC_PRECISION = 1e18;

    uint256 public constant MIN_REWARDS_DURATION = 1 days;
    uint256 public constant MAX_REWARDS_DURATION = 90 days;

    /// @dev Carried over from v1's `MIN_DISTRIBUTE_AMOUNT` (H-06). `notifyRewardAmount`
    ///      is permissionless, and each call restretches the unspent remainder over a
    ///      fresh full duration — a griefer can slow payouts. The only cost that
    ///      prices that out is requiring the griefer to DONATE: notify consumes the
    ///      un-reserved balance, so the 1 ETH floor must be funded by whoever calls.
    uint256 public constant MIN_NOTIFY_AMOUNT = 1 ether;

    /// @dev Ported from `TegridyLPFarming.NOTIFY_COOLDOWN` (LPFARM-NOTIFY-COOLDOWN).
    ///      Bounds both the rate-jack sandwich and the restretch grief above to one
    ///      attempt per day.
    uint256 public constant NOTIFY_COOLDOWN = 24 hours;

    /// @dev Same 7 days as v1. A lock that has expired stops mirroring in (voting
    ///      power is already 0 for an expired position), but crystallised accrual
    ///      stays claimable for this long before `sync` may recycle it.
    ///
    ///      Measured from `lockEnd`, which exists only while the position does. Once the
    ///      NFT is burnt there is NO durable anchor, and `_claimDeadlineOf` says so rather
    ///      than inventing one — two attempts to invent one were refuted. That is safe now
    ///      only because the forfeit is owner-timelocked: an undeterminable window means
    ///      "do not forfeit", which costs the pool a delay instead of costing a staker
    ///      their ETH.
    uint256 public constant CLAIM_GRACE_PERIOD = 7 days;

    /// @dev `syncMany` iterates external staking reads (~2 calls each). 100 keeps the
    ///      worst case far inside a block at the same order as v1's MAX_CLAIM_EPOCHS
    ///      per-call budget.
    uint256 public constant MAX_SYNC_BATCH = 100;

    /// @dev Gas ceiling on the restaking lookup, ported from v1's F-50-8. A captured
    ///      or upgraded restaking contract that burns unbounded legitimate gas (not a
    ///      revert) would otherwise be able to push `syncMany` past the block limit.
    uint256 private constant RESTAKING_CALL_GAS = 50_000;

    // ─── Immutables ───────────────────────────────────────────────────

    IVotingEscrow public immutable votingEscrow;
    IWETH public immutable weth;

    // ─── Synthetix accrual state (verbatim shape) ────────────────────

    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public rewardsDuration;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    /// @notice Mirrored veTOWELI boosted power per account (delta D2).
    mapping(address => uint256) public effectiveBalanceOf;
    uint256 public totalEffectiveSupply;

    /// @notice Accounts named by the pending forfeit proposal. Cleared on execute
    ///         and on cancel.
    address[] public pendingForfeitAccounts;


    // ─── Reserve accounting (delta D3) ───────────────────────────────

    /// @notice Emission that has been credited to the pool across windows in which
    ///         `totalEffectiveSupply > 0`. Empty-window emission is Synthetix-forfeit
    ///         and deliberately NOT counted here, which is what makes it re-streamable.
    uint256 public totalStreamed;
    /// @notice ETH that has actually left through `getReward`.
    uint256 public totalPaidOut;
    /// @notice Crystallised accrual recycled back to the staker pool by `sync` after
    ///         an account's grace period elapsed. Never routed to an owner or treasury.
    uint256 public totalForfeitedToPool;

    // ─── Config state ─────────────────────────────────────────────────

    /// @notice House law: new economics ship OFF. Until an owner completes the 48h
    ///         `STREAMING_ENABLE` timelock, `notifyRewardAmount` reverts and no
    ///         emission schedule can exist. ETH that arrives meanwhile is untouched
    ///         and becomes the first period's budget.
    bool public streamingEnabled;

    /// @notice Zero-address-gated: while unset, restakers mirror in at their staking
    ///         power (0) rather than through the fallback. Set via the 48h timelock.
    ITegridyRestaking public restakingContract;
    address public pendingRestaking;

    uint256 public pendingRewardsDuration;
    uint256 public lastNotifyTime;

    // ─── Events ───────────────────────────────────────────────────────

    event ETHReceived(address indexed sender, uint256 amount);
    event RewardAdded(uint256 newETH, uint256 rewardRate, uint256 periodFinish);
    event RewardPaid(address indexed user, uint256 amount);
    event BalanceSynced(address indexed user, uint256 oldBalance, uint256 newBalance);
    event RewardsForfeitedToPool(address indexed user, uint256 amount);
    /// @dev Emits the ACCOUNTS, not just a count. The 48h window is only a control if
    ///      a monitor can see who is in it; a count makes the proposal unreviewable.
    event ForfeitProposed(address[] accounts, uint256 executeAfter);
    event ForfeitExecuted(uint256 forfeited, uint256 skipped, uint256 totalAmount);
    event ForfeitCancelled();
    event RewardsForfeitedDuringEmptyPeriod(uint256 amount);
    event StreamingEnableProposed(uint256 executeAfter);
    event StreamingEnabled();
    event StreamingEnableCancelled();
    event RewardsDurationProposed(uint256 newDuration, uint256 executeAfter);
    event RewardsDurationUpdated(uint256 oldDuration, uint256 newDuration);
    event RewardsDurationChangeCancelled();
    event RestakingChangeProposed(address indexed newRestaking, uint256 executeAfter);
    event RestakingContractUpdated(address indexed newRestaking);
    event RestakingChangeCancelled(address indexed cancelledRestaking);

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error ForfeitBatchTooLarge();
    error ForfeitBatchEmpty();
    error NotForfeitable(address account);
    error DurationOutOfRange();
    error StreamingDisabled();
    error StreamingAlreadyEnabled();
    error StakingPaused();
    error NotifyCooldownActive();
    error NotifyAmountTooSmall();
    error NothingToClaim();
    error NoLockedTokens();
    error SyncBatchTooLarge();
    error PreviousPeriodNotComplete();
    /// @dev Post-condition on `notifyRewardAmount`: the schedule it just wrote must be
    ///      funded by the balance on hand. Unreachable by construction (the budget is
    ///      derived from the un-reserved balance) — kept as a loud assert because the
    ///      alternative failure mode is a stream that silently runs dry mid-period.
    error ScheduleUnfunded();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _votingEscrow, address _weth, uint256 _rewardsDuration)
        OwnableNoRenounce(msg.sender)
    {
        if (_votingEscrow == address(0) || _weth == address(0)) revert ZeroAddress();
        if (_rewardsDuration < MIN_REWARDS_DURATION || _rewardsDuration > MAX_REWARDS_DURATION) {
            revert DurationOutOfRange();
        }
        votingEscrow = IVotingEscrow(_votingEscrow);
        weth = IWETH(_weth);
        rewardsDuration = _rewardsDuration;

        // Ported from v1's H-11 [F-55-1, F-80-02]: pre-warm the ingress counter slot so
        // the first `receive()` SSTORE is non-zero -> non-zero. A sender forwarding only
        // the 30k `WETHFallbackLib` stipend would otherwise pay the 22.1k zero-slot
        // price here and get bounced into that lib's WETH-wrap branch — and wrapped WETH
        // is invisible to `distributable()`, so the first revenue would never stream.
        _totalETHReceivedRaw = 1;
    }

    // ─── ETH ingress ──────────────────────────────────────────────────

    uint256 private _totalETHReceivedRaw;

    /// @notice Monotonic counter of ETH delivered through `receive()`, net of the
    ///         1-wei constructor pre-warm. Diffing this against `address(this).balance`
    ///         is how off-chain monitoring detects donation drift (selfdestruct /
    ///         coinbase ETH bypasses `receive()` entirely).
    function totalETHReceived() external view returns (uint256) {
        unchecked { return _totalETHReceivedRaw - 1; }
    }

    receive() external payable {
        unchecked { _totalETHReceivedRaw += msg.value; }
        emit ETHReceived(msg.sender, msg.value);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  SYNTHETIX ACCRUAL CORE — verbatim from TegridyLPFarming        ║
    // ═══════════════════════════════════════════════════════════════════

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalEffectiveSupply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + (
            (lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * ACC_PRECISION / totalEffectiveSupply
        );
    }

    function earned(address account) public view returns (uint256) {
        return (
            effectiveBalanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account]) / ACC_PRECISION
        ) + rewards[account];
    }

    /// @dev Body is the sibling's `updateReward(account)` modifier, factored into a
    ///      function so `syncMany` can iterate it (delta D4). The ORDER inside is the
    ///      security-critical part and is unchanged:
    ///        1. forfeit-observability for an empty window,
    ///        2. advance the global accumulator,
    ///        3. crystallise the account under its OLD mirror,
    ///        4. only then move the mirror.
    ///      Swapping 3 and 4 is the FRESH-2026 C-1 / F-28-1 bug — it applies a balance
    ///      increase retroactively across the whole un-checkpointed delta, which is
    ///      precisely the flash-amplification the epoch snapshot existed to prevent.
    function _updateReward(address account) internal {
        uint256 applicable = lastTimeRewardApplicable();

        if (totalEffectiveSupply == 0) {
            // Synthetix forfeits emission accrued while nobody is staked rather than
            // banking it, because banking it hands the next staker a windfall they can
            // sandwich for. The event is the observability the forfeit would otherwise
            // lack; the wei itself stays un-reserved and re-streams on the next notify.
            if (lastUpdateTime < applicable) {
                uint256 forfeit = (applicable - lastUpdateTime) * rewardRate;
                if (forfeit > 0) emit RewardsForfeitedDuringEmptyPeriod(forfeit);
            }
        } else if (applicable > lastUpdateTime) {
            totalStreamed += (applicable - lastUpdateTime) * rewardRate;
        }

        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = applicable;

        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;

            uint256 oldEff = effectiveBalanceOf[account];
            uint256 newEff = _effectivePower(account);
            if (oldEff != newEff) {
                totalEffectiveSupply = totalEffectiveSupply - oldEff + newEff;
                effectiveBalanceOf[account] = newEff;
                // Durable grace anchor. `oldEff != newEff` with `newEff == 0` is exactly
                // the non-zero -> zero edge, so this fires once per exit and re-arms if
                // the account ever mirrors back in. Placed here because this is the only
                // write to the mirror, which makes the anchor and the mirror incapable of
                // disagreeing, and because `_syncAndMaybeRecycle` runs `_updateReward`
                // BEFORE its forfeit gate — so the anchor is always written before it is
                // read, and the 7 days are real rather than retroactively zero.
                emit BalanceSynced(account, oldEff, newEff);
            }
        }
    }

    modifier updateReward(address account) {
        _updateReward(account);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  MIRROR                                                        ║
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Current veTOWELI boosted power for `account`, as this contract will
    ///         mirror it. A REVERTING staking read degrades to 0 rather than bricking
    ///         accrual for everyone else — `votingEscrow` is immutable here, so a
    ///         future staking-side ABI break must not be fatal.
    /// @dev `votingPowerOf` already excludes expired positions, so an expired lock
    ///      mirrors to 0 without any lockEnd arithmetic on this side.
    ///
    ///      HONESTY BOUND on the sentence above — measured, not assumed. `try` catches a
    ///      call that REVERTS. It does NOT catch a call to a CODELESS address: that
    ///      succeeds with empty returndata and fails in the ABI decode that follows,
    ///      outside the catch. `test_CodelessEscrowIsLoudAndNeverConfiscates` pins the
    ///      observed behaviour on this toolchain — `sync` reverts outright. So "must not
    ///      be fatal" is true for a revert and FALSE for a codeless (or short-returndata)
    ///      escrow, which bricks sync and claim for everyone.
    ///
    ///      That failure is loud rather than silent and confiscates nothing, and it is
    ///      unreachable while `votingEscrow` is a deployed contract fixed at construction
    ///      (post-Cancun SELFDESTRUCT cannot clear a deployed contract's code). The one
    ///      way in is a deploy-time mis-wire, because the constructor checks only for the
    ///      ZERO address, not for code. A `code.length` check there is the cheap close;
    ///      deliberately not added in this change, which is scoped to the outage-vs-
    ///      expiry conflation. Flagged for the operator rather than silently absorbed.
    function _effectivePower(address account) internal view returns (uint256) {
        uint256 power;
        try votingEscrow.votingPowerOf(account) returns (uint256 p) {
            power = p;
        } catch {
            power = 0;
        }
        if (power > 0) return power;

        // Restakers read 0 above because TegridyRestaking custodies the NFT. Same
        // fallback as v1's NEW-S1; without it every restaker mirrors in at zero and
        // is silently paid nothing.
        if (address(restakingContract) == address(0)) return 0;
        try restakingContract.boostedAmountAt{gas: RESTAKING_CALL_GAS}(account, block.timestamp) returns (uint256 p) {
            return p;
        } catch {
            return 0;
        }
    }

    /// @notice True once `account` has a mirrored balance that reflects a live
    ///         position. A UI MUST call this before rendering an earnings number:
    ///         a zero from an account that has staked but never synced is an
    ///         un-registered account, NOT "no revenue yet", and rendering it as the
    ///         latter is the fabricated-data failure this protocol gates against.
    function isSynced(address account) external view returns (bool) {
        return effectiveBalanceOf[account] == _effectivePower(account);
    }

    /// @notice Mirror `account`'s current boosted power into the accrual set.
    ///         Permissionless by design — the accrual is only correct while the
    ///         mirror tracks reality, so anyone must be able to correct anyone,
    ///         in both directions.
    function sync(address account) external nonReentrant whenNotPaused {
        if (account == address(0)) revert ZeroAddress();
        _syncAndMaybeRecycle(account);
    }

    /// @notice Batch form for the keeper that covers the staker set at cutover.
    function syncMany(address[] calldata accounts) external nonReentrant whenNotPaused {
        uint256 len = accounts.length;
        if (len > MAX_SYNC_BATCH) revert SyncBatchTooLarge();
        for (uint256 i; i < len; ++i) {
            address a = accounts[i];
            if (a == address(0)) continue;
            _syncAndMaybeRecycle(a);
        }
    }

    /// @dev Sync, then recycle a fully-exited account's crystallised accrual back to
    ///      the staker pool once its grace period has elapsed. This is the streaming
    ///      analogue of v1's epoch forfeit — with the difference that the wei goes
    ///      back to stakers via the next `notifyRewardAmount`, never to a treasury.
    ///      An account still inside grace, still restaked, or still holding power is
    ///      untouched.
    function _syncAndMaybeRecycle(address account) internal {
        _updateReward(account);

        if (effectiveBalanceOf[account] != 0) return;
        uint256 owed = rewards[account];
        if (owed == 0) return;

        // ── THE FORFEIT USED TO HAPPEN HERE, AND THAT WAS THE BUG ──────────────
        //
        // This function is PERMISSIONLESS (`sync`/`syncMany`, no access control, natspec
        // "Permissionless by design"). Every zeroing of `rewards[account]` reachable from
        // here was therefore a stranger's call, and forfeited wei re-streams to REMAINING
        // stakers — so a large staker was PAID pro-rata for confiscating everyone else's
        // accrual. One call, gas only.
        //
        // Two attempts were made to make that safe by engineering a precise grace anchor.
        // Both were refuted, each by two independent adversarial reviews, and the second
        // refutation showed no `lockEnd`-derived anchor can EVER exist for restakers.
        // The conclusion was that the anchor was never the problem: a permissionless
        // confiscation path turns every imprecision into someone losing ETH.
        //
        // So the forfeit moved behind the owner timelock, matching v1
        // (`RevenueDistributor.FORFEIT_RECLAIM`, 48h + a 1% lifetime cap) — which is why
        // an escrow failure in v1 was only ever a retryable lockout. `sync` now does
        // exactly one thing: it updates the mirror. It cannot reduce `rewards`, cannot
        // touch `totalForfeitedToPool`, and cannot cost any account a wei.
        //
        // `owed` is read above purely to skip the mirror write for accounts with nothing
        // to protect; it is no longer a precondition for taking anything.
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  RESERVE ACCOUNTING                                            ║
    // ═══════════════════════════════════════════════════════════════════

    /// @notice ETH already committed: the unspent tail of the active schedule, the
    ///         window accrued since the last touch, and everything credited to
    ///         accounts but not yet withdrawn.
    /// @dev Deliberately does NOT carry a separate pending-withdrawal term. That is
    ///      v1's REV-RESERVE-01 lesson: a queued payee's wei is still inside the
    ///      credited-minus-paid term, and adding it again over-reserves and strands
    ///      an equal amount of genuinely distributable revenue. There is no queue
    ///      here at all — `WETHFallbackLib` guarantees delivery as ETH or as WETH —
    ///      but the same double-count is the shape to avoid.
    function reservedETH() public view returns (uint256) {
        uint256 remaining = block.timestamp < periodFinish
            ? (periodFinish - block.timestamp) * rewardRate
            : 0;

        uint256 pendingWindow;
        if (totalEffectiveSupply != 0) {
            uint256 applicable = lastTimeRewardApplicable();
            if (applicable > lastUpdateTime) {
                pendingWindow = (applicable - lastUpdateTime) * rewardRate;
            }
        }

        uint256 settled = totalPaidOut + totalForfeitedToPool;
        uint256 outstanding = totalStreamed > settled ? totalStreamed - settled : 0;
        return remaining + pendingWindow + outstanding;
    }

    /// @notice Un-reserved ETH — the budget the next `notifyRewardAmount` would stream.
    /// @dev Truncation in `rewardPerToken` / `earned` means the sum actually payable is
    ///      at most `totalStreamed`, so `outstanding` above is an upper bound and this
    ///      view is a lower bound. The residue is sub-wei-per-crystallisation dust that
    ///      stays in the contract; there is no owner path to extract it, which is the
    ///      intended trade — dust stranded in the staker pool beats an owner ETH exit.
    function distributable() public view returns (uint256) {
        uint256 reserved = reservedETH();
        uint256 bal = address(this).balance;
        return bal > reserved ? bal - reserved : 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  STREAM SCHEDULING                                             ║
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Start (or top up) the emission schedule from the un-reserved balance.
    ///         Permissionless, like v1's `distributePermissionless` — no keeper
    ///         privilege, no owner dependency for revenue to reach stakers.
    /// @dev Not payable, and it reads the balance rather than an argument. Same H-06
    ///      reasoning as v1: a payable notify lets an attacker top up by exactly enough
    ///      to clear the minimum and drive the cadence.
    function notifyRewardAmount() external nonReentrant whenNotPaused updateReward(address(0)) {
        if (!streamingEnabled) revert StreamingDisabled();

        // Ported from v1's M-14 [F-13-2]. The staking pause is the protocol's
        // "checkpoint data is corrupt" kill switch. If claims must refuse to read that
        // data then scheduling must refuse to commit revenue against it — the mirror
        // this schedule pays out over is built from exactly those reads.
        if (_isStakingPaused()) revert StakingPaused();

        if (lastNotifyTime != 0 && block.timestamp < lastNotifyTime + NOTIFY_COOLDOWN) {
            revert NotifyCooldownActive();
        }

        uint256 newETH = distributable();
        if (newETH < MIN_NOTIFY_AMOUNT) revert NotifyAmountTooSmall();

        uint256 duration = rewardsDuration;

        // Synthetix leftover-rollover, verbatim: the unspent tail of the current
        // schedule is folded into the new budget rather than dropped.
        uint256 leftover = block.timestamp < periodFinish
            ? (periodFinish - block.timestamp) * rewardRate
            : 0;
        uint256 budget = leftover + newETH;

        // slither-disable-next-line divide-before-multiply
        rewardRate = budget / duration;
        if (rewardRate == 0) revert NotifyAmountTooSmall();

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        lastNotifyTime = block.timestamp;

        // The integer-division residue (< duration wei) is simply left un-reserved and
        // is picked up by the next notify. No separate dust bucket, no owner sweep.
        if (address(this).balance < reservedETH()) revert ScheduleUnfunded();

        emit RewardAdded(newETH, rewardRate, periodFinish);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  CLAIMING                                                      ║
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Withdraw crystallised accrual. Self-syncs first, so a staker who has
    ///         never called `sync` still starts accruing from this call forward
    ///         (but is paid nothing for the window before it — see (X) in the header).
    function getReward() external nonReentrant whenNotPaused updateReward(msg.sender) {
        // v1's M-10: corrupted staking checkpoints must not be monetised while the
        // staking kill-switch is engaged.
        if (_isStakingPaused()) revert StakingPaused();

        // v1's lock/grace gate, ported: an account with no live position and past its
        // grace window cannot withdraw. `_syncAndMaybeRecycle` is what eventually
        // recycles such an account's balance back to the pool, and this gate is its exact
        // complement by construction — it refuses precisely when that one forfeits, off
        // the same `_claimDeadlineOf`. An unreadable escrow must therefore fail the SAME
        // way here as it does there, toward the staker: refusing a claim on evidence we
        // could not read would leave an account simultaneously unable to withdraw its own
        // ETH and (before this fix) instantly forfeitable — an outage rendering as a
        // legitimate negative. Letting `!ok` through is not a surface: it withdraws the
        // caller's OWN crystallised accrual, `votingEscrow` is immutable, and no staker
        // can induce the failure.
        // Structured to mirror `_syncAndMaybeRecycle` gate-for-gate, and to keep the
        // original short-circuit: a live mirror makes no external call at all.
        if (effectiveBalanceOf[msg.sender] == 0) {
            (bool restakingOk, bool restaked) = _isRestaked(msg.sender);
            if (restakingOk && !restaked) {
                (bool ok, uint256 deadline) = _claimDeadlineOf(msg.sender);
                if (ok && block.timestamp >= deadline) revert NoLockedTokens();
            }
        }

        uint256 reward = rewards[msg.sender];
        if (reward == 0) revert NothingToClaim();

        rewards[msg.sender] = 0;
        totalPaidOut += reward;

        // Delivery is guaranteed as ETH or, if the recipient's `receive()` does not fit
        // the stipend, as WETH. There is deliberately no pending-withdrawal queue to
        // brick or to double-count in `reservedETH`.
        WETHFallbackLib.safeTransferETHOrWrap(address(weth), msg.sender, reward);

        emit RewardPaid(msg.sender, reward);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  STAKING READS                                                 ║
    // ═══════════════════════════════════════════════════════════════════

    function _isStakingPaused() internal view returns (bool) {
        try votingEscrow.paused() returns (bool p) {
            return p;
        } catch {
            return false;
        }
    }

    /// @dev Restaking membership, three-valued. An UNSET restaking contract is a genuine
    ///      answer — while the zero-address gate is closed nobody is restaked, by
    ///      construction — but a FAILED read is not, and must never be read as "this
    ///      account has exited". Restakers reach this helper with `_lockEndOf` already
    ///      structurally 0 (TegridyStaking custodies their NFT, so `userTokenId` is 0 and
    ///      `votingPowerOf` force-returns 0 for the restaking address), which makes this
    ///      the ONLY guard standing between a restaker and a permissionless forfeit.
    /// @return ok       False iff the restaking read failed. `restaked` is meaningless then.
    /// @return restaked True iff `account` holds a live restaking position.
    function _isRestaked(address account) internal view returns (bool ok, bool restaked) {
        if (address(restakingContract) == address(0)) return (true, false);
        // slither-disable-next-line unused-return
        try restakingContract.restakers(account) returns (
            uint256 tokenId, uint256 positionAmount, uint256, int256, uint256
        ) {
            return (true, tokenId != 0 && positionAmount > 0);
        } catch {
            return (false, false);
        }
    }

    /// @dev Present-state lock expiry. Returns `(false, 0)` for every read FAILURE, so a
    ///      caller can distinguish "the escrow says this account has no position" from
    ///      "the escrow did not answer". Same two-value shape, and the same reason, as
    ///      `LaunchRugEscrow._readCovenantBps`: collapsing those two into a bare 0 is what
    ///      let a transient outage read as a legitimate expiry, and the arity change is
    ///      what makes the distinction impossible for a caller to drop by accident.
    ///
    ///      Only reached for accounts whose live power is already 0, so the single
    ///      `userTokenId` pointer is sufficient here — the multi-NFT undercount that
    ///      forced v1's aggregate-first `_getUserLockState` cannot bite, because any
    ///      account with a second live position would have non-zero power and never
    ///      reach this path.
    /// @return ok      False iff a staking read REVERTED. `lockEnd` is meaningless then.
    ///                 See the honesty bound on `_effectivePower`: a codeless escrow is
    ///                 not caught here either, but it bricks the whole call rather than
    ///                 producing a false `ok == true`, so this flag never lies.
    /// @return lockEnd 0 with `ok == true` is a genuine "no position", NOT an unknown;
    ///                 >0 is the position's expiry instant.
    function _lockEndOf(address account) internal view returns (bool ok, uint256 lockEnd) {
        try votingEscrow.userTokenId(account) returns (uint256 tokenId) {
            if (tokenId == 0) return (true, 0);
            // slither-disable-next-line unused-return
            try votingEscrow.positions(tokenId) returns (
                uint256, uint256, int256, uint256 _lockEnd,
                uint256, uint256, bool, bool, uint256, uint256, bool
            ) {
                return (true, _lockEnd);
            } catch {
                return (false, 0);
            }
        } catch {
            return (false, 0);
        }
    }

    /// @dev The instant `account`'s claim window closes. The single place the grace
    ///      arithmetic lives, so the forfeit gate and the claim gate cannot drift apart.
    ///
    ///      Anchor precedence, and why:
    ///        - `lockEnd != 0` -> the documented `lockEnd + CLAIM_GRACE_PERIOD`. A real
    ///          expiry always wins; this is v1's semantic and is deliberately not extended.
    ///        - `lockEnd == 0` from a READABLE escrow is a real answer about the POSITION
    ///          ("none") but NOT an answer about the window, and it is the ORDINARY exit
    ///          path rather than an edge case: `TegridyStaking` zeroes `userTokenId[from]`
    ///          on every outbound transfer, and `withdraw` runs
    ///          `delete positions[tokenId]; _burn(tokenId)`. Restakers sit in that state
    ///          permanently. So this returns UNKNOWN, and the callers disagree on purpose.
    /// @return ok       False when no window can be determined — either the escrow was
    ///                  unreadable, or there is no durable anchor. `deadline` is
    ///                  meaningless then, and each caller must resolve it TOWARD THE
    ///                  STAKER: allow the claim, refuse the forfeit.
    /// @return deadline Claim window closes at this instant. Only meaningful when `ok`.
    function _claimDeadlineOf(address account) internal view returns (bool ok, uint256 deadline) {
        uint256 lockEnd;
        (ok, lockEnd) = _lockEndOf(account);
        if (!ok) return (false, 0);

        // NO DURABLE ANCHOR EXISTS, so the honest answer is UNKNOWN.
        //
        // `exitedAt` — the instant this contract first NOTICED the mirror fall to zero —
        // used to fill this gap and was REFUTED twice. `TegridyStaking.withdraw` is gated
        // on `block.timestamp >= p.lockEnd` and burns the NFT, so the only permitted exit
        // ERASES the fact grace is measured from; and the account is normally the first to
        // move the mirror, so it chose the anchor's value. A past-grace account could
        // withdraw, manufacture a fresh window, and be paid ETH already assigned to
        // `totalForfeitedToPool`.
        //
        // Restakers make it worse: their NFT is custodied by TegridyRestaking, so
        // `userTokenId` is 0 and this returns a GENUINE, READABLE `lockEnd == 0` for their
        // entire life while rewards accrue. No `lockEnd`-derived anchor can ever exist for
        // them.
        //
        // Returning `(true, 0)` here — "grace never opened" — is what made that dangerous:
        // it read as a definitively EXPIRED window. `(false, 0)` says we do not know, and
        // the two callers resolve it in opposite directions, both toward the staker:
        // `getReward` ALLOWS the claim, and the forfeit path refuses to forfeit.
        if (lockEnd == 0) return (false, 0);
        return (true, lockEnd + CLAIM_GRACE_PERIOD);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  TIMELOCKED ADMIN                                              ║
    // ═══════════════════════════════════════════════════════════════════

    function proposeEnableStreaming() external onlyOwner {
        if (streamingEnabled) revert StreamingAlreadyEnabled();
        _propose(STREAMING_ENABLE, STREAMING_ENABLE_DELAY);
        emit StreamingEnableProposed(_executeAfter[STREAMING_ENABLE]);
    }

    /// @dev One-way. There is no `disableStreaming`: an off switch that can strand an
    ///      in-flight schedule is a worse failure than the pause this contract already
    ///      inherits, and `pause()` already freezes notify, sync and claim together.
    function executeEnableStreaming() external onlyOwner {
        _execute(STREAMING_ENABLE);
        streamingEnabled = true;
        emit StreamingEnabled();
    }

    function cancelEnableStreaming() external onlyOwner {
        _cancel(STREAMING_ENABLE);
        emit StreamingEnableCancelled();
    }

    /// @dev Gated on a completed period, mirroring the sibling's DEEP-DR-05 pairing:
    ///      changing the duration mid-stream re-times money already promised.
    function proposeRewardsDurationChange(uint256 _newDuration) external onlyOwner {
        if (_newDuration < MIN_REWARDS_DURATION || _newDuration > MAX_REWARDS_DURATION) {
            revert DurationOutOfRange();
        }
        if (block.timestamp < periodFinish) revert PreviousPeriodNotComplete();
        pendingRewardsDuration = _newDuration;
        _propose(REWARDS_DURATION_CHANGE, REWARDS_DURATION_DELAY);
        emit RewardsDurationProposed(_newDuration, _executeAfter[REWARDS_DURATION_CHANGE]);
    }

    function executeRewardsDurationChange() external onlyOwner {
        if (block.timestamp < periodFinish) revert PreviousPeriodNotComplete();
        _execute(REWARDS_DURATION_CHANGE);
        uint256 old = rewardsDuration;
        rewardsDuration = pendingRewardsDuration;
        pendingRewardsDuration = 0;
        emit RewardsDurationUpdated(old, rewardsDuration);
    }

    function cancelRewardsDurationChange() external onlyOwner {
        _cancel(REWARDS_DURATION_CHANGE);
        pendingRewardsDuration = 0;
        emit RewardsDurationChangeCancelled();
    }

    function proposeRestakingChange(address _restaking) external onlyOwner {
        if (_restaking == address(0)) revert ZeroAddress();
        pendingRestaking = _restaking;
        _propose(RESTAKING_CHANGE, RESTAKING_CHANGE_DELAY);
        emit RestakingChangeProposed(_restaking, _executeAfter[RESTAKING_CHANGE]);
    }

    function executeRestakingChange() external onlyOwner {
        _execute(RESTAKING_CHANGE);
        restakingContract = ITegridyRestaking(pendingRestaking);
        emit RestakingContractUpdated(pendingRestaking);
        pendingRestaking = address(0);
    }

    // ── FORFEIT: OWNER-TIMELOCKED, AND THAT IS THE SECURITY PROPERTY ─────────
    //
    // Reclaiming genuinely abandoned accrual is legitimate — otherwise a dead account's
    // ETH sits here forever and the pool can never recover it. What is NOT legitimate is
    // letting anyone do it on a read we might have got wrong.
    //
    // v2 originally forfeited inside the PERMISSIONLESS `sync`. Two attempts to make that
    // safe with a precise grace anchor were refuted, each by two independent adversarial
    // reviews, and the second showed no `lockEnd`-derived anchor can exist for restakers
    // at all. This is v1's shape instead: propose, wait 48h, execute, capped at 1% of
    // lifetime streamed. An imprecise eligibility read now costs a delay, not a
    // confiscation — which is the entire reason an escrow failure in v1 was only ever a
    // retryable lockout.

    /// @notice Propose forfeiting the crystallised accrual of specific accounts.
    /// @dev Eligibility is checked HERE and again at execute. Both resolve an unknown
    ///      TOWARD THE STAKER: `_isRestaked` or `_claimDeadlineOf` returning `ok == false`
    ///      makes the account ineligible, because "we could not read the escrow" and "this
    ///      account abandoned its rewards" are different facts and only one of them
    ///      justifies taking money.
    function proposeForfeit(address[] calldata accounts) external onlyOwner {
        uint256 len = accounts.length;
        if (len == 0) revert ForfeitBatchEmpty();
        if (len > MAX_FORFEIT_BATCH) revert ForfeitBatchTooLarge();

        // Reject the WHOLE batch if any member is ineligible rather than silently
        // skipping it. A partial proposal that quietly drops names is how an operator
        // ends up believing an account was reclaimed when it never was.
        for (uint256 i; i < len; ++i) {
            if (!_isForfeitable(accounts[i])) revert NotForfeitable(accounts[i]);
        }

        delete pendingForfeitAccounts;
        for (uint256 i; i < len; ++i) pendingForfeitAccounts.push(accounts[i]);

        _propose(FORFEIT_RECLAIM, FORFEIT_RECLAIM_DELAY);
        emit ForfeitProposed(accounts, _executeAfter[FORFEIT_RECLAIM]);
    }

    /// @notice Execute a matured forfeit proposal.
    /// @dev RE-CHECKS eligibility per account. 48 hours is long enough for a lock to be
    ///      extended or a position restaked, and an account that became legitimate again
    ///      inside the window must not be taken — so an ineligible member is SKIPPED here
    ///      rather than reverting the batch, and the event reports the skip count so it is
    ///      visible off-chain instead of looking like a clean sweep.
    function executeForfeit() external onlyOwner {
        _execute(FORFEIT_RECLAIM);

        address[] memory accounts = pendingForfeitAccounts;
        delete pendingForfeitAccounts;

        uint256 taken;
        uint256 skipped;
        for (uint256 i; i < accounts.length; ++i) {
            address account = accounts[i];
            uint256 owed = rewards[account];
            if (owed == 0 || !_isForfeitable(account)) {
                ++skipped;
                continue;
            }
            rewards[account] = 0;
            totalForfeitedToPool += owed;
            taken += owed;
            emit RewardsForfeitedToPool(account, owed);
        }
        emit ForfeitExecuted(accounts.length - skipped, skipped, taken);
    }

    /// @notice The accounts a pending forfeit would hit. Read this during the 48h
    ///         window; the public array's index getter cannot be enumerated by a monitor
    ///         that does not already know the length.
    function pendingForfeit() external view returns (address[] memory accounts, uint256 executeAfter) {
        return (pendingForfeitAccounts, _executeAfter[FORFEIT_RECLAIM]);
    }

    function cancelForfeit() external onlyOwner {
        _cancel(FORFEIT_RECLAIM);
        delete pendingForfeitAccounts;
        emit ForfeitCancelled();
    }

    /// @dev Eligible only on POSITIVE evidence of abandonment: the escrow read back, the
    ///      account is not restaked, a claim window was determinable, and it has closed.
    ///      Every `false` below is a refusal to take money on a fact we do not have.
    function _isForfeitable(address account) internal view returns (bool) {
        if (account == address(0)) return false;
        if (effectiveBalanceOf[account] != 0) return false;

        (bool restakingOk, bool restaked) = _isRestaked(account);
        if (!restakingOk || restaked) return false;

        (bool ok, uint256 deadline) = _claimDeadlineOf(account);
        if (!ok) return false;
        return block.timestamp >= deadline;
    }

    function cancelRestakingChange() external onlyOwner {
        _cancel(RESTAKING_CHANGE);
        address cancelled = pendingRestaking;
        pendingRestaking = address(0);
        emit RestakingChangeCancelled(cancelled);
    }

    // ─── Pause ────────────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function setPauseGuardian(address _newGuardian) external onlyOwner { _setPauseGuardian(_newGuardian); }
    function guardianPause() external onlyPauseGuardian { _pause(); }
}
