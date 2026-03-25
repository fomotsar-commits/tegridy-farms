// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/MemeBountyBoard.sol";

contract MockToweli is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MemeBountyBoardTest is Test {
    MemeBountyBoard public board;
    MockToweli public token;
    address public creator = makeAddr("creator");
    address public artist1 = makeAddr("artist1");
    address public artist2 = makeAddr("artist2");
    address public voter1 = makeAddr("voter1");
    address public voter2 = makeAddr("voter2");
    address public voter3 = makeAddr("voter3");

    function setUp() public {
        token = new MockToweli();
        board = new MemeBountyBoard(address(token));
        vm.deal(creator, 10 ether);
        vm.deal(address(this), 10 ether);

        // Give voters enough TOWELI to meet MIN_VOTE_BALANCE
        token.transfer(voter1, 10_000 ether);
        token.transfer(voter2, 10_000 ether);
        token.transfer(voter3, 10_000 ether);
    }

    // ─── Create Bounty ────────────────────────────────────────────────

    function test_createBounty() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Create a dank meme", block.timestamp + 7 days);

        assertEq(board.bountyCount(), 1);
        (address c,, uint256 reward, uint256 deadline,,,,) = board.getBounty(0);
        assertEq(c, creator);
        assertEq(reward, 1 ether);
        assertGt(deadline, block.timestamp);
    }

    function test_revert_createBounty_tooSmall() public {
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.InsufficientReward.selector);
        board.createBounty{value: 0.0001 ether}("Cheap bounty", block.timestamp + 1 days);
    }

    function test_revert_createBounty_pastDeadline() public {
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.DeadlinePassed.selector);
        board.createBounty{value: 1 ether}("Late", block.timestamp - 1);
    }

    // ─── Submit Work ──────────────────────────────────────────────────

    function test_submitWork() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Meme contest", block.timestamp + 7 days);

        vm.prank(artist1);
        board.submitWork(0, "ipfs://Qm123abc");

        (address submitter, string memory uri, uint256 votes) = board.getSubmission(0, 0);
        assertEq(submitter, artist1);
        assertEq(uri, "ipfs://Qm123abc");
        assertEq(votes, 0);
        assertEq(board.submissionCount(0), 1);
    }

    function test_multipleSubmissions() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);

        vm.prank(artist1);
        board.submitWork(0, "ipfs://submission1");
        vm.prank(artist2);
        board.submitWork(0, "ipfs://submission2");

        assertEq(board.submissionCount(0), 2);
    }

    function test_revert_submitAfterDeadline() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 1 days);

        vm.warp(block.timestamp + 2 days);

        vm.prank(artist1);
        vm.expectRevert(MemeBountyBoard.DeadlinePassed.selector);
        board.submitWork(0, "ipfs://late");
    }

    // ─── Voting ───────────────────────────────────────────────────────

    function test_voteForSubmission() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);
        vm.prank(artist1);
        board.submitWork(0, "ipfs://art");

        vm.prank(voter1);
        board.voteForSubmission(0, 0);

        (,, uint256 votes) = board.getSubmission(0, 0);
        assertEq(votes, 1);
    }

    function test_revert_voteDoubl() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);
        vm.prank(artist1);
        board.submitWork(0, "ipfs://art");

        vm.prank(voter1);
        board.voteForSubmission(0, 0);

        vm.prank(voter1);
        vm.expectRevert(MemeBountyBoard.AlreadyVoted.selector);
        board.voteForSubmission(0, 0);
    }

    // ─── Complete Bounty ──────────────────────────────────────────────

    function test_completeBounty() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);

        vm.prank(artist1);
        board.submitWork(0, "ipfs://winner");
        vm.prank(artist2);
        board.submitWork(0, "ipfs://loser");

        // Vote for artist1
        vm.prank(voter1);
        board.voteForSubmission(0, 0);
        vm.prank(voter2);
        board.voteForSubmission(0, 0);
        // One vote for artist2
        vm.prank(voter3);
        board.voteForSubmission(0, 1);

        vm.warp(block.timestamp + 8 days);

        uint256 balBefore = artist1.balance;
        vm.prank(creator);
        board.completeBounty(0);
        uint256 balAfter = artist1.balance;

        assertEq(balAfter - balBefore, 1 ether);
        assertEq(board.totalPaidOut(), 1 ether);
    }

    function test_revert_completeBeforeDeadline() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);
        vm.prank(artist1);
        board.submitWork(0, "ipfs://art");

        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.DeadlineNotPassed.selector);
        board.completeBounty(0);
    }

    function test_revert_completeNoSubmissions() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);

        vm.warp(block.timestamp + 8 days);

        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.NoSubmissions.selector);
        board.completeBounty(0);
    }

    function test_revert_completeByRandom() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);
        vm.prank(artist1);
        board.submitWork(0, "ipfs://art");

        vm.warp(block.timestamp + 8 days);

        vm.prank(voter1); // Not creator or owner
        vm.expectRevert(MemeBountyBoard.NotCreator.selector);
        board.completeBounty(0);
    }

    // ─── Cancel Bounty ────────────────────────────────────────────────

    function test_cancelBounty_byCreator() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Cancel me", block.timestamp + 7 days);

        uint256 balBefore = creator.balance;
        vm.prank(creator);
        board.cancelBounty(0);
        uint256 balAfter = creator.balance;

        assertEq(balAfter - balBefore, 1 ether); // Refunded
    }

    function test_cancelBounty_byOwner() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Cancel me", block.timestamp + 7 days);

        board.cancelBounty(0); // Owner (test contract)

        (,,,,,,MemeBountyBoard.BountyStatus status,) = board.getBounty(0);
        assertEq(uint256(status), uint256(MemeBountyBoard.BountyStatus.Cancelled));
    }

    function test_revert_cancelByRandom() public {
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Contest", block.timestamp + 7 days);

        vm.prank(voter1);
        vm.expectRevert(MemeBountyBoard.NotCreatorOrOwner.selector);
        board.cancelBounty(0);
    }

    receive() external payable {}
}
