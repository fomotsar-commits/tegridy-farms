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
    mapping(address => uint256) public _userTokenId;
    uint256 public totalLocked;

    function setPower(address user, uint256 power) external {
        totalLocked = totalLocked - powers[user] + power;
        powers[user] = power;
    }

    function setUserTokenId(address user, uint256 tokenId) external {
        _userTokenId[user] = tokenId;
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

    function userTokenId(address user) external view returns (uint256) {
        // AUDIT NEW-G7 mock convenience: when unset, return uint160(user) as a
        // per-address-unique non-zero default. Tests that never call setUserTokenId
        // still get a deterministic, collision-free tokenId, while explicitly-set
        // values continue to win.
        uint256 id = _userTokenId[user];
        return id == 0 ? uint256(uint160(user)) : id;
    }

    /// @notice Mock: emulate TegridyStaking.holdsToken for the NEW-G7 self-vote check.
    function holdsToken(address user, uint256 tokenId) external view returns (bool) {
        uint256 id = _userTokenId[user];
        uint256 effective = id == 0 ? uint256(uint160(user)) : id;
        return effective == tokenId;
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
    address public dave = makeAddr("dave");
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
        ve.setPower(dave, 5_000 ether);

        // AUDIT NEW-G7: proposers must have a non-zero userTokenId pointer at proposal
        // creation time (mirrors the post-fix real-world constraint: proposer must hold a
        // staking NFT pointed to by userTokenId). Assign unique synthetic token IDs to
        // every user that might propose in this suite.
        ve.setUserTokenId(alice, 1);
        ve.setUserTokenId(bob, 2);
        ve.setUserTokenId(carol, 3);
        ve.setUserTokenId(dave, 4);
        ve.setUserTokenId(address(this), 99);

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

    /// @dev Helper: warp past VOTING_DELAY then cast 3 "for" votes (alice, bob, carol) to meet MIN_UNIQUE_VOTERS.
    ///      Proposer must NOT be alice, bob, or carol (use address(this) as proposer).
    function _voteThreeFor(uint256 id) internal {
        vm.warp(block.timestamp + 1 days); // past VOTING_DELAY
        vm.prank(alice);
        grants.voteOnProposal(id, true);
        vm.prank(bob);
        grants.voteOnProposal(id, true);
        vm.prank(carol);
        grants.voteOnProposal(id, true);
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

        vm.warp(block.timestamp + 1 days); // past VOTING_DELAY
        vm.prank(alice);
        grants.voteOnProposal(0, true);

        (,,,,uint256 votesFor, uint256 votesAgainst,,,,) = grants.getProposal(0);
        assertEq(votesFor, 20_000 ether);
        assertEq(votesAgainst, 0);
    }

    function test_voteAgainst() public {
        grants.createProposal(artist, 1 ether, "Bad proposal");

        vm.warp(block.timestamp + 1 days); // past VOTING_DELAY
        vm.prank(bob);
        grants.voteOnProposal(0, false);

        (,,,,uint256 votesFor, uint256 votesAgainst,,,,) = grants.getProposal(0);
        assertEq(votesFor, 0);
        assertEq(votesAgainst, 10_000 ether);
    }

    function test_revert_voteTwice() public {
        grants.createProposal(artist, 1 ether, "Test");

        vm.warp(block.timestamp + 1 days); // past VOTING_DELAY
        vm.prank(alice);
        grants.voteOnProposal(0, true);

        vm.prank(alice);
        vm.expectRevert(CommunityGrants.AlreadyVoted.selector);
        grants.voteOnProposal(0, true);
    }

    function test_revert_voteNoVotingPower() public {
        grants.createProposal(artist, 1 ether, "Test");

        vm.warp(block.timestamp + 1 days); // past VOTING_DELAY
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
        ve.setPower(dave, 0);
        // totalLocked is now 0

        grants.createProposal(artist, 1 ether, "Test quorum");
        // snapshotTotalStake == 0

        // Restore power so alice can vote (votingPowerAt mock returns current power)
        ve.setPower(alice, 10_000 ether);

        vm.warp(block.timestamp + 1 days); // past VOTING_DELAY
        vm.prank(alice);
        grants.voteOnProposal(0, true);

        vm.warp(block.timestamp + 7 days + 1); // past voting deadline

        // snapshotTotalStake == 0 should cause QuorumNotMet
        vm.expectRevert(CommunityGrants.QuorumNotMet.selector);
        grants.finalizeProposal(0);
    }

    function test_revert_finalizeQuorumNotMet_lowTurnout() public {
        ve.setPower(makeAddr("whale"), 1_000_000 ether);

        grants.createProposal(artist, 1 ether, "Low turnout");

        vm.warp(block.timestamp + 1 days); // past VOTING_DELAY
        vm.prank(bob);
        grants.voteOnProposal(0, true);

        vm.warp(block.timestamp + 7 days + 1); // past voting deadline
        vm.expectRevert(CommunityGrants.QuorumNotMet.selector);
        grants.finalizeProposal(0);
    }

    // ===== REJECTION REFUND WORKS (50% returned) =====

    function test_finalizeRejected_refunds50pct() public {
        vm.prank(alice);
        grants.createProposal(artist, 1 ether, "Bad proposal");

        vm.warp(block.timestamp + 1 days); // past VOTING_DELAY
        vm.prank(bob);
        grants.voteOnProposal(0, true);
        vm.prank(carol);
        grants.voteOnProposal(0, false);
        vm.prank(dave);
        grants.voteOnProposal(0, false);

        uint256 aliceBefore = token.balanceOf(alice);
        vm.warp(block.timestamp + 7 days + 1); // past voting deadline
        grants.finalizeProposal(0);

        (,,,,,,,CommunityGrants.ProposalStatus status,,) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Rejected));

        // 50% refund of 42,069 TOWELI
        assertEq(token.balanceOf(alice) - aliceBefore, 42_069 ether / 2);
    }

    // ===== EXECUTE ONLY AFTER APPROVAL =====

    function test_executeProposal() public {
        grants.createProposal(artist, 1 ether, "Pay the artist");

        _voteThreeFor(0);
        vm.warp(block.timestamp + 7 days + 1); // past voting deadline
        grants.finalizeProposal(0);

        vm.warp(block.timestamp + 1 days); // past EXECUTION_DELAY
        uint256 artistBefore = artist.balance;
        grants.executeProposal(0);

        assertEq(artist.balance - artistBefore, 1 ether);
        assertEq(grants.totalGranted(), 1 ether);

        (,,,,,,,CommunityGrants.ProposalStatus status,,) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Executed));
    }

    function test_revert_executeNotApproved() public {
        grants.createProposal(artist, 1 ether, "Rejected");

        vm.warp(block.timestamp + 1 days); // past VOTING_DELAY
        vm.prank(alice);
        grants.voteOnProposal(0, false);
        vm.prank(bob);
        grants.voteOnProposal(0, false);
        vm.prank(carol);
        grants.voteOnProposal(0, false);
        vm.warp(block.timestamp + 7 days + 1); // past voting deadline
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
        _voteThreeFor(0);
        vm.warp(block.timestamp + 7 days + 1); // past voting deadline
        grants.finalizeProposal(0);

        vm.warp(block.timestamp + 1 days); // past EXECUTION_DELAY
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
        vm.warp(block.timestamp + 1 days); // past VOTING_DELAY
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
        _voteThreeFor(id);
        vm.warp(block.timestamp + 7 days + 1); // past voting deadline
        grants.finalizeProposal(id);
        vm.warp(block.timestamp + 1 days); // past EXECUTION_DELAY
    }

    function test_rollingLimit_blocksSerialDrain() public {
        vm.deal(address(grants), 100 ether);

        // t=1: Create first grant
        grants.createProposal(artist, 25 ether, "Grant 1");
        // t=1d+1: Vote (past VOTING_DELAY)
        vm.warp(1 days + 1);
        vm.prank(alice);
        grants.voteOnProposal(0, true);
        vm.prank(bob);
        grants.voteOnProposal(0, true);
        vm.prank(carol);
        grants.voteOnProposal(0, true);

        // t=8d+2: Finalize (past voting deadline)
        vm.warp(8 days + 2);
        grants.finalizeProposal(0);
        // t=9d+2: Execute (past EXECUTION_DELAY)
        vm.warp(9 days + 2);
        grants.executeProposal(0);

        // t=10d+2: Create second grant (past cooldown)
        vm.warp(10 days + 2);
        grants.createProposal(artist, 10 ether, "Grant 2");
        // t=11d+3: Vote on second grant (past VOTING_DELAY)
        vm.warp(11 days + 3);
        vm.prank(alice);
        grants.voteOnProposal(1, true);
        vm.prank(bob);
        grants.voteOnProposal(1, true);
        vm.prank(carol);
        grants.voteOnProposal(1, true);

        // t=18d+4: Finalize second grant (past voting deadline)
        vm.warp(18 days + 4);
        grants.finalizeProposal(1);
        // t=19d+4: Past EXECUTION_DELAY
        vm.warp(19 days + 4);

        // Second execute should fail: 25 + 10 > 30% of 75 ETH (22.5)
        vm.expectRevert(CommunityGrants.RollingDisbursementExceeded.selector);
        grants.executeProposal(1);
    }

    function test_rollingLimit_resetsAfterWindow() public {
        vm.deal(address(grants), 100 ether);

        // First grant: create, vote, finalize, execute
        grants.createProposal(artist, 20 ether, "Grant 1");
        vm.warp(1 days + 1);
        vm.prank(alice);
        grants.voteOnProposal(0, true);
        vm.prank(bob);
        grants.voteOnProposal(0, true);
        vm.prank(carol);
        grants.voteOnProposal(0, true);
        vm.warp(8 days + 2);
        grants.finalizeProposal(0);
        vm.warp(9 days + 2);
        grants.executeProposal(0);

        // Wait for rolling window to reset
        vm.warp(40 days);

        // Second grant: create, vote, finalize, execute
        grants.createProposal(artist, 20 ether, "Grant 2");
        vm.warp(41 days + 1);
        vm.prank(alice);
        grants.voteOnProposal(1, true);
        vm.prank(bob);
        grants.voteOnProposal(1, true);
        vm.prank(carol);
        grants.voteOnProposal(1, true);
        vm.warp(48 days + 2);
        grants.finalizeProposal(1);
        vm.warp(49 days + 2);
        grants.executeProposal(1);

        assertEq(grants.totalGranted(), 40 ether);
    }

    // ─── AUDIT NEW-G7: proposerTokenId=0 rejected at creation ──────────

    /// @notice AUDIT NEW-G7: if the proposer has no userTokenId pointer (e.g.
    ///         multi-NFT Safe whose pointer was overwritten, fully-restaked
    ///         address, or unstaked proposer), createProposal reverts with
    ///         `ProposerMissingStakingPointer`. The check closes the silent
    ///         self-vote bypass where a proposer could route an NFT to a
    ///         second controlled address and vote for their own grant.
    function test_NEWG7_createProposalRevertsOnZeroPointer() public {
        // Mock-convenience in this suite auto-fills userTokenId with
        // uint160(user) when unset, so every test address passes the new
        // guard by default. To trigger the revert we force the call to
        // return 0 via vm.mockCall, simulating a multi-NFT Safe whose
        // userTokenId pointer was overwritten to 0 by a later transfer-out.
        address noPointer = makeAddr("noPointer");
        ve.setPower(noPointer, 50_000 ether);
        vm.mockCall(
            address(ve),
            abi.encodeWithSelector(MockVEGrants.userTokenId.selector, noPointer),
            abi.encode(uint256(0))
        );

        token.transfer(noPointer, 100_000 ether);
        vm.prank(noPointer);
        token.approve(address(grants), type(uint256).max);

        vm.prank(noPointer);
        vm.expectRevert(CommunityGrants.ProposerMissingStakingPointer.selector);
        grants.createProposal(artist, 1 ether, "no-pointer attempt");
    }

    /// @notice AUDIT NEW-G7: happy path — a proposer WITH a non-zero pointer
    ///         can create proposals, and the stored `proposerTokenId`
    ///         matches what the self-vote check will compare against.
    function test_NEWG7_createProposalWithValidPointerSucceeds() public {
        vm.prank(alice); // alice's pointer was set to 1 in setUp
        grants.createProposal(artist, 1 ether, "with-pointer");
        uint256 id = 0; // first proposal — no other createProposal calls in this test
        // Proposal struct has 12 fields (address, address, uint256, string,
        // uint256, uint256, uint256, uint256, ProposalStatus, uint256, uint256,
        // uint256). Unpack all and assert the snapshotted pointer.
        (
            ,,,,,,,,,,, uint256 proposerTokenId
        ) = grants.proposals(id);
        assertEq(proposerTokenId, 1, "snapshotted pointer matches setUp value");
    }

    receive() external payable {}
}
