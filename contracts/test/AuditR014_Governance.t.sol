// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/GaugeController.sol";
import "../src/CommunityGrants.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

/// @title AuditR014_Governance — Tests for the R014 governance audit fixes
/// @notice One test per finding from the audit:
///   * HIGH    — GaugeController vote rotation via abandoned commits
///   * MEDIUM  — GaugeController reveal window clock skew (5-min grace buffer)
///   * LOW     — GaugeController zero-weight gauge entries
///   * MEDIUM  — CommunityGrants paginated proposal queries
///   * MEDIUM  — CommunityGrants fee-receiver dry-run validation
///
/// Each test references the finding it covers and would fail if the
/// corresponding fix were reverted.

// ─── Mocks ──────────────────────────────────────────────────────────────────

contract MockTOWELI_R014G is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev Minimal mock implementing GaugeController's ITegridyStakingGauge interface.
///      We control ownership and voting power directly per tokenId so we can simulate
///      a multi-NFT contract holder rotating commits across tokens within an epoch
///      without standing up a full TegridyStaking integration (which enforces a
///      single-NFT-per-EOA invariant in `_update`).
contract MockStakingR014G {
    // Position field shape mirrors TegridyStaking.Position for ABI compatibility.
    struct Pos {
        uint256 amount;
        uint256 boostedAmount;
        int256 rewardDebt;
        uint256 lockEnd;
        uint256 boostBps;
        uint256 lockDuration;
        bool autoMaxLock;
        bool hasJbacBoost;
        uint256 stakeTimestamp;
        uint256 jbacTokenId;
        bool jbacDeposited;
    }

    mapping(uint256 => Pos) internal _positions;
    mapping(uint256 => address) internal _owners;
    mapping(address => uint256) public defaultPower;

    function setOwner(uint256 tokenId, address owner_) external {
        _owners[tokenId] = owner_;
    }

    function setPosition(uint256 tokenId, uint256 amount, uint256 lockEnd) external {
        _positions[tokenId] = Pos({
            amount: amount,
            boostedAmount: amount,
            rewardDebt: 0,
            lockEnd: lockEnd,
            boostBps: 10000,
            lockDuration: 365 days,
            autoMaxLock: false,
            hasJbacBoost: false,
            stakeTimestamp: 1,
            jbacTokenId: 0,
            jbacDeposited: false
        });
    }

    function setPower(address user, uint256 power) external {
        defaultPower[user] = power;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _owners[tokenId];
    }

    function positions(uint256 tokenId) external view returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) {
        Pos memory p = _positions[tokenId];
        return (
            p.amount, p.boostedAmount, p.rewardDebt, p.lockEnd,
            p.boostBps, p.lockDuration, p.autoMaxLock, p.hasJbacBoost,
            p.stakeTimestamp, p.jbacTokenId, p.jbacDeposited
        );
    }

    function votingPowerAtTimestamp(address user, uint256 /*ts*/) external view returns (uint256) {
        return defaultPower[user];
    }

    /// @notice AUDIT FIX: DEEP-GOV-01 — current-power view used by the
    ///         min(historical, current) clamp at vote / revealVote sites.
    function votingPowerOf(address user) external view returns (uint256) {
        return defaultPower[user];
    }
}

/// @dev Mock VotingEscrow used by CommunityGrants tests. Mirrors the proposer-pointer
///      requirements of the contract (NEW-G7) so proposals don't get bounced by the
///      ProposerMissingStakingPointer guard.
contract MockVE_R014G {
    mapping(address => uint256) public powers;
    uint256 public totalLocked;

    function setPower(address user, uint256 power) external {
        totalLocked = totalLocked - powers[user] + power;
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

    function totalBoostedStake() external view returns (uint256) {
        return totalLocked;
    }

    function userTokenId(address user) external pure returns (uint256) {
        // NEW-G7 mock convenience: per-address-unique non-zero default.
        return uint256(uint160(user));
    }

    function holdsToken(address user, uint256 tokenId) external pure returns (bool) {
        return uint256(uint160(user)) == tokenId;
    }

    /// @dev BATCH-A C3: historical denominator — mock returns current total.
    function totalBoostedStakeAtTimestamp(uint256) external view returns (uint256) {
        return totalLocked;
    }

    /// @dev BATCH-E H11: proposer-must-have-single-position rule — mock returns 1.
    function userPositionCount(address) external pure returns (uint256) {
        return 1;
    }
}

/// @dev WETH mock kept here for interface parity (these tests don't exercise the WETH path).
contract MockWETH_R014G {
    function deposit() external payable { revert("WETH_BROKEN"); }
    function transfer(address, uint256) external pure returns (bool) { return false; }
    receive() external payable {}
}

/// @dev TOWELI variant that refuses to transfer to a flagged blacklisted address.
///      Used for the fee-receiver dry-run failure test.
contract MockTOWELIBlacklist is ERC20 {
    mapping(address => bool) public blacklisted;
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    function setBlacklisted(address who, bool b) external {
        blacklisted[who] = b;
    }
    function _update(address from, address to, uint256 value) internal override {
        require(!blacklisted[to], "ERC20: blacklisted");
        super._update(from, to, value);
    }
}

// ─── Test contract ──────────────────────────────────────────────────────────

contract AuditR014_GovernanceTest is Test {
    // GaugeController setup
    GaugeController public gauge;
    MockStakingR014G public staking;

    // CommunityGrants setup
    CommunityGrants public grants;
    MockTOWELI_R014G public toweli;
    MockTOWELIBlacklist public towelieBL;
    MockVE_R014G public ve;
    MockWETH_R014G public wethMock;

    // Common addresses
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public artist = makeAddr("artist");
    address public treasury = makeAddr("treasury");

    address public g1 = makeAddr("gauge1");
    address public g2 = makeAddr("gauge2");
    address public g3 = makeAddr("gauge3");

    // Multi-NFT holder addresses (simulated via mock)
    address public multiHolder = makeAddr("multiHolder");
    uint256 public constant TOKEN_A = 1001;
    uint256 public constant TOKEN_B = 1002;

    function setUp() public {
        // ── GaugeController side ─────────────────────────────────────
        staking = new MockStakingR014G();
        gauge = new GaugeController(address(staking), 1_000_000 ether);

        // Two NFTs both owned by `multiHolder` — simulates a multi-NFT contract wallet.
        // TegridyStaking's _update guard prevents this for EOAs in production, but a
        // Safe / vault contract can legitimately hold both. The bug under test only
        // matters for that case.
        staking.setOwner(TOKEN_A, multiHolder);
        staking.setOwner(TOKEN_B, multiHolder);
        // Long lock that easily outlasts any single epoch we exercise in these tests.
        staking.setPosition(TOKEN_A, 100_000 ether, block.timestamp + 365 days);
        staking.setPosition(TOKEN_B, 100_000 ether, block.timestamp + 365 days);
        staking.setPower(multiHolder, 100_000 ether);

        // Single-NFT users for the standard scenarios
        staking.setOwner(2001, alice);
        staking.setPosition(2001, 100_000 ether, block.timestamp + 365 days);
        staking.setPower(alice, 100_000 ether);
        staking.setOwner(2002, bob);
        staking.setPosition(2002, 100_000 ether, block.timestamp + 365 days);
        staking.setPower(bob, 100_000 ether);

        _addGauge(g1);
        _addGauge(g2);
        _addGauge(g3);

        // ── CommunityGrants side ─────────────────────────────────────
        toweli = new MockTOWELI_R014G();
        ve = new MockVE_R014G();
        wethMock = new MockWETH_R014G();
        grants = new CommunityGrants(address(ve), address(toweli), treasury, address(wethMock));

        ve.setPower(alice, 20_000 ether);
        ve.setPower(bob, 10_000 ether);
        ve.setPower(carol, 30_000 ether);

        toweli.transfer(alice, 500_000 ether);
        toweli.transfer(bob, 500_000 ether);
        toweli.transfer(carol, 500_000 ether);

        vm.prank(alice);
        toweli.approve(address(grants), type(uint256).max);
        vm.prank(bob);
        toweli.approve(address(grants), type(uint256).max);
        vm.prank(carol);
        toweli.approve(address(grants), type(uint256).max);

        vm.deal(address(grants), 100 ether);
    }

    // ── Helpers ─────────────────────────────────────────────────────

    function _addGauge(address g) internal {
        // AUDIT FIX G-02: proposeAddGauge requires gauge.code.length > 0.
        // AUDIT FIX (pass-8) GOV-INT-01: now also requires a `pair` arg.
        if (g.code.length == 0) vm.etch(g, hex"60006000fd");
        address pair = address(uint160(g) ^ uint160(1));
        if (pair.code.length == 0) vm.etch(pair, hex"60006000fd");
        gauge.proposeAddGauge(g, pair);
        vm.warp(block.timestamp + 24 hours + 1);
        gauge.executeAddGauge();
    }

    /// @dev Move into the commit window of the current epoch. `_addGauge` warps
    ///      well into mid-epoch; this is mostly a no-op nudge for clarity.
    function _warpToCommitWindow() internal {
        // Ensure we're at least REVEAL_GRACE+REVEAL_WINDOW before the formal close,
        // i.e. firmly inside the commit window of the current epoch.
        uint256 epoch = gauge.currentEpoch();
        uint256 revealOpens = gauge.epochStartTime(epoch) + 7 days - 24 hours;
        // If we're already past commit window for this epoch, advance to next one.
        if (block.timestamp + gauge.REVEAL_GRACE() >= revealOpens) {
            vm.warp(gauge.epochStartTime(epoch + 1) + 1 hours);
        }
    }

    function _warpToRevealWindow() internal {
        uint256 epoch = gauge.currentEpoch();
        uint256 revealOpens = gauge.epochStartTime(epoch) + 7 days - 24 hours;
        vm.warp(revealOpens + 1);
    }

    function _ballot(address gA, uint256 wA, address gB, uint256 wB)
        internal
        pure
        returns (address[] memory gauges, uint256[] memory weights)
    {
        gauges = new address[](2);
        weights = new uint256[](2);
        gauges[0] = gA;
        gauges[1] = gB;
        weights[0] = wA;
        weights[1] = wB;
    }

    // ═══════════════════════════════════════════════════════════════
    //  Finding 1 (HIGH): vote rotation via abandoned commits
    // ═══════════════════════════════════════════════════════════════

    /// @notice Multi-NFT holder commits with TOKEN_A, then attempts to commit with
    ///         TOKEN_B in the same epoch. Without the fix the second commit is
    ///         accepted and the holder can wait for other revealers, then reveal
    ///         only with whichever NFT is most advantageous (abandoning the other
    ///         commit). With the per-user active-commit guard, the second commit
    ///         reverts with `UserHasActiveCommit` and the holder must explicitly
    ///         cancel the first commit during the commit window before swapping.
    function test_R014H_AbandonedCommitRotationBlocked() public {
        _warpToCommitWindow();

        (address[] memory gauges, uint256[] memory weights) = _ballot(g1, 6000, g2, 4000);
        uint256 epoch = gauge.currentEpoch();
        bytes32 saltA = keccak256("A");
        bytes32 hashA = gauge.computeCommitment(multiHolder, TOKEN_A, gauges, weights, saltA, epoch);

        vm.prank(multiHolder);
        gauge.commitVote(TOKEN_A, hashA);
        // Sanity: per-user active commit was recorded
        assertEq(gauge.userActiveCommit(multiHolder, epoch), hashA, "commit-A recorded");
        assertEq(gauge.userActiveCommitTokenId(multiHolder, epoch), TOKEN_A, "tokenId pinned");

        // Attempt to rotate into TOKEN_B without cancelling — must revert.
        bytes32 saltB = keccak256("B");
        bytes32 hashB = gauge.computeCommitment(multiHolder, TOKEN_B, gauges, weights, saltB, epoch);
        vm.prank(multiHolder);
        vm.expectRevert(GaugeController.UserHasActiveCommit.selector);
        gauge.commitVote(TOKEN_B, hashB);

        // Holder cancels the first commit (still during commit window).
        vm.prank(multiHolder);
        gauge.cancelCommit(epoch);
        assertEq(gauge.userActiveCommit(multiHolder, epoch), bytes32(0), "active commit cleared");
        assertEq(gauge.commitmentOf(TOKEN_A, epoch), bytes32(0), "per-token commit cleared");

        // Now the holder may commit with TOKEN_B.
        vm.prank(multiHolder);
        gauge.commitVote(TOKEN_B, hashB);

        // Critical: cancellation is forbidden once the reveal window opens. Otherwise
        // the holder could commit with TOKEN_B, watch other reveals, then null the
        // commit if it turns out unfavorable — same observation-then-rotate vector
        // we're closing.
        _warpToRevealWindow();
        vm.prank(multiHolder);
        vm.expectRevert(GaugeController.CancelWindowClosed.selector);
        gauge.cancelCommit(epoch);

        // The TOKEN_B commitment still reveals normally to confirm the happy path
        // round-trips end-to-end.
        vm.prank(multiHolder);
        gauge.revealVote(TOKEN_B, gauges, weights, saltB);
        assertTrue(gauge.hasVotedInEpoch(TOKEN_B, epoch), "TOKEN_B vote applied");
    }

    // ═══════════════════════════════════════════════════════════════
    //  Finding 2 (MEDIUM): reveal-window clock skew grace buffer
    // ═══════════════════════════════════════════════════════════════

    /// @notice Reveal must be accepted REVEAL_GRACE before the formal opening and
    ///         REVEAL_GRACE after the formal close. Without the buffer, validators
    ///         running ±15s ahead/behind would silently brick reveals at the
    ///         boundary. Outside the graced window the reveal still reverts.
    function test_R014M_RevealWindowGraceBufferAccepted() public {
        _warpToCommitWindow();
        (address[] memory gauges, uint256[] memory weights) = _ballot(g1, 5000, g2, 5000);
        uint256 epoch = gauge.currentEpoch();
        bytes32 salt = keccak256("grace");
        bytes32 h = gauge.computeCommitment(alice, 2001, gauges, weights, salt, epoch);

        vm.prank(alice);
        gauge.commitVote(2001, h);

        uint256 revealOpens = gauge.epochStartTime(epoch) + 7 days - 24 hours;

        // ── Early-graced reveal: REVEAL_GRACE - 1 BEFORE the formal open should
        //    still succeed. Without the fix this reverts with RevealWindowNotOpen.
        vm.warp(revealOpens - (gauge.REVEAL_GRACE() - 1));
        vm.prank(alice);
        gauge.revealVote(2001, gauges, weights, salt);

        // The vote is applied, so the per-token guard fires on a re-attempt.
        assertTrue(gauge.hasVotedInEpoch(2001, epoch), "vote applied at graced opening");

        // ── Beyond the graced opening, the gate still fires.
        // Use a fresh tokenId so the AlreadyVotedThisEpoch guard doesn't shadow.
        // bob commits a new vote we'll try to reveal too early.
        bytes32 saltB = keccak256("graceB");
        bytes32 hB = gauge.computeCommitment(bob, 2002, gauges, weights, saltB, epoch);
        // Roll back to commit window for bob's commit — the original commit window
        // is still open if we rewind past `revealOpens - REVEAL_GRACE` and within
        // the same epoch boundary.
        vm.warp(revealOpens - 2 hours);
        vm.prank(bob);
        gauge.commitVote(2002, hB);

        // Try to reveal `REVEAL_GRACE + 1` BEFORE revealOpens — should still revert.
        vm.warp(revealOpens - (gauge.REVEAL_GRACE() + 1));
        vm.prank(bob);
        vm.expectRevert(GaugeController.RevealWindowNotOpen.selector);
        gauge.revealVote(2002, gauges, weights, saltB);
    }

    // ═══════════════════════════════════════════════════════════════
    //  Finding 3 (LOW): zero-weight gauge entries rejected
    // ═══════════════════════════════════════════════════════════════

    /// @notice Submitting a vote with a `weights[i] == 0` entry must revert with
    ///         `ZeroWeight`. Without the fix the entry is silently kept, padding
    ///         storage with no-op allocations.
    function test_R014L_ZeroWeightGaugeRejected() public {
        _warpToCommitWindow();
        // Three gauges, middle entry has zero weight; remaining two sum to BPS
        // so the existing WeightsMustSumToBPS gate would NOT catch this case.
        address[] memory gauges = new address[](3);
        uint256[] memory weights = new uint256[](3);
        gauges[0] = g1; gauges[1] = g2; gauges[2] = g3;
        weights[0] = 5000; weights[1] = 0; weights[2] = 5000;

        vm.prank(alice);
        vm.expectRevert(GaugeController.ZeroWeight.selector);
        gauge.vote(2001, gauges, weights);

        // Same enforcement on the reveal path.
        uint256 epoch = gauge.currentEpoch();
        bytes32 salt = keccak256("zw");
        bytes32 h = gauge.computeCommitment(alice, 2001, gauges, weights, salt, epoch);
        vm.prank(alice);
        gauge.commitVote(2001, h);

        _warpToRevealWindow();
        vm.prank(alice);
        vm.expectRevert(GaugeController.ZeroWeight.selector);
        gauge.revealVote(2001, gauges, weights, salt);
    }

    // ═══════════════════════════════════════════════════════════════
    //  Finding 4 (MEDIUM): paginated proposal queries
    // ═══════════════════════════════════════════════════════════════

    /// @notice `getProposalsInRange` and `getProposalsByStatus` must return bounded
    ///         windows over the proposals array, with correct clamping at the end
    ///         and a resumable cursor for the status-filtered variant.
    function test_R014M_PaginatedProposalQueries() public {
        // Create five proposals from three different proposers (active proposal cap is 50).
        // We need 5 distinct proposers because the per-proposer cooldown is 1 day and
        // the proposal-snapshot lookback complicates re-using proposers within the same
        // window. Add two extra holders to round out the set.
        address dave = makeAddr("dave");
        address eve = makeAddr("eve");
        ve.setPower(dave, 8_000 ether);
        ve.setPower(eve, 8_000 ether);
        toweli.transfer(dave, 500_000 ether);
        toweli.transfer(eve, 500_000 ether);
        vm.prank(dave);
        toweli.approve(address(grants), type(uint256).max);
        vm.prank(eve);
        toweli.approve(address(grants), type(uint256).max);

        address[5] memory proposers = [alice, bob, carol, dave, eve];
        for (uint256 i; i < 5; ++i) {
            vm.prank(proposers[i]);
            grants.createProposal(artist, 1 ether, "p");
        }

        // ── getProposalsInRange happy path
        CommunityGrants.Proposal[] memory firstThree = grants.getProposalsInRange(0, 3);
        assertEq(firstThree.length, 3, "range [0,3) returns 3");
        assertEq(firstThree[0].proposer, alice, "first is alice");
        assertEq(firstThree[1].proposer, bob, "second is bob");

        // ── End clamping: ask for more than exists
        CommunityGrants.Proposal[] memory tail = grants.getProposalsInRange(3, type(uint256).max);
        assertEq(tail.length, 2, "range clamps to length");

        // ── Inverted/empty range returns empty array, no revert
        CommunityGrants.Proposal[] memory empty = grants.getProposalsInRange(4, 4);
        assertEq(empty.length, 0, "inverted/empty returns empty");

        // ── getProposalsByStatus with limit & cursor
        // Cancel proposal #1 so we have a non-trivial mix of statuses.
        grants.cancelProposal(1);

        // First page: scan for Active starting at 0, limit 2.
        (uint256[] memory ids1, CommunityGrants.Proposal[] memory page1, uint256 next1) =
            grants.getProposalsByStatus(CommunityGrants.ProposalStatus.Active, 0, 2);
        // Active proposals are 0, 2, 3, 4 (1 is cancelled). First page captures 0 and 2.
        assertEq(page1.length, 2, "page1 size == limit");
        assertEq(ids1[0], 0, "first active id");
        assertEq(ids1[1], 2, "second active id");
        assertGt(next1, 2, "cursor advanced past last match");

        // Resume from cursor.
        (uint256[] memory ids2, CommunityGrants.Proposal[] memory page2, uint256 next2) =
            grants.getProposalsByStatus(CommunityGrants.ProposalStatus.Active, next1, 10);
        assertEq(page2.length, 2, "page2 captures remaining 2");
        assertEq(ids2[0], 3);
        assertEq(ids2[1], 4);
        assertEq(next2, grants.proposalCount(), "scan reached end");

        // Cancelled status returns proposal #1.
        (uint256[] memory cIds, , ) =
            grants.getProposalsByStatus(CommunityGrants.ProposalStatus.Cancelled, 0, 10);
        assertEq(cIds.length, 1);
        assertEq(cIds[0], 1, "cancelled id is 1");
    }

    // ═══════════════════════════════════════════════════════════════
    //  Finding 5 (MEDIUM): fee-receiver dry-run validation
    // ═══════════════════════════════════════════════════════════════

    /// @notice A fee-receiver change targeting a TOWELI-blacklisted address must
    ///         be auto-cancelled at execution time. The dry-run sends 1 wei TOWELI
    ///         and detects the rejection without rotating fees to a black-hole.
    function test_R014M_FeeReceiverDryRunRejectsBlacklistedReceiver() public {
        // Build a fresh grants instance against a blacklist-aware TOWELI mock.
        towelieBL = new MockTOWELIBlacklist();
        MockVE_R014G ve2 = new MockVE_R014G();
        MockWETH_R014G weth2 = new MockWETH_R014G();
        CommunityGrants grants2 = new CommunityGrants(address(ve2), address(towelieBL), treasury, address(weth2));

        // Seed the grants contract with TOWELI so the dry-run has spare balance.
        towelieBL.transfer(address(grants2), 1_000 ether);

        address bad = makeAddr("blacklistedReceiver");
        towelieBL.setBlacklisted(bad, true);

        grants2.proposeFeeReceiver(bad);
        vm.warp(block.timestamp + 48 hours);

        // Execute should auto-cancel via the dry-run path: emit FeeReceiverChangeRejected,
        // clear pendingFeeReceiver, and return without rotating fees. We don't revert
        // because reverting would unwind the auto-cancel state changes.
        vm.expectEmit(true, false, false, true, address(grants2));
        emit CommunityGrants.FeeReceiverChangeRejected(bad, "DRY_RUN_TRANSFER_FAILED");
        grants2.executeFeeReceiverChange();

        // Auto-cancel: pending pointer was cleared.
        assertEq(grants2.pendingFeeReceiver(), address(0), "pending fee receiver cleared on dry-run failure");
        // The original feeReceiver is unchanged.
        assertEq(grants2.feeReceiver(), treasury, "feeReceiver untouched");

        // ── Sanity: a normal (non-blacklisted) receiver passes the dry-run and
        //    the change commits successfully. The test 1-wei stays with the receiver.
        address good = makeAddr("goodReceiver");
        uint256 goodBalanceBefore = towelieBL.balanceOf(good);

        grants2.proposeFeeReceiver(good);
        // Capture block.timestamp explicitly so the optimizer can't fold the warp
        // argument across statements.
        uint256 nowTs = block.timestamp;
        vm.warp(nowTs + 48 hours + 1);
        grants2.executeFeeReceiverChange();

        assertEq(grants2.feeReceiver(), good, "good receiver applied");
        assertEq(towelieBL.balanceOf(good) - goodBalanceBefore, 1, "1 wei dry-run delivered");
    }

    receive() external payable {}
}
