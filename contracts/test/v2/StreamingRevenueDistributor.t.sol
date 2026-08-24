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
    /// @dev PRIVATE, with an explicit getter below. As a `public` mapping the
    ///      compiler-generated getter is a bare SLOAD that can never revert, which made
    ///      the OUTER catch arm of `_lockEndOf` unreachable from any test in this file.
    mapping(address => uint256) private _userTokenId;
    mapping(uint256 => address) public tokenOwner;
    bool public paused;
    bool public reverting;
    /// @dev Three independent outage toggles, not one. `reverting` keeps its exact
    ///      original meaning (`votingPowerOf` only) so the pre-existing degradation test
    ///      stays honest, and the two new ones address SEPARATE `return` sites: a fix
    ///      that teaches the outer catch to signal "unknown" and forgets the inner one
    ///      passes a single-flag test and still forfeits stakers.
    bool public tokenIdReverting;
    bool public positionsReverting;
    uint256 private _next = 1;

    function setPosition(address user, uint256 power, uint256 lockEnd) external {
        if (_userTokenId[user] == 0) {
            uint256 tid = _next++;
            _userTokenId[user] = tid;
            tokenOwner[tid] = user;
        }
        rawPower[user] = power;
        lockEnds[user] = lockEnd;
    }

    /// @dev Mirrors the production exit exactly: `TegridyStaking.withdraw` runs
    ///      `delete positions[tokenId]; _burn(tokenId)`, and `_burn` -> `_update` zeroes
    ///      `userTokenId[msg.sender]` (re-pointed only if OTHER positions remain).
    ///      `tokenId == 0` is therefore the steady state of every fully-exited staker —
    ///      exactly the population `totalForfeitedToPool` exists to reclaim from — and
    ///      without this the suite cannot reach that state at all.
    function clearPosition(address user) external {
        uint256 tid = _userTokenId[user];
        if (tid != 0) delete tokenOwner[tid];
        delete _userTokenId[user];
        delete rawPower[user];
        delete lockEnds[user];
    }

    function setPaused(bool p) external { paused = p; }
    function setReverting(bool r) external { reverting = r; }
    function setTokenIdReverting(bool r) external { tokenIdReverting = r; }
    function setPositionsReverting(bool r) external { positionsReverting = r; }

    /// @dev Same selector the public mapping generated, so `IVotingEscrow` is unchanged.
    function userTokenId(address user) external view returns (uint256) {
        if (tokenIdReverting) revert("VE_TOKENID_DOWN");
        return _userTokenId[user];
    }

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
        if (positionsReverting) revert("VE_POSITIONS_DOWN");
        address u = tokenOwner[tokenId];
        return (rawPower[u], rawPower[u], int256(0), lockEnds[u], 10000, 0, false, false, 0, 0, false);
    }
}

contract MockRestaking {
    mapping(address => uint256) public power;
    mapping(address => uint256) public tokenIds;
    /// @dev A restaker's staking-side `userTokenId` is 0 and `votingPowerOf` force-returns
    ///      0 (TegridyStaking custodies the NFT), so `_lockEndOf` answers a genuine,
    ///      readable "no position" for them permanently. `_isRestaked` is therefore the
    ///      ONLY thing between a restaker and a permissionless forfeit — which makes an
    ///      outage toggle on this mock load-bearing, not decorative.
    bool public reverting;

    function setRestaker(address user, uint256 tokenId, uint256 p) external {
        tokenIds[user] = tokenId;
        power[user] = p;
    }

    function setReverting(bool r) external { reverting = r; }

    function restakers(address user) external view returns (
        uint256 tokenId, uint256 positionAmount, uint256 boostedAmount, int256 bonusDebt, uint256 depositTime
    ) {
        if (reverting) revert("RESTAKING_DOWN");
        return (tokenIds[user], power[user], power[user], int256(0), 0);
    }

    function boostedAmountAt(address user, uint256) external view returns (uint256) {
        if (reverting) revert("RESTAKING_DOWN");
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
    // ║  UNREADABLE ESCROW — AN OUTAGE IS NOT EVIDENCE                 ║
    // ═══════════════════════════════════════════════════════════════════
    //
    // `_lockEndOf` used to return a bare 0 for THREE different conditions: a genuine
    // "no position", a reverting `positions`, and a reverting `userTokenId`. The two
    // consumers then read that 0 in OPPOSITE directions and both hurt the staker —
    // `_syncAndMaybeRecycle` forfeited immediately with no grace, and `getReward`
    // refused to pay. A transient failure to read the escrow therefore left an account
    // simultaneously unable to claim its own ETH and instantly forfeitable by any
    // permissionless `sync` caller.
    //
    // Every fixture below leaves the restaking contract UNWIRED and asserts a non-zero
    // `rewards[alice]` first: `_syncAndMaybeRecycle` has three early returns BEFORE the
    // gate under test, and any of them would make a "did not forfeit" assertion
    // trivially true.

    /// @dev Alice with a LIVE far-future lock and real crystallised accrual.
    function _crystalliseAliceAccrual() internal returns (uint256 owed) {
        _enableStreaming();
        _stake(alice, 500e18);
        _stake(bob, 500e18);
        dist.sync(alice);
        dist.sync(bob);
        _fund(7 ether);
        dist.notifyRewardAmount();

        vm.warp(block.timestamp + DURATION / 2);
        dist.sync(alice);
        owed = dist.rewards(alice);
        assertGt(owed, 0, "fixture is vacuous: nothing crystallised to forfeit");
    }

    /// @dev Alice expired, synced, and now PAST `lockEnd + CLAIM_GRACE_PERIOD` — i.e.
    ///      legitimately forfeitable whenever the escrow is readable. This is the state
    ///      that makes the outage tests sharp rather than tautological.
    function _alicePastGrace() internal returns (uint256 owed) {
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
        owed = dist.rewards(alice);
        assertGt(owed, 0, "fixture is vacuous: nothing crystallised to forfeit");
        assertEq(dist.effectiveBalanceOf(alice), 0, "expired lock still mirrored");

        vm.warp(aliceEnd + dist.CLAIM_GRACE_PERIOD() + 1);
    }

    /// @notice OUTER catch arm. A live 4-year lock, mid-stream, while the whole escrow is
    ///         dark: neither forfeited nor blocked from claiming.
    function test_UserTokenIdOutageNeitherForfeitsNorBlocksTheClaim() public {
        uint256 owed = _crystalliseAliceAccrual();
        uint256 forfeitedBefore = dist.totalForfeitedToPool();

        ve.setReverting(true);
        ve.setTokenIdReverting(true);
        ve.setPositionsReverting(true);

        dist.sync(alice);

        // The mirror zeroing is what carries execution PAST the `effectiveBalanceOf != 0`
        // early return and INTO the gate under test. Without this line the two assertions
        // below would pass vacuously.
        assertEq(dist.effectiveBalanceOf(alice), 0, "forfeit gate was never reached");
        assertEq(dist.rewards(alice), owed, "an outage forfeited a live staker");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "an outage recycled a live staker");

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        dist.getReward();
        assertEq(alice.balance - balBefore, owed, "an outage blocked a live staker's claim");
        assertEq(dist.rewards(alice), 0);
    }

    /// @notice INNER catch arm in isolation — `userTokenId` still answers, `positions`
    ///         does not. The sharpest statement of the doctrine: an account that WOULD be
    ///         forfeitable is not forfeited while the evidence is unreadable.
    function test_PositionsOutageNeitherForfeitsNorBlocksTheClaim() public {
        uint256 owed = _alicePastGrace();
        uint256 forfeitedBefore = dist.totalForfeitedToPool();

        ve.setPositionsReverting(true);

        dist.sync(alice);
        assertEq(dist.rewards(alice), owed, "forfeited on evidence that could not be read");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "recycled on unreadable evidence");

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        dist.getReward();
        assertEq(alice.balance - balBefore, owed, "unreadable evidence blocked the claim");
    }

    /// @notice ANTI-WEAKENING. The fix DEFERS the forfeit, it does not disable it: the
    ///         same account, unchanged, becomes forfeitable the moment the escrow answers.
    function test_EscrowRecoveryRestoresForfeitability() public {
        uint256 owed = _alicePastGrace();
        uint256 forfeitedBefore = dist.totalForfeitedToPool();

        ve.setPositionsReverting(true);
        dist.sync(alice);
        assertEq(dist.rewards(alice), owed, "forfeited while unreadable");

        ve.setPositionsReverting(false);
        dist.sync(alice);
        assertEq(dist.rewards(alice), 0, "recovery did not restore forfeitability");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore + owed, "recycling is dead");

        vm.prank(alice);
        vm.expectRevert(StreamingRevenueDistributor.NoLockedTokens.selector);
        dist.getReward();
    }

    /// @notice The same anti-weakening proof through the OUTER arm, so neither catch can
    ///         be left permanently "unknown" without a test noticing.
    function test_EscrowRecoveryRestoresForfeitabilityViaTheTokenIdArm() public {
        uint256 owed = _alicePastGrace();
        uint256 forfeitedBefore = dist.totalForfeitedToPool();

        ve.setTokenIdReverting(true);
        dist.sync(alice);
        assertEq(dist.rewards(alice), owed, "forfeited while unreadable");

        ve.setTokenIdReverting(false);
        dist.sync(alice);
        assertEq(dist.rewards(alice), 0, "recovery did not restore forfeitability");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore + owed, "recycling is dead");
    }

    /// @notice COMBINATION SWEEP over both toggles. Deliberately a deterministic loop in a
    ///         `test_` function and NOT a `testFuzz_` name: every unit slice in
    ///         `.github/contracts-test-slices.json` runs with
    ///         `--no-match-test "^(invariant_|testFuzz_)"`, so a fuzz-named test here would
    ///         compile, be counted in the slice, and silently never execute.
    function test_EveryEscrowOutageCombinationPreservesTheStaker() public {
        for (uint256 i = 1; i < 4; ++i) {
            uint256 snap = vm.snapshotState();

            uint256 owed = _alicePastGrace();
            uint256 forfeitedBefore = dist.totalForfeitedToPool();

            ve.setTokenIdReverting((i & 1) != 0);
            ve.setPositionsReverting((i & 2) != 0);

            dist.sync(alice);
            assertEq(dist.rewards(alice), owed, "an outage combination forfeited");
            assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "an outage combination recycled");

            uint256 balBefore = alice.balance;
            vm.prank(alice);
            dist.getReward();
            assertEq(alice.balance - balBefore, owed, "an outage combination blocked the claim");

            vm.revertToState(snap);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  THE ORDINARY EXIT — tokenId == 0 IS A REAL ANSWER             ║
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Alice exits ON TERM — the only exit `TegridyStaking.withdraw` permits, since
    ///      it reverts `LockNotExpired` while `block.timestamp < p.lockEnd`
    ///      (TegridyStaking.sol:1465). The previous version of this fixture cleared a
    ///      FAR_FUTURE position mid-lock, which is not `withdraw` at all: that is
    ///      `earlyWithdraw` (which reverts `MustUseWithdraw` unless the lock is still
    ///      running, TegridyStaking.sol:1490) or an outbound NFT transfer — a different
    ///      and deliberately ungraced case, pinned by `RefuteAnchorReset`.
    /// @return owed    crystallised accrual at the instant the mirror fell to zero
    /// @return lockEnd the staking-side number the grace is measured from
    function _aliceExitsOnTerm() internal returns (uint256 owed, uint256 lockEnd) {
        _enableStreaming();
        lockEnd = block.timestamp + 2 days;
        ve.setPosition(alice, 500e18, lockEnd);
        _stake(bob, 500e18);
        dist.sync(alice);
        dist.sync(bob);
        _fund(7 ether);
        dist.notifyRewardAmount();

        assertEq(dist.lockEndSeen(alice), lockEnd, "anchor was not sampled while the position lived");

        vm.warp(lockEnd + 1);
        dist.sync(alice);
        assertEq(dist.effectiveBalanceOf(alice), 0, "expired lock still mirrored");
        owed = dist.rewards(alice);
        assertGt(owed, 0, "fixture is vacuous: nothing crystallised to forfeit");

        // THE PROPERTY ATTEMPT 1 LACKED, stated as an assertion rather than a comment:
        // `withdraw` runs `delete positions[tokenId]; _burn(tokenId)`, so the only
        // permitted exit ERASES the `lockEnd` the grace is measured from. An anchor
        // stamped when this contract NOTICES that fall is chosen by the account; the
        // remembered NUMBER survives the burn untouched.
        ve.clearPosition(alice);
        assertEq(dist.lockEndSeen(alice), lockEnd, "the burn erased the anchor");
    }

    /// @notice A fully-exited staker keeps the documented 7 days, measured from the
    ///         remembered `lockEndSeen` because the burnt NFT leaves no `lockEnd` to
    ///         read. Before the anchor existed this account was forfeitable in the SAME
    ///         BLOCK it exited, with no outage involved at all.
    function test_ExitedStakerKeepsGraceThenClaims() public {
        (uint256 owed, uint256 lockEnd) = _aliceExitsOnTerm();
        uint256 forfeitedBefore = dist.totalForfeitedToPool();

        vm.warp(lockEnd + dist.CLAIM_GRACE_PERIOD() - 1 hours);
        dist.sync(alice);
        assertEq(dist.rewards(alice), owed, "grace not honoured for an exited staker");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "forfeited inside the grace window");

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        dist.getReward();
        assertEq(alice.balance - balBefore, owed, "in-grace claim refused after exit");
    }

    /// @notice THE ANTI-WEAKENING TEST. A fix that treated `lockEnd == 0` as "unknown"
    ///         would make every fully-exited account permanently unforfeitable — silently
    ///         killing recycling for the entire real population — while passing every
    ///         outage test above. This is the only test that kills that over-fix.
    function test_ExitedStakerForfeitsOnceGraceExpires() public {
        (uint256 owed, uint256 lockEnd) = _aliceExitsOnTerm();
        uint256 forfeitedBefore = dist.totalForfeitedToPool();

        vm.warp(lockEnd + dist.CLAIM_GRACE_PERIOD() + 1);
        dist.sync(alice);

        // The anchor must be DURABLE. If a later sync re-stamped it, grace would restart
        // on every touch and expire never — recycling would be dead by a different route.
        assertEq(dist.lockEndSeen(alice), lockEnd, "anchor slid forward on a later sync");

        assertEq(dist.rewards(alice), 0, "past-grace exited staker was never forfeited");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore + owed, "recycling is dead");
        assertGe(dist.distributable(), owed, "recycled wei did not return to the staker pool");

        vm.prank(alice);
        vm.expectRevert(StreamingRevenueDistributor.NoLockedTokens.selector);
        dist.getReward();
    }

    /// @notice THE ANCHOR CANNOT BE CHOSEN OR TIMED BY THE ACCOUNT IT PROTECTS — the
    ///         property attempt 1 lacked, asserted directly. `StakingViewLib.votingPowerOf`
    ///         skips every position with `nowTs >= p.lockEnd` (StakingViewLib.sol:100), so
    ///         the moment the lock expires the account has no live power, the sample
    ///         branch in `_updateReward` is never entered again, and the high-water mark
    ///         is frozen at a staking-side number the account can no longer move. That is
    ///         precisely the state a forfeit is decided in. Alice syncs her own record
    ///         every day for twelve days and cannot shift it by one second.
    function test_AnchorIsFrozenOnceTheLockExpires() public {
        _enableStreaming();
        uint256 lockEnd = block.timestamp + 2 days;
        ve.setPosition(alice, 500e18, lockEnd);
        _stake(bob, 500e18);
        dist.sync(alice);
        dist.sync(bob);
        _fund(7 ether);
        dist.notifyRewardAmount();
        assertEq(dist.lockEndSeen(alice), lockEnd, "anchor was not sampled while the lock was live");

        // NOTE: `block.timestamp` is CSE-folded across `vm.warp` under via_ir, so the
        // clock is carried in an explicit accumulator rather than re-read in the loop.
        uint256 t = lockEnd + 1;
        for (uint256 i; i < 12; ++i) {
            vm.warp(t);
            vm.prank(alice);
            dist.sync(alice);
            assertEq(dist.lockEndSeen(alice), lockEnd, "the account moved its own grace anchor");
            t += 1 days;
        }

        // ...and the window she could not move has closed behind her.
        vm.prank(alice);
        vm.expectRevert(StreamingRevenueDistributor.NoLockedTokens.selector);
        dist.getReward();
    }

    /// @notice The anchor must TRACK a genuine lock extension, which is why the sample
    ///         cannot be gated on the mirror moving. `extendLock` only requires the
    ///         resulting expiry to exceed the old one (TegridyStaking.sol:1251), and the
    ///         autoMaxLock relock inside `TegridyStaking.getReward` rewrites
    ///         `p.lockEnd = block.timestamp + MAX_LOCK_DURATION` on EVERY claim
    ///         (TegridyStaking.sol:1532). Both leave `boostBps` — and therefore this
    ///         mirror — byte-identical. An anchor frozen at its first value, or sampled
    ///         only when the mirror moves, would send a staker who relocked into a
    ///         forfeit measured from the OLD expiry.
    function test_AnchorFollowsALockExtension() public {
        _enableStreaming();
        uint256 firstEnd = block.timestamp + 2 days;
        ve.setPosition(alice, 500e18, firstEnd);
        _stake(bob, 500e18);
        dist.sync(alice);
        dist.sync(bob);
        _fund(7 ether);
        dist.notifyRewardAmount();
        assertEq(dist.lockEndSeen(alice), firstEnd);

        // Relock. Same amount, same boost, same mirror — only `lockEnd` moves.
        uint256 secondEnd = firstEnd + 60 days;
        uint256 mirrorBefore = dist.effectiveBalanceOf(alice);
        ve.setPosition(alice, 500e18, secondEnd);
        dist.sync(alice);
        assertEq(dist.effectiveBalanceOf(alice), mirrorBefore, "fixture is vacuous: the mirror moved");
        assertEq(dist.lockEndSeen(alice), secondEnd, "anchor ignored a lock extension");

        // Run the extended lock out and exit ON TERM. The burnt position leaves nothing
        // to read, so the EXTENDED anchor is the only thing carrying the grace.
        vm.warp(secondEnd + 1);
        dist.sync(alice);
        uint256 owed = dist.rewards(alice);
        assertGt(owed, 0, "fixture is vacuous: nothing crystallised");
        ve.clearPosition(alice);

        vm.warp(secondEnd + dist.CLAIM_GRACE_PERIOD() - 1 hours);
        uint256 forfeitedBefore = dist.totalForfeitedToPool();
        dist.sync(alice);
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "forfeited at the pre-extension anchor");

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        dist.getReward();
        assertEq(alice.balance - balBefore, owed, "a relocked staker's in-grace claim was refused");
    }

    /// @notice A LOCK EXTENSION NOBODY SYNCED still wins, which is why the LIVE read is
    ///         preferred over the remembered one whenever it is later. `extendLock` can
    ///         move `lockEnd` forward at any time (TegridyStaking.sol:1251) and nothing
    ///         obliges a keeper to observe it, so the high-water mark can legitimately lag
    ///         the truth. Drop that preference and a staker who relocked for two more
    ///         months and was never re-synced is forfeited at the OLD expiry — a
    ///         confiscation caused purely by keeper latency.
    function test_AnUnsyncedLockExtensionStillBeatsTheStaleAnchor() public {
        _enableStreaming();
        uint256 firstEnd = block.timestamp + 2 days;
        ve.setPosition(alice, 500e18, firstEnd);
        _stake(bob, 500e18);
        dist.sync(alice);
        dist.sync(bob);
        _fund(7 ether);
        dist.notifyRewardAmount();
        assertEq(dist.lockEndSeen(alice), firstEnd);

        // Alice relocks and NOBODY syncs her, so the extended lock runs out having never
        // been sampled and the anchor keeps the stale `firstEnd`.
        uint256 secondEnd = firstEnd + 60 days;
        ve.setPosition(alice, 500e18, secondEnd);
        vm.warp(secondEnd + 1);

        uint256 forfeitedBefore = dist.totalForfeitedToPool();
        dist.sync(alice);
        assertEq(dist.lockEndSeen(alice), firstEnd, "fixture is vacuous: the anchor was refreshed");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "forfeited at a stale anchor");

        uint256 owed = dist.rewards(alice);
        assertGt(owed, 0, "fixture is vacuous: nothing crystallised");
        uint256 balBefore = alice.balance;
        vm.prank(alice);
        dist.getReward();
        assertEq(alice.balance - balBefore, owed, "claim refused at a stale anchor after a relock");
    }

    /// @notice The zero anchor is never load-bearing. `rewards` only grows through
    ///         `earned()`, which is identically 0 under a zero mirror — so an account
    ///         that never mirrored in has nothing to protect and nothing to forfeit.
    function test_NeverMirroredAccountIsNeitherForfeitableNorClaimable() public {
        _enableStreaming();
        _stake(alice, 1000e18);
        dist.sync(alice);
        _fund(7 ether);
        dist.notifyRewardAmount();
        vm.warp(block.timestamp + DURATION);

        assertEq(dist.lockEndSeen(carol), 0, "anchor written for an account that never held power");

        uint256 forfeitedBefore = dist.totalForfeitedToPool();
        dist.sync(carol);
        assertEq(dist.rewards(carol), 0);
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "forfeited a phantom balance");

        // SELECTOR CHANGED IN ATTEMPT 2, deliberately. With NO anchor at all the
        // lock/grace gate declines to judge (`_claimDeadlineOf` state (1)) rather than
        // refusing, so a total stranger now falls through to the `reward == 0` check.
        // Both are reverts and neither moves a wei; the gate had to stop refusing on a
        // missing anchor because refusing there is exactly what confiscates a restaker
        // whose NFT stranded — see test_StrandedRestakerIsNeitherForfeitedNorRefused.
        vm.prank(carol);
        vm.expectRevert(StreamingRevenueDistributor.NothingToClaim.selector);
        dist.getReward();
    }

    /// @notice BOUNDARY OF THE `ok` FLAG. `try/catch` catches a REVERTING call; it does
    ///         not catch a call to a CODELESS address, which succeeds with empty
    ///         returndata and fails in the ABI decode that follows. `votingEscrow` is
    ///         immutable and set at construction and post-Cancun SELFDESTRUCT cannot clear
    ///         a deployed contract's code, so this is reachable only by a deployment
    ///         mis-wire — pinned because the header claims reverting staking reads
    ///         "degrade to 0 rather than bricking", and this is where that claim stops.
    ///         The property that must hold either way: nothing is fabricated and no
    ///         staker's crystallised ETH moves.
    function test_CodelessEscrowIsLoudAndNeverConfiscates() public {
        uint256 owed = _crystalliseAliceAccrual();

        vm.etch(address(ve), "");

        try dist.sync(alice) {
            emit log("codeless escrow: sync DEGRADED (did not revert)");
        } catch {
            emit log("codeless escrow: sync REVERTED (loud, not silent)");
        }
        assertEq(dist.rewards(alice), owed, "a codeless escrow cost a staker their accrual");
        assertEq(dist.totalForfeitedToPool(), 0, "a codeless escrow triggered a forfeit");
    }

    // ═══════════════════════════════════════════════════════════════════
    // ║  RESTAKING FALLBACK                                            ║
    // ═══════════════════════════════════════════════════════════════════

    /// @notice RESTAKERS ARE THE MOST EXPOSED POPULATION, and fixing `_lockEndOf` alone
    ///         does NOT cover them. Their NFT is custodied by TegridyRestaking, so
    ///         `userTokenId` is 0 and `votingPowerOf` force-returns 0 for the restaking
    ///         address — `_lockEndOf` answers a genuine, READABLE "no position" for them
    ///         permanently. With only `_lockEndOf` three-valued they would still be
    ///         confiscated the moment their anchor expired, having exited nothing.
    ///         `_isRestaked`'s "unknown" signal is the whole guard here.
    /// @dev    FIXTURE STRENGTHENED IN ATTEMPT 2. The previous version made Carol a
    ///         restaker who had never held a staking position, so her `lockEndSeen` was 0
    ///         and `_claimDeadlineOf`'s no-anchor branch would have saved her whether
    ///         `_isRestaked` was three-valued or not — the assertions passed without the
    ///         guard under test doing anything (mutation M3/M5 survived it). A restaker
    ///         comes into existence by staking FIRST and restaking after, which writes a
    ///         real anchor before the NFT is custodied. With that anchor present and its
    ///         grace long expired, `_isRestaked` refusing to report an outage as "this
    ///         account exited" is once again the only thing standing between Carol and a
    ///         permissionless forfeit.
    function test_RestakingOutageDoesNotConfiscateARestaker() public {
        _enableStreaming();
        _wireRestaking();
        _stake(bob, 1000e18);

        uint256 carolEnd = block.timestamp + 2 days;
        ve.setPosition(carol, 1000e18, carolEnd);
        dist.sync(carol);
        assertEq(dist.lockEndSeen(carol), carolEnd, "anchor not written before restaking");

        // TegridyRestaking takes custody: the NFT leaves her, `userTokenId[carol]` is
        // zeroed (StakingRewardLib.sol:890), and her power now arrives through the
        // restaking leg instead.
        restaking.setRestaker(carol, 42, 1000e18);
        ve.clearPosition(carol);
        dist.sync(carol);
        dist.sync(bob);
        assertEq(dist.effectiveBalanceOf(carol), 1000e18, "restaker not mirrored");

        _fund(7 ether);
        dist.notifyRewardAmount();
        vm.warp(block.timestamp + DURATION / 2);
        dist.sync(carol);
        uint256 owed = dist.rewards(carol);
        assertGt(owed, 0, "fixture is vacuous: nothing crystallised to forfeit");

        // The restaking leg goes dark. Carol has not moved a thing.
        restaking.setReverting(true);
        dist.sync(carol);
        assertEq(dist.effectiveBalanceOf(carol), 0, "forfeit gate was never reached");

        // Warped past her own pre-restaking anchor + grace — the underlying lock ran out
        // while the NFT was custodied, which is ordinary. She has exited NOTHING, and the
        // ONLY thing that can save her is `_isRestaked` refusing to report an outage as
        // "this account exited".
        vm.warp(carolEnd + dist.CLAIM_GRACE_PERIOD() + 1);
        uint256 forfeitedBefore = dist.totalForfeitedToPool();
        dist.sync(carol);
        assertEq(dist.rewards(carol), owed, "a restaking outage confiscated a restaker");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "a restaking outage recycled a restaker");

        uint256 balBefore = carol.balance;
        vm.prank(carol);
        dist.getReward();
        assertEq(carol.balance - balBefore, owed, "a restaking outage blocked a restaker's claim");
    }

    /// @notice ANTI-WEAKENING for the restaking arm. An account that genuinely LEFT
    ///         restaking — read cleanly, no outage — still forfeits once its grace
    ///         expires. An unset restaking contract and a live one that answers "no" are
    ///         real answers, not unknowns.
    /// @dev    FIXTURE CORRECTED IN ATTEMPT 2, and the correction is the point. The
    ///         previous version unwound Carol with `restaking.setRestaker(carol, 0, 0)`
    ///         and left her with NO staking position afterwards. That is not a clean
    ///         unrestake: every real exit path (`unrestake`, force-close,
    ///         `emergencyWithdrawNFT`) deletes `restakers[user]` and hands the NFT back in
    ///         the SAME transaction through `_returnNftSettleResidual`, whose
    ///         `safeTransferFrom` repopulates `userTokenId` (StakingRewardLib.sol:897) and
    ///         makes the real `lockEnd` readable again. The old fixture was silently
    ///         modelling that function's CATCH ARM — the stranded-NFT case — while its
    ///         docstring claimed the happy path. The stranded case now has its own test
    ///         below, with the OPPOSITE expectation, deliberately.
    function test_FormerRestakerStillForfeitsOnceGraceExpires() public {
        _enableStreaming();
        _wireRestaking();
        restaking.setRestaker(carol, 42, 1000e18);
        _stake(bob, 1000e18);
        dist.sync(carol);
        dist.sync(bob);

        _fund(7 ether);
        dist.notifyRewardAmount();
        vm.warp(block.timestamp + DURATION / 2);
        dist.sync(carol);
        assertGt(dist.rewards(carol), 0, "fixture is vacuous: nothing crystallised to forfeit");

        // Carol genuinely unwinds. The NFT comes home in the same transaction, so her
        // position — and its lockEnd — are readable again the moment she stops being a
        // restaker. No anchor gap ever opens.
        uint256 carolEnd = block.timestamp + 2 days;
        restaking.setRestaker(carol, 0, 0);
        ve.setPosition(carol, 1000e18, carolEnd);
        dist.sync(carol);
        assertEq(dist.lockEndSeen(carol), carolEnd, "the returned position was not anchored");

        vm.warp(carolEnd + 1);
        dist.sync(carol);
        uint256 owed = dist.rewards(carol);
        assertGt(owed, 0, "fixture is vacuous after the unwind");
        uint256 forfeitedBefore = dist.totalForfeitedToPool();

        vm.warp(carolEnd + dist.CLAIM_GRACE_PERIOD() + 1);
        dist.sync(carol);
        assertEq(dist.rewards(carol), 0, "a former restaker never forfeits");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore + owed, "recycling is dead");
    }

    /// @notice THE HONEST FALLBACK, PINNED — and the loud statement that the "an anchor
    ///         always exists wherever there is something to forfeit" hypothesis is FALSE.
    ///         It holds for escrow stakers by construction: `rewards` grows only through
    ///         `earned()`, `earned()` scales by `effectiveBalanceOf`, that mirror has
    ///         exactly one writer, and the anchor is sampled at that same site — and
    ///         `StakingViewLib.votingPowerOf` counts a position only while
    ///         `nowTs < p.lockEnd` (StakingViewLib.sol:100), so live power PROVES a
    ///         readable non-zero `lockEnd`. It FAILS for restakers: TegridyRestaking
    ///         custodies the NFT, `userTokenId` is 0 (StakingRewardLib.sol:890), and
    ///         `_lockEndOf` therefore answers a genuine, readable `(true, 0)` for their
    ///         entire restaking life. No `lockEndSeen` is ever written for them.
    ///
    ///         A clean unrestake repairs that in the same transaction (test above). The
    ///         `_returnNftSettleResidual` CATCH ARM (TegridyRestaking.sol:342) does not:
    ///         `restakers[user]` is already deleted and the NFT is stranded, leaving an
    ///         account with crystallised ETH, no readable expiry, and no anchor.
    ///         Forfeiting there re-arms attempt 1's bug against exactly the population
    ///         `_isRestaked` was made three-valued for, so this contract declines to
    ///         judge instead. The cost is real and stated rather than hidden: those wei
    ///         stay in `rewards[carol]`, stay inside `reservedETH()`, and never re-stream
    ///         until she calls `claimStrandedRestakeNFT` and is synced again.
    function test_StrandedRestakerIsNeitherForfeitedNorRefused() public {
        _enableStreaming();
        _wireRestaking();
        restaking.setRestaker(carol, 42, 1000e18);
        _stake(bob, 1000e18);
        dist.sync(carol);
        dist.sync(bob);

        _fund(7 ether);
        dist.notifyRewardAmount();
        vm.warp(block.timestamp + DURATION / 2);
        dist.sync(carol);
        uint256 owed = dist.rewards(carol);
        assertGt(owed, 0, "fixture is vacuous: nothing crystallised to forfeit");

        // The stranded state: restaking membership gone, NFT never delivered, so the
        // staking side still shows her nothing.
        restaking.setRestaker(carol, 0, 0);
        dist.sync(carol);
        assertEq(dist.effectiveBalanceOf(carol), 0, "forfeit gate was never reached");
        assertEq(dist.lockEndSeen(carol), 0, "a custodied restaker was given a lockEnd anchor");

        vm.warp(block.timestamp + 3650 days);
        uint256 forfeitedBefore = dist.totalForfeitedToPool();
        dist.sync(carol);
        assertEq(dist.rewards(carol), owed, "a stranded restaker was confiscated");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "a stranded restaker was recycled");

        uint256 balBefore = carol.balance;
        vm.prank(carol);
        dist.getReward();
        assertEq(carol.balance - balBefore, owed, "a stranded restaker's own claim was refused");
    }

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
