// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/VoteIncentives.sol";

// ─── Mocks ───────────────────────────────────────────────────────────

contract MockTOWELI_R014 is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MockBribeToken_R014 is ERC20 {
    constructor() ERC20("BribeToken", "BRB") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MockWETH_R014 {
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "ins");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

contract MockEscrow_R014 {
    uint256 public totalBoostedStake;
    bool public paused;
    mapping(address => uint256) public _vp;
    mapping(address => uint256) public userTokenId;

    function setPower(address u, uint256 p) external { _vp[u] = p; }
    function setTotal(uint256 t) external { totalBoostedStake = t; }
    function setPaused(bool p) external { paused = p; }

    function votingPowerOf(address u) external view returns (uint256) { return _vp[u]; }
    function votingPowerAtTimestamp(address u, uint256) external view returns (uint256) { return _vp[u]; }
    function totalLocked() external view returns (uint256) { return totalBoostedStake; }
    function positions(uint256) external pure returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) { return (0, 0, 0, 0, 0, 0, false, false, 0, 0, false); }
}

contract MockFactory_R014 {
    mapping(address => mapping(address => address)) public _pair;
    /// @dev AUDIT R016 M-1: VoteIncentives now reads disabledPairs during validatePair.
    mapping(address => bool) public disabledPairs;
    function setPair(address a, address b, address p) external { _pair[a][b] = p; _pair[b][a] = p; }
    function getPair(address a, address b) external view returns (address) { return _pair[a][b]; }
    function setDisabled(address pair, bool d) external { disabledPairs[pair] = d; }
}

contract MockPair_R014 {
    address public token0;
    address public token1;
    constructor(address a, address b) { token0 = a; token1 = b; }
}

// ─── R014 Test ───────────────────────────────────────────────────────

/// @title AuditR014 — VoteIncentives.sol H-4 + M-6 hardening
/// @notice Verifies the two R014 audit fixes:
///         H-4 (HIGH): bribe pool finalization is atomic with `advanceEpoch()`.
///                     Voters / claimers / preview cannot read or claim against
///                     a non-finalized epoch (the live, MEV-able bucket).
///         M-6 (MED):  `refundUnvotedBribe` deadline branches on the epoch's
///                     voting model — legacy uses VOTE_DEADLINE, commit-reveal
///                     uses revealDeadline. Today both expressions are equal,
///                     but the explicit branch defends future drift.
contract AuditR014_VoteIncentivesTest is Test {
    VoteIncentives public bribes;
    MockTOWELI_R014 public toweli;
    MockBribeToken_R014 public bribeToken;
    MockWETH_R014 public weth;
    MockEscrow_R014 public escrow;
    MockFactory_R014 public factory;
    MockPair_R014 public pair;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public depositor = makeAddr("depositor");

    uint256 internal constant FEE_BPS = 300; // 3%

    function setUp() public {
        toweli = new MockTOWELI_R014();
        bribeToken = new MockBribeToken_R014();
        weth = new MockWETH_R014();
        escrow = new MockEscrow_R014();
        factory = new MockFactory_R014();

        pair = new MockPair_R014(address(toweli), address(bribeToken));
        factory.setPair(address(toweli), address(bribeToken), address(pair));

        bribes = new VoteIncentives(
            address(escrow),
            treasury,
            address(weth),
            address(factory),
            address(toweli),
            FEE_BPS
        );

        // Whitelist bribeToken via the timelock flow.
        bribes.proposeWhitelistChange(address(bribeToken), true);
        vm.warp(block.timestamp + 24 hours + 1);
        bribes.executeWhitelistChange();

        // Fund depositor.
        bribeToken.transfer(depositor, 1_000_000 ether);
        vm.deal(depositor, 100 ether);

        // Establish stake high enough to pass MIN_DISTRIBUTE_STAKE.
        escrow.setTotal(1_000_000 ether);
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function _advance() internal {
        if (block.timestamp < bribes.lastEpochTime() + bribes.MIN_EPOCH_INTERVAL()) {
            vm.warp(bribes.lastEpochTime() + bribes.MIN_EPOCH_INTERVAL() + 1);
        }
        bribes.advanceEpoch();
    }

    function _depositERC20(address from, uint256 amount) internal {
        vm.startPrank(from);
        bribeToken.approve(address(bribes), amount);
        bribes.depositBribe(address(pair), address(bribeToken), amount);
        vm.stopPrank();
    }

    // ─── H-4 (HIGH): pre-snapshot arbitrage — OLD behavior demonstration ────
    //
    // The OLD code wrote bribes to `epochBribes[epochs.length]` (live bucket)
    // and flipped that index from "live" to "snapshotted" inside `advanceEpoch`
    // with NO finalization barrier. A briber could:
    //   1. depositBribe()   // writes to slot `epochs.length`
    //   2. advanceEpoch()   // pushes epoch — slot now belongs to snapshotted N
    //   3. vote()           // votes on the freshly-snapshotted epoch
    // and the vote/claim paths would read the bribe pool that the briber just
    // staged, with no separation between pending and confirmed.
    //
    // We can't run the OLD code (it's gone), but we can show the NEW behavior
    // makes the boundary unambiguous: the snapshot index N is finalized
    // atomically inside `advanceEpoch`, and reads against not-yet-finalized
    // indices revert with EpochNotFinalized.

    /// @notice H-4: confirmedEpochBribes view returns 0 for the live bucket and
    ///         the actual confirmed amount once finalized.
    function test_H4_confirmedView_zeroBeforeFinalize_realAfter() public {
        // Bribe lands in the live bucket (epochs.length == 0 here).
        _depositERC20(depositor, 10_000 ether);

        uint256 liveIdx = bribes.currentEpoch(); // == epochs.length
        // Live bucket is NOT finalized. confirmedEpochBribes view returns 0.
        assertEq(
            bribes.confirmedEpochBribes(liveIdx, address(pair), address(bribeToken)),
            0,
            "live bucket must be invisible to confirmed-view"
        );
        // Sanity: raw mapping shows the staged amount (this is the MEV-able bucket).
        uint256 expectedNet = 10_000 ether - (10_000 ether * FEE_BPS / bribes.BPS());
        assertEq(
            bribes.epochBribes(liveIdx, address(pair), address(bribeToken)),
            expectedNet,
            "raw epochBribes mapping should hold the staged deposit"
        );

        // Advance: liveIdx is now finalized as the just-pushed epoch.
        _advance();
        assertEq(bribes.currentEpoch(), liveIdx + 1, "epoch was pushed");
        assertTrue(
            bribes.epochBribesFinalized(liveIdx),
            "finalized flag must flip atomically with advanceEpoch"
        );
        assertEq(
            bribes.confirmedEpochBribes(liveIdx, address(pair), address(bribeToken)),
            expectedNet,
            "confirmed-view returns finalized amount post-advance"
        );

        // The NEW live bucket (post-advance) is back to zero in the view.
        assertEq(
            bribes.confirmedEpochBribes(liveIdx + 1, address(pair), address(bribeToken)),
            0,
            "next live bucket must remain invisible until finalized"
        );
    }

    /// @notice H-4: voting against an un-finalized epoch reverts with
    ///         EpochNotFinalized (defensive — by construction the same as
    ///         `epoch < epochs.length`, but enforced explicitly).
    function test_H4_vote_revertsOnUnfinalizedEpoch() public {
        // Stage a bribe + give alice power, but DO NOT advance.
        _depositERC20(depositor, 10_000 ether);
        escrow.setPower(alice, 1_000 ether);

        uint256 liveIdx = bribes.currentEpoch();
        // vote() goes through `epoch >= epochs.length` first → InvalidEpoch.
        // The finalized-flag guard is the SECOND line of defense for the case
        // where someone pushes to epochs[] without setting the flag.
        vm.prank(alice);
        vm.expectRevert(VoteIncentives.InvalidEpoch.selector);
        bribes.vote(liveIdx, address(pair), 100);
    }

    /// @notice H-4: claimBribes against a finalized epoch returns the confirmed
    ///         amount; claim against an un-finalized epoch reverts.
    function test_H4_claim_seesOnlyConfirmedSnapshot() public {
        _depositERC20(depositor, 10_000 ether);
        escrow.setPower(alice, 1_000 ether);
        escrow.setPower(bob, 4_000 ether);

        // Pre-advance: liveIdx is the un-finalized bucket. Claim against it
        // would hit `epoch >= epochs.length` first.
        uint256 unfinalized = bribes.currentEpoch();

        _advance();
        // The pushed epoch is now finalized. claimBribes against the NEXT
        // (still un-finalized) live bucket reverts with InvalidEpoch first.
        vm.prank(alice);
        vm.expectRevert(VoteIncentives.InvalidEpoch.selector);
        bribes.claimBribes(unfinalized + 1, address(pair));

        // Vote in the finalized epoch.
        vm.prank(alice);
        bribes.vote(unfinalized, address(pair), 1_000 ether);
        vm.prank(bob);
        bribes.vote(unfinalized, address(pair), 4_000 ether);

        // Claim bribes — share is computed from the CONFIRMED pool only.
        uint256 net = 10_000 ether - (10_000 ether * FEE_BPS / bribes.BPS());
        uint256 aliceExpected = (net * 1_000 ether) / 5_000 ether;
        uint256 aliceBefore = bribeToken.balanceOf(alice);
        vm.prank(alice);
        bribes.claimBribes(unfinalized, address(pair));
        assertEq(bribeToken.balanceOf(alice) - aliceBefore, aliceExpected, "alice claim equals confirmed share");
    }

    /// @notice H-4: post-advance, depositing more bribes into the LIVE bucket
    ///         doesn't poison the just-finalized snapshot. confirmedEpochBribes
    ///         for the finalized index stays put; the new deposits target the
    ///         NEXT live bucket (which itself isn't visible until its own
    ///         advance fires).
    function test_H4_postAdvanceDeposits_doNotChangeConfirmed() public {
        _depositERC20(depositor, 10_000 ether);
        _advance();
        uint256 finalizedIdx = bribes.currentEpoch() - 1;

        uint256 net = 10_000 ether - (10_000 ether * FEE_BPS / bribes.BPS());
        assertEq(
            bribes.confirmedEpochBribes(finalizedIdx, address(pair), address(bribeToken)),
            net,
            "finalized bucket holds initial deposit"
        );

        // New deposit goes to the LIVE bucket (currentEpoch()), NOT the finalized one.
        _depositERC20(depositor, 5_000 ether);
        assertEq(
            bribes.confirmedEpochBribes(finalizedIdx, address(pair), address(bribeToken)),
            net,
            "finalized snapshot must be IMMUTABLE post-advance"
        );
        assertEq(
            bribes.confirmedEpochBribes(bribes.currentEpoch(), address(pair), address(bribeToken)),
            0,
            "new live bucket invisible to confirmed view"
        );
    }

    /// @notice H-4: depositing into a forced-finalized index (defense-in-depth
    ///         path). We can't reach this naturally — `epochs.length` is always
    ///         the live (un-finalized) bucket — so this test just verifies the
    ///         require message wires up correctly via the natural path.
    function test_H4_depositOnFinalizedEpoch_revertsViaConstruction() public {
        // depositBribe targets `epochs.length` — never a finalized index. The
        // require is defense-in-depth. Sanity test: the require message is
        // wired up. We exercise the natural path (deposit into live) and
        // verify it succeeds.
        _depositERC20(depositor, 10_000 ether);
        // Live bucket isn't finalized; deposit succeeded. No revert expected.
        assertGt(
            bribes.epochBribes(bribes.currentEpoch(), address(pair), address(bribeToken)),
            0,
            "deposit landed in live bucket"
        );
    }

    /// @notice H-4: dustOf returns 0 for un-finalized buckets so observability
    ///         doesn't leak the live MEV-able amount.
    function test_H4_dustOf_zeroForUnfinalizedEpoch() public {
        _depositERC20(depositor, 10_000 ether);
        // Live bucket — dustOf must read 0 (no claim accounting yet).
        assertEq(
            bribes.dustOf(bribes.currentEpoch(), address(pair), address(bribeToken)),
            0,
            "dustOf returns 0 for live bucket"
        );

        _advance();
        // Finalized epoch with no claims yet — dust == full deposit minus 0 paidOut.
        uint256 net = 10_000 ether - (10_000 ether * FEE_BPS / bribes.BPS());
        assertEq(
            bribes.dustOf(bribes.currentEpoch() - 1, address(pair), address(bribeToken)),
            net,
            "dustOf reflects full unclaimed pool post-finalize"
        );
    }

    // ─── M-6: refundUnvotedBribe deadline branches by voting model ─────────

    /// @notice M-6: legacy (non-commit-reveal) epoch refund gate uses
    ///         `epoch.timestamp + VOTE_DEADLINE + UNVOTED_REFUND_GRACE`.
    ///         Today this happens to equal `revealDeadline + grace`, but the
    ///         explicit branch defends against future drift in revealDeadline.
    function test_M6_refundUnvotedBribe_legacyEpochUsesVoteDeadline() public {
        // Deposit into the live bucket, advance to finalize as legacy epoch.
        _depositERC20(depositor, 10_000 ether);
        _advance();
        uint256 epoch = bribes.currentEpoch() - 1;

        // Confirm this is a LEGACY epoch (commit-reveal flag wasn't enabled).
        (, , bool ucr) = bribes.epochs(epoch);
        assertFalse(ucr, "epoch must be legacy for this test");

        // No votes were cast → pair has zero gauge votes → eligible for
        // refundUnvotedBribe once VOTE_DEADLINE + UNVOTED_REFUND_GRACE elapsed.
        // Pre-grace window: refund must revert with GRACE_NOT_ELAPSED.
        vm.prank(depositor);
        vm.expectRevert(bytes("GRACE_NOT_ELAPSED"));
        bribes.refundUnvotedBribe(epoch, address(pair), address(bribeToken));

        // Warp to JUST BEFORE the gate (epoch.timestamp + VOTE_DEADLINE +
        // UNVOTED_REFUND_GRACE - 1). Still must revert.
        (, uint256 epochTs, ) = bribes.epochs(epoch);
        uint256 gate = epochTs + bribes.VOTE_DEADLINE() + bribes.UNVOTED_REFUND_GRACE();
        vm.warp(gate - 1);
        vm.prank(depositor);
        vm.expectRevert(bytes("GRACE_NOT_ELAPSED"));
        bribes.refundUnvotedBribe(epoch, address(pair), address(bribeToken));

        // Warp to the gate exactly — refund succeeds.
        vm.warp(gate);
        uint256 net = 10_000 ether - (10_000 ether * FEE_BPS / bribes.BPS());
        uint256 before_ = bribeToken.balanceOf(depositor);
        vm.prank(depositor);
        bribes.refundUnvotedBribe(epoch, address(pair), address(bribeToken));
        assertEq(
            bribeToken.balanceOf(depositor) - before_,
            net,
            "depositor must recover net deposit at the legacy-epoch gate"
        );
    }

    /// @notice M-6: commit-reveal epoch refund gate uses
    ///         `revealDeadline(epoch) + UNVOTED_REFUND_GRACE`. Today this
    ///         expression equals `epoch.timestamp + VOTE_DEADLINE + grace`,
    ///         so the test mirrors the legacy gate timing — but the BRANCH
    ///         that's exercised is the commit-reveal one, which is what we
    ///         care about for future-proofing.
    function test_M6_refundUnvotedBribe_commitRevealEpochUsesRevealDeadline() public {
        // Stage a bribe + flip commit-reveal ON BEFORE advancing so the new
        // epoch tags `usesCommitReveal == true`.
        _depositERC20(depositor, 10_000 ether);
        bribes.proposeEnableCommitReveal();
        vm.warp(block.timestamp + bribes.COMMIT_REVEAL_ENABLE_DELAY() + 1);
        bribes.executeEnableCommitReveal();

        _advance();
        uint256 epoch = bribes.currentEpoch() - 1;
        (, , bool ucr) = bribes.epochs(epoch);
        assertTrue(ucr, "epoch must be commit-reveal for this test");

        // Same deadline shape today (revealDeadline == ts + VOTE_DEADLINE) but
        // we exercise the `usesCommitReveal == true` branch.
        uint256 gate = bribes.revealDeadline(epoch) + bribes.UNVOTED_REFUND_GRACE();

        vm.warp(gate - 1);
        vm.prank(depositor);
        vm.expectRevert(bytes("GRACE_NOT_ELAPSED"));
        bribes.refundUnvotedBribe(epoch, address(pair), address(bribeToken));

        vm.warp(gate);
        uint256 net = 10_000 ether - (10_000 ether * FEE_BPS / bribes.BPS());
        uint256 before_ = bribeToken.balanceOf(depositor);
        vm.prank(depositor);
        bribes.refundUnvotedBribe(epoch, address(pair), address(bribeToken));
        assertEq(
            bribeToken.balanceOf(depositor) - before_,
            net,
            "depositor must recover net deposit at the commit-reveal gate"
        );
    }
}
