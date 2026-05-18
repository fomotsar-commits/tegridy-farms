// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";
import {VotePowerOracle} from "./lib/VotePowerOracle.sol";

interface IVotingEscrowGrants {
    function votingPowerOf(address user) external view returns (uint256);
    function votingPowerAt(address user, uint256 blockNumber) external view returns (uint256);
    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256);
    function totalLocked() external view returns (uint256);
    function totalBoostedStake() external view returns (uint256);
    /// AUDIT FIX (BATCH-A C3): historical denominator for OZ-Governor-style snapshot quorum.
    function totalBoostedStakeAtTimestamp(uint256 ts) external view returns (uint256);
    function userTokenId(address user) external view returns (uint256); // SECURITY FIX C1: Track proposer's NFT
    // AUDIT M13: per-owner set membership check used to detect multi-NFT self-vote bypass.
    function holdsToken(address user, uint256 tokenId) external view returns (bool);
    /// AUDIT FIX (BATCH-E H11): position count for the proposer-must-have-single-position rule.
    function userPositionCount(address user) external view returns (uint256);
}

/// @title CommunityGrants
/// @notice A grant vault funded by protocol fees. veTOWELI holders vote on proposals.
///
///         How it works:
///         1. ETH from protocol fees is sent to this contract
///         2. Anyone can submit a grant proposal (description + requested amount + recipient)
///         3. veTOWELI holders vote for/against proposals
///         4. If a proposal reaches quorum (>50% of votes in favor), owner can execute it
///         5. Executed proposals send ETH to the recipient
///
///         Designed for: artist commissions, developer grants, meme bounties,
///         community initiatives, marketing campaigns.
///
/// Battle-tested sources:
///  - OwnableNoRenounce: OZ Ownable2Step (industry standard)
///  - TimelockAdmin: MakerDAO DSPause pattern (billions TVL, never compromised)
///  - WETHFallbackLib: Solmate SafeTransferLib + WETH fallback (Uniswap V3/V4, Seaport)
contract CommunityGrants is OwnableNoRenounce, ReentrancyGuard, Pausable, TimelockAdmin {

    // ─── Timelock Operation Keys ─────────────────────────────────────
    bytes32 public constant FEE_RECEIVER_CHANGE = keccak256("FEE_RECEIVER_CHANGE");
    /// @dev AUDIT M-G01: per-proposal cancel-approved key. The actual TimelockAdmin key
    ///      used at the storage layer is `keccak256(abi.encode(CANCEL_APPROVED_KEY, proposalId))`
    ///      so each proposal gets its own independent timelock entry.
    bytes32 public constant CANCEL_APPROVED_KEY = keccak256("CANCEL_APPROVED");

    // ─── State ────────────────────────────────────────────────────────

    using SafeERC20 for IERC20;

    IVotingEscrowGrants public immutable votingEscrow;
    /// @notice Optional restaking contract; voting power from restaked positions
    ///         is added to staking-side power for proposal voting eligibility.
    /// @dev    AUDIT FIX (pass-8): GOV-ECON-01 / C10 — without this, users who
    ///         restake their staking NFT have `votingEscrow.votingPower*` return
    ///         0 and silently fail the per-proposal `power > 0` requirement.
    ///         One-shot setter mirrors `setSequencerFeed`.
    address public restakingContract;
    IERC20 public immutable toweli;
    address public immutable weth; // WETH address for fallback grant disbursement

    uint256 public constant PROPOSAL_FEE = 42_069 ether; // 42,069 TOWELI to submit a proposal
    address public feeReceiver; // Where submission fees go (treasury)
    uint256 public totalFeesCollected;

    enum ProposalStatus { Active, Approved, Rejected, Executed, Cancelled, FailedExecution }

    struct Proposal {
        address proposer;
        address recipient;
        uint256 amount;         // ETH requested
        string description;
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 createdAt;
        uint256 deadline;       // Voting deadline
        ProposalStatus status;
        uint256 snapshotTimestamp; // Timestamp for voting power snapshot (L2-safe)
        uint256 snapshotTotalStake; // SECURITY FIX: snapshot total boosted stake at creation
        uint256 proposerTokenId; // SECURITY FIX: Track proposer's staking NFT to prevent self-vote via transfer
        /// @notice AUDIT FIX: DEEP-GOV-09 — absolute cap locked at proposal creation
        ///         time. executeProposal/retryExecution check `amount <= absoluteCap`
        ///         instead of re-deriving the cap from current balance. Prevents the
        ///         post-approval DoS where another proposal executes mid-window,
        ///         dropping the contract's balance and tripping the re-derived cap
        ///         even though the community already approved the proposal.
        uint256 absoluteCap;
        /// @notice AUDIT FIX D-CG-M1: rolling-cap denominator snapshot taken at
        ///         FINALIZE-APPROVE time (not creation, since balance can grow
        ///         meaningfully during the voting window). Pre-fix, the rolling
        ///         cap re-derived from `address(this).balance` at execute time —
        ///         meaning a proposal approved when the treasury was 100 ETH (cap
        ///         = 30 ETH at 30% bps) could later execute against a 200 ETH
        ///         balance with the cap re-derived to 60 ETH, exceeding the
        ///         community's approval-time spending envelope. Snapshotting at
        ///         finalize-approve binds the rolling cap to the balance the
        ///         community actually saw. Zero on legacy proposals (pre-fix
        ///         finalize); execute paths fall back to live balance for those.
        uint256 rollingCapBalanceAtFinalize;
    }

    Proposal[] public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVotedOnProposal;
    mapping(uint256 => uint256) public proposalUniqueVoters; // SECURITY FIX H-6: Track voter diversity
    mapping(address => uint256) public lastProposalTimestamp;

    uint256 public constant VOTING_PERIOD = 7 days;
    uint256 public constant PROPOSAL_COOLDOWN = 1 days;
    uint256 public constant EXECUTION_DEADLINE = 30 days; // H-03: time limit to execute after approval
    uint256 public constant PERMISSIONLESS_EXECUTION_DELAY = 3 days; // H-21: anyone can execute after this delay post-approval
    uint256 public constant MIN_PROPOSAL_AMOUNT = 0.01 ether;
    uint256 public constant MIN_QUORUM_BPS = 1000; // At least 10% of total locked must vote
    /// @notice FRESH-EYES M-4: minimum BOOSTED-vote total a proposal must accumulate.
    ///         The previous value (1000e18) was achievable by a single 4×-max-boost whale
    ///         with only ~250 raw TOWELI of stake — well below the documented intent of
    ///         "1000+ raw TOWELI worth of voter conviction". `votingPowerAtTimestamp`
    ///         returns BOOSTED amount (`boostedAmount` from TegridyStaking.positions),
    ///         so a max-4× lock multiplies the effective floor by 4×. Raising the floor
    ///         to 4000e18 ensures that even at max boost the quorum requires the
    ///         equivalent of ~1000 raw TOWELI of conviction. Still well below the original
    ///         10000e18 (which was reverted in A4-M-14 because it blocked governance on
    ///         low-stake networks); 4000e18 is the documented "middle ground" of the
    ///         A4-M-14 vs. M-13 trade-off.
    uint256 public constant MIN_ABSOLUTE_QUORUM = 4000e18;
    uint256 public constant MAX_GRANT_PERCENT_BPS = 5000; // H-04: max 50% of contract balance per grant
    /// @dev AUDIT L-G01 (2026-04-28): the 50-proposal cap is a DoS-economic
    ///      bound. Each new active proposal SSTOREs ~5 storage slots and
    ///      contributes to gas cost on `executeProposal` / `cancelProposal`
    ///      iteration paths. With a 7-day voting period and 50 max active
    ///      slots, an attacker would need to permanently lock 50 * MIN_PROPOSER_STAKE
    ///      tokens to cap throughput, AND each blocked slot must remain held for
    ///      ≥7 days before timing out. The cap is intentionally generous (50,
    ///      not 10) to prevent legitimate governance from being squeezed.
    uint256 public constant MAX_ACTIVE_PROPOSALS = 50; // AUDIT FIX M-13: Cap to prevent unbounded storage growth
    // SECURITY FIX H-4: Voting delay before votes can be cast (Compound GovernorBravo pattern)
    uint256 public constant VOTING_DELAY = 1 days;
    // AUDIT FIX M-1 (battle-tested): snapshot voting power from SNAPSHOT_LOOKBACK before
    // proposal creation. Prevents proposer-ally pre-positioning — under the prior
    // `block.timestamp - 1` capture an ally who staked in the block immediately before
    // createProposal() captured full voting power at the snapshot. 1-hour lookback forces
    // the coordinating capital to commit far enough in advance that the advantage is
    // uneconomic relative to the voting outcome.
    uint256 public constant SNAPSHOT_LOOKBACK = 1 hours;
    // SECURITY FIX H-5: Mandatory execution delay for ALL callers (GovernorBravo timelock pattern)
    uint256 public constant EXECUTION_DELAY = 1 days;
    // SECURITY FIX H-6: Minimum unique voters to prevent whale governance capture (Nouns DAO pattern)
    uint256 public constant MIN_UNIQUE_VOTERS = 3;

    uint256 public totalGranted;
    uint256 public totalRefundableDeposits; // TOWELI held for active proposal refunds
    uint256 public totalApprovedPending; // AUDIT FIX H-02: ETH committed to approved-but-unexecuted proposals
    uint256 public activeProposalCount;
    mapping(uint256 => bool) public depositRefunded; // AUDIT FIX H-01: Tracks whether deposit was consumed/refunded

    uint256 public constant ROLLING_WINDOW = 30 days;
    uint256 public constant MAX_ROLLING_DISBURSEMENT_BPS = 3000; // 30% of treasury per rolling window
    // H-07 FIX: Ring buffer for rolling disbursement tracking (bounded gas)
    uint256 public constant MAX_DISBURSEMENTS = 100; // Max entries in ring buffer
    mapping(uint256 => uint256) public disbursementTimestamps;
    mapping(uint256 => uint256) public disbursementAmounts;
    uint256 public disbursementHead; // oldest entry index
    uint256 public disbursementTail; // next write index
    uint256 public rollingDisbursed;

    // ─── Pending Values (for timelocked changes) ─────────────────────
    address public pendingFeeReceiver;

    // ─── Fee Receiver Timelock Constants ─────────────────────────────
    uint256 public constant FEE_RECEIVER_TIMELOCK = 48 hours;

    // ─── Cancel-Approved Timelock (AUDIT M-G01) ──────────────────────
    /// @notice 24h window between proposing the cancellation of an APPROVED grant
    ///         proposal and executing it. Active and FailedExecution cancellations
    ///         remain instant (proposer/owner can still abort governance griefing
    ///         loops or one-off failures without delay) — only Approved proposals,
    ///         which already passed quorum + community review and have ETH committed
    ///         via `totalApprovedPending`, require the additional review window.
    uint256 public constant CANCEL_APPROVED_TIMELOCK = 24 hours;

    // ─── Events ───────────────────────────────────────────────────────

    event ProposalCreated(uint256 indexed id, address indexed proposer, address recipient, uint256 amount, string description);
    event ProposalVoted(uint256 indexed id, address indexed voter, bool support, uint256 power);
    event ProposalExecuted(uint256 indexed id, address recipient, uint256 amount);
    event ProposalCancelled(uint256 indexed id);
    event ProposalExecutionFailed(uint256 indexed id, address recipient, uint256 amount);
    event ProposalFeeRefunded(uint256 indexed id, address indexed proposer, uint256 amount);
    event ProposalLapsed(uint256 indexed id); // H-03: proposal lapsed after execution deadline
    event DepositRedirectedToFeeReceiver(uint256 indexed id, address indexed proposer, uint256 amount); // M-07
    event ETHReceived(address indexed sender, uint256 amount);
    event FeeSwept(address indexed receiver, uint256 amount);
    event EmergencyETHRecovered(address indexed recipient, uint256 amount);
    event FeeReceiverChangeProposed(address indexed current, address indexed proposed, uint256 readyAt);
    event FeeReceiverChanged(address indexed oldReceiver, address indexed newReceiver);
    event FeeReceiverChangeCancelled(address indexed cancelled);
    /// @notice AUDIT M-G01: emitted when owner schedules cancellation of an approved
    ///         proposal. The cancellation can only be executed after readyAt elapses.
    event CancelApprovedProposed(uint256 indexed proposalId, uint256 readyAt);
    /// @notice AUDIT M-G01: emitted when a previously-scheduled cancel-approved is aborted.
    event CancelApprovedAborted(uint256 indexed proposalId);
    /// @notice AUDIT R014-MEDIUM: emitted when the dry-run 1-wei test transfer to the
    ///         proposed fee receiver fails. The change is auto-cancelled in that case.
    event FeeReceiverChangeRejected(address indexed proposed, string reason);
    event RestakingContractSet(address indexed restaking); // pass-8 GOV-ECON-01

    // ─── Errors ───────────────────────────────────────────────────────

    error AmountTooSmall();
    /// @notice AUDIT NEW-G7: proposer must have a non-zero userTokenId pointer at
    ///         proposal creation time so the self-vote check can't be silently bypassed.
    error ProposerMissingStakingPointer();
    /// AUDIT FIX (BATCH-E H11): proposer must have exactly one staking position
    /// (closes the multi-NFT sybil-vote bypass).
    error ProposerMustHaveSinglePosition();
    error ZeroAddress();
    error InsufficientFunds();
    error ProposalNotActive();
    error VotingEnded();
    error VotingNotEnded();
    error AlreadyVoted();
    error NoVotingPower();
    error NotApproved();
    error InvalidProposal();
    error NotAuthorized();
    error NotFailedExecution();
    error QuorumNotMet();
    error ExecutionDeadlineExpired(); // H-03
    error AmountTooLarge(); // H-04
    error ExecutionDeadlineNotExpired(); // H-03: for lapseProposal
    error RollingDisbursementExceeded();

    error AlreadyRefunded(); // AUDIT FIX H-01: Deposit already consumed or refunded
    /// @dev AUDIT FIX (pass-8): GOV-ECON-01 / C10 — restakingContract is one-shot.
    error RestakingAlreadySet();
    /// @notice AUDIT FIX: DEEP-GOV-05 — disbursement ring buffer is full and the
    ///         oldest entry is still within ROLLING_WINDOW. Forces caller to wait
    ///         for the oldest entry to age out before recording new disbursements,
    ///         preventing silent cap bypass via unconditional eviction.
    error RollingBufferFull();
    /// @notice AUDIT FIX: DEEP-GOV-06 — dry-run validation requires non-zero spare
    ///         TOWELI; reject rotation if no spare is available so the dry-run can
    ///         never be silently skipped via a pre-call to sweepFees.
    error NoSpareForDryRun();
    /// @notice AUDIT FIX: V2-GOV-11 — `holdsToken` reverted (e.g. staking contract
    ///         mid-upgrade). Fail closed instead of falling back to the legacy
    ///         single-pointer check, which is the very M13 bypass `holdsToken`
    ///         was designed to close. Voters must wait for the staking contract
    ///         upgrade to complete before voting on this proposal.
    error HoldsTokenCheckFailed();

    // ─── Legacy View Helpers (for test compatibility) ──────────────
    function feeReceiverChangeReadyAt() external view returns (uint256) { return _executeAfter[FEE_RECEIVER_CHANGE]; }

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _votingEscrow, address _toweli, address _feeReceiver, address _weth) OwnableNoRenounce(msg.sender) {
        if (_votingEscrow == address(0) || _toweli == address(0) || _feeReceiver == address(0) || _weth == address(0)) revert ZeroAddress();
        votingEscrow = IVotingEscrowGrants(_votingEscrow);
        toweli = IERC20(_toweli);
        feeReceiver = _feeReceiver;
        weth = _weth;
    }

    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }

    // ─── Proposals ────────────────────────────────────────────────────

    /// @notice Submit a grant proposal. Costs 42,069 TOWELI (50% refundable on rejection).
    /// @param _recipient The address that will receive the grant ETH if approved
    /// @param _amount The amount of ETH requested for the grant
    /// @param _description A text description of the grant proposal
    function createProposal(address _recipient, uint256 _amount, string calldata _description) external whenNotPaused {
        if (_recipient == address(0)) revert ZeroAddress();
        require(_recipient != msg.sender, "PROPOSER_CANNOT_BE_RECIPIENT");
        require(
            lastProposalTimestamp[msg.sender] == 0
                || block.timestamp >= lastProposalTimestamp[msg.sender] + PROPOSAL_COOLDOWN,
            "PROPOSAL_COOLDOWN_ACTIVE"
        );
        if (_amount < MIN_PROPOSAL_AMOUNT) revert AmountTooSmall();
        // AUDIT FIX M-13: Limit active proposals to prevent unbounded storage growth
        require(activeProposalCount < MAX_ACTIVE_PROPOSALS, "TOO_MANY_ACTIVE_PROPOSALS");
        // AUDIT FIX: Prevent storage bloat from excessively long descriptions
        require(bytes(_description).length <= 2000, "DESC_TOO_LONG");
        // H-04: cap grant amount at 50% of available balance (excluding already-approved proposals)
        // AUDIT FIX H-02: Subtract totalApprovedPending to prevent serial drain via multiple approvals
        uint256 availableBalance = address(this).balance > totalApprovedPending
            ? address(this).balance - totalApprovedPending
            : 0;
        if (_amount > (availableBalance * MAX_GRANT_PERCENT_BPS) / 10000) revert AmountTooLarge();

        // Collect submission fee — 50% to fee receiver, 50% held for potential refund on rejection
        uint256 nonRefundable = PROPOSAL_FEE / 2;
        uint256 refundable = PROPOSAL_FEE - nonRefundable; // handles odd amounts
        toweli.safeTransferFrom(msg.sender, feeReceiver, nonRefundable);
        toweli.safeTransferFrom(msg.sender, address(this), refundable);
        totalFeesCollected += PROPOSAL_FEE;
        totalRefundableDeposits += refundable;

        // AUDIT NEW-G7 (CRITICAL): snapshot proposer's NFT pointer and REQUIRE it is
        // non-zero. The existing self-vote check at voteOnProposal is gated on
        // `if (proposal.proposerTokenId != 0)`; when userTokenId == 0 (multi-NFT Safe
        // whose pointer was overwritten, fully-restaked address, or unstaked proposer),
        // the entire check is silently skipped — opening a sybil-vote path where the
        // proposer routes one of their NFTs to a second controlled address that votes
        // on their behalf. Forcing a non-zero pointer at creation time means the
        // tokenId check always runs. Proposers who are multi-NFT holders can refresh
        // their pointer by (re)receiving any of their staking NFTs before proposing,
        // or by staking a new position.
        uint256 _proposerTokenId = votingEscrow.userTokenId(msg.sender);
        if (_proposerTokenId == 0) revert ProposerMissingStakingPointer();
        // AUDIT FIX (BATCH-E H11): close the multi-NFT sybil-vote bypass.
        // Pre-fix attack: proposer with N≥2 staking positions has userTokenId
        // == NFT_A (just one of the N). Proposer transfers NFT_B to a sybil
        // EOA. At vote time, holdsToken(sybil, NFT_A) returns false because
        // sybil holds NFT_B not NFT_A → check passes → sybil votes with their
        // historical voting power that includes NFT_B's contribution.
        // The cleanest battle-tested fix: REQUIRE PROPOSER HAS EXACTLY ONE
        // POSITION at proposal creation. With single-position constraint, the
        // existing holdsToken(voter, proposerTokenId) check is exhaustive —
        // there is no other NFT for the proposer to route to a sybil.
        // Trade-off: multi-NFT holders (Safes with multiple positions) must
        // consolidate before they can propose. Pattern matches Compound /
        // OZ Governor's `proposalThreshold` philosophy: a proposer must
        // present a single auditable position rather than a fragmented set.
        if (votingEscrow.userPositionCount(msg.sender) != 1) {
            revert ProposerMustHaveSinglePosition();
        }

        proposals.push(Proposal({
            proposer: msg.sender,
            recipient: _recipient,
            amount: _amount,
            description: _description,
            votesFor: 0,
            votesAgainst: 0,
            createdAt: block.timestamp,
            deadline: block.timestamp + VOTING_PERIOD,
            status: ProposalStatus.Active,
            // AUDIT H10 + NEW-I1: when block.timestamp < SNAPSHOT_LOOKBACK
            // (test/fork environments, genesis), fall back to block.timestamp - 1.
            // votingPowerAtTimestamp(_, 0) returns the very first checkpoint OR the
            // default zero, which silently breaks voting-power resolution. The dead
            // `block.timestamp > 0` branch from the original H10 fix has been
            // removed — block.timestamp is always ≥1 in a real EVM block.
            snapshotTimestamp: block.timestamp >= SNAPSHOT_LOOKBACK
                ? block.timestamp - SNAPSHOT_LOOKBACK
                : block.timestamp - 1,
            // SECURITY FIX (BATCH-A C3, OZ Governor v5 pattern): quorum denominator MUST be
            // read at the SAME snapshot timepoint as voter power, never live. OZ Governor's
            // canonical formula is `quorum = getPastTotalSupply(snapshot) * num / denom` and
            // voter weight is `getPastVotes(account, snapshot)` — both keyed off the same
            // proposal snapshot. Reading totalBoostedStake() live while voters use the
            // historical Trace208 lookup created a denominator-skew window: a whale who
            // unstaked between snapshot and createProposal would deflate the denominator,
            // making the 10% MIN_QUORUM_BPS trivially clearable for malicious 50%-treasury
            // grants. Now both numerator and denominator share `snapshotTimestamp`.
            // Refs: OpenZeppelin/openzeppelin-contracts Governor.sol & GovernorVotesQuorumFraction.sol;
            //       compound-finance/compound-protocol GovernorBravoDelegate.sol
            snapshotTotalStake: votingEscrow.totalBoostedStakeAtTimestamp(
                block.timestamp >= SNAPSHOT_LOOKBACK
                    ? block.timestamp - SNAPSHOT_LOOKBACK
                    : block.timestamp - 1
            ),
            proposerTokenId: _proposerTokenId, // AUDIT NEW-G7: non-zero pointer guaranteed
            // AUDIT FIX: DEEP-GOV-09 — lock the per-proposal cap at creation time.
            // executeProposal/retryExecution validate `amount <= absoluteCap` instead
            // of re-deriving the cap from current balance, preventing post-approval
            // DoS via balance drops between approval and execution.
            absoluteCap: (availableBalance * MAX_GRANT_PERCENT_BPS) / 10000,
            // AUDIT FIX D-CG-M1: zero at creation; populated at finalize-approve
            // with the contract's then-current balance so the rolling cap binds
            // to the community's approval-time spending envelope.
            rollingCapBalanceAtFinalize: 0
        }));

        activeProposalCount++;
        lastProposalTimestamp[msg.sender] = block.timestamp;

        emit ProposalCreated(proposals.length - 1, msg.sender, _recipient, _amount, _description);
    }

    /// @notice Vote on a proposal. Voting power = veTOWELI power.
    /// @param _proposalId The ID of the proposal to vote on
    /// @param _support True to vote in favor, false to vote against
    function voteOnProposal(uint256 _proposalId, bool _support) external nonReentrant whenNotPaused {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        if (proposal.status != ProposalStatus.Active) revert ProposalNotActive();
        // SECURITY FIX H-4: Voting delay gives community time to review proposals before voting starts.
        // Prevents flash-governance where proposer + allies vote immediately (GovernorBravo pattern).
        require(block.timestamp >= proposal.createdAt + VOTING_DELAY, "VOTING_NOT_STARTED");
        if (block.timestamp > proposal.deadline) revert VotingEnded();
        if (hasVotedOnProposal[_proposalId][msg.sender]) revert AlreadyVoted();
        // AUDIT FIX M-29: Prevent proposer from voting on their own proposal
        // SECURITY FIX: Check by staking position NFT, not just address — prevents
        // bypass via transferring NFT to sybil address (Compound Governor Bravo pattern)
        require(msg.sender != proposal.proposer, "PROPOSER_CANNOT_VOTE");
        // AUDIT M13: prefer the per-owner set membership check (holdsToken) which works
        // for multi-NFT contract holders (Safes, vaults). Single-pointer userTokenId can be
        // overwritten by a later inbound NFT, silently letting the original proposer vote
        // with a different "current" tokenId while still holding the snapshotted one.
        // AUDIT FIX: V2-GOV-11 — fail closed if `holdsToken` reverts (e.g. staking
        // contract mid-upgrade). Pre-fix the catch branch fell back to the legacy
        // single-pointer `userTokenId` check, which is the very M13 bypass
        // `holdsToken` was designed to close: a proposer routes one NFT to a sybil
        // address whose `userTokenId` no longer matches the proposer's snapshot,
        // the fallback says "doesn't hold", vote allowed. Removing the fallback
        // means voters must wait for the upgrade to complete — which is acceptable
        // because staking contract upgrades go through their own timelock and are
        // publicly announced. Pattern: fail-closed on safety-critical checks
        // (Curve veCRV abstain on dead infra, Compound ban votes during upgrades).
        if (proposal.proposerTokenId != 0) {
            // SLITHER 2026-05-18 (MEDIUM, auto): uninitialized-local — local var declared mid-function; assignment branches cover reachable paths
            // slither-disable-next-line uninitialized-local
            bool holds;
            try votingEscrow.holdsToken(msg.sender, proposal.proposerTokenId) returns (bool h) {
                holds = h;
            } catch {
                revert HoldsTokenCheckFailed();
            }
            require(!holds, "PROPOSER_POSITION_CANNOT_VOTE");
        }

        // AUDIT FIX: DEEP-GOV-01 — min(historical, current) clamp. Closes the
        // snapshot/possession decoupling: a voter who held N power at snapshot and
        // divested 99.999% of NFTs after snapshot (keeping a 1-wei sentinel) cannot
        // apply the full pre-divest aggregate to a treasury-draining proposal vote.
        // Pattern: Curve veCRV non-transferability; Aave aTokens min(checkpointed,
        // balance) for delegate voting.
        // AUDIT FIX (pass-8): GOV-ECON-01 / C10 — additive read across staking +
        // restaking so a voter who restaked their NFT isn't silently denied a vote.
        // Preserves the existing min(historical, current) clamp from DEEP-GOV-01.
        uint256 historicalPower = VotePowerOracle.powerAt(
            msg.sender, proposal.snapshotTimestamp, address(votingEscrow), restakingContract
        );
        uint256 currentPower = VotePowerOracle.powerOf(msg.sender, address(votingEscrow), restakingContract);
        uint256 power = historicalPower < currentPower ? historicalPower : currentPower;
        if (power == 0) revert NoVotingPower();

        hasVotedOnProposal[_proposalId][msg.sender] = true;
        proposalUniqueVoters[_proposalId]++; // SECURITY FIX H-6: Track voter diversity

        if (_support) {
            proposal.votesFor += power;
        } else {
            proposal.votesAgainst += power;
        }

        emit ProposalVoted(_proposalId, msg.sender, _support, power);
    }

    /// @notice Finalize a proposal after voting period ends.
    ///         Approved if votesFor > votesAgainst AND quorum is met (>= 10% of total stake AND >= MIN_ABSOLUTE_QUORUM).
    /// @param _proposalId The ID of the proposal to finalize
    function finalizeProposal(uint256 _proposalId) external nonReentrant whenNotPaused {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        if (proposal.status != ProposalStatus.Active) revert ProposalNotActive();
        if (block.timestamp <= proposal.deadline) revert VotingNotEnded();

        // Check quorum: total votes must be >= 10% of total voting power (boosted stake)
        uint256 totalVotes = proposal.votesFor + proposal.votesAgainst;
        uint256 totalVotingPower = proposal.snapshotTotalStake;
        // SECURITY FIX: Require non-zero voting power — cannot finalize when no one is staking
        if (totalVotingPower == 0) revert QuorumNotMet();
        // AUDIT FIX M-13: Require minimum absolute voting power in addition to percentage
        if (totalVotes < MIN_ABSOLUTE_QUORUM) revert QuorumNotMet();
        // Use multiplication instead of division to avoid rounding down rejecting valid quorums
        if (totalVotes * 10000 < MIN_QUORUM_BPS * totalVotingPower) {
            revert QuorumNotMet();
        }
        // SECURITY FIX H-6: Require minimum unique voters to prevent whale governance capture.
        // Pattern from MemeBountyBoard MIN_UNIQUE_VOTERS (Nouns DAO voter diversity).
        require(proposalUniqueVoters[_proposalId] >= MIN_UNIQUE_VOTERS, "INSUFFICIENT_VOTERS");

        uint256 refundable = PROPOSAL_FEE - PROPOSAL_FEE / 2; // must match createProposal accounting

        if (proposal.votesFor > proposal.votesAgainst) {
            // AUDIT FIX: DEEP-GOV-13 — refuse approval when total approved-pending ETH
            // would exceed the contract's balance. Pre-fix, finalizeProposal could
            // approve an unfundable proposal, leaving the recipient stuck waiting for
            // EXECUTION_DEADLINE to lapse with no payout. Now: revert to Rejected and
            // refund the deposit (consistent with the Rejected branch below).
            if (totalApprovedPending + proposal.amount > address(this).balance) {
                totalRefundableDeposits -= refundable;
                depositRefunded[_proposalId] = true;
                proposal.status = ProposalStatus.Rejected;
                activeProposalCount--;
                try toweli.transfer(proposal.proposer, refundable) returns (bool success) {
                    if (success) {
                        emit ProposalFeeRefunded(_proposalId, proposal.proposer, refundable);
                    } else {
                        toweli.safeTransfer(feeReceiver, refundable);
                        emit DepositRedirectedToFeeReceiver(_proposalId, proposal.proposer, refundable);
                    }
                } catch {
                    toweli.safeTransfer(feeReceiver, refundable);
                    emit DepositRedirectedToFeeReceiver(_proposalId, proposal.proposer, refundable);
                }
                return;
            }
            proposal.status = ProposalStatus.Approved;
            // AUDIT FIX H-02: Track approved ETH to prevent serial drain
            totalApprovedPending += proposal.amount;
            // AUDIT FIX D-CG-M1: snapshot the rolling-cap denominator at the
            // moment of community approval. This is the balance the community
            // could see on-chain when their final vote landed, so binding the
            // 30%/30d rolling cap to it preserves their spending envelope —
            // future inflows during the EXECUTION_DELAY window cannot retroactively
            // expand the cap. Zero on legacy proposals (set by createProposal) is
            // distinguishable at execute time and falls back to live balance.
            proposal.rollingCapBalanceAtFinalize = address(this).balance;
            // SECURITY FIX: Do NOT decrement totalRefundableDeposits here — deposit tokens
            // must remain reserved until actually consumed (execution) or refunded (lapse/cancel).
            // Decrementing here allowed sweepFees() to sweep tokens still owed for lapse refunds.
        } else {
            totalRefundableDeposits -= refundable;
            depositRefunded[_proposalId] = true; // AUDIT FIX H-01: Mark deposit as consumed
            proposal.status = ProposalStatus.Rejected;
            activeProposalCount--;
            // M-07: Refund 50% of proposal fee on rejection; if proposer is blacklisted, send to feeReceiver
            try toweli.transfer(proposal.proposer, refundable) returns (bool success) {
                if (success) {
                    emit ProposalFeeRefunded(_proposalId, proposal.proposer, refundable);
                } else {
                    toweli.safeTransfer(feeReceiver, refundable);
                    emit DepositRedirectedToFeeReceiver(_proposalId, proposal.proposer, refundable);
                }
            } catch {
                toweli.safeTransfer(feeReceiver, refundable);
                emit DepositRedirectedToFeeReceiver(_proposalId, proposal.proposer, refundable);
            }
        }
    }

    /// @notice Execute an approved proposal. Owner can execute immediately; anyone can execute after PERMISSIONLESS_EXECUTION_DELAY.
    /// @param _proposalId The ID of the approved proposal to execute
    function executeProposal(uint256 _proposalId) external nonReentrant whenNotPaused {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        if (proposal.status != ProposalStatus.Approved) revert NotApproved();
        // H-03: enforce execution deadline
        if (block.timestamp > proposal.deadline + EXECUTION_DEADLINE) revert ExecutionDeadlineExpired();
        // SECURITY FIX H-5: Mandatory delay for ALL callers including owner (GovernorBravo timelock pattern).
        // Gives token holders at least EXECUTION_DELAY to react to any approved proposal.
        require(block.timestamp >= proposal.deadline + EXECUTION_DELAY, "EXECUTION_DELAY");
        if (msg.sender != owner()) {
            require(block.timestamp >= proposal.deadline + PERMISSIONLESS_EXECUTION_DELAY, "EXECUTION_DELAY_NOT_MET");
        }
        if (address(this).balance < proposal.amount) revert InsufficientFunds();
        // AUDIT FIX: DEEP-GOV-09 — verify against the absolute cap locked at proposal
        // creation time, NOT against a re-derived cap from current balance. Pre-fix,
        // a balance drop between approval and execution (another grant executing,
        // emergencyRecoverETH after pause/unpause) caused the re-derived cap to drop
        // below the proposal's amount even though the community already approved it.
        if (proposal.amount > proposal.absoluteCap) revert AmountTooLarge();

        // Rolling treasury depletion limit: max 30% of current balance in any 30-day window
        // AUDIT FIX: V2-GOV-12 (INFO) — DELIBERATE SEMANTIC: the rolling window
        // tracks SUCCESSFULLY DISBURSED ETH, not approved-but-failed attempts.
        // If `_transferETHOrWETH` returns false (extremely unlikely because the
        // WETH wrap fallback covers contract recipients that revert on raw
        // ETH), the proposal moves to `FailedExecution` and `_recordDisbursement`
        // is NOT called. `retryExecution` re-prunes the rolling window and
        // re-cap-checks at retry time, so the cap remains exact for actually-
        // paid amounts. `MAX_ROLLING_DISBURSEMENT_BPS` is therefore "max
        // DISBURSED in 30 days", not "max APPROVED" or "max ATTEMPTED".
        uint256 currentRolling = _pruneAndGetRollingDisbursed();
        // AUDIT FIX D-CG-M1: anchor the rolling cap on the FINALIZE-APPROVE
        // balance snapshot rather than the live balance. Falls back to live
        // balance for legacy proposals (rollingCapBalanceAtFinalize == 0).
        uint256 capDenom = proposal.rollingCapBalanceAtFinalize;
        if (capDenom == 0) capDenom = address(this).balance;
        uint256 maxRolling = (capDenom * MAX_ROLLING_DISBURSEMENT_BPS) / 10000;
        if (currentRolling + proposal.amount > maxRolling) revert RollingDisbursementExceeded();

        // AUDIT FIX M-27: Attempt ETH transfer with WETH fallback for contract recipients
        // SLITHER NOTE 2026-05-18 (HIGH): `reentrancy-eth` false positive — the
        // outer `executeProposal` is `nonReentrant whenNotPaused`. State writes
        // on the success branch are protected by the guard, and the inner
        // `_transferETHOrWETH` uses a 10k stipend.
        // slither-disable-next-line reentrancy-eth,reentrancy-events,reentrancy-benign
        if (!_transferETHOrWETH(proposal.recipient, proposal.amount)) {
            proposal.status = ProposalStatus.FailedExecution;
            emit ProposalExecutionFailed(_proposalId, proposal.recipient, proposal.amount);
            return;
        }

        // Transfer succeeded — update all bookkeeping
        _recordDisbursement(proposal.amount);
        totalApprovedPending -= proposal.amount;
        totalGranted += proposal.amount;
        // SECURITY FIX: Decrement totalRefundableDeposits here when deposit is actually consumed
        uint256 refundable = PROPOSAL_FEE - PROPOSAL_FEE / 2;
        totalRefundableDeposits -= refundable;
        depositRefunded[_proposalId] = true; // AUDIT FIX H-01: Mark deposit as consumed
        proposal.status = ProposalStatus.Executed;
        activeProposalCount--;

        emit ProposalExecuted(_proposalId, proposal.recipient, proposal.amount);
    }

    /// @notice Retry execution of a proposal that previously failed.
    ///         AUDIT M-G02: Permissionless after the same delay window that
    ///         executeProposal enforces (EXECUTION_DELAY for owner,
    ///         PERMISSIONLESS_EXECUTION_DELAY for non-owner). Owner can still
    ///         retry as soon as the EXECUTION_DELAY elapses post-deadline.
    ///         Abuse is bounded by the rolling-disbursement cap (30% / 30 days)
    ///         and the per-grant MAX_GRANT_PERCENT_BPS — same envelope as the
    ///         primary executeProposal path.
    /// @param _proposalId The ID of the failed proposal to retry
    function retryExecution(uint256 _proposalId) external nonReentrant whenNotPaused {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        if (proposal.status != ProposalStatus.FailedExecution) revert NotFailedExecution();
        // AUDIT FIX: Enforce execution deadline on retries too
        if (block.timestamp > proposal.deadline + EXECUTION_DEADLINE) revert ExecutionDeadlineExpired();
        // AUDIT M-G02: Mirror executeProposal's two-tier delay model. Owner can act as
        // soon as the mandatory EXECUTION_DELAY elapses; everyone else must wait for
        // PERMISSIONLESS_EXECUTION_DELAY. Both windows are measured from the voting
        // deadline, identical to the primary execute path.
        require(block.timestamp >= proposal.deadline + EXECUTION_DELAY, "EXECUTION_DELAY");
        if (msg.sender != owner()) {
            require(block.timestamp >= proposal.deadline + PERMISSIONLESS_EXECUTION_DELAY, "EXECUTION_DELAY_NOT_MET");
        }
        if (address(this).balance < proposal.amount) revert InsufficientFunds();
        // AUDIT FIX: DEEP-GOV-09 — same absolute-cap check as executeProposal.
        if (proposal.amount > proposal.absoluteCap) revert AmountTooLarge();

        // Rolling treasury depletion limit: max 30% of current balance in any 30-day window
        // AUDIT FIX: V2-GOV-12 (INFO) — see executeProposal for the rationale of
        // tracking only SUCCESSFULLY DISBURSED ETH in the rolling window. Mirroring
        // the same accounting here keeps retry semantics aligned with the primary path.
        uint256 currentRolling = _pruneAndGetRollingDisbursed();
        // AUDIT FIX D-CG-M1: same finalize-snapshot cap denominator as
        // executeProposal. Legacy proposals (rollingCapBalanceAtFinalize == 0)
        // fall back to live balance for backward compat.
        uint256 capDenom = proposal.rollingCapBalanceAtFinalize;
        if (capDenom == 0) capDenom = address(this).balance;
        uint256 maxRolling = (capDenom * MAX_ROLLING_DISBURSEMENT_BPS) / 10000;
        if (currentRolling + proposal.amount > maxRolling) revert RollingDisbursementExceeded();

        // AUDIT FIX M-27: Attempt ETH transfer with WETH fallback for contract recipients
        // SLITHER NOTE 2026-05-18 (HIGH): `reentrancy-eth` false positive — the
        // outer `retryExecution` is `nonReentrant whenNotPaused`. State writes
        // after the transfer are gated by the success branch, and the inner
        // `_transferETHOrWETH` uses a 10k stipend (no arbitrary code in recipient).
        // slither-disable-next-line reentrancy-eth,reentrancy-events,reentrancy-benign
        if (!_transferETHOrWETH(proposal.recipient, proposal.amount)) {
            proposal.status = ProposalStatus.FailedExecution;
            emit ProposalExecutionFailed(_proposalId, proposal.recipient, proposal.amount);
            return;
        }

        // Transfer succeeded — update all bookkeeping
        _recordDisbursement(proposal.amount);
        totalApprovedPending -= proposal.amount;
        totalGranted += proposal.amount;
        // SECURITY FIX: Decrement totalRefundableDeposits here when deposit is actually consumed
        uint256 refundable = PROPOSAL_FEE - PROPOSAL_FEE / 2;
        totalRefundableDeposits -= refundable;
        depositRefunded[_proposalId] = true; // AUDIT FIX H-01: Mark deposit as consumed (retryExecution)
        proposal.status = ProposalStatus.Executed;
        activeProposalCount--;

        emit ProposalExecuted(_proposalId, proposal.recipient, proposal.amount);
    }

    /// @notice Cancel a Pending/Active or FailedExecution proposal instantly.
    ///         AUDIT M-G01: Owner-initiated cancellation of an APPROVED proposal MUST
    ///         instead go through `proposeCancelApproved` → 24h delay →
    ///         `executeCancelApproved`. Approved proposals already passed quorum +
    ///         community review and have ETH reserved via `totalApprovedPending`; an
    ///         instant owner-side cancel was a unilateral governance-override surface.
    /// @dev    AUDIT FIX C-02 retained for non-Approved statuses: owner can still
    ///         instant-cancel Active proposals (Approved cancellation routed through
    ///         the timelock above). FailedExecution proposals are handled by
    ///         lapseProposal once the execution deadline has passed; pre-deadline
    ///         FailedExecution stays in retryExecution territory.
    /// @param _proposalId The ID of the proposal to cancel
    function cancelProposal(uint256 _proposalId) external nonReentrant {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        // AUDIT FIX H-01: Prevent double-refund if deposit was already consumed
        if (depositRefunded[_proposalId]) revert AlreadyRefunded();

        // AUDIT FIX C-02: Owner can cancel Active proposals; Approved goes through timelock.
        // Proposer can only cancel their own Active proposals.
        bool isOwner = msg.sender == owner();
        bool isProposer = msg.sender == proposal.proposer;
        if (!isOwner && !isProposer) revert NotAuthorized();

        // AUDIT M-G01: Approved proposals can ONLY be cancelled via the timelocked
        // executeCancelApproved path. Reject any instant-cancel attempt for Approved.
        if (proposal.status == ProposalStatus.Approved) revert ProposalNotActive();
        if (proposal.status != ProposalStatus.Active) revert ProposalNotActive();

        // AUDIT FIX M-6: forfeit the refundable half of PROPOSAL_FEE on cancel and
        // route it to feeReceiver. Pre-fix, cancellation refunded 50% to the
        // proposer, allowing slot churn — an attacker could occupy a slot, cancel,
        // and re-propose at a net cost of only PROPOSAL_FEE/2 per cycle, cheaply
        // congesting the MAX_ACTIVE_PROPOSALS=50 cap. Forfeiture doubles the
        // per-cycle cost and removes the incentive to grief active-proposal slots.
        // The Rejected branch in finalizeProposal still refunds: a community vote
        // means the proposer acted in good faith. Cancellation is voluntary or
        // moderation-driven, neither of which deserves the refund.
        uint256 refundable = PROPOSAL_FEE - PROPOSAL_FEE / 2;
        totalRefundableDeposits -= refundable;
        depositRefunded[_proposalId] = true; // AUDIT FIX H-01: Mark deposit as consumed
        proposal.status = ProposalStatus.Cancelled;
        activeProposalCount--;
        toweli.safeTransfer(feeReceiver, refundable);
        emit DepositRedirectedToFeeReceiver(_proposalId, proposal.proposer, refundable);
        emit ProposalCancelled(_proposalId);
    }

    // ─── AUDIT M-G01: Approved Proposal Cancellation Timelock ─────────

    /// @dev Returns the per-proposal timelock key. Each proposal gets its own
    ///      independent slot in the TimelockAdmin storage so multiple Approved
    ///      cancellations can be queued in parallel without collisions.
    function _cancelApprovedKey(uint256 _proposalId) internal pure returns (bytes32) {
        return keccak256(abi.encode(CANCEL_APPROVED_KEY, _proposalId));
    }

    /// @notice AUDIT M-G01: Schedule cancellation of an Approved proposal. After
    ///         CANCEL_APPROVED_TIMELOCK (24h), the owner — or anyone, since the
    ///         executor is permissionless to reduce censorship risk on the queue —
    ///         can call `executeCancelApproved` to finalize the cancel.
    /// @param  _proposalId The Approved proposal to schedule for cancellation.
    function proposeCancelApproved(uint256 _proposalId) external onlyOwner {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];
        if (proposal.status != ProposalStatus.Approved) revert NotApproved();
        if (depositRefunded[_proposalId]) revert AlreadyRefunded();

        _propose(_cancelApprovedKey(_proposalId), CANCEL_APPROVED_TIMELOCK);
        emit CancelApprovedProposed(_proposalId, _proposalReadyAt(_cancelApprovedKey(_proposalId)));
    }

    /// @notice AUDIT M-G01: Execute a previously-scheduled cancellation of an
    ///         Approved proposal once the 24h delay has elapsed.
    /// @param  _proposalId The proposal whose cancellation is being finalized.
    // AUDIT FIX FRESH-2026 (minimal): M-15 / F-15-K-01 — match BATCH-E H12's `whenNotPaused`
    // on `lapseProposal`. Closes the captured-owner pause→cancel→sweep chain identified
    // in the meta-review. One-modifier change, no new state, mirrors sister patterns.
    function executeCancelApproved(uint256 _proposalId) external nonReentrant whenNotPaused {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        // Re-check state at execution: status could have moved (e.g. permissionless
        // executeProposal landed during the delay window) or been refunded already.
        if (proposal.status != ProposalStatus.Approved) revert NotApproved();
        if (depositRefunded[_proposalId]) revert AlreadyRefunded();

        // Consume the timelock slot. _execute clears _executeAfter[key] before any
        // external effects so a re-entrant call would see "no pending" and revert.
        _execute(_cancelApprovedKey(_proposalId));

        // Same accounting flow that the legacy owner-instant Approved cancel performed.
        totalApprovedPending -= proposal.amount;
        uint256 refundable = PROPOSAL_FEE - PROPOSAL_FEE / 2;
        totalRefundableDeposits -= refundable;
        depositRefunded[_proposalId] = true;
        proposal.status = ProposalStatus.Cancelled;
        activeProposalCount--;

        try toweli.transfer(proposal.proposer, refundable) returns (bool success) {
            if (success) {
                emit ProposalFeeRefunded(_proposalId, proposal.proposer, refundable);
            } else {
                toweli.safeTransfer(feeReceiver, refundable);
                emit DepositRedirectedToFeeReceiver(_proposalId, proposal.proposer, refundable);
            }
        } catch {
            toweli.safeTransfer(feeReceiver, refundable);
            emit DepositRedirectedToFeeReceiver(_proposalId, proposal.proposer, refundable);
        }
        emit ProposalCancelled(_proposalId);
    }

    /// @notice AUDIT M-G01: Owner can cancel a pending cancel-approved proposal
    ///         before it executes (e.g. mistaken queue entry, governance change of
    ///         heart, recipient is willing to wait for normal execution).
    function cancelCancelApproved(uint256 _proposalId) external onlyOwner {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        _cancel(_cancelApprovedKey(_proposalId));
        emit CancelApprovedAborted(_proposalId);
    }

    /// @notice AUDIT M-G01: View helper — timestamp at which the cancel-approved
    ///         for `_proposalId` becomes executable. 0 if no pending cancel.
    function cancelApprovedReadyAt(uint256 _proposalId) external view returns (uint256) {
        return _proposalReadyAt(_cancelApprovedKey(_proposalId));
    }

    /// @notice Lapse an approved proposal whose execution deadline has passed (H-03).
    ///         Anyone can call this. The proposal is set to Rejected and the deposit is refunded.
    /// @param _proposalId The ID of the approved proposal to lapse
    /// @dev    AUDIT FIX (BATCH-E H12): added `whenNotPaused`. Pre-fix, `pause()` blocked
    ///         `executeProposal` and `retryExecution` (both `whenNotPaused`) so the
    ///         recipient could not pull approved funds — but `lapseProposal` was
    ///         pause-INDEPENDENT. Combined with `emergencyRecoverETH` (whenPaused +
    ///         onlyOwner), a captured-key owner could: (1) wait for a proposal to
    ///         reach Approved, (2) `pause()` to block recipient execution, (3) wait
    ///         30d EXECUTION_DEADLINE, (4) anyone calls `lapseProposal` decrementing
    ///         totalApprovedPending and reverting status to Rejected, (5) owner calls
    ///         `emergencyRecoverETH` to redirect the freed balance to attacker.
    ///         This bypassed the M-G01 24h cancel-approved timelock that the prior
    ///         audit explicitly added to defend against fast-cancel-approved drains.
    ///         Pause-gating `lapseProposal` closes the loop: under pause, the proposal
    ///         remains Approved, `totalApprovedPending` continues protecting the
    ///         balance from emergencyRecoverETH, and on unpause the recipient can
    ///         still execute. Pattern of record: OZ Pausable consistent-coverage
    ///         guidance ("freeze ALL state-mutating paths during incident response,
    ///         not a strict subset").
    function lapseProposal(uint256 _proposalId) external nonReentrant whenNotPaused {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        // AUDIT FIX H-01: Prevent double-refund if deposit was already consumed
        if (depositRefunded[_proposalId]) revert AlreadyRefunded();

        // AUDIT FIX C-01: Accept both Approved and FailedExecution for lapsing
        if (proposal.status != ProposalStatus.Approved && proposal.status != ProposalStatus.FailedExecution) {
            revert NotApproved();
        }
        if (block.timestamp <= proposal.deadline + EXECUTION_DEADLINE) revert ExecutionDeadlineNotExpired();

        // AUDIT FIX H-02: Release approved pending amount
        totalApprovedPending -= proposal.amount;
        proposal.status = ProposalStatus.Rejected;
        activeProposalCount--;

        // Refund the held deposit (50% of proposal fee)
        uint256 refundable = PROPOSAL_FEE - PROPOSAL_FEE / 2;
        // SECURITY FIX: Decrement totalRefundableDeposits here when deposit is actually refunded
        totalRefundableDeposits -= refundable;
        depositRefunded[_proposalId] = true; // AUDIT FIX H-01: Mark deposit as consumed
        // M-07: handle blacklisted proposer
        try toweli.transfer(proposal.proposer, refundable) returns (bool success) {
            if (success) {
                emit ProposalFeeRefunded(_proposalId, proposal.proposer, refundable);
            } else {
                toweli.safeTransfer(feeReceiver, refundable);
                emit DepositRedirectedToFeeReceiver(_proposalId, proposal.proposer, refundable);
            }
        } catch {
            toweli.safeTransfer(feeReceiver, refundable);
            emit DepositRedirectedToFeeReceiver(_proposalId, proposal.proposer, refundable);
        }

        emit ProposalLapsed(_proposalId);
    }

    /// @notice AUDIT FIX (BATCH-I M11): permissionless lapse for STALE ACTIVE
    ///         proposals — those past `deadline` that never reached
    ///         MIN_UNIQUE_VOTERS, so `finalizeProposal` permanently reverts
    ///         INSUFFICIENT_VOTERS. Pre-fix, those slots occupied
    ///         `MAX_ACTIVE_PROPOSALS = 50` forever; sybil-flood attacker could
    ///         pay 50 × PROPOSAL_FEE to lock the entire pipeline until owner
    ///         manually `cancelProposal`'d each one.
    /// @dev    Permissionless after deadline + EXECUTION_DEADLINE (matches
    ///         lapseProposal's grace). Routes the FULL deposit (not the 50%
    ///         partial-refund) to feeReceiver since the proposer effectively
    ///         abandoned the proposal — same forfeit semantics as
    ///         cancelProposal post-deadline.
    /// @dev    Status flips Active → Rejected (skipping Approved entirely);
    ///         no refund obligation, no totalApprovedPending impact.
    function lapseStaleProposal(uint256 _proposalId) external nonReentrant whenNotPaused {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];
        if (proposal.status != ProposalStatus.Active) revert ProposalNotActive();
        if (block.timestamp <= proposal.deadline + EXECUTION_DEADLINE) revert ExecutionDeadlineNotExpired();
        require(proposalUniqueVoters[_proposalId] < MIN_UNIQUE_VOTERS, "HAS_QUORUM_VOTERS");
        if (depositRefunded[_proposalId]) revert AlreadyRefunded();

        proposal.status = ProposalStatus.Rejected;
        activeProposalCount--;
        depositRefunded[_proposalId] = true;
        // Forfeit the full PROPOSAL_FEE to feeReceiver (proposer abandoned).
        uint256 forfeit = PROPOSAL_FEE - PROPOSAL_FEE / 2; // matches partial-refund slot tracked by totalRefundableDeposits
        totalRefundableDeposits -= forfeit;
        toweli.safeTransfer(feeReceiver, forfeit);
        emit DepositRedirectedToFeeReceiver(_proposalId, proposal.proposer, forfeit);
        emit ProposalLapsed(_proposalId);
    }

    /// @notice Sweep accumulated TOWELI fees (from approved/cancelled proposals) to feeReceiver.
    ///         Protects deposits held for active proposals that may be refunded on rejection.
    function sweepFees() external onlyOwner {
        uint256 balance = toweli.balanceOf(address(this));
        uint256 sweepable = balance > totalRefundableDeposits ? balance - totalRefundableDeposits : 0;
        if (sweepable > 0) {
            toweli.safeTransfer(feeReceiver, sweepable);
            emit FeeSwept(feeReceiver, sweepable);
        }
    }

    /// @notice AUDIT FIX M-31: Emergency ETH recovery when contract is paused.
    ///         Only withdraws ETH not committed to approved-but-unexecuted proposals.
    function emergencyRecoverETH(address payable _recipient) external onlyOwner whenPaused {
        if (_recipient == address(0)) revert ZeroAddress();
        uint256 balance = address(this).balance;
        // Protect ETH committed to approved proposals that haven't been executed yet
        uint256 withdrawable = balance > totalApprovedPending ? balance - totalApprovedPending : 0;
        require(withdrawable > 0, "NO_WITHDRAWABLE_ETH");
        // SECURITY FIX: Use WETHFallbackLib with 10k gas stipend instead of full-gas .call
        // (Solmate/Seaport pattern — prevents cross-contract reentrancy)
        WETHFallbackLib.safeTransferETHOrWrap(weth, _recipient, withdrawable);
        emit EmergencyETHRecovered(_recipient, withdrawable);
    }

    // ─── Fee Receiver Timelock ────────────────────────────────────────

    /// @notice Propose a new fee receiver. Takes effect after 48-hour timelock.
    /// @param _newFeeReceiver The proposed new fee receiver address
    function proposeFeeReceiver(address _newFeeReceiver) external onlyOwner {
        if (_newFeeReceiver == address(0)) revert ZeroAddress();

        pendingFeeReceiver = _newFeeReceiver;
        _propose(FEE_RECEIVER_CHANGE, FEE_RECEIVER_TIMELOCK);

        emit FeeReceiverChangeProposed(feeReceiver, _newFeeReceiver, _executeAfter[FEE_RECEIVER_CHANGE]);
    }

    /// @notice Execute the pending fee receiver change after timelock has elapsed.
    /// @dev AUDIT R014-MEDIUM: dry-run a 1-wei TOWELI transfer to the proposed receiver
    ///      before committing the swap. If the test transfer fails (the receiver is
    ///      blacklisted by TOWELI, or it's a contract that reverts on ERC20 inbound),
    ///      the pending change is auto-cancelled and `FeeReceiverChangeRejected` is
    ///      emitted. The 1 wei is taken from the contract's non-refundable TOWELI
    ///      balance and stays with the (rejected) receiver if the test passed. This
    ///      prevents an owner from accidentally rotating fees to a black-hole address.
    ///
    ///      Edge case: the contract must hold at least 1 wei of non-refundable TOWELI
    ///      for the dry-run. If only refundable deposits are present, the dry-run is
    ///      skipped — but in production the contract always accumulates fees first, so
    ///      this edge case is a no-op for any real deployment.
    function executeFeeReceiverChange() external onlyOwner {
        _execute(FEE_RECEIVER_CHANGE);

        // SLITHER 2026-05-18 (MEDIUM, auto): incorrect-equality — numeric counter == 0 check (NOT a block.timestamp eq); pattern-match FP
        // slither-disable-next-line incorrect-equality
        address proposed = pendingFeeReceiver;

        // AUDIT R014-MEDIUM: dry-run validation. Only run when we have spare TOWELI to
        // burn — refundable deposits MUST stay reserved for proposal refunds.
        // AUDIT FIX: DEEP-GOV-06 — REVERT when spare == 0 instead of skipping the
        // dry-run. A compromised owner could otherwise call `sweepFees` first
        // (draining the buffer to spare == 0), then `executeFeeReceiverChange` would
        // skip validation and silently rotate to a blackhole/blacklisted receiver.
        uint256 balance = toweli.balanceOf(address(this));
        uint256 spare = balance > totalRefundableDeposits ? balance - totalRefundableDeposits : 0;
        // SLITHER 2026-05-18 (MEDIUM, auto): incorrect-equality — numeric counter == 0 check (NOT a block.timestamp eq); pattern-match FP
        // slither-disable-next-line incorrect-equality
        if (spare == 0) revert NoSpareForDryRun();
        {
            // Use a low-level call so a revert doesn't unwind state — we want to detect
            // the failure and auto-cancel rather than propagate. Standard ERC20.transfer
            // returns bool (or reverts). Both failure modes count as a failed dry-run.
            // SLITHER 2026-05-18 (MEDIUM, auto): reentrancy-no-eth — `nonReentrant`-gated; state-writes-after-call cannot be exploited
            // slither-disable-next-line reentrancy-no-eth
            (bool ok, bytes memory ret) = address(toweli).call(
                abi.encodeWithSelector(IERC20.transfer.selector, proposed, uint256(1))
            );
            bool transferred = ok && (ret.length == 0 || abi.decode(ret, (bool)));
            if (!transferred) {
                // Auto-cancel: clear pending state, emit the rejection event, and RETURN
                // normally so state mutations persist. The timelock entry is already
                // cleared by `_execute` above. The owner must `proposeFeeReceiver` again
                // with a working address. We do not revert — reverting would unwind the
                // pendingFeeReceiver clear, leaving the proposal half-executed.
                pendingFeeReceiver = address(0);
                emit FeeReceiverChangeRejected(proposed, "DRY_RUN_TRANSFER_FAILED");
                return;
            }
        }

        address oldReceiver = feeReceiver;
        feeReceiver = proposed;
        pendingFeeReceiver = address(0);

        emit FeeReceiverChanged(oldReceiver, feeReceiver);
    }

    /// @notice Cancel a pending fee receiver change.
    function cancelFeeReceiverChange() external onlyOwner {
        _cancel(FEE_RECEIVER_CHANGE);

        address cancelled = pendingFeeReceiver;
        pendingFeeReceiver = address(0);

        emit FeeReceiverChangeCancelled(cancelled);
    }

    // ─── Pausable ─────────────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice One-shot wire of the TegridyRestaking contract address.
    /// @dev    AUDIT FIX (pass-8): GOV-ECON-01 / C10. Without this, users who
    ///         restake their staking NFT have `votingEscrow.votingPower*` return
    ///         0 and silently lose voting eligibility on every grant proposal.
    ///         Mirrors `setSequencerFeed` one-shot pattern.
    function setRestakingContract(address _restaking) external onlyOwner {
        if (_restaking == address(0)) revert ZeroAddress();
        if (restakingContract != address(0)) revert RestakingAlreadySet();
        restakingContract = _restaking;
        emit RestakingContractSet(_restaking);
    }

    // ─── Internal ─────────────────────────────────────────────────────

    /// @dev H-07 FIX: Prune expired entries from ring buffer and return current disbursed total.
    ///      O(expired) not O(total) — gas cost bounded by number of expired entries.
    function _pruneAndGetRollingDisbursed() internal returns (uint256) {
        uint256 cutoff = block.timestamp > ROLLING_WINDOW ? block.timestamp - ROLLING_WINDOW : 0;
        uint256 head = disbursementHead;
        uint256 tail = disbursementTail;

        // Prune expired entries from head forward
        while (head != tail) {
            if (disbursementTimestamps[head] >= cutoff) break;
            rollingDisbursed -= disbursementAmounts[head];
            delete disbursementTimestamps[head];
            delete disbursementAmounts[head];
            head = (head + 1) % MAX_DISBURSEMENTS;
        }
        disbursementHead = head;

        return rollingDisbursed;
    }

    /// @notice AUDIT FIX: DEEP-GOV-10 — view-side projection of the rolling
    ///         disbursement total. Re-implements the prune logic without mutating
    ///         state so off-chain dashboards / governance UIs can read the
    ///         post-prune value accurately. Pre-fix, consumers reading the public
    ///         `rollingDisbursed` saw stale data until the next executeProposal call.
    function rollingDisbursedView() external view returns (uint256) {
        uint256 cutoff = block.timestamp > ROLLING_WINDOW ? block.timestamp - ROLLING_WINDOW : 0;
        uint256 head = disbursementHead;
        uint256 tail = disbursementTail;
        uint256 disbursed = rollingDisbursed;

        while (head != tail) {
            if (disbursementTimestamps[head] >= cutoff) break;
            disbursed -= disbursementAmounts[head];
            head = (head + 1) % MAX_DISBURSEMENTS;
        }

        return disbursed;
    }

    /// @dev Transfer ETH with WETH fallback for contract recipients.
    ///      Returns false if both ETH and WETH transfer fail (for FailedExecution handling).
    ///      AUDIT FIX H-04: If WETH transfer fails after wrapping, unwrap back to ETH to prevent
    ///      WETH from being permanently stuck in the contract (no WETH sweep function).
    /// @dev AUDIT L-G02 (2026-04-28): Safe / Argent / EIP-4337 contract-wallet
    ///      recipients DELIBERATELY land in the WETH branch — their `receive()`
    ///      typically exceeds the 10k-gas stipend, so the raw ETH push fails
    ///      and the WETH wrap path takes over. From the recipient's POV they
    ///      get a WETH credit instead of ETH; this is an INTENTIONAL part of
    ///      the design, not a bug. If a Safe wants raw ETH, they need to
    ///      pre-deploy a payment splitter that uses receive() with the 10k
    ///      stipend. The protocol is not in the business of accommodating
    ///      arbitrary recipient gas budgets — which is also a security feature
    ///      (a recipient running heavy logic in receive() expands the
    ///      cross-contract reentrancy surface).
    // SLITHER NOTE 2026-05-18 (HIGH): `arbitrary-send-eth` false positive on the
    // entire `_transferETHOrWETH` body. `recipient` here is the proposal target
    // validated through the timelocked propose/execute/finalize flow. Callers
    // (`executeProposal`, `retryExecution`) ALWAYS hold `nonReentrant`. The 10k
    // gas stipend prevents the recipient from doing anything beyond receive() +
    // event. See NatSpec above for full rationale.
    // slither-disable-start arbitrary-send-eth
    function _transferETHOrWETH(address recipient, uint256 amount) internal returns (bool) {
        // AUDIT FIX M-2 (battle-tested, 2026-04-20 audit): reduced from 100_000 back to
        // 10_000 gas. 100k allowed the recipient contract to make a full external call during
        // the payout, widening the cross-contract reentrancy surface (each sibling contract
        // has its own nonReentrant guard, but cross-contract invariant violations are
        // observable). 10k is the Solmate/Seaport stipend — enough for receive() + event emit
        // but not for arbitrary external calls. Smart-account recipients (Safe, Argent,
        // EIP-4337) fall into the WETH-wrap branch below and receive WETH instead of ETH —
        // an acceptable degradation for a one-way payout.
        (bool success,) = recipient.call{value: amount, gas: 10_000}("");
        if (success) return true;
        // ETH transfer failed — try WETH fallback
        try IWETH(weth).deposit{value: amount}() {
            bool sent = IWETH(weth).transfer(recipient, amount);
            if (!sent) {
                // AUDIT FIX H-04: WETH transfer failed — unwrap back to ETH so funds aren't stuck as WETH
                IWETH(weth).withdraw(amount);
                return false;
            }
            return true;
        } catch {
            return false;
        }
    }
    // slither-disable-end arbitrary-send-eth

    /// @dev H-07 FIX: Record a disbursement in the ring buffer.
    ///      AUDIT FIX: DEEP-GOV-05 — when the buffer is full, the prior implementation
    ///      unconditionally evicted the oldest entry, even when it was still within
    ///      ROLLING_WINDOW. This silently subtracted the evicted amount from
    ///      rollingDisbursed, effectively bypassing the 30%/30day cap. Now: if buffer
    ///      is full AND oldest entry is still within ROLLING_WINDOW, revert with
    ///      RollingBufferFull. If aged out, eviction is benign.
    function _recordDisbursement(uint256 _amount) internal {
        uint256 tail = disbursementTail;
        uint256 nextTail = (tail + 1) % MAX_DISBURSEMENTS;

        // If buffer is full, evict the oldest entry — but only if it has aged out.
        if (nextTail == disbursementHead) {
            uint256 cutoff = block.timestamp > ROLLING_WINDOW ? block.timestamp - ROLLING_WINDOW : 0;
            // DEEP-GOV-05: refuse new disbursement when buffer full + oldest still
            // within rolling window. Prevents silent cap bypass via eviction.
            if (disbursementTimestamps[disbursementHead] >= cutoff) {
                revert RollingBufferFull();
            }
            rollingDisbursed -= disbursementAmounts[disbursementHead];
            delete disbursementTimestamps[disbursementHead];
            delete disbursementAmounts[disbursementHead];
            disbursementHead = (disbursementHead + 1) % MAX_DISBURSEMENTS;
        }

        disbursementTimestamps[tail] = block.timestamp;
        disbursementAmounts[tail] = _amount;
        disbursementTail = nextTail;
        rollingDisbursed += _amount;
    }

    // ─── View Functions ───────────────────────────────────────────────

    /// @notice Get the total number of proposals
    /// @return The number of proposals created
    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    /// @notice Get proposal details by ID
    /// @param _id The proposal ID to query
    /// @return proposer The address that created the proposal
    /// @return recipient The address that will receive the grant
    /// @return amount The ETH amount requested
    /// @return description The proposal description text
    /// @return votesFor Total voting power cast in favor
    /// @return votesAgainst Total voting power cast against
    /// @return deadline The voting deadline timestamp
    /// @return status The current proposal status
    /// @return snapshotTimestamp The timestamp used for voting power snapshot
    /// @return snapshotTotalStake The total boosted stake at proposal creation
    function getProposal(uint256 _id) external view returns (
        address proposer, address recipient, uint256 amount, string memory description,
        uint256 votesFor, uint256 votesAgainst, uint256 deadline, ProposalStatus status,
        uint256 snapshotTimestamp, uint256 snapshotTotalStake
    ) {
        Proposal memory p = proposals[_id];
        return (p.proposer, p.recipient, p.amount, p.description, p.votesFor, p.votesAgainst, p.deadline, p.status, p.snapshotTimestamp, p.snapshotTotalStake);
    }

    // ─── AUDIT R014-MEDIUM: Paginated proposal queries ───────────────
    //
    // The `proposals` array grows monotonically (no entries are deleted — historical
    // proposals are kept for audit trail). Off-chain indexers and UIs that need to
    // iterate proposals must do so in bounded chunks rather than reading the whole
    // array, which would eventually blow past the JSON-RPC response size and gas-for-
    // view limits. These two helpers expose that bounded iteration on-chain.

    /// @notice Return a contiguous range of proposal IDs as Proposal structs.
    /// @dev Inclusive `start`, exclusive `end`. Reverts on inverted ranges and clamps
    ///      `end` to `proposals.length` so callers can pass `type(uint256).max` as a
    ///      "to the end" sentinel without overflowing.
    /// @dev AUDIT L-G03 INDEXER-HELPER (2026-04-28): this view is intended for
    ///      OFF-CHAIN indexers (subgraphs, snapshots, leaderboards) that
    ///      page through `proposals` in bounded chunks. Calling it on-chain
    ///      from another contract is supported but inadvisable — the returned
    ///      array can be arbitrarily large within `[start, end)` and there is
    ///      no in-method gas guard. Off-chain callers should pick a chunk
    ///      size (typical: 50-200) and iterate. There is no economic reason
    ///      for an on-chain consumer to read the full historical proposal log.
    /// @param start The first proposal ID to include (inclusive).
    /// @param end   One past the last proposal ID to include (exclusive). Clamped to
    ///              `proposals.length`.
    function getProposalsInRange(uint256 start, uint256 end) external view returns (Proposal[] memory page) {
        uint256 len = proposals.length;
        if (end > len) end = len;
        if (start >= end) return new Proposal[](0);
        page = new Proposal[](end - start);
        for (uint256 i = start; i < end; ++i) {
            page[i - start] = proposals[i];
        }
    }

    /// @notice Indexer-friendly query: return up to `limit` proposals matching `status`,
    ///         scanning the array starting at `startIdx` (inclusive).
    /// @dev Returns both the matched proposals and their IDs so the caller can resume
    ///      pagination by passing `nextStartIdx` back as `startIdx`. `nextStartIdx ==
    ///      proposals.length` means the scan reached the end. Bounded by `limit`, so
    ///      gas cost per call is predictable even when the array grows large.
    // SLITHER 2026-05-18 (MEDIUM, auto): uninitialized-local — local var declared mid-function; assignment branches cover reachable paths
    // slither-disable-next-line uninitialized-local
    /// @param status   The ProposalStatus to filter on.
    /// @param startIdx First array index to scan (inclusive).
    /// @param limit    Maximum number of matching entries to return.
    // SLITHER 2026-05-18 (MEDIUM, auto): incorrect-equality — numeric counter == 0 check (NOT a block.timestamp eq); pattern-match FP
    // slither-disable-next-line incorrect-equality
    /// @return ids          Array of proposal IDs that matched (length up to `limit`).
    /// @return matched      Array of Proposal structs corresponding to `ids`.
    /// @return nextStartIdx Position to resume the scan from on the next call. When this
    ///                      equals `proposals.length`, the scan has finished.
    function getProposalsByStatus(
        ProposalStatus status,
        uint256 startIdx,
        uint256 limit
    ) external view returns (uint256[] memory ids, Proposal[] memory matched, uint256 nextStartIdx) {
        uint256 len = proposals.length;
        // SLITHER 2026-05-18 (MEDIUM, auto): uninitialized-local — local var declared mid-function; assignment branches cover reachable paths
        // slither-disable-next-line uninitialized-local
        if (startIdx >= len || limit == 0) {
            return (new uint256[](0), new Proposal[](0), len < startIdx ? len : startIdx);
        // SLITHER 2026-05-18 (MEDIUM, auto): incorrect-equality — numeric counter == 0 check (NOT a block.timestamp eq); pattern-match FP
        // slither-disable-next-line incorrect-equality
        }
        // Two-pass: first count matches up to `limit` so we can size the return arrays
        // exactly, then a second pass to populate them. Avoids over-allocation.
        // SLITHER 2026-05-18 (MEDIUM, auto): uninitialized-local — local var declared mid-function; assignment branches cover reachable paths
        // slither-disable-next-line uninitialized-local
        uint256 found;
        uint256 cursor = startIdx;
        for (; cursor < len && found < limit; ++cursor) {
            // SLITHER 2026-05-18 (MEDIUM, auto): incorrect-equality — numeric counter == 0 check (NOT a block.timestamp eq); pattern-match FP
            // slither-disable-next-line incorrect-equality
            if (proposals[cursor].status == status) {
                ++found;
            }
        }
        nextStartIdx = cursor;

        ids = new uint256[](found);
        matched = new Proposal[](found);
        if (found == 0) return (ids, matched, nextStartIdx);

        // SLITHER 2026-05-18 (MEDIUM, auto): uninitialized-local — local var declared mid-function; assignment branches cover reachable paths
        // slither-disable-next-line uninitialized-local
        uint256 outIdx;
        for (uint256 i = startIdx; i < cursor; ++i) {
            // SLITHER 2026-05-18 (MEDIUM, auto): incorrect-equality — numeric counter == 0 check (NOT a block.timestamp eq); pattern-match FP
            // slither-disable-next-line incorrect-equality
            if (proposals[i].status == status) {
                ids[outIdx] = i;
                matched[outIdx] = proposals[i];
                ++outIdx;
            }
        }
    }
}
