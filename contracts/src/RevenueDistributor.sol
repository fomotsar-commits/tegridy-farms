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
    bytes32 public constant CLAIM_RECOVERY = keccak256("CLAIM_RECOVERY");
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
    // AUDIT R014 M-8: Auto-reconcile errors
    error NoEpochToReconcile();
    error GracePeriodActive();

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

        // AUDIT FIX C-01: Snapshot denominator and individual power at the SAME timestamp.
        // OZ Checkpoints.upperLookup(T-1) returns most recent checkpoint with key <= T-1,
        // excluding same-block stakes (checkpoint key = T > T-1). The denominator must also
        // exclude same-block stakes to avoid diluting legitimate claimers.
        //
        // We read totalBoostedStake() twice (before and after the epoch push) and use the
        // minimum value to bound any same-block inflation. Combined with the 1-hour cooldown,
        // flash-stake dilution is economically unprofitable.
        uint256 locked = votingEscrow.totalBoostedStake();
        if (locked == 0) revert NoLockedTokens();

        uint256 snapshotTime = block.timestamp > 0 ? block.timestamp - 1 : 0;

        // Re-read total to detect same-tx manipulation. Use the lower value to ensure
        // the denominator is not inflated beyond what claimers can actually account for.
        uint256 lockedAfter = votingEscrow.totalBoostedStake();
        uint256 effectiveLocked = locked < lockedAfter ? locked : lockedAfter;

        epochs.push(Epoch({
            totalETH: newETH,
            totalLocked: effectiveLocked,
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

    function executeEmergencyWithdrawExcess() external onlyOwner nonReentrant {
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

        if (totalOwed == 0) revert NothingToClaim();

        lastClaimedEpoch[msg.sender] = actualEndEpoch;

        // SECURITY FIX C5: Only increment totalClaimed on successful direct transfer.
        // Failed transfers go to pendingWithdrawals — totalClaimed is incremented in withdrawPending().
        // Prevents totalEarmarked drift that permanently locks ETH (MakerDAO DSR pull-pattern).
        // SECURITY FIX: Use 10k gas stipend to prevent cross-contract reentrancy (Solmate/Seaport pattern)
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

        if (totalOwed == 0) revert NothingToClaim();

        lastClaimedEpoch[msg.sender] = actualEndEpoch;

        // SECURITY FIX C5: Only increment totalClaimed on successful direct transfer.
        // Failed transfers go to pendingWithdrawals — totalClaimed is incremented in withdrawPending().
        // Prevents totalEarmarked drift that permanently locks ETH (MakerDAO DSR pull-pattern).
        // SECURITY FIX: Use 10k gas stipend to prevent cross-contract reentrancy (Solmate/Seaport pattern)
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

        for (uint256 i = startEpoch; i < endEpoch; i++) {
            Epoch memory epoch = epochs[i];

            // In grace period, only claim epochs distributed before lock expired
            if (inGracePeriod && epoch.timestamp >= lockEnd) {
                actualEndEpoch = i;
                break;
            }

            if (epoch.totalLocked > 0) {
                uint256 userPower = votingEscrow.votingPowerAtTimestamp(user, epoch.timestamp);
                // AUDIT NEW-S1 (CRITICAL): if staking checkpoint reads 0, fall through
                // to the restaking contract's historical boostedAmount. Restakers' NFTs
                // are held by the restaking contract, so their staking checkpoint is
                // zeroed on transfer-in — without this fallback they silently earn $0.
                if (userPower == 0) {
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
    function sweepDust() external onlyOwner nonReentrant {
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

    function executeTokenSweep() external onlyOwner {
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
    bytes32 public constant FORFEIT_RECLAIM = keccak256("FORFEIT_RECLAIM");
    uint256 public constant FORFEIT_RECLAIM_DELAY = 48 hours;
    uint256 public pendingForfeitAmount;

    event ForfeitReclaimed(uint256 amount);
    event ForfeitReclaimProposed(uint256 amount, uint256 executeAfter);
    event ForfeitReclaimCancelled();

    function proposeForfeitReclaim(uint256 _amount) external onlyOwner {
        require(_amount > 0 && _amount <= 10 ether, "INVALID_AMOUNT");
        uint256 gap = totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0;
        require(_amount <= gap, "EXCEEDS_GAP");
        pendingForfeitAmount = _amount;
        _propose(FORFEIT_RECLAIM, FORFEIT_RECLAIM_DELAY);
        emit ForfeitReclaimProposed(_amount, _executeAfter[FORFEIT_RECLAIM]);
    }

    function executeForfeitReclaim() external onlyOwner {
        _execute(FORFEIT_RECLAIM);
        uint256 amount = pendingForfeitAmount;
        uint256 gap = totalEarmarked > totalClaimed ? (totalEarmarked - totalClaimed) : 0;
        if (amount > gap) amount = gap;
        totalEarmarked -= amount;
        totalForfeited += amount;
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
    function reconcileRoundingDust() external onlyOwner {
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
    uint256 public constant DUST_RECLAIM_GRACE = 7 days;
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
    function autoReconcileDust() external nonReentrant returns (uint256 totalReclaimed, uint256 epochsProcessed) {
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
    /// @param user  The address whose claim is being recovered.
    /// @param epoch The epoch index to recover (must be < epochs.length).
    /// @param power The user's attested voting power at epoch.timestamp. Must be
    ///              <= epoch.totalLocked as a sanity bound.
    function proposeClaimRecovery(address user, uint256 epoch, uint256 power) external onlyOwner {
        if (user == address(0)) revert ZeroAddress();
        if (epoch >= epochs.length) revert InvalidEpoch();
        if (power == 0) revert PowerExceedsTotalLocked(); // 0 is not a valid recovery
        if (recoveryClaimed[user][epoch]) revert AlreadyClaimed();

        Epoch memory ep = epochs[epoch];
        if (power > ep.totalLocked) revert PowerExceedsTotalLocked();

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
        emit ClaimRecoveryCancelled(user, epoch);
    }

    /// @notice Execute a previously proposed claim recovery after the 48h timelock.
    ///         Pays the user as if they had the attested power, decrementing the
    ///         epoch's remaining pool via epochClaimed. Marks (user, epoch) as
    ///         recoveryClaimed so the same proposal cannot be replayed.
    function executeClaimRecovery(address user, uint256 epoch) external nonReentrant {
        PendingRecovery memory p = pendingRecoveries[user][epoch];
        if (p.executeAfter == 0) revert NoPendingRecovery();
        if (block.timestamp < p.executeAfter) revert ProposalNotReady(CLAIM_RECOVERY);
        if (block.timestamp > p.executeAfter + PROPOSAL_VALIDITY) revert ProposalExpired(CLAIM_RECOVERY);
        if (recoveryClaimed[user][epoch]) revert AlreadyClaimed();

        Epoch memory ep = epochs[epoch];
        if (ep.totalLocked == 0) revert NoLockedTokens();
        // Re-bound power against epoch.totalLocked (defensive — totalLocked is immutable
        // post-distribution but we read fresh state to be safe).
        uint256 power = p.power > ep.totalLocked ? ep.totalLocked : p.power;

        uint256 share = (ep.totalETH * power) / ep.totalLocked;

        // Cap by remaining pool to preserve C-03 invariant.
        uint256 remaining = ep.totalETH > epochClaimed[epoch] ? ep.totalETH - epochClaimed[epoch] : 0;
        if (share > remaining) share = remaining;
        if (share == 0) revert NothingToClaim();

        // Effects before external interaction (CEI).
        recoveryClaimed[user][epoch] = true;
        delete pendingRecoveries[user][epoch];
        epochClaimed[epoch] += share;

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
            if (epoch.totalLocked > 0) {
                uint256 userPower = votingEscrow.votingPowerAtTimestamp(user, epoch.timestamp);
                // AUDIT NEW-S1: restaker fallback — mirror _calculateClaim so the UI shows
                // non-zero pendingETH for restakers.
                if (userPower == 0) {
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
