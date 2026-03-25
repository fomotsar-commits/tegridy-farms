// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/CommunityGrants.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev Mock that implements IVotingEscrowGrants interface
contract MockVE {
    mapping(address => uint256) public powers;
    uint256 public totalLocked;

    function setPower(address user, uint256 power) external {
        totalLocked = totalLocked - powers[user] + power;
        powers[user] = power;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return powers[user];
    }
}

contract CommunityGrantsTest is Test {
    MockVE public ve;
    CommunityGrants public grants;
    MockToken public token;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public artist = makeAddr("artist");
    address public treasury = makeAddr("treasury");

    function setUp() public {
        token = new MockToken();
        ve = new MockVE();
        grants = new CommunityGrants(address(ve), address(token), treasury);

        // Set voting power
        ve.setPower(alice, 20_000 ether);
        ve.setPower(bob, 10_000 ether);

        token.transfer(alice, 100_000 ether);
        token.transfer(bob, 100_000 ether);

        // Approve grants contract to take proposal fees
        vm.prank(alice);
        token.approve(address(grants), type(uint256).max);
        vm.prank(bob);
        token.approve(address(grants), type(uint256).max);
        token.approve(address(grants), type(uint256).max);

        // Fund the grant vault
        vm.deal(address(grants), 10 ether);
    }

    function test_createProposal() public {
        uint256 aliceBefore = token.balanceOf(alice);
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.prank(alice);
        grants.createProposal(artist, 1 ether, "Commission new meme art");

        assertEq(grants.proposalCount(), 1);
        (,address recipient, uint256 amount, string memory desc,,,,) = grants.getProposal(0);
        assertEq(recipient, artist);
        assertEq(amount, 1 ether);
        assertEq(desc, "Commission new meme art");

        assertEq(token.balanceOf(alice), aliceBefore - 42_069 ether);
        assertEq(token.balanceOf(treasury), treasuryBefore + 42_069 ether);
        assertEq(grants.totalFeesCollected(), 42_069 ether);
    }

    function test_voteFor() public {
        grants.createProposal(artist, 1 ether, "Art grant");

        vm.prank(alice);
        grants.voteOnProposal(0, true);

        (,,,,uint256 votesFor, uint256 votesAgainst,,) = grants.getProposal(0);
        assertGt(votesFor, 0);
        assertEq(votesAgainst, 0);
    }

    function test_voteAgainst() public {
        grants.createProposal(artist, 1 ether, "Bad proposal");

        vm.prank(bob);
        grants.voteOnProposal(0, false);

        (,,,,uint256 votesFor, uint256 votesAgainst,,) = grants.getProposal(0);
        assertEq(votesFor, 0);
        assertGt(votesAgainst, 0);
    }

    function test_finalizeApproved() public {
        grants.createProposal(artist, 1 ether, "Good proposal");

        vm.prank(alice);
        grants.voteOnProposal(0, true);

        vm.prank(bob);
        grants.voteOnProposal(0, false);

        vm.warp(block.timestamp + 8 days);
        grants.finalizeProposal(0);

        (,,,,,,,CommunityGrants.ProposalStatus status) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Approved));
    }

    function test_finalizeRejected() public {
        grants.createProposal(artist, 1 ether, "Bad proposal");

        vm.prank(bob);
        grants.voteOnProposal(0, true);

        vm.prank(alice);
        grants.voteOnProposal(0, false);

        vm.warp(block.timestamp + 8 days);
        grants.finalizeProposal(0);

        (,,,,,,,CommunityGrants.ProposalStatus status) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Rejected));
    }

    function test_executeProposal() public {
        grants.createProposal(artist, 1 ether, "Pay the artist");

        vm.prank(alice);
        grants.voteOnProposal(0, true);

        vm.warp(block.timestamp + 8 days);
        grants.finalizeProposal(0);

        uint256 artistBalBefore = artist.balance;
        grants.executeProposal(0);
        uint256 artistBalAfter = artist.balance;

        assertEq(artistBalAfter - artistBalBefore, 1 ether);
        assertEq(grants.totalGranted(), 1 ether);
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

    function test_revert_voteTwice() public {
        grants.createProposal(artist, 1 ether, "Test");

        vm.prank(alice);
        grants.voteOnProposal(0, true);

        vm.prank(alice);
        vm.expectRevert(CommunityGrants.AlreadyVoted.selector);
        grants.voteOnProposal(0, true);
    }

    function test_revert_voteAfterDeadline() public {
        grants.createProposal(artist, 1 ether, "Test");
        vm.warp(block.timestamp + 8 days);

        vm.prank(alice);
        vm.expectRevert(CommunityGrants.VotingEnded.selector);
        grants.voteOnProposal(0, true);
    }

    function test_cancelProposal_byOwner() public {
        grants.createProposal(artist, 1 ether, "Cancel me");
        grants.cancelProposal(0);

        (,,,,,,,CommunityGrants.ProposalStatus status) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Cancelled));
    }

    function test_cancelProposal_byProposer() public {
        vm.prank(alice);
        grants.createProposal(artist, 1 ether, "Cancel me");

        vm.prank(alice);
        grants.cancelProposal(0);

        (,,,,,,,CommunityGrants.ProposalStatus status) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Cancelled));
    }

    function test_receiveETH() public {
        vm.deal(address(this), 5 ether);
        (bool ok,) = address(grants).call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(address(grants).balance, 15 ether);
    }

    receive() external payable {}
}
