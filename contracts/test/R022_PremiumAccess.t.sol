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
    /// at ~24h into the new 45-day period.
    ///
    /// AUDIT FIX: DEEP-DR-M-06 (2026-05-01) — on extension, the UNCONSUMED
    /// pro-rata of the old period is now credited back into the new
    /// per-period escrow (rather than being forfeit to revenue). Only the
    /// CONSUMED portion (15/30 of FEE = 50 TOWELI) becomes revenue.
    /// Net effect: new escrow = remainingEscrow + cost = 50 + 100 = 150 TOWELI.
    /// After 1 day of the new 45-day period, refund = 150 * (45d - 1d - 1) / 45d
    /// ≈ 146.67 TOWELI. Net cost = 200 - 146.67 ≈ 53.33 TOWELI.
    function test_extend_then_cancel_correctedBehavior_R022() public {
        // Period 1
        vm.prank(alice);
        premium.subscribe(1, FEE);

        // Halfway through period 1
        vm.warp(block.timestamp + 15 days);

        // Extend by another month — anchors period 2 with fresh startedAt
        // and unconsumed remainder rolled into the escrow.
        vm.prank(alice);
        premium.subscribe(1, FEE);

        // Wait past MIN_HOLDING_PERIOD (1 day) on the new anchored period so
        // cancel is permitted. Pick 1 day + 1 second to land just past the gate.
        vm.warp(block.timestamp + 1 days + 1);

        uint256 balBefore = toweli.balanceOf(alice);
        vm.prank(alice);
        premium.cancelSubscription();
        uint256 refund = toweli.balanceOf(alice) - balBefore;

        // Per-period pro-rata. Extension: `startFrom = sub.expiresAt` (since
        // old sub had NOT expired), so startFrom = block.timestamp + 15 days,
        // expiresAt = startFrom + 30 days = block.timestamp + 45 days.
        // DR-M-06 resets startedAt to block.timestamp and credits unconsumed
        // back: new escrow = remainingEscrow_old + cost = 50 + 100 = 150.
        // totalDuration = 45 days, remainingTime = 45 days - 1 day - 1s.
        // Refund = 150 * (45d - 1d - 1) / 45d ≈ 146.67 TOWELI.
        uint256 newEscrow = (FEE * 15 days) / 30 days + FEE; // remaining + cost
        uint256 expectedRefund = (newEscrow * (45 days - 1 days - 1)) / 45 days;
        assertApproxEqAbs(refund, expectedRefund, 1 ether,
            "DEEP-DR-M-06: refund includes credited-back unconsumed remainder");

        // Net cost = consumed-portion-of-period-1 (50) + consumed-portion-of-new-150-escrow
        //         ≈ 50 + 150 * (1 day + 1) / 45 days ≈ 53.33 TOWELI.
        uint256 netCost = (10_000 ether) - toweli.balanceOf(alice);
        uint256 expectedNetCost = (FEE * 15 days) / 30 days + (newEscrow * (1 days + 1)) / 45 days;
        assertApproxEqAbs(netCost, expectedNetCost, 1 ether,
            "DEEP-DR-M-06: net cost = consumed portion only");
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
