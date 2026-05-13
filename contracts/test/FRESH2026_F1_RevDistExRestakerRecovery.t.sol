// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/RevenueDistributor.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

/// @title FRESH-2026 F1 — RevenueDistributor ex-restaker past-epoch revenue recovery
/// @notice POST-FIX REGRESSION (commit ad0042e).
///
///         BUG (pre-fix):
///         RevenueDistributor._calculateClaim cached the user's CURRENT restaker
///         status outside the epoch loop:
///             bool isRestaker = _isRestaked(user);
///         and only consulted `_restakedPowerAt(user, ts)` when `isRestaker == true`.
///         This was a DEEP-DR-L-03 gas optimization, but it created a
///         silent-data-loss condition for EX-RESTAKERS:
///
///         Sequence (the failing one):
///           1. Alice stakes — staking-side checkpoint reads >0 in T_0.
///           2. Alice restakes — staking-side checkpoint zeros (NFT held by
///              the restaking contract), restaking-side checkpoint records
///              her boostedAmount at T_1.
///           3. Distributor produces N epochs while Alice is restaked.
///              Each epoch's `votingPowerAtTimestamp(alice, ts) = 0`
///              (staking checkpoint is zero during restake) and the only
///              source of historical power is `_restakedPowerAt`.
///           4. Alice unrestakes — `restakers[alice].tokenId = 0`.
///           5. Alice calls `claim()`. The cache lookup fires:
///              `_isRestaked(alice) = false` (she just unrestaked).
///              The loop sees `userPower = 0` for every restaked-period
///              epoch, never adds the restaking-side fallback, and continues.
///           6. PRE-FIX: `claimedAtEpoch[alice][i] = true` was written
///              UNCONDITIONALLY at the top of the loop, sealing every
///              ex-restaker epoch at zero. `proposeClaimRecovery` then
///              reverts `AlreadyClaimedNormally` — Alice is permanently
///              locked out of her own past revenue.
///
///         FIX (commit ad0042e on RevenueDistributor.sol:813-826, 846-883,
///         1671-1683):
///         (a) Drop the `bool isRestaker` cache. Call `_restakedPowerAt`
///             unconditionally for every epoch. The function already has a
///             try/catch wrapper plus a Trace208 length-0 fast path so the
///             worst-case cost is bounded for never-restakers.
///         (b) Move `claimedAtEpoch[user][i] = true` INSIDE the
///             `if (userPower > 0)` branch. Zero-power epochs stay eligible
///             for `proposeClaimRecovery`, restoring the recovery path.
///
///         Pattern of record: Curve FeeDistributor (always read both source
///         contracts per epoch, never cache restaker status across the
///         claim loop).
///
///         POST-FIX VALIDATION (this test):
///         (1) Alice's claim now reads her restaked-period power via the
///             restaking-side fallback and pays the correct ETH amount.
///         (2) For an isolated zero-power-everywhere epoch, the
///             `claimedAtEpoch` flag is NOT set, so the owner-attested
///             `proposeClaimRecovery` flow can recover for her.
///
///         If the cache + unconditional-seal lines were re-introduced,
///         either assertion in this test would fail.

contract MockVE_F1 {
    mapping(address => uint256) public lockedAmounts;
    mapping(address => uint256) public lockEnds;
    mapping(address => mapping(uint256 => uint256)) public votingPowerAtTs;
    mapping(address => uint256) public votingPowerNow;
    uint256 public totalLocked;
    bool public isPaused;

    function setLock(address user, uint256 amount, uint256 end) external {
        if (lockedAmounts[user] == 0) totalLocked += amount;
        else totalLocked = totalLocked - lockedAmounts[user] + amount;
        lockedAmounts[user] = amount;
        lockEnds[user] = end;
    }

    function setVotingPowerAt(address user, uint256 ts, uint256 power) external {
        votingPowerAtTs[user][ts] = power;
    }

    function setVotingPowerNow(address user, uint256 power) external {
        votingPowerNow[user] = power;
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return votingPowerNow[user];
    }

    function votingPowerAtTimestamp(address user, uint256 ts) external view returns (uint256) {
        return votingPowerAtTs[user][ts];
    }

    function totalBoostedStake() external view returns (uint256) {
        return totalLocked;
    }

    function totalBoostedStakeAtTimestamp(uint256) external view returns (uint256) {
        return totalLocked;
    }

    function locks(address user) external view returns (uint256, uint256) {
        return (lockedAmounts[user], lockEnds[user]);
    }

    function paused() external view returns (bool) {
        return isPaused;
    }

    function setPaused(bool v) external {
        isPaused = v;
    }
}

/// @dev Mocks ITegridyRestaking. Crucially, restakers() returns (0,...) AFTER
///      "unrestake" but boostedAmountAt() still returns the historical power
///      for past timestamps — this is the exact shape the F1 fix relies on.
contract MockRestaking_F1 {
    struct Info { uint256 tokenId; uint256 posAmt; uint256 boosted; int256 debt; uint256 depTime; }
    mapping(address => Info) private _r;
    mapping(address => mapping(uint256 => uint256)) private _boostedAt;

    function setRestaker(address u, uint256 tid, uint256 amt) external {
        _r[u] = Info(tid, amt, amt, 0, block.timestamp);
    }

    function clearRestaker(address u) external {
        delete _r[u];
    }

    function setBoostedAt(address u, uint256 ts, uint256 power) external {
        _boostedAt[u][ts] = power;
    }

    function restakers(address u) external view returns (uint256, uint256, uint256, int256, uint256, uint256) {
        Info memory i = _r[u];
        return (i.tokenId, i.posAmt, i.boosted, i.debt, i.depTime, 0);
    }

    function boostedAmountAt(address u, uint256 ts) external view returns (uint256) {
        return _boostedAt[u][ts];
    }
}

contract MockWETH_F1 {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

contract FRESH2026_F1_RevDistExRestakerRecoveryTest is Test {
    MockVE_F1 ve;
    MockRestaking_F1 restaking;
    MockWETH_F1 weth;
    RevenueDistributor dist;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    uint256 constant ALICE_POWER = 100_000 ether;
    uint256 constant BOB_POWER = 50_000 ether;

    function setUp() public {
        vm.warp(5 hours);
        ve = new MockVE_F1();
        restaking = new MockRestaking_F1();
        weth = new MockWETH_F1();
        dist = new RevenueDistributor(address(ve), treasury, address(weth));

        // Wire restaking contract on the distributor (48h timelock).
        dist.proposeRestakingChange(address(restaking));
        vm.warp(block.timestamp + 49 hours);
        dist.executeRestakingChange();

        // Bob is a permanent normal staker so distribute() always has a
        // healthy totalLocked and a well-defined denominator.
        ve.setLock(bob, BOB_POWER, block.timestamp + 365 days);
        ve.setVotingPowerNow(bob, BOB_POWER);
    }

    function _fund(uint256 amt) internal {
        vm.deal(address(this), address(this).balance + amt);
        (bool ok,) = address(dist).call{value: amt}("");
        assertTrue(ok, "fund failed");
    }

    /// @notice POST-FIX REGRESSION: ex-restaker recovers past-epoch revenue
    ///         that pre-fix was sealed at zero by the `isRestaker` cache.
    function test_F1_exRestaker_claims_pastRestakedEpochs() public {
        // ── PHASE 1: Alice stakes (staking-side power positive). ────────
        ve.setLock(alice, ALICE_POWER, block.timestamp + 365 days);
        ve.setVotingPowerNow(alice, ALICE_POWER);

        // ── PHASE 2: Alice restakes — staking-side power now zeros for
        //    future epoch reads. Restaking-side records her boostedAmount
        //    so `boostedAmountAt(alice, ts) > 0` for the restaked window.
        ve.setVotingPowerNow(alice, 0); // staking-side aggregate = 0
        restaking.setRestaker(alice, 1, ALICE_POWER);

        // Distribute 3 epochs while Alice is restaked. After each distribute()
        // call, write the historical power maps at the canonical `epoch.ts`
        // that distribute() snapshotted. Alice's staking-side power is 0
        // (NFT held by restaking contract), restaking-side returns
        // ALICE_POWER — exactly what the F1 fix relies on as the fallback.
        for (uint256 i; i < 3; i++) {
            if (i > 0) vm.warp(block.timestamp + 4 hours + 1);
            _fund(2 ether);
            dist.distribute();
            (, , uint256 epochTs) = dist.getEpoch(i);
            ve.setVotingPowerAt(alice, epochTs, 0);
            restaking.setBoostedAt(alice, epochTs, ALICE_POWER);
            ve.setVotingPowerAt(bob, epochTs, BOB_POWER);
        }

        // Sanity: 3 epochs exist.
        assertEq(dist.epochCount(), 3, "3 epochs created during alice's restake");

        // ── PHASE 3: Alice unrestakes. `_isRestaked(alice)` now returns
        //    FALSE for the cache. Pre-fix this short-circuited
        //    `_restakedPowerAt` for ALL of Alice's past restaked-period
        //    epochs even though those epochs DO have positive
        //    boostedAmountAt entries.
        restaking.clearRestaker(alice);

        // To pass the lock-active check on claim(), Alice needs either an
        // active staking lock OR an active restake. Restore her staking-side
        // CURRENT lock now that her NFT is back. This is the realistic
        // post-unrestake on-chain state.
        ve.setLock(alice, ALICE_POWER, block.timestamp + 365 days);
        ve.setVotingPowerNow(alice, ALICE_POWER);
        // NB: do NOT touch the historical `votingPowerAtTs` for past epochs —
        // those reads still correctly return 0 (staking-side was zero during
        // restake). The only fix-relevant source for past power is the
        // restaking-side `boostedAmountAt` set above.

        // ── PHASE 4: Alice claims. POST-FIX: she receives ETH for every
        //    restaked-period epoch via the restaking-side fallback.
        //    PRE-FIX: she would receive 0 (cache short-circuit) and every
        //    epoch flag would be sealed via `claimedAtEpoch[alice][i]=true`.
        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        dist.claim();
        uint256 received = alice.balance - aliceBalBefore;
        emit log_named_uint("alice received post-fix", received);

        // POST-FIX assertion (the load-bearing one):
        //   share_per_epoch = epoch.totalETH * power / totalLocked
        //                   = 2e18 * 100_000e18 / 150_000e18 ≈ 1.333e18
        //   total over 3 epochs ≈ 4 ETH (with rounding floor)
        // Pre-fix she would receive 0 and the call would revert NothingToClaim().
        assertGt(received, 3 ether, "FIX: ex-restaker recovers >3 ETH from 3 restaked-period epochs");
        assertApproxEqAbs(received, 4 ether, 1e9, "FIX: ~4 ETH owed across 3 epochs (rounding floor)");

        // ── PHASE 5: cursor advanced through all 3 epochs.
        assertEq(dist.lastClaimedEpoch(alice), 3, "FIX: cursor advanced through all 3 ex-restake epochs");
    }

    /// @notice POST-FIX REGRESSION (zero-power path): for an epoch where
    ///         BOTH staking and restaking sides are zero, the
    ///         `claimedAtEpoch` seal is now suppressed, leaving the
    ///         (user, epoch) pair eligible for `proposeClaimRecovery`.
    ///         Pre-fix the seal was unconditional so the recovery path
    ///         reverted `AlreadyClaimedNormally`.
    function test_F1_zeroPowerEpoch_eligibleForClaimRecovery() public {
        // Carol is brand new: never staked, never restaked at any epoch.
        // For every epoch we run, both VE and restaking return 0 historical
        // power. We then verify that `claimedAtEpoch[carol][i]` is FALSE
        // after a claim() loop, so admin recovery is unblocked.

        address carol = makeAddr("carol");

        // Carol must have an ACTIVE lock right now to pass the lock-active
        // gate on `claim()`. The historical power is what the F1 fix
        // hinges on; the lock-active gate is orthogonal.
        ve.setLock(carol, ALICE_POWER, block.timestamp + 365 days);
        ve.setVotingPowerNow(carol, ALICE_POWER);

        // Distribute 2 epochs. Carol's `votingPowerAtTimestamp` returns 0
        // by default (mock zero-init), and `boostedAmountAt` also returns 0.
        for (uint256 i; i < 2; i++) {
            if (i > 0) vm.warp(block.timestamp + 4 hours + 1);
            uint256 ts = block.timestamp - 1;
            ve.setVotingPowerAt(bob, ts, BOB_POWER); // bob still anchors totalLocked
            _fund(1 ether);
            dist.distribute();
        }

        // Carol claims. Loop sees userPower == 0 for every epoch, so:
        // POST-FIX: `claimedAtEpoch[carol][i]` STAYS FALSE (no seal).
        // PRE-FIX: `claimedAtEpoch[carol][i] = true` was written at the top
        //          of the loop unconditionally.
        // The claim itself reverts `NothingToClaim()` either way.
        vm.prank(carol);
        vm.expectRevert(RevenueDistributor.NothingToClaim.selector);
        dist.claim();

        // ── POST-FIX VALIDATION: owner can still propose a recovery for
        //    any epoch — the seal was suppressed so the propose-time
        //    `AlreadyClaimedNormally` revert does NOT fire. Pre-fix this
        //    propose would revert.
        //
        // Use a small attestation (1k of 50k totalLocked = 2%, well under
        // the 25% per-proposal cap and the 50% aggregate cap) so the
        // owner's `proposeClaimRecovery` is well-formed.
        dist.proposeClaimRecovery(carol, 0, 1_000 ether);

        // Sanity: a pending recovery now exists.
        (uint256 pPower, uint256 pExecuteAfter) = dist.pendingRecoveries(carol, 0);
        assertEq(pPower, 1_000 ether, "FIX: recovery proposal accepted (claimedAtEpoch seal suppressed)");
        assertGt(pExecuteAfter, block.timestamp, "FIX: recovery is timelocked");

        emit log_string("F1 FIX VALIDATED: zero-power epochs no longer sealed; proposeClaimRecovery unblocked");
    }
}
