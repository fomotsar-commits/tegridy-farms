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
    // AUDIT FIX: DEEP-DR-M-04 — per-(user,epoch) flag set by every normal-claim
    // iteration (regardless of share size). Replaces the `lastClaimedEpoch[user] > epoch`
    // proxy in `proposeClaimRecovery` so users with zero historical power who already
    // ran `claim()` (advancing the cursor past epoch i without setting any per-epoch
    // marker) cannot be silently locked out of a future legitimate recovery for that
    // same epoch.
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
    event PendingWithdrawnWETH(address indexed user, uint256 amount);
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

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error NoETHToDistribute();
    error NoLockedTokens();
    error NothingToClaim();
    error ETHTransferFailed();
    error StillHasLockedTokens();
    error NoETHToWithdraw();
    error TooManyEpochs();
    error NoPendingTreasuryChange();
    error TreasuryChangeNotReady();
    error UseProposeTreasuryChange();
    error NoPendingWithdrawal();
    error NoDustToSweep();
    error NoPendingRestakingChange();
    error RestakingChangeNotReady();
    error TooManyUnclaimedEpochs();
    error DistributeTooSoon();
    error EmergencyWithdrawNotProposed();
    error EmergencyWithdrawNotReady();
    error EmergencyWithdrawExpired();
    error StakingPaused(); // AUDIT FIX M-10: Block claims when staking is paused
    error EpochExhausted(); // AUDIT FIX C-03: Epoch funds fully claimed
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

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _votingEscrow, address _treasury, address _weth) OwnableNoRenounce(msg.sender) {
        if (_votingEscrow == address(0) || _treasury == address(0) || _weth == address(0)) revert ZeroAddress();
        votingEscrow = IVotingEscrow(_votingEscrow);
        weth = IWETH(_weth);
        treasury = _treasury;
    }

    // ─── Receive ETH ──────────────────────────────────────────────────

    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }

    // ─── Distribution ─────────────────────────────────────────────────

    /// @notice Create a new distribution epoch with NEW ETH (not already earmarked).
    ///         Permissionless — anyone can trigger (e.g., keeper, user, or admin).
    ///         Uses votingEscrow.totalBoostedStake() for the epoch's totalLocked snapshot.
    function distribute() external nonReentrant whenNotPaused {
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
        if (locked == 0) {
            locked = votingEscrow.totalBoostedStake();
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
    function emergencyWithdraw() external onlyOwner nonReentrant {
        if (votingEscrow.totalBoostedStake() != 0) revert StillHasLockedTokens();

        uint256 unclaimed = (totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0) + totalPendingWithdrawals;
        uint256 balance = address(this).balance;
        uint256 withdrawable = balance > unclaimed ? balance - unclaimed : 0;
        if (withdrawable == 0) revert NoETHToWithdraw();

        (bool success,) = treasury.call{value: withdrawable}("");
        if (!success) revert ETHTransferFailed();

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
        if (excess == 0) revert NoETHToWithdraw();

        (bool success,) = treasury.call{value: excess}("");
        if (!success) revert ETHTransferFailed();

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
        try restakingContract.restakers(_user) returns (
            uint256 tokenId, uint256 positionAmount, uint256, int256, uint256
        ) {
            return tokenId != 0 && positionAmount > 0;
        } catch {
            return false;
        }
    }

    /// @dev Returns the current restaked position amount for a user, or 0 if not restaked.
    function _getRestakedAmount(address _user) internal view returns (uint256) {
        if (address(restakingContract) == address(0)) return 0;
        try restakingContract.restakers(_user) returns (
            uint256 tokenId, uint256 positionAmount, uint256, int256, uint256
        ) {
            if (tokenId == 0) return 0;
            return positionAmount;
        } catch {
            return 0;
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
        try restakingContract.boostedAmountAt(_user, _ts) returns (uint256 p) {
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

        // AUDIT FIX: DEEP-DR-L-03 — cache the user's restaker status outside the
        // loop. Previously every iteration where `userPower == 0` fell through to
        // `_restakedPowerAt` which performed a try-CALL into the restaking contract,
        // so a non-restaker user with N zero-power epochs incurred N redundant CALLs.
        // Caching the bool once collapses the worst case to a single CALL.
        bool isRestaker = _isRestaked(user);

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

            // Mark every iterated epoch claimed-normally for this user,
            // regardless of share size or whether the epoch had any locked
            // tokens. The cursor advances past i unconditionally, so without
            // this per-epoch flag a user with zero historical power for
            // epoch i has no on-chain trace that they ran the normal claim
            // loop — and `proposeClaimRecovery` would be silently permitted
            // to refund them on the same (user, epoch).
            claimedAtEpoch[user][i] = true;

            if (epoch.totalLocked > 0) {
                uint256 userPower = votingEscrow.votingPowerAtTimestamp(user, epoch.timestamp);
                // AUDIT NEW-S1 (CRITICAL): if staking checkpoint reads 0, fall through
                // to the restaking contract's historical boostedAmount. Restakers' NFTs
                // are held by the restaking contract, so their staking checkpoint is
                // zeroed on transfer-in — without this fallback they silently earn $0.
                // AUDIT FIX: DEEP-DR-L-03 — only consult restaking contract if the user
                // has an active restaker position. Saves N try-CALLs for non-restakers.
                if (userPower == 0 && isRestaker) {
                    userPower = _restakedPowerAt(user, epoch.timestamp);
                }
                if (userPower > 0) {
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
        if (dust == 0) revert NoDustToSweep();

        (bool success,) = treasury.call{value: dust}("");
        if (!success) revert ETHTransferFailed();

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
    function reclaimEligibleAmount() public view returns (uint256 eligible) {
        uint256 cutoff = block.timestamp > DUST_RECLAIM_GRACE ? block.timestamp - DUST_RECLAIM_GRACE : 0;
        uint256 len = epochs.length;
        for (uint256 i = 0; i < len; i++) {
            Epoch memory ep = epochs[i];
            if (ep.timestamp >= cutoff) continue; // Still in grace — skip.
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

    /// @notice AUDIT R014 M-8: Auto-reclaim per-epoch dust (epoch.totalETH - epochClaimed[i])
    ///         from finalized epochs whose 7-day grace period has elapsed. Dust above
    ///         MIN_DUST_RECONCILE is moved into the most recent (current) epoch's pool so
    ///         active stakers absorb the unclaimed share.
    ///
    ///         Bounded loop — at most MAX_AUTO_RECONCILE_EPOCHS (10) per call. The
    ///         lastReconciledEpoch cursor advances even when an epoch is skipped (e.g.
    ///         dust below threshold) so subsequent calls make forward progress without
    ///         re-scanning.
    ///
    ///         Permissionless — anyone may call. The grace period + threshold + cursor
    ///         together prevent griefing: a caller cannot reclaim dust that stragglers
    ///         could still rightfully claim, and cannot replay reclamations.
    ///
    ///         Routes the reclaimed dust into the latest epoch (epochs[length-1]).
    ///         If there is no current epoch (epochs.length == 0) or only one epoch exists
    ///         (no separate destination available), the call reverts.
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
                // see no remaining share, and credit the destination epoch's pool.
                epochClaimed[i] = epoch.totalETH;
                epochs[destEpoch].totalETH += dust;
                totalReclaimed += dust;
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

        // AUDIT REV-H-02: bump the per-epoch in-flight count ONLY when the slot was
        // empty. Re-proposing for the same (user, epoch) (e.g. amending the attested
        // power) overwrites without double-counting.
        if (pendingRecoveries[user][epoch].executeAfter == 0) {
            pendingRecoveryCount[epoch] += 1;
        }

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

        // AUDIT REV-M-02 (DOCUMENT only): 10k stipend tradeoff — see claim() above for
        // the full rationale. Recovery payouts to recipients whose receive() doesn't fit
        // in 10k gas land in pendingWithdrawals and are pulled via withdrawPending()'s
        // WETH-fallback path.
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
                // AUDIT NEW-S1: restaker fallback — mirror _calculateClaim so the UI shows
                // non-zero pendingETH for restakers.
                // AUDIT FIX: DEEP-DR-L-03 — only consult restaking contract if user has
                // an active restaker position (cached in `isRestaked` above the loop).
                if (userPower == 0 && isRestaked) {
                    userPower = _restakedPowerAt(user, epoch.timestamp);
                }
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
}
