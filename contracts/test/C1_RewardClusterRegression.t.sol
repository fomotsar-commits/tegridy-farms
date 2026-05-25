// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";

/*//////////////////////////////////////////////////////////////////////////
                                  PURPOSE
//////////////////////////////////////////////////////////////////////////

  REGRESSION TEST NET for TegridyStaking's reward-accounting cluster:
      _accumulateRewards / _getReward / kick / _settleRewardsOnTransfer /
      _settleUnsettled / claimUnsettled / claimUnsettledFor /
      claimUnsettledForTokenId / _claimUnsettledInternal.

  These tests are the SAFETY SCAFFOLD for an upcoming refactor that moves the
  reward cluster into a delegatecall library. They PIN CURRENT BEHAVIOUR with
  exact / near-exact (±1-2 wei for ACC_PRECISION rounding) assertions so that
  ANY behavioural drift during extraction fails the suite.

  This file deliberately AVOIDS ground already covered:
    * R018_Staking.t.sol            — EOA _getReward under-funded shortfall
                                       (rewardDebt advances only by paid+queued,
                                       cap reversibility, totalUnsettled==sum).
    * C1_L1_GetRewardShortfallAttribution.t.sol — TRACKED-holder _getReward
                                       per-tokenId shortfall attribution.
    * Audit195_StakingRewards.t.sol — rewardDebt-on-stake/claim/transfer exact,
                                       partial-payout-leaves-remainder,
                                       pool-depletion caps, claim symmetry.
    * Deep_Staking_2026_05_01.t.sol — kick settles-to-unsettled (loose), kick
                                       no-op / phantom / paused reverts.
    * RedTeam_Staking.t.sol         — adversarial drain / theft attempts.

  What this file ADDS (the gaps), with TIGHT assertions:
    1. ACCRUAL  — exact rewardPerTokenStored delta + earned() formula match;
                  getReward pays EXACTLY earned (fully funded); two-staker
                  pro-rata split exact to ±1 wei.
    2. getReward fully-funded vs under-funded (EOA): exact full pay + debt
                  advance + no unsettled; under-funded partial pay + remainder
                  to unsettledRewards[user]; RewardsForfeited only when the
                  unsettled cap clips; top-up + claimUnsettled recovers exactly.
    3. kick()   — funded kick credits the EXACT pre-expiry pending, decays
                  boostedAmount, decrements totalBoostedStake EXACTLY;
                  under-funded forfeiting kick reverts KickWouldForfeit
                  (all-or-nothing).
    4. _settleRewardsOnTransfer — settles EXACT pending to `from`, advances new
                  owner's rewardDebt to accumulated; under-funded books shortfall
                  to unsettledRewards[from]; AlreadyHasPosition / cooldown /
                  rate-limit guards behave as today.
    5. claimUnsettled / For / Internal — partial retains remainder (no zeroing);
                  claimUnsettledFor reverts for tracked holder; owner-gated by
                  90-day USER_INACTIVITY_GATE; user can always self-claim.
    6. CONSERVATION (load-bearing) — mixed sequence; token & principal
                  conservation invariants that the extraction MUST preserve.
*/

contract C1RCMockToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 5_000_000_000 ether);
    }
}

contract C1RCMockNFT is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}

/// @notice Minimal stand-in for a TRACKED holder (lending escrow / restaking
///         contract). Holds a staking NFT, is flagged via applyLendingContract,
///         and forwards calls so `msg.sender == address(this)`.
contract C1RCTrackedHolder {
    TegridyStaking public immutable staking;
    constructor(TegridyStaking _staking) { staking = _staking; }
    function callClaimUnsettledForTokenId(uint256 tokenId, address recipient)
        external returns (uint256)
    { return staking.claimUnsettledForTokenId(tokenId, recipient); }
    function onERC721Received(address, address, uint256, bytes calldata)
        external pure returns (bytes4)
    { return this.onERC721Received.selector; }
}

contract C1RewardClusterRegressionTest is Test {
    TegridyStaking public staking;
    TegridyStakingAdmin public admin;
    C1RCMockToken public token;
    C1RCMockNFT public nft;

    address public treasury = makeAddr("c1rc_treasury");
    address public alice    = makeAddr("c1rc_alice");
    address public bob      = makeAddr("c1rc_bob");
    address public carol    = makeAddr("c1rc_carol");
    address public dave     = makeAddr("c1rc_dave");
    address public payee    = makeAddr("c1rc_payee");

    // Mirror of TegridyStaking's private ACC_PRECISION (1e18, per the
    // BATCH-N1 M1 bump). Used to recompute the accrual math independently.
    uint256 internal constant ACC = 1e18;
    uint256 internal constant BOOST_PRECISION = 10000;
    uint256 internal constant RATE = 1 ether; // 1 TOWELI / second
    uint256 internal constant MIN_LOCK = 7 days;

    function setUp() public {
        token = new C1RCMockToken();
        nft = new C1RCMockNFT();
        staking = new TegridyStaking(address(token), address(nft), treasury, RATE);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        token.transfer(alice, 500_000_000 ether);
        token.transfer(bob,   500_000_000 ether);
        token.transfer(carol, 500_000_000 ether);
        token.transfer(dave,  500_000_000 ether);

        vm.prank(alice); token.approve(address(staking), type(uint256).max);
        vm.prank(bob);   token.approve(address(staking), type(uint256).max);
        vm.prank(carol); token.approve(address(staking), type(uint256).max);
        vm.prank(dave);  token.approve(address(staking), type(uint256).max);
        token.approve(address(staking), type(uint256).max);

        // Start at a non-zero, round timestamp so cooldown/rate-limit math is clean.
        vm.warp(1_000_000);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _stake(address u, uint256 amt, uint256 lock) internal returns (uint256 id) {
        vm.prank(u);
        staking.stake(amt, lock);
        id = staking.userTokenId(u);
    }

    /// @dev Read the load-bearing position fields. Position struct order:
    ///      amount, boostedAmount, rewardDebt, lockEnd, boostBps, lockDuration,
    ///      autoMaxLock, hasJbacBoost, stakeTimestamp, jbacTokenId, jbacDeposited.
    function _pos(uint256 tokenId)
        internal view returns (uint256 amount, uint256 boostedAmount, int256 rewardDebt)
    {
        (amount, boostedAmount, rewardDebt, , , , , , , , ) = staking.positions(tokenId);
    }

    /// @dev The free reward pool = balance - totalStaked - totalUnsettledRewards
    ///      (mirrors TegridyStaking._reserved()).
    function _rewardPool() internal view returns (uint256) {
        uint256 bal = token.balanceOf(address(staking));
        uint256 reserved = staking.totalStaked() + staking.totalUnsettledRewards();
        return bal > reserved ? bal - reserved : 0;
    }

    /// @dev Drain the free reward pool down to `leavePool` by moving tokens OUT
    ///      of the staking contract (models a pool depleted by prior payouts).
    ///      Draining balance is the clean lever: a stake adds to BOTH balance
    ///      and totalStaked, so principal cannot shrink the pool.
    function _drainPoolTo(uint256 leavePool) internal {
        uint256 pool = _rewardPool();
        require(pool >= leavePool, "drain: pool already below target");
        uint256 drain = pool - leavePool;
        if (drain == 0) return;
        vm.prank(address(staking));
        token.transfer(address(0xDEAD), drain);
        // Record the artificial outflow so the conservation value identity stays
        // exact (these tokens really left the contract; they are neither a reward
        // payout nor a principal withdrawal).
        _artificialDrain += drain;
        assertApproxEqAbs(_rewardPool(), leavePool, 0, "drain: pool not at target");
    }

    /// @dev Running tally of tokens drained OUT of the staking contract by the
    ///      test harness to simulate an under-funded pool. Only consumed by the
    ///      conservation value identity.
    uint256 internal _artificialDrain;

    /// @dev Fund the reward pool with `amt` (>= MIN_NOTIFY_AMOUNT). Carries the
    ///      updateReward modifier, so it ALSO bakes elapsed accrual into
    ///      rewardPerTokenStored at the pool level present BEFORE this call.
    function _fund(uint256 amt) internal {
        staking.notifyRewardAmount(amt);
    }

    /// @dev Raise the L-06 unsettled cap via the 48h-timelocked admin path so a
    ///      large shortfall books in FULL (the default 100_000e18 cap would clip
    ///      it and confound the exact-credit assertions). Same idiom as
    ///      C1_L1_GetRewardShortfallAttribution / R018 shortfall tests.
    function _raiseUnsettledCap(uint256 newCap) internal {
        admin.proposeMaxUnsettledRewards(newCap);
        vm.warp(block.timestamp + 48 hours + 1);
        admin.executeMaxUnsettledRewards();
        assertEq(staking.maxUnsettledRewards(), newCap, "unsettled cap raised");
    }

    /// @dev The claim-specific reward pool for `user`: balance - totalStaked -
    ///      OTHER users' unsettled (the claiming user's own unsettled is NOT
    ///      reserved against their own claim). Mirrors _claimUnsettledInternal.
    function _claimPoolFor(address user) internal view returns (uint256) {
        uint256 amount = staking.unsettledRewards(user);
        uint256 total = staking.totalUnsettledRewards();
        uint256 otherUnsettled = total > amount ? total - amount : 0;
        uint256 otherReserved = staking.totalStaked() + otherUnsettled;
        uint256 bal = token.balanceOf(address(staking));
        return bal > otherReserved ? bal - otherReserved : 0;
    }

    // ════════════════════════════════════════════════════════════════════
    // 1. ACCRUAL — exact rewardPerTokenStored, exact earned(), exact pay,
    //              exact two-staker pro-rata split.
    // ════════════════════════════════════════════════════════════════════

    /// @notice Single staker: rewardPerTokenStored advances by EXACTLY
    ///         reward*ACC/totalBoostedStake, earned() matches the closed-form,
    ///         and a fully-funded getReward pays EXACTLY earned.
    function test_accrual_singleStaker_rptAndEarnedAndPayExact() public {
        _fund(10_000_000 ether); // healthy pool, fully funds all accrual below

        uint256 id = _stake(bob, 1_000_000 ether, 365 days);
        (, uint256 boosted, ) = _pos(id);
        assertGt(boosted, 0, "boosted must be non-zero");
        assertEq(staking.totalBoostedStake(), boosted, "sole staker => totalBoosted == boosted");

        uint256 rptBefore = staking.rewardPerTokenStored();
        uint256 dt = 1234; // seconds
        vm.warp(block.timestamp + dt);

        // earned() recomputed independently from the closed-form (fully funded
        // means the view's uncapped dt*rate equals what would actually accrue).
        uint256 expectedAccDelta = (dt * RATE * ACC) / staking.totalBoostedStake();
        uint256 expectedEarned = (boosted * (rptBefore + expectedAccDelta)) / ACC
            - uint256(_debt(id));
        assertEq(staking.earned(id), expectedEarned, "earned() must match closed-form exactly");

        // Trigger accrual via a no-stake notify (updateReward modifier) so we can
        // read the materialised rewardPerTokenStored AFTER accrual.
        _fund(1_000 ether); // MIN_NOTIFY_AMOUNT; bakes the dt accrual in
        uint256 rptAfter = staking.rewardPerTokenStored();
        assertEq(rptAfter - rptBefore, expectedAccDelta,
            "rewardPerTokenStored advanced by EXACTLY reward*ACC/totalBoosted");

        // Fully-funded getReward pays EXACTLY earned at this instant (no extra dt).
        uint256 pendingNow = staking.earned(id);
        uint256 balBefore = token.balanceOf(bob);
        vm.prank(bob);
        uint256 paid = staking.getReward(id);
        assertEq(paid, pendingNow, "getReward return must equal earned (fully funded)");
        assertEq(token.balanceOf(bob) - balBefore, pendingNow,
            "getReward must transfer EXACTLY earned (fully funded)");

        // No shortfall booked, debt advanced to accumulated.
        assertEq(staking.unsettledRewards(bob), 0, "fully funded => no unsettled");
        (, uint256 boostedAfter, int256 debtAfter) = _pos(id);
        assertEq(debtAfter, int256((boostedAfter * staking.rewardPerTokenStored()) / ACC),
            "rewardDebt advanced to boosted*rpt/ACC");
        assertEq(staking.earned(id), 0, "earned == 0 immediately after full claim");
    }

    /// @notice Two stakers with DIFFERENT boosts split emission pro-rata by
    ///         boostedAmount, exact to ±1 wei (ACC_PRECISION integer rounding).
    function test_accrual_twoStakers_proRataSplitExact() public {
        _fund(50_000_000 ether); // generously funded so nothing caps

        // Bob: 1yr lock. Carol: 4yr lock (max boost). Different boostedAmounts.
        uint256 bobId   = _stake(bob,   1_000_000 ether, 365 days);
        uint256 carolId = _stake(carol, 1_000_000 ether, 4 * 365 days);

        (, uint256 bBoost, ) = _pos(bobId);
        (, uint256 cBoost, ) = _pos(carolId);
        assertTrue(cBoost > bBoost, "carol's longer lock => larger boostedAmount");

        uint256 total = staking.totalBoostedStake();
        assertEq(total, bBoost + cBoost, "totalBoosted == sum of both");

        uint256 dt = 100_000;
        vm.warp(block.timestamp + dt);

        uint256 emitted = dt * RATE; // total emission over the window (fully funded)
        // Pro-rata expectation by boosted share (same integer path the contract uses:
        // accDelta = emitted*ACC/total; earned_i = boosted_i*accDelta/ACC).
        uint256 accDelta = (emitted * ACC) / total;
        uint256 expBob   = (bBoost * accDelta) / ACC;
        uint256 expCarol = (cBoost * accDelta) / ACC;

        assertApproxEqAbs(staking.earned(bobId),   expBob,   1, "bob pro-rata share exact");
        assertApproxEqAbs(staking.earned(carolId), expCarol, 1, "carol pro-rata share exact");

        // The two shares together equal the MATERIALISED accrual exactly
        // (total*accDelta/ACC). This is <= the ideal `emitted` by the ACC integer
        // truncation; comparing against the materialised value is the tight,
        // extraction-sensitive invariant (no value created or lost in the split).
        uint256 materialised = (total * accDelta) / ACC;
        assertApproxEqAbs(
            staking.earned(bobId) + staking.earned(carolId), materialised, 1,
            "shares sum to the materialised accrual within 1 wei"
        );
        // And the materialised accrual is never MORE than the ideal emission.
        assertLe(materialised, emitted, "materialised accrual <= ideal emission");

        // And the actual payouts mirror the view exactly.
        uint256 bBefore = token.balanceOf(bob);
        vm.prank(bob);   uint256 paidBob = staking.getReward(bobId);
        uint256 cBefore = token.balanceOf(carol);
        vm.prank(carol); uint256 paidCarol = staking.getReward(carolId);

        assertApproxEqAbs(paidBob,   expBob,   1, "bob payout == pro-rata share");
        assertApproxEqAbs(paidCarol, expCarol, 1, "carol payout == pro-rata share");
        assertEq(token.balanceOf(bob)   - bBefore, paidBob,   "bob received exactly paid");
        assertEq(token.balanceOf(carol) - cBefore, paidCarol, "carol received exactly paid");
    }

    /// @notice _accumulateRewards is a strict integral of the rate it sees: two
    ///         separate accrual windows sum to the single-window accrual over
    ///         the same total time (no double counting, no gaps). Pins the
    ///         linearity an extraction must preserve.
    function test_accrual_isLinearAcrossWindows() public {
        _fund(50_000_000 ether);
        _stake(bob, 1_000_000 ether, 365 days);
        uint256 total = staking.totalBoostedStake();

        uint256 rpt0 = staking.rewardPerTokenStored();

        // Window A: 600s, materialise.
        vm.warp(block.timestamp + 600);
        _fund(1_000 ether);
        uint256 rptA = staking.rewardPerTokenStored();

        // Window B: 400s, materialise.
        vm.warp(block.timestamp + 400);
        _fund(1_000 ether);
        uint256 rptB = staking.rewardPerTokenStored();

        // Sum of the two deltas must equal the closed-form over 1000s exactly.
        uint256 expectedTotalDelta = (1000 * RATE * ACC) / total;
        assertEq(rptB - rpt0, expectedTotalDelta, "two-window accrual == one-window accrual");
        // Sanity: each leg is non-trivial.
        assertGt(rptA - rpt0, 0, "window A accrued");
        assertGt(rptB - rptA, 0, "window B accrued");

    }

    // ════════════════════════════════════════════════════════════════════
    // 2. getReward FULLY-FUNDED vs UNDER-FUNDED (EOA)
    // ════════════════════════════════════════════════════════════════════

    /// @notice Fully funded: getReward pays the EXACT full pending, advances
    ///         rewardDebt to accumulated, books ZERO unsettled, emits no
    ///         RewardsForfeited.
    function test_getReward_fullyFunded_paysExact_noUnsettled() public {
        _fund(50_000_000 ether);
        uint256 id = _stake(bob, 1_000_000 ether, 365 days);

        vm.warp(block.timestamp + 5000);
        uint256 pending = staking.earned(id);
        assertGt(pending, 0, "must have pending");

        // Pool comfortably exceeds pending.
        assertGt(_rewardPool(), pending, "pool must exceed pending for the funded path");

        uint256 balBefore = token.balanceOf(bob);
        vm.prank(bob);
        uint256 paid = staking.getReward(id);

        assertEq(paid, pending, "funded: paid == full pending");
        assertEq(token.balanceOf(bob) - balBefore, pending, "funded: transferred == full pending");
        assertEq(staking.unsettledRewards(bob), 0, "funded: zero unsettled booked");
        (, uint256 boostedAfter, int256 debtAfter) = _pos(id);
        assertEq(debtAfter, int256((boostedAfter * staking.rewardPerTokenStored()) / ACC),
            "funded: rewardDebt advanced to accumulated");
    }

    /// @notice Under-funded (EOA): getReward pays only the pool, books the
    ///         shortfall to unsettledRewards[user] (NOT per-tokenId for an EOA),
    ///         and does NOT emit RewardsForfeited because the unsettled cap has
    ///         room. Then a top-up + claimUnsettled recovers EXACTLY the
    ///         shortfall. (Distinct from R018: this pins the exact split
    ///         paid==pool and recovered==booked to the wei, and the no-forfeit
    ///         + no-per-tokenId-for-EOA facts.)
    function test_getReward_underFunded_EOA_booksShortfall_recoversExact() public {
        _fund(50_000_000 ether);
        uint256 id = _stake(bob, 1_000_000 ether, 365 days);

        // Accrue a large pending while the pool is healthy.
        vm.warp(block.timestamp + 50_000); // ~50_000 ether pending (sole staker)
        // Bake the elapsed emission into rewardPerTokenStored at the HEALTHY pool
        // so it is locked in before we drain (otherwise _accumulateRewards, which
        // itself caps to the pool, would never accrue it and there'd be no shortfall).
        _fund(1_000 ether);
        uint256 pending = staking.earned(id);
        assertGt(pending, 1_000 ether, "pending must dwarf the leftover pool");

        // Leave only a thin pool so the pay is partial but non-zero.
        uint256 leavePool = 1_000 ether;
        _drainPoolTo(leavePool);
        uint256 poolNow = _rewardPool();
        assertEq(poolNow, leavePool, "pool drained to thin sliver");
        assertLt(poolNow, pending, "pool < pending => shortfall path");

        (, , int256 debtBefore) = _pos(id);
        uint256 balBefore = token.balanceOf(bob);

        // No forfeiture expected (cap has ample room) — assert RewardsForfeited
        // does NOT fire by recording logs and scanning.
        vm.recordLogs();
        vm.prank(bob);
        uint256 paid = staking.getReward(id);
        _assertNoRewardsForfeited();

        // Paid EXACTLY the available pool (the shortfall branch caps to rewardPool).
        assertEq(paid, poolNow, "under-funded: paid == available pool exactly");
        assertEq(token.balanceOf(bob) - balBefore, poolNow, "transferred == pool exactly");

        // Shortfall booked to the per-USER bucket, NOT per-tokenId (EOA).
        uint256 booked = staking.unsettledRewards(bob);
        assertEq(booked, pending - poolNow, "shortfall booked to unsettledRewards[user] exactly");
        assertEq(staking.unsettledRewardsByTokenId(id), 0,
            "EOA: NO per-tokenId attribution (tracked-holder-scoped only)");

        // rewardDebt advanced by EXACTLY paid + booked (R018 invariant, pinned tight here).
        (, , int256 debtAfter) = _pos(id);
        assertApproxEqAbs(debtAfter - debtBefore, int256(paid + booked), 1,
            "rewardDebt advanced only by paid + booked");

        // Recover: top up, claimUnsettled pays EXACTLY the booked shortfall.
        _fund(50_000_000 ether);
        uint256 balBefore2 = token.balanceOf(bob);
        vm.prank(bob);
        staking.claimUnsettled();
        assertEq(token.balanceOf(bob) - balBefore2, booked, "claimUnsettled recovers EXACT shortfall");
        assertEq(staking.unsettledRewards(bob), 0, "unsettled fully drained after recovery");
    }

    /// @notice Under-funded AND the unsettled cap clips: getReward emits
    ///         RewardsForfeited for exactly the un-bookable slice, and
    ///         totalUnsettledRewards stops at the cap. Pins the cap-clip
    ///         forfeit semantic (the only condition under which getReward
    ///         forfeits).
    function test_getReward_underFunded_capClips_emitsRewardsForfeited() public {
        _fund(50_000_000 ether);
        uint256 id = _stake(bob, 5_000_000 ether, 4 * 365 days); // big boosted -> big pending

        // Drive the unsettled cap (default 100_000e18) close to full first, using
        // a SEPARATE staker (dave) transferring under-funded so his shortfall
        // lands in unsettledRewards[dave] and consumes the global cap.
        // Simplest: accrue a huge pending for bob, drain pool, then claim — the
        // shortfall (well over the 100k cap) can only partly book; the rest
        // forfeits.
        vm.warp(block.timestamp + 200_000); // ~ huge pending given 5M @ 4x boost
        _fund(1_000 ether); // bake accrual at healthy pool
        uint256 pending = staking.earned(id);

        // Cap is 100_000e18; ensure pending - pool > cap so a forfeit is forced.
        uint256 cap = staking.maxUnsettledRewards();
        assertEq(cap, 100_000 ether, "default cap assumption");
        _drainPoolTo(1_000 ether);
        uint256 poolNow = _rewardPool();
        uint256 shortfall = pending - poolNow;
        assertGt(shortfall, cap, "shortfall must exceed the unsettled cap to force a forfeit");

        uint256 totalUnsettledBefore = staking.totalUnsettledRewards();
        uint256 room = cap - totalUnsettledBefore; // bookable amount
        uint256 expectedForfeit = shortfall - room;

        // RewardsForfeited(bob, expectedForfeit) must fire (topic-matched; we
        // assert the data amount explicitly).
        vm.expectEmit(true, false, false, true, address(staking));
        emit TegridyStaking.RewardsForfeited(bob, expectedForfeit);
        vm.prank(bob);
        uint256 paid = staking.getReward(id);

        assertEq(paid, poolNow, "paid == pool");
        // Booked is capped to room; total unsettled now sits AT the cap.
        assertEq(staking.unsettledRewards(bob), room, "booked == cap room exactly");
        assertEq(staking.totalUnsettledRewards(), cap, "totalUnsettled clamped at cap");
    }

    // ════════════════════════════════════════════════════════════════════
    // 3. kick()
    // ════════════════════════════════════════════════════════════════════

    /// @notice Funded kick on an EXPIRED position (permissionless): pre-expiry
    ///         rewards settle to unsettledRewards[holder] EXACTLY, boostedAmount
    ///         decays to 0, and totalBoostedStake decrements by EXACTLY the
    ///         decayed boost. (Deep_Staking pins the settle loosely; this pins
    ///         the exact credit + the exact totalBoostedStake decrement.)
    function test_kick_funded_creditsExact_decaysBoost_decrementsTotalExact() public {
        // Raise the unsettled cap so alice's full pre-expiry pending books (the
        // default 100k cap would clip a multi-day accrual and force the
        // all-or-nothing KickWouldForfeit revert — covered separately below).
        _raiseUnsettledCap(10_000_000 ether);
        _fund(50_000_000 ether);

        // alice expires soon; bob keeps totalBoostedStake non-zero post-decay.
        uint256 aliceId = _stake(alice, 50_000 ether, 7 days);
        uint256 bobId   = _stake(bob,   50_000 ether, 365 days);

        (, uint256 aliceBoost, ) = _pos(aliceId);
        (, uint256 bobBoost, )   = _pos(bobId);
        uint256 totalBefore = staking.totalBoostedStake();
        assertEq(totalBefore, aliceBoost + bobBoost, "total == sum pre-kick");

        // Warp past alice's lockEnd (7d). The contract accrues to expired
        // positions until decay (AUDIT M-01), so alice keeps earning until the
        // kick decays her boost.
        vm.warp(block.timestamp + 7 days + 1); // alice expired

        // kick() computes owed as: _accumulateRewards() (bumps rpt, pool-capped),
        // then diff = boosted*rpt/ACC - rewardDebt. With a healthy pool that
        // equals earned() captured at THIS block (earned()'s inline accrual term
        // matches the pool-capped _accumulateRewards exactly when funded).
        uint256 owedAtKick = staking.earned(aliceId); // same block as the kick below
        assertGt(owedAtKick, 0, "alice has pre-expiry pending");
        assertLt(owedAtKick, staking.maxUnsettledRewards(), "owed fits under the raised cap");

        uint256 unsettledBefore = staking.unsettledRewards(alice);
        vm.prank(carol); // permissionless kicker
        staking.kick(aliceId);
        uint256 credited = staking.unsettledRewards(alice) - unsettledBefore;

        // Exact credit: kick routes the full pre-expiry pending to unsettled
        // (pool is healthy, cap has room) — within 1 wei of earned() captured at
        // the same block. (earned() and kick() share the closed-form;
        // _accumulateRewards in kick advances rpt identically to earned()'s
        // inline term since they're in the same block.)
        assertApproxEqAbs(credited, owedAtKick, 1, "kick credits EXACT pre-expiry pending");

        // boostedAmount decayed to 0; totalBoostedStake decremented by EXACTLY
        // alice's decayed boost (bob's remains).
        (, uint256 aliceBoostAfter, ) = _pos(aliceId);
        assertEq(aliceBoostAfter, 0, "boostedAmount decayed to 0");
        assertEq(staking.totalBoostedStake(), totalBefore - aliceBoost,
            "totalBoostedStake decremented by EXACTLY the decayed boost");
        assertEq(staking.totalBoostedStake(), bobBoost, "only bob's boost remains");

        // Holder can reclaim the credited amount exactly.
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        staking.claimUnsettled();
        assertEq(token.balanceOf(alice) - aliceBefore, credited, "alice reclaims EXACT credit");
    }

    /// @notice All-or-nothing forfeit guard: when a kick would forfeit ANY
    ///         portion of pending (pool shortfall + unsettled cap collectively
    ///         block full credit), kick reverts KickWouldForfeit and leaves the
    ///         position's boost intact (anti-dilution weakens, value preserved).
    function test_kick_underFunded_revertsKickWouldForfeit_boostIntact() public {
        _fund(50_000_000 ether);

        // alice big position so pending dwarfs both the pool sliver AND the cap.
        uint256 aliceId = _stake(alice, 5_000_000 ether, 7 days);
        _stake(bob, 50_000 ether, 365 days); // keeps totalBoostedStake non-zero post-decay

        vm.warp(block.timestamp + 5 days);
        _fund(1_000 ether); // bake accrual at healthy pool
        vm.warp(block.timestamp + 2 days + 1); // expire alice

        uint256 pending = staking.earned(aliceId);
        uint256 cap = staking.maxUnsettledRewards();
        // Drain pool to a sliver; ensure pending - pool > cap so even the cap
        // can't absorb the shortfall => a forfeit WOULD occur => revert.
        _drainPoolTo(1_000 ether);
        uint256 poolNow = _rewardPool();
        assertGt(pending - poolNow, cap, "shortfall must exceed cap to force forfeit");

        // Snapshot boost + total to prove they are untouched after the revert.
        (, uint256 aliceBoostBefore, ) = _pos(aliceId);
        uint256 totalBefore = staking.totalBoostedStake();

        vm.expectRevert(TegridyStaking.KickWouldForfeit.selector);
        vm.prank(carol);
        staking.kick(aliceId);

        // State unchanged by the reverted kick.
        (, uint256 aliceBoostAfter, ) = _pos(aliceId);
        assertEq(aliceBoostAfter, aliceBoostBefore, "boost intact after KickWouldForfeit");
        assertEq(staking.totalBoostedStake(), totalBefore, "totalBoosted intact after revert");
    }

    // ════════════════════════════════════════════════════════════════════
    // 4. _settleRewardsOnTransfer (via transferFrom)
    // ════════════════════════════════════════════════════════════════════

    /// @notice Transfer (after cooldown) settles EXACT pending to `from` and
    ///         advances the NEW owner's rewardDebt to accumulated; subsequent
    ///         accrual is owed to the new owner only. (Audit195 pins the new
    ///         owner's debt; this ALSO pins from's settled amount exactly and
    ///         the clean hand-off boundary.)
    function test_settleOnTransfer_settlesExactToFrom_resetsNewOwnerDebt() public {
        _fund(50_000_000 ether);
        uint256 id = _stake(alice, 1_000_000 ether, 365 days);

        // Wait out the 24h cooldown (+ accrue rewards during the wait).
        vm.warp(block.timestamp + 24 hours + 500);

        // Owed to alice at the transfer block (same block, no extra warp).
        uint256 owedAlice = staking.earned(id);
        assertGt(owedAlice, 0, "alice accrued pending before transfer");

        // Pool healthy => the settle pays out via the unsettled mapping in full.
        uint256 aliceUnsettledBefore = staking.unsettledRewards(alice);
        vm.prank(alice);
        staking.transferFrom(alice, bob, id);

        // from (alice) settled EXACTLY her pending into her unsettled bucket
        // (transfer path books to unsettled, not a direct wallet transfer).
        uint256 settled = staking.unsettledRewards(alice) - aliceUnsettledBefore;
        assertApproxEqAbs(settled, owedAlice, 1, "transfer settled EXACT pending to `from`");

        // New owner (bob) rewardDebt reset to accumulated => earned(bob)==0 now.
        (, uint256 boosted, int256 debt) = _pos(id);
        assertEq(debt, int256((boosted * staking.rewardPerTokenStored()) / ACC),
            "new owner rewardDebt == boosted*rpt/ACC");
        assertEq(staking.earned(id), 0, "new owner starts at zero pending");

        // Clean hand-off: after more time, ALL new accrual is bob's; alice's
        // claimable (her settled bucket) is unchanged by bob's accrual.
        uint256 aliceBucket = staking.unsettledRewards(alice);
        vm.warp(block.timestamp + 1000);
        assertGt(staking.earned(id), 0, "bob accrues after transfer");
        assertEq(staking.unsettledRewards(alice), aliceBucket,
            "alice's settled bucket untouched by bob's post-transfer accrual");
    }

    /// @notice Under-funded transfer books the shortfall to
    ///         unsettledRewards[from] (recoverable), paying nothing out
    ///         directly. Pins the under-funded transfer-settle split.
    function test_settleOnTransfer_underFunded_booksShortfallToFrom() public {
        // Raise the cap so the full transfer shortfall books (default 100k would
        // clip the ~136k owed and the assertion targets the FULL booking).
        _raiseUnsettledCap(10_000_000 ether);
        _fund(50_000_000 ether);
        uint256 id = _stake(alice, 1_000_000 ether, 365 days);

        vm.warp(block.timestamp + 24 hours + 50_000); // cooldown cleared + accrual
        _fund(1_000 ether); // bake accrual at healthy pool
        uint256 owedAlice = staking.earned(id);
        assertGt(owedAlice, 1_000 ether, "owed dwarfs the leftover pool");

        // Thin pool => transfer settle can only partially cover; the rest books
        // to unsettled[alice] (the M-1 / F-02-K-02 routing).
        _drainPoolTo(1_000 ether);

        uint256 aliceUnsettledBefore = staking.unsettledRewards(alice);
        vm.prank(alice);
        staking.transferFrom(alice, bob, id);

        // Whole owed amount is booked to alice's unsettled (cap has room; pool
        // slice ALSO books to unsettled on this path — it is not wallet-paid).
        uint256 booked = staking.unsettledRewards(alice) - aliceUnsettledBefore;
        assertApproxEqAbs(booked, owedAlice, 1,
            "under-funded transfer books full owed to unsettledRewards[from]");

        // Recover after top-up.
        _fund(50_000_000 ether);
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        staking.claimUnsettled();
        assertApproxEqAbs(token.balanceOf(alice) - aliceBefore, booked, 1,
            "alice recovers the booked transfer shortfall");
    }

    /// @notice Transfer guards behave as today: AlreadyHasPosition (EOA already
    ///         staked), TransferCooldownActive (< 24h since stake),
    ///         TransferRateLimited (< 1h since last transfer).
    function test_settleOnTransfer_guards_cooldownRateLimitAlreadyHasPosition() public {
        _fund(50_000_000 ether);
        uint256 aliceId = _stake(alice, 1_000_000 ether, 365 days);

        // (a) Cooldown: transfer < 24h after stake reverts.
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(TegridyStaking.TransferCooldownActive.selector);
        staking.transferFrom(alice, bob, aliceId);

        // Clear cooldown; first transfer to bob succeeds.
        vm.warp(block.timestamp + 24 hours);
        vm.prank(alice);
        staking.transferFrom(alice, bob, aliceId);
        assertEq(staking.ownerOf(aliceId), bob, "transfer succeeded after cooldown");

        // (b) Rate limit: bob -> carol within 1h of the last transfer reverts.
        vm.warp(block.timestamp + 30 minutes);
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.TransferRateLimited.selector);
        staking.transferFrom(bob, carol, aliceId);

        // (c) AlreadyHasPosition: carol stakes her own, then bob (after the rate
        //     limit clears) tries to push his NFT onto carol -> revert.
        _stake(carol, 1_000_000 ether, 365 days); // carol now has userTokenId set
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.AlreadyHasPosition.selector);
        staking.transferFrom(bob, carol, aliceId);
    }

    // ════════════════════════════════════════════════════════════════════
    // 5. claimUnsettled / claimUnsettledFor / _claimUnsettledInternal
    // ════════════════════════════════════════════════════════════════════

    /// @notice Partial payout RETAINS the remainder (does not zero it), and the
    ///         exact remainder == booked - paid; global totalUnsettled decrements
    ///         in lockstep. (Audit195 pins remainder accounting loosely via a
    ///         transfer; this isolates a deterministic partial via a precise
    ///         pool drain and pins exact paid==pool.)
    function test_claimUnsettled_partialRetainsExactRemainder() public {
        _fund(50_000_000 ether);
        uint256 id = _stake(alice, 1_000_000 ether, 365 days);

        vm.warp(block.timestamp + 50_000);
        _fund(1_000 ether); // bake accrual
        uint256 pending = staking.earned(id);

        // Drain so getReward books a big shortfall to unsettled[alice].
        _drainPoolTo(0);
        vm.prank(alice);
        staking.getReward(id);
        uint256 booked = staking.unsettledRewards(alice);
        assertApproxEqAbs(booked, pending, 1, "shortfall booked");
        assertGt(booked, 2_000 ether, "booked must exceed the partial top-up below");

        // Top up only PART of the booked amount so claimUnsettled is partial.
        // The claim pool = balance - totalStaked - (otherUnsettled). With alice
        // the only unsettled holder, otherUnsettled == 0, so claim pool == the
        // free pool. Fund a controlled small amount above MIN_NOTIFY_AMOUNT.
        uint256 topUp = 2_000 ether; // < booked => partial
        _fund(topUp);
        // Alice is the only unsettled holder, so her claim pool == the funded
        // top-up (her own unsettled is NOT reserved against her own claim).
        assertEq(_claimPoolFor(alice), topUp, "claim pool == controlled top-up");

        uint256 globalBefore = staking.totalUnsettledRewards();
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        staking.claimUnsettled();
        uint256 received = token.balanceOf(alice) - aliceBefore;

        assertEq(received, topUp, "partial claim pays EXACTLY the available pool");
        assertEq(staking.unsettledRewards(alice), booked - received,
            "remainder RETAINED == booked - received (not zeroed)");
        assertEq(staking.totalUnsettledRewards(), globalBefore - received,
            "global totalUnsettled decremented in lockstep");
        assertGt(staking.unsettledRewards(alice), 0, "remainder is strictly positive");
    }

    /// @notice claimUnsettledFor: reverts Unauthorized for a TRACKED holder
    ///         (per-tokenId backing must only drain via claimUnsettledForTokenId);
    ///         a random caller cannot claim for a fresh (active) user; the user
    ///         themselves CAN always self-claim.
    function test_claimUnsettledFor_trackedHolderGuard_andSelfClaim() public {
        _fund(50_000_000 ether);

        // Whitelist a tracked-holder mock as a lending contract.
        C1RCTrackedHolder mock = new C1RCTrackedHolder(staking);
        admin.proposeLendingContract(address(mock), true);
        vm.warp(block.timestamp + 48 hours + 1);
        admin.executeLendingContract();
        assertTrue(staking.isLendingContract(address(mock)), "mock is tracked");

        // (a) claimUnsettledFor(trackedHolder) reverts Unauthorized for ANY caller
        //     (the tracked-holder guard fires before the role checks).
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.claimUnsettledFor(address(mock)); // called by owner (this test)

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.claimUnsettledFor(address(mock));

        // (b) Random caller cannot claim for an ACTIVE user (bob).
        //     Give bob a real unsettled balance via an under-funded getReward.
        uint256 bobId = _stake(bob, 1_000_000 ether, 365 days);
        vm.warp(block.timestamp + 50_000);
        _fund(1_000 ether);
        _drainPoolTo(0);
        vm.prank(bob);
        staking.getReward(bobId); // books shortfall to unsettled[bob], touches bob
        assertGt(staking.unsettledRewards(bob), 0, "bob has unsettled");

        vm.prank(carol);
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.claimUnsettledFor(bob); // carol is not owner/self/restaking

        // (c) The user themselves can always self-claim via claimUnsettledFor.
        _fund(50_000_000 ether);
        uint256 owed = staking.unsettledRewards(bob);
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob);
        staking.claimUnsettledFor(bob);
        assertEq(token.balanceOf(bob) - bobBefore, owed, "user self-claim pays full owed");
    }

    /// @notice Owner stale-fallback is gated by the 90-day USER_INACTIVITY_GATE:
    ///         owner claimUnsettledFor reverts while the user is active, then
    ///         succeeds once the user has been dormant for >= 90 days.
    function test_claimUnsettledFor_ownerGatedBy90DayInactivity() public {
        _fund(50_000_000 ether);

        // bob accrues an unsettled balance (under-funded getReward) — this also
        // _touch()es bob (sets lastActivityAt[bob] = now).
        uint256 bobId = _stake(bob, 1_000_000 ether, 365 days);
        vm.warp(block.timestamp + 50_000);
        _fund(1_000 ether);
        _drainPoolTo(0);
        vm.prank(bob);
        staking.getReward(bobId);
        uint256 owed = staking.unsettledRewards(bob);
        assertGt(owed, 0, "bob has unsettled to be force-claimed");

        // Re-fund so the eventual claim can actually pay out.
        _fund(50_000_000 ether);

        // Owner attempts the stale fallback too early -> Unauthorized (gate open).
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.claimUnsettledFor(bob); // msg.sender == owner == this test

        // Warp just past the 90-day gate since bob's last activity.
        vm.warp(staking.lastActivityAt(bob) + 90 days + 1);

        // Now the owner CAN claim on bob's behalf; funds go to BOB (not owner).
        uint256 bobBefore = token.balanceOf(bob);
        staking.claimUnsettledFor(bob);
        assertEq(token.balanceOf(bob) - bobBefore, owed, "owner stale-claim pays the USER");
        assertEq(staking.unsettledRewards(bob), 0, "bob's unsettled drained by owner stale-claim");
    }

    // ════════════════════════════════════════════════════════════════════
    // 6. CONSERVATION (the load-bearing invariant the extraction MUST preserve)
    // ════════════════════════════════════════════════════════════════════

    /// @notice Run a mixed sequence (multiple stakers, varying boosts, partial
    ///         funding, a kick, a transfer, several getReward/claim calls) and
    ///         assert at every checkpoint:
    ///
    ///         (A) TOKEN CONSERVATION (exact, wei-level): the staking token IS the
    ///             reward token, so balance is fully partitioned:
    ///                 balanceOf(staking) == totalStaked
    ///                                     + totalUnsettledRewards
    ///                                     + freeRewardPool
    ///             and the value identity:
    ///                 balanceOf(staking) == totalStaked
    ///                                     + totalRewardsFunded
    ///                                     - rewardTokensPaidOutToUsers
    ///             (forfeited slices are NOT sent anywhere — they stay in
    ///             freeRewardPool and re-accrue, so they need no separate term.)
    ///
    ///         (B) totalUnsettledRewards == sum unsettledRewards[user]  (global
    ///             counter never desyncs from the per-user mapping).
    ///
    ///         (C) PRINCIPAL is always fully recoverable:
    ///                 balanceOf(staking) >= totalStaked()  at all times, and
    ///                 sum withdrawn principal == sum staked principal  at the end.
    function test_conservation_mixedSequence_tokenAndPrincipalInvariants() public {
        // Track principal flows independently of rewards.
        uint256 totalStakedPrincipal;
        uint256 totalWithdrawnPrincipal;

        // Raise the unsettled cap so the under-funded leg books its shortfall in
        // FULL (keeps the totalUnsettled == sum(per-user) check meaningful and
        // avoids a forfeiture term; the value identity holds either way).
        _raiseUnsettledCap(10_000_000 ether);

        // ── Funding round 1.
        _fund(20_000_000 ether);
        _checkTokenConservation("after fund#1");

        // ── alice, bob, carol stake with DIFFERENT boosts.
        uint256 aliceId = _stake(alice, 2_000_000 ether, 7 days);       // low boost, expires soon
        uint256 bobId   = _stake(bob,   3_000_000 ether, 365 days);     // mid boost
        uint256 carolId = _stake(carol, 1_000_000 ether, 4 * 365 days); // max boost
        totalStakedPrincipal += 2_000_000 ether + 3_000_000 ether + 1_000_000 ether;
        _checkTokenConservation("after stakes");
        _checkPrincipalFloor();

        // ── Accrue; carol claims (funded) — pays reward tokens out.
        vm.warp(block.timestamp + 3 days);
        vm.prank(carol);
        uint256 paidCarol = staking.getReward(carolId);
        _rewardsPaidOut += paidCarol;
        _checkTokenConservation("after carol getReward (funded)");
        _checkUnsettledSum("after carol getReward");

        // ── Drain the pool to a sliver, then bob claims UNDER-FUNDED:
        //    partial pay out + shortfall booked to unsettled[bob].
        _fund(1_000 ether); // bake current accrual at healthy-ish pool first
        _drainPoolTo(500 ether);
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob);
        uint256 paidBob = staking.getReward(bobId);
        _rewardsPaidOut += paidBob;
        assertEq(token.balanceOf(bob) - bobBefore, paidBob, "bob received exactly paid");
        _checkTokenConservation("after bob getReward (under-funded)");
        _checkUnsettledSum("after bob getReward");

        // ── Re-fund, expire alice, KICK her (funded) — credits unsettled[alice],
        //    decays her boost.
        _fund(20_000_000 ether);
        vm.warp(block.timestamp + 5 days); // alice (7d lock) now expired
        uint256 totalBoostBefore = staking.totalBoostedStake();
        (, uint256 aliceBoost, ) = _pos(aliceId);
        vm.prank(dave); // permissionless
        staking.kick(aliceId);
        assertEq(staking.totalBoostedStake(), totalBoostBefore - aliceBoost,
            "kick decremented totalBoosted by alice's boost exactly");
        _checkTokenConservation("after kick(alice)");
        _checkUnsettledSum("after kick(alice)");

        // ── TRANSFER bob's position to dave (cooldown long cleared) — settles
        //    bob's pending to unsettled[bob], resets dave's debt.
        vm.warp(block.timestamp + 1 hours + 1); // clear any rate-limit window
        vm.prank(bob);
        staking.transferFrom(bob, dave, bobId);
        _checkTokenConservation("after transfer bob->dave");
        _checkUnsettledSum("after transfer");

        // ── Everyone claims their unsettled (pool is healthy now).
        _drainToHealthy();
        _claimUnsettledIfAny(alice);
        _claimUnsettledIfAny(bob);
        _claimUnsettledIfAny(carol);
        _claimUnsettledIfAny(dave);
        _checkTokenConservation("after all claimUnsettled");
        _checkUnsettledSum("after all claimUnsettled");

        // ── PRINCIPAL RECOVERY: withdraw every live position after locks expire.
        //    alice was kicked (boost 0) but principal remains fully withdrawable.
        vm.warp(block.timestamp + 4 * 365 days + 1); // all locks surely expired

        // alice still owns her (decayed) position.
        totalWithdrawnPrincipal += _withdrawAndMeasurePrincipal(alice, aliceId);
        // dave owns bob's old position now.
        totalWithdrawnPrincipal += _withdrawAndMeasurePrincipal(dave, bobId);
        // carol owns hers.
        totalWithdrawnPrincipal += _withdrawAndMeasurePrincipal(carol, carolId);

        _checkTokenConservation("after all withdrawals");
        _checkUnsettledSum("after all withdrawals");

        // FINAL PRINCIPAL INVARIANT (load-bearing): every staked principal token
        // came back out, to the wei. An extraction bug that mis-credits rewards
        // could only break this if it corrupted principal accounting — which it
        // must never do.
        assertEq(totalWithdrawnPrincipal, totalStakedPrincipal,
            "CONSERVATION: sum withdrawn principal == sum staked principal");
        assertEq(staking.totalStaked(), 0, "all principal accounted; totalStaked == 0");
        // NOTE: we deliberately do NOT assert `balance >= totalUnsettledRewards`
        // at the end. The long final warp accrues far more reward than the pool
        // holds, so the withdraw-path `_getReward` calls book unpayable shortfalls
        // to `unsettledRewards` — a legitimate state where the unsettled PROMISE
        // exceeds the on-hand pool. The exact value identity (checked above at
        // every checkpoint) and the per-user/global unsettled-sum equality are the
        // rigorous conservation statements; principal recovery is proven by the
        // two assertions above.
    }

    // ───────────────── conservation bookkeeping & assertions ─────────────────

    uint256 internal _rewardsPaidOut; // running tally of reward tokens sent to users

    /// @dev (A) token conservation: balance is partitioned, and the value
    ///      identity balance == totalStaked + totalRewardsFunded - rewardsPaidOut
    ///      holds to the wei. The partition identity is structural; the value
    ///      identity is what an extraction bug (double-credit / lost write-back)
    ///      would break.
    function _checkTokenConservation(string memory ctx) internal view {
        uint256 bal = token.balanceOf(address(staking));
        uint256 staked = staking.totalStaked();

        // PRINCIPAL FLOOR (always true): principal is never paid out as reward —
        // every reward path caps to `balance - totalStaked - ...`. Note we do NOT
        // assert `balance >= staked + totalUnsettled`: `unsettledRewards` is a
        // PROMISE that can legitimately exceed the on-hand pool when the contract
        // is under-funded (that's why claims are pool-capped).
        assertGe(bal, staked,
            string.concat("PRINCIPAL floor: balance >= totalStaked @ ", ctx));

        // VALUE IDENTITY (exact): nothing is minted/burned; tokens in = stakes +
        // funds, tokens out = principal withdrawals + reward payouts (+ the
        // harness's artificial drain used to simulate under-funding).
        //   balance == staked_now + funded_total - rewards_paid_out - drained
        // because withdrawn principal reduces BOTH balance and staked_now in
        // lockstep, cancelling out of the identity. Forfeited reward slices are
        // NOT sent anywhere (they stay in-balance and re-accrue), so they need no
        // separate term — they are simply value that has not (yet) been paid out.
        uint256 expected =
            staked + staking.totalRewardsFunded() - _rewardsPaidOut - _artificialDrain;
        assertEq(bal, expected,
            string.concat("CONSERVATION value identity @ ", ctx));
    }

    /// @dev (B) global counter never desyncs from the per-user mapping sum.
    function _checkUnsettledSum(string memory ctx) internal view {
        uint256 sum =
            staking.unsettledRewards(alice) +
            staking.unsettledRewards(bob) +
            staking.unsettledRewards(carol) +
            staking.unsettledRewards(dave) +
            staking.unsettledRewards(treasury);
        assertEq(staking.totalUnsettledRewards(), sum,
            string.concat("totalUnsettled == sum per-user @ ", ctx));
    }

    /// @dev (C) principal floor — balance must always cover staked principal.
    function _checkPrincipalFloor() internal view {
        assertGe(token.balanceOf(address(staking)), staking.totalStaked(),
            "PRINCIPAL: balance >= totalStaked at all times");
    }

    function _claimUnsettledIfAny(address u) internal {
        if (staking.unsettledRewards(u) == 0) return;
        uint256 before = token.balanceOf(u);
        vm.prank(u);
        staking.claimUnsettled();
        _rewardsPaidOut += token.balanceOf(u) - before;
    }

    /// @dev Withdraw a position and return ONLY the principal component
    ///      (any reward paid alongside is added to the reward tally so the
    ///      conservation identity stays exact). withdraw() pays principal then
    ///      reward via the same token, so we separate them using the position's
    ///      recorded `amount` BEFORE the withdraw clears it.
    function _withdrawAndMeasurePrincipal(address u, uint256 tokenId)
        internal returns (uint256 principal)
    {
        (uint256 amount, , ) = _pos(tokenId);
        principal = amount;
        uint256 before = token.balanceOf(u);
        vm.prank(u);
        staking.withdraw(tokenId);
        uint256 got = token.balanceOf(u) - before;
        // got == principal + rewardPaidNow; attribute the surplus to rewards.
        assertGe(got, principal, "withdraw returns at least principal");
        _rewardsPaidOut += (got - principal);
    }

    /// @dev Ensure the free pool is large enough that pending claims pay in full
    ///      (used right before the mass-claim phase). Funds a generous amount.
    function _drainToHealthy() internal {
        _fund(50_000_000 ether);
    }

    // ───────────────────────────── log helpers ─────────────────────────────

    /// @dev Assert that NO RewardsForfeited event was emitted among the logs
    ///      recorded since the most recent vm.recordLogs().
    function _assertNoRewardsForfeited() internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("RewardsForfeited(address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(staking) && logs[i].topics.length > 0) {
                assertTrue(logs[i].topics[0] != sig, "unexpected RewardsForfeited emitted");
            }
        }
    }

    function _debt(uint256 tokenId) internal view returns (int256 d) {
        (, , d) = _pos(tokenId);
    }

    receive() external payable {}
}
