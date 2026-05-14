// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";

/// @dev Mock voting escrow for AUDIT R014 tests. Mirrors the IVotingEscrow surface
///      consumed by RevenueDistributor with deterministic getters.
contract MockVE_R014 {
    mapping(address => uint256) public power;
    mapping(address => uint256) public lockEnds;
    mapping(address => uint256) public userTokenId;
    mapping(uint256 => address) public tokenOwner;
    uint256 public total;
    uint256 private _next = 1;

    function setLock(address user, uint256 amt, uint256 end) external {
        if (userTokenId[user] == 0) {
            uint256 tid = _next++;
            userTokenId[user] = tid;
            tokenOwner[tid] = user;
        }
        if (power[user] == 0) total += amt;
        else total = total - power[user] + amt;
        power[user] = amt;
        lockEnds[user] = end;
    }

    /// @dev Simulate a "corrupted" position — all fallbacks return 0 so claim()
    ///      hits the NoLockedTokens revert. This models a single-NFT user whose
    ///      NFT was transferred out of the staking contract.
    function corrupt(address user) external {
        total -= power[user];
        power[user] = 0;
        // Keep userTokenId pointing at a tokenId, but make positions() return zeros
        // so the multi-fallback in _getUserLockState misses everywhere.
        uint256 tid = userTokenId[user];
        tokenOwner[tid] = address(0);
    }

    function votingPowerOf(address user) external view returns (uint256) { return power[user]; }
    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) { return power[user]; }
    function totalLocked() external view returns (uint256) { return total; }
    function totalBoostedStake() external view returns (uint256) { return total; }
    function paused() external pure returns (bool) { return false; }

    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint256 lockEnd,
        uint256 boostBps, uint256 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        uint256 stakeTimestamp, uint256 jbacTokenId, bool jbacDeposited
    ) {
        address u = tokenOwner[tokenId];
        return (power[u], power[u], int256(0), lockEnds[u], 10000, 0, false, false, 0, 0, false);
    }
}

contract MockWETH_R014 {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v; balanceOf[to] += v; return true;
    }
    receive() external payable {}
}

/// @dev AUDIT FIX 2026-05-13 — H-REV-3 — minimal restaking mock for the new
///      immutable `_restaking` constructor arg. No test in this file exercises
///      the restaker fallback; mock returns zero for every view.
contract MockRestaking_R014 {
    function restakers(address) external pure returns (
        uint256, uint256, uint256, int256, uint256
    ) { return (0, 0, 0, int256(0), 0); }
    function boostedAmountAt(address, uint256) external pure returns (uint256) { return 0; }
}

/// @title AUDIT R014 — RevenueDistributor remediation tests
/// @notice Covers H-5 (claim recovery for corrupted positions) and M-8 (auto dust
///         reconcile after grace period) as per the audit ticket.
contract AuditR014_RevenueDistributorTest is Test {
    MockVE_R014 public ve;
    MockWETH_R014 public weth;
    MockRestaking_R014 public restaking;
    RevenueDistributor public dist;

    address public alice = makeAddr("alice");
    address public bob   = makeAddr("bob");
    address public carol = makeAddr("carol"); // recovery target
    address public attacker = makeAddr("attacker");
    address public treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(4 hours + 1);
        ve = new MockVE_R014();
        weth = new MockWETH_R014();
        restaking = new MockRestaking_R014();
        dist = new RevenueDistributor(address(ve), treasury, address(weth), address(restaking));

        ve.setLock(alice, 100_000 ether, block.timestamp + 365 days);
        ve.setLock(bob,   100_000 ether, block.timestamp + 365 days);
        ve.setLock(carol,  50_000 ether, block.timestamp + 365 days);
    }

    function _distribute(uint256 amt) internal {
        vm.deal(address(this), address(this).balance + amt);
        (bool ok,) = address(dist).call{value: amt}("");
        assertTrue(ok);
        dist.distribute();
    }

    // ─── H-5 — Claim Recovery ─────────────────────────────────────────

    function test_proposeClaimRecovery_isOwnerOnly() public {
        _distribute(2 ether);
        vm.prank(attacker);
        vm.expectRevert(); // OwnableNoRenounce reverts; we don't pin the selector
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);
    }

    function test_proposeClaimRecovery_revertsWhenPowerExceedsTotalLocked() public {
        _distribute(2 ether);
        // Epoch 0 totalLocked = 250_000 ether (alice + bob + carol). Attest 250_001 — must revert.
        vm.expectRevert(RevenueDistributor.PowerExceedsTotalLocked.selector);
        dist.proposeClaimRecovery(carol, 0, 250_001 ether);
    }

    function test_proposeClaimRecovery_revertsOnInvalidEpoch() public {
        _distribute(2 ether);
        vm.expectRevert(RevenueDistributor.InvalidEpoch.selector);
        dist.proposeClaimRecovery(carol, 1, 50_000 ether);
    }

    function test_executeClaimRecovery_paysCorrectShare() public {
        _distribute(10 ether);

        // Snapshot epoch denominator: 250_000 ether. Carol's share: 50_000/250_000 * 10 = 2 ether.
        // Now corrupt carol so the normal claim() path would revert.
        ve.corrupt(carol);

        // Sanity: the normal path would now revert for carol.
        vm.prank(carol);
        vm.expectRevert(RevenueDistributor.NoLockedTokens.selector);
        dist.claim();

        // Owner attests carol's historical power.
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);

        // Cannot execute before timelock matures.
        vm.expectRevert();
        dist.executeClaimRecovery(carol, 0);

        // Warp past the 48h timelock.
        vm.warp(block.timestamp + 48 hours + 1);

        uint256 carolBefore = carol.balance;
        dist.executeClaimRecovery(carol, 0);
        assertEq(carol.balance - carolBefore, 2 ether, "carol should receive 2 ETH");

        // epochClaimed[0] reflects the recovery payout.
        assertEq(dist.epochClaimed(0), 2 ether, "epochClaimed[0] tracks recovery");

        // Idempotency: re-execute reverts (proposal cleared).
        vm.expectRevert(RevenueDistributor.NoPendingRecovery.selector);
        dist.executeClaimRecovery(carol, 0);

        // Re-proposing the SAME (user, epoch) reverts because already paid out.
        vm.expectRevert(RevenueDistributor.AlreadyClaimed.selector);
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);
    }

    function test_cancelClaimRecovery_clearsProposal() public {
        _distribute(5 ether);
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);
        dist.cancelClaimRecovery(carol, 0);
        // After cancel, executing reverts.
        vm.warp(block.timestamp + 48 hours + 1);
        vm.expectRevert(RevenueDistributor.NoPendingRecovery.selector);
        dist.executeClaimRecovery(carol, 0);
    }

    // ─── M-8 — Auto Dust Reconcile ─────────────────────────────────────

    function test_autoReconcileDust_revertsWithinGracePeriod() public {
        // Need at least 2 epochs to have a destination distinct from source.
        _distribute(2 ether);
        vm.warp(block.timestamp + 4 hours + 1);
        _distribute(2 ether);
        vm.expectRevert(RevenueDistributor.GracePeriodActive.selector);
        dist.autoReconcileDust();
    }

    function test_autoReconcileDust_routesDustForwardAfterGrace() public {
        // FRESH-2026 TEST REALIGN: F-12-K-3 — dust no longer flows into the
        // destination epoch's `totalETH`; it now lands in `protocolDustPool` and
        // becomes sweepable via the 48h-timelocked owner sweep path. The fairness
        // fix prevents racing-claimer advantages on the latest epoch.
        // Distribute 2 ETH at t=t0, wait > DUST_RECLAIM_GRACE, distribute another 2 ETH.
        // DEEP-DR-M-01: DUST_RECLAIM_GRACE was bumped from 7d to 14d.
        _distribute(2 ether); // epoch 0: 2 ETH
        vm.warp(block.timestamp + dist.DUST_RECLAIM_GRACE() + 1);
        _distribute(2 ether); // epoch 1: 2 ETH (destination)

        // Snapshot the destination epoch's totalETH BEFORE reconcile.
        (uint256 destETHBefore, , ) = dist.getEpoch(1);
        assertEq(destETHBefore, 2 ether);
        uint256 dustPoolBefore = dist.protocolDustPool();

        // No claims happened on epoch 0 → entire 2 ETH is "dust" (above MIN_DUST_RECONCILE = 0.01).
        (uint256 reclaimed, uint256 processed) = dist.autoReconcileDust();
        assertEq(reclaimed, 2 ether, "all of epoch 0 reclaimed");
        assertEq(processed, 1, "one epoch processed");

        // Destination epoch totalETH unchanged (dust no longer routed forward).
        (uint256 destETHAfter, , ) = dist.getEpoch(1);
        assertEq(destETHAfter, destETHBefore, "dest epoch totalETH unchanged");
        // Dust accumulates into the protocol dust pool instead.
        assertEq(dist.protocolDustPool(), dustPoolBefore + 2 ether, "dust routed to protocolDustPool");

        // epochClaimed[0] now equals epoch 0's totalETH → no further claims possible there.
        assertEq(dist.epochClaimed(0), 2 ether);

        // Cursor advanced.
        assertEq(dist.lastReconciledEpoch(), 1);
    }

    function test_autoReconcileDust_isBoundedTo10Epochs() public {
        // Push 12 epochs with 4h+1 spacing (use a local cursor to avoid trace ambiguity).
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 12; i++) {
            _distribute(2 ether);
            t += 4 hours + 1;
            vm.warp(t);
        }
        // Need a 13th epoch as the destination (cannot reconcile the latest into itself).
        // Wait long enough that all earlier epochs are past their grace window AND
        // that MIN_DISTRIBUTE_INTERVAL has elapsed since the most recent distribute.
        // DEEP-DR-M-01: DUST_RECLAIM_GRACE was bumped from 7d → 14d.
        t += dist.DUST_RECLAIM_GRACE() + 1;
        vm.warp(t);
        _distribute(2 ether); // epoch 12 destination

        // First call processes at most MAX_AUTO_RECONCILE_EPOCHS = 10 epochs.
        (uint256 reclaimed1, uint256 processed1) = dist.autoReconcileDust();
        assertEq(processed1, 10, "first call bounded to 10 epochs");
        assertEq(reclaimed1, 20 ether, "first call reclaims 10 epochs * 2 ETH");
        assertEq(dist.lastReconciledEpoch(), 10);

        // Second call processes the remaining eligible epochs (10 and 11).
        (uint256 reclaimed2, uint256 processed2) = dist.autoReconcileDust();
        assertEq(processed2, 2, "second call processes remaining 2");
        assertEq(reclaimed2, 4 ether);
        assertEq(dist.lastReconciledEpoch(), 12);

        // Third call: no more source epochs (cursor == destEpoch).
        vm.expectRevert(RevenueDistributor.NoEpochToReconcile.selector);
        dist.autoReconcileDust();
    }

    function test_autoReconcileDust_revertsWhenNoEpochs() public {
        vm.expectRevert(RevenueDistributor.NoEpochToReconcile.selector);
        dist.autoReconcileDust();
    }

    // ─── REV-H-02 — autoReconcileDust must NOT brick pending recoveries ─────
    //
    // ATTACK MODEL: H-5 claim-recovery is keyed on epochClaimed[epoch]. Once
    // autoReconcileDust sets epochClaimed[src] = epoch.totalETH, the recovery's
    // share = 0 → executeClaimRecovery reverts NothingToClaim() forever. The
    // race: admin proposes recovery → during the 48h delay, an attacker calls
    // autoReconcileDust on a now-past-grace epoch → recovery permanently bricked.
    function test_REV_H_02_autoReconcileDust_skipsEpochsWithPendingRecovery() public {
        // Two epochs with grace+1 spacing so epoch 0 is past DUST_RECLAIM_GRACE
        // and epoch 1 is the destination.
        // DEEP-DR-M-01: DUST_RECLAIM_GRACE was bumped from 7d → 14d.
        uint256 t0 = block.timestamp;
        _distribute(10 ether); // epoch 0 — 10 ETH

        // Corrupt carol BEFORE the second distribute so the normal claim path is
        // dead and only recovery can rescue her.
        ve.corrupt(carol);

        vm.warp(t0 + dist.DUST_RECLAIM_GRACE() + 1);
        _distribute(10 ether); // epoch 1 — destination

        // Admin proposes recovery for carol on the now-past-grace epoch 0.
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);
        assertEq(dist.pendingRecoveryCount(0), 1, "counter bumped");

        // Attacker races autoReconcileDust DURING the 48h timelock — pre-fix this
        // would have set epochClaimed[0] = epoch[0].totalETH and bricked the
        // recovery.
        // DEEP-DR-M-03: cursor now HALTS at the first pending-recovery epoch
        // (instead of skipping past it). When the only eligible epoch has a
        // pending recovery, the call reverts NoEpochToReconcile().
        vm.prank(attacker);
        vm.expectRevert(RevenueDistributor.NoEpochToReconcile.selector);
        dist.autoReconcileDust();
        // Cursor MUST NOT have advanced.
        assertEq(dist.lastReconciledEpoch(), 0, "cursor unchanged");
        assertEq(dist.epochClaimed(0), 0, "epoch 0 untouched");

        // Warp past the recovery timelock and execute. Carol gets her share —
        // proving the recovery was NOT bricked by the racing reconcile call.
        vm.warp(block.timestamp + 48 hours + 1);
        uint256 carolBefore = carol.balance;
        dist.executeClaimRecovery(carol, 0);
        // 50_000 / 250_000 * 10 ETH = 2 ETH.
        assertEq(carol.balance - carolBefore, 2 ether, "carol receives 2 ETH");
        assertEq(dist.pendingRecoveryCount(0), 0, "counter decremented on execute");

        // After recovery resolved, autoReconcileDust can now process epoch 0's
        // residual dust (8 ETH = 10 - 2) — DEEP-DR-M-03 prevents the orphan.
        (uint256 reclaimed2, uint256 processed2) = dist.autoReconcileDust();
        assertEq(reclaimed2, 8 ether, "residual dust reclaimed after recovery");
        assertEq(processed2, 1);
        assertEq(dist.lastReconciledEpoch(), 1);
    }

    function test_REV_H_02_proposeClaimRecovery_revertsOnReconciledEpoch() public {
        // Two epochs, grace+1 apart. Reconcile epoch 0 (no pending recoveries).
        // DEEP-DR-M-01: DUST_RECLAIM_GRACE was bumped from 7d → 14d.
        uint256 t0 = block.timestamp;
        _distribute(10 ether); // epoch 0
        vm.warp(t0 + dist.DUST_RECLAIM_GRACE() + 1);
        _distribute(10 ether); // epoch 1
        dist.autoReconcileDust();
        assertEq(dist.lastReconciledEpoch(), 1, "epoch 0 was reconciled");

        // Now any new recovery proposal on the reconciled epoch must be
        // rejected fail-fast — the source pool is empty.
        vm.expectRevert(RevenueDistributor.EpochAlreadyReconciled.selector);
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);
    }

    function test_REV_H_02_cancelClaimRecovery_decrementsCounter() public {
        _distribute(10 ether);
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);
        assertEq(dist.pendingRecoveryCount(0), 1, "counter bumped");
        dist.cancelClaimRecovery(carol, 0);
        assertEq(dist.pendingRecoveryCount(0), 0, "counter decremented on cancel");
    }

    function test_REV_H_02_proposeClaimRecovery_doesNotDoubleCount() public {
        _distribute(10 ether);
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);
        assertEq(dist.pendingRecoveryCount(0), 1, "first propose bumps");
        // Re-propose for SAME (user, epoch) — should overwrite without
        // double-counting.
        dist.proposeClaimRecovery(carol, 0, 40_000 ether);
        assertEq(dist.pendingRecoveryCount(0), 1, "re-propose does not double-count");
    }
}
