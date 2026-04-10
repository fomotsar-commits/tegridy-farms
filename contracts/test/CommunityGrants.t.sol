// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/CommunityGrants.sol";

contract MockTokenGrants is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev Mock that implements IVotingEscrowGrants interface
contract MockVEGrants {
    mapping(address => uint256) public powers;
    uint256 public totalLocked;

    function setPower(address user, uint256 power) external {
        totalLocked = totalLocked - powers[user] + power;
        powers[user] = power;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return powers[user];
    }

    function votingPowerAt(address user, uint256 /* blockNumber */) external view returns (uint256) {
        return powers[user];
    }

    function votingPowerAtTimestamp(address user, uint256 /* ts */) external view returns (uint256) {
        return powers[user];
    }

    function totalBoostedStake() external view returns (uint256) {
        return totalLocked;
    }
}

/// @dev Mock WETH that always reverts on deposit — ensures both ETH and WETH paths fail for FailedExecution tests
contract MockWETHGrants {
    function deposit() external payable { revert("WETH_BROKEN"); }
    function transfer(address, uint256) external pure returns (bool) { return false; }
    receive() external payable {}
}

/// @dev Contract that rejects ETH (for testing execution failure)
contract ETHRejecter {
    receive() external payable {
        revert("no ETH");
    }
}

contract CommunityGrantsTest is Test {
    MockVEGrants public ve;
    CommunityGrants public grants;
    MockTokenGrants public token;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public artist = makeAddr("artist");
    address public treasury = makeAddr("treasury");

    MockWETHGrants public wethMock;

    function setUp() public {
        token = new MockTokenGrants();
        ve = new MockVEGrants();
        wethMock = new MockWETHGrants();
        grants = new CommunityGrants(address(ve), address(token), treasury, address(wethMock));

        ve.setPower(alice, 20_000 ether);
        ve.setPower(bob, 10_000 ether);
        ve.setPower(carol, 30_000 ether);

        token.transfer(alice, 200_000 ether);
        token.transfer(bob, 200_000 ether);

        vm.prank(alice);
        token.approve(address(grants), type(uint256).max);
        vm.prank(bob);
        token.approve(address(grants), type(uint256).max);
        token.approve(address(grants), type(uint256).max);

        vm.deal(address(grants), 10 ether);
        token.transfer(address(grants), 200_000 ether);
    }

    // ===== PROPOSAL CREATION WITH FEE SPLIT (50% to feeReceiver, 50% held) =====

    function test_createProposal_feeSplit() public {
        uint256 aliceBefore = token.balanceOf(alice);
        uint256 treasuryBefore = token.balanceOf(treasury);
        uint256 contractBefore = token.balanceOf(address(grants));

        vm.prank(alice);
        grants.createProposal(artist, 1 ether, "Commission new meme art");

        // Alice pays full 42,069
        assertEq(token.balanceOf(alice), aliceBefore - 42_069 ether);
        // Treasury gets 50% (non-refundable)
        assertEq(token.balanceOf(treasury), treasuryBefore + 42_069 ether / 2);
        // Contract holds the other 50% (refundable on rejection)
        assertEq(token.balanceOf(address(grants)), contractBefore + (42_069 ether - 42_069 ether / 2));
        assertEq(grants.totalFeesCollected(), 42_069 ether);
    }

    function test_createProposal_snapshotBlock() public {
        vm.prank(alice);
        grants.createProposal(artist, 1 ether, "Test");

        (,,,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Active));
    }

    // ===== VOTING WITH SNAPSHOT BLOCK =====

    function test_voteFor() public {
        grants.createProposal(artist, 1 ether, "Art grant");

        vm.prank(alice);
        grants.voteOnProposal(0, true);

        (,,,,uint256 votesFor, uint256 votesAgainst,,,,) = grants.getProposal(0);
        assertEq(votesFor, 20_000 ether);
        assertEq(votesAgainst, 0);
    }

    function test_voteAgainst() public {
        grants.createProposal(artist, 1 ether, "Bad proposal");

        vm.prank(bob);
        grants.voteOnProposal(0, false);

        (,,,,uint256 votesFor, uint256 votesAgainst,,,,) = grants.getProposal(0);
        assertEq(votesFor, 0);
        assertEq(votesAgainst, 10_000 ether);
    }

    function test_revert_voteTwice() public {
        grants.createProposal(artist, 1 ether, "Test");

        vm.prank(alice);
        grants.voteOnProposal(0, true);

        vm.prank(alice);
        vm.expectRevert(CommunityGrants.AlreadyVoted.selector);
        grants.voteOnProposal(0, true);
    }

    function test_revert_voteNoVotingPower() public {
        grants.createProposal(artist, 1 ether, "Test");

        address nopower = makeAddr("nopower");
        vm.prank(nopower);
        vm.expectRevert(CommunityGrants.NoVotingPower.selector);
        grants.voteOnProposal(0, true);
    }

    // ===== QUORUM CHECK (revert when totalBoostedStake == 0) =====

    function test_revert_finalize_zeroTotalVotingPower() public {
        // SECURITY FIX: quorum now uses snapshotTotalStake from creation time.
        // Zero out all power BEFORE creating the proposal so snapshot captures 0.
        ve.setPower(alice, 0);
        ve.setPower(bob, 0);
        ve.setPower(carol, 0);
        // totalLocked is now 0

        grants.createProposal(artist, 1 ether, "Test quorum");
        // snapshotTotalStake == 0

        // Restore power so alice can vote (votingPowerAt mock returns current power)
        ve.setPower(alice, 10_000 ether);

        vm.prank(alice);
        grants.voteOnProposal(0, true);

        vm.warp(block.timestamp + 8 days);

        // snapshotTotalStake == 0 should cause QuorumNotMet
        vm.expectRevert(CommunityGrants.QuorumNotMet.selector);
        grants.finalizeProposal(0);
    }

    function test_revert_finalizeQuorumNotMet_lowTurnout() public {
        ve.setPower(makeAddr("whale"), 1_000_000 ether);

        grants.createProposal(artist, 1 ether, "Low turnout");

        vm.prank(bob);
        grants.voteOnProposal(0, true);

        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(CommunityGrants.QuorumNotMet.selector);
        grants.finalizeProposal(0);
    }

    // ===== REJECTION REFUND WORKS (50% returned) =====

    function test_finalizeRejected_refunds50pct() public {
        vm.prank(alice);
        grants.createProposal(artist, 1 ether, "Bad proposal");

        vm.prank(bob);
        grants.voteOnProposal(0, true);
        vm.prank(carol);
        grants.voteOnProposal(0, false);

        uint256 aliceBefore = token.balanceOf(alice);
        vm.warp(block.timestamp + 8 days);
        grants.finalizeProposal(0);

        (,,,,,,,CommunityGrants.ProposalStatus status,,) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Rejected));

        // 50% refund of 42,069 TOWELI
        assertEq(token.balanceOf(alice) - aliceBefore, 42_069 ether / 2);
    }

    // ===== EXECUTE ONLY AFTER APPROVAL =====

    function test_executeProposal() public {
        grants.createProposal(artist, 1 ether, "Pay the artist");

        vm.prank(alice);
        grants.voteOnProposal(0, true);
        vm.warp(block.timestamp + 8 days);
        grants.finalizeProposal(0);

        uint256 artistBefore = artist.balance;
        grants.executeProposal(0);

        assertEq(artist.balance - artistBefore, 1 ether);
        assertEq(grants.totalGranted(), 1 ether);

        (,,,,,,,CommunityGrants.ProposalStatus status,,) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Executed));
    }

    function test_revert_executeNotApproved() public {
        grants.createProposal(artist, 1 ether, "Rejected");
        vm.prank(alice);
        grants.voteOnProposal(0, false);
        vm.warp(block.timestamp + 8 days);
        grants.finalizeProposal(0);

        vm.expectRevert(CommunityGrants.NotApproved.selector);
        grants.executeProposal(0);
    }

    function test_revert_executeActiveProposal() public {
        grants.createProposal(artist, 1 ether, "Still active");

        vm.expectRevert(CommunityGrants.NotApproved.selector);
        grants.executeProposal(0);
    }

    function test_execute_failedExecution_thenRetry() public {
        ETHRejecter rejecter = new ETHRejecter();
        grants.createProposal(address(rejecter), 1 ether, "Will fail");
        vm.prank(alice);
        grants.voteOnProposal(0, true);
        vm.warp(block.timestamp + 8 days);
        grants.finalizeProposal(0);

        grants.executeProposal(0);

        (,,,,,,,CommunityGrants.ProposalStatus status,,) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.FailedExecution));

        // Retry also fails
        grants.retryExecution(0);
        (,,,,,,,status,,) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.FailedExecution));
    }

    // ===== CANCEL =====

    function test_cancelProposal_byOwner() public {
        grants.createProposal(artist, 1 ether, "Cancel me");
        grants.cancelProposal(0);

        (,,,,,,,CommunityGrants.ProposalStatus status,,) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Cancelled));
    }

    function test_cancelProposal_byProposer() public {
        vm.prank(alice);
        grants.createProposal(artist, 1 ether, "Cancel me");

        vm.prank(alice);
        grants.cancelProposal(0);

        (,,,,,,,CommunityGrants.ProposalStatus status,,) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Cancelled));
    }

    function test_revert_cancelByUnauthorized() public {
        grants.createProposal(artist, 1 ether, "Test");

        vm.prank(bob);
        vm.expectRevert(CommunityGrants.NotAuthorized.selector);
        grants.cancelProposal(0);
    }

    // ===== PAUSABLE =====

    function test_pause_blocksCreateProposal() public {
        grants.pause();
        vm.prank(alice);
        vm.expectRevert();
        grants.createProposal(artist, 1 ether, "Paused");
    }

    function test_pause_blocksVoting() public {
        grants.createProposal(artist, 1 ether, "Test");
        grants.pause();
        vm.prank(alice);
        vm.expectRevert();
        grants.voteOnProposal(0, true);
    }

    // ===== PROPOSER CANNOT BE RECIPIENT =====

    function test_createProposal_reverts_when_proposer_is_recipient() public {
        vm.prank(alice);
        vm.expectRevert("PROPOSER_CANNOT_BE_RECIPIENT");
        grants.createProposal(alice, 1 ether, "Self-grant attempt");
    }

    // ===== PROPOSAL COOLDOWN =====

    function test_createProposal_reverts_during_cooldown() public {
        vm.prank(alice);
        grants.createProposal(artist, 1 ether, "First proposal");

        // Immediately try to create another proposal
        vm.prank(alice);
        vm.expectRevert("PROPOSAL_COOLDOWN_ACTIVE");
        grants.createProposal(artist, 1 ether, "Second proposal too soon");
    }

    function test_createProposal_succeeds_after_cooldown() public {
        vm.prank(alice);
        grants.createProposal(artist, 1 ether, "First proposal");

        // Warp past the 1-day cooldown
        vm.warp(block.timestamp + 1 days);

        vm.prank(alice);
        grants.createProposal(artist, 1 ether, "Second proposal after cooldown");

        assertEq(grants.proposalCount(), 2);
    }

    function test_createProposal_cooldown_per_proposer() public {
        vm.prank(alice);
        grants.createProposal(artist, 1 ether, "Alice proposal");

        // Bob should be able to create immediately (different proposer)
        vm.prank(bob);
        grants.createProposal(artist, 1 ether, "Bob proposal");

        assertEq(grants.proposalCount(), 2);
    }

    // ===== E-07: ROLLING TREASURY DEPLETION LIMIT =====

    function _createVoteFinalize(address _recipient, uint256 _amount, string memory _desc) internal returns (uint256 id) {
        id = grants.proposalCount();
        grants.createProposal(_recipient, _amount, _desc);
        vm.prank(carol);
        grants.voteOnProposal(id, true);
        vm.warp(block.timestamp + 8 days);
        grants.finalizeProposal(id);
    }

    function test_rollingLimit_blocksSerialDrain() public {
        vm.deal(address(grants), 100 ether);

        // t=1: Create and vote on first grant
        grants.createProposal(artist, 25 ether, "Grant 1");
        vm.prank(carol);
        grants.voteOnProposal(0, true);

        // t=8d+1: Finalize and execute first grant
        uint256 t1 = 8 days + 1;
        vm.warp(t1);
        grants.finalizeProposal(0);
        grants.executeProposal(0);

        // t=10d+1: Create and vote on second grant
        uint256 t2 = t1 + 2 days;
        vm.warp(t2);
        grants.createProposal(artist, 10 ether, "Grant 2");
        vm.prank(carol);
        grants.voteOnProposal(1, true);

        // t=18d+1: Finalize second grant
        uint256 t3 = t2 + 8 days;
        vm.warp(t3);
        grants.finalizeProposal(1);

        // Second execute should fail: 25 + 10 > 30% of 75 ETH (22.5)
        vm.expectRevert(CommunityGrants.RollingDisbursementExceeded.selector);
        grants.executeProposal(1);
    }

    function test_rollingLimit_resetsAfterWindow() public {
        vm.deal(address(grants), 100 ether);

        uint256 id0 = _createVoteFinalize(artist, 20 ether, "Grant 1");
        grants.executeProposal(id0);

        vm.warp(block.timestamp + 31 days);

        uint256 id1 = _createVoteFinalize(artist, 20 ether, "Grant 2");
        grants.executeProposal(id1);

        assertEq(grants.totalGranted(), 40 ether);
    }

    receive() external payable {}
}
