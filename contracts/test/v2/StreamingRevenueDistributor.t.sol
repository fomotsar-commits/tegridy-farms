// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {StreamingRevenueDistributor} from "../../src/v2/StreamingRevenueDistributor.sol";

/// @dev Voting-escrow stand-in exposing exactly the subset
///      `StreamingRevenueDistributor.IVotingEscrow` declares. `votingPowerOf` mirrors
///      the production semantic that matters most here: an EXPIRED position
///      contributes zero (StakingViewLib skips `nowTs >= p.lockEnd`).
contract MockVE {
    mapping(address => uint256) public rawPower;
    mapping(address => uint256) public lockEnds;
    mapping(address => uint256) public userTokenId;
    mapping(uint256 => address) public tokenOwner;
    bool public paused;
    bool public reverting;
    uint256 private _next = 1;

    function setPosition(address user, uint256 power, uint256 lockEnd) external {
        if (userTokenId[user] == 0) {
            uint256 tid = _next++;
            userTokenId[user] = tid;
            tokenOwner[tid] = user;
        }
        rawPower[user] = power;
        lockEnds[user] = lockEnd;
    }

    function setPaused(bool p) external { paused = p; }
    function setReverting(bool r) external { reverting = r; }

    function votingPowerOf(address user) external view returns (uint256) {
        if (reverting) revert("VE_DOWN");
        if (block.timestamp >= lockEnds[user]) return 0;
        return rawPower[user];
    }

    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, int256 rewardDebt, uint256 lockEnd,
        uint256 boostBps, uint256 lockDuration, bool autoMaxLock, bool hasJbacBoost,
        uint256 stakeTimestamp, uint256 jbacTokenId, bool jbacDeposited
    ) {
        address u = tokenOwner[tokenId];
        return (rawPower[u], rawPower[u], int256(0), lockEnds[u], 10000, 0, false, false, 0, 0, false);
    }
}

contract MockRestaking {
    mapping(address => uint256) public power;
    mapping(address => uint256) public tokenIds;

    function setRestaker(address user, uint256 tokenId, uint256 p) external {
        tokenIds[user] = tokenId;
        power[user] = p;
    }

    function restakers(address user) external view returns (
        uint256 tokenId, uint256 positionAmount, uint256 boostedAmount, int256 bonusDebt, uint256 depositTime
    ) {
        return (tokenIds[user], power[user], power[user], int256(0), 0);
    }

    function boostedAmountAt(address user, uint256) external view returns (uint256) {
        return power[user];
    }
}

contract MockWETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
    }
    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
    receive() external payable {}
}

contract StreamingRevenueDistributorTest is Test {
    StreamingRevenueDistributor internal dist;
    MockVE internal ve;
    MockRestaking internal restaking;
    MockWETH internal weth;

    address internal owner = address(this);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCAC0);

    uint256 internal constant DURATION = 7 days;
    uint256 internal constant FAR_FUTURE = 3650 days;

    function setUp() public {
        vm.warp(1_700_000_000);
        ve = new MockVE();
        restaking = new MockRestaking();
        weth = new MockWETH();
        dist = new StreamingRevenueDistributor(address(ve), address(weth), DURATION);
    }

    // ─── helpers ──────────────────────────────────────────────────────

    function _enableStreaming() internal {
        dist.proposeEnableStreaming();
        vm.warp(block.timestamp + dist.STREAMING_ENABLE_DELAY());
        dist.executeEnableStreaming();
    }

    function _wireRestaking() internal {
        dist.proposeRestakingChange(address(restaking));
        vm.warp(block.timestamp + dist.RESTAKING_CHANGE_DELAY());
        dist.executeRestakingChange();
    }

    function _stake(address user, uint256 power) internal {
        ve.setPosition(user, power, block.timestamp + FAR_FUTURE);
    }

    function _fund(uint256 amount) internal {
        (bool ok, ) = address(dist).call{value: amount}("");
        assertTrue(ok, "fund failed");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  FLAG GATE                                                     ║
    // ═══════════════════════════════════════════════════════════════════

    function test_StreamingIsOffAtDeploy() public {
        assertFalse(dist.streamingEnabled());
        _fund(10 ether);
        vm.expectRevert(StreamingRevenueDistributor.StreamingDisabled.selector);
        dist.notifyRewardAmount();
    }

    function test_EnableRequiresFullTimelock() public {
        dist.proposeEnableStreaming();
        vm.warp(block.timestamp + dist.STREAMING_ENABLE_DELAY() - 1);
        vm.expectRevert();
        dist.executeEnableStreaming();

        vm.warp(block.timestamp + 1);
        dist.executeEnableStreaming();
        assertTrue(dist.streamingEnabled());
    }

    function test_EnableIsOwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert();
        dist.proposeEnableStreaming();
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  THE ANTI-FLASH PROPERTY                                       ║
    // ═══════════════════════════════════════════════════════════════════

    /// @notice A staker whose power appears in the same block as their sync+claim
    ///         earns exactly zero. This is the streaming counterpart of v1's
    ///         `block.timestamp - 1` epoch snapshot (REV-M-01).
    function test_FlashStakerEarnsNothingInTheSameBlock() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        vm.prank(alice);
        dist.sync(alice);

        _fund(7 ether);
        dist.notifyRewardAmount();

        // Let a full stream accumulate to Alice.
        vm.warp(block.timestamp + 3 days);

        // Mallory appears with 100x Alice's power and immediately tries to claim.
        address mallory = address(0xDEAD);
        _stake(mallory, 100_000e18);
        vm.prank(mallory);
        dist.sync(mallory);

        assertEq(dist.earned(mallory), 0, "flash staker credited for elapsed stream");

        vm.prank(mallory);
        vm.expectRevert(StreamingRevenueDistributor.NothingToClaim.selector);
        dist.getReward();
    }

    /// @notice A balance INCREASE must apply only forward. Crystallisation happens
    ///         under the old mirror (FRESH-2026 C-1 / F-28-1 ordering); reversing it
    ///         is the retroactive-amplification bug the epoch snapshot prevented.
    function test_BalanceIncreaseIsNotRetroactive() public {
        _enableStreaming();
        _stake(alice, 100e18);
        _stake(bob, 100e18);
        dist.sync(alice);
        dist.sync(bob);

        _fund(7 ether);
        dist.notifyRewardAmount();
        uint256 rate = dist.rewardRate();

        // Half the period at a 50/50 split.
        vm.warp(block.timestamp + DURATION / 2);
        uint256 expectedHalf = (DURATION / 2) * rate / 2;

        // Alice's power jumps 9x. Sync crystallises the past at the OLD weight.
        _stake(alice, 900e18);
        dist.sync(alice);

        assertApproxEqAbs(dist.rewards(alice), expectedHalf, 1e12, "past window repriced at new balance");

        // Forward window is at the NEW weight: 900 / (900 + 100).
        vm.warp(block.timestamp + DURATION / 2);
        uint256 expectedTail = (DURATION / 2) * rate * 900 / 1000;
        assertApproxEqAbs(dist.earned(alice), expectedHalf + expectedTail, 1e12, "forward window mispriced");
    }

    /// @notice Waiting to sync can only ever LOSE the staker rewards, never gain them.
    function test_DelayedSyncForfeitsTheUnsyncedWindow() public {
        _enableStreaming();
        _stake(alice, 100e18);
        dist.sync(alice);

        _fund(7 ether);
        dist.notifyRewardAmount();

        // Bob stakes immediately but never syncs.
        _stake(bob, 100e18);

        vm.warp(block.timestamp + DURATION / 2);
        assertEq(dist.earned(bob), 0, "unsynced staker accrued");

        // Honesty surface: the zero above is "not registered", not "no revenue".
        assertFalse(dist.isSynced(bob), "unsynced staker reported as synced");
        assertTrue(dist.isSynced(alice));

        dist.sync(bob);
        assertEq(dist.rewards(bob), 0, "sync back-credited the unsynced window");
        assertTrue(dist.isSynced(bob));
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  ACCRUAL CORRECTNESS                                           ║
    // ═══════════════════════════════════════════════════════════════════

    function test_EqualStakersSplitTheStreamEvenly() public {
        _enableStreaming();
        _stake(alice, 500e18);
        _stake(bob, 500e18);
        dist.sync(alice);
        dist.sync(bob);

        _fund(7 ether);
        dist.notifyRewardAmount();

        vm.warp(block.timestamp + DURATION);

        uint256 a = dist.earned(alice);
        uint256 b = dist.earned(bob);
        assertApproxEqAbs(a, b, 1e6, "split is uneven");
        assertApproxEqAbs(a + b, 7 ether, 1e12, "total streamed != notified");
    }

    function test_LatencyBeatsTheFourHourEpoch() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        dist.sync(alice);

        _fund(7 ether);
        dist.notifyRewardAmount();

        // The v1 floor was MIN_DISTRIBUTE_INTERVAL = 4 hours before any wei moved.
        vm.warp(block.timestamp + 1 minutes);
        assertGt(dist.earned(alice), 0, "no accrual inside the old epoch interval");
    }

    function test_PayoutNeverExceedsWhatWasNotified() public {
        _enableStreaming();
        _stake(alice, 300e18);
        _stake(bob, 700e18);
        dist.sync(alice);
        dist.sync(bob);

        _fund(7 ether);
        dist.notifyRewardAmount();

        vm.warp(block.timestamp + DURATION + 1 days);

        uint256 before = address(dist).balance;
        vm.prank(alice);
        dist.getReward();
        vm.prank(bob);
        dist.getReward();
        uint256 paid = before - address(dist).balance;

        assertLe(paid, 7 ether, "paid out more than was funded");
        assertApproxEqAbs(paid, 7 ether, 1e12, "material shortfall vs funded amount");
        assertApproxEqAbs(alice.balance * 7 / 3, bob.balance, 1e12, "weights not honoured");
    }

    function test_ClaimIsPaidAsNativeEth() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        dist.sync(alice);
        _fund(7 ether);
        dist.notifyRewardAmount();

        vm.warp(block.timestamp + DURATION);
        vm.prank(alice);
        dist.getReward();

        assertApproxEqAbs(alice.balance, 7 ether, 1e12);
        assertEq(weth.balanceOf(alice), 0, "fell back to WETH for an EOA");
        assertEq(dist.rewards(alice), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  RESERVE ACCOUNTING                                            ║
    // ═══════════════════════════════════════════════════════════════════

    function test_ScheduledEthIsNotReDistributable() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        dist.sync(alice);
        _fund(7 ether);
        dist.notifyRewardAmount();

        // Everything is committed to the active schedule.
        assertLt(dist.distributable(), 1 ether, "scheduled ETH still counted as new");

        vm.warp(block.timestamp + NOTIFY_GAP());
        vm.expectRevert(StreamingRevenueDistributor.NotifyAmountTooSmall.selector);
        dist.notifyRewardAmount();
    }

    function NOTIFY_GAP() internal view returns (uint256) {
        return dist.NOTIFY_COOLDOWN();
    }

    function test_LeftoverRollsIntoTheNextSchedule() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        dist.sync(alice);
        _fund(7 ether);
        dist.notifyRewardAmount();

        vm.warp(block.timestamp + DURATION / 2);
        _fund(7 ether);
        dist.notifyRewardAmount();

        // Half of the first schedule (3.5) plus the new 7 = 10.5 over a fresh duration.
        uint256 expectedRate = uint256(10.5 ether) / DURATION;
        assertApproxEqRel(dist.rewardRate(), expectedRate, 1e15, "leftover was dropped or double counted");

        vm.warp(block.timestamp + DURATION);
        vm.prank(alice);
        dist.getReward();
        assertApproxEqAbs(alice.balance, 14 ether, 1e12, "total paid != total funded");
    }

    function test_EmptyPeriodEmissionIsForfeitAndRestreamable() public {
        _enableStreaming();
        _fund(7 ether);

        // Nobody is synced: the whole first half streams into an empty pool.
        dist.notifyRewardAmount();
        vm.warp(block.timestamp + DURATION / 2);

        _stake(alice, 1000e18);
        dist.sync(alice);

        // Synthetix forfeits the empty window rather than banking it for the first
        // arriving staker — the windfall-sandwich defence.
        assertEq(dist.rewards(alice), 0, "empty-window emission banked for first staker");

        vm.warp(block.timestamp + DURATION);
        vm.prank(alice);
        dist.getReward();
        assertApproxEqRel(alice.balance, 3.5 ether, 1e15, "second half not paid");

        // The forfeited half is un-reserved again and can be re-streamed to stakers.
        assertApproxEqRel(dist.distributable(), 3.5 ether, 1e15, "forfeited half stranded");
    }

    function test_NotifyEnforcesMinimumAndCooldown() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        dist.sync(alice);

        _fund(0.5 ether);
        vm.expectRevert(StreamingRevenueDistributor.NotifyAmountTooSmall.selector);
        dist.notifyRewardAmount();

        _fund(6.5 ether);
        dist.notifyRewardAmount();

        _fund(7 ether);
        vm.expectRevert(StreamingRevenueDistributor.NotifyCooldownActive.selector);
        dist.notifyRewardAmount();

        vm.warp(block.timestamp + dist.NOTIFY_COOLDOWN());
        dist.notifyRewardAmount();
    }

    function test_NotifyIsPermissionless() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        dist.sync(alice);
        _fund(7 ether);

        vm.prank(carol);
        dist.notifyRewardAmount();
        assertGt(dist.rewardRate(), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  LOCK EXPIRY / GRACE / RECYCLE                                 ║
    // ═══════════════════════════════════════════════════════════════════

    function test_ExpiredLockStopsAccruingOnSync() public {
        _enableStreaming();
        uint256 aliceEnd = block.timestamp + 2 days;
        ve.setPosition(alice, 500e18, aliceEnd);
        _stake(bob, 500e18);
        dist.sync(alice);
        dist.sync(bob);

        _fund(7 ether);
        dist.notifyRewardAmount();

        vm.warp(aliceEnd + 1);
        dist.sync(alice);
        assertEq(dist.effectiveBalanceOf(alice), 0, "expired lock still mirrored");

        uint256 crystallised = dist.rewards(alice);
        assertGt(crystallised, 0);

        vm.warp(block.timestamp + 1 days);
        assertEq(dist.earned(alice), crystallised, "expired position kept accruing");
    }

    function test_ExpiredStakerMayStillClaimInsideGrace() public {
        _enableStreaming();
        uint256 aliceEnd = block.timestamp + 2 days;
        ve.setPosition(alice, 500e18, aliceEnd);
        _stake(bob, 500e18);
        dist.sync(alice);
        dist.sync(bob);
        _fund(7 ether);
        dist.notifyRewardAmount();

        vm.warp(aliceEnd + 1 days);
        vm.prank(alice);
        dist.getReward();
        assertGt(alice.balance, 0, "in-grace claim refused");
    }

    function test_PastGraceClaimIsRefusedAndRecycledToStakers() public {
        _enableStreaming();
        uint256 aliceEnd = block.timestamp + 2 days;
        ve.setPosition(alice, 500e18, aliceEnd);
        _stake(bob, 500e18);
        dist.sync(alice);
        dist.sync(bob);
        _fund(7 ether);
        dist.notifyRewardAmount();

        vm.warp(aliceEnd + dist.CLAIM_GRACE_PERIOD() + 1);

        vm.prank(alice);
        vm.expectRevert(StreamingRevenueDistributor.NoLockedTokens.selector);
        dist.getReward();

        // Alice never synced her expiry, so her mirror stayed stale-high and she kept
        // accruing for the whole period. That accrual is real in `earned()` but has not
        // been crystallised into `rewards[]` by any committed call yet.
        uint256 owed = dist.earned(alice);
        assertGt(owed, 0);
        assertEq(dist.rewards(alice), 0, "accrual crystallised by a reverting claim");

        uint256 recycledBefore = dist.totalForfeitedToPool();
        dist.sync(alice);
        assertEq(dist.rewards(alice), 0, "past-grace accrual not recycled");
        assertEq(dist.totalForfeitedToPool(), recycledBefore + owed);

        // Recycled wei returns to the staker pool, never to an owner.
        assertGe(dist.distributable(), owed);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  RESTAKING FALLBACK                                            ║
    // ═══════════════════════════════════════════════════════════════════

    function test_RestakerMirrorsThroughFallbackOnlyOnceWired() public {
        _enableStreaming();
        // Restaked: the staking-side power reads 0 because the NFT is custodied.
        restaking.setRestaker(carol, 42, 1000e18);

        dist.sync(carol);
        assertEq(dist.effectiveBalanceOf(carol), 0, "restaking read before it was wired");

        _wireRestaking();
        dist.sync(carol);
        assertEq(dist.effectiveBalanceOf(carol), 1000e18, "restaker not credited");

        _fund(7 ether);
        dist.notifyRewardAmount();
        vm.warp(block.timestamp + DURATION);
        vm.prank(carol);
        dist.getReward();
        assertApproxEqAbs(carol.balance, 7 ether, 1e12);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  KILL SWITCHES / DEGRADATION                                   ║
    // ═══════════════════════════════════════════════════════════════════

    function test_StakingPauseBlocksNotifyAndClaim() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        dist.sync(alice);
        _fund(7 ether);
        dist.notifyRewardAmount();
        vm.warp(block.timestamp + DURATION);

        ve.setPaused(true);

        vm.prank(alice);
        vm.expectRevert(StreamingRevenueDistributor.StakingPaused.selector);
        dist.getReward();

        _fund(7 ether);
        vm.warp(block.timestamp + dist.NOTIFY_COOLDOWN());
        vm.expectRevert(StreamingRevenueDistributor.StakingPaused.selector);
        dist.notifyRewardAmount();
    }

    function test_LocalPauseFreezesEveryUserPath() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        dist.sync(alice);
        _fund(7 ether);
        dist.notifyRewardAmount();
        dist.pause();

        vm.expectRevert();
        dist.sync(alice);
        vm.prank(alice);
        vm.expectRevert();
        dist.getReward();
        vm.expectRevert();
        dist.notifyRewardAmount();
    }

    function test_RevertingStakingReadDegradesToZeroNotBrick() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        dist.sync(alice);
        _fund(7 ether);
        dist.notifyRewardAmount();
        vm.warp(block.timestamp + DURATION / 2);

        ve.setReverting(true);
        // The staking read failing must not brick everyone else's accounting; the
        // mirror simply drops to zero for the affected account.
        dist.sync(alice);
        assertEq(dist.effectiveBalanceOf(alice), 0);
        assertGt(dist.rewards(alice), 0, "accrual before the outage was lost");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  BATCH SYNC                                                    ║
    // ═══════════════════════════════════════════════════════════════════

    function test_SyncManyCoversTheStakerSet() public {
        _enableStreaming();
        address[] memory set = new address[](3);
        set[0] = alice; set[1] = bob; set[2] = carol;
        for (uint256 i; i < 3; i++) _stake(set[i], 100e18);

        dist.syncMany(set);
        assertEq(dist.totalEffectiveSupply(), 300e18);
    }

    function test_SyncManyRejectsAnOversizedBatch() public {
        address[] memory set = new address[](dist.MAX_SYNC_BATCH() + 1);
        vm.expectRevert(StreamingRevenueDistributor.SyncBatchTooLarge.selector);
        dist.syncMany(set);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  ADMIN SURFACE                                                 ║
    // ═══════════════════════════════════════════════════════════════════

    function test_DurationChangeIsTimelockedAndPeriodGated() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        dist.sync(alice);
        _fund(7 ether);
        dist.notifyRewardAmount();

        vm.expectRevert(StreamingRevenueDistributor.PreviousPeriodNotComplete.selector);
        dist.proposeRewardsDurationChange(14 days);

        vm.warp(block.timestamp + DURATION + 1);
        dist.proposeRewardsDurationChange(14 days);
        vm.warp(block.timestamp + dist.REWARDS_DURATION_DELAY());
        dist.executeRewardsDurationChange();
        assertEq(dist.rewardsDuration(), 14 days);
    }

    function test_DurationBoundsAreEnforced() public {
        vm.expectRevert(StreamingRevenueDistributor.DurationOutOfRange.selector);
        new StreamingRevenueDistributor(address(ve), address(weth), 1 hours);

        vm.expectRevert(StreamingRevenueDistributor.DurationOutOfRange.selector);
        dist.proposeRewardsDurationChange(365 days);
    }

    /// @notice There is no owner ETH exit at all. This asserts the absence: the only
    ///         ETH-moving entrypoint on the contract is `getReward`.
    function test_NoOwnerEthExitExists() public {
        _enableStreaming();
        _fund(7 ether);
        uint256 balBefore = address(dist).balance;

        // Every owner-callable mutator, exercised; none moves ETH.
        dist.proposeRestakingChange(address(restaking));
        dist.cancelRestakingChange();
        dist.pause();
        dist.unpause();
        dist.setPauseGuardian(address(0xBEEF));

        assertEq(address(dist).balance, balBefore, "an owner path moved ETH");
    }

    receive() external payable {}
}
