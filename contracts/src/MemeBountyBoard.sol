// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";

interface IStakingVote {
    function votingPowerOf(address user) external view returns (uint256);
    function votingPowerAt(address user, uint256 blockNumber) external view returns (uint256);
    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256);
}

/// @title MemeBountyBoard
/// @notice A decentralized bounty board where anyone can post bounties (in ETH)
///         for tasks. Community votes on submissions. Winner gets paid.
///
///         Use cases: meme creation, tool building, thread writing,
///         sticker pack design, art commissions, community contributions.
///
///         "Seize the memes of production" — now with actual compensation.
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
///  - WETHFallbackLib: Solmate SafeTransferLib + WETH fallback (Uniswap V3/V4, Seaport)
contract MemeBountyBoard is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant MIN_REWARD_CHANGE = keccak256("MIN_REWARD_CHANGE");

    // ─── State ────────────────────────────────────────────────────────

    IERC20 public immutable voteToken; // TOWELI — must hold tokens to vote (anti-sybil)
    IStakingVote public immutable stakingContract; // Staking contract for flash-loan-resistant voting power
    address public immutable weth; // WETH for fallback payout to revert-on-receive winners
    uint256 public constant MIN_VOTE_BALANCE = 1000 ether; // Must hold 1000 TOWELI to vote
    uint256 public constant MIN_DEADLINE_DURATION = 1 days; // Minimum time between creation and deadline
    uint256 public constant MIN_COMPLETION_VOTES = 3000e18; // AUDIT FIX H-07: Minimum stake-weighted votes for quorum (3000 TOWELI equivalent)
    uint256 public constant DISPUTE_PERIOD = 2 days; // SECURITY FIX #15: dispute window after deadline
    uint256 public constant GRACE_PERIOD = 30 days; // SECURITY FIX: after deadline + dispute, creator has 30 days before anyone can complete
    uint256 public constant MAX_SUBMISSIONS_PER_BOUNTY = 100; // L-05: cap submissions to prevent griefing
    uint256 public constant MIN_SUBMIT_BALANCE = 500 ether; // A4-M-15: Must hold 500 TOWELI to submit (prevents slot griefing)
    uint256 public constant MAX_DEADLINE_DURATION = 180 days; // AUDIT FIX H-20: prevent indefinite ETH locking (was 365, reduced to 180)
    // AUDIT FIX M-38: Configurable minimum reward — 0.001 ETH may be too low on L2
    uint256 public minBountyReward = 0.001 ether;
    uint256 public constant MIN_BOUNTY_REWARD_TIMELOCK = 24 hours;
    uint256 public pendingMinBountyReward;
    uint256 public constant MIN_CANCEL_DELAY = 1 hours; // FIX 3: minimum time after creation before cancel allowed
    uint256 public constant EMERGENCY_FORCE_CANCEL_DELAY = 7 days; // FIX 2: grace period after deadline for force cancel

    enum BountyStatus { Open, Completed, Cancelled }

    struct Bounty {
        address creator;
        string description;
        uint256 reward;       // ETH locked
        uint256 deadline;
        address winner;
        BountyStatus status;
        uint256 submissionCount;
        uint256 snapshotTimestamp; // Timestamp snapshot for voting power (L2-safe)
        uint256 createdAt;    // FIX 3: timestamp of creation for cancel delay
    }

    struct Submission {
        address submitter;
        string contentURI;    // IPFS hash or URL
        uint256 votes;
    }

    Bounty[] public bounties;
    mapping(uint256 => Submission[]) public submissions; // bountyId => submissions
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public hasVotedOnSubmission;
    mapping(uint256 => mapping(address => bool)) public hasVotedOnBounty; // H-02: per-bounty vote tracking to prevent vote splitting
    mapping(uint256 => uint256) public topSubmissionId; // bountyId => submission index with most votes
    mapping(uint256 => uint256) public topSubmissionVotes; // bountyId => vote count of top submission
    mapping(uint256 => mapping(address => bool)) public hasSubmitted; // AUDIT FIX L-18: one submission per address
    mapping(uint256 => uint256) public totalBountyVotes; // AUDIT FIX M-17: aggregate votes across all submissions

    uint256 public totalBountiesPosted;
    uint256 public totalPaidOut;
    mapping(address => uint256) public pendingRefund; // A3-H-03: Pull-pattern for creator refunds
    mapping(address => uint256) public refundTimestamp; // M-09: Track when refund was credited for expiry sweep
    uint256 public constant REFUND_EXPIRY = 365 days; // M-09: Refunds expire after 1 year
    mapping(address => uint256) public pendingPayouts; // FIX 1: Pull-pattern for winners who can't receive ETH

    // ─── Events ───────────────────────────────────────────────────────

    event BountyCreated(uint256 indexed id, address indexed creator, uint256 reward, string description);
    event SubmissionAdded(uint256 indexed bountyId, uint256 submissionId, address indexed submitter, string contentURI);
    event SubmissionVoted(uint256 indexed bountyId, uint256 submissionId, address indexed voter);
    event BountyCompleted(uint256 indexed bountyId, address indexed winner, uint256 reward);
    event BountyCancelled(uint256 indexed bountyId);
    event BountyEmergencyCancelled(uint256 indexed bountyId);
    event BountyDisputed(uint256 indexed bountyId, address indexed disputer); // SECURITY FIX #15
    event PayoutCredited(uint256 indexed bountyId, address indexed winner, uint256 reward);
    event PayoutWithdrawn(address indexed winner, uint256 amount);
    event BountyForceCancelled(uint256 indexed bountyId);
    event RefundCredited(uint256 indexed bountyId, address indexed creator, uint256 amount); // A3-H-03
    event MinBountyRewardProposed(uint256 newReward, uint256 executeAfter);
    event MinBountyRewardExecuted(uint256 newReward);

    // ─── Errors ───────────────────────────────────────────────────────

    error InsufficientReward();
    error BountyNotOpen();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error AlreadyVoted();
    error InvalidBounty();
    error InvalidSubmission();
    error NoSubmissions();
    error NotCreator();
    error NotCreatorOrOwner();
    error ETHTransferFailed();
    error InsufficientVoteBalance();
    error DeadlineTooSoon();
    error QuorumNotMet(); // SECURITY FIX #15
    error DisputePeriodActive(); // SECURITY FIX #15
    error CannotVoteOwnSubmission();
    error CannotCancelAfterDeadline();
    error CreatorCannotSubmit(); // SECURITY FIX: prevent self-dealing
    error GracePeriodNotExpired(); // SECURITY FIX: grace period for permissionless completion
    error ZeroAddress(); // L-02: constructor validation
    error MaxSubmissionsReached(); // L-05: submission cap
    error AlreadySubmitted(); // AUDIT FIX v3: custom error for duplicate submissions
    error WinnerExists(); // AUDIT FIX: valid winner exists, use completeBounty instead
    error DeadlineTooFar(); // AUDIT FIX: prevent indefinite ETH locking
    error CreatorCannotVote(); // SECURITY FIX M-11: prevent creator from influencing outcome
    error CannotCancelWithSubmissions(); // SECURITY FIX M-10: prevent cancelling after receiving work
    error InsufficientSubmitBalance(); // A4-M-15: Must hold tokens to submit
    error CancelTooEarly(); // FIX 3: cannot cancel before MIN_CANCEL_DELAY after creation
    error ForceCancelTooEarly(); // FIX 2: force cancel grace period not yet passed
    error NoPendingPayout(); // FIX 1: no pending payout to withdraw

    // Legacy error aliases (kept for test compatibility)
    error NoPendingMinRewardChange();
    error MinRewardTimelockNotElapsed();

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function minBountyRewardChangeTime() external view returns (uint256) { return _executeAfter[MIN_REWARD_CHANGE]; }

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _voteToken, address _stakingContract, address _weth) OwnableNoRenounce(msg.sender) {
        // L-02: Validate constructor arguments
        if (_voteToken == address(0)) revert ZeroAddress();
        if (_stakingContract == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        voteToken = IERC20(_voteToken);
        stakingContract = IStakingVote(_stakingContract);
        weth = _weth;
    }

    // ─── Pausable ────────────────────────────────────────────────────

    /// @notice Pause the contract (owner only)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause the contract (owner only)
    function unpause() external onlyOwner {
        _unpause();
    }

    function proposeMinBountyReward(uint256 _minReward) external onlyOwner {
        require(_minReward > 0, "ZERO_REWARD");
        require(_minReward <= 1 ether, "TOO_HIGH");
        pendingMinBountyReward = _minReward;
        _propose(MIN_REWARD_CHANGE, MIN_BOUNTY_REWARD_TIMELOCK);
        emit MinBountyRewardProposed(_minReward, _executeAfter[MIN_REWARD_CHANGE]);
    }

    function executeMinBountyRewardChange() external onlyOwner {
        _execute(MIN_REWARD_CHANGE);
        minBountyReward = pendingMinBountyReward;
        emit MinBountyRewardExecuted(pendingMinBountyReward);
        pendingMinBountyReward = 0;
    }

    // ─── Bounty Management ────────────────────────────────────────────

    /// @notice Create a bounty. ETH sent with this call is the reward.
    /// @param _description Text describing the bounty task
    /// @param _deadline Unix timestamp after which submissions close (must be >= 1 day from now)
    function createBounty(string calldata _description, uint256 _deadline) external payable whenNotPaused {
        if (msg.value < minBountyReward) revert InsufficientReward();
        // SECURITY FIX: Cap description length to prevent storage bloat griefing
        require(bytes(_description).length <= 2000, "DESC_TOO_LONG");
        if (_deadline < block.timestamp + MIN_DEADLINE_DURATION) revert DeadlineTooSoon();
        // AUDIT FIX: Prevent indefinite ETH locking with unreasonable deadlines
        if (_deadline > block.timestamp + MAX_DEADLINE_DURATION) revert DeadlineTooFar();

        bounties.push(Bounty({
            creator: msg.sender,
            description: _description,
            reward: msg.value,
            deadline: _deadline,
            winner: address(0),
            status: BountyStatus.Open,
            submissionCount: 0,
            snapshotTimestamp: block.timestamp > 0 ? block.timestamp - 1 : 0,
            createdAt: block.timestamp
        }));

        totalBountiesPosted++;
        emit BountyCreated(bounties.length - 1, msg.sender, msg.value, _description);
    }

    /// @notice Submit work for a bounty
    /// @param _bountyId The bounty ID to submit work for
    /// @param _contentURI IPFS hash or URL pointing to the submission content
    function submitWork(uint256 _bountyId, string calldata _contentURI) external whenNotPaused {
        // SECURITY FIX: Cap contentURI length to prevent storage bloat griefing
        require(bytes(_contentURI).length <= 2000, "URI_TOO_LONG");
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        if (block.timestamp > bounty.deadline) revert DeadlinePassed();
        // SECURITY FIX: Prevent creator from submitting work on their own bounty (self-dealing)
        if (msg.sender == bounty.creator) revert CreatorCannotSubmit();
        if (stakingContract.votingPowerAtTimestamp(msg.sender, bounty.snapshotTimestamp) < MIN_SUBMIT_BALANCE) revert InsufficientSubmitBalance();
        // L-05: Cap submissions per bounty
        if (bounty.submissionCount >= MAX_SUBMISSIONS_PER_BOUNTY) revert MaxSubmissionsReached();
        // AUDIT FIX L-18: One submission per address per bounty
        if (hasSubmitted[_bountyId][msg.sender]) revert AlreadySubmitted();
        hasSubmitted[_bountyId][msg.sender] = true;

        submissions[_bountyId].push(Submission({
            submitter: msg.sender,
            contentURI: _contentURI,
            votes: 0
        }));
        bounty.submissionCount++;

        emit SubmissionAdded(_bountyId, submissions[_bountyId].length - 1, msg.sender, _contentURI);
    }

    /// @notice Vote for a submission. Must hold MIN_VOTE_BALANCE TOWELI (anti-sybil).
    ///         SECURITY FIX: Uses snapshotted voting power to prevent flash-stake manipulation.
    ///         H-02: Each voter can only vote once per bounty (prevents vote splitting).
    /// @param _bountyId The bounty ID containing the submission
    /// @param _submissionId The index of the submission to vote for
    function voteForSubmission(uint256 _bountyId, uint256 _submissionId) external whenNotPaused {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        if (_submissionId >= submissions[_bountyId].length) revert InvalidSubmission();
        // H-02: Check per-bounty vote to prevent vote splitting across submissions
        if (hasVotedOnBounty[_bountyId][msg.sender]) revert AlreadyVoted();
        if (bounties[_bountyId].status != BountyStatus.Open) revert BountyNotOpen();
        // AUDIT FIX v2: Prevent voting after deadline
        if (block.timestamp > bounties[_bountyId].deadline) revert DeadlinePassed();
        // SECURITY FIX: Prevent submitters from voting on their own submissions
        if (submissions[_bountyId][_submissionId].submitter == msg.sender) revert CannotVoteOwnSubmission();
        // SECURITY FIX M-11: Prevent bounty creator from voting to influence outcome
        if (msg.sender == bounties[_bountyId].creator) revert CreatorCannotVote();
        uint256 voterPower = stakingContract.votingPowerAtTimestamp(msg.sender, bounties[_bountyId].snapshotTimestamp);
        if (voterPower < MIN_VOTE_BALANCE) revert InsufficientVoteBalance();

        // H-02: Set both mappings — per-bounty (primary check) and per-submission (backwards compat)
        hasVotedOnBounty[_bountyId][msg.sender] = true;
        hasVotedOnSubmission[_bountyId][_submissionId][msg.sender] = true;
        // AUDIT FIX H-07: Use stake-weighted voting to prevent Sybil attacks
        submissions[_bountyId][_submissionId].votes += voterPower;
        totalBountyVotes[_bountyId] += voterPower; // AUDIT FIX M-17: Track aggregate
        uint256 newVotes = submissions[_bountyId][_submissionId].votes;

        // Track top submission to avoid unbounded loop in completeBounty
        // AUDIT FIX M-03: Use strict > so first submission to reach a vote count keeps its position (fair tie-breaking)
        if (newVotes > topSubmissionVotes[_bountyId]) {
            topSubmissionVotes[_bountyId] = newVotes;
            topSubmissionId[_bountyId] = _submissionId;
        }

        emit SubmissionVoted(_bountyId, _submissionId, msg.sender);
    }

    /// @notice Complete a bounty — pay the top-voted submission.
    ///         Only the bounty creator can complete it (owner cannot override).
    ///         SECURITY FIX #15: Requires minimum vote quorum and dispute period.
    ///         AUDIT FIX M-20/M-06: State finalized before external call; on failure, credits pendingPayouts.
    /// @param _bountyId The bounty ID to complete and pay out
    function completeBounty(uint256 _bountyId) external nonReentrant whenNotPaused {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        if (block.timestamp <= bounty.deadline) revert DeadlineNotPassed();
        // SECURITY FIX #15: Enforce dispute period — cannot complete until dispute window closes
        if (block.timestamp < bounty.deadline + DISPUTE_PERIOD) revert DisputePeriodActive();
        // SECURITY FIX: Creator-only within grace period; after grace period, anyone can complete
        if (msg.sender != bounty.creator) {
            if (block.timestamp < bounty.deadline + DISPUTE_PERIOD + GRACE_PERIOD) revert GracePeriodNotExpired();
        }
        if (bounty.submissionCount == 0) revert NoSubmissions();

        // Read top-voted submission directly (tracked during voting, no loop needed)
        uint256 topVotes = topSubmissionVotes[_bountyId];

        // SECURITY FIX #15: Require minimum vote threshold for completion (quorum)
        if (topVotes < MIN_COMPLETION_VOTES) revert QuorumNotMet();

        address winner = submissions[_bountyId][topSubmissionId[_bountyId]].submitter;
        bounty.winner = winner;

        // AUDIT FIX M-20: CEI pattern — ALL state changes BEFORE external call (no rollback after)
        uint256 reward = bounty.reward;
        totalPaidOut += reward;
        bounty.status = BountyStatus.Completed;

        (bool success,) = winner.call{value: reward}("");
        if (success) {
            emit BountyCompleted(_bountyId, winner, reward);
        } else {
            // AUDIT FIX M-06: Credit to pendingPayouts instead of rolling back state
            pendingPayouts[winner] += reward;
            emit PayoutCredited(_bountyId, winner, reward);
        }
    }

    /// @notice FIX 1: Withdraw pending payout (pull-pattern for winners who cannot receive ETH via push)
    ///         AUDIT FIX M-06: If ETH transfer fails (revert-on-receive), wraps as WETH and sends WETH instead
    function withdrawPayout() external nonReentrant {
        uint256 amount = pendingPayouts[msg.sender];
        if (amount == 0) revert NoPendingPayout();
        pendingPayouts[msg.sender] = 0;
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, amount);
        emit PayoutWithdrawn(msg.sender, amount);
    }

    /// @notice Cancel a bounty and refund (creator or owner, before deadline only)
    ///         SECURITY FIX: Cannot cancel after deadline to prevent extracting free labor
    ///         A3-H-03 FIX: Uses pull-pattern if creator can't receive ETH
    /// @param _bountyId The bounty ID to cancel and refund
    function cancelBounty(uint256 _bountyId) external nonReentrant {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        if (block.timestamp > bounty.deadline) revert CannotCancelAfterDeadline();
        if (msg.sender != bounty.creator && msg.sender != owner()) revert NotCreatorOrOwner();
        // FIX 3: Prevent creator from front-running submitWork — must wait MIN_CANCEL_DELAY after creation
        if (block.timestamp < bounty.createdAt + MIN_CANCEL_DELAY) revert CancelTooEarly();
        // SECURITY FIX M-10: Cannot cancel after receiving submissions — prevents
        // creator from viewing submitted work (on-chain URIs), copying it, then cancelling.
        if (bounty.submissionCount > 0) revert CannotCancelWithSubmissions();

        bounty.status = BountyStatus.Cancelled;

        (bool success,) = bounty.creator.call{value: bounty.reward}("");
        if (!success) {
            // A3-H-03: Credit to pendingRefund instead of reverting
            pendingRefund[bounty.creator] += bounty.reward;
            refundTimestamp[bounty.creator] = block.timestamp; // M-09: Track refund time
            emit RefundCredited(_bountyId, bounty.creator, bounty.reward);
        }

        emit BountyCancelled(_bountyId);
    }

    /// @notice A3-H-03: Withdraw pending refund (pull-pattern for creators whose address can't receive ETH)
    function withdrawRefund() external nonReentrant {
        uint256 amount = pendingRefund[msg.sender];
        if (amount == 0) revert NoPendingPayout();
        pendingRefund[msg.sender] = 0;
        refundTimestamp[msg.sender] = 0; // M-09: Clear refund timestamp
        WETHFallbackLib.safeTransferETHOrWrap(weth, msg.sender, amount);
    }

    /// @notice Refund a stale bounty where no submission met the vote quorum after the full
    ///         grace period (deadline + dispute period + grace period). Anyone can call this.
    ///         Refunds ETH to the bounty creator since no valid winner exists.
    ///         A3-H-03 FIX: Uses pull-pattern if creator can't receive ETH.
    /// @param _bountyId The bounty ID to refund
    function refundStaleBounty(uint256 _bountyId) external nonReentrant {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        if (block.timestamp < bounty.deadline + DISPUTE_PERIOD + GRACE_PERIOD) revert GracePeriodNotExpired();
        // AUDIT FIX: Only allow refund if no submission met the completion quorum.
        // If a valid winner exists, use completeBounty() instead — prevents creator front-running.
        if (topSubmissionVotes[_bountyId] >= MIN_COMPLETION_VOTES) revert WinnerExists();

        // No submission met quorum — refund creator
        bounty.status = BountyStatus.Cancelled;

        (bool success,) = bounty.creator.call{value: bounty.reward}("");
        if (!success) {
            // A3-H-03: Credit to pendingRefund instead of reverting
            pendingRefund[bounty.creator] += bounty.reward;
            refundTimestamp[bounty.creator] = block.timestamp; // M-09: Track refund time
            emit RefundCredited(_bountyId, bounty.creator, bounty.reward);
        }

        emit BountyCancelled(_bountyId);
    }

    /// @notice Emergency cancel by owner — refunds the bounty creator (does NOT pay any submission).
    ///         Use only for disputes, spam, or stuck bounties.
    /// @param _bountyId The bounty ID to emergency-cancel
    function emergencyCancel(uint256 _bountyId) external nonReentrant onlyOwner {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        // SECURITY FIX M-12: Cannot emergency cancel if any submissions exist (before or after deadline).
        // Prevents owner from colluding with creator to extract free labor.
        if (bounty.submissionCount > 0) revert CannotCancelWithSubmissions();

        bounty.status = BountyStatus.Cancelled;

        (bool success,) = bounty.creator.call{value: bounty.reward}("");
        if (!success) {
            // A3-H-03: Credit to pendingRefund instead of reverting
            pendingRefund[bounty.creator] += bounty.reward;
            refundTimestamp[bounty.creator] = block.timestamp; // M-09: Track refund time
            emit RefundCredited(_bountyId, bounty.creator, bounty.reward);
        }

        emit BountyEmergencyCancelled(_bountyId);
    }

    /// @notice FIX 2: Emergency force cancel by owner — works even with submissions.
    ///         Requires 7 days after the bounty deadline has passed. For extreme cases only.
    /// @param _bountyId The bounty ID to force-cancel
    function emergencyForceCancel(uint256 _bountyId) external nonReentrant onlyOwner {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        // Must wait at least 7 days after the deadline
        if (block.timestamp < bounty.deadline + EMERGENCY_FORCE_CANCEL_DELAY) revert ForceCancelTooEarly();
        // AUDIT FIX: Cannot force-cancel when a legitimate winner exists
        if (topSubmissionVotes[_bountyId] >= MIN_COMPLETION_VOTES) revert WinnerExists();
        // AUDIT FIX M-17: Also block force-cancel when aggregate engagement is high
        // (multiple submissions with significant votes, even if none individually meet quorum).
        // Uses 2x MIN_COMPLETION_VOTES as the aggregate threshold.
        if (totalBountyVotes[_bountyId] >= MIN_COMPLETION_VOTES * 2) revert WinnerExists();

        bounty.status = BountyStatus.Cancelled;

        (bool success,) = bounty.creator.call{value: bounty.reward}("");
        if (!success) {
            pendingRefund[bounty.creator] += bounty.reward;
            refundTimestamp[bounty.creator] = block.timestamp; // M-09: Track refund time
            emit RefundCredited(_bountyId, bounty.creator, bounty.reward);
        }

        emit BountyForceCancelled(_bountyId);
    }

    // ─── Expired Refund Sweep (M-09) ───────────────────────────────────

    /// @notice M-09: Sweep expired unclaimed refunds to owner (treasury).
    ///         Refunds expire after REFUND_EXPIRY (365 days) of being unclaimed.
    /// @param _user The user whose expired refund to sweep
    function sweepExpiredRefund(address _user) external onlyOwner nonReentrant {
        require(pendingRefund[_user] > 0, "NO_REFUND");
        require(refundTimestamp[_user] != 0 && block.timestamp >= refundTimestamp[_user] + REFUND_EXPIRY, "NOT_EXPIRED");
        uint256 amount = pendingRefund[_user];
        pendingRefund[_user] = 0;
        refundTimestamp[_user] = 0;
        (bool ok,) = owner().call{value: amount}("");
        require(ok, "TRANSFER_FAILED");
    }

    // ─── View ─────────────────────────────────────────────────────────

    /// @notice Total number of bounties created
    /// @return The length of the bounties array
    function bountyCount() external view returns (uint256) { return bounties.length; }

    /// @notice Get bounty details by ID
    /// @param _id The bounty ID to query
    /// @return creator The address that created the bounty
    /// @return description The bounty description text
    /// @return reward The ETH reward locked for this bounty
    /// @return deadline The timestamp after which submissions close
    /// @return winner The winning submitter address (zero if not yet completed)
    /// @return submCount The number of submissions received
    /// @return status The current bounty status (Open, Completed, or Cancelled)
    function getBounty(uint256 _id) external view returns (
        address creator, string memory description, uint256 reward, uint256 deadline,
        address winner, uint256 submCount, BountyStatus status
    ) {
        Bounty memory b = bounties[_id];
        return (b.creator, b.description, b.reward, b.deadline, b.winner, b.submissionCount, b.status);
    }

    /// @notice Get submission details
    /// @param _bountyId The bounty ID
    /// @param _submissionId The submission index within the bounty
    /// @return submitter The address that submitted the work
    /// @return contentURI The IPFS hash or URL of the submission
    /// @return votes The number of votes this submission received
    function getSubmission(uint256 _bountyId, uint256 _submissionId) external view returns (
        address submitter, string memory contentURI, uint256 votes
    ) {
        Submission memory s = submissions[_bountyId][_submissionId];
        return (s.submitter, s.contentURI, s.votes);
    }

    /// @notice Get the number of submissions for a bounty
    /// @param _bountyId The bounty ID to query
    /// @return The number of submissions
    function submissionCount(uint256 _bountyId) external view returns (uint256) {
        return submissions[_bountyId].length;
    }
}
