// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {PremiumAccess} from "../src/PremiumAccess.sol";

contract MockToweli is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JBAC", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}

/// @title R022 — PremiumAccess reconciliation against current contract.
/// @notice DRIFT (RC10): the R022 redesign (Period[] array, `pendingRefund`/
///         `claimRefund` pull-pattern, `sweepExpiredEscrow` permissionless
///         reaper, `pendingTreasuryWithdrawal` accrual on blocklisted
///         treasury) was deferred. The current contract still uses the
///         single-`Subscription`-per-user model with extension drift on the
///         `escrowed * remainingTime / totalDuration` refund formula and a
///         direct safeTransfer in cancelSubscription/withdrawToTreasury.
///
///         These tests pin the CURRENT behavior so future drift is caught.
contract R022_PremiumAccessTest is Test {
    PremiumAccess premium;
    MockToweli toweli;
    MockJBAC jbac;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant FEE = 100 ether;
    uint256 constant MONTH = 30 days;

    function setUp() public {
        toweli = new MockToweli();
        jbac = new MockJBAC();
        premium = new PremiumAccess(address(toweli), address(jbac), treasury, FEE);

        toweli.transfer(alice, 10_000 ether);
        toweli.transfer(bob, 10_000 ether);

        vm.prank(alice);
        toweli.approve(address(premium), type(uint256).max);
        vm.prank(bob);
        toweli.approve(address(premium), type(uint256).max);
    }

    /// Single-period halfway cancel still produces the correct pro-rata refund.
    /// (Pre-fix invariant — held both before and after R022.)
    function test_cancel_singlePeriod_halfwayThrough_proRata() public {
        vm.prank(alice);
        premium.subscribe(1, FEE);
        vm.warp(block.timestamp + 15 days);
        vm.prank(alice);
        premium.cancelSubscription();
        // Paid 100, used ~50, refunded ~50 → bal = 9_950 ± 1 wei.
        assertApproxEqAbs(toweli.balanceOf(alice), 9_950 ether, 2, "single-period halfway pro-rata");
    }

    /// AUDIT PA-M-01 / R022 (2026-04-29): on extension, `startedAt` is reset
    /// AND `userEscrow` is reset to the new period's `cost` — the unconsumed
    /// remainder of the OLD period is forfeit (credited to `totalRevenue`).
    /// The cancel refund formula then operates on a clean per-period
    /// (cost, startedAt, expiresAt) triple identical to a brand-new
    /// subscription, eliminating the extend-then-cancel drift.
    ///
    /// Scenario: pay 100 (period 1), wait 15 days, extend by 1 month
    /// (period 2 anchored fresh), wait MIN_HOLDING_PERIOD + a hair, cancel
    /// at ~24h into the new 30-day period. Per-period pro-rata: refund ≈
    /// remaining/total * cost = (~29 days / 30 days) * 100 ≈ ~96.66 TOWELI.
    /// Total paid: 200; net cost: ~103 TOWELI (15 full days of period 1 ≈
    /// 50 TOWELI consumed + ~3.33 TOWELI of period 2 + the 100 forfeit
    /// remainder of period 1 that is now permanent revenue).
    function test_extend_then_cancel_correctedBehavior_R022() public {
        // Period 1
        vm.prank(alice);
        premium.subscribe(1, FEE);

        // Halfway through period 1
        vm.warp(block.timestamp + 15 days);

        // Extend by another month — anchors period 2 with fresh startedAt + escrow.
        vm.prank(alice);
        premium.subscribe(1, FEE);

        // Wait past MIN_HOLDING_PERIOD (1 day) on the new anchored period so
        // cancel is permitted. Pick 1 day + 1 second to land just past the gate.
        vm.warp(block.timestamp + 1 days + 1);

        uint256 balBefore = toweli.balanceOf(alice);
        vm.prank(alice);
        premium.cancelSubscription();
        uint256 refund = toweli.balanceOf(alice) - balBefore;

        // Per-period pro-rata. Note: on extension `startFrom = sub.expiresAt`
        // (since the old sub had NOT expired) — i.e. the new period extends
        // FROM the original expiry, not from now. Original expiry was
        // startedAt+30 days; we extended halfway through (15 days in), so
        // startFrom = block.timestamp + 15 days, and expiresAt = startFrom + 30
        // days = block.timestamp + 45 days. R022 resets startedAt to
        // block.timestamp, so totalDuration = 45 days, remainingTime = 45 days
        // - 1 day - 1s. Refund = (45d - 1d - 1) / 45d * FEE ≈ 97.78 TOWELI.
        // The OLD (buggy) drift value was much higher (~150 TOWELI) because
        // the old formula carried the unconsumed period-1 remainder into the
        // new period AND used the larger originally-anchored startedAt.
        uint256 expectedRefund = (FEE * (45 days - 1 days - 1)) / 45 days;
        assertApproxEqAbs(refund, expectedRefund, 1 ether,
            "R022: refund matches per-period pro-rata of NEW period only");

        // Net cost should reflect 100 (forfeit period-1 remainder) + 100 - ~97.78
        // (period-2 1-day consumption) ≈ 102.22 TOWELI.
        uint256 netCost = (10_000 ether) - toweli.balanceOf(alice);
        assertApproxEqAbs(netCost, FEE + (FEE * (1 days + 1)) / 45 days, 1 ether,
            "R022: net cost = forfeit + 1-day-of-new-45d-period");
    }

    /// withdrawToTreasury sends `balance - totalRefundEscrow` directly. This works
    /// fine for non-blocklisted ERC20s. The R022 M-02 pull-pattern + accrual on
    /// blocklisted treasury is deferred.
    function test_withdrawToTreasury_drainsAfterReconcile() public {
        vm.prank(alice);
        premium.subscribe(1, FEE);
        vm.warp(block.timestamp + 31 days);

        // Free escrow via the public reconcile path (R022's `sweepExpiredEscrow`
        // bounty/reaper is deferred — `reconcileExpired` is the analogue).
        premium.reconcileExpired(alice);
        assertEq(premium.totalRefundEscrow(), 0, "escrow freed");

        // Treasury can now drain.
        premium.withdrawToTreasury();
        assertEq(toweli.balanceOf(treasury), 100 ether, "treasury received fee");
    }

    /// Cancellation reverts on no active subscription.
    function test_cancel_revertsOnNoActiveSubscription() public {
        vm.prank(alice);
        vm.expectRevert(PremiumAccess.NoActiveSubscription.selector);
        premium.cancelSubscription();
    }

    /// hasPremium tracks the subscription expiry across an extension.
    function test_hasPremium_acrossExtension() public {
        vm.prank(alice);
        premium.subscribe(1, FEE);
        assertTrue(premium.hasPremium(alice));

        vm.warp(block.timestamp + 15 days);
        vm.prank(alice);
        premium.subscribe(1, FEE);
        assertTrue(premium.hasPremium(alice));

        // Move past everything.
        vm.warp(block.timestamp + 50 days);
        assertFalse(premium.hasPremium(alice), "premium ends after final period");
    }
}
