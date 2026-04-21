// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {OwnableNoRenounce} from "./base/OwnableNoRenounce.sol";
import {TimelockAdmin} from "./base/TimelockAdmin.sol";
import {WETHFallbackLib, IWETH} from "./lib/WETHFallbackLib.sol";

interface IVotingEscrowGrants {
    function votingPowerOf(address user) external view returns (uint256);
    function votingPowerAt(address user, uint256 blockNumber) external view returns (uint256);
    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256);
    function totalLocked() external view returns (uint256);
    function totalBoostedStake() external view returns (uint256);
    function userTokenId(address user) external view returns (uint256); // SECURITY FIX C1: Track proposer's NFT
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

    // ─── State ────────────────────────────────────────────────────────

    using SafeERC20 for IERC20;

    IVotingEscrowGrants public immutable votingEscrow;
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
    uint256 public constant MIN_ABSOLUTE_QUORUM = 1000e18; // A4-M-14: Reduced from 10000e18 — old value blocked governance when total stake < 10k tokens
    uint256 public constant MAX_GRANT_PERCENT_BPS = 5000; // H-04: max 50% of contract balance per grant
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

    // ─── Errors ───────────────────────────────────────────────────────

    error AmountTooSmall();
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
    error FeeReceiverProposalExpired();
    error RollingDisbursementExceeded();

    error AlreadyRefunded(); // AUDIT FIX H-01: Deposit already consumed or refunded

    // Legacy error aliases (kept for test compatibility)
    error NoFeeReceiverChangePending();
    error FeeReceiverTimelockNotElapsed();
    error FeeReceiverChangePending();

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
            snapshotTimestamp: block.timestamp >= SNAPSHOT_LOOKBACK ? block.timestamp - SNAPSHOT_LOOKBACK : 0,
            snapshotTotalStake: votingEscrow.totalBoostedStake(), // SECURITY FIX: snapshot quorum denominator
            proposerTokenId: votingEscrow.userTokenId(msg.sender) // SECURITY FIX: snapshot proposer's NFT position
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
        if (proposal.proposerTokenId != 0) {
            require(votingEscrow.userTokenId(msg.sender) != proposal.proposerTokenId, "PROPOSER_POSITION_CANNOT_VOTE");
        }

        uint256 power = votingEscrow.votingPowerAtTimestamp(msg.sender, proposal.snapshotTimestamp);
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
            proposal.status = ProposalStatus.Approved;
            // AUDIT FIX H-02: Track approved ETH to prevent serial drain
            totalApprovedPending += proposal.amount;
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
        // AUDIT FIX C-01: Exclude this proposal's own amount from totalApprovedPending when computing cap
        uint256 otherApproved = totalApprovedPending > proposal.amount
            ? totalApprovedPending - proposal.amount
            : 0;
        uint256 availableForGrant = address(this).balance > otherApproved
            ? address(this).balance - otherApproved
            : 0;
        if (proposal.amount > (availableForGrant * MAX_GRANT_PERCENT_BPS) / 10000) revert AmountTooLarge();

        // Rolling treasury depletion limit: max 30% of current balance in any 30-day window
        uint256 currentRolling = _pruneAndGetRollingDisbursed();
        uint256 maxRolling = (address(this).balance * MAX_ROLLING_DISBURSEMENT_BPS) / 10000;
        if (currentRolling + proposal.amount > maxRolling) revert RollingDisbursementExceeded();

        // AUDIT FIX M-27: Attempt ETH transfer with WETH fallback for contract recipients
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

    /// @notice Retry execution of a proposal that previously failed
    /// @param _proposalId The ID of the failed proposal to retry
    function retryExecution(uint256 _proposalId) external onlyOwner nonReentrant {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        if (proposal.status != ProposalStatus.FailedExecution) revert NotFailedExecution();
        // AUDIT FIX: Enforce execution deadline on retries too
        if (block.timestamp > proposal.deadline + EXECUTION_DEADLINE) revert ExecutionDeadlineExpired();
        if (address(this).balance < proposal.amount) revert InsufficientFunds();
        // AUDIT FIX C-01: Exclude this proposal's own amount from totalApprovedPending for cap check
        uint256 otherApproved = totalApprovedPending > proposal.amount
            ? totalApprovedPending - proposal.amount
            : 0;
        uint256 availableForRetry = address(this).balance > otherApproved
            ? address(this).balance - otherApproved
            : 0;
        if (proposal.amount > (availableForRetry * MAX_GRANT_PERCENT_BPS) / 10000) revert AmountTooLarge();

        // Rolling treasury depletion limit: max 30% of current balance in any 30-day window
        uint256 currentRolling = _pruneAndGetRollingDisbursed();
        uint256 maxRolling = (address(this).balance * MAX_ROLLING_DISBURSEMENT_BPS) / 10000;
        if (currentRolling + proposal.amount > maxRolling) revert RollingDisbursementExceeded();

        // AUDIT FIX M-27: Attempt ETH transfer with WETH fallback for contract recipients
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

    /// @notice Cancel a proposal (owner or proposer only).
    ///         AUDIT FIX C-02: Owner can cancel Active AND Approved proposals.
    ///         Proposer can only cancel Active proposals.
    ///         This prevents governance griefing where approved proposals freeze treasury for 30 days.
    /// @param _proposalId The ID of the proposal to cancel
    function cancelProposal(uint256 _proposalId) external nonReentrant {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        // AUDIT FIX H-01: Prevent double-refund if deposit was already consumed
        if (depositRefunded[_proposalId]) revert AlreadyRefunded();

        // AUDIT FIX C-02: Owner can cancel both Active and Approved proposals.
        // Proposer can only cancel their own Active proposals.
        bool isOwner = msg.sender == owner();
        bool isProposer = msg.sender == proposal.proposer;
        if (!isOwner && !isProposer) revert NotAuthorized();

        if (proposal.status == ProposalStatus.Active) {
            // Anyone authorized can cancel Active proposals
        } else if (proposal.status == ProposalStatus.Approved && isOwner) {
            // AUDIT FIX C-02: Only owner can cancel Approved proposals — releases totalApprovedPending
            totalApprovedPending -= proposal.amount;
        } else {
            revert ProposalNotActive();
        }

        uint256 refundable = PROPOSAL_FEE - PROPOSAL_FEE / 2;
        totalRefundableDeposits -= refundable;
        depositRefunded[_proposalId] = true; // AUDIT FIX H-01: Mark deposit as consumed
        proposal.status = ProposalStatus.Cancelled;
        activeProposalCount--;
        // AUDIT FIX: Handle blacklisted proposer with try/catch pattern (consistent with finalizeProposal/lapseProposal)
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

    /// @notice Lapse an approved proposal whose execution deadline has passed (H-03).
    ///         Anyone can call this. The proposal is set to Rejected and the deposit is refunded.
    /// @param _proposalId The ID of the approved proposal to lapse
    function lapseProposal(uint256 _proposalId) external nonReentrant {
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
    function executeFeeReceiverChange() external onlyOwner {
        _execute(FEE_RECEIVER_CHANGE);

        address oldReceiver = feeReceiver;
        feeReceiver = pendingFeeReceiver;
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

    // ─── Internal ─────────────────────────────────────────────────────

    function _countActiveProposals() internal view returns (uint256) {
        return activeProposalCount;
    }

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

    /// @dev Transfer ETH with WETH fallback for contract recipients.
    ///      Returns false if both ETH and WETH transfer fail (for FailedExecution handling).
    ///      AUDIT FIX H-04: If WETH transfer fails after wrapping, unwrap back to ETH to prevent
    ///      WETH from being permanently stuck in the contract (no WETH sweep function).
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

    /// @dev H-07 FIX: Record a disbursement in the ring buffer.
    ///      If buffer is full, the oldest entry is evicted (its amount removed from rollingDisbursed).
    function _recordDisbursement(uint256 _amount) internal {
        uint256 tail = disbursementTail;
        uint256 nextTail = (tail + 1) % MAX_DISBURSEMENTS;

        // If buffer is full, evict the oldest entry
        if (nextTail == disbursementHead) {
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
}
