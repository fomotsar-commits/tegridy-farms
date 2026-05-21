// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";

/// @dev Interface for TegridyStaking (voting escrow) — Curve-style checkpoint queries.
interface IVotingEscrow {
    function votingPowerOf(address user) external view returns (uint256);
    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256);
    function totalLocked() external view returns (uint256);
    function totalBoostedStake() external view returns (uint256);
    /// @notice AUDIT REV-M-01 (MEDIUM, 2026-04-28): historical totalBoostedStake at `ts`.
    ///         Used by `_distribute` to pin the epoch denominator at `block.timestamp - 1`
    ///         so a same-block stake (Trace208 key == block.timestamp) is EXCLUDED from
    ///         the read — matching the same-block exclusion already enforced for
    ///         per-user `votingPowerAtTimestamp(user, T-1)` in `_calculateClaim`.
    function totalBoostedStakeAtTimestamp(uint256 ts) external view returns (uint256);
    function userTokenId(address user) external view returns (uint256);
    // H-01 FIX: Aligned to actual TegridyStaking.Position struct ABI order
    // AUDIT H-1 (2026-04-20): Position struct extended with jbacTokenId + jbacDeposited.
    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint256 lockEnd,
        uint256 boostBps, uint256 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        uint256 stakeTimestamp, uint256 jbacTokenId, bool jbacDeposited
    );
    function paused() external view returns (bool); // AUDIT FIX M-10: Check staking pause state
}

/// @dev Interface for TegridyRestaking to check if a user has a restaked position.
interface ITegridyRestaking {
    function restakers(address user) external view returns (
        uint256 tokenId, uint256 positionAmount, uint256 boostedAmount, int256 bonusDebt, uint256 depositTime
    );
    /// @notice AUDIT NEW-S1 (CRITICAL): returns user's restaker boostedAmount at a given
    ///         timestamp, or 0 if they had no active restaked position at that time.
    ///         Used as a fallback voting-power source when the staking checkpoint
    ///         reads 0 (always the case for restakers, because the NFT is held by
    ///         the restaking contract, not the user).
    function boostedAmountAt(address user, uint256 timestamp) external view returns (uint256);
}

/// @title RevenueDistributor
/// @notice Distributes ETH revenue to veTOWELI holders using the Curve FeeDistributor
///         auto-checkpoint pattern. No registration required — shares are computed from
///         on-chain voting power checkpoints at each epoch's timestamp.
///
///         How it works:
///         1. Protocol fees (ETH) are sent to this contract
///         2. Anyone calls distribute() to snapshot a new epoch
///         3. Each epoch records: total ETH + totalBoostedStake at that moment
///         4. Users call claim() to receive their share across all unclaimed epochs
///         5. Share = (votingPowerAtTimestamp(user, epoch.timestamp) / epoch.totalLocked) * epoch.totalETH
///
///         Uses checkpointed voting power — users who lock more or lock longer
///         receive proportionally more revenue. The checkpoint system means users
///         cannot retroactively claim epochs they had no power at.
///
///         Design choices:
///         - Epoch-based (not streaming) for gas efficiency
///         - Curve FeeDistributor pattern: no registration, checkpoint-based shares
///         - Permissionless claim (users claim when they want)
///         - Unclaimed ETH persists — no expiry
///         - Failed ETH transfers credited to pendingWithdrawals (pull pattern)
contract RevenueDistributor is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {

    // ─── TimelockAdmin Keys ──────────────────────────────────────────
    bytes32 public constant TREASURY_CHANGE = keccak256("TREASURY_CHANGE");
    bytes32 public constant RESTAKING_CHANGE = keccak256("RESTAKING_CHANGE");
    bytes32 public constant EMERGENCY_WITHDRAW_EXCESS = keccak256("EMERGENCY_WITHDRAW_EXCESS");
    bytes32 public constant TOKEN_SWEEP = keccak256("TOKEN_SWEEP");
    /// @notice AUDIT R014 H-5: Per-(user,epoch) admin recovery for users whose staking
    ///         checkpoint was zeroed (e.g. NFT transferred out, position corrupted) and
    ///         who now revert with NoLockedTokens(). Each proposal is keyed by the
    ///         (user, epoch) pair so multiple recoveries can be in-flight in parallel.
    /// @dev    AUDIT REV-M-03 (CLEANUP): the prior `CLAIM_RECOVERY` bytes32 constant has
    ///         been removed. It was never used as a key for `_executeAfter` (recoveries
    ///         live in `pendingRecoveries[user][epoch]` instead) so it served only as a
    ///         tag passed to TimelockAdmin's `ProposalNotReady`/`ProposalExpired` errors.
    ///         Those error paths now use the recovery-specific `RecoveryNotReady` /
    ///         `RecoveryExpired` errors below for clarity.
    uint256 public constant CLAIM_RECOVERY_DELAY = 48 hours;

    // ─── State ────────────────────────────────────────────────────────

    using SafeERC20 for IERC20;

    IVotingEscrow public immutable votingEscrow;
    IWETH public immutable weth;
    ITegridyRestaking public restakingContract;
    address public treasury;

    // Timelock for restaking contract changes
    uint256 public constant RESTAKING_CHANGE_DELAY = 48 hours;
    address public pendingRestaking;

    struct Epoch {
        uint256 totalETH;         // ETH distributed in this epoch
        uint256 totalLocked;      // Total boosted stake at distribution time
        uint256 timestamp;        // When this epoch was created
    }

    Epoch[] public epochs;
    mapping(address => uint256) public lastClaimedEpoch; // Next epoch index to claim from
    mapping(uint256 => uint256) public epochClaimed; // AUDIT FIX C-03: Total ETH claimed per epoch
    uint256 public totalDistributed;
    uint256 public totalClaimed;
    uint256 public totalEarmarked; // ETH allocated to epochs but not yet claimed
    uint256 public totalForfeited; // Track forfeited ETH so totalDistributed stays accurate

    // Pending withdrawals for contracts that can't receive ETH
    mapping(address => uint256) public pendingWithdrawals;

    // AUDIT R014 H-5: Per-(user,epoch) claim-recovery state. Owner attests historical
    // power off-chain (from staking checkpoint at epoch.timestamp); after a 48h timelock
    // the user is paid as if they had that power. Decrements epoch.totalETH via epochClaimed.
    struct PendingRecovery {
        uint256 power;        // Attested historical voting power
        uint256 executeAfter; // Timelock unlock timestamp
    }
    mapping(address => mapping(uint256 => PendingRecovery)) public pendingRecoveries;
    // Per-(user,epoch) idempotency for recovery executions (separate from lastClaimedEpoch
    // because recovery is for users who can't traverse the normal claim loop).
    mapping(address => mapping(uint256 => bool)) public recoveryClaimed;
    // AUDIT FIX: DEEP-DR-M-04 — per-(user,epoch) flag set by normal-claim
    // iterations that produced non-zero `userPower`. Used by
    // `proposeClaimRecovery` (and the view path) to skip epochs already
    // settled normally, regardless of the cursor position.
    // AUDIT FIX FRESH-2026: F1 / F-REV-EXRESTAKER — gate the seal on
    //         `userPower > 0`. Pre-fix the seal fired unconditionally (in
    //         the `if (epoch.totalLocked > 0)` branch), permanently locking
    //         ex-restakers out of `proposeClaimRecovery` for epochs where
    //         their staking-side checkpoint had been zeroed by restake. Now
    //         zero-power epochs stay eligible for owner-attested recovery,
    //         and `recoveryClaimed[user][epoch]` continues to prevent
    //         double-recovery on legitimately-paid epochs.
    mapping(address => mapping(uint256 => bool)) public claimedAtEpoch;

    // AUDIT REV-H-02 (HIGH): per-epoch in-flight pending recovery count. Bumped on
    // proposeClaimRecovery (when the slot was empty), decremented on
    // executeClaimRecovery and cancelClaimRecovery. Used by autoReconcileDust to
    // SKIP any epoch with non-zero count so the recovery's source pool is preserved
    // for executeClaimRecovery to pay out from. Without this, a permissionless
    // autoReconcileDust call during the 48h timelock would set
    // epochClaimed[src] = epoch.totalETH, causing executeClaimRecovery to revert
    // NothingToClaim() forever — irreversibly bricking the recovery and rugging
    // the corrupted user.
    mapping(uint256 => uint256) public pendingRecoveryCount;

    // Max epochs claimable in a single call / view iteration cap
    // R064 (MEDIUM): lowered from 500 → 250. _calculateClaim runs a binary-search
    // Checkpoints.upperLookup PLUS a try/CALL into restakingContract per
    // iteration; at the prior 500-cap a single claim() could exhaust the 30M
    // block gas budget when many epochs accumulate. 250 still covers ~5 years
    // at the protocol's 1-week distribution cadence — well past the 56-day
    // stale window — while halving worst-case gas. Curve FeeDistributor uses
    // 50 as its iteration cap; we keep 250 to favour UX. claimUpTo() handles
    // the long tail for users who genuinely have more than 250 unclaimed
    // epochs.
    uint256 public constant MAX_CLAIM_EPOCHS = 250;
    uint256 public constant MAX_VIEW_EPOCHS = 250;
    /// @notice AUDIT FIX F-13-3 [F-50-1, F-72-7] (LOW): per-call window cap on
    ///         the paginated reclaim-eligibility scan. 250 mirrors
    ///         `MAX_VIEW_EPOCHS` / `MAX_CLAIM_EPOCHS` so the same window-shape
    ///         that is gas-safe for `_calculateClaim` is reused here. The
    ///         legacy whole-history view is preserved for off-chain callers
    ///         and for the propose-time gate; new on-chain consumers should
    ///         use `reclaimEligibleAmountPaginated`.
    uint256 public constant MAX_RECLAIM_PAGE_SIZE = 250;

    // Minimum interval between permissionless distributions
    uint256 public constant MIN_DISTRIBUTE_INTERVAL = 4 hours;
    uint256 public lastDistributeTime;
    // Minimum ETH per epoch to distribute — prevents dust distributions
    // H-06 FIX: Increased from 0.1 to 1 ether. Combined with 4-hour interval, limits
    // epoch griefing to 6 epochs/day at 6 ETH/day cost (previously 24 epochs/day at 2.4 ETH/day).
    uint256 public constant MIN_DISTRIBUTE_AMOUNT = 1 ether;

    // Grace period for claiming after lock expiry (7 days)
    uint256 public constant CLAIM_GRACE_PERIOD = 7 days;

    // AUDIT FIX: DEEP-DR-H-02 / M-R6 — cap each individual recovery's attested
    // power at 25% of `epoch.totalLocked`. Bounds the blast radius of any single
    // recovery (or owner-key compromise) to one-quarter of the source pool;
    // legitimate corruption-recovery for a >25% holder must split into multiple
    // proposals, each timelocked, each visible.
    uint256 public constant MAX_RECOVERY_POWER_BPS = 2500;

    // AUDIT FIX D-DR-L1: AGGREGATE per-epoch recovery cap. The per-proposal cap
    // above (25%) was previously the only bound, so a captured owner could fan
    // out 4 separate proposals each at 25% and reach 100% epoch drain — each
    // timelock visible but each individually within bounds. The aggregate cap
    // keeps the legitimate >25%-position recovery path open via 2 proposals
    // while bounding the captured-key blast radius.
    // AUDIT FIX (BATCH-J3 H21): tightened from 5000 (50%) to 2500 (25%) per
    // 100-agent audit. Pre-fix, captured owner could shell out 5 proposals
    // at 10% each across 5 EOAs → 50% epoch drain after 24h timelock.
    // Tightened to 25% — legitimate >25%-power-recovery is rare and can
    // be staged across multiple epochs (24h * N delay) instead. Halves
    // the captured-key blast radius without breaking honest recovery.
    uint256 public constant MAX_AGGREGATE_RECOVERY_POWER_BPS = 2500;
    /// @notice AUDIT FIX D-DR-L1: per-epoch aggregate of in-flight + executed
    ///         recovery power. Bumped on propose (when slot was empty), adjusted
    ///         on overwrite, decremented on cancel, RETAINED on execute (executed
    ///         power counts toward the cap, mirroring the pendingRecoveryCount
    ///         pattern at REV-H-02).
    mapping(uint256 => uint256) public aggregateRecoveryPower;

    /// @notice AUDIT FIX 2026-05-16 M1: lifetime cap on `executeClaimRecovery` ETH
    ///         outflow. Symmetric with the forfeit-side `MAX_LIFETIME_FORFEIT_BPS`
    ///         (line 1065). Without this cap, a captured owner could serially
    ///         exfiltrate up to MAX_AGGREGATE_RECOVERY_POWER_BPS (25%) of EVERY
    ///         epoch's totalETH across N epochs — proposals parallelize across
    ///         epochs so the 48h delay applies once, not N times. The lifetime cap
    ///         bounds total recovery outflow to 1% of cumulative `totalDistributed`,
    ///         matching the forfeit side. Honest recoveries are statistically rare
    ///         (legitimate "I had checkpoint data corruption" claims should be
    ///         single-digit per year); 1% headroom is sufficient. Captured-owner
    ///         blast radius drops from ~25% × N → 1% lifetime.
    uint256 public constant MAX_LIFETIME_RECOVERY_BPS = 100;
    /// @notice AUDIT FIX 2026-05-16 M1: cumulative ETH paid via executeClaimRecovery.
    ///         Capped by MAX_LIFETIME_RECOVERY_BPS of totalDistributed. Incremented
    ///         at execute time; never decremented (audit-trail integrity).
    uint256 public totalRecoveryClaimed;
    /// @notice AUDIT FIX 2026-05-16 M1: propose/execute revert when adding a
    ///         recovery share would breach `MAX_LIFETIME_RECOVERY_BPS` of
    ///         `totalDistributed`. Mirrors `ForfeitExceedsLifetimeCap` selector
    ///         pattern (line 1216) for symmetric off-chain monitoring.
    error RecoveryExceedsLifetimeCap();

    // Treasury change timelock
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    address public pendingTreasury;
    uint256 public totalPendingWithdrawals;

    uint256 public constant EMERGENCY_WITHDRAW_DELAY = 48 hours;

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function treasuryChangeTime() external view returns (uint256) { return _executeAfter[TREASURY_CHANGE]; }
    function restakingChangeTime() external view returns (uint256) { return _executeAfter[RESTAKING_CHANGE]; }
    function emergencyWithdrawProposedAt() external view returns (uint256) { return _executeAfter[EMERGENCY_WITHDRAW_EXCESS]; }
    function tokenSweepReadyAt() external view returns (uint256) { return _executeAfter[TOKEN_SWEEP]; }

    // ─── Events ───────────────────────────────────────────────────────

    event EpochDistributed(uint256 indexed epochId, uint256 ethAmount, uint256 totalLocked);
    event Claimed(address indexed user, uint256 ethAmount, uint256 fromEpoch, uint256 toEpoch);
    event ETHReceived(address indexed sender, uint256 amount);
    event EmergencyWithdraw(address indexed treasury, uint256 amount);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event TreasuryChangeProposed(address indexed newTreasury, uint256 executeAfter);
    event TreasuryChangeExecuted(address oldTreasury, address newTreasury);
    event PendingWithdrawalCredited(address indexed user, uint256 amount);
    event PendingWithdrawn(address indexed user, uint256 amount);
    event DustSwept(address indexed treasury, uint256 amount);
    event TokenSwept(address indexed token, address indexed to, uint256 amount);
    event RestakingContractUpdated(address indexed newRestaking);
    event RestakingChangeProposed(address indexed newRestaking, uint256 executeAfter);
    event RestakingChangeCancelled(address indexed cancelledRestaking);
    event TreasuryChangeCancelled(address indexed cancelledTreasury);
    event PermissionlessDistribution(address indexed caller, uint256 epochId);
    event EmergencyWithdrawExcess(address indexed treasury, uint256 amount);
    event EmergencyWithdrawExcessProposed(uint256 executeAfter);
    event EmergencyWithdrawExcessCancelled();
    // AUDIT R014 H-5: claim-recovery events (loud — admin attestation should be auditable on-chain)
    event ClaimRecoveryProposed(address indexed user, uint256 indexed epoch, uint256 power, uint256 executeAfter);
    event ClaimRecoveryExecuted(address indexed user, uint256 indexed epoch, uint256 power, uint256 amount);
    event ClaimRecoveryCancelled(address indexed user, uint256 indexed epoch);
    // AUDIT R014 M-8: auto-reconcile events
    event DustAutoReconciled(uint256 fromEpoch, uint256 toEpoch, uint256 amount, uint256 routedToEpoch);
    /// @notice AUDIT FIX F-12-K-3 (LOW / fairness): emitted when `autoReconcileDust`
    ///         routes per-epoch dust into the protocol-wide pool (instead of the
    ///         previous mutate-into-`epochs[length-1]` shape). Mirrors
    ///         `DustAutoReconciled` but is emitted per-epoch with a clearer name.
    event DustRoutedToProtocolPool(uint256 fromEpoch, uint256 toEpoch, uint256 amount);

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error NoETHToDistribute();
    error NoLockedTokens();
    error NothingToClaim();
    error ETHTransferFailed();
    error StillHasLockedTokens();
    error NoETHToWithdraw();
    error UseProposeTreasuryChange();
    error NoPendingWithdrawal();
    error NoDustToSweep();
    error TooManyUnclaimedEpochs();
    error DistributeTooSoon();
    error StakingPaused(); // AUDIT FIX M-10: Block claims when staking is paused
    // AUDIT R014 H-5: Recovery-path errors
    error InvalidEpoch();
    error PowerExceedsTotalLocked();
    error NoPendingRecovery();
    error AlreadyClaimed();
    // AUDIT FIX: DEEP-DR-M-04 — distinguishes "user already ran normal claim() for
    // this epoch" from the legacy AlreadyClaimed() (which only fires for
    // recoveryClaimed double-execution). Lets off-chain ops triage which path the
    // proposal hit without needing to read state.
    error AlreadyClaimedNormally();
    // AUDIT FIX: DEEP-DR-H-02 / M-R6 — recovery's attested power exceeded
    // `epoch.totalLocked * MAX_RECOVERY_POWER_BPS / 10000`. Distinguished from
    // PowerExceedsTotalLocked (the absolute upper bound) so off-chain monitors
    // can flag near-cap proposals without conflating with arithmetic errors.
    error RecoveryPowerExceedsCap();
    /// @notice AUDIT REV-M-03 (CLEANUP): recovery-specific replacements for the
    ///         TimelockAdmin `ProposalNotReady(bytes32)` / `ProposalExpired(bytes32)`
    ///         errors that the recovery path used to piggyback on. Recoveries live
    ///         in `pendingRecoveries[user][epoch]` (NOT in `_executeAfter`) so the
    ///         generic timelock errors were misleading — they implied a key-tagged
    ///         proposal that never existed. These selectors are payload-free since
    ///         executeClaimRecovery already takes (user, epoch) as call args.
    error RecoveryNotReady();
    error RecoveryExpired();
    // AUDIT R014 M-8: Auto-reconcile errors
    error NoEpochToReconcile();
    error GracePeriodActive();
    // AUDIT REV-H-02: propose-time guard for already-reconciled epochs.
    error EpochAlreadyReconciled();
    /// @notice AUDIT FIX F-12-K-4 (LOW / liveness): typed error emitted when both the
    ///         historical `totalBoostedStakeAtTimestamp(T-1)` AND the live
    ///         `totalBoostedStake()` fallback fail (revert on a future staking-side
    ///         ABI break or new revert path). Lets ops dashboards distinguish
    ///         "staking contract is broken" from "no stakers" / "amount too small".
    error StakingTotalBoostedStakeFailed();
    /// @notice AUDIT FIX F-13-3 [F-50-1, F-72-7] (LOW): paginated-form callers must
    ///         supply a window no larger than `MAX_RECLAIM_PAGE_SIZE` (250).
    error ReclaimPageSizeExceeded();
    /// @notice AUDIT FIX F-13-3 [F-50-1, F-72-7] (LOW): paginated-form callers must
    ///         supply `endEpoch <= epochs.length`.
    error ReclaimEndEpochOutOfBounds();
    /// @notice AUDIT FIX F-13-3 [F-50-1, F-72-7] (LOW): paginated-form callers must
    ///         supply `startEpoch < endEpoch`.
    error ReclaimRangeEmpty();
    /// @notice AUDIT FIX F-13-4 (INFO): `executeTokenSweep` deny-list — WETH cannot
    ///         be swept because the WETHFallbackLib's wrap-on-fail path leaves WETH
    ///         that is part of the staker pool (e.g., from `withdrawPending`'s
    ///         fallback leg). Sweeping WETH would rug stakers whose share landed
    ///         in `pendingWithdrawals` after a failed direct ETH push.
    error TokenSweepWETHDenied();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _votingEscrow, address _treasury, address _weth) OwnableNoRenounce(msg.sender) {
        if (_votingEscrow == address(0) || _treasury == address(0) || _weth == address(0)) revert ZeroAddress();
        votingEscrow = IVotingEscrow(_votingEscrow);
        weth = IWETH(_weth);
        treasury = _treasury;

        // ─── AUDIT FIX H-11 [F-55-1, F-80-02] (HIGH) ──────────────────────────
        // Pre-warm the `_totalETHReceivedRaw` storage slot so the first ingress
        // through the receive() body does NOT incur the 22.1k zero→non-zero
        // SSTORE (Berlin/Shanghai pricing). Without this, the very first ETH
        // delivery to RevenueDistributor via `WETHFallbackLib.safeTransferETHOrWrap`
        // (10k stipend) would always blow the gas budget on the SSTORE alone,
        // causing the lib to fall back to wrapping the ETH as WETH ERC20 — and
        // since `_distribute()` reads only `address(this).balance`, the wrapped
        // WETH is invisible to the distribution loop and stakers never see it.
        //
        // We seed the slot with 1 wei (the smallest non-zero value) so every
        // future receive() SSTORE is non-zero→non-zero (~5k gas), comfortably
        // within the 10k stipend together with the LOG2 emit (~1.7k) and
        // arithmetic. The public `totalETHReceived()` getter below subtracts the
        // pre-warm offset so external observers see the same monotonic counter
        // as the sister contracts (POLAccumulator, SwapFeeRouter).
        _totalETHReceivedRaw = 1;
    }

    // ─── Receive ETH ──────────────────────────────────────────────────

    /// AUDIT FIX (BATCH-I M35): mirror POLAccumulator + SwapFeeRouter pass-8
    /// batch-18 monotonic ETH-ingress counter so off-chain monitoring can
    /// reconcile inflows symmetrically across all three ETH-receiving sister
    /// contracts. Also catches selfdestruct/coinbase ETH that bypasses
    /// `receive()` only when off-chain readers diff this counter against
    /// `address(this).balance` (a divergence flags donation drift).
    /// @dev AUDIT FIX H-11 [F-55-1, F-80-02]: stored as `_totalETHReceivedRaw`
    ///      (pre-warmed to 1 in the constructor) so the first SSTORE in
    ///      receive() is non-zero→non-zero (~5k gas) instead of zero→non-zero
    ///      (~22.1k gas). External observers MUST use the public getter
    ///      `totalETHReceived()` below which subtracts the 1-wei pre-warm.
    uint256 private _totalETHReceivedRaw;

    /// @notice Monotonic counter of ETH delivered through the receive() path.
    ///         Subtracts the 1-wei constructor pre-warm (see H-11 fix above) so
    ///         observers see the same semantic as POLAccumulator / SwapFeeRouter.
    function totalETHReceived() external view returns (uint256) {
        unchecked { return _totalETHReceivedRaw - 1; }
    }

    receive() external payable {
        unchecked { _totalETHReceivedRaw += msg.value; }
        emit ETHReceived(msg.sender, msg.value);
    }

    // ─── Distribution ─────────────────────────────────────────────────

    /// @notice Create a new distribution epoch with NEW ETH (not already earmarked).
    ///         Permissionless — anyone can trigger (e.g., keeper, user, or admin).
    ///         Uses votingEscrow.totalBoostedStake() for the epoch's totalLocked snapshot.
    /// @dev AUDIT FIX PASS5-REV-H1: mirror the M-12 MIN_DISTRIBUTE_STAKE guard
    ///      on `distributePermissionless` so this sibling entrypoint cannot be
    ///      used to bypass the concentration-attack defense. Pre-fix, an
    ///      attacker could `kick` a whale's expired position to deflate
    ///      `totalBoostedStake`, then immediately call `distribute()` (no
    ///      guard) to concentrate the entire epoch's revenue to themselves —
    ///      a cross-contract attack chain confirmed by the PASS5 PoC.
    function distribute() external nonReentrant whenNotPaused {
        // AUDIT FIX M-14 [F-13-2] (MEDIUM): mirror the `claim()`/`claimUpTo()`/
        // `executeClaimRecovery()` `_isStakingPaused()` gate. The pause flag is
        // the protocol's universal kill-switch for "staking-side checkpoint data
        // is corrupt / under exploit"; if claims must refuse to use that data,
        // distributions must refuse to CEMENT it into a new epoch. Without this
        // gate, an attacker who exploited TegridyStaking to inflate their
        // boostedAmount could (a) wait for the team to pause staking, (b)
        // permissionlessly call `distributePermissionless()` to lock the
        // corrupt denominator into `epochs[i].totalLocked`, then (c) claim
        // the inflated share post-unpause. The gate makes the kill-switch
        // symmetric across read AND write paths.
        if (_isStakingPaused()) revert StakingPaused();
        require(votingEscrow.totalBoostedStake() >= MIN_DISTRIBUTE_STAKE, "STAKE_TOO_LOW");
        _distribute();
    }

    /// @notice Permissionless distribution with safety guards.
    ///         Anyone can call this to trigger a distribution epoch, but:
    ///         (a) At least MIN_DISTRIBUTE_INTERVAL (1 hour) must have passed since last distribution.
    ///         (b) There must be new ETH to distribute (msg.value > 0 or balance > totalEarmarked).
    /// AUDIT FIX M-12: Added minimum totalBoostedStake guard. Without this, an attacker
    /// could front-run a large unstake by calling distributePermissionless when totalBoostedStake
    /// is temporarily low, concentrating the epoch's revenue to the remaining stakers (including themselves).
    uint256 public constant MIN_DISTRIBUTE_STAKE = 1000e18; // Minimum 1000 TOWELI equivalent staked

    function distributePermissionless() external nonReentrant whenNotPaused {
        // AUDIT FIX M-14 [F-13-2] (MEDIUM): same `_isStakingPaused()` gate as
        // `distribute()` above. See that function's comment for full rationale.
        // Attacker route: corrupt-checkpoint exploit → team pauses staking →
        // attacker calls THIS permissionless path to cement the corrupt
        // denominator into a new epoch → claims after unpause. Closed here.
        if (_isStakingPaused()) revert StakingPaused();
        // AUDIT FIX M-12: Prevent distribution at low stake levels to avoid concentration attacks
        require(votingEscrow.totalBoostedStake() >= MIN_DISTRIBUTE_STAKE, "STAKE_TOO_LOW");
        uint256 reserved = (totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0) + totalPendingWithdrawals;
        uint256 balance = address(this).balance;
        bool hasNewETH = balance > reserved;
        // H-06 FIX: Removed msg.value check — function is no longer payable to prevent
        // attackers from sending just enough ETH to bypass the minimum distribute amount
        require(hasNewETH, "NO_NEW_ETH");
        _distribute();
        emit PermissionlessDistribution(msg.sender, epochs.length - 1);
    }

    function _distribute() internal {
        if (block.timestamp < lastDistributeTime + MIN_DISTRIBUTE_INTERVAL) revert DistributeTooSoon();

        uint256 reserved = (totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0) + totalPendingWithdrawals;
        uint256 balance = address(this).balance;
        uint256 newETH = balance > reserved ? balance - reserved : 0;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (newETH == 0) revert NoETHToDistribute();
        require(newETH >= MIN_DISTRIBUTE_AMOUNT, "AMOUNT_TOO_SMALL");

        uint256 snapshotTime = block.timestamp > 0 ? block.timestamp - 1 : 0;

        // AUDIT REV-M-01 (MEDIUM, 2026-04-28): pin the epoch denominator to the historical
        // totalBoostedStake AT (block.timestamp - 1) instead of the live spot value. The
        // staking contract writes a `Checkpoints.Trace208` entry at `block.timestamp` on
        // every same-block stake/withdraw/boost-rewrite, so `upperLookup(T-1)` returns
        // ONLY the boosted stake that was already settled before the current block —
        // closing the same-block dilution window that REV C-01 left half-open (the prior
        // double-spot-read + min trick still admitted dilution from any same-block stake
        // that landed BEFORE the distribute() call within the same block).
        //
        // Per-user `votingPowerAtTimestamp(user, T-1)` is read at the SAME T-1 inside
        // `_calculateClaim`, so the numerator and denominator now share a single Trace208
        // semantic — no more "denom captured fresh stake but numerator did not" race.
        //
        // Fallback: if the staking contract doesn't yet have a checkpoint at or before
        // T-1 (e.g., genesis epoch before any stake settled — the totalBoostedStake() != 0
        // gate rules this out — or future ABIs missing the new function), fall back to the
        // live `totalBoostedStake()` so we degrade gracefully instead of bricking
        // distribution. The try/catch surface keeps RevenueDistributor robust against an
        // upgraded staking contract that drops the helper.
        // SLITHER 2026-05-18: Solidity default-init to 0 is the intended value here
        // slither-disable-next-line uninitialized-local
        uint256 locked;
        try votingEscrow.totalBoostedStakeAtTimestamp(snapshotTime) returns (uint256 hist) {
            locked = hist;
        } catch {
            locked = 0;
        }
        // If the historical checkpoint reads 0 (no checkpoint at or before T-1), fall back
        // to the live value so the very first distribution after a fresh deploy doesn't
        // brick. The live value also serves as the floor when the upgraded staking
        // contract hasn't yet been wired in.
        //
        // AUDIT FIX F-12-K-4 (LOW / liveness): wrap the live-fallback in try/catch
        // mirroring the historical lookup above. Without this, a future staking-side
        // ABI break or new revert path on `totalBoostedStake()` would brick
        // distribution permanently (votingEscrow is immutable). With the try/catch,
        // a broken live read surfaces as a typed `StakingTotalBoostedStakeFailed`
        // error instead of an opaque cascade — keeper and ops dashboards can detect
        // and trigger the staking-contract recovery path immediately.
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (locked == 0) {
            try votingEscrow.totalBoostedStake() returns (uint256 live) {
                locked = live;
            } catch {
                revert StakingTotalBoostedStakeFailed();
            }
        }
        if (locked == 0) revert NoLockedTokens();

        epochs.push(Epoch({
            totalETH: newETH,
            totalLocked: locked,
            timestamp: snapshotTime
        }));

        totalDistributed += newETH;
        totalEarmarked += newETH;
        lastDistributeTime = block.timestamp;

        emit EpochDistributed(epochs.length - 1, newETH, locked);
    }

    // ─── Emergency ───────────────────────────────────────────────────

    /// @notice Recover stuck ETH when ALL stakers have unlocked (totalBoostedStake == 0).
    ///         Only withdraws excess ETH, preserving unclaimed amounts.
    /// @dev AUDIT FIX M-38 [F-55-2, F-80-06] (MEDIUM): route through
    ///      `WETHFallbackLib.safeTransferETHOrWrap` instead of raw `.call`.
    ///      Treasury is rotatable behind a 48h timelock; if rotation has just
    ///      landed and the new treasury's `receive()` reverts (paused multisig,
    ///      misconfigured Safe guard), the prior raw-call shape would have
    ///      bricked this dust-recovery hatch and required ANOTHER 48h treasury
    ///      rotation to recover. The lib's WETH-wrap fallback ensures the funds
    ///      always land in treasury (as ETH or as WETH ERC20) without bricking.
    function emergencyWithdraw() external onlyOwner nonReentrant {
        if (votingEscrow.totalBoostedStake() != 0) revert StillHasLockedTokens();

        uint256 unclaimed = (totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0) + totalPendingWithdrawals;
        uint256 balance = address(this).balance;
        uint256 withdrawable = balance > unclaimed ? balance - unclaimed : 0;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (withdrawable == 0) revert NoETHToWithdraw();

        WETHFallbackLib.safeTransferETHOrWrap(address(weth), treasury, withdrawable);

        emit EmergencyWithdraw(treasury, withdrawable);
    }

    /// @notice Withdraw only excess ETH (balance minus totalEarmarked obligations).
    ///         Unlike emergencyWithdraw(), this does NOT require totalBoostedStake == 0.
    function proposeEmergencyWithdrawExcess() external onlyOwner {
        _propose(EMERGENCY_WITHDRAW_EXCESS, EMERGENCY_WITHDRAW_DELAY);
        emit EmergencyWithdrawExcessProposed(_executeAfter[EMERGENCY_WITHDRAW_EXCESS]);
    }

    function cancelEmergencyWithdrawExcess() external onlyOwner {
        _cancel(EMERGENCY_WITHDRAW_EXCESS);
        emit EmergencyWithdrawExcessCancelled();
    }

    /// @dev AUDIT FIX: DEEP-DR-M-02 — `whenNotPaused` so the universal kill-switch
    ///      freezes owner-side mutators alongside user claims (M-7 sibling-search).
    function executeEmergencyWithdrawExcess() external onlyOwner nonReentrant whenNotPaused {
        _execute(EMERGENCY_WITHDRAW_EXCESS);

        uint256 unclaimed = totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0;
        uint256 reserved = unclaimed + totalPendingWithdrawals;
        uint256 balance = address(this).balance;
        uint256 excess = balance > reserved ? balance - reserved : 0;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (excess == 0) revert NoETHToWithdraw();

        // AUDIT FIX M-38 [F-55-2, F-80-06] (MEDIUM): route through WETHFallbackLib
        // for treasury-contract robustness. See `emergencyWithdraw` above for
        // the full rationale (treasury rotation race vs reverting receive).
        WETHFallbackLib.safeTransferETHOrWrap(address(weth), treasury, excess);

        emit EmergencyWithdrawExcess(treasury, excess);
    }

    /// @notice DEPRECATED: Use proposeTreasuryChange() + executeTreasuryChange() instead.
    function setTreasury(address) external pure {
        revert UseProposeTreasuryChange();
    }

    /// @notice Propose a treasury change (takes effect after 48h delay)
    function proposeTreasuryChange(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        pendingTreasury = _treasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(_treasury, _executeAfter[TREASURY_CHANGE]);
    }

    /// @notice Execute a previously proposed treasury change after the timelock
    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address old = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeExecuted(old, treasury);
    }

    /// @notice Cancel a pending treasury change proposal.
    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }

    /// @notice Propose a restaking contract change (48h timelock).
    function proposeRestakingChange(address _restaking) external onlyOwner {
        require(_restaking != address(0), "ZERO_ADDRESS");
        pendingRestaking = _restaking;
        _propose(RESTAKING_CHANGE, RESTAKING_CHANGE_DELAY);
        emit RestakingChangeProposed(_restaking, _executeAfter[RESTAKING_CHANGE]);
    }

    /// @notice Execute a previously proposed restaking contract change after the timelock.
    function executeRestakingChange() external onlyOwner {
        _execute(RESTAKING_CHANGE);
        restakingContract = ITegridyRestaking(pendingRestaking);
        emit RestakingContractUpdated(pendingRestaking);
        pendingRestaking = address(0);
    }

    /// @notice Cancel a pending restaking contract change.
    function cancelRestakingChange() external onlyOwner {
        _cancel(RESTAKING_CHANGE);
        address cancelled = pendingRestaking;
        pendingRestaking = address(0);
        emit RestakingChangeCancelled(cancelled);
    }

    /// @dev Check if a user has an active restaked position.
    ///      When NFT is in restaking, locks(user) returns (0,0) but position still exists.
    function _isRestaked(address _user) internal view returns (bool) {
        if (address(restakingContract) == address(0)) return false;
        // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
        // slither-disable-next-line unused-return
        try restakingContract.restakers(_user) returns (
            uint256 tokenId, uint256 positionAmount, uint256, int256, uint256
        ) {
            return tokenId != 0 && positionAmount > 0;
        } catch {
            return false;
        }
    }

    /// @dev AUDIT NEW-S1 (CRITICAL): fallback voting-power source for restakers.
    ///      TegridyStaking zeroes a user's checkpoint when their NFT is transferred to
    ///      the restaking contract, so votingPowerAtTimestamp reads 0 for every epoch
    ///      during the restake window. Restakers were silently paid $0 of protocol
    ///      revenue. This view pulls the restaker's boostedAmount (gated by depositTime)
    ///      so _calculateClaim can credit them correctly.
    ///
    ///      Safety: the current boostedAmount is a lower bound for historical power
    ///      (boost only decays over time), so this never over-credits. Bounded above
    ///      by `epoch.totalLocked` in _calculateClaim.
    function _restakedPowerAt(address _user, uint256 _ts) internal view returns (uint256) {
        if (address(restakingContract) == address(0)) return 0;
        // AUDIT FIX F-50-8 [agent_50] (INFO / defense-in-depth): cap the gas
        // forwarded to the restaking-contract call at 50_000 wei. The function
        // is documented as a Trace208 lookup (~5k gas typical), so 50k is
        // generous. Without the cap, an upgraded/captured restaking contract
        // that consumes unbounded legitimate gas (not a revert — just slow)
        // could push 250-iteration `_calculateClaim` loops past the block gas
        // limit. Bounded gas closes that surface while preserving the existing
        // try/catch zero-return defense for revert paths.
        try restakingContract.boostedAmountAt{gas: 50_000}(_user, _ts) returns (uint256 p) {
            return p;
        } catch {
            return 0;
        }
    }

    /// @notice Pause user-facing functions
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause user-facing functions
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Claiming ─────────────────────────────────────────────────────

    /// @notice Claim ETH for all unclaimed epochs. No registration needed.
    ///         User's share per epoch = (votingPowerAtTimestamp(user, epoch.timestamp) / epoch.totalLocked) * epoch.totalETH
    ///         Reverts if more than MAX_CLAIM_EPOCHS unclaimed — use claimUpTo() instead.
    function claim() external nonReentrant whenNotPaused {
        // AUDIT FIX M-10: Block claims when staking is paused to prevent exploitation of
        // corrupted checkpoint data. If staking was paused due to a discovered exploit that
        // inflated voting power, claims using that corrupted data must be blocked.
        if (_isStakingPaused()) revert StakingPaused();
        uint256 startEpoch = lastClaimedEpoch[msg.sender];
        uint256 endEpoch = epochs.length;

        if (endEpoch - startEpoch > MAX_CLAIM_EPOCHS) {
            revert TooManyUnclaimedEpochs();
        }

        if (startEpoch >= endEpoch) revert NothingToClaim();

        // Check that user has an active lock or is in grace period
        (uint256 currentLocked, uint256 lockEnd) = _getUserLockState(msg.sender);
        bool isRestaked = _isRestaked(msg.sender);
        bool lockActive = (currentLocked > 0 && block.timestamp < lockEnd) || isRestaked;
        bool inGracePeriod = !lockActive && lockEnd > 0 && block.timestamp < lockEnd + CLAIM_GRACE_PERIOD;
        if (!lockActive && !inGracePeriod) revert NoLockedTokens();

        (uint256 totalOwed, uint256 actualEndEpoch) = _calculateClaim(
            msg.sender, startEpoch, endEpoch, inGracePeriod, lockEnd
        );

        // AUDIT FIX: V2-DR-M-02 — advance the cursor even when the entire iterated
        // range was already settled via `executeClaimRecovery` (every epoch has
        // `claimedAtEpoch[user][i] == true` so the loop `continue`s through and
        // returns `totalOwed = 0`). Without the explicit advance the cursor stays
        // parked at `lastClaimedEpoch[user]`, so subsequent `claim()` calls
        // re-iterate the same recovered range, hit `continue` for each, and revert
        // again — bricking forward progress for any user with N consecutive
        // recovered epochs and no fresh claimable share. Mirror the same fix in
        // `claimUpTo()`.
        if (totalOwed == 0) {
            if (actualEndEpoch > startEpoch) {
                lastClaimedEpoch[msg.sender] = actualEndEpoch;
            }
            revert NothingToClaim();
        }

        lastClaimedEpoch[msg.sender] = actualEndEpoch;

        // SECURITY FIX C5: Only increment totalClaimed on successful direct transfer.
        // Failed transfers go to pendingWithdrawals — totalClaimed is incremented in withdrawPending().
        // Prevents totalEarmarked drift that permanently locks ETH (MakerDAO DSR pull-pattern).
        //
        // ─── AUDIT REV-M-02 (DOCUMENT only): 10k gas stipend tradeoff ────
        // The fixed 10_000-gas stipend is a deliberate Seaport/Solmate-grade defense
        // against cross-contract reentrancy. It is sufficient for an EOA receive() and
        // for minimal `receive() external payable {}` contract recipients (event-only,
        // no SLOAD/SSTORE), which is the overwhelmingly common case.
        //
        // KNOWN DEGRADATION: a future EVM gas reprice (e.g., a new EIP that raises the
        // base cost of CALL or makes `receive()` more expensive) could flip recipients
        // whose previously-cheap `receive()` no longer fits in 10k gas into the
        // pendingWithdrawals queue. Those recipients are NOT rugged — they remain
        // entitled to the same ETH, and can pull it via `withdrawPending()`, which
        // forwards through `WETHFallbackLib.safeTransferETHOrWrap` (no stipend cap on
        // the WETH wrap path). The only observable change is one extra transaction
        // per claim. Acceptable degradation.
        //
        // We intentionally do NOT raise the stipend or remove it: a higher stipend
        // widens the reentrancy window for a malicious recipient, and an unbounded
        // `.call` would re-introduce the cross-contract reentrancy class this defense
        // was added to close in the first place.
        (bool success,) = msg.sender.call{value: totalOwed, gas: 10000}("");
        if (success) {
            totalClaimed += totalOwed;
        } else {
            pendingWithdrawals[msg.sender] += totalOwed;
            totalPendingWithdrawals += totalOwed;
            emit PendingWithdrawalCredited(msg.sender, totalOwed);
        }

        emit Claimed(msg.sender, totalOwed, startEpoch, actualEndEpoch);
    }

    /// @notice Claim ETH for a limited number of epochs (gas-safe for many unclaimed epochs).
    function claimUpTo(uint256 maxEpochs) external nonReentrant whenNotPaused {
        // AUDIT FIX M-10: Block claims when staking is paused (same as claim())
        if (_isStakingPaused()) revert StakingPaused();
        if (maxEpochs > MAX_CLAIM_EPOCHS) maxEpochs = MAX_CLAIM_EPOCHS;
        uint256 startEpoch = lastClaimedEpoch[msg.sender];
        uint256 endEpoch = epochs.length;
        if (startEpoch + maxEpochs < endEpoch) {
            endEpoch = startEpoch + maxEpochs;
        }

        if (startEpoch >= endEpoch) revert NothingToClaim();

        // Check that user has an active lock or is in grace period
        (uint256 currentLocked, uint256 lockEnd) = _getUserLockState(msg.sender);
        bool isRestaked = _isRestaked(msg.sender);
        bool lockActive = (currentLocked > 0 && block.timestamp < lockEnd) || isRestaked;
        bool inGracePeriod = !lockActive && lockEnd > 0 && block.timestamp < lockEnd + CLAIM_GRACE_PERIOD;
        if (!lockActive && !inGracePeriod) revert NoLockedTokens();

        (uint256 totalOwed, uint256 actualEndEpoch) = _calculateClaim(
            msg.sender, startEpoch, endEpoch, inGracePeriod, lockEnd
        );

        // AUDIT FIX: V2-DR-M-02 — sibling-search of the `claim()` cursor-advance fix.
        // When the requested `maxEpochs` window is entirely composed of
        // recovery-settled epochs, the cursor must still advance so the user can
        // make forward progress on subsequent calls.
        if (totalOwed == 0) {
            if (actualEndEpoch > startEpoch) {
                lastClaimedEpoch[msg.sender] = actualEndEpoch;
            }
            revert NothingToClaim();
        }

        lastClaimedEpoch[msg.sender] = actualEndEpoch;

        // SECURITY FIX C5: Only increment totalClaimed on successful direct transfer.
        // Failed transfers go to pendingWithdrawals — totalClaimed is incremented in withdrawPending().
        // Prevents totalEarmarked drift that permanently locks ETH (MakerDAO DSR pull-pattern).
        //
        // AUDIT REV-M-02 (DOCUMENT only): 10k stipend tradeoff — see claim() above for
        // the full rationale. Same Seaport/Solmate-grade defense, same WETH-fallback
        // recovery path via withdrawPending(). Acceptable degradation.
        (bool success,) = msg.sender.call{value: totalOwed, gas: 10000}("");
        if (success) {
            totalClaimed += totalOwed;
        } else {
            pendingWithdrawals[msg.sender] += totalOwed;
            totalPendingWithdrawals += totalOwed;
            emit PendingWithdrawalCredited(msg.sender, totalOwed);
        }

        emit Claimed(msg.sender, totalOwed, startEpoch, actualEndEpoch);
    }

    /// @dev Shared claim calculation logic. Queries votingPowerAtTimestamp per epoch.
    ///      AUDIT FIX C-03: Tracks per-epoch cumulative claims to prevent over-claim when
    ///      totalBoostedStake decreases between distribution and claim (users unstake).
    /// @return totalOwed The total ETH owed to the user across the epoch range.
    /// @return actualEndEpoch The actual end epoch (may be earlier than endEpoch due to grace period cutoff).
    function _calculateClaim(
        address user,
        uint256 startEpoch,
        uint256 endEpoch,
        bool inGracePeriod,
        uint256 lockEnd
    ) internal returns (uint256 totalOwed, uint256 actualEndEpoch) {
        actualEndEpoch = endEpoch;

        // AUDIT FIX FRESH-2026: F-REV-EXRESTAKER — DEEP-DR-L-03's `isRestaker`
        //         cache short-circuited `_restakedPowerAt` based on CURRENT
        //         restaker status. Ex-restakers (unrestaked at claim time) were
        //         silently skipped for ALL their past restaked-period epochs
        //         (staking-side checkpoint was 0 during restake, so userPower
        //         stayed 0 unless restaking-side fallback fired). Combined with
        //         the unconditional `claimedAtEpoch[user][i] = true` seal below,
        //         this permanently locked them out of `proposeClaimRecovery`
        //         too. Drop the cache: `_restakedPowerAt` already has a
        //         try/catch wrapper, returns 0 cheaply for users who never
        //         restaked (Trace208 length 0 path), and is the canonical Curve
        //         FeeDistributor pattern (always read both sources per epoch).

        for (uint256 i = startEpoch; i < endEpoch; i++) {
            Epoch memory epoch = epochs[i];

            // In grace period, only claim epochs distributed before lock expired
            if (inGracePeriod && epoch.timestamp >= lockEnd) {
                actualEndEpoch = i;
                break;
            }

            // AUDIT FIX: DEEP-DR-M-04 — skip epochs already paid via recovery.
            // The cursor `lastClaimedEpoch[user]` may lag behind `claimedAtEpoch`
            // when an executeClaimRecovery for an epoch lower than the cursor
            // landed first; a later normal claim would otherwise re-traverse
            // the same epoch and double-credit. The unified mapping is the
            // authoritative "settled" flag for this (user, epoch) pair.
            if (claimedAtEpoch[user][i]) {
                continue;
            }

            if (epoch.totalLocked > 0) {
                uint256 userPower = votingEscrow.votingPowerAtTimestamp(user, epoch.timestamp);
                // AUDIT NEW-S1 (CRITICAL) + REV-RESTAKE-01 (pass-8): ADDITIVE sum
                // of staking-side and restaking-side historical power. Restakers'
                // NFTs are held by the restaking contract, so their staking
                // checkpoint is zeroed on transfer-in; without the restaking-side
                // add, they silently earn $0 on every restaked-period epoch.
                // AUDIT FIX FRESH-2026: F-REV-EXRESTAKER — call unconditionally
                //         (was gated on `isRestaker` cache pre-fix). The cache
                //         returned false for users who unrestaked, sealing
                //         their past restaked-period epochs at zero permanently.
                //         `_restakedPowerAt` is cheap for never-restakers
                //         (returns 0 via try/catch + Trace208 length-0 path).
                userPower += _restakedPowerAt(user, epoch.timestamp);
                if (userPower > 0) {
                    // AUDIT FIX FRESH-2026: F-REV-EXRESTAKER — only seal the
                    //         per-epoch claim flag when the user actually had
                    //         non-zero historical power. Zero-power epochs stay
                    //         eligible for `proposeClaimRecovery` (which
                    //         requires owner-attested non-zero `power` anyway,
                    //         so this cannot enable double-credit).
                    claimedAtEpoch[user][i] = true;
                    // Cap userPower to epoch.totalLocked to prevent over-payment
                    uint256 effectivePower = userPower > epoch.totalLocked ? epoch.totalLocked : userPower;
                    uint256 share = (epoch.totalETH * effectivePower) / epoch.totalLocked;

                    // AUDIT FIX C-03: Prevent total claims from exceeding deposited ETH per epoch.
                    // If totalBoostedStake decreased between distribution and claim, multiple users
                    // could each claim based on the snapshot denominator with sum(claims) > epoch.totalETH.
                    uint256 remaining = epoch.totalETH > epochClaimed[i] ? epoch.totalETH - epochClaimed[i] : 0;
                    if (share > remaining) {
                        share = remaining;
                    }
                    if (share > 0) {
                        epochClaimed[i] += share;
                        totalOwed += share;
                    }
                }
            }
        }
    }

    /// @dev AUDIT FIX M-10: Check if the staking contract is paused.
    ///      Uses try/catch so this contract doesn't break if the staking contract
    ///      doesn't implement paused() (defensive future-proofing).
    function _isStakingPaused() internal view returns (bool) {
        try votingEscrow.paused() returns (bool isPaused) {
            return isPaused;
        } catch {
            return false;
        }
    }

    /// @dev Get a user's lock state, with try/catch fallback for paused votingEscrow.
    ///      AUDIT C3 / H11: now uses votingEscrow.votingPowerOf(user) — which aggregates
    ///      across all NFTs the user owns — as the primary "active" signal. Multi-NFT
    ///      contract holders (Safes, vaults) were previously locked out of claims because
    ///      `userTokenId` only points to the most-recently-received NFT. The aggregated
    ///      power check returns true if ANY of their positions is still active.
    ///
    ///      The `lockEnd` return value is preserved for the grace-period path (single-NFT
    ///      users about to expire). For aggregate-active users we return type(uint64).max
    ///      so the grace check is effectively a no-op (always > block.timestamp).
    function _getUserLockState(address user) internal view returns (uint256 currentLocked, uint256 lockEnd) {
        // AUDIT C3 / H11: prefer aggregate voting power. Returns the SUM across all the
        // user's positions, so a multi-NFT contract holder with at least one active lock
        // is correctly recognised as active.
        try votingEscrow.votingPowerOf(user) returns (uint256 power) {
            if (power > 0) {
                // Active via aggregate. Sentinel lockEnd suppresses the grace-period gate.
                return (power, type(uint64).max);
            }
        } catch {
            // votingPowerOf can revert if staking is paused / mid-upgrade. Fall through to
            // the legacy single-pointer path so users with a single NFT can still claim
            // through the grace-period door.
        }

        // No aggregate power → fall back to single-pointer for grace-period semantics.
        try votingEscrow.userTokenId(user) returns (uint256 tokenId) {
            if (tokenId == 0) return (0, 0);
            // SLITHER 2026-05-18: intentional tuple destructure; external interface tuple shape is fixed
            // slither-disable-next-line unused-return
            try votingEscrow.positions(tokenId) returns (
                uint256 amount, uint256, int256, uint256 _lockEnd,
                uint256, uint256, bool, bool, uint256, uint256, bool
            ) {
                currentLocked = amount;
                lockEnd = _lockEnd;
            } catch {
                currentLocked = 0;
                lockEnd = 0;
            }
        } catch {
            currentLocked = 0;
            lockEnd = 0;
        }
    }

    // ─── Pending Withdrawals ────────────────────────────────────────

    /// @notice Withdraw ETH that was credited due to a failed transfer.
    ///         Allows contracts that couldn't receive ETH during claim to pull their funds.
    function withdrawPending() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NoPendingWithdrawal();

        pendingWithdrawals[msg.sender] = 0;
        totalPendingWithdrawals -= amount;
        // SECURITY FIX C5: Increment totalClaimed here (was previously in claim() before transfer success check)
        totalClaimed += amount;

        WETHFallbackLib.safeTransferETHOrWrap(address(weth), msg.sender, amount);

        emit PendingWithdrawn(msg.sender, amount);
    }

    // ─── Dust Sweep ─────────────────────────────────────────────────

    /// @notice Sweep rounding dust to treasury.
    ///         Only callable by owner. Sends any balance beyond unclaimed + pending withdrawal amounts to treasury.
    /// @dev AUDIT FIX: DEEP-DR-M-02 — `whenNotPaused` so the universal kill-switch
    ///      freezes owner-side mutators alongside user claims (M-7 sibling-search).
    function sweepDust() external onlyOwner nonReentrant whenNotPaused {
        uint256 unclaimed = totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0;
        uint256 reserved = unclaimed + totalPendingWithdrawals;
        uint256 balance = address(this).balance;
        uint256 dust = balance > reserved ? balance - reserved : 0;
        // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
        // slither-disable-next-line incorrect-equality
        if (dust == 0) revert NoDustToSweep();

        // AUDIT FIX M-38 [F-55-2, F-80-06] (MEDIUM): route through WETHFallbackLib
        // for treasury-contract robustness. See `emergencyWithdraw` above for
        // the full rationale (treasury rotation race vs reverting receive).
        WETHFallbackLib.safeTransferETHOrWrap(address(weth), treasury, dust);

        emit DustSwept(treasury, dust);
    }

    /// @notice Propose sweeping ERC-20 tokens (timelocked 48h).
    uint256 public constant TOKEN_SWEEP_DELAY = 48 hours;
    address public pendingSweepToken;
    address public pendingSweepTo;

    event TokenSweepProposed(address indexed token, address indexed to, uint256 readyAt);
    event TokenSweepCancelled(address indexed token);

    function proposeTokenSweep(address token, address to) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        // AUDIT FIX F-13-4 (INFO): fail fast at propose time so admins do not
        // burn a 48h timelock on a doomed proposal that the execute-time deny
        // would revert anyway. See `executeTokenSweep` below for the full
        // rationale on why WETH must be excluded.
        if (token == address(weth)) revert TokenSweepWETHDenied();
        pendingSweepToken = token;
        pendingSweepTo = to;
        _propose(TOKEN_SWEEP, TOKEN_SWEEP_DELAY);
        emit TokenSweepProposed(token, to, _executeAfter[TOKEN_SWEEP]);
    }

    /// @dev AUDIT FIX: DEEP-DR-M-02 — `whenNotPaused` so the universal kill-switch
    ///      freezes owner-side mutators alongside user claims (M-7 sibling-search).
    function executeTokenSweep() external onlyOwner whenNotPaused {
        _execute(TOKEN_SWEEP);
        address token = pendingSweepToken;
        address to = pendingSweepTo;
        pendingSweepToken = address(0);
        pendingSweepTo = address(0);
        // AUDIT FIX F-13-4 (INFO): explicit deny-list for the canonical WETH.
        // The WETHFallbackLib's wrap-on-fail leaves WETH ERC20 inside this
        // contract whenever a 10k-stipend ETH push fails (e.g., a contract
        // recipient whose `receive()` exceeds the budget). That WETH is
        // semantically part of the staker pool — a user whose claim landed in
        // `pendingWithdrawals` and whose subsequent `withdrawPending` push
        // wrapped is owed that WETH. Sweeping WETH here would rug those users.
        // Mirror lib-side wrap recovery is via the existing claim/withdraw
        // mechanics; admin-side sweep MUST exclude WETH.
        if (token == address(weth)) revert TokenSweepWETHDenied();
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "NO_TOKEN_BALANCE");
        IERC20(token).safeTransfer(to, balance);
        emit TokenSwept(token, to, balance);
    }

    function cancelTokenSweep() external onlyOwner {
        _cancel(TOKEN_SWEEP);
        address token = pendingSweepToken;
        pendingSweepToken = address(0);
        pendingSweepTo = address(0);
        emit TokenSweepCancelled(token);
    }

    /// @dev DEPRECATED: Use proposeTokenSweep() + executeTokenSweep()
    function emergencySweepToken(address, address) external pure {
        revert("Use proposeTokenSweep()");
    }

    /// @notice AUDIT FIX M-11: Allow owner to reclaim ETH from epochs where the claim grace
    ///         period has expired and users can no longer claim. Over time, users who let their
    ///         locks expire without claiming leave ETH permanently trapped in totalEarmarked.
    ///         This function reduces totalEarmarked by a specified amount (capped at 10 ETH per call)
    ///         so it can be swept via sweepDust(). Requires a 48h timelock for safety.
    ///
    /// AUDIT REV-H-01 (HIGH): Hard-gate the reclaim amount against the SUM of unclaimed dust
    /// from epochs whose DUST_RECLAIM_GRACE has elapsed. Without this, the prior `gap` check
    /// (totalEarmarked - totalClaimed) lets the owner slow-drain still-claimable ETH from
    /// fresh epochs at up to 10 ETH per 48h cycle, leaving late claimers with insufficient
    /// balance and permanently-pending withdrawals. Belt-and-braces: a 1% lifetime cap
    /// (totalForfeitedReclaimed / totalDistributed) bounds owner authority even if the
    /// per-epoch math is somehow circumvented.
    bytes32 public constant FORFEIT_RECLAIM = keccak256("FORFEIT_RECLAIM");
    uint256 public constant FORFEIT_RECLAIM_DELAY = 48 hours;
    /// @notice AUDIT REV-H-01: lifetime cap on owner forfeit reclaims, expressed in basis
    ///         points of totalDistributed. 100 bps = 1% — well above any legitimate dust
    ///         floor, well below an exploit-grade slow drain.
    uint256 public constant MAX_LIFETIME_FORFEIT_BPS = 100;
    uint256 public pendingForfeitAmount;
    /// @notice AUDIT REV-H-01: cumulative ETH reclaimed via the forfeit-reclaim path.
    ///         Bounded by MAX_LIFETIME_FORFEIT_BPS of totalDistributed.
    uint256 public totalForfeitedReclaimed;

    event ForfeitReclaimed(uint256 amount);
    event ForfeitReclaimProposed(uint256 amount, uint256 executeAfter);
    event ForfeitReclaimCancelled();

    error ForfeitExceedsEligibleDust();
    error ForfeitExceedsLifetimeCap();

    /// @notice AUDIT REV-H-01: Sum of unclaimed ETH across epochs whose DUST_RECLAIM_GRACE
    ///         has elapsed. This is the ONLY pool the owner is permitted to forfeit-reclaim.
    /// @dev Bounded loop scanning every epoch — O(epochs.length). Used in propose-time gate
    ///      and exposed as a view so off-chain callers can size proposals correctly.
    /// @dev AUDIT FIX F-13-3 [F-50-1, F-72-7] (LOW): preserved as the legacy
    ///      whole-history view for off-chain callers + the propose-time gate.
    ///      Long-tail O(epochs.length) — at ~6 epochs/day for 5 years this hits
    ///      ~10k epochs and approaches the eth_call gas budget. New paginated
    ///      sister `reclaimEligibleAmountPaginated` (below) is the canonical
    ///      on-chain shape; the propose path also accepts a paginated form.
    function reclaimEligibleAmount() public view returns (uint256 eligible) {
        return _reclaimEligibleInRange(0, epochs.length);
    }

    /// @notice AUDIT FIX F-13-3 [F-50-1, F-72-7] (LOW): paginated reclaim-eligibility
    ///         view. Off-chain callers and the propose path can chunk through
    ///         `epochs.length` with `MAX_RECLAIM_PAGE_SIZE` per call so the scan
    ///         remains gas-safe past the 5-year eth_call envelope.
    /// @param startEpoch The first epoch index to scan (inclusive).
    /// @param endEpoch   The end epoch index (exclusive). Must be `<= epochs.length`
    ///                   and `endEpoch - startEpoch <= MAX_RECLAIM_PAGE_SIZE`.
    function reclaimEligibleAmountPaginated(uint256 startEpoch, uint256 endEpoch)
        external
        view
        returns (uint256 eligible)
    {
        if (endEpoch > epochs.length) revert ReclaimEndEpochOutOfBounds();
        if (startEpoch >= endEpoch) revert ReclaimRangeEmpty();
        if (endEpoch - startEpoch > MAX_RECLAIM_PAGE_SIZE) revert ReclaimPageSizeExceeded();
        return _reclaimEligibleInRange(startEpoch, endEpoch);
    }

    /// @dev Shared body for `reclaimEligibleAmount` (whole-history) and
    ///      `reclaimEligibleAmountPaginated` (windowed). The eligibility logic
    ///      is identical to the prior pre-pagination implementation — only the
    ///      loop bounds differ. Centralised here to keep view↔write parity for
    ///      the M-12 fix in `executeForfeitReclaim`.
    function _reclaimEligibleInRange(uint256 startEpoch, uint256 endEpoch)
        internal
        view
        returns (uint256 eligible)
    {
        uint256 cutoff = block.timestamp > DUST_RECLAIM_GRACE ? block.timestamp - DUST_RECLAIM_GRACE : 0;
        // AUDIT FIX (BATCH-L1 M32): tighten the eligibility window further. Pre-fix
        // the cutoff was the only filter; here we add an EXTRA active-stake-grace
        // ahead of cutoff so a still-locked staker who just hasn't claimed yet
        // (e.g., user with auto-MaxLock who claims monthly) doesn't see their
        // share force-reclaimed at exactly DUST_RECLAIM_GRACE. The lifetime cap
        // (MAX_LIFETIME_FORFEIT_BPS = 1%) is still the primary bound; this just
        // pushes the per-epoch cutoff further back to be conservative.
        uint256 extendedCutoff = cutoff > 30 days ? cutoff - 30 days : 0;
        for (uint256 i = startEpoch; i < endEpoch; i++) {
            Epoch memory ep = epochs[i];
            if (ep.timestamp >= cutoff) continue; // Still in grace — skip.
            // AUDIT FIX (BATCH-L1 M32): epochs in the [extendedCutoff, cutoff) window
            // are eligible by primary grace but defensively under-eligible — only
            // half their unclaimed dust counts toward `eligible`. This halves the
            // force-reclaim pressure on still-active stakers' just-past-grace shares.
            if (ep.timestamp >= extendedCutoff) {
                if (pendingRecoveryCount[i] > 0) continue;
                uint256 unclaimedHalf = ep.totalETH > epochClaimed[i] ? (ep.totalETH - epochClaimed[i]) / 2 : 0;
                eligible += unclaimedHalf;
                continue;
            }
            // AUDIT FIX: V2-DR-M-04 — exclude pending-recovery epochs from the
            // forfeit-reclaim eligible pool. Without this skip the owner can
            // sequence `proposeForfeitReclaim` against an `eligible` figure that
            // includes a recovery's reserved share, then `executeForfeitReclaim`
            // → `sweepDust` to drain the contract balance, which would brick the
            // recovery's payout (its `user.call{value: share}` would fail with
            // out-of-funds). Mirrors the HALT semantics that DEEP-DR-M-03 added
            // for `autoReconcileDust` — both consumers of the per-epoch
            // unclaimed pool now respect `pendingRecoveryCount`.
            if (pendingRecoveryCount[i] > 0) continue;
            uint256 unclaimed = ep.totalETH > epochClaimed[i] ? ep.totalETH - epochClaimed[i] : 0;
            eligible += unclaimed;
        }
    }

    /// @notice AUDIT FIX M-12 [F-12-K-1] (MEDIUM): consume eligible per-epoch
    ///         dust in lockstep with the forfeit-reclaim accounting and bump
    ///         `epochClaimed[i]` on each consumed epoch so subsequent legitimate
    ///         late claims correctly compute zero remaining instead of being
    ///         routed to unfundable `pendingWithdrawals`.
    /// @dev Walks epochs in chronological order from `startEpoch` to `endEpoch`,
    ///      applying the same eligibility filter as `_reclaimEligibleInRange`,
    ///      but on the WRITE side. Each consumed epoch's `epochClaimed[i]` is
    ///      advanced by the consumed slice so future `_calculateClaim` returns
    ///      the correct (zero) remaining for those epochs. Returns the actual
    ///      amount consumed (≤ `targetAmount`).
    function _consumeEligibleAndBumpClaimed(
        uint256 startEpoch,
        uint256 endEpoch,
        uint256 targetAmount
    ) internal returns (uint256 consumed) {
        if (targetAmount == 0) return 0;
        uint256 cutoff = block.timestamp > DUST_RECLAIM_GRACE ? block.timestamp - DUST_RECLAIM_GRACE : 0;
        uint256 extendedCutoff = cutoff > 30 days ? cutoff - 30 days : 0;
        uint256 remaining = targetAmount;
        for (uint256 i = startEpoch; i < endEpoch && remaining > 0; i++) {
            Epoch memory ep = epochs[i];
            if (ep.timestamp >= cutoff) continue;
            if (pendingRecoveryCount[i] > 0) continue;
            uint256 epochUnclaimed = ep.totalETH > epochClaimed[i]
                ? ep.totalETH - epochClaimed[i]
                : 0;
            // Apply the same half-window cap that the eligibility view applies
            // to epochs in [extendedCutoff, cutoff). The write-side accounting
            // MUST mirror the view-side eligibility so the propose-time/execute-
            // time `eligible` figures stay consistent with the `epochClaimed[i]`
            // bumps applied here.
            if (ep.timestamp >= extendedCutoff) {
                epochUnclaimed = epochUnclaimed / 2;
            }
            // SLITHER 2026-05-18: sentinel comparison (zero/uninitialized check, exact-match gate)
            // slither-disable-next-line incorrect-equality
            if (epochUnclaimed == 0) continue;
            uint256 take = epochUnclaimed > remaining ? remaining : epochUnclaimed;
            // SECURITY: bump `epochClaimed[i]` so a still-locked late claimer
            // computing `remaining = epoch.totalETH - epochClaimed[i]` in
            // `_calculateClaim` will see zero (or strictly less) for this
            // epoch — closing the F-12-K-1 rug where late claimers were
            // routed to unfundable `pendingWithdrawals`.
            epochClaimed[i] += take;
            consumed += take;
            remaining -= take;
        }
    }

    function proposeForfeitReclaim(uint256 _amount) external onlyOwner {
        require(_amount > 0 && _amount <= 10 ether, "INVALID_AMOUNT");
        uint256 gap = totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0;
        require(_amount <= gap, "EXCEEDS_GAP");
        // AUDIT REV-H-01 (HIGH): the requested amount must be backed by per-epoch dust
        // whose grace period has already elapsed. This prevents draining still-claimable
        // ETH from fresh epochs.
        if (_amount > reclaimEligibleAmount()) revert ForfeitExceedsEligibleDust();
        // AUDIT REV-H-01: lifetime cap — total lifetime reclaims may not exceed
        // MAX_LIFETIME_FORFEIT_BPS of totalDistributed.
        uint256 lifetimeCap = (totalDistributed * MAX_LIFETIME_FORFEIT_BPS) / 10_000;
        if (totalForfeitedReclaimed + _amount > lifetimeCap) revert ForfeitExceedsLifetimeCap();
        pendingForfeitAmount = _amount;
        _propose(FORFEIT_RECLAIM, FORFEIT_RECLAIM_DELAY);
        emit ForfeitReclaimProposed(_amount, _executeAfter[FORFEIT_RECLAIM]);
    }

    /// @dev AUDIT FIX: DEEP-DR-M-02 — `whenNotPaused` so the universal kill-switch
    ///      freezes owner-side mutators alongside user claims (M-7 sibling-search).
    function executeForfeitReclaim() external onlyOwner whenNotPaused {
        _execute(FORFEIT_RECLAIM);
        uint256 amount = pendingForfeitAmount;
        uint256 gap = totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0;
        if (amount > gap) amount = gap;
        // AUDIT REV-H-01: re-check eligible dust at execution time. Defense-in-depth
        // against the race where epochs appear/are claimed during the 48h delay.
        uint256 eligible = reclaimEligibleAmount();
        if (amount > eligible) amount = eligible;
        // AUDIT FIX: DEEP-DR-H-02 — re-check the lifetime cap at execute time.
        // The propose-time cap is computed against `totalDistributed` at propose
        // time; if that figure changes between propose and execute (or any future
        // code path decrements it), the cap must still hold. Subsumes DR-M-09.
        uint256 lifetimeCap = (totalDistributed * MAX_LIFETIME_FORFEIT_BPS) / 10_000;
        if (totalForfeitedReclaimed + amount > lifetimeCap) {
            amount = lifetimeCap > totalForfeitedReclaimed ? lifetimeCap - totalForfeitedReclaimed : 0;
        }
        if (amount == 0) revert ForfeitExceedsLifetimeCap();

        // ─── AUDIT FIX M-12 [F-12-K-1] (MEDIUM) ────────────────────────────
        // Walk eligible epochs in chronological order and bump `epochClaimed[i]`
        // for each consumed epoch in lockstep with `totalEarmarked` decrement.
        // Without this, a long-locked late claimer (e.g., an auto-MaxLock user
        // claiming monthly) whose epoch share was reclaimed could still compute
        // their full owed amount via `_calculateClaim` (which reads the
        // immutable `epoch.totalETH` and `epochClaimed[i]` per-epoch high-water
        // mark) and be routed to `pendingWithdrawals` — but the contract
        // balance would be insufficient, bricking their `withdrawPending` call
        // permanently. By bumping `epochClaimed[i]` here, those late claimers
        // see zero remaining for the consumed epochs and skip them cleanly.
        //
        // The consume loop applies the same eligibility filter as
        // `_reclaimEligibleInRange` (the view used to size `eligible` above),
        // so the consumed slice exactly equals the slice the view counted as
        // eligible. By construction `consumed <= amount <= eligible`, but we
        // re-clamp `amount` to `consumed` defensively in case a future filter
        // change introduces drift.
        uint256 consumed = _consumeEligibleAndBumpClaimed(0, epochs.length, amount);
        if (consumed < amount) amount = consumed;
        if (amount == 0) revert ForfeitExceedsEligibleDust();

        totalEarmarked -= amount;
        totalForfeited += amount;
        totalForfeitedReclaimed += amount;
        pendingForfeitAmount = 0;
        emit ForfeitReclaimed(amount);
    }

    function cancelForfeitReclaim() external onlyOwner {
        _cancel(FORFEIT_RECLAIM);
        pendingForfeitAmount = 0;
        emit ForfeitReclaimCancelled();
    }

    /// @notice Reconcile rounding dust trapped inside totalEarmarked.
    ///         Per-epoch share calculations round down, so sum(claimed) < totalEarmarked.
    ///         This function reduces totalEarmarked to match actual obligations, freeing
    ///         the trapped dust for sweepDust().
    ///         AUDIT FIX H-03: Removed totalBoostedStake == 0 requirement which made this
    ///         function uncallable in a healthy protocol (stakers always present).
    ///         Increased dust cap from 0.01 to 1 ether to handle long-running accumulation.
    ///         The owner-only + gap-cap guards prevent abuse.
    /// @dev AUDIT FIX: DEEP-DR-M-02 — `whenNotPaused` so the universal kill-switch
    ///      freezes owner-side mutators alongside user claims (M-7 sibling-search).
    function reconcileRoundingDust() external onlyOwner whenNotPaused {
        uint256 gap = totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0;
        require(gap <= 1 ether, "GAP_TOO_LARGE");
        if (gap == 0) revert NoDustToSweep();
        totalForfeited += gap;
        totalEarmarked = totalClaimed;
        emit DustSwept(treasury, gap);
    }

    // ─── Auto Dust Reconcile (AUDIT R014 M-8) ─────────────────────────
    /// @notice Minimum per-epoch dust threshold to consider for auto-reconcile.
    uint256 public constant MIN_DUST_RECONCILE = 0.01 ether;
    /// @notice Grace period after epoch creation before its unclaimed dust can be auto-reclaimed.
    /// @dev AUDIT FIX: DEEP-DR-M-01 — bumped 7d → 14d so DUST_RECLAIM_GRACE >= 2 * CLAIM_GRACE_PERIOD.
    ///      Prevents the owner from forfeit-reclaiming epochs whose dust is still claimable by
    ///      grace-period users. With CLAIM_GRACE_PERIOD = 7d and the 48h forfeit timelock, a 7d
    ///      DUST_RECLAIM_GRACE permitted the owner to race a user whose lock just expired
    ///      (their 7d grace window overlaps the 7d epoch eligibility window). 14d guarantees
    ///      that any user whose lock expired before the epoch was eligible has had their
    ///      grace window close before the dust becomes reclaimable.
    uint256 public constant DUST_RECLAIM_GRACE = 14 days;
    /// @notice Bound on how many epochs a single autoReconcileDust() call may scan.
    uint256 public constant MAX_AUTO_RECONCILE_EPOCHS = 10;
    /// @notice Cursor tracking the next epoch index to attempt auto-reconcile for.
    uint256 public lastReconciledEpoch;

    /// @notice AUDIT FIX F-12-K-3 (LOW / fairness): cumulative dust collected
    ///         from `autoReconcileDust` across the protocol's lifetime.
    ///         Pre-fix, dust was mutated into `epochs[length-1].totalETH` —
    ///         which created a perverse incentive: users who already claimed
    ///         the destination epoch (`claimedAtEpoch[user][destEpoch] == true`)
    ///         were locked out of the redirected dust, while patient claimers
    ///         who delayed their latest-epoch claim until after `autoReconcileDust`
    ///         captured a disproportionate share. By routing dust into this
    ///         protocol-wide pool, all active stakers are treated symmetrically
    ///         and the dust is swept to treasury via the existing
    ///         48h-timelocked `executeForfeitReclaim` → `sweepDust` cycle.
    /// @dev The pool is decremented in step with `totalEarmarked` because the
    ///      dust was originally part of `totalEarmarked`. `sweepDust` reads
    ///      `address(this).balance - reserved` where `reserved = unclaimed +
    ///      pending`, so once `totalEarmarked` is decremented, the dust falls
    ///      into the sweepable surplus and is timelock-routed to treasury.
    uint256 public protocolDustPool;

    /// @notice AUDIT R014 M-8: Auto-reclaim per-epoch dust (epoch.totalETH - epochClaimed[i])
    ///         from finalized epochs whose 14-day grace period has elapsed. Dust above
    ///         MIN_DUST_RECONCILE is routed into a protocol-wide dust pool that is
    ///         eventually swept to treasury via the existing 48h-timelocked
    ///         `executeForfeitReclaim` → `sweepDust` cycle.
    ///
    ///         AUDIT FIX F-12-K-3 (LOW / fairness): the prior shape mutated
    ///         `epochs[length-1].totalETH += dust` which locked-out already-claimed
    ///         users from the redirected dust and gave patient claimers a perverse
    ///         timing advantage. Routing dust into a generic pool eliminates the
    ///         race condition; all stakers are treated symmetrically and the dust
    ///         is timelock-routed to treasury via the same path as
    ///         `executeForfeitReclaim`. The change ALSO eliminates the unbounded
    ///         `epochs[length-1].totalETH` growth that would otherwise inflate
    ///         `_calculateClaim` per-epoch math past `epoch.totalLocked`-cap math
    ///         (a 4-year-old protocol with significant straggler dust could see
    ///         the latest epoch's `totalETH` reach 5-10x its native value).
    ///
    ///         Bounded loop — at most MAX_AUTO_RECONCILE_EPOCHS (10) per call. The
    ///         lastReconciledEpoch cursor advances even when an epoch is skipped (e.g.
    ///         dust below threshold) so subsequent calls make forward progress without
    ///         re-scanning.
    ///
    ///         Permissionless — anyone may call. The grace period + threshold + cursor
    ///         together prevent griefing: a caller cannot reclaim dust that stragglers
    ///         could still rightfully claim, and cannot replay reclamations.
    /// @dev AUDIT FIX: DEEP-DR-M-02 — `whenNotPaused` so this permissionless mutator
    ///      cannot advance state while the universal kill-switch is engaged.
    function autoReconcileDust() external nonReentrant whenNotPaused returns (uint256 totalReclaimed, uint256 epochsProcessed) {
        uint256 totalEpochs = epochs.length;
        if (totalEpochs == 0) revert NoEpochToReconcile();

        uint256 cursor = lastReconciledEpoch;
        if (cursor >= totalEpochs) revert NoEpochToReconcile();

        // Auto-reconcile routes dust forward into the most recent epoch. We must NOT
        // touch the current (latest) epoch as both source and destination, and we must
        // leave at least one epoch as the destination.
        uint256 destEpoch = totalEpochs - 1;
        if (cursor >= destEpoch) revert NoEpochToReconcile();

        uint256 endEpoch = cursor + MAX_AUTO_RECONCILE_EPOCHS;
        if (endEpoch > destEpoch) endEpoch = destEpoch;

        bool anyEligible = false;
        uint256 lastTouched = cursor;

        for (uint256 i = cursor; i < endEpoch; i++) {
            Epoch memory epoch = epochs[i];

            // Grace period gate — if the next-eligible epoch is still in its grace
            // window, stop scanning. We do NOT advance the cursor past an in-grace
            // epoch; subsequent calls will retry it once enough time has passed.
            if (epoch.timestamp + DUST_RECLAIM_GRACE > block.timestamp) {
                if (!anyEligible) revert GracePeriodActive();
                break;
            }

            // AUDIT FIX: DEEP-DR-M-03 — pending-recovery epochs HALT the cursor.
            // Previously the loop `continue`'d past pending-recovery epochs (skipping
            // their dust) but `lastTouched` had already been updated, so the cursor
            // advanced past them anyway. After the recovery executed, the residual
            // dust on those epochs was permanently orphaned (no replay path).
            //
            // New semantics: STOP at the first pending-recovery epoch. The cursor
            // does NOT advance past it. Subsequent calls retry from this epoch
            // once the recovery resolves (cancel or execute clears the count).
            // This preserves dust auto-reclaim for the residual portion of the
            // epoch that the recovery did not consume.
            if (pendingRecoveryCount[i] > 0) {
                if (!anyEligible) revert NoEpochToReconcile();
                break;
            }

            anyEligible = true;
            lastTouched = i;

            uint256 dust = epoch.totalETH > epochClaimed[i] ? epoch.totalETH - epochClaimed[i] : 0;
            if (dust >= MIN_DUST_RECONCILE) {
                // Mark the source epoch fully claimed so future claims/views correctly
                // see no remaining share.
                epochClaimed[i] = epoch.totalETH;
                // ─── AUDIT FIX F-12-K-3 (LOW / fairness) ─────────────────────
                // Pre-fix: `epochs[destEpoch].totalETH += dust` mutated the
                // latest epoch's pool, locking out already-claimed users from
                // the redirected dust and giving patient claimers a perverse
                // timing advantage.
                //
                // New shape: route the dust into the protocol-wide
                // `protocolDustPool`, decrement `totalEarmarked` (the dust is
                // no longer earmarked for stakers), and bump `totalForfeited`
                // to keep the `totalDistributed = totalClaimed + totalEarmarked +
                // totalForfeited` invariant intact. The dust then becomes
                // sweepable via the existing 48h-timelocked owner sweep path
                // (sweepDust reads `balance - reserved` and `reserved` is
                // `unclaimed + pending`, so once `totalEarmarked` is decremented
                // the dust falls into the sweepable surplus).
                //
                // This eliminates the racing-claimer fairness issue AND caps
                // unbounded growth of `epochs[destEpoch].totalETH` over the
                // protocol's lifetime.
                if (totalEarmarked >= dust) {
                    totalEarmarked -= dust;
                } else {
                    totalEarmarked = 0;
                }
                totalForfeited += dust;
                protocolDustPool += dust;
                totalReclaimed += dust;
                emit DustRoutedToProtocolPool(i, destEpoch, dust);
            }
        }

        if (!anyEligible) revert NoEpochToReconcile();

        epochsProcessed = lastTouched + 1 - cursor;
        lastReconciledEpoch = lastTouched + 1;

        emit DustAutoReconciled(cursor, lastTouched, totalReclaimed, destEpoch);
    }

    // ─── Claim Recovery (AUDIT R014 H-5) ───────────────────────────────

    /// @notice AUDIT R014 H-5: Propose an admin-attested recovery for a user whose
    ///         claim path reverts because their staking checkpoint reads 0 (NFT
    ///         transferred out, position corruption, etc.) and all fallbacks miss.
    ///
    ///         The owner must attest the user's correct historical voting power at
    ///         epoch.timestamp (from off-chain proof — typically the staking
    ///         checkpoint snapshot the indexer captured before the corruption).
    ///         A 48h timelock applies before executeClaimRecovery() may pay out.
    ///
    /// @dev    AUDIT FIX: V2-DR-L-04 — recovery is capped at 25% of
    ///         `epoch.totalLocked` per (user, epoch) pair via
    ///         `MAX_RECOVERY_POWER_BPS = 2500`. The unified `claimedAtEpoch`
    ///         flag is set on the FIRST `executeClaimRecovery`, so a holder
    ///         whose historical power exceeded 25% of `epoch.totalLocked` for a
    ///         single corrupted epoch CANNOT be made fully whole via this path
    ///         — subsequent proposals for the same (user, epoch) revert
    ///         `AlreadyClaimedNormally`. The residual share above the 25% cap is
    ///         permanently un-recoverable for that user and eventually flows
    ///         through `forfeitUnclaimedRewards` to the protocol treasury. This
    ///         is an architectural tradeoff inherited from DEEP-DR-H-02 / M-R6
    ///         (blast-radius bounding): an unbounded recovery is a one-shot rug
    ///         vector under owner-key compromise, while a 25% cap converts even
    ///         a successful exploit into a partial loss the protocol can
    ///         backfill from treasury via off-chain remediation. Ops must
    ///         escalate >25% holder corruptions through governance, not the
    ///         recovery path.
    ///
    /// @param user  The address whose claim is being recovered.
    /// @param epoch The epoch index to recover (must be < epochs.length).
    /// @param power The user's attested voting power at epoch.timestamp. Must be
    ///              <= epoch.totalLocked as a sanity bound, AND <= 25% of
    ///              `epoch.totalLocked` per V2-DR-L-04 cap above.
    function proposeClaimRecovery(address user, uint256 epoch, uint256 power) external onlyOwner {
        if (user == address(0)) revert ZeroAddress();
        if (epoch >= epochs.length) revert InvalidEpoch();
        if (power == 0) revert PowerExceedsTotalLocked(); // 0 is not a valid recovery
        if (recoveryClaimed[user][epoch]) revert AlreadyClaimed();
        // AUDIT FIX: DEEP-DR-M-04 — fail fast if the user already ran normal claim()
        // for this epoch (regardless of historical power). Replaces the old
        // `lastClaimedEpoch[user] > epoch` cursor check, which silently permitted
        // recovery for zero-power-loop visitors and burned a 48h timelock window
        // before the executeClaimRecovery guards caught it.
        if (claimedAtEpoch[user][epoch]) revert AlreadyClaimedNormally();
        // AUDIT REV-H-02 (HIGH): refuse proposals on epochs the auto-reconcile cursor
        // has already passed. Once epoch < lastReconciledEpoch the source pool may
        // have been emptied (epochClaimed[epoch] = epoch.totalETH), in which case
        // executeClaimRecovery would revert NothingToClaim() — fail fast at propose
        // time so admins do not waste a 48h timelock on a doomed proposal.
        if (epoch < lastReconciledEpoch) revert EpochAlreadyReconciled();

        Epoch memory ep = epochs[epoch];
        if (power > ep.totalLocked) revert PowerExceedsTotalLocked();
        // AUDIT FIX: DEEP-DR-H-02 / M-R6 — bound power to 25% of epoch.totalLocked
        // at propose time. A legitimate single-holder recovery for a >25% position
        // must use multiple proposals — each individually timelocked, each visible.
        uint256 recoveryCap = (ep.totalLocked * MAX_RECOVERY_POWER_BPS) / 10000;
        if (power > recoveryCap) revert RecoveryPowerExceedsCap();

        // AUDIT FIX D-DR-L1: aggregate per-epoch cap. Compute the prospective
        // aggregate power AFTER this propose lands; reject if it would exceed
        // 50% of epoch.totalLocked. Mirrors the per-proposal cap structure but
        // closes the multi-proposal bypass.
        uint256 oldPower = pendingRecoveries[user][epoch].power;
        uint256 prospectiveAggregate = aggregateRecoveryPower[epoch] + power - oldPower;
        uint256 aggregateCap = (ep.totalLocked * MAX_AGGREGATE_RECOVERY_POWER_BPS) / 10000;
        if (prospectiveAggregate > aggregateCap) revert RecoveryPowerExceedsCap();

        // AUDIT FIX 2026-05-16 M1: best-effort lifetime cap check at propose time.
        // Computes the ETH share this proposal would pay out and rejects if it would
        // breach `MAX_LIFETIME_RECOVERY_BPS = 1%` of totalDistributed. `totalDistributed`
        // can only grow between propose and execute, so the propose-time check is the
        // tighter bound — but execute-time also re-checks (defense-in-depth, same shape
        // as the forfeit path at line 1213-1216).
        if (ep.totalLocked > 0) {
            uint256 projectedShare = (ep.totalETH * power) / ep.totalLocked;
            uint256 lifetimeCap = (totalDistributed * MAX_LIFETIME_RECOVERY_BPS) / 10_000;
            if (totalRecoveryClaimed + projectedShare > lifetimeCap) {
                revert RecoveryExceedsLifetimeCap();
            }
        }

        // AUDIT REV-H-02: bump the per-epoch in-flight count ONLY when the slot was
        // empty. Re-proposing for the same (user, epoch) (e.g. amending the attested
        // power) overwrites without double-counting.
        if (pendingRecoveries[user][epoch].executeAfter == 0) {
            pendingRecoveryCount[epoch] += 1;
        }
        // AUDIT FIX D-DR-L1: update aggregate (handles both fresh propose and
        // overwrite via the (power - oldPower) delta computed above).
        aggregateRecoveryPower[epoch] = prospectiveAggregate;

        // Overwrite any in-flight proposal for this (user, epoch). Loud event ensures
        // any silent overwrite is auditable on-chain.
        uint256 unlockAt = block.timestamp + CLAIM_RECOVERY_DELAY;
        pendingRecoveries[user][epoch] = PendingRecovery({power: power, executeAfter: unlockAt});

        emit ClaimRecoveryProposed(user, epoch, power, unlockAt);
    }

    /// @notice Cancel a previously proposed claim recovery.
    function cancelClaimRecovery(address user, uint256 epoch) external onlyOwner {
        PendingRecovery memory p = pendingRecoveries[user][epoch];
        if (p.executeAfter == 0) revert NoPendingRecovery();
        delete pendingRecoveries[user][epoch];
        // AUDIT REV-H-02: decrement the per-epoch in-flight count so autoReconcileDust
        // can resume processing this epoch's residual dust.
        pendingRecoveryCount[epoch] -= 1;
        // AUDIT FIX D-DR-L1: free the cancelled power back to the aggregate cap
        // so legitimate recoveries are not permanently blocked by a previously
        // proposed-then-cancelled slot.
        if (aggregateRecoveryPower[epoch] >= p.power) {
            aggregateRecoveryPower[epoch] -= p.power;
        } else {
            aggregateRecoveryPower[epoch] = 0;
        }
        emit ClaimRecoveryCancelled(user, epoch);
    }

    /// @notice Execute a previously proposed claim recovery after the 48h timelock.
    ///         Pays the user as if they had the attested power, decrementing the
    ///         epoch's remaining pool via epochClaimed. Marks (user, epoch) as
    ///         recoveryClaimed so the same proposal cannot be replayed.
    /// @dev AUDIT FIX: DEEP-DR-H-01 — gated by `whenNotPaused` and the staking-paused
    ///      check that the normal claim path enforces. The recovery is admin-attested,
    ///      but pause is the universal kill-switch; recoveries must respect it. Without
    ///      this gate, a 48h-old proposal would still pay out during a live incident.
    function executeClaimRecovery(address user, uint256 epoch) external nonReentrant whenNotPaused {
        // AUDIT FIX: DEEP-DR-H-01 — block recovery payouts when staking is paused
        // (mirrors `claim()` / `claimUpTo()`). If staking was paused due to a
        // discovered exploit, recovery payouts using attested power must also halt.
        if (_isStakingPaused()) revert StakingPaused();
        PendingRecovery memory p = pendingRecoveries[user][epoch];
        if (p.executeAfter == 0) revert NoPendingRecovery();
        // AUDIT REV-M-03 (CLEANUP): use recovery-specific errors instead of the generic
        // TimelockAdmin proposal errors that took a bytes32 key. There is no `_executeAfter`
        // entry for the recovery — it lives in `pendingRecoveries[user][epoch]` — so the
        // old key-tagged error was misleading.
        if (block.timestamp < p.executeAfter) revert RecoveryNotReady();
        if (block.timestamp > p.executeAfter + PROPOSAL_VALIDITY) revert RecoveryExpired();
        if (recoveryClaimed[user][epoch]) revert AlreadyClaimed();
        // AUDIT FIX: DEEP-DR-M-04 — defensive: if a normal claim landed
        // during the 48h timelock window, the user has already been paid.
        // Refuse the recovery payout to prevent double-credit. This is
        // defence-in-depth on top of the same propose-time check.
        if (claimedAtEpoch[user][epoch]) revert AlreadyClaimedNormally();

        Epoch memory ep = epochs[epoch];
        if (ep.totalLocked == 0) revert NoLockedTokens();
        // Re-bound power against epoch.totalLocked (defensive — totalLocked is immutable
        // post-distribution but we read fresh state to be safe).
        uint256 power = p.power > ep.totalLocked ? ep.totalLocked : p.power;
        // AUDIT FIX: DEEP-DR-H-02 / M-R6 — re-apply the 25% cap defensively at
        // execute time. If a future code path bypasses the propose-time check,
        // this still enforces the cap. Pure clamp (no revert) — the proposal was
        // already validated; we just downsize to the cap if state shifted.
        uint256 recoveryCap = (ep.totalLocked * MAX_RECOVERY_POWER_BPS) / 10000;
        if (power > recoveryCap) power = recoveryCap;

        uint256 share = (ep.totalETH * power) / ep.totalLocked;

        // Cap by remaining pool to preserve C-03 invariant.
        uint256 remaining = ep.totalETH > epochClaimed[epoch] ? ep.totalETH - epochClaimed[epoch] : 0;
        if (share > remaining) share = remaining;
        if (share == 0) revert NothingToClaim();

        // AUDIT FIX 2026-05-16 M1: enforce lifetime cap at execute time too.
        // Mirrors the forfeit-execute pattern (line 1237-1239). Use a clamp here
        // (not a revert) so a recovery that propose-checked legitimately but ran
        // into a tighter cap after additional execute outflows still settles at
        // the cap remainder rather than fully reverting (which would forfeit the
        // 48h timelock work and require operator to cancel + re-propose). The
        // propose-time check is the primary defense; this is defense-in-depth.
        uint256 lifetimeCap = (totalDistributed * MAX_LIFETIME_RECOVERY_BPS) / 10_000;
        if (totalRecoveryClaimed + share > lifetimeCap) {
            share = lifetimeCap > totalRecoveryClaimed ? lifetimeCap - totalRecoveryClaimed : 0;
            if (share == 0) revert RecoveryExceedsLifetimeCap();
        }

        // Effects before external interaction (CEI).
        recoveryClaimed[user][epoch] = true;
        // AUDIT FIX: DEEP-DR-M-04 — also stamp the unified `claimedAtEpoch`
        // so a subsequent normal `claim()` from the same user CANNOT
        // re-traverse this epoch and double-credit. The unified mapping is
        // the source of truth for "this (user, epoch) is settled" across
        // both code paths; recovery and normal claim must mark it together.
        claimedAtEpoch[user][epoch] = true;
        delete pendingRecoveries[user][epoch];
        // AUDIT REV-H-02: decrement the per-epoch in-flight count.
        pendingRecoveryCount[epoch] -= 1;
        epochClaimed[epoch] += share;
        // AUDIT FIX 2026-05-16 M1: increment lifetime recovery tracker (CEI before
        // external call below). Never decremented for audit-trail integrity.
        totalRecoveryClaimed += share;

        // AUDIT REV-M-02 (DOCUMENT only): 10k stipend tradeoff — see claim() above for
        // the full rationale. Recovery payouts to recipients whose receive() doesn't fit
        // in 10k gas land in pendingWithdrawals and are pulled via withdrawPending()'s
        // WETH-fallback path.
        // SLITHER 2026-05-18: intended recipient (revenueDistributor / pol accumulator / user via timelocked admin-attested executeClaimRecovery with lifetime+per-epoch caps)
        // slither-disable-next-line arbitrary-send-eth
        (bool success,) = user.call{value: share, gas: 10000}("");
        if (success) {
            totalClaimed += share;
        } else {
            pendingWithdrawals[user] += share;
            totalPendingWithdrawals += share;
            emit PendingWithdrawalCredited(user, share);
        }

        emit ClaimRecoveryExecuted(user, epoch, power, share);
    }

    // ─── View Functions ───────────────────────────────────────────────

    /// @notice Calculate pending ETH claimable by a user
    function pendingETH(address user) external view returns (uint256) {
        return _pendingETH(user, MAX_VIEW_EPOCHS);
    }

    /// @notice Paginated version of pendingETH for frontends.
    function pendingETHPaginated(address user, uint256 maxEpochs) external view returns (uint256) {
        return _pendingETH(user, maxEpochs);
    }

    /// @dev Internal shared logic for pendingETH and pendingETHPaginated.
    function _pendingETH(address user, uint256 maxEpochs) internal view returns (uint256) {
        uint256 startEpoch = lastClaimedEpoch[user];
        uint256 endEpoch = epochs.length;

        if (startEpoch >= endEpoch) return 0;

        if (endEpoch - startEpoch > maxEpochs) {
            endEpoch = startEpoch + maxEpochs;
        }

        // Check lock state for grace period logic
        (uint256 currentLocked, uint256 lockEnd) = _getUserLockState(user);
        bool isRestaked = _isRestaked(user);
        bool lockActive = (currentLocked > 0 && block.timestamp < lockEnd) || isRestaked;
        bool inGracePeriod = !lockActive && lockEnd > 0 && block.timestamp < lockEnd + CLAIM_GRACE_PERIOD;
        if (!lockActive && !inGracePeriod) return 0;

        uint256 total = 0;
        for (uint256 i = startEpoch; i < endEpoch; i++) {
            Epoch memory epoch = epochs[i];
            // In grace period, only count epochs before lock expiry
            if (inGracePeriod && epoch.timestamp >= lockEnd) break;
            // AUDIT FIX: V2-DR-M-01 — mirror the write-path skip from
            // `_calculateClaim` (DEEP-DR-M-04). Epochs already settled via
            // `executeClaimRecovery` (`claimedAtEpoch[user][i] == true`) must NOT
            // contribute to `pendingETH(user)`; otherwise the view reports phantom
            // ETH that the corresponding `claim()` call would never actually pay
            // (the write path skips the same epoch and may revert NothingToClaim).
            if (claimedAtEpoch[user][i]) continue;
            if (epoch.totalLocked > 0) {
                uint256 userPower = votingEscrow.votingPowerAtTimestamp(user, epoch.timestamp);
                // AUDIT FIX M-13 [F-12-K-2, F-13-1] (MEDIUM) + REV-RESTAKE-01:
                // ADDITIVE sum of staking-side and restaking-side historical power.
                // Multi-source holders (direct NFT-A staked + NFT-B restaked)
                // correctly accumulate both sides; view stays in lockstep with
                // write path so frontends / indexers / keeper bots see the same
                // amount `claim()` will pay.
                // AUDIT FIX FRESH-2026: F-REV-EXRESTAKER — call unconditionally
                //         to mirror the write-path drop of the `isRestaker`
                //         short-circuit. Ex-restakers' historical power is now
                //         visible in `pendingETH(user)` instead of silently 0.
                userPower += _restakedPowerAt(user, epoch.timestamp);
                if (userPower > 0) {
                    uint256 effectivePower = userPower > epoch.totalLocked ? epoch.totalLocked : userPower;
                    uint256 share = (epoch.totalETH * effectivePower) / epoch.totalLocked;
                    // H-02 FIX: Apply per-epoch claimed cap (matches _calculateClaim write path)
                    uint256 remaining = epoch.totalETH > epochClaimed[i]
                        ? epoch.totalETH - epochClaimed[i] : 0;
                    if (share > remaining) share = remaining;
                    total += share;
                }
            }
        }
        return total;
    }

    /// @notice Total number of distribution epochs
    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    /// @notice Get epoch details
    function getEpoch(uint256 epochId) external view returns (uint256 totalETH, uint256 totalLocked, uint256 timestamp) {
        Epoch memory epoch = epochs[epochId];
        return (epoch.totalETH, epoch.totalLocked, epoch.timestamp);
    }

    /// @notice AUDIT FIX 2026-05-21 M19-CLUSTER: override `acceptOwnership` so any
    ///         pending TIMELOCK_KEY proposals seeded by the outgoing owner are
    ///         CANCELLED automatically on handoff. Mirrors the canonical
    ///         TegridyNFTPoolFactory pattern (M19 fix, commit 0a08bff). Without
    ///         this override, a captured outgoing owner could `propose...`
    ///         immediately before `transferOwnership`, and the timer would silently
    ///         keep running under the new owner. A new-owner deploy/keeper script
    ///         reading `pending...()` could then execute the hostile change.
    /// @dev    Calls `super.acceptOwnership()` first so the pendingOwner→owner
    ///         promotion happens before the cancellations.
    /// @dev    SCOPE NOTE: per-(user,epoch) `proposeClaimRecovery` proposals use
    ///         the `pendingRecoveries[user][epoch]` struct (NOT the TimelockAdmin
    ///         `_executeAfter` slot), so they are out of scope for this override.
    ///         Honest operators must use `cancelClaimRecovery(user, epoch)` to
    ///         clear each before transferring ownership if they want to flush
    ///         those proposals.
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[TREASURY_CHANGE] != 0) {
            address cancelled = pendingTreasury;
            _cancel(TREASURY_CHANGE);
            pendingTreasury = address(0);
            emit TreasuryChangeCancelled(cancelled);
        }
        if (_executeAfter[RESTAKING_CHANGE] != 0) {
            address cancelled = pendingRestaking;
            _cancel(RESTAKING_CHANGE);
            pendingRestaking = address(0);
            emit RestakingChangeCancelled(cancelled);
        }
        if (_executeAfter[EMERGENCY_WITHDRAW_EXCESS] != 0) {
            _cancel(EMERGENCY_WITHDRAW_EXCESS);
            emit EmergencyWithdrawExcessCancelled();
        }
        if (_executeAfter[TOKEN_SWEEP] != 0) {
            address token = pendingSweepToken;
            _cancel(TOKEN_SWEEP);
            pendingSweepToken = address(0);
            pendingSweepTo = address(0);
            emit TokenSweepCancelled(token);
        }
        if (_executeAfter[FORFEIT_RECLAIM] != 0) {
            _cancel(FORFEIT_RECLAIM);
            pendingForfeitAmount = 0;
            emit ForfeitReclaimCancelled();
        }
    }
}
