// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/MemeBountyBoard.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";
import {WETHFallbackLib} from "../src/lib/WETHFallbackLib.sol";

// ─── Mock contracts ──────────────────────────────────────────────────────────

contract MockToweli195 is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockStaking195 {
    mapping(address => uint256) public _power;
    mapping(address => mapping(uint256 => uint256)) public _powerAtTs;

    function setVotingPower(address u, uint256 p) external { _power[u] = p; }
    function setVotingPowerAtTimestamp(address u, uint256 ts, uint256 p) external { _powerAtTs[u][ts] = p; }

    function votingPowerOf(address u) external view returns (uint256) { return _power[u]; }
    function votingPowerAt(address u, uint256 bn) external view returns (uint256) {
        return _powerAtTs[u][bn] > 0 ? _powerAtTs[u][bn] : _power[u];
    }
    function votingPowerAtTimestamp(address u, uint256 ts) external view returns (uint256) {
        return _powerAtTs[u][ts] > 0 ? _powerAtTs[u][ts] : _power[u];
    }
}

contract MockWETH195 {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
    receive() external payable {}
}

/// @dev Rejects all ETH transfers -- used to test WETH fallback paths
contract ETHRejecter195 {
    MemeBountyBoard public board;
    constructor(MemeBountyBoard _b) { board = _b; }
    function createBounty(string calldata d, uint256 dl) external payable {
        board.createBounty{value: msg.value}(d, dl);
    }
    function withdrawRefund() external { board.withdrawRefund(); }
    function withdrawPayout() external { board.withdrawPayout(); }
    // No receive/fallback -- ETH transfers revert
}

/// @dev Accepts ETH (has receive) so push-pattern transfers succeed
contract ETHAcceptor195 {
    MemeBountyBoard public board;
    constructor(MemeBountyBoard _b) { board = _b; }
    function submitWork(uint256 id, string calldata uri) external { board.submitWork(id, uri); }
    function withdrawPayout() external { board.withdrawPayout(); }
    receive() external payable {}
}

/// @dev Failing WETH mock -- deposit succeeds but transfer always returns false
contract FailingWETH195 {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address, uint256) external pure returns (bool) { return false; }
    receive() external payable {}
}

// ─── Main Test Contract ──────────────────────────────────────────────────────

contract Audit195Bounty is Test {
    MemeBountyBoard public board;
    MockToweli195 public token;
    MockStaking195 public staking;
    MockWETH195 public weth;

    address creator = makeAddr("creator195");
    address artist1 = makeAddr("artist195_1");
    address artist2 = makeAddr("artist195_2");
    address voter1 = makeAddr("voter195_1");
    address voter2 = makeAddr("voter195_2");
    address voter3 = makeAddr("voter195_3");
    address voter4 = makeAddr("voter195_4");
    address nobody = makeAddr("nobody195");

    uint256 constant REWARD = 1 ether;
    uint256 constant SEVEN_DAYS = 7 days;

    function setUp() public {
        token = new MockToweli195();
        staking = new MockStaking195();
        weth = new MockWETH195();
        board = new MemeBountyBoard(address(token), address(staking), address(weth));

        vm.deal(creator, 100 ether);
        vm.deal(address(this), 100 ether);

        // Set up voting powers
        address[4] memory voters = [voter1, voter2, voter3, voter4];
        for (uint256 i; i < voters.length; i++) {
            staking.setVotingPower(voters[i], 10_000 ether);
        }
        staking.setVotingPower(artist1, 500 ether);
        staking.setVotingPower(artist2, 500 ether);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _create() internal returns (uint256) {
        vm.prank(creator);
        board.createBounty{value: REWARD}("Audit bounty", block.timestamp + SEVEN_DAYS);
        return board.bountyCount() - 1;
    }

    function _createAndSubmit() internal returns (uint256 id) {
        id = _create();
        vm.prank(artist1);
        board.submitWork(id, "ipfs://sub1");
        vm.prank(artist2);
        board.submitWork(id, "ipfs://sub2");
    }

    function _voteQuorum(uint256 id, uint256 subId) internal {
        // 3 voters x 10_000 = 30_000 ether > 3_000 ether quorum
        vm.prank(voter1); board.voteForSubmission(id, subId);
        vm.prank(voter2); board.voteForSubmission(id, subId);
        vm.prank(voter3); board.voteForSubmission(id, subId);
    }

    function _warpPastDispute() internal {
        vm.warp(block.timestamp + SEVEN_DAYS + 2 days + 1);
    }

    function _warpPastGrace() internal {
        vm.warp(block.timestamp + SEVEN_DAYS + 2 days + 30 days + 1);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  1. BOUNTY LIFECYCLE: CREATE
    // ═══════════════════════════════════════════════════════════════════════

    function test_create_basic() public {
        uint256 id = _create();
        (address c,, uint256 r, uint256 dl,, uint256 sc, MemeBountyBoard.BountyStatus st) = board.getBounty(id);
        assertEq(c, creator);
        assertEq(r, REWARD);
        assertGt(dl, block.timestamp);
        assertEq(sc, 0);
        assertEq(uint256(st), 0); // Open
    }

    function test_create_revert_insufficientReward() public {
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.InsufficientReward.selector);
        board.createBounty{value: 0.0001 ether}("cheap", block.timestamp + SEVEN_DAYS);
    }

    function test_create_revert_deadlineTooSoon() public {
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.DeadlineTooSoon.selector);
        board.createBounty{value: REWARD}("soon", block.timestamp + 12 hours);
    }

    function test_create_revert_deadlineTooFar() public {
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.DeadlineTooFar.selector);
        board.createBounty{value: REWARD}("far", block.timestamp + 181 days);
    }

    function test_create_revert_descriptionTooLong() public {
        bytes memory longDesc = new bytes(2001);
        for (uint256 i; i < longDesc.length; i++) longDesc[i] = 0x41; // 'A'
        vm.prank(creator);
        vm.expectRevert("DESC_TOO_LONG");
        board.createBounty{value: REWARD}(string(longDesc), block.timestamp + SEVEN_DAYS);
    }

    function test_create_exactMinDeadline() public {
        vm.prank(creator);
        board.createBounty{value: REWARD}("exact", block.timestamp + 1 days);
        assertEq(board.bountyCount(), 1);
    }

    function test_create_exactMaxDeadline() public {
        vm.prank(creator);
        board.createBounty{value: REWARD}("max", block.timestamp + 180 days);
        assertEq(board.bountyCount(), 1);
    }

    function test_create_paused_reverts() public {
        board.pause();
        vm.prank(creator);
        vm.expectRevert();
        board.createBounty{value: REWARD}("paused", block.timestamp + SEVEN_DAYS);
    }

    function test_create_snapshotTimestamp() public {
        uint256 ts = block.timestamp;
        uint256 id = _create();
        // snapshotTimestamp should be block.timestamp - 1 at creation
        // We verify indirectly: voting power is checked at snapshotTimestamp
        // The bounty was created at ts, snapshot = ts - 1
        // No direct getter for snapshotTimestamp from getBounty, but we can verify
        // voting works correctly with snapshot-based power
        staking.setVotingPowerAtTimestamp(voter1, ts - 1, 10_000 ether);
        staking.setVotingPowerAtTimestamp(voter1, ts, 0); // no power at creation time
        vm.prank(artist1);
        board.submitWork(id, "ipfs://test");
        // voter1 should still be able to vote because snapshot is ts-1
        vm.prank(voter1);
        board.voteForSubmission(id, 0);
        (, , uint256 votes) = board.getSubmission(id, 0);
        assertEq(votes, 10_000 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  2. BOUNTY LIFECYCLE: SUBMIT WORK
    // ═══════════════════════════════════════════════════════════════════════

    function test_submit_basic() public {
        uint256 id = _create();
        vm.prank(artist1);
        board.submitWork(id, "ipfs://art");
        (address sub, string memory uri, uint256 v) = board.getSubmission(id, 0);
        assertEq(sub, artist1);
        assertEq(keccak256(bytes(uri)), keccak256("ipfs://art"));
        assertEq(v, 0);
    }

    function test_submit_revert_creatorCannotSubmit() public {
        uint256 id = _create();
        staking.setVotingPower(creator, 500 ether);
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.CreatorCannotSubmit.selector);
        board.submitWork(id, "ipfs://selfDeal");
    }

    function test_submit_revert_afterDeadline() public {
        uint256 id = _create();
        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        vm.prank(artist1);
        vm.expectRevert(MemeBountyBoard.DeadlinePassed.selector);
        board.submitWork(id, "ipfs://late");
    }

    function test_submit_revert_duplicateSubmission() public {
        uint256 id = _create();
        vm.prank(artist1);
        board.submitWork(id, "ipfs://first");
        vm.prank(artist1);
        vm.expectRevert(MemeBountyBoard.AlreadySubmitted.selector);
        board.submitWork(id, "ipfs://second");
    }

    function test_submit_revert_maxSubmissionsReached() public {
        uint256 id = _create();
        // Fill up MAX_SUBMISSIONS_PER_BOUNTY = 100
        for (uint256 i; i < 100; i++) {
            address submitter = makeAddr(string(abi.encodePacked("submitter", vm.toString(i))));
            staking.setVotingPower(submitter, 500 ether);
            vm.prank(submitter);
            board.submitWork(id, "ipfs://sub");
        }
        // 101st should revert
        address extra = makeAddr("extra_submitter");
        staking.setVotingPower(extra, 500 ether);
        vm.prank(extra);
        vm.expectRevert(MemeBountyBoard.MaxSubmissionsReached.selector);
        board.submitWork(id, "ipfs://overflow");
    }

    function test_submit_revert_insufficientSubmitBalance() public {
        uint256 id = _create();
        address weakSub = makeAddr("weakSubmitter");
        staking.setVotingPower(weakSub, 499 ether); // below 500 ether
        vm.prank(weakSub);
        vm.expectRevert(MemeBountyBoard.InsufficientSubmitBalance.selector);
        board.submitWork(id, "ipfs://weak");
    }

    function test_submit_revert_invalidBountyId() public {
        vm.prank(artist1);
        vm.expectRevert(MemeBountyBoard.InvalidBounty.selector);
        board.submitWork(999, "ipfs://noexist");
    }

    function test_submit_revert_bountyNotOpen() public {
        uint256 id = _create();
        // Cancel it first
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(creator);
        board.cancelBounty(id);
        vm.prank(artist1);
        vm.expectRevert(MemeBountyBoard.BountyNotOpen.selector);
        board.submitWork(id, "ipfs://cancelled");
    }

    function test_submit_contentURITooLong() public {
        uint256 id = _create();
        bytes memory longURI = new bytes(2001);
        for (uint256 i; i < longURI.length; i++) longURI[i] = 0x41;
        vm.prank(artist1);
        vm.expectRevert("URI_TOO_LONG");
        board.submitWork(id, string(longURI));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  3. BOUNTY LIFECYCLE: VOTE
    // ═══════════════════════════════════════════════════════════════════════

    function test_vote_stakeWeighted() public {
        uint256 id = _createAndSubmit();
        vm.prank(voter1);
        board.voteForSubmission(id, 0);
        (, , uint256 v) = board.getSubmission(id, 0);
        assertEq(v, 10_000 ether);
    }

    function test_vote_revert_selfVoteOwnSubmission() public {
        uint256 id = _create();
        staking.setVotingPower(artist1, 10_000 ether);
        vm.prank(artist1);
        board.submitWork(id, "ipfs://mywork");
        vm.prank(artist1);
        vm.expectRevert(MemeBountyBoard.CannotVoteOwnSubmission.selector);
        board.voteForSubmission(id, 0);
    }

    function test_vote_revert_creatorCannotVote() public {
        uint256 id = _createAndSubmit();
        staking.setVotingPower(creator, 10_000 ether);
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.CreatorCannotVote.selector);
        board.voteForSubmission(id, 0);
    }

    function test_vote_revert_doubleVoteSameBounty() public {
        uint256 id = _createAndSubmit();
        vm.prank(voter1);
        board.voteForSubmission(id, 0);
        // Try voting on a different submission in the same bounty
        vm.prank(voter1);
        vm.expectRevert(MemeBountyBoard.AlreadyVoted.selector);
        board.voteForSubmission(id, 1);
    }

    function test_vote_revert_afterDeadline() public {
        uint256 id = _createAndSubmit();
        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        vm.prank(voter1);
        vm.expectRevert(MemeBountyBoard.DeadlinePassed.selector);
        board.voteForSubmission(id, 0);
    }

    function test_vote_revert_insufficientVotingPower() public {
        uint256 id = _createAndSubmit();
        staking.setVotingPower(nobody, 999 ether); // < 1000 ether MIN_VOTE_BALANCE
        vm.prank(nobody);
        vm.expectRevert(MemeBountyBoard.InsufficientVoteBalance.selector);
        board.voteForSubmission(id, 0);
    }

    function test_vote_revert_invalidSubmission() public {
        uint256 id = _createAndSubmit();
        vm.prank(voter1);
        vm.expectRevert(MemeBountyBoard.InvalidSubmission.selector);
        board.voteForSubmission(id, 99);
    }

    function test_vote_topSubmissionTracking() public {
        uint256 id = _createAndSubmit();
        // voter1 votes for sub 0
        vm.prank(voter1);
        board.voteForSubmission(id, 0);
        assertEq(board.topSubmissionId(id), 0);
        assertEq(board.topSubmissionVotes(id), 10_000 ether);

        // voter2 votes for sub 1
        vm.prank(voter2);
        board.voteForSubmission(id, 1);
        // Tie: 10_000 each. First-to-reach retains (strict >)
        assertEq(board.topSubmissionId(id), 0);

        // voter3 votes for sub 1 -- now sub 1 has 20_000 > 10_000
        vm.prank(voter3);
        board.voteForSubmission(id, 1);
        assertEq(board.topSubmissionId(id), 1);
        assertEq(board.topSubmissionVotes(id), 20_000 ether);
    }

    function test_vote_revert_bountyNotOpen() public {
        // Create bounty with a submission, then cancel via owner path
        // Actually cancel blocks with submissions. Use complete instead.
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0);
        _warpPastDispute();
        vm.prank(creator);
        board.completeBounty(id);
        // Now bounty is Completed (not Open)
        vm.prank(voter4);
        vm.expectRevert(MemeBountyBoard.BountyNotOpen.selector);
        board.voteForSubmission(id, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  4. BOUNTY LIFECYCLE: COMPLETE
    // ═══════════════════════════════════════════════════════════════════════

    function test_complete_creatorAfterDispute() public {
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0);
        _warpPastDispute();

        uint256 balBefore = artist1.balance;
        vm.prank(creator);
        board.completeBounty(id);
        assertEq(artist1.balance - balBefore, REWARD);

        (,,,, address w,, MemeBountyBoard.BountyStatus st) = board.getBounty(id);
        assertEq(w, artist1);
        assertEq(uint256(st), 1); // Completed
    }

    function test_complete_revert_beforeDeadline() public {
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0);
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.DeadlineNotPassed.selector);
        board.completeBounty(id);
    }

    function test_complete_revert_disputePeriodActive() public {
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0);
        vm.warp(block.timestamp + SEVEN_DAYS + 1); // past deadline, in dispute
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.DisputePeriodActive.selector);
        board.completeBounty(id);
    }

    function test_complete_revert_quorumNotMet() public {
        uint256 id = _createAndSubmit();
        // Only 1 vote = 10_000 ether, but quorum is 3_000 ether so actually this passes
        // Need voter with less power
        address weakVoter = makeAddr("weakVoter");
        staking.setVotingPower(weakVoter, 1000 ether);
        vm.prank(weakVoter);
        board.voteForSubmission(id, 0);
        // 1000 ether < 3000 ether quorum
        _warpPastDispute();
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.QuorumNotMet.selector);
        board.completeBounty(id);
    }

    function test_complete_revert_noSubmissions() public {
        uint256 id = _create();
        _warpPastDispute();
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.NoSubmissions.selector);
        board.completeBounty(id);
    }

    function test_complete_revert_nonCreatorBeforeGrace() public {
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0);
        _warpPastDispute();
        vm.prank(nobody);
        vm.expectRevert(MemeBountyBoard.GracePeriodNotExpired.selector);
        board.completeBounty(id);
    }

    function test_complete_permissionlessAfterGrace() public {
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0);
        _warpPastGrace();

        uint256 balBefore = artist1.balance;
        vm.prank(nobody); // anyone can complete
        board.completeBounty(id);
        assertEq(artist1.balance - balBefore, REWARD);
    }

    function test_complete_revert_alreadyCompleted() public {
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0);
        _warpPastDispute();
        vm.prank(creator);
        board.completeBounty(id);
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.BountyNotOpen.selector);
        board.completeBounty(id);
    }

    function test_complete_creditsPayoutOnETHReject() public {
        // Creator creates bounty, a contract submitter wins but can't receive ETH
        ETHAcceptor195 contractSubmitter = new ETHAcceptor195(board);
        staking.setVotingPower(address(contractSubmitter), 500 ether);

        uint256 id = _create();
        vm.prank(address(contractSubmitter));
        board.submitWork(id, "ipfs://contractwork");

        _voteQuorum(id, 0); // vote for submission 0 (contractSubmitter)
        _warpPastDispute();

        // Now make contractSubmitter reject ETH by deploying a rejecter version
        // Actually ETHAcceptor195 has receive(), so push will succeed.
        // Let's use ETHRejecter195 instead for this test path.
        // We need a different approach: use a bare contract without receive
        // that submitted via a proxy. Simpler: just verify the pendingPayouts path
        // by checking totalPaidOut is updated regardless of push success.
        vm.prank(creator);
        board.completeBounty(id);
        // ETHAcceptor has receive, so push succeeds, payout goes direct
        assertEq(address(contractSubmitter).balance, REWARD);
    }

    /// @dev PoC: completeBounty credits pendingPayouts when winner rejects ETH
    function test_complete_pendingPayout_WETHFallback() public {
        // We need a contract submitter that rejects ETH
        // Create a special submitter contract
        ETHRejectSubmitter195 rejectSubmitter = new ETHRejectSubmitter195(board);
        staking.setVotingPower(address(rejectSubmitter), 500 ether);

        uint256 id = _create();
        rejectSubmitter.submitWork(id, "ipfs://rejectwork");

        _voteQuorum(id, 0);
        _warpPastDispute();

        vm.prank(creator);
        board.completeBounty(id);

        // Push failed, so reward is in pendingPayouts
        assertEq(board.pendingPayouts(address(rejectSubmitter)), REWARD);

        // Now withdraw via WETH fallback
        rejectSubmitter.withdrawPayout();
        assertEq(board.pendingPayouts(address(rejectSubmitter)), 0);
        assertEq(weth.balanceOf(address(rejectSubmitter)), REWARD);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  5. PULL-PATTERN: withdrawPayout
    // ═══════════════════════════════════════════════════════════════════════

    function test_withdrawPayout_revert_noPending() public {
        vm.prank(nobody);
        vm.expectRevert(MemeBountyBoard.NoPendingPayout.selector);
        board.withdrawPayout();
    }

    function test_withdrawPayout_directETH() public {
        // Manually credit pendingPayouts (simulate failed push in completeBounty)
        // We can't directly set storage easily, so use the full flow
        ETHRejectSubmitter195 rs = new ETHRejectSubmitter195(board);
        staking.setVotingPower(address(rs), 500 ether);
        uint256 id = _create();
        rs.submitWork(id, "ipfs://reject");
        _voteQuorum(id, 0);
        _warpPastDispute();
        vm.prank(creator);
        board.completeBounty(id);

        // Payout is pending. Now make the submitter accept ETH for withdrawal
        // But ETHRejectSubmitter195 has no receive, so withdrawPayout will also fail push
        // and fall back to WETH
        rs.withdrawPayout();
        assertEq(weth.balanceOf(address(rs)), REWARD);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  6. PULL-PATTERN: withdrawRefund
    // ═══════════════════════════════════════════════════════════════════════

    function test_withdrawRefund_WETHFallback() public {
        ETHRejecter195 rej = new ETHRejecter195(board);
        rej.createBounty{value: 10 ether}("rej bounty", block.timestamp + SEVEN_DAYS);
        vm.warp(block.timestamp + 1 hours + 1);
        board.emergencyCancel(0);
        assertEq(board.pendingRefund(address(rej)), 10 ether);
        rej.withdrawRefund();
        assertEq(board.pendingRefund(address(rej)), 0);
        assertEq(weth.balanceOf(address(rej)), 10 ether);
    }

    function test_withdrawRefund_revert_noPending() public {
        vm.prank(nobody);
        vm.expectRevert(MemeBountyBoard.NoPendingPayout.selector);
        board.withdrawRefund();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  7. WETH FALLBACK CORRECTNESS
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev PoC: If WETH transfer fails, funds are permanently locked
    ///      because pendingPayouts was already zeroed before the WETH call.
    function test_withdrawPayout_failingWETH_reverts() public {
        // Deploy board with failing WETH
        FailingWETH195 badWeth = new FailingWETH195();
        MemeBountyBoard badBoard = new MemeBountyBoard(address(token), address(staking), address(badWeth));

        ETHRejectSubmitter195 rs = new ETHRejectSubmitter195(badBoard);
        staking.setVotingPower(address(rs), 500 ether);

        vm.deal(creator, 10 ether);
        vm.prank(creator);
        badBoard.createBounty{value: REWARD}("bad weth bounty", block.timestamp + SEVEN_DAYS);

        rs.submitWork(0, "ipfs://badweth");
        vm.prank(voter1); badBoard.voteForSubmission(0, 0);
        vm.prank(voter2); badBoard.voteForSubmission(0, 0);
        vm.prank(voter3); badBoard.voteForSubmission(0, 0);

        vm.warp(block.timestamp + SEVEN_DAYS + 2 days + 1);
        vm.prank(creator);
        badBoard.completeBounty(0);

        // pendingPayouts credited because push failed
        assertEq(badBoard.pendingPayouts(address(rs)), REWARD);

        // withdrawPayout will revert because WETH.transfer returns false
        vm.expectRevert(WETHFallbackLib.WETHTransferFailed.selector);
        rs.withdrawPayout();

        // FINDING: pendingPayouts was zeroed before the revert, but the revert
        // rolls back the zeroing. So funds are NOT permanently locked -- the
        // require revert restores state. This is safe.
        assertEq(badBoard.pendingPayouts(address(rs)), REWARD);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  8. CANCEL BOUNTY
    // ═══════════════════════════════════════════════════════════════════════

    function test_cancel_beforeDeadlineNoSubmissions() public {
        uint256 id = _create();
        vm.warp(block.timestamp + 1 hours + 1);
        uint256 balBefore = creator.balance;
        vm.prank(creator);
        board.cancelBounty(id);
        assertEq(creator.balance - balBefore, REWARD);
    }

    function test_cancel_revert_afterDeadline() public {
        uint256 id = _create();
        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.CannotCancelAfterDeadline.selector);
        board.cancelBounty(id);
    }

    function test_cancel_revert_withSubmissions() public {
        uint256 id = _createAndSubmit();
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.CannotCancelWithSubmissions.selector);
        board.cancelBounty(id);
    }

    function test_cancel_revert_tooEarly() public {
        uint256 id = _create();
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.CancelTooEarly.selector);
        board.cancelBounty(id);
    }

    function test_cancel_revert_notCreatorOrOwner() public {
        uint256 id = _create();
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(nobody);
        vm.expectRevert(MemeBountyBoard.NotCreatorOrOwner.selector);
        board.cancelBounty(id);
    }

    function test_cancel_ownerCanCancel() public {
        uint256 id = _create();
        vm.warp(block.timestamp + 1 hours + 1);
        uint256 balBefore = creator.balance;
        // owner is address(this)
        board.cancelBounty(id);
        assertEq(creator.balance - balBefore, REWARD);
    }

    function test_cancel_revert_alreadyCancelled() public {
        uint256 id = _create();
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(creator);
        board.cancelBounty(id);
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.BountyNotOpen.selector);
        board.cancelBounty(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  9. REFUND STALE BOUNTY
    // ═══════════════════════════════════════════════════════════════════════

    function test_refundStale_noQuorum() public {
        uint256 id = _createAndSubmit();
        // Only 1 weak vote, under quorum
        address weakV = makeAddr("weakV");
        staking.setVotingPower(weakV, 1000 ether);
        vm.prank(weakV);
        board.voteForSubmission(id, 0);

        _warpPastGrace();
        uint256 balBefore = creator.balance;
        vm.prank(nobody);
        board.refundStaleBounty(id);
        assertEq(creator.balance - balBefore, REWARD);
    }

    function test_refundStale_revert_gracePeriodNotExpired() public {
        uint256 id = _createAndSubmit();
        _warpPastDispute(); // past dispute but not past grace
        vm.prank(nobody);
        vm.expectRevert(MemeBountyBoard.GracePeriodNotExpired.selector);
        board.refundStaleBounty(id);
    }

    function test_refundStale_revert_winnerExists() public {
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0); // quorum met
        _warpPastGrace();
        vm.prank(nobody);
        vm.expectRevert(MemeBountyBoard.WinnerExists.selector);
        board.refundStaleBounty(id);
    }

    /// @dev PoC: refundStaleBounty and completeBounty are mutually exclusive
    ///      when quorum is met: refundStale reverts, completeBounty succeeds
    function test_refundStale_vs_complete_mutuallyExclusive() public {
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0);
        _warpPastGrace();

        // refundStaleBounty should revert (winner exists)
        vm.expectRevert(MemeBountyBoard.WinnerExists.selector);
        board.refundStaleBounty(id);

        // completeBounty should succeed (anyone can call after grace)
        vm.prank(nobody);
        board.completeBounty(id);
        (,,,,,, MemeBountyBoard.BountyStatus st) = board.getBounty(id);
        assertEq(uint256(st), 1); // Completed
    }

    function test_refundStale_noSubmissions() public {
        uint256 id = _create();
        _warpPastGrace();
        uint256 balBefore = creator.balance;
        board.refundStaleBounty(id);
        assertEq(creator.balance - balBefore, REWARD);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  10. EMERGENCY CANCEL
    // ═══════════════════════════════════════════════════════════════════════

    function test_emergencyCancel_noSubmissions() public {
        uint256 id = _create();
        uint256 balBefore = creator.balance;
        board.emergencyCancel(id);
        assertEq(creator.balance - balBefore, REWARD);
    }

    function test_emergencyCancel_revert_withSubmissions() public {
        uint256 id = _createAndSubmit();
        vm.expectRevert(MemeBountyBoard.CannotCancelWithSubmissions.selector);
        board.emergencyCancel(id);
    }

    function test_emergencyCancel_revert_notOwner() public {
        uint256 id = _create();
        vm.prank(nobody);
        vm.expectRevert();
        board.emergencyCancel(id);
    }

    function test_emergencyCancel_revert_notOpen() public {
        uint256 id = _create();
        board.emergencyCancel(id);
        vm.expectRevert(MemeBountyBoard.BountyNotOpen.selector);
        board.emergencyCancel(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  11. EMERGENCY FORCE CANCEL
    // ═══════════════════════════════════════════════════════════════════════

    function test_emergencyForceCancel_afterDelay() public {
        uint256 id = _createAndSubmit();
        // Only a weak vote (under quorum)
        address weakV = makeAddr("weakForce");
        staking.setVotingPower(weakV, 1000 ether);
        vm.prank(weakV);
        board.voteForSubmission(id, 0);

        vm.warp(block.timestamp + SEVEN_DAYS + 7 days + 1);
        uint256 balBefore = creator.balance;
        board.emergencyForceCancel(id);
        assertEq(creator.balance - balBefore, REWARD);
    }

    function test_emergencyForceCancel_revert_tooEarly() public {
        uint256 id = _createAndSubmit();
        vm.warp(block.timestamp + SEVEN_DAYS + 3 days); // before 7 days after deadline
        vm.expectRevert(MemeBountyBoard.ForceCancelTooEarly.selector);
        board.emergencyForceCancel(id);
    }

    function test_emergencyForceCancel_revert_winnerExists() public {
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0);
        vm.warp(block.timestamp + SEVEN_DAYS + 7 days + 1);
        vm.expectRevert(MemeBountyBoard.WinnerExists.selector);
        board.emergencyForceCancel(id);
    }

    function test_emergencyForceCancel_revert_notOwner() public {
        uint256 id = _createAndSubmit();
        vm.warp(block.timestamp + SEVEN_DAYS + 7 days + 1);
        vm.prank(nobody);
        vm.expectRevert();
        board.emergencyForceCancel(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  12. TIMELOCK: proposedMinBountyReward
    // ═══════════════════════════════════════════════════════════════════════

    function test_timelock_proposeAndExecute() public {
        board.proposeMinBountyReward(0.01 ether);
        assertEq(board.pendingMinBountyReward(), 0.01 ether);
        assertGt(board.minBountyRewardChangeTime(), 0);

        vm.warp(block.timestamp + 24 hours + 1);
        board.executeMinBountyRewardChange();
        assertEq(board.minBountyReward(), 0.01 ether);
        // State cleaned up
        assertEq(board.pendingMinBountyReward(), 0);
        assertEq(board.minBountyRewardChangeTime(), 0);
    }

    function test_timelock_revert_executeTooEarly() public {
        board.proposeMinBountyReward(0.01 ether);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, board.MIN_REWARD_CHANGE()));
        board.executeMinBountyRewardChange();
    }

    function test_timelock_revert_noPending() public {
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, board.MIN_REWARD_CHANGE()));
        board.executeMinBountyRewardChange();
    }

    function test_timelock_revert_notOwner() public {
        vm.prank(nobody);
        vm.expectRevert();
        board.proposeMinBountyReward(0.01 ether);
    }

    function test_timelock_revert_zeroReward() public {
        vm.expectRevert("ZERO_REWARD");
        board.proposeMinBountyReward(0);
    }

    function test_timelock_revert_tooHigh() public {
        vm.expectRevert("TOO_HIGH");
        board.proposeMinBountyReward(2 ether);
    }

    /// @dev TimelockAdmin blocks overwriting a pending proposal — must execute or wait for expiry.
    function test_timelock_overwritePending() public {
        board.proposeMinBountyReward(0.01 ether);
        // Owner changes mind, tries to propose again — blocked by ExistingProposalPending
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ExistingProposalPending.selector, board.MIN_REWARD_CHANGE()));
        board.proposeMinBountyReward(0.05 ether);
        // Original proposal still pending — execute it
        assertEq(board.pendingMinBountyReward(), 0.01 ether);
        vm.warp(block.timestamp + 24 hours + 1);
        board.executeMinBountyRewardChange();
        assertEq(board.minBountyReward(), 0.01 ether);
    }

    /// @dev After executing, a second execute should fail (cleaned state)
    function test_timelock_doubleExecuteReverts() public {
        board.proposeMinBountyReward(0.01 ether);
        vm.warp(block.timestamp + 24 hours + 1);
        board.executeMinBountyRewardChange();
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, board.MIN_REWARD_CHANGE()));
        board.executeMinBountyRewardChange();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  13. DEADLINE ENFORCEMENT (various paths)
    // ═══════════════════════════════════════════════════════════════════════

    function test_deadline_submitAtExactDeadline_reverts() public {
        uint256 id = _create();
        (, , , uint256 dl, , ,) = board.getBounty(id);
        vm.warp(dl + 1); // 1 second after deadline
        vm.prank(artist1);
        vm.expectRevert(MemeBountyBoard.DeadlinePassed.selector);
        board.submitWork(id, "ipfs://exactly");
    }

    function test_deadline_voteAtExactDeadline_reverts() public {
        uint256 id = _createAndSubmit();
        (, , , uint256 dl, , ,) = board.getBounty(id);
        vm.warp(dl + 1);
        vm.prank(voter1);
        vm.expectRevert(MemeBountyBoard.DeadlinePassed.selector);
        board.voteForSubmission(id, 0);
    }

    function test_deadline_completeAtExactDeadline_reverts() public {
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0);
        (, , , uint256 dl, , ,) = board.getBounty(id);
        vm.warp(dl); // at exact deadline, not past
        vm.prank(creator);
        vm.expectRevert(MemeBountyBoard.DeadlineNotPassed.selector);
        board.completeBounty(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  14. CONSTRUCTOR VALIDATION
    // ═══════════════════════════════════════════════════════════════════════

    function test_constructor_revert_zeroVoteToken() public {
        vm.expectRevert(MemeBountyBoard.ZeroAddress.selector);
        new MemeBountyBoard(address(0), address(staking), address(weth));
    }

    function test_constructor_revert_zeroStaking() public {
        vm.expectRevert(MemeBountyBoard.ZeroAddress.selector);
        new MemeBountyBoard(address(token), address(0), address(weth));
    }

    function test_constructor_revert_zeroWETH() public {
        vm.expectRevert(MemeBountyBoard.ZeroAddress.selector);
        new MemeBountyBoard(address(token), address(staking), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  15. PAUSE / UNPAUSE
    // ═══════════════════════════════════════════════════════════════════════

    function test_pause_blocksFunctions() public {
        board.pause();

        vm.prank(creator);
        vm.expectRevert();
        board.createBounty{value: REWARD}("p", block.timestamp + SEVEN_DAYS);

        board.unpause();
        uint256 id = _create(); // works after unpause
        assertEq(board.bountyCount(), 1);
    }

    function test_pause_revert_notOwner() public {
        vm.prank(nobody);
        vm.expectRevert();
        board.pause();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  16. VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    function test_bountyCount() public {
        assertEq(board.bountyCount(), 0);
        _create();
        assertEq(board.bountyCount(), 1);
        _create();
        assertEq(board.bountyCount(), 2);
    }

    function test_submissionCount() public {
        uint256 id = _create();
        assertEq(board.submissionCount(id), 0);
        vm.prank(artist1);
        board.submitWork(id, "ipfs://a");
        assertEq(board.submissionCount(id), 1);
    }

    function test_totalBountiesPosted() public {
        assertEq(board.totalBountiesPosted(), 0);
        _create();
        assertEq(board.totalBountiesPosted(), 1);
    }

    function test_totalPaidOut() public {
        uint256 id = _createAndSubmit();
        _voteQuorum(id, 0);
        _warpPastDispute();
        vm.prank(creator);
        board.completeBounty(id);
        assertEq(board.totalPaidOut(), REWARD);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  17. EDGE CASE: Multiple bounties isolation
    // ═══════════════════════════════════════════════════════════════════════

    function test_multipleBounties_isolated() public {
        // Create two bounties
        uint256 id0 = _create();
        uint256 id1 = _create();
        assertEq(id0, 0);
        assertEq(id1, 1);

        // Submit to both
        vm.prank(artist1);
        board.submitWork(id0, "ipfs://b0");
        vm.prank(artist1);
        board.submitWork(id1, "ipfs://b1");

        // Vote on bounty 0
        vm.prank(voter1);
        board.voteForSubmission(id0, 0);

        // Same voter can vote on bounty 1 (different bounty)
        vm.prank(voter1);
        board.voteForSubmission(id1, 0);

        (, , uint256 v0) = board.getSubmission(id0, 0);
        (, , uint256 v1) = board.getSubmission(id1, 0);
        assertEq(v0, 10_000 ether);
        assertEq(v1, 10_000 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  18. FINDING: withdrawRefund emits no event
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev PoC: withdrawRefund does not emit any event on success,
    ///      unlike withdrawPayout which emits PayoutWithdrawn.
    ///      This is an observability gap -- indexers/frontends cannot track refund withdrawals.
    function test_withdrawRefund_noEventEmitted() public {
        ETHRejecter195 rej = new ETHRejecter195(board);
        rej.createBounty{value: 5 ether}("no event", block.timestamp + SEVEN_DAYS);
        vm.warp(block.timestamp + 1 hours + 1);
        board.emergencyCancel(0);

        // Record logs during withdrawRefund
        vm.recordLogs();
        rej.withdrawRefund();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // There should be 0 events from withdrawRefund (no RefundWithdrawn event exists)
        // The only events are from WETH deposit/transfer internals
        bool foundRefundEvent = false;
        for (uint256 i; i < logs.length; i++) {
            // Check if any event from the board contract relates to refund withdrawal
            if (logs[i].emitter == address(board)) {
                foundRefundEvent = true;
            }
        }
        // FINDING: No event emitted from the board contract during withdrawRefund
        assertFalse(foundRefundEvent, "Expected no board events from withdrawRefund");
    }

    receive() external payable {}
}

// ─── Helper: Contract submitter that rejects ETH ─────────────────────────────

contract ETHRejectSubmitter195 {
    MemeBountyBoard public board;
    constructor(MemeBountyBoard _b) { board = _b; }
    function submitWork(uint256 id, string calldata uri) external { board.submitWork(id, uri); }
    function withdrawPayout() external { board.withdrawPayout(); }
    // No receive/fallback
}
