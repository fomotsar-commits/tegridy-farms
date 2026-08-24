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

    /// @notice A fully-exited staker keeps their accrual and can still claim it.
    ///
    ///         REWRITTEN with the timelocked-forfeit change. This used to assert a 7-day
    ///         window measured from an `exitedAt` anchor. That anchor was refuted twice
    ///         (the only permitted exit BURNS the NFT, erasing the `lockEnd` grace is
    ///         measured from, and the account chose when the anchor was stamped), so it
    ///         is gone. `_claimDeadlineOf` now answers UNKNOWN for an exited account, and
    ///         `getReward` resolves unknown toward the staker.
    ///
    ///         The protection is therefore STRONGER than the old 7 days and no longer
    ///         depends on an anchor at all: `sync` cannot take anything from anyone.
    function test_ExitedStakerKeepsAccrualAndCanStillClaim() public {
        uint256 owed = _crystalliseAliceAccrual();
        uint256 forfeitedBefore = dist.totalForfeitedToPool();

        ve.clearPosition(alice);
        dist.sync(alice);
        assertEq(dist.effectiveBalanceOf(alice), 0, "exit not mirrored");

        // Far past any window the old design would have closed.
        vm.warp(block.timestamp + dist.CLAIM_GRACE_PERIOD() * 10);
        dist.sync(alice);
        assertEq(dist.rewards(alice), owed, "a permissionless sync reduced an exited staker's accrual");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "sync forfeited");

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        dist.getReward();
        assertEq(alice.balance - balBefore, owed, "exited staker could not claim their own accrual");
    }

    /// @notice ⚠️ THE TRADE-OFF, ASSERTED RATHER THAN HIDDEN.
    ///
    ///         A fully-exited account has NO durable anchor — the burnt NFT leaves no
    ///         `lockEnd`, and restakers sit in that state permanently. Under the previous
    ///         design that gap was filled by an anchor, and the anchor was refutable.
    ///         Under this design the gap is answered honestly with UNKNOWN, and
    ///         `_isForfeitable` refuses to take money on a fact it does not have.
    ///
    ///         CONSEQUENCE: this population can NEVER be forfeited, by anyone, including
    ///         the owner. Their ETH stays claimable by them forever and never returns to
    ///         the pool. That is a deliberate choice — the ETH is not lost, only
    ///         unrecycled, and the protocol has no claim on user funds it cannot prove
    ///         were abandoned. It is recorded here so nobody "fixes" it by inventing a
    ///         third anchor.
    function test_ExitedStakerIsNeverForfeitableEvenByTheOwner() public {
        _crystalliseAliceAccrual();

        ve.clearPosition(alice);
        dist.sync(alice);
        vm.warp(block.timestamp + dist.CLAIM_GRACE_PERIOD() * 10);

        address[] memory batch = new address[](1);
        batch[0] = alice;
        vm.prank(dist.owner());
        vm.expectRevert(
            abi.encodeWithSelector(StreamingRevenueDistributor.NotForfeitable.selector, alice)
        );
        dist.proposeForfeit(batch);
    }

    /// @notice RECYCLING IS NOT DEAD — the anti-weakening test, repointed.
    ///
    ///         The population where abandonment IS provable is an account whose lock has
    ///         EXPIRED while it still holds the NFT: `lockEnd` is readable, non-zero and
    ///         in the past, so a window exists and has closed. That is the case the
    ///         timelocked forfeit exists for, and it must work end to end or the pool can
    ///         never reclaim anything.
    function test_ExpiredLockIsForfeitableThroughTheTimelock() public {
        uint256 owed = _crystalliseAliceAccrual();
        uint256 forfeitedBefore = dist.totalForfeitedToPool();

        // Lock expires, NFT still held: readable non-zero lockEnd, now in the past.
        uint256 lockEnd = block.timestamp + 1 days;
        ve.setPosition(alice, 0, lockEnd);
        dist.sync(alice);
        assertEq(dist.effectiveBalanceOf(alice), 0, "expired lock still mirrors power");

        vm.warp(lockEnd + dist.CLAIM_GRACE_PERIOD() + 1);
        // A permissionless sync STILL takes nothing — that is the whole change.
        dist.sync(alice);
        assertEq(dist.rewards(alice), owed, "sync forfeited without the timelock");

        address[] memory batch = new address[](1);
        batch[0] = alice;
        vm.prank(dist.owner());
        dist.proposeForfeit(batch);

        vm.warp(block.timestamp + dist.FORFEIT_RECLAIM_DELAY());
        vm.prank(dist.owner());
        dist.executeForfeit();

        assertEq(dist.rewards(alice), 0, "the timelocked forfeit did not land");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore + owed, "recycling is dead");
        assertEq(dist.lifetimeForfeited(), owed, "lifetime cap accounting did not move");
    }

    /// @notice A non-owner cannot forfeit, which is the property the whole change buys.
    ///         This replaces what `RefuteAnchorReset.t.sol` proved about the old anchor:
    ///         the protection is no longer "the anchor is correct", it is "a stranger
    ///         cannot reach the forfeit at all".
    function test_ForfeitIsUnreachableWithoutOwnership() public {
        _crystalliseAliceAccrual();
        uint256 lockEnd = block.timestamp + 1 days;
        ve.setPosition(alice, 0, lockEnd);
        dist.sync(alice);
        vm.warp(lockEnd + dist.CLAIM_GRACE_PERIOD() + 1);

        address[] memory batch = new address[](1);
        batch[0] = alice;

        vm.prank(bob);
        vm.expectRevert();
        dist.proposeForfeit(batch);

        vm.prank(bob);
        vm.expectRevert();
        dist.executeForfeit();
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


        uint256 forfeitedBefore = dist.totalForfeitedToPool();
        dist.sync(carol);
        assertEq(dist.rewards(carol), 0);
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "forfeited a phantom balance");

        // Gate ORDER matters: the lock/grace gate runs before the `reward == 0` check, so
        // a total stranger is refused with NoLockedTokens, not NothingToClaim.
        vm.prank(carol);
        vm.expectRevert(StreamingRevenueDistributor.NoLockedTokens.selector);
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
    function test_RestakingOutageDoesNotConfiscateARestaker() public {
        _enableStreaming();
        _wireRestaking();
        restaking.setRestaker(carol, 42, 1000e18);
        _stake(bob, 1000e18);
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

        // Warped well past any grace window, so the ONLY thing that can save Carol is
        // `_isRestaked` refusing to report an outage as "this account exited".
        vm.warp(block.timestamp + dist.CLAIM_GRACE_PERIOD() + 1);
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
        uint256 owed = dist.rewards(carol);
        assertGt(owed, 0, "fixture is vacuous: nothing crystallised to forfeit");

        // Carol genuinely unwinds her restaking position. The read is clean throughout.
        restaking.setRestaker(carol, 0, 0);
        dist.sync(carol);

        // REWRITTEN with the timelocked-forfeit change. This asserted that a former
        // restaker IS forfeited once an `exitedAt`-anchored grace expired. That anchor is
        // gone (refuted twice), and a former restaker has no readable `lockEnd` — their
        // NFT was custodied, so `userTokenId` is 0. `_claimDeadlineOf` answers UNKNOWN and
        // nothing may be taken from them.
        //
        // ⚠️ So a former restaker joins the never-forfeitable population. Their ETH stays
        // claimable by them and never returns to the pool. Stated here rather than
        // discovered later — and it is the SAFE direction: this population's power reaches
        // the contract through the restaking leg, whose own read degrades to `false` on
        // failure, so anchoring their forfeit on anything would have made an outage look
        // like an exit.
        uint256 forfeitedBefore = dist.totalForfeitedToPool();
        vm.warp(block.timestamp + dist.CLAIM_GRACE_PERIOD() * 10);
        dist.sync(carol);
        assertEq(dist.rewards(carol), owed, "a former restaker's accrual was reduced by a stranger's sync");
        assertEq(dist.totalForfeitedToPool(), forfeitedBefore, "sync forfeited a former restaker");

        vm.prank(carol);
        dist.getReward();
        assertEq(dist.rewards(carol), 0, "a former restaker could not claim their own accrual");
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
