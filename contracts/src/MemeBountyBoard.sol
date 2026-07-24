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
import {VotePowerOracle} from "./lib/VotePowerOracle.sol";

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
    /// @notice Optional restaking contract; voting power from restaked positions
    ///         is added to staking-side power for submission/voting eligibility.
    /// @dev    AUDIT FIX (pass-8): GOV-ECON-01 / C10 — without this, users who
    ///         restake their staking NFT have `stakingContract.votingPowerOf`
    ///         return 0 and silently fail MIN_SUBMIT_BALANCE / MIN_VOTE_BALANCE
    ///         gates. One-shot setter (mirrors `setSequencerFeed` pattern).
    address public restakingContract;
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

    /// @dev GAS (1000-agent audit 2026-07-22, HIGH): repacked 9 storage slots → 4
    ///      (3 packed + the unavoidable `string` slot). `bounties` is a STORAGE array
    ///      and `createBounty` writes every field, so each removed slot is a full
    ///      cold SSTORE (~20,000 gas) saved per bounty — ~100,000 gas per creation.
    ///      Field ORDER below is load-bearing: Solidity packs sequentially, so
    ///      reordering these declarations silently un-packs them.
    ///
    ///        slot 0 │ creator(20) + deadline(6)  + createdAt(6)          = 32 B
    ///        slot 1 │ winner(20)  + snapshotTimestamp(6) + submissionCount(4)
    ///                 + status(1)                                       = 31 B
    ///        slot 2 │ originalCreator(20) + reward(12)                   = 32 B
    ///        slot 3 │ description (dynamic — always its own slot)
    ///
    ///      Width safety:
    ///        * `uint48` timestamps overflow in year ~8,921,556. Standard practice
    ///          (OpenZeppelin Governor, Aave V3 use the same width).
    ///        * `uint96` reward holds 7.9e28 wei ≈ 7.9e10 ETH, ~650x the entire ETH
    ///          supply (~1.2e8 ETH), so `msg.value` cannot truncate — a bounty large
    ///          enough to overflow cannot be funded because the ether does not exist.
    ///        * `uint32` submissionCount allows ~4.29e9 submissions per bounty; the
    ///          per-bounty cap `MAX_SUBMISSIONS_PER_BOUNTY` is orders of magnitude
    ///          below it.
    ///
    ///      STORAGE-LAYOUT CHANGE — fresh deploy only; a live instance cannot be
    ///      repacked in place. The `getBounty` view deliberately keeps its original
    ///      `uint256` return widths so the external ABI is UNCHANGED; only the
    ///      auto-generated `bounties(uint256)` getter tuple narrows, and that getter
    ///      has no consumer in this repo or in the frontend's generated ABI.
    struct Bounty {
        address creator;
        uint48 deadline;
        uint48 createdAt;     // FIX 3: timestamp of creation for cancel delay
        address winner;
        uint48 snapshotTimestamp; // Timestamp snapshot for voting power (L2-safe)
        uint32 submissionCount;
        BountyStatus status;
        // AUDIT R014 (MEDIUM, creator voting suppression): snapshot the bounty
        // creator at creation time and reject any vote where the voter matches
        // the snapshot. Mirrors `creator` today, but having an immutable
        // snapshot field guarantees the suppression check survives any future
        // creator-mutation logic and gives auditors an explicit invariant.
        address originalCreator;
        uint96 reward;        // ETH locked
        string description;
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
    event RestakingContractSet(address indexed restaking); // pass-8 GOV-ECON-01

    // ─── Errors ───────────────────────────────────────────────────────

    error InsufficientReward();
    error BountyNotOpen();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error AlreadyVoted();
    error InvalidBounty();
    error InvalidSubmission();
    error NoSubmissions();
    error NotCreatorOrOwner();
    error ETHTransferFailed();
    error InsufficientVoteBalance();
    error DeadlineTooSoon();
    error QuorumNotMet(); // SECURITY FIX #15
    error DisputePeriodActive(); // SECURITY FIX #15
    error CannotVoteOwnSubmission();
    /// @dev AUDIT FIX (pass-8): MBB-VOTE-01 — submitter cross-vote ring closed.
    error SubmitterCannotVote();
    error CannotCancelAfterDeadline();
    error CreatorCannotSubmit(); // SECURITY FIX: prevent self-dealing
    error GracePeriodNotExpired(); // SECURITY FIX: grace period for permissionless completion
    error ZeroAddress(); // L-02: constructor validation
    error MaxSubmissionsReached(); // L-05: submission cap
    error AlreadySubmitted(); // AUDIT FIX v3: custom error for duplicate submissions
    /// @dev AUDIT FIX (pass-8): GOV-ECON-01 / C10 — restakingContract is one-shot.
    error RestakingAlreadySet();
    error WinnerExists(); // AUDIT FIX: valid winner exists, use completeBounty instead
    error DeadlineTooFar(); // AUDIT FIX: prevent indefinite ETH locking
    error CreatorCannotVote(); // SECURITY FIX M-11: prevent creator from influencing outcome
    error CannotCancelWithSubmissions(); // SECURITY FIX M-10: prevent cancelling after receiving work
    error InsufficientSubmitBalance(); // A4-M-15: Must hold tokens to submit
    error CancelTooEarly(); // FIX 3: cannot cancel before MIN_CANCEL_DELAY after creation
    error ForceCancelTooEarly(); // FIX 2: force cancel grace period not yet passed
    error NoPendingPayout(); // FIX 1: no pending payout to withdraw
    error EmptyDescription(); // FIX 4: bounty description cannot be empty

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

    /// @notice One-shot wire of the TegridyRestaking contract address.
    /// @dev    AUDIT FIX (pass-8): GOV-ECON-01 / C10. Without this, users who
    ///         restake their staking NFT have `stakingContract.votingPower*`
    ///         return 0 and silently fail MIN_SUBMIT_BALANCE / MIN_VOTE_BALANCE
    ///         gates. Mirrors `setSequencerFeed` one-shot pattern.
    function setRestakingContract(address _restaking) external onlyOwner {
        if (_restaking == address(0)) revert ZeroAddress();
        if (restakingContract != address(0)) revert RestakingAlreadySet();
        restakingContract = _restaking;
        emit RestakingContractSet(_restaking);
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

        // GAS (2026-07-22 repack): narrowing casts into the packed `Bounty`. Each is
        // provably lossless at this call site — `msg.value` is bounded by the ETH
        // supply (≪ uint96), and `_deadline` was just bounded to
        // `block.timestamp + MAX_DEADLINE_DURATION` (≪ uint48, which runs to year
        // ~8.9 million). See the struct NatSpec for the full width analysis.
        bounties.push(Bounty({
            creator: msg.sender,
            description: _description,
            reward: uint96(msg.value),
            deadline: uint48(_deadline),
            winner: address(0),
            status: BountyStatus.Open,
            submissionCount: 0,
            // AUDIT H10 + NEW-I1: fallback to (block.timestamp - 1) when
            // SNAPSHOT_LOOKBACK hasn't elapsed, to avoid the 0-timestamp
            // checkpoint-default trap on test/fork environments. The dead
            // `block.timestamp > 0` guard was removed — always ≥1 in real blocks.
            snapshotTimestamp: uint48(
                block.timestamp >= SNAPSHOT_LOOKBACK ? block.timestamp - SNAPSHOT_LOOKBACK : block.timestamp - 1
            ),
            createdAt: uint48(block.timestamp),
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
        // AUDIT FIX (pass-8): GOV-ECON-01 / C10 — additive read across staking + restaking
        // so a user who restaked their NFT isn't silently denied the submission gate.
        if (
            VotePowerOracle.powerAt(msg.sender, bounty.snapshotTimestamp, address(stakingContract), restakingContract)
                < MIN_SUBMIT_BALANCE
        ) revert InsufficientSubmitBalance();
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
        // AUDIT FIX (pass-8): MBB-VOTE-01 — submitter cross-vote ring. Pre-fix,
        // the rule was "submitter cannot vote on OWN submission" but a submitter
        // COULD vote on a peer's submission. Three colluding submitters
        // (A, B, C) each submit then cross-vote (A→B, B→C, C→B) trivially clear
        // the MIN_UNIQUE_VOTERS=3 quorum gate without any honest voters.
        // Now any voter who has submitted ANY work to the same bounty is
        // disqualified from voting on ANY submission in that bounty.
        if (hasSubmitted[_bountyId][msg.sender]) revert SubmitterCannotVote();
        // SECURITY FIX M-11: Prevent bounty creator from voting to influence outcome.
        // AUDIT R014 (MEDIUM, creator suppression): check against the originalCreator
        // snapshot field — invariant-grade rejection, immune to any future creator
        // mutation. We also keep the live `creator` check for defense-in-depth.
        if (msg.sender == bounties[_bountyId].originalCreator || msg.sender == bounties[_bountyId].creator) revert CreatorCannotVote();
        // AUDIT FIX: DEEP-GOV-01 — min(historical, current) clamp. Closes the snapshot/
        // possession decoupling: a voter who held an NFT at snapshot but transferred
        // most of it post-snapshot (keeping a 1-wei sentinel) cannot apply the full
        // pre-divest aggregate to amplify a confederate's submission.
        // AUDIT FIX (pass-8): GOV-ECON-01 / C10 — both reads are additive across
        // staking + restaking so restakers aren't silently denied voting eligibility.
        uint256 historicalPower = VotePowerOracle.powerAt(
            msg.sender, bounties[_bountyId].snapshotTimestamp, address(stakingContract), restakingContract
        );
        // De-drift 2026-05-31: powerOf was a deprecated alias removed in the H-10
        // refactor; powerOfLiveUnsafe is the identical live read it forwarded to.
        uint256 currentPower = VotePowerOracle.powerOfLiveUnsafe(msg.sender, address(stakingContract), restakingContract);
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
            // AUDIT FIX H-5: during freeze, allow ESTABLISHED challengers to dethrone
            // established leaders. Pre-fix, an attacker who locked in MIN_COMPLETION_VOTES
            // with the cheapest possible sybil ring (3 voter wallets staked at
            // MIN_VOTE_BALANCE each, plus a submitter) had a permanent lock —
            // even a much larger legitimate late-formed coalition could not
            // dethrone. The freeze now blocks only UN-established late-flip snipers
            // (challenger below the completion threshold). Legitimate coalitions of
            // equal-or-greater established weight can still claim the slot —
            // turning the previous asymmetric lock-in into a symmetric arms race
            // bounded by the actual stake distribution.
            //
            // Note: outer `newVotes > topSubmissionVotes` already enforces strict
            // monotonic improvement, so the first established submission still
            // holds the slot against equal-weight ties (fair tie-breaking).
            bool challengerEstablished = newVotes >= MIN_COMPLETION_VOTES;
            if (!inFreeze || !hasEstablishedLeader || challengerEstablished || _submissionId == topSubmissionId[_bountyId]) {
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
    /// @dev    AUDIT FIX (BATCH-F H16): removed `whenNotPaused`. Pre-fix this was
    ///         pause-gated, but creator-side `cancelBounty`/`refundStaleBounty`
    ///         were NOT — meaning a captured-key owner could pause to block the
    ///         winner's settlement while creators (potentially colluding) still
    ///         drained their refundable paths. Pause should freeze creation/entry
    ///         paths (createBounty, submitWork, voteForSubmission — already
    ///         `whenNotPaused`) but NOT the settlement/exit path. OZ Pausable
    ///         best practice: a paused contract should always honor in-progress
    ///         exits to prevent fund-trapping. Pre-existing pendingPayouts
    ///         pull-pattern (M-20/M-06) already handles the failed-receive case;
    ///         winners now have a complete pause-resilient settlement path.
    /// @param _bountyId The bounty ID to complete and pay out
    function completeBounty(uint256 _bountyId) external nonReentrant {
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

        // SECURITY FIX: Use WETHFallbackLib with gas stipend (Solmate/Seaport pattern)
        // instead of full-gas .call{value} which enabled cross-contract reentrancy.
        // AUDIT FIX D-MEME-M1: bumped 10k → 50k matching VoteIncentives.claimBribes
        // (FIX 5.7). 10k was below what a Gnosis Safe (or any minimal smart-contract
        // wallet that runs whenNotPaused/owner reads on receive) costs to credit ETH,
        // so honest contract winners silently fell into the pendingPayouts fallback
        // and had to discover-and-call withdrawPayout out-of-band. nonReentrant on
        // completeBounty makes the larger stipend safe — no cross-contract reentry
        // surface remains even at 50k.
        (bool success,) = winner.call{value: reward, gas: 50000}("");
        if (success) {
            emit BountyCompleted(_bountyId, winner, reward);
        } else {
            // AUDIT FIX M-06: Credit to pendingPayouts instead of rolling back state
            pendingPayouts[winner] += reward;
            // AUDIT FIX (BATCH-L1 M18): record credit timestamp so non-claiming
            // winners' ETH can be swept to feeReceiver after PAYOUT_EXPIRY (1 year),
            // mirroring the existing M-09 refund-expiry pattern.
            // AUDIT FIX FRESH-2026: BB-PAYOUT-TS-RESET [HIGH] — unconditional
            //         overwrite (matches refundTimestamp pattern at lines 695,
            //         734, 755, 787). Pre-fix the timestamp was only set on
            //         FIRST credit so a winner with multiple staggered payouts
            //         had ALL credits (including yesterday's) swept the moment
            //         the oldest one crossed the 365d boundary. The latest-anchor
            //         semantic restarts the sweep window on every new credit,
            //         matching the user's reasonable mental model and the
            //         refund-side convention. A winner can't grief themselves
            //         by self-crediting because completeBounty only credits via
            //         majority-vote completion path (not winner-controlled).
            pendingPayoutTime[winner] = block.timestamp;
            emit PayoutCredited(_bountyId, winner, reward);
        }
    }

    /// @notice AUDIT FIX (BATCH-L1 M18): timestamp of first pendingPayouts credit per address.
    /// Used by `sweepExpiredPayout` to detect 1-year-stale payouts.
    mapping(address => uint256) public pendingPayoutTime;
    uint256 public constant PAYOUT_EXPIRY = 365 days;
    error PayoutNotExpired();
    error NoExpiredPayout();
    event PayoutSweptExpired(address indexed winner, uint256 amount);

    /// @notice Sweep an unclaimed payout that has been pending > PAYOUT_EXPIRY.
    /// @dev    Permissionless trigger; routes to `treasury` (timelocked-rotation
    ///         via TimelockAdmin). Mirrors M-09 sweepExpiredRefund pattern.
    ///         Closes the M18 finding where non-claiming winners' ETH was
    ///         locked forever (e.g., self-destructed contract winners).
    function sweepExpiredPayout(address winner) external nonReentrant {
        uint256 amount = pendingPayouts[winner];
        if (amount == 0) revert NoExpiredPayout();
        uint256 creditedAt = pendingPayoutTime[winner];
        if (creditedAt == 0 || block.timestamp <= creditedAt + PAYOUT_EXPIRY) revert PayoutNotExpired();
        pendingPayouts[winner] = 0;
        pendingPayoutTime[winner] = 0;
        // AUDIT FIX FRESH-2026 (minimal): M-42 / F-80-03 — swap raw 50k call to canonical
        // WETHFallbackLib pattern (already used by withdrawPayout in this file). 30k stipend
        // + WETH-on-fail means a paused/upgraded treasury contract no longer bricks the
        // permissionless 1y-stale sweep.
        WETHFallbackLib.safeTransferETHOrWrap(weth, treasury, amount);
        emit PayoutSweptExpired(winner, amount);
    }

    /// @notice FIX 1: Withdraw pending payout (pull-pattern for winners who cannot receive ETH via push)
    ///         AUDIT FIX M-06: If ETH transfer fails (revert-on-receive), wraps as WETH and sends WETH instead
    function withdrawPayout() external nonReentrant {
        uint256 amount = pendingPayouts[msg.sender];
        if (amount == 0) revert NoPendingPayout();
        pendingPayouts[msg.sender] = 0;
        // AUDIT FIX (BATCH-L1 M18): clear timestamp on successful withdraw.
        pendingPayoutTime[msg.sender] = 0;
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

    /// @notice AUDIT FIX 2026-06-01 M19-CLUSTER: override `acceptOwnership` so any
    ///         pending global-timelock proposal seeded by the OUTGOING owner
    ///         (treasury change, min-reward change) is CANCELLED atomically when the
    ///         new owner accepts. Without it, a compromised/outgoing owner could
    ///         queue a hostile `proposeTreasuryChange` / `proposeMinBountyReward`
    ///         just before `transferOwnership`; the `_executeAfter` timer keeps
    ///         running and the new owner inherits an executable booby-trap. Mirrors
    ///         the canonical pattern on ReferralSplitter / RevenueDistributor.
    /// @dev    `super.acceptOwnership()` first (Ownable2Step promotion), then guard
    ///         each `_cancel` on non-zero `_executeAfter` (`_cancel` reverts on
    ///         no-pending). MIN_REWARD_CHANGE has no dedicated `cancelX()` on this
    ///         contract, but a pending min-reward proposal is exactly the M19 risk,
    ///         so it is flushed here (clear `pendingMinBountyReward` + `_cancel`).
    function acceptOwnership() public override {
        super.acceptOwnership();
        if (_executeAfter[TREASURY_CHANGE] != 0) {
            address cancelled = pendingTreasury;
            _cancel(TREASURY_CHANGE);
            pendingTreasury = address(0);
            emit TreasuryChangeCancelled(cancelled);
        }
        if (_executeAfter[MIN_REWARD_CHANGE] != 0) {
            _cancel(MIN_REWARD_CHANGE);
            pendingMinBountyReward = 0;
        }
    }
}
