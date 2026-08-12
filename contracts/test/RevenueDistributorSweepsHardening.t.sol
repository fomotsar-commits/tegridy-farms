// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/RevenueDistributor.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

/// @dev Minimal IVotingEscrow mock. Deliberately does NOT implement
///      `totalBoostedStakeAtTimestamp` so `_distribute` exercises its
///      documented live-value catch fallback.
contract MockVE_Sweeps {
    mapping(address => uint256) public lockedAmounts;
    mapping(address => uint256) public lockEnds;
    mapping(address => uint256) public userTokenId;
    mapping(uint256 => address) public tokenOwner;
    uint256 public totalLocked;
    uint256 private _next = 1;

    function setLock(address u, uint256 a, uint256 e) external {
        if (userTokenId[u] == 0) {
            uint256 t = _next++;
            userTokenId[u] = t;
            tokenOwner[t] = u;
        }
        totalLocked = totalLocked - lockedAmounts[u] + a;
        lockedAmounts[u] = a;
        lockEnds[u] = e;
    }

    function votingPowerOf(address u) external view returns (uint256) { return lockedAmounts[u]; }
    function votingPowerAtTimestamp(address u, uint256) external view returns (uint256) { return lockedAmounts[u]; }
    function totalBoostedStake() external view returns (uint256) { return totalLocked; }

    function positions(uint256 id) external view returns (
        uint256, uint256, int256, uint256, uint256, uint256, bool, bool, uint256, uint256, bool
    ) {
        address u = tokenOwner[id];
        return (lockedAmounts[u], lockedAmounts[u], int256(0), lockEnds[u], 10000, 0, false, false, 0, 0, false);
    }

    function paused() external pure returns (bool) { return false; }
}

contract MockWETH_Sweeps {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

/// @dev No receive()/fallback() — every ETH push to it reverts, so claims are
///      routed into `pendingWithdrawals`.
contract Rejecter_Sweeps {}

/// @title RevenueDistributor — dust-sweep / auto-reconcile / reserved-accounting hardening
/// @notice Lane `revdist-sweeps`. Each test below is written to FAIL on pre-fix source.
contract RevenueDistributorSweepsHardeningTest is Test {
    MockVE_Sweeps public ve;
    MockWETH_Sweeps public weth;
    RevenueDistributor public dist;

    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public attacker = makeAddr("attacker");
    address public treasury = makeAddr("treasury");

    /// @dev Literal key, NOT `dist.DUST_SWEEP()`, so this file compiles against
    ///      pre-fix source and the tests fail on BEHAVIOUR rather than on a
    ///      missing getter.
    bytes32 internal constant DUST_SWEEP_KEY = keccak256("DUST_SWEEP");

    function setUp() public {
        vm.warp(4 hours + 1);
        ve = new MockVE_Sweeps();
        weth = new MockWETH_Sweeps();
        dist = new RevenueDistributor(address(ve), treasury, address(weth));

        ve.setLock(alice, 100_000 ether, block.timestamp + 3650 days);
        ve.setLock(bob, 100_000 ether, block.timestamp + 3650 days);
    }

    function _fund(uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        (bool ok,) = address(dist).call{value: amount}("");
        assertTrue(ok, "fund");
    }

    function _fundAndDistribute(uint256 amount) internal {
        _fund(amount);
        dist.distribute();
    }

    function _proposeDustSweep() internal returns (bool ok) {
        (ok,) = address(dist).call(abi.encodeWithSignature("proposeDustSweep()"));
    }

    // ══════════════════════════════════════════════════════════════════
    //  (a) sweepDust() must be timelocked like its three siblings
    // ══════════════════════════════════════════════════════════════════

    /// PRE-FIX: `sweepDust()` is a byte-for-byte clone of
    /// `executeEmergencyWithdrawExcess()` minus the `_execute()` call — the owner
    /// moves the identical amount to the identical destination with delay 0.
    function test_sweepDust_requiresTimelockProposal() public {
        vm.deal(address(dist), 5 ether);
        uint256 tb = treasury.balance;

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, DUST_SWEEP_KEY));
        dist.sweepDust();

        assertEq(treasury.balance, tb, "no ETH may leave with delay 0");
        assertEq(address(dist).balance, 5 ether, "balance untouched");
    }

    /// PRE-FIX: `sweepDust`'s reserve excludes UNDISTRIBUTED revenue, so the owner
    /// can take the entire pre-distribution float in a single transaction.
    function test_sweepDust_cannotTakePreDistributionFloatInstantly() public {
        _fund(20 ether); // revenue has landed but no epoch exists yet
        assertEq(dist.totalEarmarked(), 0, "nothing earmarked yet");

        uint256 tb = treasury.balance;
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, DUST_SWEEP_KEY));
        dist.sweepDust();

        assertEq(treasury.balance, tb, "pre-distribution float must not be instantly takeable");
        assertEq(address(dist).balance, 20 ether, "float stays in the contract");
    }

    function test_sweepDust_timelockEnforcedBeforeDelay() public {
        vm.deal(address(dist), 5 ether);
        assertTrue(_proposeDustSweep(), "proposeDustSweep() must exist");

        vm.warp(block.timestamp + 47 hours);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, DUST_SWEEP_KEY));
        dist.sweepDust();
    }

    function test_sweepDust_succeedsAfterTimelock() public {
        vm.deal(address(dist), 5 ether);
        assertTrue(_proposeDustSweep(), "proposeDustSweep() must exist");

        vm.warp(block.timestamp + 48 hours + 1);
        uint256 tb = treasury.balance;
        dist.sweepDust();
        assertEq(treasury.balance - tb, 5 ether, "capability preserved behind the delay");
    }

    function test_sweepDust_proposalCanBeCancelled() public {
        vm.deal(address(dist), 5 ether);
        assertTrue(_proposeDustSweep(), "proposeDustSweep() must exist");
        (bool ok,) = address(dist).call(abi.encodeWithSignature("cancelDustSweep()"));
        assertTrue(ok, "cancelDustSweep() must exist");

        vm.warp(block.timestamp + 48 hours + 1);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, DUST_SWEEP_KEY));
        dist.sweepDust();
    }

    /// A queued DUST_SWEEP must not survive an ownership handoff (mirrors the
    /// existing flush for the four sibling keys).
    function test_sweepDust_proposalFlushedOnOwnershipHandoff() public {
        vm.deal(address(dist), 5 ether);
        assertTrue(_proposeDustSweep(), "proposeDustSweep() must exist");

        address newOwner = makeAddr("newOwner");
        dist.transferOwnership(newOwner);
        vm.prank(newOwner);
        dist.acceptOwnership();

        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, DUST_SWEEP_KEY));
        dist.sweepDust();
    }

    // ══════════════════════════════════════════════════════════════════
    //  (b) permissionless autoReconcileDust must not rug active stakers
    // ══════════════════════════════════════════════════════════════════

    /// PRE-FIX: anyone may drain any epoch older than 180 days regardless of
    /// ACTIVE locks, moving the ETH out of `totalEarmarked` and into the
    /// owner-sweepable surplus — entirely outside the 1% lifetime forfeit cap.
    function test_autoReconcileDust_cannotRugActiveStaker() public {
        _fundAndDistribute(10 ether); // epoch 0 — alice is owed 5 ETH
        vm.warp(block.timestamp + 180 days + 1);
        _fundAndDistribute(10 ether); // epoch 1

        assertEq(dist.pendingETH(alice), 10 ether, "alice owed 5 + 5");

        vm.prank(attacker);
        // Low-level so the post-fix revert does not abort the test.
        (bool ok,) = address(dist).call(abi.encodeWithSignature("autoReconcileDust()"));
        ok; // pre-fix: true (epoch 0 drained). post-fix: false (disabled).

        // alice's lock is still ACTIVE and has no claim deadline.
        vm.prank(alice);
        dist.claim();
        assertEq(alice.balance, 10 ether, "an active staker's share must survive");
        assertEq(dist.totalForfeited(), 0, "nothing may be forfeited out from under her");
    }

    /// The permissionless reclaim path is retired outright: it sat outside both
    /// the 48h timelock and the 1% lifetime forfeit cap, and the write that took
    /// the ETH (`epochClaimed[i] += dust`) is the same write that closes the
    /// `proposeClaimRecovery` channel which could have returned it.
    function test_autoReconcileDust_isDisabled() public {
        _fundAndDistribute(10 ether);
        vm.warp(block.timestamp + 180 days + 1);
        _fundAndDistribute(10 ether);

        vm.expectRevert(bytes4(keccak256("AutoReconcileDisabled()")));
        dist.autoReconcileDust();
    }

    /// The owner's timelocked + 1%-capped forfeit path remains the only route
    /// out for genuinely abandoned dust.
    function test_ownerForfeitPath_stillWorks() public {
        _fundAndDistribute(10 ether);
        vm.warp(block.timestamp + 180 days + 1);
        _fundAndDistribute(10 ether);

        // 1% of totalDistributed (20 ETH) = 0.2 ETH.
        dist.proposeForfeitReclaim(0.05 ether);
        vm.warp(block.timestamp + 48 hours + 1);
        dist.executeForfeitReclaim();
        assertEq(dist.totalForfeitedReclaimed(), 0.05 ether, "forfeit still counted against the 1% cap");
    }

    // ══════════════════════════════════════════════════════════════════
    //  (c) `reserved` double-counts totalPendingWithdrawals
    // ══════════════════════════════════════════════════════════════════

    /// PRE-FIX: a queued payee's ETH is already inside `(totalEarmarked -
    /// totalClaimed)`, so adding `totalPendingWithdrawals` on top reserves it
    /// twice and strands an equal amount of genuinely new revenue.
    function test_reserved_doesNotDoubleCountPendingWithdrawals() public {
        Rejecter_Sweeps r = new Rejecter_Sweeps();
        ve.setLock(address(r), 200_000 ether, block.timestamp + 3650 days);

        _fundAndDistribute(4 ether); // epoch 0 — r's half is 2 ETH
        vm.prank(address(r));
        dist.claim();
        assertEq(dist.pendingWithdrawals(address(r)), 2 ether, "push failed, queued");
        assertEq(dist.totalPendingWithdrawals(), 2 ether);
        assertEq(dist.totalClaimed(), 0, "queued ETH is NOT in totalClaimed");

        // 3 ETH of genuinely new revenue arrives.
        vm.warp(block.timestamp + 4 hours + 1);
        _fund(3 ether);
        dist.distribute();

        (uint256 e1,,) = dist.getEpoch(1);
        assertEq(e1, 3 ether, "all 3 ETH of new revenue must be distributable");
    }

    /// Guard for the other direction: dropping the double count must NOT let the
    /// sweep reach a queued payee's ETH.
    function test_sweepDust_leavesPendingWithdrawalsFullyFunded() public {
        Rejecter_Sweeps r = new Rejecter_Sweeps();
        ve.setLock(address(r), 200_000 ether, block.timestamp + 3650 days);

        _fundAndDistribute(4 ether); // r 2 ETH, alice 1 ETH, bob 1 ETH
        vm.prank(address(r));
        dist.claim();
        vm.prank(alice);
        dist.claim();
        vm.prank(bob);
        dist.claim();
        assertEq(dist.totalPendingWithdrawals(), 2 ether);
        assertEq(address(dist).balance, 2 ether);

        _fund(1 ether); // pure surplus

        assertTrue(_proposeDustSweep(), "proposeDustSweep() must exist");
        vm.warp(block.timestamp + 48 hours + 1);
        dist.sweepDust();

        assertEq(treasury.balance, 1 ether, "only the true surplus is swept");
        assertEq(address(dist).balance, 2 ether, "the queued payee's ETH stays funded");
        assertGe(address(dist).balance, dist.totalPendingWithdrawals(), "pending queue solvent");
    }

    receive() external payable {}
}
