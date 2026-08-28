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
///  owner-side ETH exit at all, and as of 2026-08-26 no forfeiture either: there is
///  exactly ONE way for wei to leave this contract, and it is `getReward` paying an
///  account its own accrual. No path moves value between accounts. The protocol
///  spends nothing it has not earned, and can take nothing at all.
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
///  M7. v1's 7-day `CLAIM_GRACE_PERIOD` still applies TO v1 — a staker whose lock
///      expires during the cutover has 7 days from their own `lockEnd` to drain v1,
///      so publish the cutover at least 7 days ahead of any clustered lock cliff or
///      those epochs forfeit inside v1. v2 has no such deadline: it dropped the
///      claim grace along with the forfeit on 2026-08-26, so nothing here expires.
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

    uint256 public constant STREAMING_ENABLE_DELAY = 48 hours;
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

    /// @dev `syncMany` iterates external staking reads (~5 calls each, incl. the
    ///      grace-anchor observation). 100 keeps the worst case far inside a block at
    ///      the same order as v1's MAX_CLAIM_EPOCHS per-call budget.
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


    // ─── Reserve accounting (delta D3) ───────────────────────────────

    /// @notice Emission that has been credited to the pool across windows in which
    ///         `totalEffectiveSupply > 0`. Empty-window emission is Synthetix-forfeit
    ///         and deliberately NOT counted here, which is what makes it re-streamable.
    uint256 public totalStreamed;
    /// @notice ETH that has actually left through `getReward`.
    uint256 public totalPaidOut;
    /// @notice Crystallised accrual recycled back to the staker pool by `sync` after
    ///         an account's grace period elapsed. Never routed to an owner or treasury.

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
    event RewardsForfeitedDuringEmptyPeriod(uint256 amount);
    /// @notice A sync could not read `account`'s power, so the mirror was left at
    ///         `keptBalance`. Emitted instead of silently writing a zero.
    event MirrorReadUnavailable(address indexed account, uint256 keptBalance);
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
    error DurationOutOfRange();
    error StreamingDisabled();
    error StreamingAlreadyEnabled();
    error StakingPaused();
    error NotifyCooldownActive();
    error NotifyAmountTooSmall();
    error NothingToClaim();
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

            // AN UNREADABLE READ IS NOT A ZERO. (2026-08-26)
            //
            // This used to call `_effectivePower`, which discards the `readable`
            // flag and returns 0 when the escrow or the restaking read reverts.
            // That zero was then written into the mirror and subtracted from
            // `totalEffectiveSupply` — so the stream re-priced onto whoever
            // happened to stay mirrored.
            //
            // `sync`/`syncMany` are permissionless BY DESIGN (the accrual is only
            // correct while the mirror tracks reality, so anyone must be able to
            // correct anyone). That made the zero a stranger's to write: call
            // `sync(victim)` while the read is failing, do not sync yourself, and
            // absorb their share. Accrual is not retroactive, so re-syncing the
            // victim afterwards does not give the window back. An adversarial
            // review measured 22x amplification via `syncMany` over 50 victims —
            // and it bypassed the staking kill switch, which `getReward` and
            // `notifyRewardAmount` both respect.
            //
            // So a read we could not perform now changes NOTHING. The mirror keeps
            // its last known-good value until a readable one replaces it. The
            // trade is deliberate and it is the safe direction: a stale-high
            // mirror over-credits an account that has genuinely left, which costs
            // the pool a bounded amount of stream; a stranger-written zero
            // under-credits an account that has NOT left, which takes their money.
            //
            // Residual, stated rather than hidden: the restaking leg is called with
            // a gas stipend, so a restaking contract that reverts or exhausts the
            // stipend holds its own stakers' mirrors stale. That is a misbehaving
            // dependency, not a caller-chosen attack, and it fails toward the
            // staker rather than away from them.
            (bool readable, uint256 newEff) = _mirrorPower(account);
            uint256 oldEff = effectiveBalanceOf[account];
            if (readable && oldEff != newEff) {
                totalEffectiveSupply = totalEffectiveSupply - oldEff + newEff;
                effectiveBalanceOf[account] = newEff;
                emit BalanceSynced(account, oldEff, newEff);
            } else if (!readable) {
                emit MirrorReadUnavailable(account, oldEff);
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
    ///         mirror it. Reverting staking reads degrade to 0 rather than bricking
    ///         accrual for everyone else — `votingEscrow` is immutable here, so a
    ///         future staking-side ABI break must not be fatal.
    /// @dev `votingPowerOf` already excludes expired positions, so an expired lock
    ///      mirrors to 0 without any lockEnd arithmetic on this side.
    /// @dev What `_updateReward` may WRITE into the mirror, which is a different
    ///      question from what `isSynced` may CERTIFY, and the difference is exactly
    ///      one case.
    ///
    ///      `isSynced` answers "is the mirror correct?". With no restaking contract
    ///      wired there may be restakers this contract cannot see, so the honest
    ///      answer is "cannot verify" and `_tryEffectivePower` returns `(false, 0)`.
    ///      That is 3acd395b's fix and it stays.
    ///
    ///      `_updateReward` answers "what is this account's power right now?". There,
    ///      an escrow that ANSWERED with zero and no fallback to consult is a real
    ///      zero — it is what an expired lock looks like. Treating it as unreadable
    ///      froze every expired plain-staker position at its stale-high mirror and
    ///      kept it accruing forever, which a test caught immediately.
    ///
    ///      So: unreadable means the escrow did not answer. It does not mean we had
    ///      nowhere to double-check.
    function _mirrorPower(address account) internal view returns (bool writable, uint256 power) {
        (writable, power) = _tryEffectivePower(account);
        if (!writable && power == 0 && address(restakingContract) == address(0)) {
            // Re-ask the primary directly: only its revert makes this unwritable.
            try votingEscrow.votingPowerOf(account) returns (uint256 p) {
                return (true, p);
            } catch {
                return (false, 0);
            }
        }
    }

    function _effectivePower(address account) internal view returns (uint256) {
        (, uint256 power) = _tryEffectivePower(account);
        return power;
    }

    /// @dev Two-value form of the power read, `LaunchRugEscrow._readCovenantBps`-style:
    ///      `readable` is false whenever a failure mode was collapsed into the zero — a
    ///      reverting staking read, a reverting / over-budget restaking lookup, or a
    ///      zero-power account while `restakingContract` is unset (the default
    ///      post-deploy state, in which a custodied restaker is indistinguishable from
    ///      an empty account). `_updateReward` deliberately keeps consuming the
    ///      degraded zero (liveness over accuracy, see `_effectivePower`); honesty
    ///      surfaces like `isSynced` MUST consume `readable` instead of trusting it.
    function _tryEffectivePower(address account) internal view returns (bool readable, uint256 power) {
        bool primaryReadable = true;
        try votingEscrow.votingPowerOf(account) returns (uint256 p) {
            power = p;
        } catch {
            primaryReadable = false;
        }
        if (power > 0) return (true, power);

        // Restakers read 0 above because TegridyRestaking custodies the NFT. Same
        // fallback as v1's NEW-S1; without it every restaker mirrors in at zero and
        // is silently paid nothing.
        //
        // `(false, 0)` and not `(primaryReadable, 0)`: with no fallback wired there
        // may be restakers this contract cannot see, so it cannot certify a zero.
        // `isSynced` depends on that — see `_mirrorPower` for the one caller that
        // needs the opposite answer, and why.
        if (address(restakingContract) == address(0)) return (false, 0);
        try restakingContract.boostedAmountAt{gas: RESTAKING_CALL_GAS}(account, block.timestamp) returns (uint256 p) {
            // A positive restaked balance is real data even during a staking outage;
            // a zero is only trustworthy when the primary read was also readable.
            return (p > 0 || primaryReadable, p);
        } catch {
            return (false, 0);
        }
    }

    /// @notice True once `account` has a mirrored balance that reflects a live
    ///         position. A UI MUST call this before rendering an earnings number:
    ///         a zero from an account that has staked but never synced is an
    ///         un-registered account, NOT "no revenue yet", and rendering it as the
    ///         latter is the fabricated-data failure this protocol gates against.
    /// @dev Reads the two-value power form: an UNREADABLE zero (staking outage,
    ///      restaking outage, or the restaking fallback not yet wired) reports false —
    ///      "cannot verify" must never render as "synced". A false negative here is
    ///      idle UI copy; the false positive was exactly the fabrication above.
    function isSynced(address account) external view returns (bool) {
        (bool readable, uint256 power) = _tryEffectivePower(account);
        return readable && effectiveBalanceOf[account] == power;
    }

    /// @notice Mirror `account`'s current boosted power into the accrual set.
    ///         Permissionless by design — the accrual is only correct while the
    ///         mirror tracks reality, so anyone must be able to correct anyone,
    ///         in both directions.
    function sync(address account) external nonReentrant whenNotPaused {
        if (account == address(0)) revert ZeroAddress();
        _syncMirror(account);
    }

    /// @notice Batch form for the keeper that covers the staker set at cutover.
    function syncMany(address[] calldata accounts) external nonReentrant whenNotPaused {
        uint256 len = accounts.length;
        if (len > MAX_SYNC_BATCH) revert SyncBatchTooLarge();
        for (uint256 i; i < len; ++i) {
            address a = accounts[i];
            if (a == address(0)) continue;
            _syncMirror(a);
        }
    }

    /// @dev Refresh `account`'s mirrored effective power from its live staking +
    ///      restaking legs, so accrual is priced off current power. MIRROR-ONLY: it
    ///      moves no funds, credits no pool, and can never reduce `rewards[account]`.
    ///      (The forfeit/recycle mechanism that once lived here is GONE — the
    ///      historical note below is why. Do not describe this function as moving or
    ///      recycling value; it does not.)
    /// @dev Mirror-only. THE FORFEIT USED TO LIVE HERE AND IT IS GONE. (2026-08-26)
    ///
    ///      Four attempts were made to make a permissionless confiscation safe by
    ///      engineering a precise "is this account abandoned" test. Attempts 1, 2
    ///      and 3 were each refuted by two independent adversarial reviews.
    ///      Attempt 4 moved the forfeit behind an owner timelock and was refuted
    ///      too — 9 confirmed defects, because the eligibility input was still
    ///      built from stale mirrors and a stranger-writable anchor.
    ///
    ///      The lesson the fourth refutation finally made unambiguous: the anchor
    ///      was never the problem, and neither was the caller. THE FORFEIT was the
    ///      problem. Every version of it had to answer "has this account abandoned
    ///      its rewards?" from chain state that cannot actually answer it, and each
    ///      wrong answer took somebody's ETH.
    ///
    ///      Synthetix `StakingRewards` — the battle-tested upstream this contract's
    ///      accrual is modelled on, unhacked since 2019 — has no forfeiture at all.
    ///      Neither does this now. Unclaimed rewards stay `rewards[account]`
    ///      forever, claimable only by that account.
    ///
    ///      What that costs: a genuinely dead account's ETH is never recycled to
    ///      the pool and sits here indefinitely. That is the price, it is bounded
    ///      by what those accounts actually earned, and it is the correct side to
    ///      err on — the protocol has no claim on user funds it cannot prove were
    ///      abandoned, and four attempts established that it cannot prove it.
    ///
    ///      Nothing reachable from `sync` can now reduce `rewards`, and there is no
    ///      longer any mechanism by which one account's balance moves to another.
    function _syncMirror(address account) internal {
        _updateReward(account);
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

        // Nothing is ever recycled now (the forfeit is gone), so the only wei that
        // leaves the pool leaves through `getReward`.
        uint256 settled = totalPaidOut;
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

        // THERE IS NO CLAIM DEADLINE. (2026-08-26)
        //
        // This used to refuse `NoLockedTokens()` once an account had no live
        // position and its 7-day grace had elapsed. That gate only ever existed to
        // pair with the recycle: "claim within the window or the pool takes it."
        // The recycle is gone, so refusing a claim now strands a staker's own ETH
        // for nobody's benefit — no other account can receive it either.
        //
        // Removing it also closes the other half of a confirmed defect. The grace
        // anchor was written by `_observeLockEnd` from whatever veNFT
        // `userTokenId[account]` pointed at, and `StakingRewardLib.afterTokenTransfer`
        // lets ANYONE transfer a position in to an account whose pointer is zero.
        // A stranger could therefore send an expired dust veNFT to a victim (an
        // ERC-721 transfer needs no consent), call the permissionless `sync`, drive
        // the anchor BACKWARDS, and slam this gate shut on the victim's whole
        // crystallised balance. With no deadline there is nothing to slam shut, and
        // the anchor itself is deleted rather than merely unused.
        //
        // Synthetix `StakingRewards.getReward` has no deadline either.

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

    /// @dev Two-value, `LaunchRugEscrow._readCovenantBps`-style: `readable` is false
    ///      when the restaking read reverts or exceeds its gas budget (same F-50-8 cap
    ///      as `boostedAmountAt`), so the recycle path can refuse rather than treat an
    ///      outage as "not restaked". An unset restaking contract is a READABLE
    ///      "not restaked" — the claim gate must not treat everyone as restaked — and
    ///      the recycle path refuses that state separately.
    function _isRestaked(address account) internal view returns (bool readable, bool restaked) {
        if (address(restakingContract) == address(0)) return (true, false);
        // slither-disable-next-line unused-return
        try restakingContract.restakers{gas: RESTAKING_CALL_GAS}(account) returns (
            uint256 tokenId, uint256 positionAmount, uint256, int256, uint256
        ) {
            return (true, tokenId != 0 && positionAmount > 0);
        } catch {
            return (false, false);
        }
    }

    /// @dev LOAD-BEARING only for accounts whose live power is already 0 (the grace
    ///      decisions), so the single `userTokenId` pointer is sufficient here — the
    ///      multi-NFT undercount that forced v1's aggregate-first `_getUserLockState`
    ///      cannot bite, because any account with a second live position would have
    ///      non-zero power and never be recycled or grace-gated.
    ///      Two-value, `LaunchRugEscrow._readCovenantBps`-style: `(false, 0)` for a
    ///      reverting read so callers can distinguish "no data" from "no current
    ///      position" (`(true, 0)`). Collapsing both into a bare 0 used to be the
    ///      claim-grace contradiction — fail-OPEN forfeiture and fail-CLOSED claims
    ///      from the same undifferentiated zero. Both consumers are gone as of
    ///      2026-08-26; the distinction is kept because `_isForfeitable`'s successor
    ///      problem (an unreadable read must never read as "absent") still applies to
    ///      every future caller.
    function _lockEndOf(address account) internal view returns (bool readable, uint256 lockEnd) {
        try votingEscrow.userTokenId(account) returns (uint256 tokenId) {
            if (tokenId == 0) return (true, 0);
            // slither-disable-next-line unused-return
            try votingEscrow.positions(tokenId) returns (
                uint256, uint256, int256, uint256 le,
                uint256, uint256, bool, bool, uint256, uint256, bool
            ) {
                return (true, le);
            } catch {
                return (false, 0);
            }
        } catch {
            return (false, 0);
        }
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
