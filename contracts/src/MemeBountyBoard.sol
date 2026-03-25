// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MemeBountyBoard
/// @notice A decentralized bounty board where anyone can post bounties (in ETH)
///         for tasks. Community votes on submissions. Winner gets paid.
///
///         Use cases: meme creation, tool building, thread writing,
///         sticker pack design, art commissions, community contributions.
///
///         "Seize the memes of production" — now with actual compensation.
contract MemeBountyBoard is Ownable2Step, ReentrancyGuard {

    // ─── State ────────────────────────────────────────────────────────

    IERC20 public immutable voteToken; // TOWELI — must hold tokens to vote (anti-sybil)
    uint256 public constant MIN_VOTE_BALANCE = 1000 ether; // Must hold 1000 TOWELI to vote

    enum BountyStatus { Open, Completed, Cancelled }

    struct Bounty {
        address creator;
        string description;
        uint256 reward;       // ETH locked
        uint256 deadline;
        address winner;
        BountyStatus status;
        uint256 submissionCount;
    }

    struct Submission {
        address submitter;
        string contentURI;    // IPFS hash or URL
        uint256 votes;
    }

    Bounty[] public bounties;
    mapping(uint256 => Submission[]) public submissions; // bountyId => submissions
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public hasVotedOnSubmission;

    uint256 public totalBountiesPosted;
    uint256 public totalPaidOut;

    // ─── Events ───────────────────────────────────────────────────────

    event BountyCreated(uint256 indexed id, address indexed creator, uint256 reward, string description);
    event SubmissionAdded(uint256 indexed bountyId, uint256 submissionId, address indexed submitter, string contentURI);
    event SubmissionVoted(uint256 indexed bountyId, uint256 submissionId, address indexed voter);
    event BountyCompleted(uint256 indexed bountyId, address indexed winner, uint256 reward);
    event BountyCancelled(uint256 indexed bountyId);
    event BountyEmergencyCancelled(uint256 indexed bountyId);

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

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(address _voteToken) Ownable(msg.sender) {
        voteToken = IERC20(_voteToken);
    }

    // ─── Bounty Management ────────────────────────────────────────────

    /// @notice Create a bounty. ETH sent with this call is the reward.
    function createBounty(string calldata _description, uint256 _deadline) external payable {
        if (msg.value < 0.001 ether) revert InsufficientReward();
        if (_deadline <= block.timestamp) revert DeadlinePassed();

        bounties.push(Bounty({
            creator: msg.sender,
            description: _description,
            reward: msg.value,
            deadline: _deadline,
            winner: address(0),
            status: BountyStatus.Open,
            submissionCount: 0
        }));

        totalBountiesPosted++;
        emit BountyCreated(bounties.length - 1, msg.sender, msg.value, _description);
    }

    /// @notice Submit work for a bounty
    function submitWork(uint256 _bountyId, string calldata _contentURI) external {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        if (block.timestamp > bounty.deadline) revert DeadlinePassed();

        submissions[_bountyId].push(Submission({
            submitter: msg.sender,
            contentURI: _contentURI,
            votes: 0
        }));
        bounty.submissionCount++;

        emit SubmissionAdded(_bountyId, submissions[_bountyId].length - 1, msg.sender, _contentURI);
    }

    /// @notice Vote for a submission. Must hold MIN_VOTE_BALANCE TOWELI (anti-sybil).
    function voteForSubmission(uint256 _bountyId, uint256 _submissionId) external {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        if (_submissionId >= submissions[_bountyId].length) revert InvalidSubmission();
        if (hasVotedOnSubmission[_bountyId][_submissionId][msg.sender]) revert AlreadyVoted();
        if (bounties[_bountyId].status != BountyStatus.Open) revert BountyNotOpen();
        if (voteToken.balanceOf(msg.sender) < MIN_VOTE_BALANCE) revert InsufficientVoteBalance();

        hasVotedOnSubmission[_bountyId][_submissionId][msg.sender] = true;
        submissions[_bountyId][_submissionId].votes++;

        emit SubmissionVoted(_bountyId, _submissionId, msg.sender);
    }

    /// @notice Complete a bounty — pay the top-voted submission.
    ///         Only the bounty creator can complete it (owner cannot override).
    function completeBounty(uint256 _bountyId) external nonReentrant {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        if (block.timestamp <= bounty.deadline) revert DeadlineNotPassed();
        if (msg.sender != bounty.creator) revert NotCreator();
        if (bounty.submissionCount == 0) revert NoSubmissions();

        // Find top-voted submission
        uint256 topVotes = 0;
        uint256 topIdx = 0;
        Submission[] storage subs = submissions[_bountyId];
        for (uint256 i = 0; i < subs.length; i++) {
            if (subs[i].votes > topVotes) {
                topVotes = subs[i].votes;
                topIdx = i;
            }
        }

        address winner = subs[topIdx].submitter;
        bounty.winner = winner;
        bounty.status = BountyStatus.Completed;
        totalPaidOut += bounty.reward;

        (bool success,) = winner.call{value: bounty.reward}("");
        if (!success) revert ETHTransferFailed();

        emit BountyCompleted(_bountyId, winner, bounty.reward);
    }

    /// @notice Cancel a bounty and refund (creator or owner, before deadline)
    function cancelBounty(uint256 _bountyId) external nonReentrant {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        if (msg.sender != bounty.creator && msg.sender != owner()) revert NotCreatorOrOwner();

        bounty.status = BountyStatus.Cancelled;

        (bool success,) = bounty.creator.call{value: bounty.reward}("");
        if (!success) revert ETHTransferFailed();

        emit BountyCancelled(_bountyId);
    }

    /// @notice Emergency cancel by owner — refunds the bounty creator (does NOT pay any submission).
    ///         Use only for disputes, spam, or stuck bounties.
    function emergencyCancel(uint256 _bountyId) external nonReentrant onlyOwner {
        if (_bountyId >= bounties.length) revert InvalidBounty();
        Bounty storage bounty = bounties[_bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();

        bounty.status = BountyStatus.Cancelled;

        (bool success,) = bounty.creator.call{value: bounty.reward}("");
        if (!success) revert ETHTransferFailed();

        emit BountyEmergencyCancelled(_bountyId);
    }

    // ─── View ─────────────────────────────────────────────────────────

    function bountyCount() external view returns (uint256) { return bounties.length; }

    function getBounty(uint256 _id) external view returns (
        address creator, string memory description, uint256 reward, uint256 deadline,
        address winner, uint256 submCount, BountyStatus status, uint256 dummy
    ) {
        Bounty memory b = bounties[_id];
        return (b.creator, b.description, b.reward, b.deadline, b.winner, b.submissionCount, b.status, 0);
    }

    function getSubmission(uint256 _bountyId, uint256 _submissionId) external view returns (
        address submitter, string memory contentURI, uint256 votes
    ) {
        Submission memory s = submissions[_bountyId][_submissionId];
        return (s.submitter, s.contentURI, s.votes);
    }

    function submissionCount(uint256 _bountyId) external view returns (uint256) {
        return submissions[_bountyId].length;
    }
}
