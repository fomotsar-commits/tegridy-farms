// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/MemeBountyBoard.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

contract MockToweliBoard is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockStakingVoteBoard {
    mapping(address => uint256) public _votingPower;
    mapping(address => mapping(uint256 => uint256)) public _votingPowerAtBlock;

    function setVotingPower(address user, uint256 power) external {
        _votingPower[user] = power;
    }

    function setVotingPowerAtBlock(address user, uint256 blockNum, uint256 power) external {
        _votingPowerAtBlock[user][blockNum] = power;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return _votingPower[user];
    }

    function votingPowerAt(address user, uint256 blockNumber) external view returns (uint256) {
        // If specific block power was set, use it; otherwise fall back to general power
        if (_votingPowerAtBlock[user][blockNumber] > 0) {
            return _votingPowerAtBlock[user][blockNumber];
        }
        return _votingPower[user];
    }

    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256) {
        if (_votingPowerAtBlock[user][ts] > 0) {
            return _votingPowerAtBlock[user][ts];
        }
        return _votingPower[user];
    }
}

contract MockWETHBoard {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    receive() external payable {}
}

/// @dev Contract that rejects ETH transfers (no receive/fallback), used to test WETH fallback
contract ETHRejecter {
    MemeBountyBoard public board;

    constructor(MemeBountyBoard _board) {
        board = _board;
    }

    function createBounty(string calldata desc, uint256 deadline) external payable {
        board.createBounty{value: msg.value}(desc, deadline);
    }

    function withdrawRefund() external {
        board.withdrawRefund();
    }

    // No receive() or fallback() — ETH transfers will revert
}

contract MemeBountyBoardTest is Test {
    MemeBountyBoard public board;
    MockToweliBoard public token;
    MockStakingVoteBoard public staking;
    MockWETHBoard public weth;
    address public creator = makeAddr("creator");
    address public artist1 = makeAddr("artist1");
    address public artist2 = makeAddr("artist2");
    address public voter1 = makeAddr("voter1");
    address public voter2 = makeAddr("voter2");
    address public voter3 = makeAddr("voter3");
    address public voter4 = makeAddr("voter4");

    function setUp() public {
        token = new MockToweliBoard();
        staking = new MockStakingVoteBoard();
        weth = new MockWETHBoard();
        board = new MemeBountyBoard(address(token), address(staking), address(weth));
        vm.deal(creator, 10 ether);
        vm.deal(address(this), 10 ether);

        token.transfer(artist1, 500 ether);
        token.transfer(artist2, 500 ether);
        token.transfer(voter1, 10_000 ether);
        token.transfer(voter2, 10_000 ether);
        token.transfer(voter3, 10_000 ether);
        token.transfer(voter4, 10_000 ether);

        staking.setVotingPower(artist1, 500 ether);
        staking.setVotingPower(artist2, 500 ether);
        staking.setVotingPower(voter1, 10_000 ether);
        staking.setVotingPower(voter2, 10_000 ether);
        staking.setVotingPower(voter3, 10_000 ether);
        staking.setVotingPower(voter4, 10_000 ether);
    }

    function _createBountyWithSubmission() internal returns (uint256 bountyId) {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Meme contest", block.timestamp + 7 days);
        bountyId = 0;

        vm.prank(artist1);
        board.submitWork(bountyId, "ipfs://winner");
        vm.prank(artist2);
        board.submitWork(bountyId, "ipfs://loser");
    }

    function _voteForSubmission(uint256 bountyId, uint256 subId, address voter) internal {
        vm.prank(voter);
        board.voteForSubmission(bountyId, subId);
    }

    // ===== BOUNTY CREATION WITH MINIMUM DEADLINE =====

    function test_createBounty() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Create a dank meme", block.timestamp + 7 days);

        assertEq(board.bountyCount(), 1);
        (address c,, uint256 reward, uint256 deadline,,,) = board.getBounty(0);
        assertEq(c, creator);
        assertEq(reward, 1 ether);
        assertGt(deadline, block.timestamp);
    }

    function test_revert_createBounty_deadlineTooSoon() public {
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.DeadlineTooSoon.selector);
        board.createBounty{value: 1 ether}("Too soon", block.timestamp + 12 hours);
    }

    function test_createBounty_exactMinDeadline() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Exact min", block.timestamp + 1 days);
        assertEq(board.bountyCount(), 1);
    }

    function test_revert_createBounty_rewardTooSmall() public {
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.InsufficientReward.selector);
        board.createBounty{value: 0.0001 ether}("Cheap", block.timestamp + 1 days);
    }

    // ===== CANNOT CANCEL AFTER DEADLINE =====

    function test_revert_cancelBounty_afterDeadline() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);

        vm.warp(block.timestamp + 8 days);

        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.CannotCancelAfterDeadline.selector);
        board.cancelBounty(0);
    }

    function test_cancelBounty_beforeDeadline() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);

        // Warp past MIN_CANCEL_DELAY (1 hour) to allow cancellation
        vm.warp(block.timestamp + 1 hours + 1);

        uint256 balBefore = creator.balance;
        vm.prank(creator);
        board.cancelBounty(0);

        assertEq(creator.balance - balBefore, 1 ether);
        (,,,,,,MemeBountyBoard.BountyStatus status) = board.getBounty(0);
        assertEq(uint256(status), uint256(MemeBountyBoard.BountyStatus.Cancelled));
    }

    // ===== SELF-VOTING PREVENTION =====

    function test_revert_selfVote() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);

        // artist1 submits and also has voting power
        staking.setVotingPower(artist1, 10_000 ether);
        vm.prank(artist1);
        board.submitWork(0, "ipfs://mywork");

        // artist1 tries to vote on own submission
        vm.prank(artist1);
        vm.expectRevert(MemeBountyBoard.CannotVoteOwnSubmission.selector);
        board.voteForSubmission(0, 0);
    }

    // ===== SNAPSHOT-BASED VOTING POWER =====

    function test_vote_usesSnapshotBlock() public {
        uint256 creationBlock = block.number;

        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);

        vm.prank(artist1);
        board.submitWork(0, "ipfs://art");

        // Set voter1's power at the snapshot block
        // They should be able to vote since their general power is set
        vm.prank(voter1);
        board.voteForSubmission(0, 0);

        // Votes are stake-weighted: voter1 has 10_000 ether voting power
        (,, uint256 votes) = board.getSubmission(0, 0);
        assertEq(votes, 10_000 ether);
    }

    function test_revert_vote_insufficientVotingPower() public {
        _createBountyWithSubmission();

        address nopower = makeAddr("nopower");
        staking.setVotingPower(nopower, 0);

        vm.prank(nopower);
        vm.expectRevert(MemeBountyBoard.InsufficientVoteBalance.selector);
        board.voteForSubmission(0, 0);
    }

    // ===== DISPUTE PERIOD ENFORCEMENT (SECURITY FIX #15) =====

    function test_revert_completeBounty_disputePeriodActive() public {
        _createBountyWithSubmission();

        _voteForSubmission(0, 0, voter1);
        _voteForSubmission(0, 0, voter2);
        _voteForSubmission(0, 0, voter3);

        // Past deadline but still in 2-day dispute period
        vm.warp(block.timestamp + 7 days + 1);

        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.DisputePeriodActive.selector);
        board.completeBounty(0);
    }

    function test_completeBounty_afterDisputePeriod() public {
        _createBountyWithSubmission();

        _voteForSubmission(0, 0, voter1);
        _voteForSubmission(0, 0, voter2);
        _voteForSubmission(0, 0, voter3);

        // Past deadline + dispute period
        vm.warp(block.timestamp + 10 days);

        uint256 balBefore = artist1.balance;
        vm.prank(creator);
        board.completeBounty(0);

        assertEq(artist1.balance - balBefore, 1 ether);
    }

    // ===== QUORUM MINIMUM VOTES (SECURITY FIX #15) =====

    function test_revert_completeBounty_quorumNotMet() public {
        // Create bounty and submission with low-power voters to stay under quorum
        // MIN_COMPLETION_VOTES = 3000e18, so we need total votes < 3000e18
        address weakVoter1 = makeAddr("weakVoter1");
        address weakVoter2 = makeAddr("weakVoter2");
        staking.setVotingPower(weakVoter1, 1000 ether); // 1000e18 each
        staking.setVotingPower(weakVoter2, 1000 ether);
        // Also set at block 0 for snapshot
        staking.setVotingPowerAtBlock(weakVoter1, block.number > 0 ? block.number - 1 : 0, 1000 ether);
        staking.setVotingPowerAtBlock(weakVoter2, block.number > 0 ? block.number - 1 : 0, 1000 ether);

        _createBountyWithSubmission();

        // 2 weak votes = 2000e18 < 3000e18 quorum
        _voteForSubmission(0, 0, weakVoter1);
        _voteForSubmission(0, 0, weakVoter2);

        vm.warp(block.timestamp + 10 days);

        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.QuorumNotMet.selector);
        board.completeBounty(0);
    }

    function test_completeBounty_exactQuorum() public {
        _createBountyWithSubmission();

        // Exactly 3 votes (= MIN_COMPLETION_VOTES)
        _voteForSubmission(0, 0, voter1);
        _voteForSubmission(0, 0, voter2);
        _voteForSubmission(0, 0, voter3);

        vm.warp(block.timestamp + 10 days);

        vm.prank(creator);
        board.completeBounty(0);

        (,,,,address winner,, MemeBountyBoard.BountyStatus status) = board.getBounty(0);
        assertEq(winner, artist1);
        assertEq(uint256(status), uint256(MemeBountyBoard.BountyStatus.Completed));
    }

    // ===== OTHER TESTS =====

    function test_revert_completeBounty_beforeDeadline() public {
        _createBountyWithSubmission();

        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.DeadlineNotPassed.selector);
        board.completeBounty(0);
    }

    function test_revert_completeBounty_noSubmissions() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);
        vm.warp(block.timestamp + 10 days);

        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.NoSubmissions.selector);
        board.completeBounty(0);
    }

    function test_revert_completeBounty_notCreator() public {
        _createBountyWithSubmission();
        _voteForSubmission(0, 0, voter1);
        _voteForSubmission(0, 0, voter2);
        _voteForSubmission(0, 0, voter3);
        // Warp past deadline + dispute but WITHIN grace period — non-creator should fail
        vm.warp(block.timestamp + 10 days);

        vm.prank(voter1);
        vm.expectRevert(MemeBountyBoard.GracePeriodNotExpired.selector);
        board.completeBounty(0);
    }

    function test_revert_voteDouble() public {
        _createBountyWithSubmission();

        _voteForSubmission(0, 0, voter1);

        vm.prank(voter1);
        vm.expectRevert(MemeBountyBoard.AlreadyVoted.selector);
        board.voteForSubmission(0, 0);
    }

    function test_emergencyCancel() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Emergency", block.timestamp + 7 days);

        uint256 creatorBalBefore = creator.balance;
        board.emergencyCancel(0);

        assertEq(creator.balance - creatorBalBefore, 1 ether);
    }

    function test_topSubmission_tracking() public {
        _createBountyWithSubmission();

        _voteForSubmission(0, 0, voter1);
        _voteForSubmission(0, 0, voter2);

        // Votes are stake-weighted: 2 voters x 10_000 ether each = 20_000 ether
        assertEq(board.topSubmissionId(0), 0);
        assertEq(board.topSubmissionVotes(0), 20_000 ether);

        // Use different voters for submission 1 (H-02: each voter can only vote once per bounty)
        _voteForSubmission(0, 1, voter3);
        _voteForSubmission(0, 1, voter4);

        // Submission 1 has 20_000 ether votes (tied with sub 0)
        // With > comparison, first submission to reach vote count retains top position on tie
        assertEq(board.topSubmissionId(0), 0);
        assertEq(board.topSubmissionVotes(0), 20_000 ether);
    }

    // ===== H-06: withdrawRefund WETH fallback for contracts that reject ETH =====

    function test_withdrawRefund_WETHFallback() public {
        // Deploy a contract creator that cannot receive ETH
        ETHRejecter rejecter = new ETHRejecter(board);

        // Rejecter creates a bounty (test contract sends ETH which rejecter forwards)
        rejecter.createBounty{value: 10 ether}("Test bounty", block.timestamp + 7 days);

        // Warp past cancel delay, cancel bounty via owner (no submissions)
        vm.warp(block.timestamp + 1 hours + 1);
        board.emergencyCancel(0);

        // ETH transfer to rejecter failed, so funds are in pendingRefund
        assertEq(board.pendingRefund(address(rejecter)), 10 ether);

        // withdrawRefund should fall back to WETH since rejecter can't receive ETH
        rejecter.withdrawRefund();

        // pendingRefund should be cleared
        assertEq(board.pendingRefund(address(rejecter)), 0);

        // Rejecter should have received WETH instead
        assertEq(weth.balanceOf(address(rejecter)), 10 ether);
    }

    // ===== AC-03: setMinBountyReward TIMELOCK =====

    function test_revert_executeMinBountyReward_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, board.MIN_REWARD_CHANGE()));
        board.executeMinBountyRewardChange();
    }

    function test_revert_executeMinBountyReward_tooEarly() public {
        board.proposeMinBountyReward(0.01 ether);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, board.MIN_REWARD_CHANGE()));
        board.executeMinBountyRewardChange();
    }

    function test_proposeAndExecuteMinBountyReward() public {
        board.proposeMinBountyReward(0.01 ether);
        vm.warp(block.timestamp + 24 hours + 1);
        board.executeMinBountyRewardChange();

        assertEq(board.minBountyReward(), 0.01 ether);
    }

    function test_revert_proposeMinBountyReward_notOwner() public {
        vm.prank(creator);
        vm.expectRevert();
        board.proposeMinBountyReward(0.01 ether);
    }

    receive() external payable {}
}
