// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVotingEscrowGrants {
    function votingPowerOf(address user) external view returns (uint256);
    function totalLocked() external view returns (uint256);
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
contract CommunityGrants is Ownable2Step, ReentrancyGuard {

    // ─── State ────────────────────────────────────────────────────────

    using SafeERC20 for IERC20;

    IVotingEscrowGrants public immutable votingEscrow;
    IERC20 public immutable toweli;

    uint256 public constant PROPOSAL_FEE = 42_069 ether; // 42,069 TOWELI to submit a proposal
    address public feeReceiver; // Where submission fees go (treasury)
    uint256 public totalFeesCollected;

    enum ProposalStatus { Active, Approved, Rejected, Executed, Cancelled }

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
    }

    Proposal[] public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVotedOnProposal;

    uint256 public constant VOTING_PERIOD = 7 days;
    uint256 public constant MIN_PROPOSAL_AMOUNT = 0.01 ether;
    uint256 public constant MIN_QUORUM_BPS = 1000; // At least 10% of total locked must vote

    uint256 public totalGranted;

    // ─── Events ───────────────────────────────────────────────────────

    event ProposalCreated(uint256 indexed id, address indexed proposer, address recipient, uint256 amount, string description);
    event ProposalVoted(uint256 indexed id, address indexed voter, bool support, uint256 power);
    event ProposalExecuted(uint256 indexed id, address recipient, uint256 amount);
    event ProposalCancelled(uint256 indexed id);
    event ETHReceived(address indexed sender, uint256 amount);

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
    error QuorumNotMet();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _votingEscrow, address _toweli, address _feeReceiver) Ownable(msg.sender) {
        if (_votingEscrow == address(0) || _toweli == address(0) || _feeReceiver == address(0)) revert ZeroAddress();
        votingEscrow = IVotingEscrowGrants(_votingEscrow);
        toweli = IERC20(_toweli);
        feeReceiver = _feeReceiver;
    }

    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }

    // ─── Proposals ────────────────────────────────────────────────────

    /// @notice Submit a grant proposal. Costs 42,069 TOWELI (non-refundable).
    function createProposal(address _recipient, uint256 _amount, string calldata _description) external {
        if (_recipient == address(0)) revert ZeroAddress();
        if (_amount < MIN_PROPOSAL_AMOUNT) revert AmountTooSmall();

        // Collect submission fee — 42,069 TOWELI sent to fee receiver
        toweli.safeTransferFrom(msg.sender, feeReceiver, PROPOSAL_FEE);
        totalFeesCollected += PROPOSAL_FEE;

        proposals.push(Proposal({
            proposer: msg.sender,
            recipient: _recipient,
            amount: _amount,
            description: _description,
            votesFor: 0,
            votesAgainst: 0,
            createdAt: block.timestamp,
            deadline: block.timestamp + VOTING_PERIOD,
            status: ProposalStatus.Active
        }));

        emit ProposalCreated(proposals.length - 1, msg.sender, _recipient, _amount, _description);
    }

    /// @notice Vote on a proposal. Voting power = veTOWELI power.
    function voteOnProposal(uint256 _proposalId, bool _support) external {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        if (proposal.status != ProposalStatus.Active) revert ProposalNotActive();
        if (block.timestamp > proposal.deadline) revert VotingEnded();
        if (hasVotedOnProposal[_proposalId][msg.sender]) revert AlreadyVoted();

        uint256 power = votingEscrow.votingPowerOf(msg.sender);
        if (power == 0) revert NoVotingPower();

        hasVotedOnProposal[_proposalId][msg.sender] = true;

        if (_support) {
            proposal.votesFor += power;
        } else {
            proposal.votesAgainst += power;
        }

        emit ProposalVoted(_proposalId, msg.sender, _support, power);
    }

    /// @notice Finalize a proposal after voting period ends.
    ///         Approved if votesFor > votesAgainst.
    function finalizeProposal(uint256 _proposalId) external {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        if (proposal.status != ProposalStatus.Active) revert ProposalNotActive();
        if (block.timestamp <= proposal.deadline) revert VotingNotEnded();

        // Check quorum: total votes must be >= 10% of total locked TOWELI
        uint256 totalVotes = proposal.votesFor + proposal.votesAgainst;
        uint256 totalLocked = votingEscrow.totalLocked();
        if (totalLocked > 0 && (totalVotes * 10000) / totalLocked < MIN_QUORUM_BPS) {
            revert QuorumNotMet();
        }

        if (proposal.votesFor > proposal.votesAgainst) {
            proposal.status = ProposalStatus.Approved;
        } else {
            proposal.status = ProposalStatus.Rejected;
        }
    }

    /// @notice Execute an approved proposal (owner only — safety check)
    function executeProposal(uint256 _proposalId) external onlyOwner nonReentrant {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];

        if (proposal.status != ProposalStatus.Approved) revert NotApproved();
        if (address(this).balance < proposal.amount) revert InsufficientFunds();

        proposal.status = ProposalStatus.Executed;
        totalGranted += proposal.amount;

        (bool success,) = proposal.recipient.call{value: proposal.amount}("");
        if (!success) revert InsufficientFunds();

        emit ProposalExecuted(_proposalId, proposal.recipient, proposal.amount);
    }

    /// @notice Cancel a proposal (owner or proposer only)
    function cancelProposal(uint256 _proposalId) external {
        if (_proposalId >= proposals.length) revert InvalidProposal();
        Proposal storage proposal = proposals[_proposalId];
        if (proposal.status != ProposalStatus.Active) revert ProposalNotActive();
        if (msg.sender != owner() && msg.sender != proposal.proposer) revert ProposalNotActive();

        proposal.status = ProposalStatus.Cancelled;
        emit ProposalCancelled(_proposalId);
    }

    // ─── View Functions ───────────────────────────────────────────────

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    function getProposal(uint256 _id) external view returns (
        address proposer, address recipient, uint256 amount, string memory description,
        uint256 votesFor, uint256 votesAgainst, uint256 deadline, ProposalStatus status
    ) {
        Proposal memory p = proposals[_id];
        return (p.proposer, p.recipient, p.amount, p.description, p.votesFor, p.votesAgainst, p.deadline, p.status);
    }
}
