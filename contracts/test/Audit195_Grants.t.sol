// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/CommunityGrants.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

// ─── Mocks ──────────────────────────────────────────────────────────────────

contract MockToken195 is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev Mock VE that supports per-timestamp snapshots
contract MockVE195 {
    mapping(address => uint256) public powers;
    mapping(address => mapping(uint256 => uint256)) public powerAtTs;
    mapping(address => bool) public hasSnapshot;
    uint256 public totalLocked;

    function setPower(address user, uint256 power) external {
        totalLocked = totalLocked - powers[user] + power;
        powers[user] = power;
    }

    /// @dev Set power for a specific timestamp snapshot
    function setPowerAtTimestamp(address user, uint256 ts, uint256 power) external {
        powerAtTs[user][ts] = power;
        hasSnapshot[user] = true;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return powers[user];
    }

    function votingPowerAt(address user, uint256) external view returns (uint256) {
        return powers[user];
    }

    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256) {
        if (hasSnapshot[user]) {
            return powerAtTs[user][ts];
        }
        return powers[user];
    }

    function totalBoostedStake() external view returns (uint256) {
        return totalLocked;
    }

    function userTokenId(address user) external pure returns (uint256) {
        // AUDIT NEW-G7 mock convenience: non-zero per-address default so proposers
        // automatically satisfy the new ProposerMissingStakingPointer guard.
        return uint256(uint160(user));
    }

    function holdsToken(address user, uint256 tokenId) external pure returns (bool) {
        return uint256(uint160(user)) == tokenId;
    }
}

/// @dev Mock WETH that reverts on deposit — ensures both ETH and WETH paths fail for FailedExecution tests
contract MockWETH195Grants {
    function deposit() external payable { revert("WETH_BROKEN"); }
    function transfer(address, uint256) external pure returns (bool) { return false; }
    receive() external payable {}
}

/// @dev ETH-rejecting contract for testing FailedExecution
contract ETHRejecter195 {
    receive() external payable {
        revert("no ETH");
    }
}

/// @dev ETH-accepting contract
contract ETHAccepter195 {
    receive() external payable {}
}

// ─── Test Contract ──────────────────────────────────────────────────────────

contract Audit195Grants is Test {
    MockVE195 public ve;
    CommunityGrants public grants;
    MockToken195 public token;

    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public dave = makeAddr("dave");
    address public artist = makeAddr("artist");
    address public treasury = makeAddr("treasury");
    address public owner;

    uint256 constant PROPOSAL_FEE = 42_069 ether;
    uint256 constant VOTING_PERIOD = 7 days;
    uint256 constant EXECUTION_DEADLINE = 30 days;
    uint256 constant PERMISSIONLESS_DELAY = 3 days;
    uint256 constant ROLLING_WINDOW = 30 days;

    MockWETH195Grants public wethMock;

    function setUp() public {
        owner = address(this);
        token = new MockToken195();
        ve = new MockVE195();
        wethMock = new MockWETH195Grants();
        grants = new CommunityGrants(address(ve), address(token), treasury, address(wethMock));

        // Set up voting power (>= MIN_ABSOLUTE_QUORUM=1000e18 each)
        ve.setPower(alice, 20_000 ether);
        ve.setPower(bob, 10_000 ether);
        ve.setPower(carol, 30_000 ether);
        ve.setPower(dave, 5_000 ether);

        // Distribute tokens for proposal fees
        token.transfer(alice, 500_000 ether);
        token.transfer(bob, 500_000 ether);
        token.transfer(carol, 500_000 ether);
        token.transfer(dave, 500_000 ether);

        // Approve spending
        vm.prank(alice);
        token.approve(address(grants), type(uint256).max);
        vm.prank(bob);
        token.approve(address(grants), type(uint256).max);
        vm.prank(carol);
        token.approve(address(grants), type(uint256).max);
        vm.prank(dave);
        token.approve(address(grants), type(uint256).max);

        // Fund the grants contract with ETH
        vm.deal(address(grants), 100 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    function _createProposal(address proposer, address recipient, uint256 amount) internal returns (uint256) {
        vm.prank(proposer);
        grants.createProposal(recipient, amount, "Test grant");
        return grants.proposalCount() - 1;
    }

    function _voteFor(uint256 id, address voter) internal {
        vm.prank(voter);
        grants.voteOnProposal(id, true);
    }

    function _voteAgainst(uint256 id, address voter) internal {
        vm.prank(voter);
        grants.voteOnProposal(id, false);
    }

    function _finalizeProposal(uint256 id) internal {
        grants.finalizeProposal(id);
    }

    function _createAndApprove(address proposer, address recipient, uint256 amount) internal returns (uint256) {
        uint256 id = _createProposal(proposer, recipient, amount);
        // Get the proposal deadline
        (,,,,,, uint256 deadline,,,) = grants.getProposal(id);
        // Advance past voting delay (1 day)
        vm.warp(block.timestamp + 1 days + 1);
        // Vote in favor with 3 unique voters (MIN_UNIQUE_VOTERS=3), excluding proposer
        if (proposer != bob) _voteFor(id, bob);
        else _voteFor(id, alice);
        if (proposer != carol) _voteFor(id, carol);
        else _voteFor(id, dave);
        if (proposer != dave) _voteFor(id, dave);
        else _voteFor(id, alice);
        // Advance past voting deadline
        vm.warp(deadline + 1);
        _finalizeProposal(id);
        // Advance past execution delay (1 day) so owner can execute
        vm.warp(deadline + 1 days + 1);
        return id;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  1. ROLLING 30-DAY TREASURY LIMIT
    // ═══════════════════════════════════════════════════════════════════════

    function test_rollingLimit_singleDisbursement() public {
        // 30% of 100 ETH = 30 ETH max per rolling window
        uint256 id = _createAndApprove(alice, artist, 1 ether);
        grants.executeProposal(id);
        // Should succeed since 1 < 30
    }

    function test_rollingLimit_exceedsWindow() public {
        // Create and execute proposals up to the rolling limit
        uint256 id1 = _createAndApprove(alice, artist, 25 ether);
        grants.executeProposal(id1);

        // Need cooldown for alice
        vm.warp(block.timestamp + 1 days + 1);

        // Second proposal: balance is now ~75 ETH, 30% = 22.5 ETH
        // But rolling disbursed is already 25 ETH, so anything should fail
        uint256 id2 = _createAndApprove(alice, artist, 1 ether);
        vm.expectRevert(CommunityGrants.RollingDisbursementExceeded.selector);
        grants.executeProposal(id2);
    }

    function test_rollingLimit_resetsAfter30Days() public {
        uint256 id1 = _createAndApprove(alice, artist, 25 ether);
        grants.executeProposal(id1);

        // Wait 31 days for rolling window to expire
        vm.warp(block.timestamp + 31 days);

        // Now the window is fresh; balance is ~75 ETH, 30% = 22.5 ETH
        uint256 id2 = _createAndApprove(alice, artist, 10 ether);
        grants.executeProposal(id2);
        // Should succeed after window reset
    }

    function test_rollingLimit_multipleSmallWithinWindow() public {
        // Execute multiple small proposals within the rolling window
        // Use all four proposers to avoid cooldown issues entirely
        uint256 id1 = _createAndApprove(alice, artist, 5 ether);
        grants.executeProposal(id1);

        uint256 id2 = _createAndApprove(bob, artist, 5 ether);
        grants.executeProposal(id2);

        uint256 id3 = _createAndApprove(dave, artist, 5 ether);
        grants.executeProposal(id3);

        // Total disbursed in window: 15 ETH. Balance ~85 ETH. 30% of 85 = 25.5. 15 < 25.5, OK.
        // Use alice again -- enough time has passed (3x 7-day voting periods = 21 days > 1 day cooldown)
        uint256 id4 = _createAndApprove(alice, artist, 5 ether);
        grants.executeProposal(id4);
        // Total: 20 ETH. Balance ~80 ETH. 30% of 80 = 24 ETH. 20 < 24. OK.
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  2. PROPOSAL LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    function test_lifecycle_create() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        (address proposer, address recipient, uint256 amount,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(id);
        assertEq(proposer, alice);
        assertEq(recipient, artist);
        assertEq(amount, 1 ether);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Active));
        assertEq(grants.activeProposalCount(), 1);
    }

    function test_lifecycle_vote() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.warp(block.timestamp + 1 days + 1);
        _voteFor(id, carol);
        (,,,, uint256 votesFor,,,,,) = grants.getProposal(id);
        assertEq(votesFor, 30_000 ether);
    }

    function test_lifecycle_finalize_approved() public {
        uint256 id = _createAndApprove(alice, artist, 1 ether);
        (,,,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(id);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Approved));
    }

    function test_lifecycle_finalize_rejected() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.warp(block.timestamp + 1 days + 1);
        _voteAgainst(id, carol);
        _voteAgainst(id, bob);
        _voteAgainst(id, dave);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        uint256 proposerBalBefore = token.balanceOf(alice);
        _finalizeProposal(id);

        (,,,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(id);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Rejected));

        // 50% refund on rejection
        uint256 refund = PROPOSAL_FEE / 2;
        assertEq(token.balanceOf(alice) - proposerBalBefore, refund);
        assertEq(grants.activeProposalCount(), 0);
    }

    function test_lifecycle_execute() public {
        uint256 id = _createAndApprove(alice, artist, 1 ether);
        uint256 balBefore = artist.balance;
        grants.executeProposal(id);
        assertEq(artist.balance - balBefore, 1 ether);

        (,,,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(id);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Executed));
        assertEq(grants.activeProposalCount(), 0);
    }

    function test_lifecycle_lapse() public {
        uint256 id = _createAndApprove(alice, artist, 1 ether);
        uint256 approvedPendingBefore = grants.totalApprovedPending();
        assertEq(approvedPendingBefore, 1 ether);

        // Create another proposal so totalRefundableDeposits has balance for lapse decrement
        // (finalizeProposal already decrements totalRefundableDeposits on approval)
        _createProposal(bob, artist, 0.01 ether);

        // Advance past execution deadline (from proposal deadline)
        (,,,,,, uint256 deadline,,,) = grants.getProposal(id);
        vm.warp(deadline + EXECUTION_DEADLINE + 1);

        grants.lapseProposal(id);
        (,,,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(id);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Rejected));
        assertEq(grants.totalApprovedPending(), 0);
    }

    function test_lifecycle_cancel_byProposer() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.prank(alice);
        grants.cancelProposal(id);

        (,,,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(id);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Cancelled));
        assertEq(grants.activeProposalCount(), 0);
    }

    function test_lifecycle_cancel_byOwner() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        grants.cancelProposal(id); // owner = address(this)

        (,,,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(id);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Cancelled));
    }

    function test_lifecycle_cancel_unauthorizedReverts() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.prank(bob);
        vm.expectRevert(CommunityGrants.NotAuthorized.selector);
        grants.cancelProposal(id);
    }

    function test_lifecycle_failedExecution_retry() public {
        ETHRejecter195 rejecter = new ETHRejecter195();
        uint256 id = _createAndApprove(alice, address(rejecter), 1 ether);

        // Execute fails
        grants.executeProposal(id);
        (,,,,,,, CommunityGrants.ProposalStatus status1,,) = grants.getProposal(id);
        assertEq(uint256(status1), uint256(CommunityGrants.ProposalStatus.FailedExecution));

        // Retry also fails with rejecter
        grants.retryExecution(id);
        (,,,,,,, CommunityGrants.ProposalStatus status2,,) = grants.getProposal(id);
        assertEq(uint256(status2), uint256(CommunityGrants.ProposalStatus.FailedExecution));
    }

    function test_lifecycle_failedExecution_lapse() public {
        ETHRejecter195 rejecter = new ETHRejecter195();
        uint256 id = _createAndApprove(alice, address(rejecter), 1 ether);

        grants.executeProposal(id);
        (,,,,,,, CommunityGrants.ProposalStatus status1,,) = grants.getProposal(id);
        assertEq(uint256(status1), uint256(CommunityGrants.ProposalStatus.FailedExecution));

        // Create another proposal so totalRefundableDeposits has balance for lapse decrement
        _createProposal(bob, artist, 0.01 ether);

        // Advance past execution deadline -- can lapse FailedExecution too
        (,,,,,, uint256 deadline,,,) = grants.getProposal(id);
        vm.warp(deadline + EXECUTION_DEADLINE + 1);
        grants.lapseProposal(id);

        (,,,,,,, CommunityGrants.ProposalStatus status2,,) = grants.getProposal(id);
        assertEq(uint256(status2), uint256(CommunityGrants.ProposalStatus.Rejected));
        assertEq(grants.totalApprovedPending(), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  3. VOTING POWER SNAPSHOT TIMING
    // ═══════════════════════════════════════════════════════════════════════

    function test_snapshot_usesTimestampMinus1() public {
        // Set dave's power at current timestamp to 50k, but at timestamp-1 to 0
        uint256 now_ = block.timestamp;
        ve.setPowerAtTimestamp(dave, now_ - 1, 0);
        ve.setPowerAtTimestamp(dave, now_, 50_000 ether);

        uint256 id = _createProposal(alice, artist, 1 ether);

        // Advance past voting delay
        vm.warp(block.timestamp + 1 days + 1);

        // Dave should have 0 power at snapshot (timestamp - 1)
        vm.prank(dave);
        vm.expectRevert(CommunityGrants.NoVotingPower.selector);
        grants.voteOnProposal(id, true);
    }

    function test_snapshot_powerBeforeCreation() public {
        // Set bob's power at snapshot time to a specific value
        uint256 now_ = block.timestamp;
        ve.setPowerAtTimestamp(bob, now_ - 1, 7_777 ether);

        uint256 id = _createProposal(alice, artist, 1 ether);

        // Advance past voting delay
        vm.warp(block.timestamp + 1 days + 1);

        _voteFor(id, bob);
        (,,,, uint256 votesFor,,,,,) = grants.getProposal(id);
        assertEq(votesFor, 7_777 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  4. FEE HANDLING -- 50% REFUND ON REJECTION
    // ═══════════════════════════════════════════════════════════════════════

    function test_fee_splitOnCreation() public {
        uint256 treasuryBefore = token.balanceOf(treasury);
        uint256 contractBefore = token.balanceOf(address(grants));

        _createProposal(alice, artist, 1 ether);

        uint256 nonRefundable = PROPOSAL_FEE / 2;
        uint256 refundable = PROPOSAL_FEE - nonRefundable;

        assertEq(token.balanceOf(treasury) - treasuryBefore, nonRefundable, "treasury gets 50%");
        assertEq(token.balanceOf(address(grants)) - contractBefore, refundable, "contract holds 50%");
        assertEq(grants.totalRefundableDeposits(), refundable);
        assertEq(grants.totalFeesCollected(), PROPOSAL_FEE);
    }

    function test_fee_refundOnRejection() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.warp(block.timestamp + 1 days + 1);
        _voteAgainst(id, carol);
        _voteAgainst(id, bob);
        _voteAgainst(id, dave);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        uint256 aliceBefore = token.balanceOf(alice);
        _finalizeProposal(id);

        uint256 refund = PROPOSAL_FEE - PROPOSAL_FEE / 2;
        assertEq(token.balanceOf(alice) - aliceBefore, refund, "50% refunded on rejection");
        assertEq(grants.totalRefundableDeposits(), 0, "refundable deposits zeroed");
    }

    function test_fee_noRefundOnApproval() public {
        uint256 id = _createAndApprove(alice, artist, 1 ether);

        // SECURITY FIX: totalRefundableDeposits is NOT decremented at approval time.
        // Deposit stays reserved until execution or lapse to prevent sweep() draining it.
        assertGt(grants.totalRefundableDeposits(), 0, "deposit still reserved after approval");
    }

    function test_fee_refundOnCancel() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        uint256 aliceBefore = token.balanceOf(alice);

        vm.prank(alice);
        grants.cancelProposal(id);

        uint256 refund = PROPOSAL_FEE - PROPOSAL_FEE / 2;
        assertEq(token.balanceOf(alice) - aliceBefore, refund, "50% refunded on cancel");
        assertEq(grants.totalRefundableDeposits(), 0);
    }

    function test_fee_refundOnLapse() public {
        uint256 id = _createAndApprove(alice, artist, 1 ether);

        // Create another proposal so totalRefundableDeposits has balance for lapse decrement
        _createProposal(bob, artist, 0.01 ether);

        (,,,,,, uint256 deadline,,,) = grants.getProposal(id);
        vm.warp(deadline + EXECUTION_DEADLINE + 1);
        uint256 aliceBefore = token.balanceOf(alice);
        grants.lapseProposal(id);

        uint256 refund = PROPOSAL_FEE - PROPOSAL_FEE / 2;
        assertEq(token.balanceOf(alice) - aliceBefore, refund, "50% refunded on lapse");
    }

    function test_fee_sweepProtectsRefundable() public {
        _createProposal(alice, artist, 1 ether);
        uint256 refundable = grants.totalRefundableDeposits();

        // Send extra TOWELI to contract
        token.transfer(address(grants), 100_000 ether);

        uint256 contractBal = token.balanceOf(address(grants));
        uint256 expectedSweepable = contractBal - refundable;

        uint256 treasuryBefore = token.balanceOf(treasury);
        grants.sweepFees();

        assertEq(token.balanceOf(treasury) - treasuryBefore, expectedSweepable);
        // Contract should still hold the refundable portion
        assertGe(token.balanceOf(address(grants)), refundable);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  5. QUORUM CALCULATION
    // ═══════════════════════════════════════════════════════════════════════

    function test_quorum_requiresMinAbsolute() public {
        // Set very low power so percentage passes but absolute fails
        MockVE195 lowVE = new MockVE195();
        MockToken195 lowToken = new MockToken195();
        CommunityGrants lowGrants = new CommunityGrants(address(lowVE), address(lowToken), treasury, address(wethMock));

        lowVE.setPower(alice, 500 ether); // Below MIN_ABSOLUTE_QUORUM (1000e18)
        lowVE.setPower(bob, 200 ether);
        lowVE.setPower(carol, 200 ether);
        lowVE.setPower(dave, 100 ether);

        lowToken.transfer(alice, 200_000 ether);
        vm.prank(alice);
        lowToken.approve(address(lowGrants), type(uint256).max);
        vm.deal(address(lowGrants), 10 ether);

        vm.prank(alice);
        lowGrants.createProposal(artist, 0.01 ether, "Test");

        // Advance past voting delay
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(bob);
        lowGrants.voteOnProposal(0, true);
        vm.prank(carol);
        lowGrants.voteOnProposal(0, true);
        vm.prank(dave);
        lowGrants.voteOnProposal(0, true);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        // 500 ether votes, totalStake = 1000 ether. 500/1000 = 50% > 10%. But 500 < MIN_ABSOLUTE_QUORUM (1000e18)
        vm.expectRevert(CommunityGrants.QuorumNotMet.selector);
        lowGrants.finalizeProposal(0);
    }

    function test_quorum_requiresPercentage() public {
        // Low percentage of total stake voted
        // total stake = 65k, need 10% = 6500e18 votes minimum
        // We need 3 unique voters with combined power < 6500e18
        address lowVoter1 = makeAddr("lowVoter1");
        address lowVoter2 = makeAddr("lowVoter2");
        ve.setPower(lowVoter1, 1 ether);
        ve.setPower(lowVoter2, 1 ether);

        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.warp(block.timestamp + 1 days + 1);
        _voteFor(id, dave); // 5000 ether power
        _voteFor(id, lowVoter1); // 1 ether
        _voteFor(id, lowVoter2); // 1 ether
        // Total: ~5002 ether, 5002/65002 = 7.7% < 10%

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        vm.expectRevert(CommunityGrants.QuorumNotMet.selector);
        _finalizeProposal(id);
    }

    function test_quorum_zeroTotalStakeReverts() public {
        // Deploy with zero-stake VE
        MockVE195 zeroVE = new MockVE195();
        MockToken195 zToken = new MockToken195();
        CommunityGrants zGrants = new CommunityGrants(address(zeroVE), address(zToken), treasury, address(wethMock));

        zeroVE.setPower(alice, 0);
        zToken.transfer(alice, 200_000 ether);
        vm.prank(alice);
        zToken.approve(address(zGrants), type(uint256).max);
        vm.deal(address(zGrants), 10 ether);

        // totalBoostedStake is 0 at creation, so snapshotTotalStake = 0
        vm.prank(alice);
        zGrants.createProposal(artist, 0.01 ether, "Test");

        // Can't vote with 0 power, so skip to finalize
        vm.warp(block.timestamp + 1 days + VOTING_PERIOD + 1);

        // Should revert because snapshotTotalStake == 0
        vm.expectRevert(CommunityGrants.QuorumNotMet.selector);
        zGrants.finalizeProposal(0);
    }

    function test_quorum_usesSnapshotTotalStake() public {
        // totalBoostedStake at creation = 65k. After creation, add huge stake.
        uint256 id = _createProposal(alice, artist, 1 ether);

        // Increase totalStake massively after proposal creation
        ve.setPower(makeAddr("whale"), 1_000_000 ether);

        // Advance past voting delay
        vm.warp(block.timestamp + 1 days + 1);

        // Need 3 unique voters (MIN_UNIQUE_VOTERS=3)
        // Carol's 30k should still pass quorum against snapshotted 65k (46% > 10%)
        _voteFor(id, carol);
        _voteFor(id, bob);
        _voteFor(id, dave);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        _finalizeProposal(id); // Should succeed because snapshot is 65k not 1.065M
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  6. totalApprovedPending TRACKING
    // ═══════════════════════════════════════════════════════════════════════

    function test_approvedPending_incrementsOnApproval() public {
        uint256 id = _createAndApprove(alice, artist, 2 ether);
        assertEq(grants.totalApprovedPending(), 2 ether);
    }

    function test_approvedPending_decrementsOnExecution() public {
        uint256 id = _createAndApprove(alice, artist, 2 ether);
        grants.executeProposal(id);
        assertEq(grants.totalApprovedPending(), 0);
    }

    function test_approvedPending_decrementsOnLapse() public {
        uint256 id = _createAndApprove(alice, artist, 2 ether);
        // Create another proposal so totalRefundableDeposits has balance for lapse decrement
        _createProposal(bob, artist, 0.01 ether);
        (,,,,,, uint256 deadline,,,) = grants.getProposal(id);
        vm.warp(deadline + EXECUTION_DEADLINE + 1);
        grants.lapseProposal(id);
        assertEq(grants.totalApprovedPending(), 0);
    }

    function test_approvedPending_notDecrementedOnFailedExecution() public {
        ETHRejecter195 rejecter = new ETHRejecter195();
        uint256 id = _createAndApprove(alice, address(rejecter), 1 ether);

        // Execute fails
        grants.executeProposal(id);
        // totalApprovedPending should STILL be 1 ether (not decremented on failure)
        assertEq(grants.totalApprovedPending(), 1 ether, "pending should remain after failed exec");
    }

    function test_approvedPending_serialDrainPrevention() public {
        // Create two proposals that together exceed balance
        // Balance = 100 ETH, 50% cap = 50 ETH per proposal
        uint256 id1 = _createAndApprove(alice, artist, 40 ether);
        // Now totalApprovedPending = 40, available = 100 - 40 = 60, cap = 30
        // So a second proposal requesting > 30 should fail at creation
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(alice);
        vm.expectRevert(CommunityGrants.AmountTooLarge.selector);
        grants.createProposal(artist, 31 ether, "Too much");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  7. TIMESTAMP-BASED VOTING
    // ═══════════════════════════════════════════════════════════════════════

    function test_voting_cannotVoteAfterDeadline() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.warp(block.timestamp + 1 days + VOTING_PERIOD + 1);

        vm.prank(carol);
        vm.expectRevert(CommunityGrants.VotingEnded.selector);
        grants.voteOnProposal(id, true);
    }

    function test_voting_canVoteAtDeadline() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        (,,,,,, uint256 deadline,,,) = grants.getProposal(id);
        // deadline is createdAt + 7 days, which is > createdAt + 1 day (voting delay)
        vm.warp(deadline); // exactly at deadline (past voting delay)

        _voteFor(id, carol); // Should succeed (block.timestamp <= deadline)
    }

    function test_voting_cannotVoteTwice() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.warp(block.timestamp + 1 days + 1);
        _voteFor(id, carol);

        vm.prank(carol);
        vm.expectRevert(CommunityGrants.AlreadyVoted.selector);
        grants.voteOnProposal(id, true);
    }

    function test_voting_cannotFinalizeBeforeDeadline() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.warp(block.timestamp + 1 days + 1);
        _voteFor(id, carol);

        vm.expectRevert(CommunityGrants.VotingNotEnded.selector);
        _finalizeProposal(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  8. PROPOSER COOLDOWN
    // ═══════════════════════════════════════════════════════════════════════

    function test_cooldown_blocksImmediateSecondProposal() public {
        _createProposal(alice, artist, 1 ether);

        // Immediately try to create another
        vm.prank(alice);
        vm.expectRevert("PROPOSAL_COOLDOWN_ACTIVE");
        grants.createProposal(artist, 1 ether, "Second");
    }

    function test_cooldown_allowsAfterPeriod() public {
        _createProposal(alice, artist, 1 ether);

        vm.warp(block.timestamp + 1 days + 1);
        _createProposal(alice, artist, 1 ether); // Should succeed
        assertEq(grants.proposalCount(), 2);
    }

    function test_cooldown_perProposer() public {
        _createProposal(alice, artist, 1 ether);
        // Bob should be able to create immediately
        _createProposal(bob, artist, 1 ether);
        assertEq(grants.proposalCount(), 2);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  9. SELF-RECIPIENT BLOCK
    // ═══════════════════════════════════════════════════════════════════════

    function test_selfRecipient_blocked() public {
        vm.prank(alice);
        vm.expectRevert("PROPOSER_CANNOT_BE_RECIPIENT");
        grants.createProposal(alice, 1 ether, "Self grant");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  10. OWNER IMMEDIATE EXECUTION
    // ═══════════════════════════════════════════════════════════════════════

    function test_ownerExecution_immediate() public {
        uint256 id = _createAndApprove(alice, artist, 1 ether);

        // Owner can execute immediately (no delay)
        uint256 balBefore = artist.balance;
        grants.executeProposal(id);
        assertEq(artist.balance - balBefore, 1 ether);
    }

    function test_nonOwnerExecution_requiresDelay() public {
        uint256 id = _createAndApprove(alice, artist, 1 ether);

        // Non-owner cannot execute immediately
        vm.prank(bob);
        vm.expectRevert("EXECUTION_DELAY_NOT_MET");
        grants.executeProposal(id);
    }

    function test_nonOwnerExecution_succeedsAfterDelay() public {
        uint256 id = _createAndApprove(alice, artist, 1 ether);

        // Advance past permissionless delay (3 days after voting ends)
        // Voting already ended, so warp 3 more days
        vm.warp(block.timestamp + PERMISSIONLESS_DELAY);

        uint256 balBefore = artist.balance;
        vm.prank(bob);
        grants.executeProposal(id);
        assertEq(artist.balance - balBefore, 1 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  11. PROPOSER CANNOT VOTE (M-29)
    // ═══════════════════════════════════════════════════════════════════════

    function test_proposerCannotVote() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        vm.expectRevert("PROPOSER_CANNOT_VOTE");
        grants.voteOnProposal(id, true);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  12. EXECUTION DEADLINE ENFORCEMENT (H-03)
    // ═══════════════════════════════════════════════════════════════════════

    function test_executionDeadline_expired() public {
        uint256 id = _createAndApprove(alice, artist, 1 ether);

        // Advance well past execution deadline
        vm.warp(block.timestamp + EXECUTION_DEADLINE + 1);

        vm.expectRevert(CommunityGrants.ExecutionDeadlineExpired.selector);
        grants.executeProposal(id);
    }

    function test_executionDeadline_retryAlsoEnforced() public {
        ETHRejecter195 rejecter = new ETHRejecter195();
        uint256 id = _createAndApprove(alice, address(rejecter), 1 ether);
        grants.executeProposal(id); // Fails

        // Advance past execution deadline
        vm.warp(block.timestamp + EXECUTION_DEADLINE + 1);

        vm.expectRevert(CommunityGrants.ExecutionDeadlineExpired.selector);
        grants.retryExecution(id);
    }

    function test_lapseProposal_cannotLapseBeforeDeadline() public {
        uint256 id = _createAndApprove(alice, artist, 1 ether);

        vm.expectRevert(CommunityGrants.ExecutionDeadlineNotExpired.selector);
        grants.lapseProposal(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  13. MAX ACTIVE PROPOSALS (M-13)
    // ═══════════════════════════════════════════════════════════════════════

    function test_maxActiveProposals_cap() public {
        // Create 50 proposals using dynamically created proposers to avoid cooldown and balance issues
        // Each proposal costs ~42,069 TOWELI
        for (uint256 i = 0; i < 50; i++) {
            address p = address(uint160(0xBEEF0000 + i));
            token.transfer(p, PROPOSAL_FEE + 1 ether);
            vm.startPrank(p);
            token.approve(address(grants), type(uint256).max);
            grants.createProposal(artist, 0.01 ether, "Test");
            vm.stopPrank();
        }

        assertEq(grants.activeProposalCount(), 50);

        // 51st proposal should fail
        address p51 = address(uint160(0xBEEF0000 + 50));
        token.transfer(p51, PROPOSAL_FEE + 1 ether);
        vm.startPrank(p51);
        token.approve(address(grants), type(uint256).max);
        vm.expectRevert("TOO_MANY_ACTIVE_PROPOSALS");
        grants.createProposal(artist, 0.01 ether, "One too many");
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  14. DESCRIPTION LENGTH LIMIT
    // ═══════════════════════════════════════════════════════════════════════

    function test_descriptionTooLong() public {
        // 2001 bytes should fail
        bytes memory longDesc = new bytes(2001);
        for (uint256 i = 0; i < 2001; i++) {
            longDesc[i] = "A";
        }
        vm.prank(alice);
        vm.expectRevert("DESC_TOO_LONG");
        grants.createProposal(artist, 0.01 ether, string(longDesc));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  15. MAX GRANT PERCENT (H-04)
    // ═══════════════════════════════════════════════════════════════════════

    function test_maxGrantPercent_creation() public {
        // Balance is 100 ETH, 50% cap = 50 ETH
        vm.prank(alice);
        vm.expectRevert(CommunityGrants.AmountTooLarge.selector);
        grants.createProposal(artist, 51 ether, "Too large");
    }

    function test_maxGrantPercent_atExecution() public {
        // Create proposal within both 50% cap and 30% rolling limit
        // Balance = 100 ETH, 50% cap = 50 ETH, 30% rolling = 30 ETH
        uint256 id = _createAndApprove(alice, artist, 29 ether);
        grants.executeProposal(id);
        assertEq(grants.totalGranted(), 29 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  16. FEE RECEIVER TIMELOCK
    // ═══════════════════════════════════════════════════════════════════════

    function test_feeReceiverTimelock_normalFlow() public {
        address newReceiver = makeAddr("newReceiver");
        grants.proposeFeeReceiver(newReceiver);

        // Cannot execute before timelock
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, grants.FEE_RECEIVER_CHANGE()));
        grants.executeFeeReceiverChange();

        // Advance past timelock
        vm.warp(block.timestamp + 48 hours);
        grants.executeFeeReceiverChange();
        assertEq(grants.feeReceiver(), newReceiver);
    }

    function test_feeReceiverTimelock_expires() public {
        address newReceiver = makeAddr("newReceiver");
        grants.proposeFeeReceiver(newReceiver);

        // Advance past timelock + 7 days
        vm.warp(block.timestamp + 48 hours + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, grants.FEE_RECEIVER_CHANGE()));
        grants.executeFeeReceiverChange();
    }

    function test_feeReceiverTimelock_cancel() public {
        address newReceiver = makeAddr("newReceiver");
        grants.proposeFeeReceiver(newReceiver);
        grants.cancelFeeReceiverChange();
        assertEq(grants.pendingFeeReceiver(), address(0));
    }

    function test_feeReceiverTimelock_cannotProposeTwice() public {
        grants.proposeFeeReceiver(makeAddr("r1"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, grants.FEE_RECEIVER_CHANGE()));
        grants.proposeFeeReceiver(makeAddr("r2"));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  17. EMERGENCY RECOVERY
    // ═══════════════════════════════════════════════════════════════════════

    function test_emergencyRecover_protectsApprovedPending() public {
        uint256 id = _createAndApprove(alice, artist, 30 ether);
        // totalApprovedPending = 30 ETH. Balance = 100 ETH. Withdrawable = 70 ETH.
        grants.pause();

        address payable recipient = payable(makeAddr("recovery"));
        grants.emergencyRecoverETH(recipient);

        assertEq(recipient.balance, 70 ether);
        assertEq(address(grants).balance, 30 ether);
    }

    function test_emergencyRecover_requiresPaused() public {
        address payable recipient = payable(makeAddr("recovery"));
        vm.expectRevert();
        grants.emergencyRecoverETH(recipient);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  18. PAUSED STATE BLOCKS OPERATIONS
    // ═══════════════════════════════════════════════════════════════════════

    function test_paused_blocksCreate() public {
        grants.pause();
        vm.prank(alice);
        vm.expectRevert();
        grants.createProposal(artist, 1 ether, "Paused");
    }

    function test_paused_blocksVote() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.warp(block.timestamp + 1 days + 1);
        grants.pause();

        vm.prank(carol);
        vm.expectRevert();
        grants.voteOnProposal(id, true);
    }

    function test_paused_blocksFinalize() public {
        uint256 id = _createProposal(alice, artist, 1 ether);
        vm.warp(block.timestamp + 1 days + 1);
        _voteFor(id, carol);
        _voteFor(id, bob);
        _voteFor(id, dave);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        grants.pause();

        vm.expectRevert();
        grants.finalizeProposal(id);
    }

    function test_paused_blocksExecute() public {
        uint256 id = _createAndApprove(alice, artist, 1 ether);
        grants.pause();

        vm.expectRevert();
        grants.executeProposal(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  19. ZERO ADDRESS CHECKS
    // ═══════════════════════════════════════════════════════════════════════

    function test_zeroAddress_recipientBlocked() public {
        vm.prank(alice);
        vm.expectRevert(CommunityGrants.ZeroAddress.selector);
        grants.createProposal(address(0), 1 ether, "Zero");
    }

    function test_zeroAddress_constructorBlocked() public {
        vm.expectRevert(CommunityGrants.ZeroAddress.selector);
        new CommunityGrants(address(0), address(token), treasury, address(wethMock));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  20. MINIMUM PROPOSAL AMOUNT
    // ═══════════════════════════════════════════════════════════════════════

    function test_minAmount_tooSmall() public {
        vm.prank(alice);
        vm.expectRevert(CommunityGrants.AmountTooSmall.selector);
        grants.createProposal(artist, 0.001 ether, "Tiny");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  21. ROLLING DISBURSEMENT PRUNING CORRECTNESS
    // ═══════════════════════════════════════════════════════════════════════

    function test_rollingPrune_removesExpiredEntries() public {
        // Execute a proposal
        uint256 id1 = _createAndApprove(alice, artist, 1 ether);
        grants.executeProposal(id1);
        assertEq(grants.rollingDisbursed(), 1 ether);

        // Warp past the rolling window
        vm.warp(block.timestamp + ROLLING_WINDOW + 1 days + 1);

        // Execute another -- the prune should clear the first entry
        uint256 id2 = _createAndApprove(alice, artist, 1 ether);
        grants.executeProposal(id2);
        // rollingDisbursed should be 1 ether (only the second), not 2
        assertEq(grants.rollingDisbursed(), 1 ether, "old disbursement pruned");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  22. ACTIVE PROPOSAL COUNT BOOKKEEPING
    // ═══════════════════════════════════════════════════════════════════════

    function test_activeCount_failedExecStillCounts() public {
        ETHRejecter195 rejecter = new ETHRejecter195();
        uint256 id = _createAndApprove(alice, address(rejecter), 1 ether);
        assertEq(grants.activeProposalCount(), 1);

        grants.executeProposal(id); // Fails
        // FailedExecution still counts as active (hasn't been resolved)
        assertEq(grants.activeProposalCount(), 1, "failed exec still active");
    }

    function test_activeCount_decrementedOnAllTerminalStates() public {
        // Test each terminal state decrements activeProposalCount
        // Use different proposers to avoid cooldown issues

        // Rejection
        uint256 id1 = _createProposal(alice, artist, 1 ether);
        vm.warp(block.timestamp + 1 days + 1);
        _voteAgainst(id1, carol);
        _voteAgainst(id1, bob);
        _voteAgainst(id1, dave);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        _finalizeProposal(id1);
        assertEq(grants.activeProposalCount(), 0, "rejected -> 0");

        // Cancellation (use bob)
        uint256 id2 = _createProposal(bob, artist, 1 ether);
        assertEq(grants.activeProposalCount(), 1);
        vm.prank(bob);
        grants.cancelProposal(id2);
        assertEq(grants.activeProposalCount(), 0, "cancelled -> 0");

        // Execution (use dave, enough cooldown time already from voting warp)
        uint256 id3 = _createAndApprove(dave, artist, 1 ether);
        assertEq(grants.activeProposalCount(), 1);
        grants.executeProposal(id3);
        assertEq(grants.activeProposalCount(), 0, "executed -> 0");

        // Lapse (use alice, enough time has passed)
        uint256 id4 = _createAndApprove(alice, artist, 1 ether);
        assertEq(grants.activeProposalCount(), 1);
        // Create another proposal so totalRefundableDeposits has balance for lapse decrement
        _createProposal(bob, artist, 0.01 ether);
        (,,,,,, uint256 deadline4,,,) = grants.getProposal(id4);
        vm.warp(deadline4 + EXECUTION_DEADLINE + 1);
        grants.lapseProposal(id4);
        assertEq(grants.activeProposalCount(), 1, "lapsed -> 1 (bob's proposal still active)");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  23. RECEIVE ETH
    // ═══════════════════════════════════════════════════════════════════════

    function test_receiveETH() public {
        uint256 before_ = address(grants).balance;
        vm.deal(address(this), 5 ether);
        (bool ok,) = address(grants).call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(address(grants).balance - before_, 5 ether);
    }
}
