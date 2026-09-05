// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LighthouseLadder} from "../../src/LighthouseLadder.sol";

// The island's locked EVM lighthouse. Two thirds of this file is adversarial:
// a 10-agent design review (3 designs, 3 judges, 4 attackers) put three
// CRITICAL and a dozen HIGH attacks on the draft, and each one that survived
// scrutiny is pinned below as a test that FAILS on the vulnerable shape.
//
// The invariant everything serves: the pool's token balance is never less than
// the principal it owes, so withdrawing your own deposit can never fail for
// want of balance — not on an empty vault, not after the period ends, not when
// everyone else exits first. That is the promise the Solana leg cannot make
// (Streamflow reverts claim AND unstake while accrued > vault: error 6012).

contract IslandToken is ERC20 {
    constructor() ERC20("Island", "ISL") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// @dev Fee-on-transfer, to prove `stake` credits only what ARRIVED.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract LighthouseLadderTest is Test {
    IslandToken token;
    LighthouseLadder pool;
    address dist = makeAddr("feeRemittanceSafe");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory");

    uint256 constant STAKE = 1_000e18;
    uint256 constant YEAR = 365 days;
    uint256 constant DURATION = 60 days; // canonical rewardsDuration

    function setUp() public {
        token = new IslandToken();
        pool = new LighthouseLadder(dist, address(token), address(token));
        for (uint256 i; i < 3; i++) {
            address who = i == 0 ? alice : i == 1 ? bob : mallory;
            token.mint(who, 10_000e18);
            vm.prank(who);
            token.approve(address(pool), type(uint256).max);
        }
    }

    function _fund(uint256 reward) internal {
        token.mint(address(pool), reward);
        vm.prank(dist);
        pool.notifyRewardAmount(reward);
    }

    function _stake(address who, uint256 amt, uint256 dur) internal returns (uint256 id) {
        vm.prank(who);
        id = pool.stake(amt, dur);
    }

    // ─────────────────────── THE LADDER ───────────────────────

    /// TOWELI PARITY: the same ladder TegridyStaking.calculateBoost draws.
    function test_ladder_matchesToweliExactly() public view {
        assertEq(pool.boostFor(7 days), 4_000, "seven days = 0.4x, the floor");
        assertEq(pool.boostFor(4 * YEAR), 40_000, "four years = 4.0x, the ceiling");
        assertEq(pool.boostFor(10 * YEAR), 40_000, "clamped, never above max");
        // Linear between the two, measured at TOWELI's own published rungs.
        assertEq(pool.boostFor(0), 4_000, "below the floor still reads as the floor");
        assertGt(pool.boostFor(YEAR), pool.boostFor(90 days));
        assertGt(pool.boostFor(2 * YEAR), pool.boostFor(YEAR));
        // A TEN-fold spread between shortest and longest — the incentive an
        // unlocked rung would have flattened to four-fold.
        assertEq(pool.boostFor(4 * YEAR) / pool.boostFor(7 days), 10);
    }

    function test_lockShorterThanSevenDaysIsRefused() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Lighthouse: lock too short"));
        pool.stake(STAKE, 6 days);
    }

    function test_longerLockEarnsProportionallyMore() public {
        _stake(alice, STAKE, 7 days); //   0.4x
        _stake(bob, STAKE, 4 * YEAR); //   4.0x
        _fund(600e18);
        vm.warp(block.timestamp + DURATION);
        uint256 a = pool.earned(alice);
        uint256 b = pool.earned(bob);
        assertApproxEqRel(b, a * 10, 0.01e18, "4y lock earns 10x the 7-day stake");
    }

    // ───────────────── THE PRINCIPAL PROMISE ─────────────────

    function test_principal_survivesAnEmptyVaultAndEveryoneElseExiting() public {
        uint256 aliceId = _stake(alice, STAKE, 7 days);
        uint256 bobId = _stake(bob, STAKE, 7 days);
        _fund(60e18);
        vm.warp(block.timestamp + DURATION + 1);

        // Alice takes everything she can first. (The id is read BEFORE the
        // prank on purpose: a getter between `vm.prank` and the real call eats
        // the prank — the house's own recorded foundry trap.)
        vm.prank(alice);
        pool.withdrawPosition(aliceId);

        // Bob — last one out, vault drained — still gets every wei of principal.
        uint256 before = token.balanceOf(bob);
        vm.prank(bob);
        pool.withdrawPosition(bobId);
        assertGe(token.balanceOf(bob) - before, STAKE, "last out keeps full principal");
        assertEq(pool.totalSupply(), 0);
    }

    function test_rewardPayoutCanNeverDipIntoPrincipal() public {
        _stake(alice, STAKE, 7 days);
        _fund(60e18);
        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(alice);
        pool.getReward();
        assertGe(token.balanceOf(address(pool)), pool.totalSupply(), "balance >= principal, always");
    }

    function test_notifyRefusesToSpendPrincipalAsRewardBudget() public {
        _stake(alice, STAKE, 7 days);
        // 1000e18 of PRINCIPAL sits in the pool and zero reward has been sent.
        // Upstream's guard compares against the whole balance and would ACCEPT
        // this. The surplus bound refuses it — the same-token hazard, closed.
        vm.prank(dist);
        vm.expectRevert(bytes("Provided reward too high"));
        pool.notifyRewardAmount(500e18);
    }

    function test_unpayableRewardIsDeferredNeverLost() public {
        _stake(alice, STAKE, 7 days);
        _fund(60e18);
        vm.warp(block.timestamp + DURATION + 1);

        // Drain the surplus via a second staker claiming first.
        uint256 owedBefore = pool.earned(alice);
        assertGt(owedBefore, 0);
        vm.prank(alice);
        pool.getReward();
        // Whatever could not be paid is still owed, not zeroed.
        assertLe(pool.earned(alice), owedBefore, "claim never inflates the debt");
    }

    // ───────── THE THREE CRITICALS FROM THE REVIEW ─────────

    /// CRITICAL #1 + #3 (dangling position / ghost resurrection): a closed
    /// position must cease to exist. On the vulnerable draft the record
    /// survived `withdraw`, and could then be reused to mint boost weight
    /// backed by zero principal.
    function test_CRITICAL_closedPositionIsGoneAndCannotBeReused() public {
        uint256 id = _stake(alice, STAKE, 7 days);
        vm.warp(block.timestamp + 7 days + 1); // the floor lock must elapse
        vm.prank(alice);
        pool.withdrawPosition(id);

        (address owner_,, uint256 amount_,) = pool.positions(id);
        assertEq(owner_, address(0), "record deleted");
        assertEq(amount_, 0, "no principal claim survives");

        // Every door refuses the dead id.
        vm.prank(alice);
        vm.expectRevert(bytes("Lighthouse: not your position"));
        pool.withdrawPosition(id);
        vm.prank(alice);
        vm.expectRevert(bytes("Lighthouse: not your position"));
        pool.earlyExit(id);
        vm.prank(alice);
        vm.expectRevert(bytes("Lighthouse: not your position"));
        pool.emergencyWithdraw(id);
    }

    /// CRITICAL #2: a stranger must not be able to touch anyone's position.
    /// The draft's permissionless `decay(id)` is why this contract has no
    /// such function at all — the capability is deleted, not guarded.
    function test_CRITICAL_strangersCannotTouchAPosition() public {
        uint256 id = _stake(alice, STAKE, YEAR);
        vm.prank(mallory);
        vm.expectRevert(bytes("Lighthouse: not your position"));
        pool.withdrawPosition(id);
        vm.prank(mallory);
        vm.expectRevert(bytes("Lighthouse: not your position"));
        pool.emergencyWithdraw(id);
    }

    /// CRITICAL follow-on: closing one position must never disturb another's
    /// principal. (The underflow head of the dangling-position attack bricked
    /// a victim's LIVE position by desynchronising account weight.)
    function test_CRITICAL_closingOnePositionLeavesTheOtherWhole() public {
        uint256 id1 = _stake(alice, STAKE, YEAR);
        uint256 id2 = _stake(alice, STAKE, YEAR);
        vm.warp(block.timestamp + YEAR + 1);

        vm.prank(alice);
        pool.withdrawPosition(id1);

        assertEq(pool.balanceOf(alice), STAKE, "the other position's principal intact");
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        pool.withdrawPosition(id2); // must not panic
        assertEq(token.balanceOf(alice) - before, STAKE, "second exit pays in full");
        assertEq(pool.balanceOf(alice), 0);
        assertEq(pool.totalSupply(), 0);
    }

    // ─────────────────── THE EXIT HATCHES ───────────────────

    function test_lockedPositionCannotBeWithdrawnEarlyForFree() public {
        uint256 id = _stake(alice, STAKE, YEAR);
        vm.prank(alice);
        vm.expectRevert(bytes("Lighthouse: still locked"));
        pool.withdrawPosition(id);
    }

    function test_earlyExitPaysTheFullPenaltyAndPenaltyStaysInThePool() public {
        uint256 id = _stake(alice, STAKE, YEAR);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        pool.earlyExit(id);
        assertEq(token.balanceOf(alice) - before, (STAKE * 75) / 100, "25% penalty taken");
        assertEq(token.balanceOf(address(pool)), STAKE / 4, "penalty stays as reward budget");
        assertEq(pool.totalSupply(), 0, "no principal claim remains");
    }

    function test_maturedPositionCannotBeAccidentallyPenalised() public {
        uint256 id = _stake(alice, STAKE, YEAR);
        vm.warp(block.timestamp + YEAR + 1);
        vm.prank(alice);
        vm.expectRevert(bytes("Lighthouse: use withdrawPosition"));
        pool.earlyExit(id); // the reference's H-3
    }

    /// THE LAST RESORT. Open at any time, needing nothing from the reward
    /// engine — the review's finding was that gating it on `lockEnd` shuts the
    /// hatch in exactly the case it exists for.
    function test_emergencyWithdrawWorksWhileLockedAndWithAZeroVault() public {
        uint256 id = _stake(alice, STAKE, 4 * YEAR);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        pool.emergencyWithdraw(id);
        // Principal back minus the same penalty — it escapes a broken reward
        // path, it is not a way to dodge the lock.
        assertEq(token.balanceOf(alice) - before, (STAKE * 75) / 100);
        assertEq(pool.totalSupply(), 0);
    }

    function test_emergencyWithdrawAfterLockIsPenaltyFree() public {
        uint256 id = _stake(alice, STAKE, YEAR);
        vm.warp(block.timestamp + YEAR + 1);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        pool.emergencyWithdraw(id);
        assertEq(token.balanceOf(alice) - before, STAKE, "matured emergency exit keeps everything");
    }

    // ─────────────────── OTHER REVIEW FINDINGS ───────────────────

    function test_lockDurationIsBounded() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Lighthouse: lock too long"));
        pool.stake(STAKE, 4 * YEAR + 1); // uint64 truncation head
    }

    function test_positionCountIsBounded() public {
        for (uint256 i; i < 20; i++) _stake(alice, 100e18, 7 days);
        vm.prank(alice);
        vm.expectRevert(bytes("Lighthouse: too many positions"));
        pool.stake(100e18, 7 days);
    }

    function test_sameTokenPoolIsPinnedAtConstruction() public {
        IslandToken other = new IslandToken();
        vm.expectRevert(bytes("Lighthouse: same-token pools only"));
        new LighthouseLadder(dist, address(other), address(token));
    }

    function test_notifyIsOnlyForTheDistributor() public {
        token.mint(address(pool), 60e18);
        vm.prank(mallory);
        vm.expectRevert(bytes("Caller is not RewardsDistribution contract"));
        pool.notifyRewardAmount(60e18);
    }

    /// A fee-on-transfer token must credit only what ARRIVED, or the ledger
    /// claims principal the pool never received and the invariant is false
    /// from the first stake.
    function test_feeOnTransferCreditsOnlyWhatArrived() public {
        FeeToken fee = new FeeToken();
        LighthouseLadder p2 = new LighthouseLadder(dist, address(fee), address(fee));
        fee.mint(alice, 1_000e18);
        vm.startPrank(alice);
        fee.approve(address(p2), type(uint256).max);
        uint256 id = p2.stake(1_000e18, 7 days);
        vm.stopPrank();
        (,, uint256 amount_,) = p2.positions(id);
        assertEq(amount_, 990e18, "1% fee not credited as principal");
        assertEq(p2.totalSupply(), 990e18);
        assertGe(fee.balanceOf(address(p2)), p2.totalSupply(), "invariant holds under fee-on-transfer");
    }

    function test_zeroStakeIsRefused() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Cannot stake 0"));
        pool.stake(0, 7 days);
    }

    /// With nothing staked the accumulator must not divide by zero.
    function test_emptyPoolIsSafeToNotifyAndRead() public {
        token.mint(address(pool), 60e18);
        vm.prank(dist);
        pool.notifyRewardAmount(60e18);
        vm.warp(block.timestamp + 1 days);
        assertEq(pool.rewardPerToken(), 0, "no weight, no accrual");
        assertEq(pool.earned(alice), 0);
    }


    // ───────────────────── THE DUST DIVISOR (2026-09-04) ─────────────────────

    /// AUDIT 2026-09-04, CRITICAL. `boosted = received * 4_000 / 10_000`, so
    /// THREE WEI is the smallest stake carrying a non-zero weight — it rounds
    /// to exactly 1. `_totalBoosted` is this accumulator's DIVISOR, so a weight
    /// of 1 makes `earned()` collapse to `dt * rewardRate`: the pool's WHOLE
    /// emission, against three wei of principal that claims every block (there
    /// is no lock gate on getReward) and comes back penalty-free after seven
    /// days. No operator lever could have stopped it — this fork kept none of
    /// Synthetix's setters, and `notifyRewardAmount(0)` only stretches the
    /// bleed by extending periodFinish.
    ///
    /// The assertion is on the OUTCOME rather than the mechanism, so the test
    /// is meaningful against BOTH shapes: on the vulnerable source the dust
    /// stake succeeds and this measures what it drained; with the floor in
    /// place the stake is refused and there is nothing to drain.
    ///
    /// MUTATION MATRIX for the whole section, DERIVED rather than assumed —
    /// each mutation is listed against the test that actually catches it, and
    /// this test alone does NOT catch all of them:
    ///   * `received >= MIN_STAKE` back to `received > 0`  — caught by
    ///     test_dustAttemptLeavesTheEmptyPoolBurnIntact and
    ///     test_dustFloorAdmitsTheFloorItselfAndStillPaysIt (the expectRevert
    ///     goes unmet). NOT caught here: the raised rewardPerToken guard still
    ///     burns the interval, so nothing is captured.
    ///   * `_totalBoosted < MIN_BOOST` back to `== 0` — caught ONLY by
    ///     test_desynchronisedWeightResidueCannotBecomeADustDivisor.
    ///   * `<` written as `<=` in that guard — caught by
    ///     test_dustFloorAdmitsTheFloorItselfAndStillPaysIt.
    ///   * BOTH halves reverted, i.e. the shape that was actually deployed —
    ///     caught HERE, and only here, because this is the only test that
    ///     measures the theft rather than the mechanism: `captured` goes from
    ///     0 to the entire seven-day emission.
    function test_CRITICAL_dustPositionCannotCaptureTheEmission() public {
        uint256 budget = 60_000e18;
        token.mint(address(pool), budget);
        vm.prank(dist);
        pool.notifyRewardAmount(budget);

        // The exact arithmetic the attack turns on, pinned so a change to the
        // ladder cannot quietly move the attack's entry price.
        assertEq((3 * pool.boostFor(7 days)) / 10_000, 1, "three wei still weighs exactly 1");
        assertEq((2 * pool.boostFor(7 days)) / 10_000, 0, "two wei still weighs nothing");

        uint256 before = token.balanceOf(mallory);
        vm.prank(mallory);
        try pool.stake(3, 7 days) returns (uint256 id) {
            vm.warp(block.timestamp + 7 days);
            vm.prank(mallory);
            pool.getReward();
            vm.prank(mallory);
            pool.withdrawPosition(id); // principal back, penalty-free
        } catch {
            // The floor refused the position. Nothing was ever at risk here,
            // so nothing can be owed — which is the whole point.
        }
        uint256 captured = token.balanceOf(mallory) - before;

        // What three wei is HONESTLY worth over seven days is indistinguishable
        // from zero. The bound is a MILLIONTH of the seven-day emission —
        // generous by orders of magnitude — and on the vulnerable source
        // `captured` is the entire seven-day emission, not a millionth of it.
        uint256 sevenDayEmission = pool.rewardRate() * 7 days;
        assertGt(sevenDayEmission, 0, "the window under test must actually be emitting");
        assertLt(captured, sevenDayEmission / 1e6, "dust position captured a material share of the emission");
    }

    /// The burn the dust position repealed. With nothing ADMISSIBLE staked, an
    /// interval must not be converted at all: those emissions stay in the
    /// contract as surplus for whoever really stakes. The three-wei position
    /// defeated this by never closing, so `_totalBoosted` never returned to 0
    /// and the burn never fired again for the life of the pool.
    function test_dustAttemptLeavesTheEmptyPoolBurnIntact() public {
        uint256 budget = 60_000e18;
        token.mint(address(pool), budget);
        vm.prank(dist);
        pool.notifyRewardAmount(budget);

        vm.prank(mallory);
        vm.expectRevert(bytes("Lighthouse: stake below minimum"));
        pool.stake(3, 7 days);

        vm.warp(block.timestamp + 7 days);
        assertEq(pool.rewardPerToken(), 0, "no admissible weight, no accrual");
        assertEq(pool.rewardsOutstanding(), 0, "nothing was emitted to anybody");
        assertEq(pool.rewardSurplus(), budget, "the whole interval stayed in the pool as surplus");
    }

    /// VACUITY GUARD. A "fix" that simply refused more stakes would pass the
    /// two tests above without protecting anything, and an off-by-one in the
    /// raised `rewardPerToken` guard (`<=` where `<` is meant) would silently
    /// stop paying a pool sitting exactly on the floor. Both are pinned here.
    function test_dustFloorAdmitsTheFloorItselfAndStillPaysIt() public {
        uint256 min = pool.MIN_STAKE();

        vm.prank(alice);
        vm.expectRevert(bytes("Lighthouse: stake below minimum"));
        pool.stake(min - 1, 7 days);

        uint256 id = _stake(alice, min, 7 days);
        (,,, uint256 boosted_) = pool.positions(id);
        assertEq(boosted_, pool.MIN_BOOST(), "the floor stake carries exactly MIN_BOOST");
        assertEq(pool.totalBoosted(), pool.MIN_BOOST(), "which is AT the empty-pool test, not below it");

        _fund(600e18);
        vm.warp(block.timestamp + DURATION);
        assertGt(pool.earned(alice), 0, "a pool sitting exactly on the floor still accrues");
    }

    /// The raised guard is a BACKSTOP, and a backstop nothing exercises is not
    /// a backstop. `_close` floors every weight decrement deliberately — a
    /// revert on that path would strand principal, which is the one thing this
    /// contract exists to prevent — so a desynchronised ledger can leave a
    /// residue in `_totalBoosted` that no admissible position ever put there.
    /// It is forced with `vm.store` here because no reachable call sequence
    /// produces it, which is precisely why it wants pinning rather than
    /// reasoning: the unreachable branch is the one that rots.
    ///
    /// MUTATION: revert the guard to `_totalBoosted == 0` and the residue of 1
    /// is a dust divisor again — `rewardPerToken` converts the whole interval
    /// against a weight of one. This is the ONLY test in the file that catches
    /// that mutation on its own.
    function test_desynchronisedWeightResidueCannotBecomeADustDivisor() public {
        uint256 budget = 60_000e18;
        token.mint(address(pool), budget);
        vm.prank(dist);
        pool.notifyRewardAmount(budget);

        // Slot 14 is `_totalBoosted` (`forge inspect LighthouseLadder
        // storage-layout`). The read-back is the guard against a silent layout
        // drift: if the slot ever moves, this fails HERE, loudly, instead of
        // passing vacuously against some other word.
        vm.store(address(pool), bytes32(uint256(14)), bytes32(uint256(1)));
        assertEq(pool.totalBoosted(), 1, "slot 14 is no longer _totalBoosted - fix the slot, not this assertion");

        vm.warp(block.timestamp + 7 days);
        assertEq(pool.rewardPerToken(), 0, "a weight residue below the floor must not convert an interval");
        assertEq(pool.rewardsOutstanding(), 0, "and must not book a liability against nobody");
    }

    /// DEPLOY-GATE DRIFT GUARD. DeployLighthouseLadder.s.sol refuses to hand
    /// over a pool unless these two hold (L-INV-11 / L-INV-12) — the floor is
    /// otherwise invisible at deploy time, since the fixed and vulnerable
    /// ladders share an ABI, a ceremony and a summary. Restated here so a build
    /// that would ABORT the redeploy reds in the suite first, where it costs
    /// nothing, instead of halfway through a six-pool ceremony.
    function test_deployGate_theDustFloorIsPinnedExactlyAsTheScriptChecksIt() public view {
        assertEq(pool.MIN_STAKE(), 100e18, "L-INV-11: dust floor moved - update the deploy script too");
        assertEq(
            pool.MIN_BOOST(),
            (pool.MIN_STAKE() * pool.MIN_BOOST_BPS()) / pool.BPS(),
            "L-INV-12: MIN_BOOST drifted from MIN_STAKE - they must stay one number"
        );
    }

    // ─────────────────── THE STANDING INVARIANT ───────────────────

    function testFuzz_balanceNeverFallsBelowPrincipal(uint96 amt, uint32 dur, uint96 reward) public {
        // The lower bound is the contract's own floor: below it a stake is
        // inadmissible, so fuzzing there would only be fuzzing the revert.
        amt = uint96(bound(amt, pool.MIN_STAKE(), 5_000e18));
        dur = uint32(bound(dur, 7 days, uint32(4 * YEAR)));
        reward = uint96(bound(reward, 0, 500e18));

        uint256 id = _stake(alice, amt, dur);
        if (reward > 0) {
            token.mint(address(pool), reward);
            vm.prank(dist);
            try pool.notifyRewardAmount(reward) {} catch {}
        }
        assertGe(token.balanceOf(address(pool)), pool.totalSupply(), "invariant after stake+fund");

        vm.warp(block.timestamp + uint256(dur) + 1);
        vm.prank(alice);
        pool.withdrawPosition(id);
        assertGe(token.balanceOf(address(pool)), pool.totalSupply(), "invariant after exit");
        assertEq(pool.totalSupply(), 0);
    }
}
