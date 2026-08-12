// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

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

/// @title AUDIT R014 — RevenueDistributor remediation tests
/// @notice Covers H-5 (claim recovery for corrupted positions) and M-8 (auto dust
///         reconcile after grace period) as per the audit ticket.
contract AuditR014_RevenueDistributorTest is Test {
    using stdStorage for StdStorage;

    MockVE_R014 public ve;
    MockWETH_R014 public weth;
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
        dist = new RevenueDistributor(address(ve), treasury, address(weth));

        ve.setLock(alice, 100_000 ether, block.timestamp + 365 days);
        ve.setLock(bob,   100_000 ether, block.timestamp + 365 days);
        ve.setLock(carol,  50_000 ether, block.timestamp + 365 days);
    }

    function _distribute(uint256 amt) internal {
        vm.deal(address(this), address(this).balance + amt);
        (bool ok,) = address(dist).call{value: amt}("");
        assertTrue(ok);
        dist.distribute();
        // AUDIT FIX 2026-05-17 TEST: inflate `totalDistributed` to give the new
        // MAX_LIFETIME_RECOVERY_BPS (1% of totalDistributed) cap enough headroom
        // for tests that propose realistic per-epoch (~20-25%) recoveries.
        // Production protocol accumulates totalDistributed across many epochs over
        // time; tests skip that simulation for speed. Per fix M1 the cap is
        // structurally enforced — tests verify per-epoch / per-proposal cap
        // semantics in isolation.
        if (dist.totalDistributed() < 1000 ether) {
            stdstore.target(address(dist)).sig(dist.totalDistributed.selector).checked_write(uint256(1000 ether));
        }
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

    // TEST REALIGN 2026-08 [REV-AUTORECONCILE-01] (HIGH): the permissionless
    // `autoReconcileDust` path is RETIRED. It drained the full unclaimed remainder of
    // any epoch older than 180d regardless of ACTIVE locks (locks have no claim
    // deadline), and it sat entirely outside the 1% lifetime forfeit cap — it bumped
    // `totalForfeited` but never `totalForfeitedReclaimed`, which is the figure the cap
    // is measured against. It is also not repairable in place: the write that takes the
    // ETH (`epochClaimed[i] += dust`) is the same write that closes the only channel
    // that could return it (`proposeClaimRecovery` → `EpochAlreadyReconciled`).
    // The owner-only, 48h-timelocked, ≤10 ETH/call, 1%-lifetime-capped
    // `proposeForfeitReclaim` → `executeForfeitReclaim` path covers the same dust and
    // applies the same `epochClaimed[i]` bump; the tests below now pin THAT path.

    function test_autoReconcileDust_revertsWithinGracePeriod() public {
        // Need at least 2 epochs to have a destination distinct from source.
        _distribute(2 ether);
        vm.warp(block.timestamp + 4 hours + 1);
        _distribute(2 ether);
        // Retirement supersedes the grace gate — the path is closed unconditionally.
        vm.expectRevert(RevenueDistributor.AutoReconcileDisabled.selector);
        dist.autoReconcileDust();
    }

    /// An ACTIVE staker's share must survive an arbitrary caller. Pre-fix this
    /// permissionless call moved epoch 0's entire unclaimed remainder out of
    /// `totalEarmarked` and into the owner-sweepable surplus.
    function test_autoReconcileDust_cannotTouchAnyEpoch() public {
        _distribute(2 ether); // epoch 0
        vm.warp(block.timestamp + dist.AUTO_RECLAIM_ABANDONED_AGE() + 1);
        _distribute(2 ether); // epoch 1

        uint256 earBefore = dist.totalEarmarked();

        vm.prank(attacker);
        vm.expectRevert(RevenueDistributor.AutoReconcileDisabled.selector);
        dist.autoReconcileDust();

        // Nothing moved: no accounting write, no cursor advance.
        assertEq(dist.epochClaimed(0), 0, "epoch 0 untouched");
        assertEq(dist.totalEarmarked(), earBefore, "earmark untouched");
        assertEq(dist.totalForfeited(), 0, "nothing forfeited");
        assertEq(dist.protocolDustPool(), 0, "dust pool frozen at 0");
        assertEq(dist.lastReconciledEpoch(), 0, "cursor frozen");

        // Alice's 100_000/250_000 share of BOTH epochs is still claimable.
        vm.prank(alice);
        dist.claim();
        assertEq(alice.balance, 1.6 ether, "active staker keeps 0.8 + 0.8");
    }

    /// The replacement path: owner-only, 48h-timelocked, and counted against the 1%
    /// lifetime forfeit cap that `autoReconcileDust` bypassed entirely.
    function test_abandonedDust_reclaimableOnlyViaCappedTimelockedOwnerPath() public {
        _distribute(10 ether); // epoch 0
        vm.warp(block.timestamp + dist.AUTO_RECLAIM_ABANDONED_AGE() + 1);
        _distribute(10 ether); // epoch 1
        vm.warp(block.timestamp + dist.AUTO_RECLAIM_ABANDONED_AGE() + 1);
        _distribute(10 ether); // epoch 2 — fresh, still in grace, must stay untouched

        // Epochs 0 and 1 are both past the extended cutoff → 20 ETH of abandoned dust.
        assertEq(dist.reclaimEligibleAmount(), 20 ether, "epochs 0 + 1 eligible");

        // MAX_LIFETIME_FORFEIT_BPS (1%) caps LIFETIME owner reclaim well below the
        // eligible dust. `autoReconcileDust` was subject to NEITHER this cap nor the
        // timelock; the surviving path is subject to both.
        uint256 cap = (dist.totalDistributed() * dist.MAX_LIFETIME_FORFEIT_BPS()) / 10_000;
        assertLt(cap, 20 ether, "cap is strictly below the eligible dust");

        dist.proposeForfeitReclaim(10 ether); // per-call ceiling is 10 ETH
        // Specific selector, NOT a bare `vm.expectRevert()` — under `via_ir` a bare
        // expect can pass for the wrong reason once `vm.warp` is in play.
        vm.expectRevert(
            abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, dist.FORFEIT_RECLAIM())
        );
        dist.executeForfeitReclaim();

        // `vm.getBlockTimestamp()` — see the via_ir timestamp-folding note above.
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        dist.executeForfeitReclaim();
        assertEq(dist.epochClaimed(0), 10 ether, "epoch 0 consumed");

        // Take the rest of the lifetime allowance, then the cap must bind.
        dist.proposeForfeitReclaim(cap - 10 ether);
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        dist.executeForfeitReclaim();
        assertEq(dist.totalForfeitedReclaimed(), cap, "lifetime allowance fully consumed");

        // Epoch 1 still holds eligible dust, but — unlike the retired uncapped
        // `autoReconcileDust` — nobody can reach it.
        assertGe(dist.reclaimEligibleAmount(), 1 ether, "epoch 1 dust still eligible on paper");
        vm.expectRevert(RevenueDistributor.ForfeitExceedsLifetimeCap.selector);
        dist.proposeForfeitReclaim(1 wei);
    }

    function test_autoReconcileDust_revertsWhenNoEpochs() public {
        // Retirement supersedes the no-epoch gate — the path is closed unconditionally.
        vm.expectRevert(RevenueDistributor.AutoReconcileDisabled.selector);
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

        vm.warp(t0 + dist.AUTO_RECLAIM_ABANDONED_AGE() + 1); // FIX REALIGN: past 180d abandoned-age (permissionless reclaim threshold)
        _distribute(10 ether); // epoch 1 — destination

        // Admin proposes recovery for carol on the now-past-grace epoch 0.
        dist.proposeClaimRecovery(carol, 0, 50_000 ether);
        assertEq(dist.pendingRecoveryCount(0), 1, "counter bumped");

        // Attacker races autoReconcileDust DURING the 48h timelock — pre-fix this
        // would have set epochClaimed[0] = epoch[0].totalETH and bricked the
        // recovery.
        // DEEP-DR-M-03 made the cursor HALT at the first pending-recovery epoch.
        // TEST REALIGN 2026-08 [REV-AUTORECONCILE-01]: the whole permissionless path
        // is now retired, so the race is closed a fortiori — no caller, racing or
        // not, can touch epoch 0.
        vm.prank(attacker);
        vm.expectRevert(RevenueDistributor.AutoReconcileDisabled.selector);
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

        // After the recovery resolved, epoch 0's residual dust (8 ETH = 10 - 2) is NOT
        // orphaned — the owner's timelocked + 1%-capped forfeit path still reaches it.
        // (DEEP-DR-M-03's anti-orphan intent is preserved; only the actor changed.)
        dist.proposeForfeitReclaim(8 ether);
        // NOTE: `vm.getBlockTimestamp()`, not `block.timestamp` — under `via_ir` the
        // compiler folds repeated `block.timestamp` reads ACROSS `vm.warp`, so a
        // second `warp(block.timestamp + delta)` in the same test body silently
        // re-uses the pre-warp value and the timelock never matures.
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        dist.executeForfeitReclaim();
        assertEq(dist.epochClaimed(0), 10 ether, "residual dust reclaimed after recovery");
        assertEq(dist.totalForfeitedReclaimed(), 8 ether, "and it counts against the 1% cap");
    }

    function test_REV_H_02_proposeClaimRecovery_revertsOnReconciledEpoch() public {
        // Two epochs, grace+1 apart. Reconcile epoch 0 (no pending recoveries).
        // DEEP-DR-M-01: DUST_RECLAIM_GRACE was bumped from 7d → 14d.
        uint256 t0 = block.timestamp;
        _distribute(10 ether); // epoch 0
        vm.warp(t0 + dist.AUTO_RECLAIM_ABANDONED_AGE() + 1); // past the 180d abandoned age
        _distribute(10 ether); // epoch 1
        // TEST REALIGN 2026-08 [REV-AUTORECONCILE-01]: epoch 0 is drained through the
        // owner's timelocked + 1%-capped forfeit path instead of the retired
        // permissionless one. The funds-based recovery gate is what is under test here,
        // and it keys off `epochClaimed[epoch] >= epoch.totalETH` regardless of actor.
        dist.proposeForfeitReclaim(10 ether);
        // `vm.getBlockTimestamp()` — see the via_ir timestamp-folding note above.
        vm.warp(vm.getBlockTimestamp() + 48 hours + 1);
        dist.executeForfeitReclaim();
        assertEq(dist.epochClaimed(0), 10 ether, "epoch 0 fully reclaimed");

        // Now any new recovery proposal on the drained epoch must be rejected
        // fail-fast — the source pool is empty (funds-based gate).
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
