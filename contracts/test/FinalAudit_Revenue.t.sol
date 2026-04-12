// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/RevenueDistributor.sol";
import "../src/CommunityGrants.sol";
import "../src/MemeBountyBoard.sol";
import "../src/ReferralSplitter.sol";

// ──────────────────────────────────────────────────────────────────────
//  MOCK CONTRACTS
// ──────────────────────────────────────────────────────────────────────

contract FA_MockToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FA_MockVotingEscrow {
    mapping(address => uint256) public lockedAmounts;
    mapping(address => uint256) public lockEnds;
    uint256 public totalLockedVal;

    function setLock(address user, uint256 amount, uint256 end) external {
        if (lockedAmounts[user] == 0) {
            totalLockedVal += amount;
        } else {
            totalLockedVal = totalLockedVal - lockedAmounts[user] + amount;
        }
        lockedAmounts[user] = amount;
        lockEnds[user] = end;
    }

    function removeLock(address user) external {
        totalLockedVal -= lockedAmounts[user];
        lockedAmounts[user] = 0;
        lockEnds[user] = 0;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return lockedAmounts[user];
    }

    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) {
        return lockedAmounts[user];
    }

    function locks(address user) external view returns (uint256, uint256) {
        return (lockedAmounts[user], lockEnds[user]);
    }

    function totalLocked() external view returns (uint256) {
        return totalLockedVal;
    }

    function totalBoostedStake() external view returns (uint256) {
        return totalLockedVal;
    }

    function userTokenId(address user) external view returns (uint256) {
        return lockedAmounts[user] > 0 ? uint256(uint160(user)) : 0;
    }

    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256, uint256, uint256 _lockEnd,
        uint256, bool, int256, uint256, bool
    ) {
        address user = address(uint160(tokenId));
        amount = lockedAmounts[user];
        _lockEnd = lockEnds[user];
    }

    function paused() external pure returns (bool) {
        return false;
    }
}

contract FA_MockVEGrants {
    mapping(address => uint256) public powers;
    uint256 public totalLockedVal;
    uint256 public totalBoostedStakeVal;

    function setPower(address user, uint256 power) external {
        totalLockedVal = totalLockedVal - powers[user] + power;
        totalBoostedStakeVal = totalLockedVal;
        powers[user] = power;
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
    function totalLocked() external view returns (uint256) {
        return totalLockedVal;
    }
    function totalBoostedStake() external view returns (uint256) {
        return totalBoostedStakeVal;
    }

    function userTokenId(address user) external view returns (uint256) {
        return powers[user] > 0 ? uint256(uint160(user)) : 0;
    }
}

contract FA_MockStaking {
    mapping(address => uint256) public powers;

    function setPower(address user, uint256 power) external {
        powers[user] = power;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return powers[user];
    }
    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) {
        return powers[user];
    }
}

contract FA_MockRestaking {
    struct RestakeInfo {
        uint256 tokenId;
        uint256 positionAmount;
        uint256 boostedAmount;
        int256 bonusDebt;
        uint256 depositTime;
    }
    mapping(address => RestakeInfo) private _restakers;

    function setRestaker(address user, uint256 tokenId, uint256 positionAmount) external {
        _restakers[user] = RestakeInfo(tokenId, positionAmount, positionAmount, 0, block.timestamp);
    }

    function restakers(address user) external view returns (uint256, uint256, uint256, int256, uint256) {
        RestakeInfo memory info = _restakers[user];
        return (info.tokenId, info.positionAmount, info.boostedAmount, info.bonusDebt, info.depositTime);
    }
}

contract FA_MockWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }
    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
    receive() external payable {}
}

// ──────────────────────────────────────────────────────────────────────
//  FINAL AUDIT TEST CONTRACT
// ──────────────────────────────────────────────────────────────────────

contract FinalAuditRevenue is Test {
    FA_MockToken public token;
    FA_MockVotingEscrow public ve;
    FA_MockVEGrants public veGrants;
    FA_MockStaking public staking;
    FA_MockRestaking public restaking;
    FA_MockWETH public weth;

    RevenueDistributor public distributor;
    CommunityGrants public grants;
    MemeBountyBoard public bountyBoard;
    ReferralSplitter public splitter;

    address public owner;
    address public attacker = makeAddr("attacker");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public treasury = makeAddr("treasury");
    address public feeReceiver = makeAddr("feeReceiver");
    address public voter2 = makeAddr("voter2");
    address public voter3 = makeAddr("voter3");

    function setUp() public {
        // Start at a reasonable timestamp
        vm.warp(1_000_000);

        owner = address(this);

        token = new FA_MockToken();
        ve = new FA_MockVotingEscrow();
        veGrants = new FA_MockVEGrants();
        staking = new FA_MockStaking();
        restaking = new FA_MockRestaking();
        weth = new FA_MockWETH();

        distributor = new RevenueDistributor(address(ve), treasury, address(weth));
        grants = new CommunityGrants(address(veGrants), address(token), feeReceiver, address(weth));
        bountyBoard = new MemeBountyBoard(address(token), address(staking), address(weth));
        splitter = new ReferralSplitter(1000, address(staking), treasury, address(weth));

        splitter.setApprovedCaller(address(this), true);

        token.mint(attacker, 1_000_000 ether);
        token.mint(alice, 1_000_000 ether);
        token.mint(bob, 1_000_000 ether);
        token.mint(carol, 1_000_000 ether);

        vm.deal(address(distributor), 100 ether);
        vm.deal(address(grants), 100 ether);
        vm.deal(attacker, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ──────────────────────────────────────────────────────────────────
    //  HELPER FUNCTIONS
    // ──────────────────────────────────────────────────────────────────

    uint256 internal timeNow;

    function _advanceTime(uint256 secs) internal {
        timeNow = block.timestamp + secs;
        vm.warp(timeNow);
    }

    function _createDistributorEpochs(uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            vm.deal(address(distributor), address(distributor).balance + 1 ether);
            _advanceTime(4 hours + 1);
            distributor.distribute();
        }
    }

    // ================================================================
    //  1. REVENUE DISTRIBUTOR — claimUpTo + claim no duplicate
    // ================================================================

    // ================================================================
    //  2. REVENUE DISTRIBUTOR — claimUpTo + claim double-claim attempt
    // ================================================================

    /// @notice Verify that calling claimUpTo then claim does not double-claim.
    ///         Expected: DEFENDED — both use lastClaimedEpoch.
    function test_RevenueDistributor_ClaimUpToPlusClaimNoDuplicate() public {
        // Start fresh — set distributor balance to 0
        vm.deal(address(distributor), 0);

        ve.setLock(alice, 1000 ether, block.timestamp + 365 days);

        // Create 6 epochs (each adds 1 ETH)
        _createDistributorEpochs(6);

        uint256 balBefore = alice.balance;

        // claimUpTo first 3 epochs
        vm.prank(alice);
        distributor.claimUpTo(3);

        uint256 balAfterFirst = alice.balance;
        uint256 firstClaim = balAfterFirst - balBefore;
        assertGt(firstClaim, 0, "First claim should pay out");

        // claim remaining epochs
        vm.prank(alice);
        distributor.claim();

        uint256 balAfterSecond = alice.balance;
        uint256 secondClaim = balAfterSecond - balAfterFirst;
        assertGt(secondClaim, 0, "Second claim should pay out remaining");

        // Total claimed should equal total distributed across 6 epochs (1 ETH each, Alice is sole staker)
        uint256 totalClaimedByAlice = firstClaim + secondClaim;
        assertEq(totalClaimedByAlice, 6 ether, "Total claimed should be exactly 6 ETH");

        // A third claim should revert — nothing left
        vm.expectRevert(RevenueDistributor.NothingToClaim.selector);
        vm.prank(alice);
        distributor.claim();
    }

    // ================================================================
    //  3. REVENUE DISTRIBUTOR — WETH fallback in withdrawPending
    // ================================================================

    /// @notice Verify WETH fallback works when ETH rejects.
    ///         Expected: DEFENDED — falls back to WETH deposit + transfer.
    function test_RevenueDistributor_WETHFallbackWithdrawPending() public {
        // Deploy a contract that rejects ETH
        ETHRejecterFA rejecter = new ETHRejecterFA();

        // Setup: give the rejecter a lock
        ve.setLock(address(rejecter), 1000 ether, block.timestamp + 365 days);

        _createDistributorEpochs(4);

        // Claim — ETH transfer fails, should be credited to pendingWithdrawals
        vm.prank(address(rejecter));
        distributor.claim();

        uint256 pending = distributor.pendingWithdrawals(address(rejecter));
        assertGt(pending, 0, "Should have pending withdrawal");

        // withdrawPending — ETH transfer fails again, should use WETH fallback
        vm.prank(address(rejecter));
        distributor.withdrawPending();

        // Pending should be 0 now
        assertEq(distributor.pendingWithdrawals(address(rejecter)), 0, "Pending should be cleared");
        // WETH balance should have the amount
        assertGt(weth.balanceOf(address(rejecter)), 0, "Should have received WETH");
    }

    // ================================================================
    //  6. COMMUNITY GRANTS — Rolling window boundary timing attack
    // ================================================================

    /// @notice Verify the 30% rolling disbursement cap cannot be bypassed by timing.
    ///         The cap is 30% of current balance in any 30-day rolling window.
    ///         Expected: DEFENDED — rolling window correctly limits serial disbursements.
    function test_CommunityGrants_RollingWindowBoundaryTiming() public {
        veGrants.setPower(alice, 10000 ether);
        veGrants.setPower(bob, 10000 ether);
        veGrants.setPower(carol, 10000 ether);
        veGrants.setPower(voter2, 10000 ether);

        // Proposal 1: 25 ETH (25% of 100 ETH, under 50% cap)
        vm.startPrank(alice);
        token.approve(address(grants), 200_000 ether);
        grants.createProposal(bob, 25 ether, "Grant 1");
        vm.stopPrank();

        _advanceTime(1 days + 1);
        vm.prank(bob);
        grants.voteOnProposal(0, true);
        vm.prank(carol);
        grants.voteOnProposal(0, true);
        vm.prank(voter2);
        grants.voteOnProposal(0, true);

        _advanceTime(7 days + 1);
        grants.finalizeProposal(0);
        _advanceTime(1 days + 1);
        grants.executeProposal(0);
        // Disbursed 25 ETH. Balance = 75 ETH. Rolling total = 25.

        // Proposal 2: 5 ETH — small enough to create, but will push rolling over 30%
        _advanceTime(1 days + 1);
        vm.prank(alice);
        grants.createProposal(carol, 5 ether, "Grant 2");

        _advanceTime(1 days + 1);
        vm.prank(bob);
        grants.voteOnProposal(1, true);
        vm.prank(carol);
        grants.voteOnProposal(1, true);
        vm.prank(voter2);
        grants.voteOnProposal(1, true);

        _advanceTime(7 days + 1);
        grants.finalizeProposal(1);

        // Execute grant 2. Rolling limit: 30% of 75 ETH = 22.5 ETH.
        // Current rolling = 25 ETH (from grant 1 still in window). 25 + 5 = 30 > 22.5.
        vm.expectRevert(CommunityGrants.RollingDisbursementExceeded.selector);
        grants.executeProposal(1);

        // After execution deadline we can lapse or wait.
        // Instead, demonstrate that after the rolling window clears, we can execute.
        // But we must stay within the execution deadline (30 days from proposal.deadline).
        // proposal 1 deadline was ~8 days in. Proposal 2 deadline ~17 days in.
        // We are ~17 days into the test. Execution deadline = proposal.deadline + 30 days = ~47 days.
        // Rolling window = 30 days from first disbursement (~8 days in).
        // So we need to be at ~38 days to clear the rolling window, which is still < 47.
        _advanceTime(22 days); // Now ~39 days in. First disbursement at ~8 days is now > 30 days ago.

        // Now execute — rolling window cleared, within execution deadline
        grants.executeProposal(1);
    }

    // ================================================================
    //  7. COMMUNITY GRANTS — retryExecution multiple calls
    // ================================================================

    /// @notice Verify retryExecution cannot be called multiple times to drain funds.
    ///         Expected: DEFENDED — status changes to Executed on success.
    function test_CommunityGrants_RetryExecutionNoDrain() public {
        veGrants.setPower(alice, 10000 ether);
        veGrants.setPower(bob, 10000 ether);
        veGrants.setPower(carol, 10000 ether);
        veGrants.setPower(voter2, 10000 ether);

        vm.startPrank(alice);
        token.approve(address(grants), 100_000 ether);
        grants.createProposal(bob, 1 ether, "Test grant");
        vm.stopPrank();

        _advanceTime(1 days + 1);
        vm.prank(bob);
        grants.voteOnProposal(0, true);
        vm.prank(carol);
        grants.voteOnProposal(0, true);
        vm.prank(voter2);
        grants.voteOnProposal(0, true);

        _advanceTime(7 days + 1);
        grants.finalizeProposal(0);

        // Execute — should succeed
        _advanceTime(1 days + 1);
        grants.executeProposal(0);

        // Try retry — should revert because status is now Executed, not FailedExecution
        vm.expectRevert(CommunityGrants.NotFailedExecution.selector);
        grants.retryExecution(0);
    }

    // ================================================================
    //  8. COMMUNITY GRANTS — lapseProposal premature call
    // ================================================================

    /// @notice Verify lapseProposal cannot be called before execution deadline expires.
    ///         Expected: DEFENDED — ExecutionDeadlineNotExpired revert.
    function test_CommunityGrants_LapseProposalPremature() public {
        veGrants.setPower(alice, 10000 ether);
        veGrants.setPower(bob, 10000 ether);
        veGrants.setPower(carol, 10000 ether);
        veGrants.setPower(voter2, 10000 ether);

        vm.startPrank(alice);
        token.approve(address(grants), 100_000 ether);
        grants.createProposal(bob, 1 ether, "Test grant");
        vm.stopPrank();

        _advanceTime(1 days + 1);
        vm.prank(bob);
        grants.voteOnProposal(0, true);
        vm.prank(carol);
        grants.voteOnProposal(0, true);
        vm.prank(voter2);
        grants.voteOnProposal(0, true);

        _advanceTime(7 days + 1);
        grants.finalizeProposal(0);

        // Try to lapse immediately — should revert
        vm.expectRevert(CommunityGrants.ExecutionDeadlineNotExpired.selector);
        grants.lapseProposal(0);

        // Warp to just before deadline expires (30 days from voting deadline)
        _advanceTime(28 days);
        vm.expectRevert(CommunityGrants.ExecutionDeadlineNotExpired.selector);
        grants.lapseProposal(0);

        // Warp past deadline — should succeed
        _advanceTime(3 days);
        grants.lapseProposal(0);
    }

    // ================================================================
    //  9. COMMUNITY GRANTS — 50% cap + totalApprovedPending manipulation
    // ================================================================

    /// @notice Verify multiple approved proposals cannot drain beyond 50% per proposal.
    ///         Expected: DEFENDED — totalApprovedPending reduces available balance at creation time.
    function test_CommunityGrants_ApprovedPendingSerialDrain() public {
        veGrants.setPower(alice, 10000 ether);
        veGrants.setPower(bob, 10000 ether);
        veGrants.setPower(carol, 10000 ether);
        veGrants.setPower(voter2, 10000 ether);

        // Proposal 1: 20 ETH (20% of 100 ETH — under both 50% cap and 30% rolling cap)
        vm.startPrank(alice);
        token.approve(address(grants), 300_000 ether);
        grants.createProposal(bob, 20 ether, "Grant A");
        vm.stopPrank();

        _advanceTime(1 days + 1);
        vm.prank(bob);
        grants.voteOnProposal(0, true);
        vm.prank(carol);
        grants.voteOnProposal(0, true);
        vm.prank(voter2);
        grants.voteOnProposal(0, true);
        _advanceTime(7 days + 1);
        grants.finalizeProposal(0);
        // Approved — totalApprovedPending = 20

        // available = 100 - 20 = 80 ETH, 50% cap = 40 ETH
        // A 50 ETH second proposal should be rejected at creation (50 > 40)
        _advanceTime(1 days + 1);
        vm.prank(alice);
        vm.expectRevert(CommunityGrants.AmountTooLarge.selector);
        grants.createProposal(carol, 50 ether, "Grant B too large");

        // A 10 ETH proposal should be accepted (10/80 = 12.5% < 50%)
        _advanceTime(1 days + 1);
        vm.prank(alice);
        grants.createProposal(carol, 10 ether, "Grant B ok");

        _advanceTime(1 days + 1);
        vm.prank(bob);
        grants.voteOnProposal(1, true);
        vm.prank(carol);
        grants.voteOnProposal(1, true);
        vm.prank(voter2);
        grants.voteOnProposal(1, true);
        _advanceTime(7 days + 1);
        grants.finalizeProposal(1);
        // totalApprovedPending = 20 + 10 = 30

        // Execute proposal 0 (20 ETH). Rolling cap: 30% of 100 = 30. 20 < 30. OK.
        _advanceTime(1 days + 1);
        grants.executeProposal(0);
        // Balance = 80, totalApprovedPending = 10, rollingDisbursed = 20

        // Execute proposal 1 (10 ETH). Rolling cap: 30% of 80 = 24. 20+10=30 > 24. BLOCKED.
        // This proves the rolling cap + totalApprovedPending prevent serial drain
        vm.expectRevert(CommunityGrants.RollingDisbursementExceeded.selector);
        grants.executeProposal(1);
    }

    // ================================================================
    //  10. MEME BOUNTY BOARD — completeBounty front-run
    // ================================================================

    /// @notice Verify that only the creator can complete a bounty within grace period.
    ///         Expected: DEFENDED — non-creator must wait for grace period.
    function test_MemeBountyBoard_CompleteBountyFrontRun() public {
        staking.setPower(alice, 2000 ether);
        staking.setPower(bob, 5000 ether);
        staking.setPower(carol, 5000 ether);
        staking.setPower(voter2, 5000 ether);
        staking.setPower(voter3, 5000 ether);

        // Alice creates a bounty
        vm.prank(alice);
        bountyBoard.createBounty{value: 1 ether}("Make a meme", block.timestamp + 2 days);

        // Bob submits
        vm.prank(bob);
        bountyBoard.submitWork(0, "ipfs://meme1");

        // 3 unique voters needed for MIN_UNIQUE_VOTERS
        vm.prank(carol);
        bountyBoard.voteForSubmission(0, 0);
        vm.prank(voter2);
        bountyBoard.voteForSubmission(0, 0);
        vm.prank(voter3);
        bountyBoard.voteForSubmission(0, 0);

        // Past deadline + dispute period
        vm.warp(block.timestamp + 2 days + 2 days + 1);

        // Attacker tries to complete — should revert (grace period not expired)
        vm.expectRevert(MemeBountyBoard.GracePeriodNotExpired.selector);
        vm.prank(attacker);
        bountyBoard.completeBounty(0);

        // Creator (Alice) can complete
        vm.prank(alice);
        bountyBoard.completeBounty(0);
    }

    // ================================================================
    //  11. MEME BOUNTY BOARD — refundStaleBounty with valid winner
    // ================================================================

    /// @notice Verify refundStaleBounty reverts when a valid winner (quorum met) exists.
    ///         Expected: DEFENDED — WinnerExists revert.
    function test_MemeBountyBoard_RefundStaleBountyWithWinner() public {
        staking.setPower(alice, 2000 ether);
        staking.setPower(bob, 5000 ether);
        staking.setPower(carol, 5000 ether);
        staking.setPower(voter2, 5000 ether);
        staking.setPower(voter3, 5000 ether);

        vm.prank(alice);
        bountyBoard.createBounty{value: 1 ether}("Bounty task", block.timestamp + 2 days);

        vm.prank(bob);
        bountyBoard.submitWork(0, "ipfs://work");

        // 3 unique voters needed
        vm.prank(carol);
        bountyBoard.voteForSubmission(0, 0);
        vm.prank(voter2);
        bountyBoard.voteForSubmission(0, 0);
        vm.prank(voter3);
        bountyBoard.voteForSubmission(0, 0);

        // Warp past deadline + dispute + grace
        vm.warp(block.timestamp + 2 days + 2 days + 30 days + 1);

        // Try refund — should revert because a valid winner exists
        vm.expectRevert(MemeBountyBoard.WinnerExists.selector);
        vm.prank(attacker);
        bountyBoard.refundStaleBounty(0);

        // completeBounty should still work (anyone can call after grace period)
        vm.prank(attacker);
        bountyBoard.completeBounty(0);
    }

    // ================================================================
    //  12. MEME BOUNTY BOARD — emergencyForceCancel abuse
    // ================================================================

    /// @notice Verify emergencyForceCancel cannot steal from a valid winner.
    ///         Expected: DEFENDED — WinnerExists revert when quorum met.
    function test_MemeBountyBoard_EmergencyForceCancelWithWinner() public {
        staking.setPower(alice, 2000 ether);
        staking.setPower(bob, 5000 ether);
        staking.setPower(carol, 5000 ether);
        staking.setPower(voter2, 5000 ether);
        staking.setPower(voter3, 5000 ether);

        vm.prank(alice);
        bountyBoard.createBounty{value: 1 ether}("Task", block.timestamp + 2 days);

        vm.prank(bob);
        bountyBoard.submitWork(0, "ipfs://work");

        vm.prank(carol);
        bountyBoard.voteForSubmission(0, 0);
        vm.prank(voter2);
        bountyBoard.voteForSubmission(0, 0);
        vm.prank(voter3);
        bountyBoard.voteForSubmission(0, 0);

        // Warp past deadline + force cancel delay (7 days)
        vm.warp(block.timestamp + 2 days + 7 days + 1);

        // Owner tries to force cancel — should revert because valid winner exists
        vm.expectRevert(MemeBountyBoard.WinnerExists.selector);
        bountyBoard.emergencyForceCancel(0);
    }

    // ================================================================
    //  13. REFERRAL SPLITTER — 11-level circular chain bypass
    // ================================================================

    /// @notice The circular referral detection walks only 10 levels deep.
    ///         An 11-level chain can create a cycle that bypasses detection.
    ///         FINDING: Low severity — 11-hop circular chain evades detection.
    function test_ReferralSplitter_CircularChainBypass11Levels() public {
        // Create 11 unique addresses to form a chain
        address[12] memory chain;
        for (uint256 i = 0; i < 12; i++) {
            chain[i] = makeAddr(string(abi.encodePacked("chain", vm.toString(i))));
        }

        // Build a chain: chain[0] -> chain[1] -> ... -> chain[10]
        for (uint256 i = 0; i < 11; i++) {
            vm.prank(chain[i]);
            splitter.setReferrer(chain[i + 1]);
        }

        // Now try to set chain[11]'s referrer to chain[0], creating an 11-level cycle
        // The check walks 10 levels from chain[0] and reaches chain[10], never seeing chain[11]
        // So this should succeed (bypassing circular detection)
        vm.prank(chain[11]);
        splitter.setReferrer(chain[0]);

        // Verify the cycle exists: chain[11] -> chain[0] -> chain[1] -> ... -> chain[10] -> chain[11]
        assertEq(splitter.referrerOf(chain[11]), chain[0]);
        assertEq(splitter.referrerOf(chain[0]), chain[1]);
        assertEq(splitter.referrerOf(chain[10]), chain[11]);
        // This forms a complete cycle of length 12
    }

    // ================================================================
    //  14. REFERRAL SPLITTER — 7-day referral age bypass attempt
    // ================================================================

    /// @notice Verify that a new referrer cannot claim before 7 days.
    ///         Expected: DEFENDED — ReferralAgeTooRecent revert.
    function test_ReferralSplitter_ReferralAgeEnforced() public {
        staking.setPower(alice, 2000 ether);
        staking.setPower(bob, 2000 ether); // Bob must be staked for referral to qualify

        // Bob refers Alice
        vm.prank(alice);
        splitter.setReferrer(bob);

        // Record a fee for Alice — Bob gets credited
        splitter.recordFee{value: 1 ether}(alice);

        // Bob tries to claim immediately — should revert (referral too recent)
        vm.prank(bob);
        vm.expectRevert(ReferralSplitter.ReferralAgeTooRecent.selector);
        splitter.claimReferralRewards();

        // Warp 6 days — still too early
        _advanceTime(6 days);
        vm.prank(bob);
        vm.expectRevert(ReferralSplitter.ReferralAgeTooRecent.selector);
        splitter.claimReferralRewards();

        // Warp past 7 days — should work
        _advanceTime(2 days);
        vm.prank(bob);
        splitter.claimReferralRewards();
    }

    // ================================================================
    //  15. REFERRAL SPLITTER — forfeitUnclaimedRewards on active referrer
    // ================================================================

    /// @notice Verify forfeit cannot steal from a properly staked, active referrer.
    ///         Expected: DEFENDED — ForfeitureConditionsNotMet revert.
    function test_ReferralSplitter_ForfeitActiveReferrer() public {
        staking.setPower(alice, 2000 ether);
        staking.setPower(bob, 2000 ether);

        vm.prank(alice);
        splitter.setReferrer(bob);

        splitter.recordFee{value: 1 ether}(alice);

        // Owner tries to forfeit Bob's rewards — should fail (Bob is staked)
        vm.expectRevert(ReferralSplitter.ForfeitureConditionsNotMet.selector);
        splitter.forfeitUnclaimedRewards(bob);

        // Even if we mark below stake, Bob is actually staked so markBelowStake resets
        splitter.markBelowStake(bob);
        assertEq(splitter.lastBelowStakeTime(bob), 0, "Timer should be reset since Bob is staked");
    }

    // ================================================================
    //  16. REFERRAL SPLITTER — sweepUnclaimable draining reserved funds
    // ================================================================

    /// @notice Verify sweepUnclaimable correctly protects all reserved funds.
    ///         Expected: DEFENDED — reserved = totalPendingETH + accumulatedTreasuryETH + totalCallerCredit.
    function test_ReferralSplitter_SweepUnclaimableProtectsReserved() public {
        staking.setPower(alice, 2000 ether);
        staking.setPower(bob, 2000 ether); // Bob must be staked so referral qualifies

        vm.prank(alice);
        splitter.setReferrer(bob);

        // Record fee — Bob's referral share (10%) credited to pendingETH,
        // remainder (90%) credited to callerCredit
        splitter.recordFee{value: 10 ether}(alice);

        uint256 pendingETHVal = splitter.totalPendingETH();
        uint256 callerCreditVal = splitter.totalCallerCredit();

        assertEq(pendingETHVal, 1 ether, "Bob should have 1 ETH pending");
        assertEq(callerCreditVal, 9 ether, "Caller should have 9 ETH credit");

        // sweepUnclaimable should have nothing to sweep
        vm.expectRevert(ReferralSplitter.NothingToClaim.selector);
        splitter.sweepUnclaimable();
    }

    // ================================================================
    //  17. REFERRAL SPLITTER — approved caller system exploitation
    // ================================================================

    /// @notice Verify that after completeSetup, instant setApprovedCaller is disabled.
    ///         Expected: DEFENDED — SetupAlreadyComplete revert.
    function test_ReferralSplitter_SetupCompleteBlocksInstantGrant() public {
        splitter.completeSetup();

        // Try instant setApprovedCaller — should revert
        vm.expectRevert(ReferralSplitter.SetupAlreadyComplete.selector);
        splitter.setApprovedCaller(attacker, true);

        // Must use timelocked path
        splitter.proposeApprovedCaller(attacker);
        vm.warp(block.timestamp + 24 hours);
        splitter.executeApprovedCaller(attacker);

        assertTrue(splitter.approvedCallers(attacker), "Attacker should be approved via timelocked path");
    }

    // ================================================================
    //  19. MEME BOUNTY BOARD — WETH fallback in withdrawPayout
    // ================================================================

    /// @notice Verify WETH fallback works for winners who cannot receive ETH.
    ///         Expected: DEFENDED — WETH deposit + transfer fallback.
    function test_MemeBountyBoard_WETHFallbackWithdrawPayout() public {
        ETHRejecterFA rejecter = new ETHRejecterFA();
        address rejecterAddr = address(rejecter);

        staking.setPower(alice, 2000 ether);
        staking.setPower(rejecterAddr, 5000 ether);
        staking.setPower(carol, 5000 ether);
        staking.setPower(voter2, 5000 ether);
        staking.setPower(voter3, 5000 ether);

        // Alice creates bounty
        vm.prank(alice);
        bountyBoard.createBounty{value: 1 ether}("Task", block.timestamp + 2 days);

        // Rejecter submits work
        vm.prank(rejecterAddr);
        bountyBoard.submitWork(0, "ipfs://work");

        // 3 unique voters needed
        vm.prank(carol);
        bountyBoard.voteForSubmission(0, 0);
        vm.prank(voter2);
        bountyBoard.voteForSubmission(0, 0);
        vm.prank(voter3);
        bountyBoard.voteForSubmission(0, 0);

        // Past deadline + dispute
        vm.warp(block.timestamp + 2 days + 2 days + 1);

        // Complete — ETH transfer to rejecter fails, goes to pendingPayouts
        vm.prank(alice);
        bountyBoard.completeBounty(0);

        uint256 pending = bountyBoard.pendingPayouts(rejecterAddr);
        assertEq(pending, 1 ether, "Should have pending payout");

        // Withdraw — ETH fails again, WETH fallback
        vm.prank(rejecterAddr);
        bountyBoard.withdrawPayout();

        assertEq(bountyBoard.pendingPayouts(rejecterAddr), 0, "Pending should be cleared");
        assertGt(weth.balanceOf(rejecterAddr), 0, "Should have received WETH");
    }

    // ================================================================
    //  20. COMMUNITY GRANTS — Timestamp snapshot on L2
    // ================================================================

    /// @notice Verify that the voting power snapshot uses block.timestamp - 1
    ///         to prevent same-block manipulation.
    ///         Expected: DEFENDED — snapshotTimestamp = block.timestamp - 1.
    function test_CommunityGrants_SnapshotTimestamp() public {
        veGrants.setPower(alice, 10000 ether);

        vm.prank(alice);
        token.approve(address(grants), 100_000 ether);
        vm.prank(alice);
        grants.createProposal(bob, 1 ether, "Test");

        (,,,,,,, , uint256 snapshotTs,) = grants.getProposal(0);
        assertEq(snapshotTs, block.timestamp - 1, "Snapshot should be block.timestamp - 1");
    }
}

// ──────────────────────────────────────────────────────────────────────
//  HELPER CONTRACTS
// ──────────────────────────────────────────────────────────────────────

contract ETHRejecterFA {
    receive() external payable {
        revert("no ETH");
    }

    // Allow calling external contracts
    fallback() external payable {
        revert("no ETH");
    }
}
