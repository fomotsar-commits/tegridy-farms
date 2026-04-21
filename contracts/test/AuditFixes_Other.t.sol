// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/PremiumAccess.sol";
import "../src/RevenueDistributor.sol";
import "../src/MemeBountyBoard.sol";
import "../src/CommunityGrants.sol";
import "../src/ReferralSplitter.sol";

// ─── Mock Contracts ──────────────────────────────────────────────────────────

contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}

contract MockVotingEscrow {
    mapping(address => uint256) public _votingPower;
    mapping(address => uint256) public _lockAmount;
    mapping(address => uint256) public _lockEnd;
    uint256 public _totalLocked;
    uint256 public _totalBoostedStake;

    function setVotingPower(address user, uint256 power) external {
        _votingPower[user] = power;
    }

    function setLock(address user, uint256 amount, uint256 end) external {
        _lockAmount[user] = amount;
        _lockEnd[user] = end;
    }

    function setTotalLocked(uint256 total) external {
        _totalLocked = total;
    }

    function setTotalBoostedStake(uint256 total) external {
        _totalBoostedStake = total;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return _votingPower[user];
    }

    function votingPowerAt(address user, uint256 /* blockNumber */) external view returns (uint256) {
        return _votingPower[user];
    }

    function votingPowerAtTimestamp(address user, uint256 /* ts */) external view returns (uint256) {
        return _votingPower[user];
    }

    function totalLocked() external view returns (uint256) {
        return _totalLocked;
    }

    function totalBoostedStake() external view returns (uint256) {
        return _totalBoostedStake;
    }

    function userTokenId(address user) external pure returns (uint256) {
        // AUDIT NEW-G7 mock convenience: non-zero per-address default so proposers
        // satisfy the new ProposerMissingStakingPointer guard without every test
        // having to pre-stake the proposer. Real deployments force a genuine stake;
        // this mock stand-in is sufficient for unit-test flow coverage.
        return uint256(uint160(user));
    }

    function holdsToken(address user, uint256 tokenId) external pure returns (bool) {
        return uint256(uint160(user)) == tokenId;
    }

    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256, uint256, uint256 lockEndVal,
        uint256, bool, int256, uint256, bool, uint256, bool
    ) {
        address user = address(uint160(tokenId));
        amount = _lockAmount[user];
        lockEndVal = _lockEnd[user];
    }

    function paused() external pure returns (bool) {
        return false;
    }

    function locks(address user) external view returns (uint256 amount, uint256 end) {
        return (_lockAmount[user], _lockEnd[user]);
    }
}

contract MockStakingVote {
    mapping(address => uint256) public _votingPower;

    function setVotingPower(address user, uint256 power) external {
        _votingPower[user] = power;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return _votingPower[user];
    }

    function votingPowerAt(address user, uint256 /* blockNumber */) external view returns (uint256) {
        return _votingPower[user];
    }

    function votingPowerAtTimestamp(address user, uint256 /* ts */) external view returns (uint256) {
        return _votingPower[user];
    }
}

/// @dev Mock WETH that always reverts on deposit — used to test FailedExecution when both ETH and WETH paths fail
contract FailingWETHGrants {
    function deposit() external payable { revert("WETH_BROKEN"); }
    function transfer(address, uint256) external pure returns (bool) { return false; }
    receive() external payable {}
}

/// @dev Contract that rejects ETH on first call, accepts on second
contract RejectThenAccept {
    bool public shouldReject = true;

    function toggleReject() external {
        shouldReject = !shouldReject;
    }

    receive() external payable {
        if (shouldReject) revert("REJECTED");
    }
}

// ─── PremiumAccess Tests ─────────────────────────────────────────────────────

contract AuditFixes_PremiumAccessTest is Test {
    PremiumAccess public premium;
    MockTOWELI public toweli;
    MockJBAC public nft;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");

    function setUp() public {
        toweli = new MockTOWELI();
        nft = new MockJBAC();
        premium = new PremiumAccess(address(toweli), address(nft), treasury, 100 ether); // 100 TOWELI/month

        // Fund alice
        toweli.transfer(alice, 100_000 ether);
        vm.prank(alice);
        toweli.approve(address(premium), type(uint256).max);
    }

    /// @notice #3: withdrawToTreasury should NOT drain escrowed refund funds.
    ///         Subscribe, then verify owner can only withdraw non-escrowed funds.
    function test_premiumAccess_escrowProtection() public {
        // Alice subscribes for 6 months = 600 TOWELI
        vm.prank(alice);
        premium.subscribe(6, type(uint256).max);

        uint256 contractBalance = toweli.balanceOf(address(premium));
        assertEq(contractBalance, 600 ether, "Contract should hold 600 TOWELI");

        // totalRefundEscrow should be 600
        assertEq(premium.totalRefundEscrow(), 600 ether);

        // Owner tries to withdraw — should get 0 since all funds are escrowed
        premium.withdrawToTreasury();
        uint256 treasuryBal = toweli.balanceOf(treasury);
        assertEq(treasuryBal, 0, "Treasury should get 0 - all funds escrowed");

        // Contract balance unchanged
        assertEq(toweli.balanceOf(address(premium)), 600 ether);
    }

    /// @notice #43: Cancel uses escrowed amount proportionally, not current fee rate.
    ///         Subscribe at rate X, owner changes rate to Y, cancel refund uses escrowed amount.
    function test_premiumAccess_cancelRefund_usesOriginalRate() public {
        // Alice subscribes for 6 months at 100 TOWELI/month = 600 TOWELI
        vm.prank(alice);
        premium.subscribe(6, type(uint256).max);

        // Verify userEscrow is stored (600 TOWELI escrowed)
        assertEq(premium.userEscrow(alice), 600 ether);

        // Owner doubles the monthly fee to 200 TOWELI (timelocked)
        premium.proposeFeeChange(200 ether);
        vm.warp(block.timestamp + 24 hours + 1);
        premium.executeFeeChange();
        assertEq(premium.monthlyFeeToweli(), 200 ether);

        // Warp forward 3 months (half the subscription period)
        vm.warp(block.timestamp + 3 * 30 days);

        // Alice cancels — refund should be proportional to remaining time from escrowed amount
        uint256 aliceBalBefore = toweli.balanceOf(alice);
        vm.prank(alice);
        premium.cancelSubscription();
        uint256 aliceBalAfter = toweli.balanceOf(alice);

        uint256 refund = aliceBalAfter - aliceBalBefore;
        // Escrowed: 600 TOWELI, remaining ~50% of time => ~300 TOWELI refund
        // (exact amount depends on timestamp precision)
        // Tolerance widened because 24h+1s timelock warp eats into the subscription period
        assertApproxEqAbs(refund, 300 ether, 5 ether, "Refund should be ~300 TOWELI proportional to remaining time");

        // If it used the NEW rate (200), refund would be ~600 which exceeds contract balance
    }

    receive() external payable {}
}

// ─── RevenueDistributor Tests ────────────────────────────────────────────────

contract MockWETHRevDist {
    function deposit() external payable {}
    function transfer(address to, uint256 value) external returns (bool) {
        (bool s,) = to.call{value: value}("");
        return s;
    }
    receive() external payable {}
}

contract AuditFixes_RevenueDistributorTest is Test {
    RevenueDistributor public distributor;
    MockVotingEscrow public escrow;
    MockWETHRevDist public weth;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    function setUp() public {
        vm.warp(5 hours);
        escrow = new MockVotingEscrow();
        weth = new MockWETHRevDist();
        distributor = new RevenueDistributor(address(escrow), treasury, address(weth));

        // Alice has a lock of 1000 TOWELI
        escrow.setLock(alice, 1000 ether, block.timestamp + 365 days);
        escrow.setVotingPower(alice, 1000 ether);
        escrow.setTotalLocked(1000 ether);
        escrow.setTotalBoostedStake(1000 ether);
    }

    /// @notice Claim uses votingPowerAtTimestamp for share calculation.
    ///         With checkpoint-based system, share depends on power at epoch timestamp.
    function test_revenueDistributor_claimUsesCheckpointPower() public {
        // Bob also has a lock of 4000 TOWELI
        escrow.setLock(bob, 4000 ether, block.timestamp + 365 days);
        escrow.setVotingPower(bob, 4000 ether);
        escrow.setTotalLocked(5000 ether);
        escrow.setTotalBoostedStake(5000 ether);

        // Fund distributor and create 3 epochs
        for (uint256 i = 0; i < 3; i++) {
            vm.deal(address(distributor), address(distributor).balance + 10 ether);
            distributor.distribute();
            if (i < 2) vm.warp(block.timestamp + 4 hours + 1);
        }

        // Alice claims — with 1000/5000 ratio: share = 3 * 10 * 1000 / 5000 = 6 ETH
        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        distributor.claim();
        uint256 aliceBalAfter = alice.balance;

        uint256 claimed = aliceBalAfter - aliceBalBefore;
        assertEq(claimed, 6 ether, "Should use votingPowerAtTimestamp for share calculation");
    }

    /// @notice #18: Claiming more than MAX_CLAIM_EPOCHS (500) reverts — use claimUpTo().
    ///         AUDIT FIX #18: claim() reverts with TooManyUnclaimedEpochs if over 500.
    function test_revenueDistributor_maxClaimEpochs() public {
        // Create 501 epochs (one more than MAX_CLAIM_EPOCHS)
        uint256 ts = block.timestamp;
        for (uint256 i = 0; i < 501; i++) {
            ts += 4 hours + 1;
            vm.warp(ts);
            vm.deal(address(distributor), address(distributor).balance + 1 ether);
            distributor.distribute();
        }

        // claim() reverts when unclaimed epochs exceed MAX_CLAIM_EPOCHS (500)
        vm.prank(alice);
        vm.expectRevert(RevenueDistributor.TooManyUnclaimedEpochs.selector);
        distributor.claim();

        // Use claimUpTo() to batch-claim first 500 epochs
        vm.prank(alice);
        distributor.claimUpTo(500);
        assertEq(distributor.lastClaimedEpoch(alice), 500);

        // Then claim the remaining 1 via regular claim()
        vm.prank(alice);
        distributor.claim();
        assertEq(distributor.lastClaimedEpoch(alice), 501);
    }

    receive() external payable {}
}

// ─── MemeBountyBoard Tests ───────────────────────────────────────────────────

contract MockWETHAudit {
    function deposit() external payable {}
    function transfer(address to, uint256 value) external returns (bool) {
        (bool s,) = to.call{value: value}("");
        return s;
    }
    receive() external payable {}
}

contract AuditFixes_MemeBountyBoardTest is Test {
    MemeBountyBoard public board;
    MockTOWELI public token;
    MockStakingVote public staking;
    MockWETHAudit public weth;
    address public creator = makeAddr("creator");
    address public artist = makeAddr("artist");
    address public voter1 = makeAddr("voter1");
    address public voter2 = makeAddr("voter2");
    address public voter3 = makeAddr("voter3");

    function setUp() public {
        token = new MockTOWELI();
        staking = new MockStakingVote();
        weth = new MockWETHAudit();
        board = new MemeBountyBoard(address(token), address(staking), address(weth));

        vm.deal(creator, 10 ether);

        // Give submitters enough TOWELI to pass MIN_SUBMIT_BALANCE (500 ether)
        token.transfer(artist, 500 ether);
        token.transfer(makeAddr("artist2"), 500 ether);

        // Set voting power for submitters (MIN_SUBMIT_BALANCE = 500 ether)
        staking.setVotingPower(artist, 500 ether);
        staking.setVotingPower(makeAddr("artist2"), 500 ether);

        // Set voting power for voters
        staking.setVotingPower(voter1, 10_000 ether);
        staking.setVotingPower(voter2, 10_000 ether);
        staking.setVotingPower(voter3, 10_000 ether);
    }

    /// @notice #14: topSubmissionId is updated when voting.
    function test_memeBountyBoard_topSubmissionTracking() public {
        // Create bounty
        vm.prank(creator);
        board.createBounty{value: 1 ether}("Test", block.timestamp + 7 days);

        // Two submissions
        vm.prank(artist);
        board.submitWork(0, "ipfs://sub0");
        vm.prank(makeAddr("artist2"));
        board.submitWork(0, "ipfs://sub1");

        // Vote for submission 1 (index 1)
        vm.prank(voter1);
        board.voteForSubmission(0, 1);

        // topSubmissionId should be 1 (stake-weighted: 10_000 ether)
        assertEq(board.topSubmissionId(0), 1);
        assertEq(board.topSubmissionVotes(0), 10_000 ether);

        // Vote for submission 0 twice — should overtake (20_000 ether > 10_000 ether)
        vm.prank(voter2);
        board.voteForSubmission(0, 0);
        vm.prank(voter3);
        board.voteForSubmission(0, 0);

        // topSubmissionId should now be 0 (20_000 ether > 10_000 ether)
        assertEq(board.topSubmissionId(0), 0);
        assertEq(board.topSubmissionVotes(0), 20_000 ether);
    }

    /// @notice #37: Deadline too soon (< MIN_DEADLINE_DURATION = 1 day) should revert.
    function test_memeBountyBoard_minDeadline() public {
        // Deadline only 12 hours from now — should revert
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.DeadlineTooSoon.selector);
        board.createBounty{value: 1 ether}("Too soon", block.timestamp + 12 hours);

        // Deadline exactly 1 day from now should succeed
        vm.prank(creator);
        board.createBounty{value: 1 ether}("OK", block.timestamp + 1 days);
        assertEq(board.bountyCount(), 1);
    }

    receive() external payable {}
}

// ─── CommunityGrants Tests ───────────────────────────────────────────────────

contract AuditFixes_CommunityGrantsTest is Test {
    CommunityGrants public grants;
    MockTOWELI public toweli;
    MockVotingEscrow public escrow;
    address public feeReceiver = makeAddr("feeReceiver");
    address public proposer = makeAddr("proposer");
    address public voter = makeAddr("voter");
    address public voter2 = makeAddr("voter2");
    address public voter3 = makeAddr("voter3");

    FailingWETHGrants public failingWeth;

    function setUp() public {
        toweli = new MockTOWELI();
        escrow = new MockVotingEscrow();
        failingWeth = new FailingWETHGrants();
        grants = new CommunityGrants(address(escrow), address(toweli), feeReceiver, address(failingWeth));

        // Fund proposer with TOWELI for proposal fee
        toweli.transfer(proposer, 100_000 ether);
        vm.prank(proposer);
        toweli.approve(address(grants), type(uint256).max);

        // Setup voters (3 required for MIN_UNIQUE_VOTERS)
        escrow.setVotingPower(voter, 10_000 ether);
        escrow.setVotingPower(voter2, 5_000 ether);
        escrow.setVotingPower(voter3, 5_000 ether);
        escrow.setTotalBoostedStake(20_000 ether);
        escrow.setTotalLocked(20_000 ether);

        // Fund grants contract with ETH
        vm.deal(address(grants), 100 ether);
    }

    /// @notice #15: Create proposal to a failing recipient, execute fails,
    ///         retry after fixing the recipient succeeds.
    function test_communityGrants_retryFailedExecution() public {
        // Deploy a contract that rejects ETH initially
        RejectThenAccept rejector = new RejectThenAccept();

        // Create proposal targeting the rejector
        vm.prank(proposer);
        grants.createProposal(address(rejector), 1 ether, "Grant to rejector");

        uint256 t0 = block.timestamp;

        // Warp past VOTING_DELAY then vote in favor (3 voters for MIN_UNIQUE_VOTERS)
        vm.warp(t0 + 1 days);
        vm.prank(voter);
        grants.voteOnProposal(0, true);
        vm.prank(voter2);
        grants.voteOnProposal(0, true);
        vm.prank(voter3);
        grants.voteOnProposal(0, true);

        // Warp past voting period
        vm.warp(t0 + 8 days);

        // Finalize — should be approved
        grants.finalizeProposal(0);
        (,,,,,,, CommunityGrants.ProposalStatus status,,) = grants.getProposal(0);
        assertEq(uint256(status), uint256(CommunityGrants.ProposalStatus.Approved));

        // Warp past EXECUTION_DELAY then execute — should fail because rejector rejects ETH
        vm.warp(t0 + 9 days);
        grants.executeProposal(0);
        (,,,,,,, CommunityGrants.ProposalStatus status2,,) = grants.getProposal(0);
        assertEq(uint256(status2), uint256(CommunityGrants.ProposalStatus.FailedExecution));

        // Fix the rejector — now it accepts ETH
        rejector.toggleReject();

        // Retry execution — should succeed
        grants.retryExecution(0);
        (,,,,,,, CommunityGrants.ProposalStatus status3,,) = grants.getProposal(0);
        assertEq(uint256(status3), uint256(CommunityGrants.ProposalStatus.Executed));

        // Rejector received the ETH
        assertEq(address(rejector).balance, 1 ether);
    }

    receive() external payable {}
}

// ─── ReferralSplitter Tests ──────────────────────────────────────────────────

contract AuditFixes_ReferralSplitterTest is Test {
    ReferralSplitter public splitter;
    MockStakingVote public staking;
    MockWETHAudit public wethForSplitter;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public randomCaller = makeAddr("random");

    function setUp() public {
        staking = new MockStakingVote();
        wethForSplitter = new MockWETHAudit();
        splitter = new ReferralSplitter(1000, address(staking), makeAddr("treasury"), address(wethForSplitter)); // 10% referral fee

        // Fund splitter
        vm.deal(address(splitter), 100 ether);
        vm.deal(address(this), 100 ether);

        // Set staking power for referrer (bob)
        staking.setVotingPower(bob, 1000 ether);
    }

    /// @notice #17: Non-approved caller cannot call recordFee.
    function test_referralSplitter_approvedCallers() public {
        vm.deal(randomCaller, 10 ether);

        // Random caller tries to record fee — should revert
        vm.prank(randomCaller);
        vm.expectRevert(ReferralSplitter.NotApprovedCaller.selector);
        splitter.recordFee{value: 1 ether}(alice);

        // Owner approves a caller
        splitter.setApprovedCaller(randomCaller, true);

        // Set up referral: alice -> bob
        vm.prank(alice);
        splitter.setReferrer(bob);

        // Now approved caller can record fee
        vm.prank(randomCaller);
        splitter.recordFee{value: 1 ether}(alice);

        // Bob should have pending rewards (10% of 1 ETH = 0.1 ETH)
        assertEq(splitter.pendingETH(bob), 0.1 ether);

        // Revoke approval
        splitter.setApprovedCaller(randomCaller, false);

        // Should fail again
        vm.prank(randomCaller);
        vm.expectRevert(ReferralSplitter.NotApprovedCaller.selector);
        splitter.recordFee{value: 1 ether}(alice);
    }

    /// @notice #39: Update referrer after cooldown period.
    function test_referralSplitter_updateReferrer() public {
        // Alice sets bob as referrer
        vm.prank(alice);
        splitter.setReferrer(bob);
        assertEq(splitter.referrerOf(alice), bob);

        // Alice tries to update immediately — should fail (cooldown)
        vm.prank(alice);
        vm.expectRevert(ReferralSplitter.CooldownNotElapsed.selector);
        splitter.updateReferrer(carol);

        // Warp past cooldown (30 days)
        vm.warp(block.timestamp + 30 days);

        // Now alice can update
        vm.prank(alice);
        splitter.updateReferrer(carol);
        assertEq(splitter.referrerOf(alice), carol);

        // Verify referral counts updated
        assertEq(splitter.totalReferred(bob), 0);
        assertEq(splitter.totalReferred(carol), 1);

        // Try to update again immediately — should fail
        vm.prank(alice);
        vm.expectRevert(ReferralSplitter.CooldownNotElapsed.selector);
        splitter.updateReferrer(bob);
    }

    receive() external payable {}
}
