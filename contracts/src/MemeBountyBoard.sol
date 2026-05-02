// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";
// AUDIT FIX: DEEP-LIB-H2 — `IChainlinkAggregator` is no longer needed
// since `_sequencerBuffer` delegates to `SequencerCheck.getSequencerOutageBuffer`.
import {SequencerCheck} from "./lib/SequencerCheck.sol";

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
    /// @dev AUDIT M-B01: 48h-timelocked treasury rotation key.
    bytes32 public constant TREASURY_CHANGE = keccak256("BOUNTY_TREASURY_CHANGE");

    // ─── State ────────────────────────────────────────────────────────

    /// @dev AUDIT FIX: DEEP-GOV-12 — voteToken is dead state; all voting power
    ///      resolution goes through `stakingContract.votingPowerAtTimestamp`. This
    ///      field is retained for ABI compatibility only.
    /// @custom:deprecated Use stakingContract for voting power. Do NOT add reads
    ///                    of voteToken — it would silently change voter eligibility
    ///                    semantics (TOWELI balance instead of staked power).
    IERC20 public immutable voteToken; // TOWELI — must hold tokens to vote (anti-sybil)
    IStakingVote public immutable stakingContract; // Staking contract for flash-loan-resistant voting power
    address public immutable weth; // WETH for fallback payout to revert-on-receive winners
    /// @dev AUDIT L-B01 (2026-04-28): MIN_SUBMIT_BALANCE (500 TOWELI) and
    ///      MIN_VOTE_BALANCE (1000 TOWELI) are intentionally LOW-BAR thresholds.
    ///      The product intent is community-meme accessibility — a token
    ///      holder with under-$10 worth of TOWELI should be able to participate
    ///      in submission/voting flows. The thresholds exist solely to filter
    ///      pure zero-cost spam (creating a brand-new wallet with literally
    ///      nothing). All ECONOMIC anti-Sybil enforcement happens elsewhere
    ///      (MIN_COMPLETION_VOTES, MIN_UNIQUE_VOTERS, snapshot-based voting
    ///      power). Do NOT raise these to "real money" levels — that breaks
    ///      the meme-board UX.
    uint256 public constant MIN_VOTE_BALANCE = 1000 ether; // Must hold 1000 TOWELI to vote
    uint256 public constant MIN_DEADLINE_DURATION = 1 days; // Minimum time between creation and deadline
    uint256 public constant MIN_COMPLETION_VOTES = 3000e18; // AUDIT FIX H-07: Minimum stake-weighted votes for quorum (3000 TOWELI equivalent)
    uint256 public constant MIN_UNIQUE_VOTERS = 3; // SECURITY FIX H3: Prevent whale single-handedly completing bounties (Nouns DAO pattern)
    mapping(uint256 => uint256) public uniqueVoterCount; // bountyId => number of unique voters
    uint256 public constant DISPUTE_PERIOD = 2 days; // SECURITY FIX #15: dispute window after deadline
    /// @notice AUDIT FIX: DEEP-GOV-04 — final-window freeze on the top submission.
    ///         In the final 24h before deadline, votes STILL count toward each
    ///         submission's tally, but a non-top submission CANNOT displace the
    ///         existing top (when one exists). Closes the late-flip primitive.
    uint256 public constant TOP_FREEZE_WINDOW = 1 days;
    uint256 public constant GRACE_PERIOD = 30 days; // SECURITY FIX: after deadline + dispute, creator has 30 days before anyone can complete
    uint256 public constant MAX_SUBMISSIONS_PER_BOUNTY = 100; // L-05: cap submissions to prevent griefing
    uint256 public constant MIN_SUBMIT_BALANCE = 500 ether; // A4-M-15: Must hold 500 TOWELI to submit (prevents slot griefing)
    uint256 public constant MAX_DEADLINE_DURATION = 180 days; // AUDIT FIX H-20: prevent indefinite ETH locking (was 365, reduced to 180)
    // AUDIT FIX M-1 (battle-tested): snapshot voting power from SNAPSHOT_LOOKBACK before
    // bounty creation. Prevents creator-ally pre-positioning for submission voting.
    // AUDIT R014 (MEDIUM, MEV snapshot bypass): re-derived from a block-count
    // semantic. 250 blocks @ ~12s/block ≈ 50 minutes — close to the prior
    // 1-hour value but explicitly motivated by "block-resistant lookback" so
    // miner-influenced timestamp jitter cannot collapse the snapshot window
    // into a MEV-friendly tx. The staking checkpoint store (Checkpoints.Trace208)
    // is keyed by timestamp, so we convert: SNAPSHOT_LOOKBACK_BLOCKS * 12s.
    uint256 public constant SNAPSHOT_LOOKBACK_BLOCKS = 250;
    uint256 public constant SNAPSHOT_LOOKBACK = SNAPSHOT_LOOKBACK_BLOCKS * 12 seconds;
    // AUDIT FIX M-38: Configurable minimum reward — 0.001 ETH may be too low on L2
    uint256 public minBountyReward = 0.001 ether;
    uint256 public constant MIN_BOUNTY_REWARD_TIMELOCK = 24 hours;
    uint256 public pendingMinBountyReward;
    /// @notice AUDIT FIX: DEEP-GOV-11 — increased from 1h to 24h to mitigate the
    ///         creator front-run attack: an artist who has gathered material and
    ///         broadcasts `submitWork` in a contention window could be front-run by
    ///         the creator's `cancelBounty` (creator pays gas, gets refund, artist's
    ///         submission tx reverts with BountyNotOpen). 24h aligns with the
    ///         industry-standard grant-board cancel grace (Gitcoin Grants).
    uint256 public constant MIN_CANCEL_DELAY = 24 hours;
    /// @dev AUDIT L-B03 (2026-04-28): the 7-day post-deadline grace before
    ///      force-cancel becomes available is the OUTER bound; the M-28
    ///      voter-diversity gate (MIN_UNIQUE_VOTERS) is the inner bound that
    ///      prevents this cancel path from being WEAPONIZED by a single
    ///      whale. Even after 7 days, force-cancel only succeeds when the
    ///      bounty has NOT yet collected sufficient distinct voters to
    ///      complete — i.e., it is genuinely abandoned, not deliberately
    ///      stalled to extract a refund. The two timers MUST be considered
    ///      together — removing either weakens the model.
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
        // AUDIT R014 (MEDIUM, creator voting suppression): snapshot the bounty
        // creator at creation time and reject any vote where the voter matches
        // the snapshot. Mirrors `creator` today, but having an immutable
        // snapshot field guarantees the suppression check survives any future
        // creator-mutation logic and gives auditors an explicit invariant.
        address originalCreator;
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
    /// @dev AUDIT L-B02 (2026-04-28): the comparison at the leader-update site
    ///      is `if (newVotes > topSubmissionVotes[_bountyId])` — STRICTLY
    ///      greater. Effect: a tie does NOT promote the new submission;
    ///      whoever crossed the threshold first remains the leader. This is
    ///      "first-mover wins on ties" semantics and is INTENTIONAL — it
    ///      removes a griefing vector where a sock-puppet voter could perpetually
    ///      flip the leader between two tied submissions to delay completion.
    ///      Submitters tied at the top should rally additional votes to break
    ///      the tie rather than expect rotation.
    mapping(uint256 => uint256) public topSubmissionVotes; // bountyId => vote count of top submission
    mapping(uint256 => mapping(address => bool)) public hasSubmitted; // AUDIT FIX L-18: one submission per address
    mapping(uint256 => uint256) public totalBountyVotes; // AUDIT FIX M-17: aggregate votes across all submissions

    uint256 public totalBountiesPosted;
    uint256 public totalPaidOut;
    mapping(address => uint256) public pendingRefund; // A3-H-03: Pull-pattern for creator refunds
    mapping(address => uint256) public refundTimestamp; // M-09: Track when refund was credited for expiry sweep
    uint256 public constant REFUND_EXPIRY = 365 days; // M-09: Refunds expire after 1 year
    mapping(address => uint256) public pendingPayouts; // FIX 1: Pull-pattern for winners who can't receive ETH

    // ─── AUDIT M-B01: treasury (recipient of expired refund sweeps) ────
    /// @notice Address that receives expired refund sweeps. Settable via the
    ///         48h-timelocked propose/execute pattern below. Initialized in the
    ///         constructor — pass owner() at deploy time if no separate
    ///         treasury is required, then rotate via the timelock once a
    ///         multisig / treasury contract is live.
    address public treasury;
    /// @notice 48h timelock delay matching the CommunityGrants `FEE_RECEIVER_TIMELOCK`
    ///         and POLAccumulator `TREASURY_CHANGE_DELAY` siblings.
    uint256 public constant TREASURY_CHANGE_DELAY = 48 hours;
    /// @notice Pending replacement queued by `proposeTreasuryChange`.
    address public pendingTreasury;

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
    /// @notice AUDIT M-B01: emitted on each step of the treasury rotation.
    event TreasuryChangeProposed(address indexed current, address indexed proposed, uint256 readyAt);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    event TreasuryChangeCancelled(address indexed cancelled);

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
    error EmptyDescription(); // FIX 4: bounty description cannot be empty

    // Legacy error aliases (kept for test compatibility)
    error NoPendingMinRewardChange();
    error MinRewardTimelockNotElapsed();

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function minBountyRewardChangeTime() external view returns (uint256) { return _executeAfter[MIN_REWARD_CHANGE]; }

    // ─── Constructor ──────────────────────────────────────────────────

    // ─── AUDIT R062: L2 Sequencer Uptime gating ──────────────────────
    /// @notice Optional Chainlink L2 Sequencer Uptime feed. address(0) on
    ///         mainnet / non-L2 (no-op).
    address public immutable sequencerFeed;
    /// @notice Buffer added to force-cancel and stale-refund windows when the
    ///         sequencer was unavailable. An honest creator/voter who tried
    ///         to participate during an outage should not be punished by
    ///         losing the bounty to a window that elapsed entirely while the
    ///         chain was down. 1h matches the Aave V3 grace default.
    uint256 public constant SEQUENCER_OUTAGE_BUFFER = 1 hours;

    /// @param _sequencerFeed AUDIT R062 — Chainlink L2 Sequencer Uptime feed;
    ///        pass `address(0)` for mainnet / non-L2 deployments.
    /// @param _treasury     AUDIT M-B01 — address that receives expired refund
    ///        sweeps. MUST be non-zero; deployers can pass owner() and rotate
    ///        later via `proposeTreasuryChange` if a separate treasury is not
    ///        yet provisioned.
    constructor(address _voteToken, address _stakingContract, address _weth, address _sequencerFeed, address _treasury)
        OwnableNoRenounce(msg.sender)
    {
        // L-02: Validate constructor arguments
        if (_voteToken == address(0)) revert ZeroAddress();
        if (_stakingContract == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        // M-B01: treasury must be non-zero so sweepExpiredRefund always has a
        // valid sink. The 48h timelock on treasury rotation prevents an
        // immediate post-deploy mistake from being weaponized.
        if (_treasury == address(0)) revert ZeroAddress();
        voteToken = IERC20(_voteToken);
        stakingContract = IStakingVote(_stakingContract);
        weth = _weth;
        // R062: zero permitted (mainnet / non-L2 = gating disabled).
        sequencerFeed = _sequencerFeed;
        // M-B01: initial treasury anchor.
        treasury = _treasury;
    }

    // ─── AUDIT M-B01: Treasury Timelock ───────────────────────────────

    /// @notice Propose a new treasury address. Takes effect after 48h.
    function proposeTreasuryChange(address _newTreasury) external onlyOwner {
        if (_newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = _newTreasury;
        _propose(TREASURY_CHANGE, TREASURY_CHANGE_DELAY);
        emit TreasuryChangeProposed(treasury, _newTreasury, _executeAfter[TREASURY_CHANGE]);
    }

    /// @notice Execute the pending treasury change after the timelock elapses.
    function executeTreasuryChange() external onlyOwner {
        _execute(TREASURY_CHANGE);
        address old = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChanged(old, treasury);
    }

    /// @notice Cancel a pending treasury change.
    function cancelTreasuryChange() external onlyOwner {
        _cancel(TREASURY_CHANGE);
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        emit TreasuryChangeCancelled(cancelled);
    }

    /// @notice View helper — timestamp at which the queued treasury change
    ///         becomes executable. 0 if no pending change.
    function treasuryChangeReadyAt() external view returns (uint256) {
        return _executeAfter[TREASURY_CHANGE];
    }

    /// @notice AUDIT R062: returns SEQUENCER_OUTAGE_BUFFER when the L2
    ///         sequencer is currently down or has resumed within the buffer
    ///         window. 0 otherwise — and 0 when sequencerFeed is unset
    ///         (mainnet / non-L2). Used by `refundStaleBounty` and
    ///         `emergencyForceCancel` to widen the grace window when an
    ///         outage prevented honest participation.
    /// @dev    AUDIT FIX: DEEP-LIB-H2 — delegates to the canonical
    ///         `SequencerCheck.getSequencerOutageBuffer` helper. The previous
    ///         in-line implementation duplicated the sequencer-uptime logic
    ///         and missed the M-Lib2 (round-validity / staleness) and
    ///         M-Lib3 (`answer != 0` strict-equality) updates that were
    ///         applied to the canonical lib. Replaced with a one-liner so
    ///         any future hardening of `getSequencerOutageBuffer` propagates
    ///         here automatically — single source of truth for sequencer
    ///         gating across the protocol.
    function _sequencerBuffer() internal view returns (uint256) {
        return SequencerCheck.getSequencerOutageBuffer(sequencerFeed, SEQUENCER_OUTAGE_BUFFER);
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
        // FIX 4: Reject empty descriptions
        if (bytes(_description).length == 0) revert EmptyDescription();
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
            // AUDIT H10 + NEW-I1: fallback to (block.timestamp - 1) when
            // SNAPSHOT_LOOKBACK hasn't elapsed, to avoid the 0-timestamp
            // checkpoint-default trap on test/fork environments. The dead
            // `block.timestamp > 0` guard was removed — always ≥1 in real blocks.
            snapshotTimestamp: block.timestamp >= SNAPSHOT_LOOKBACK
                ? block.timestamp - SNAPSHOT_LOOKBACK
                : block.timestamp - 1,
            createdAt: block.timestamp,
            // AUDIT R014: snapshot creator identity at creation time.
            originalCreator: msg.sender
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
        // SECURITY FIX M-11: Prevent bounty creator from voting to influence outcome.
        // AUDIT R014 (MEDIUM, creator suppression): check against the originalCreator
        // snapshot field — invariant-grade rejection, immune to any future creator
        // mutation. We also keep the live `creator` check for defense-in-depth.
        if (msg.sender == bounties[_bountyId].originalCreator || msg.sender == bounties[_bountyId].creator) revert CreatorCannotVote();
        // AUDIT FIX: DEEP-GOV-01 — min(historical, current) clamp. Closes the snapshot/
        // possession decoupling: a voter who held an NFT at snapshot but transferred
        // most of it post-snapshot (keeping a 1-wei sentinel) cannot apply the full
        // pre-divest aggregate to amplify a confederate's submission.
        uint256 historicalPower = stakingContract.votingPowerAtTimestamp(msg.sender, bounties[_bountyId].snapshotTimestamp);
        uint256 currentPower = stakingContract.votingPowerOf(msg.sender);
        uint256 voterPower = historicalPower < currentPower ? historicalPower : currentPower;
        if (voterPower < MIN_VOTE_BALANCE) revert InsufficientVoteBalance();

        // H-02: Set both mappings — per-bounty (primary check) and per-submission (backwards compat)
        hasVotedOnBounty[_bountyId][msg.sender] = true;
        // SECURITY FIX H3: Track unique voters for diversity requirement (Nouns DAO pattern)
        uniqueVoterCount[_bountyId]++;
        hasVotedOnSubmission[_bountyId][_submissionId][msg.sender] = true;
        // AUDIT FIX H-07: Use stake-weighted voting to prevent Sybil attacks
        submissions[_bountyId][_submissionId].votes += voterPower;
        totalBountyVotes[_bountyId] += voterPower; // AUDIT FIX M-17: Track aggregate
        uint256 newVotes = submissions[_bountyId][_submissionId].votes;

        // Track top submission to avoid unbounded loop in completeBounty
        // AUDIT FIX M-03: Use strict > so first submission to reach a vote count keeps its position (fair tie-breaking)
        // AUDIT FIX: DEEP-GOV-04 — top-submission freeze window. In the final
        // TOP_FREEZE_WINDOW (24h) before deadline, votes still accumulate per-submission
        // but a non-top submission cannot displace the existing top. Closes the
        // late-flip primitive (snapshot-pinned voting power flipping the result at the
        // buzzer). The freeze ONLY activates when there's already a leader — without
        // the `topSubmissionVotes > 0` guard, bounties with no pre-freeze votes would
        // be locked out because default `topSubmissionId == 0` would block all
        // non-zero submissions from ever promoting. Pattern: Snapshot off-chain voting
        // closes 24h before display deadline; Compound Bravo vote-queue extension.
        // AUDIT FIX: V2-GOV-08 — additionally require the leader to be ESTABLISHED
        // (topSubmissionVotes >= MIN_COMPLETION_VOTES) for the freeze protection to
        // apply. Pre-fix, a sock-puppet who voted MIN_VOTE_BALANCE for an unwanted
        // submission BEFORE freeze would lock out the rest of the epoch — even
        // 100,000 TOWELI of legitimate late votes for a different submission could
        // not displace a 1,000 TOWELI sock-puppet leader. With the established-
        // threshold gate, a tiny leader can still be displaced; once any submission
        // crosses the completion threshold, the freeze kicks in to prevent late-flip
        // griefing. Pattern: Snapshot established-thresholds for late-vote protection.
        bool inFreeze = block.timestamp + TOP_FREEZE_WINDOW >= bounties[_bountyId].deadline;
        if (newVotes > topSubmissionVotes[_bountyId]) {
            // V2-GOV-08: only protect the leader during freeze when an ESTABLISHED
            // leader exists (>= MIN_COMPLETION_VOTES). Tiny pre-freeze sock-puppet
            // leaders can still be displaced.
            bool hasEstablishedLeader = topSubmissionVotes[_bountyId] >= MIN_COMPLETION_VOTES;
            if (!inFreeze || !hasEstablishedLeader || _submissionId == topSubmissionId[_bountyId]) {
                topSubmissionVotes[_bountyId] = newVotes;
                topSubmissionId[_bountyId] = _submissionId;
            }
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
        // SECURITY FIX H3: Require minimum voter diversity — prevents whale solo-completing bounties
        require(uniqueVoterCount[_bountyId] >= MIN_UNIQUE_VOTERS, "INSUFFICIENT_VOTER_DIVERSITY");

        address winner = submissions[_bountyId][topSubmissionId[_bountyId]].submitter;
        bounty.winner = winner;

        // AUDIT FIX M-20: CEI pattern — ALL state changes BEFORE external call (no rollback after)
        uint256 reward = bounty.reward;
        totalPaidOut += reward;
        bounty.status = BountyStatus.Completed;

        // SECURITY FIX: Use WETHFallbackLib with 10k gas stipend (Solmate/Seaport pattern)
        // instead of full-gas .call{value} which enabled cross-contract reentrancy.
        (bool success,) = winner.call{value: reward, gas: 10000}("");
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
        // AUDIT FIX: V2-GOV-09 — scale the cancel delay for short-deadline bounties so
        // a 1-day-deadline bounty isn't permanently uncancellable. Pre-fix the
        // MIN_CANCEL_DELAY=24h floor combined with MIN_DEADLINE_DURATION=1d created
        // bounties whose entire cancel window was zero (cancel opens at createdAt+24h
        // == deadline, hits CannotCancelAfterDeadline). The original DEEP-GOV-11
        // attack only requires a delay long enough to discourage front-run cancels;
        // 1 hour suffices for the anti-frontrun goal even on the shortest bounty.
        // For longer bounties (deadline > createdAt + 25h), the full 24h floor still
        // applies. Pattern: bounded delay with a sensible minimum (Gitcoin grant
        // boards apply tiered cancel windows by bounty length).
        uint256 bountyDuration = bounty.deadline - bounty.createdAt;
        uint256 effectiveCancelDelay = MIN_CANCEL_DELAY;
        if (bountyDuration < MIN_CANCEL_DELAY + 1 hours) {
            // Short bounty: leave at least 1h between cancel-open and deadline so the
            // creator has SOME window. 1h is the original (pre-DEEP-GOV-11) MIN_CANCEL_DELAY.
            effectiveCancelDelay = bountyDuration > 1 hours ? bountyDuration - 1 hours : 0;
        }
        if (block.timestamp < bounty.createdAt + effectiveCancelDelay) revert CancelTooEarly();
        // SECURITY FIX M-10: Cannot cancel after receiving submissions — prevents
        // creator from viewing submitted work (on-chain URIs), copying it, then cancelling.
        if (bounty.submissionCount > 0) revert CannotCancelWithSubmissions();

        bounty.status = BountyStatus.Cancelled;

        // SECURITY FIX: Use 10k gas stipend (Solmate/Seaport pattern) instead of full-gas .call
        (bool success,) = bounty.creator.call{value: bounty.reward, gas: 10000}("");
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
        // R062 (HIGH): when the L2 sequencer was unavailable, extend the
        // grace window by SEQUENCER_OUTAGE_BUFFER so an honest creator/voter
        // who tried to participate during an outage isn't punished by a
        // refund window that elapsed entirely while the chain was offline.
        if (block.timestamp < bounty.deadline + DISPUTE_PERIOD + GRACE_PERIOD + _sequencerBuffer()) revert GracePeriodNotExpired();
        if (topSubmissionVotes[_bountyId] >= MIN_COMPLETION_VOTES && uniqueVoterCount[_bountyId] >= MIN_UNIQUE_VOTERS) revert WinnerExists();

        // No submission met quorum — refund creator
        bounty.status = BountyStatus.Cancelled;

        // SECURITY FIX: Use 10k gas stipend (Solmate/Seaport pattern) instead of full-gas .call
        (bool success,) = bounty.creator.call{value: bounty.reward, gas: 10000}("");
        if (!success) {
            pendingRefund[bounty.creator] += bounty.reward;
            refundTimestamp[bounty.creator] = block.timestamp;
            emit RefundCredited(_bountyId, bounty.creator, bounty.reward);
        }

        emit BountyCancelled(_bountyId);
    }

    /// @notice Emergency cancel by owner — refunds the bounty creator (does NOT pay any submission).
    /// @param _bountyId The bounty ID to emergency-cancel
    function emergencyCancel(uint256 _bountyId) external nonReentrant onlyOwner {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        if (bounty.submissionCount > 0) revert CannotCancelWithSubmissions();

        bounty.status = BountyStatus.Cancelled;

        // SECURITY FIX: Use 10k gas stipend (Solmate/Seaport pattern) instead of full-gas .call
        (bool success,) = bounty.creator.call{value: bounty.reward, gas: 10000}("");
        if (!success) {
            pendingRefund[bounty.creator] += bounty.reward;
            refundTimestamp[bounty.creator] = block.timestamp;
            emit RefundCredited(_bountyId, bounty.creator, bounty.reward);
        }

        emit BountyEmergencyCancelled(_bountyId);
    }

    /// @notice FIX 2: Emergency force cancel by owner — works even with submissions.
    /// @param _bountyId The bounty ID to force-cancel
    function emergencyForceCancel(uint256 _bountyId) external nonReentrant onlyOwner {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        // R062 (HIGH): extend force-cancel grace by SEQUENCER_OUTAGE_BUFFER
        // when the sequencer was recently down/resumed. Owner shouldn't be
        // able to refund the creator over a cancel window that elapsed while
        // artists could not submit / dispute (chain offline).
        if (block.timestamp < bounty.deadline + EMERGENCY_FORCE_CANCEL_DELAY + _sequencerBuffer()) revert ForceCancelTooEarly();
        // AUDIT M-28: both block-checks now require voter diversity. Without the
        // uniqueVoterCount gate on the aggregate-votes branch, a single whale with
        // >= 2x quorum could block force-cancel without satisfying completeBounty's
        // diversity requirement, deadlocking the bounty in an unfinishable state.
        // Now the bounty is only "winner exists" if there is real voter consensus.
        if (topSubmissionVotes[_bountyId] >= MIN_COMPLETION_VOTES && uniqueVoterCount[_bountyId] >= MIN_UNIQUE_VOTERS) revert WinnerExists();
        if (totalBountyVotes[_bountyId] >= MIN_COMPLETION_VOTES * 2 && uniqueVoterCount[_bountyId] >= MIN_UNIQUE_VOTERS) revert WinnerExists();

        bounty.status = BountyStatus.Cancelled;

        // SECURITY FIX: Use 10k gas stipend (Solmate/Seaport pattern) instead of full-gas .call
        (bool success,) = bounty.creator.call{value: bounty.reward, gas: 10000}("");
        if (!success) {
            pendingRefund[bounty.creator] += bounty.reward;
            refundTimestamp[bounty.creator] = block.timestamp;
            emit RefundCredited(_bountyId, bounty.creator, bounty.reward);
        }

        emit BountyForceCancelled(_bountyId);
    }

    // ─── Expired Refund Sweep (M-09) ───────────────────────────────────

    /// @notice M-09: Sweep expired unclaimed refunds to the treasury.
    ///         Refunds expire after REFUND_EXPIRY (365 days) of being unclaimed.
    /// @dev    AUDIT M-B01 (2026-04-29): destination changed from `owner()` to
    ///         `treasury`. Routing expired sweeps to a separately-controlled
    ///         treasury address (multisig / dedicated wallet) decouples
    ///         operational ownership from the proceeds custody — a compromised
    ///         owner key alone can no longer extract expired refunds without
    ///         also rotating the treasury through the new 48h timelock.
    /// @param _user The user whose expired refund to sweep
    function sweepExpiredRefund(address _user) external onlyOwner nonReentrant {
        require(pendingRefund[_user] > 0, "NO_REFUND");
        require(refundTimestamp[_user] != 0 && block.timestamp >= refundTimestamp[_user] + REFUND_EXPIRY, "NOT_EXPIRED");
        uint256 amount = pendingRefund[_user];
        pendingRefund[_user] = 0;
        refundTimestamp[_user] = 0;
        // SECURITY FIX: Use WETHFallbackLib instead of full-gas .call (Solmate/Seaport pattern)
        // AUDIT M-B01: send to `treasury`, not `owner()`.
        WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, amount);
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
