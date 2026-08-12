// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";

/*//////////////////////////////////////////////////////////////////////////
  KICK-DoS REGRESSION - 2026-08 audit finding "staking-kick"

  `kick()` is permissionless and is the ONLY expiry-decay path. Pre-fix it
  hard-reverted `KickWouldForfeit` whenever the position's pending exceeded the
  room left under the GLOBAL `maxUnsettledRewards` cap. Two consequences, both
  live on `0xcaDc93E9…`:

    (1) POSITION-LOCAL: a position whose pending exceeds the cap is
        PERMANENTLY un-kickable. Its expired boost stays in
        `totalBoostedStake` forever, so `accumulateRewards` keeps dividing
        emission by an inflated denominator - honest stakers are diluted.

    (2) PROTOCOL-WIDE: once ANY other flow saturates the global cap
        (`totalUnsettledRewards == maxUnsettledRewards`), the room is 0 and
        EVERY `kick()` reverts - even for a tiny, fully-funded position.

  Fix: kick only ever runs on an ALREADY-EXPIRED position (host guard
  `TegridyStaking.kick` -> `NoOpKick`), so the `_creditGetReward` [M5]
  expiry force-settle precondition holds unconditionally. Credit the residual
  instead of reverting. NOTHING is forfeited - these tests pin that.
//////////////////////////////////////////////////////////////////////////*/

contract KDoSToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 5_000_000_000 ether);
    }
}

contract KDoSNFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}

/// @notice Minimal stand-in for a TRACKED holder (lending escrow / restaking
///         contract) — same shape as `TrackedHolderMock` in
///         C1_L1_GetRewardShortfallAttribution.t.sol. It only needs to hold a
///         position NFT, be whitelisted so `_isTrackedHolder(this)` is true, and
///         forward `claimUnsettledForTokenId` so `msg.sender == this`.
contract KDoSTrackedHolder {
    TegridyStaking public immutable staking;
    constructor(TegridyStaking _staking) { staking = _staking; }

    function callClaimUnsettledForTokenId(uint256 tokenId, address recipient)
        external
        returns (uint256)
    {
        return staking.claimUnsettledForTokenId(tokenId, recipient);
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }
}

contract KickForfeitDoSTest is Test {
    TegridyStaking public staking;
    StakingMonitorView public monitor;
    TegridyStakingAdmin public admin;
    KDoSToken public token;
    KDoSNFT public nft;

    address public treasury = makeAddr("kdos_treasury");
    address public alice    = makeAddr("kdos_alice");
    address public bob      = makeAddr("kdos_bob");
    address public carol    = makeAddr("kdos_carol");
    address public payee    = makeAddr("kdos_payee");

    uint256 internal constant RATE = 1 ether; // 1 TOWELI / second

    function setUp() public {
        token = new KDoSToken();
        nft = new KDoSNFT();
        staking = new TegridyStaking(address(token), address(nft), treasury, RATE);
        monitor = new StakingMonitorView(address(staking));
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        token.transfer(alice, 500_000_000 ether);
        token.transfer(bob,   500_000_000 ether);
        token.transfer(carol, 500_000_000 ether);

        vm.prank(alice); token.approve(address(staking), type(uint256).max);
        vm.prank(bob);   token.approve(address(staking), type(uint256).max);
        vm.prank(carol); token.approve(address(staking), type(uint256).max);
        token.approve(address(staking), type(uint256).max);

        vm.warp(1_000_000);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _stake(address u, uint256 amt, uint256 lock) internal returns (uint256 id) {
        vm.prank(u);
        staking.stake(amt, lock);
        id = staking.userTokenId(u);
    }

    function _pos(uint256 tokenId)
        internal view returns (uint256 amount, uint256 boostedAmount, int256 rewardDebt)
    {
        (amount, boostedAmount, rewardDebt, , , , , , , , ) = staking.positions(tokenId);
    }

    function _rewardPool() internal view returns (uint256) {
        uint256 bal = token.balanceOf(address(staking));
        uint256 reserved = staking.totalStaked() + staking.totalUnsettledRewards();
        return bal > reserved ? bal - reserved : 0;
    }

    function _drainPoolTo(uint256 leavePool) internal {
        uint256 pool = _rewardPool();
        require(pool >= leavePool, "drain: pool already below target");
        uint256 drain = pool - leavePool;
        if (drain == 0) return;
        vm.prank(address(staking));
        token.transfer(address(0xDEAD), drain);
    }

    function _fund(uint256 amt) internal {
        staking.notifyRewardAmount(amt);
    }

    /// @dev true iff a `RewardsForfeited` event was emitted by the staking
    ///      contract in the recorded log window.
    function _sawForfeit(Vm.Log[] memory logs) internal view returns (bool) {
        bytes32 sig = keccak256("RewardsForfeited(address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(staking) && logs[i].topics.length > 0 && logs[i].topics[0] == sig) {
                return true;
            }
        }
        return false;
    }

    // ══════════════════════════════════════════════════════════════════
    // (1) POSITION-LOCAL: pending > cap must NOT make the position
    //     permanently un-kickable, and must NOT forfeit anything.
    // ══════════════════════════════════════════════════════════════════

    /// @notice PRE-FIX: reverts `KickWouldForfeit` — the expired boost is stuck
    ///         in `totalBoostedStake` forever, diluting every honest staker.
    ///         POST-FIX: kick succeeds, the FULL pending is credited to the
    ///         holder's unsettled bucket (cap bypassed, per the [M5]
    ///         "never destroy value" construction already used by
    ///         `_creditGetReward` on its expiry branch), and the boost decays.
    function test_kick_pendingExceedsCap_kicksAndCreditsFull_noForfeit() public {
        _fund(50_000_000 ether);

        // alice: big position, short lock -> pending dwarfs the 100k cap.
        uint256 aliceId = _stake(alice, 5_000_000 ether, 7 days);
        // bob keeps totalBoostedStake non-zero after alice's boost decays.
        uint256 bobId = _stake(bob, 50_000 ether, 365 days);

        vm.warp(block.timestamp + 5 days);
        _fund(1_000 ether);                     // bake accrual at a healthy pool
        vm.warp(block.timestamp + 2 days + 1);  // alice's 7d lock has expired

        // Drain BEFORE reading earned() so earned() and kick() see the same pool.
        _drainPoolTo(1_000 ether);
        uint256 poolNow = _rewardPool();
        uint256 pending = monitor.earned(aliceId);
        uint256 cap = staking.maxUnsettledRewards();
        assertEq(cap, 100_000 ether, "default cap assumption");
        assertGt(pending - poolNow, cap, "shortfall must exceed the cap (pre-fix: reverts)");

        (, uint256 aliceBoost, int256 debtBefore) = _pos(aliceId);
        (, uint256 bobBoost, ) = _pos(bobId);
        uint256 totalBefore = staking.totalBoostedStake();
        assertEq(totalBefore, aliceBoost + bobBoost, "total == sum pre-kick");
        uint256 unsettledBefore = staking.unsettledRewards(alice);

        vm.recordLogs();
        vm.prank(carol); // permissionless kicker
        staking.kick(aliceId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // ── nothing destroyed ───────────────────────────────────────────
        assertFalse(_sawForfeit(logs), "kick must NOT forfeit on the expiry path");
        uint256 credited = staking.unsettledRewards(alice) - unsettledBefore;
        assertApproxEqAbs(credited, pending, 1, "FULL pre-expiry pending credited");
        assertGt(credited, cap, "credit exceeds the flow-control cap (bypass is intentional)");

        // rewardDebt advances by EXACTLY what was credited (no silent write-off).
        (, uint256 aliceBoostAfter, int256 debtAfter) = _pos(aliceId);
        assertEq(uint256(debtAfter - debtBefore), credited, "rewardDebt advance == credit");

        // ── the dilution is actually cured ──────────────────────────────
        assertEq(aliceBoostAfter, 0, "boostedAmount decayed to 0");
        assertEq(staking.totalBoostedStake(), bobBoost, "expired boost removed from the denominator");

        // ── the credit is REAL money, not a bookkeeping ghost ───────────
        _fund(50_000_000 ether); // operator backfills the earned-but-unbacked debt
        uint256 balBefore = token.balanceOf(alice);
        vm.prank(alice);
        staking.claimUnsettled();
        assertEq(token.balanceOf(alice) - balBefore, credited, "alice withdraws the FULL credit");
        assertEq(staking.unsettledRewards(alice), 0, "bucket drained");
    }

    // ══════════════════════════════════════════════════════════════════
    // (2) PROTOCOL-WIDE: one saturated global cap must not brick kick()
    //     for every other position.
    // ══════════════════════════════════════════════════════════════════

    /// @notice Bob's under-funded `getReward` saturates the GLOBAL unsettled cap.
    ///         Alice's position is tiny and the pool is healthy — yet PRE-FIX her
    ///         `kick()` reverts `KickWouldForfeit` purely because
    ///         `unsettledRoom == 0`. That is a protocol-wide DoS on the only
    ///         expiry-decay path. POST-FIX the kick goes through.
    function test_kick_globalCapSaturatedByOtherStaker_stillKicks() public {
        _fund(50_000_000 ether);

        uint256 bobId   = _stake(bob,   5_000_000 ether, 4 * 365 days); // never expires here
        uint256 aliceId = _stake(alice, 1_000 ether,     7 days);

        vm.warp(block.timestamp + 8 days); // alice expired; both accrued
        _fund(1_000 ether);                // bake accrual at a healthy pool

        // Saturate the global cap through bob's under-funded claim.
        _drainPoolTo(1_000 ether);
        vm.prank(bob);
        staking.getReward(bobId);
        uint256 cap = staking.maxUnsettledRewards();
        assertEq(staking.totalUnsettledRewards(), cap, "global unsettled cap is saturated");

        // Refill the reward pool: the pool is NOT the binding constraint here.
        _fund(50_000_000 ether);
        assertGt(_rewardPool(), 1_000_000 ether, "pool is healthy");

        uint256 alicePending = monitor.earned(aliceId);
        assertGt(alicePending, 0, "alice has pre-expiry pending");
        assertLt(alicePending, cap, "alice's pending is small - only the ROOM binds");

        (, uint256 aliceBoost, ) = _pos(aliceId);
        (, uint256 bobBoost, )   = _pos(bobId);
        uint256 unsettledBefore = staking.unsettledRewards(alice);

        // PRE-FIX this reverts with KickWouldForfeit.
        vm.prank(carol);
        staking.kick(aliceId);

        uint256 credited = staking.unsettledRewards(alice) - unsettledBefore;
        assertApproxEqAbs(credited, alicePending, 1, "alice's pending credited in full");

        (, uint256 aliceBoostAfter, ) = _pos(aliceId);
        assertEq(aliceBoostAfter, 0, "boostedAmount decayed to 0");
        assertEq(staking.totalBoostedStake(), bobBoost, "denominator corrected");
        assertGt(aliceBoost, 0, "sanity: alice had boost to decay");
    }

    /// @notice A saturated cap must not let a SECOND kick double-credit. After
    ///         the fix the position is fully settled, so a repeat kick reverts
    ///         `NoOpKick` (boost already 0) and no further value is minted.
    function test_kick_isNotRepeatable_afterResidualCredit() public {
        _fund(50_000_000 ether);
        uint256 aliceId = _stake(alice, 5_000_000 ether, 7 days);
        _stake(bob, 50_000 ether, 365 days);

        vm.warp(block.timestamp + 5 days);
        _fund(1_000 ether);
        vm.warp(block.timestamp + 2 days + 1);
        _drainPoolTo(1_000 ether);

        vm.prank(carol);
        staking.kick(aliceId);
        uint256 afterFirst = staking.unsettledRewards(alice);
        uint256 totalUnsettledAfterFirst = staking.totalUnsettledRewards();

        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(TegridyStaking.NoOpKick.selector);
        vm.prank(carol);
        staking.kick(aliceId);

        assertEq(staking.unsettledRewards(alice), afterFirst, "no double credit");
        assertEq(staking.totalUnsettledRewards(), totalUnsettledAfterFirst, "totalUnsettled unchanged");
    }

    // ══════════════════════════════════════════════════════════════════
    // (3) TRACKED HOLDERS: the residual must ALSO be mirrored per-tokenId,
    //     or it is credited-but-unrecoverable.
    // ══════════════════════════════════════════════════════════════════

    /// @notice ADDED BY REVIEW 2026-08. The force-settle branch writes
    ///         `unsettledRewardsByTokenId[tokenId] += residual` only for TRACKED
    ///         holders (lending escrow / restaking contract). The three tests
    ///         above all use an EOA, so that line was never executed — and a
    ///         tracked holder CANNOT call `claimUnsettled()` (it reverts
    ///         `Unauthorized` by design), so without the per-tokenId mirror the
    ///         whole residual would be booked to the escrow's bucket with no way
    ///         to route it back to the borrower. Exactly the L1/C-1 stranding bug
    ///         that C1_L1_GetRewardShortfallAttribution.t.sol pins for
    ///         `_getReward`. This is its `kick` sibling.
    function test_kick_trackedHolder_residualMirroredPerTokenId_andRecoverable() public {
        KDoSTrackedHolder mock = new KDoSTrackedHolder(staking);
        admin.proposeLendingContract(address(mock), true);
        vm.warp(block.timestamp + 48 hours + 1);
        admin.executeLendingContract();
        assertTrue(staking.isLendingContract(address(mock)), "mock must be a tracked holder");

        _fund(50_000_000 ether);

        uint256 aliceId = _stake(alice, 5_000_000 ether, 30 days);
        _stake(bob, 50_000 ether, 365 days);

        // Escrow the position into the tracked holder (24h transfer cooldown).
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(alice);
        staking.transferFrom(alice, address(mock), aliceId);
        assertEq(staking.ownerOf(aliceId), address(mock), "mock owns the position");
        // ISOLATION: the inbound leg settles to ALICE (an EOA `from`), so it
        // cannot write the per-tokenId mapping. Any credit below is the kick's.
        assertEq(staking.unsettledRewardsByTokenId(aliceId), 0, "ISOLATION: clean per-tokenId baseline");

        vm.warp(block.timestamp + 20 days);
        _fund(1_000 ether);                 // bake accrual at a healthy pool
        vm.warp(block.timestamp + 10 days); // past the 30d lockEnd
        _drainPoolTo(1_000 ether);

        uint256 pending = monitor.earned(aliceId);
        uint256 cap = staking.maxUnsettledRewards();
        assertGt(pending - _rewardPool(), cap, "residual branch must actually be reached");

        uint256 perTokenBefore = staking.unsettledRewardsByTokenId(aliceId);
        uint256 bucketBefore = staking.unsettledRewards(address(mock));

        vm.prank(carol); // permissionless kicker
        staking.kick(aliceId);

        uint256 bucketCredit = staking.unsettledRewards(address(mock)) - bucketBefore;
        uint256 perTokenCredit = staking.unsettledRewardsByTokenId(aliceId) - perTokenBefore;
        assertApproxEqAbs(bucketCredit, pending, 1, "FULL pending credited to the escrow bucket");
        assertEq(perTokenCredit, bucketCredit, "per-tokenId mirror written in LOCKSTEP with the bucket");

        // A tracked holder must NOT be able to use the plain claim path...
        vm.prank(address(mock));
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.claimUnsettled();

        // ...so the per-tokenId mirror is the ONLY recovery route. Prove it pays.
        _fund(50_000_000 ether); // operator backfills
        uint256 payeeBefore = token.balanceOf(payee);
        uint256 paid = mock.callClaimUnsettledForTokenId(aliceId, payee);
        assertEq(paid, perTokenCredit, "escrow recovers the FULL residual per-tokenId");
        assertEq(token.balanceOf(payee) - payeeBefore, perTokenCredit, "residual lands at the borrower");
        assertEq(staking.unsettledRewardsByTokenId(aliceId), 0, "per-tokenId mapping drained");
    }
}
