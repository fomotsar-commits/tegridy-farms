// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/CommunityGrants.sol";

// ─── Minimal self-contained mocks (mirror contracts/test/CommunityGrants.t.sol) ───

contract MockTokenSL is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockVESL {
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

    function votingPowerAt(address user, uint256) external view returns (uint256) {
        return powers[user];
    }

    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) {
        return powers[user];
    }

    function totalBoostedStake() external view returns (uint256) {
        return totalLocked;
    }

    function userTokenId(address user) external view returns (uint256) {
        uint256 id = _userTokenId[user];
        return id == 0 ? uint256(uint160(user)) : id;
    }

    function holdsToken(address user, uint256 tokenId) external view returns (bool) {
        uint256 id = _userTokenId[user];
        uint256 effective = id == 0 ? uint256(uint160(user)) : id;
        return effective == tokenId;
    }

    function totalBoostedStakeAtTimestamp(uint256) external view returns (uint256) {
        return totalLocked;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 1;
    }
}

contract MockWETHSL {
    function deposit() external payable {
        revert("WETH_BROKEN");
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    receive() external payable {}
}

/// @notice AUDIT 2026-07-12 (MED): regression for the wedged-Active proposal.
///         A past-deadline Active proposal with >= MIN_UNIQUE_VOTERS voters but
///         below quorum can NEVER be approved by finalizeProposal (reverts
///         QuorumNotMet) and, pre-fix, could NOT be permissionlessly lapsed
///         (the guard only covered < MIN_UNIQUE_VOTERS). It was stuck Active,
///         locking a MAX_ACTIVE_PROPOSALS slot + the refundable deposit until an
///         owner/proposer cancelProposal. The fix broadens lapseStaleProposal to
///         clear ANY permanently-unapprovable proposal.
contract Audit20260712_StaleLapseTest is Test {
    MockVESL public ve;
    CommunityGrants public grants;
    MockTokenSL public token;
    MockWETHSL public wethMock;

    address public v1 = makeAddr("v1");
    address public v2 = makeAddr("v2");
    address public v3 = makeAddr("v3");
    address public artist = makeAddr("artist");
    address public treasury = makeAddr("treasury");

    function setUp() public {
        token = new MockTokenSL();
        ve = new MockVESL();
        wethMock = new MockWETHSL();
        grants = new CommunityGrants(address(ve), address(token), treasury, address(wethMock));

        // Three voters with SMALL power: combined 3000 ether < MIN_ABSOLUTE_QUORUM (4000 ether).
        // This is the natural low-turnout case: >= 3 unique voters, but below the
        // absolute quorum floor, so finalizeProposal can never approve.
        ve.setPower(v1, 1000 ether);
        ve.setPower(v2, 1000 ether);
        ve.setPower(v3, 1000 ether);
        ve.setUserTokenId(v1, 11);
        ve.setUserTokenId(v2, 12);
        ve.setUserTokenId(v3, 13);
        // Proposer is this test contract (never a voter, never the recipient).
        ve.setUserTokenId(address(this), 99);

        // Fund + approve the proposer (this contract) for the PROPOSAL_FEE.
        token.approve(address(grants), type(uint256).max);

        vm.deal(address(grants), 10 ether);
    }

    /// @dev Creates a proposal, casts 3 below-quorum "for" votes, warps past
    ///      deadline + EXECUTION_DEADLINE, and returns the proposal id.
    function _wedgeProposal() internal returns (uint256 id) {
        grants.createProposal(artist, 1 ether, "low-turnout grant");
        id = 0;

        vm.warp(block.timestamp + 1 days + 1); // past VOTING_DELAY

        vm.prank(v1);
        grants.voteOnProposal(id, true);
        vm.prank(v2);
        grants.voteOnProposal(id, true);
        vm.prank(v3);
        grants.voteOnProposal(id, true);

        // 3 unique voters, votesFor (3000e18) > votesAgainst (0), but totalVotes
        // (3000e18) < MIN_ABSOLUTE_QUORUM (4000e18) => finalize can never approve.
        // Warp past deadline (createdAt + 7d) + EXECUTION_DEADLINE (30d).
        vm.warp(block.timestamp + 31 days);
    }

    /// @dev The proposal genuinely cannot be approved: finalizeProposal reverts.
    function test_finalize_reverts_belowAbsoluteQuorum() public {
        uint256 id = _wedgeProposal();
        vm.expectRevert(CommunityGrants.QuorumNotMet.selector);
        grants.finalizeProposal(id);

        // Sanity: 3 unique voters recorded (so the OLD `< MIN_UNIQUE_VOTERS`
        // guard would have rejected lapseStaleProposal).
        assertEq(grants.proposalUniqueVoters(id), 3);
    }

    /// @dev FAILS on old behaviour (lapseStaleProposal reverts HAS_QUORUM_VOTERS
    ///      because it had >= MIN_UNIQUE_VOTERS); PASSES with the fix.
    function test_lapseStaleProposal_clearsWedgedBelowQuorum() public {
        uint256 id = _wedgeProposal();

        uint256 activeBefore = grants.activeProposalCount();
        uint256 refundableBefore = grants.totalRefundableDeposits();
        uint256 treasuryTokBefore = token.balanceOf(treasury);
        uint256 forfeit = grants.PROPOSAL_FEE() - grants.PROPOSAL_FEE() / 2;

        // Permissionless caller.
        address rando = makeAddr("rando");
        vm.prank(rando);
        grants.lapseStaleProposal(id);

        // Status flipped Active -> Rejected, slot freed.
        (,,,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(id);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Rejected), "status not Rejected");
        assertEq(grants.activeProposalCount(), activeBefore - 1, "slot not freed");

        // Full-forfeit-to-feeReceiver semantics + deposit accounting preserved.
        assertTrue(grants.depositRefunded(id), "deposit not marked consumed");
        assertEq(grants.totalRefundableDeposits(), refundableBefore - forfeit, "refundable not decremented");
        assertEq(token.balanceOf(treasury), treasuryTokBefore + forfeit, "forfeit not routed to feeReceiver");
    }

    /// @dev The original narrow case (< MIN_UNIQUE_VOTERS) still lapses — no regression.
    function test_lapseStaleProposal_stillClearsLowVoterCase() public {
        grants.createProposal(artist, 1 ether, "no-turnout grant");
        uint256 id = 0;
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(v1);
        grants.voteOnProposal(id, true); // single voter < MIN_UNIQUE_VOTERS
        vm.warp(block.timestamp + 38 days); // past deadline + EXECUTION_DEADLINE

        grants.lapseStaleProposal(id);
        (,,,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(id);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Rejected));
    }

    /// @dev A proposal that CAN be approved must NOT be lapse-able (guard holds).
    function test_lapseStaleProposal_rejectsApprovableProposal() public {
        // Give voters enough power to clear both absolute + bps quorum, votesFor > against.
        ve.setPower(v1, 5000 ether);
        ve.setPower(v2, 5000 ether);
        ve.setPower(v3, 5000 ether);

        grants.createProposal(artist, 1 ether, "well-supported grant");
        uint256 id = 0;
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(v1);
        grants.voteOnProposal(id, true);
        vm.prank(v2);
        grants.voteOnProposal(id, true);
        vm.prank(v3);
        grants.voteOnProposal(id, true);
        vm.warp(block.timestamp + 38 days);

        // This proposal is approvable -> lapseStaleProposal must revert.
        vm.expectRevert(bytes("PROPOSAL_CAN_APPROVE"));
        grants.lapseStaleProposal(id);

        // And finalize actually approves it.
        grants.finalizeProposal(id);
        (,,,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(id);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Approved));
    }
}
