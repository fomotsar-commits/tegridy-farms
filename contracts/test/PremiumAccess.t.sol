// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/PremiumAccess.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

contract MockToweliPremium is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockJBACPremium is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}

contract PremiumAccessTest is Test {
    PremiumAccess public premium;
    MockToweliPremium public token;
    MockJBACPremium public nft;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    uint256 public constant MONTHLY_FEE = 1000 ether;

    function setUp() public {
        token = new MockToweliPremium();
        nft = new MockJBACPremium();
        premium = new PremiumAccess(address(token), address(nft), treasury, MONTHLY_FEE);

        token.transfer(alice, 100_000 ether);
        token.transfer(bob, 100_000 ether);

        vm.prank(alice);
        token.approve(address(premium), type(uint256).max);
        vm.prank(bob);
        token.approve(address(premium), type(uint256).max);
    }

    // ===== SUBSCRIBE TRACKS userEscrow CORRECTLY =====

    function test_subscribe_tracksUserEscrow() public {
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max);

        assertEq(premium.userEscrow(alice), 2 * MONTHLY_FEE);
        assertEq(premium.totalRefundEscrow(), 2 * MONTHLY_FEE);
    }

    function test_subscribe_multipleSubscriptions_addEscrow() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.userEscrow(alice), MONTHLY_FEE);

        // DEEP-DR-L-05: extensions must respect MIN_HOLDING_PERIOD (24h) so the
        // extension can't be used to lock in old fee rates immediately.
        vm.warp(block.timestamp + premium.MIN_HOLDING_PERIOD() + 1);

        vm.prank(alice);
        premium.subscribe(1, type(uint256).max); // extend
        // AUDIT PA-M-01 / R022 (2026-04-29) + DEEP-DR-M-06 (2026-05-01):
        // on extension, the unconsumed pro-rata of the OLD period is credited
        // back into the fresh per-period escrow (NOT forfeit to revenue). For
        // a 30-day subscription extended after MIN_HOLDING_PERIOD (~1 day),
        // ~29/30 of the original escrow remains unconsumed, so userEscrow
        // post-extension is roughly cost + (29/30 * MONTHLY_FEE).
        // The exact value depends on MIN_HOLDING_PERIOD, but it is ALWAYS in
        // (cost, 2 * cost).
        uint256 escrow = premium.userEscrow(alice);
        assertGt(escrow, MONTHLY_FEE, "DEEP-DR-M-06: unconsumed credited back");
        assertLt(escrow, 2 * MONTHLY_FEE, "DEEP-DR-M-06: less than full doubling (consumed portion is forfeit)");
        assertEq(premium.totalRefundEscrow(), escrow, "DEEP-DR-M-06: refund-escrow tracks fresh anchor");
    }

    function test_subscribe_1month() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);

        (uint256 expiresAt,, bool active) = premium.getSubscription(alice);
        assertTrue(active);
        assertEq(expiresAt, block.timestamp + 30 days);
        assertEq(premium.totalRevenue(), MONTHLY_FEE);
    }

    function test_subscribe_holdsTokensInContract() public {
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max);

        assertEq(token.balanceOf(alice), aliceBefore - 2 * MONTHLY_FEE);
        assertEq(token.balanceOf(address(premium)), 2 * MONTHLY_FEE);
    }

    // ===== CANCEL REFUND IS PROPORTIONAL TO REMAINING TIME =====

    function test_cancelSubscription_proRataRefund() public {
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max); // 2 months = 2000 TOWELI

        vm.warp(block.timestamp + 15 days);

        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        premium.cancelSubscription();
        uint256 refund = token.balanceOf(alice) - aliceBefore;

        // Remaining ~45 days of 60 days: refund ~ 45/60 * 2000 = 1500
        assertApproxEqAbs(refund, 1500 ether, 10 ether);

        (,, bool active) = premium.getSubscription(alice);
        assertFalse(active);
    }

    function test_cancelSubscription_fullRefundAtStart() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);

        // AUDIT R014: MIN_HOLDING_PERIOD = 1 day, so warp past it.
        // Still exercises "near-start" pro-rata logic — refund tolerance
        // widened to absorb the 1d consumption (~33 TOWELI of 1000).
        vm.warp(block.timestamp + 1 days + 1);

        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        premium.cancelSubscription();
        uint256 refund = token.balanceOf(alice) - aliceBefore;

        assertApproxEqAbs(refund, MONTHLY_FEE, 50 ether);
    }

    function test_cancelSubscription_noRefundNearEnd() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);

        // Warp to near the end (29.9 days of 30)
        vm.warp(block.timestamp + 29 days + 23 hours);

        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        premium.cancelSubscription();
        uint256 refund = token.balanceOf(alice) - aliceBefore;

        // Should be very small refund
        assertLt(refund, 50 ether, "Refund should be minimal near end");
    }

    function test_revert_cancelSubscription_noActive() public {
        vm.prank(alice);
        vm.expectRevert(PremiumAccess.NoActiveSubscription.selector);
        premium.cancelSubscription();
    }

    function test_revert_cancelSubscription_expired() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        vm.warp(block.timestamp + 31 days);

        vm.prank(alice);
        vm.expectRevert(PremiumAccess.NoActiveSubscription.selector);
        premium.cancelSubscription();
    }

    // ===== CANCEL CLEARS ESCROW CORRECTLY =====

    function test_cancel_clearsEscrow() public {
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max);
        assertEq(premium.userEscrow(alice), 2000 ether);
        assertEq(premium.totalRefundEscrow(), 2000 ether);

        vm.warp(block.timestamp + 15 days);

        vm.prank(alice);
        premium.cancelSubscription();

        assertEq(premium.userEscrow(alice), 0);
        assertEq(premium.totalRefundEscrow(), 0);
    }

    // ===== withdrawToTreasury RESPECTS totalRefundEscrow =====

    function test_withdrawToTreasury_respectsEscrow() public {
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max); // 2000 TOWELI in contract, all escrowed

        // All tokens are escrowed, nothing should go to treasury
        premium.withdrawToTreasury();
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_withdrawToTreasury_afterCancelReleasesConsumed() public {
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max); // 2000 TOWELI

        // Warp 30 days (half consumed)
        vm.warp(block.timestamp + 30 days);

        vm.prank(alice);
        premium.cancelSubscription();
        // Refund ~ 1000, escrow cleared to 0
        // Contract should have ~ 1000 left (consumed portion)

        uint256 treasuryBefore = token.balanceOf(treasury);
        premium.withdrawToTreasury();
        uint256 treasuryGot = token.balanceOf(treasury) - treasuryBefore;

        // Should be able to withdraw the consumed (non-refunded) portion
        assertGt(treasuryGot, 0, "Treasury should get consumed fees");
    }

    function test_withdrawToTreasury_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        premium.withdrawToTreasury();
    }

    // ===== PAID FEE RATE EXPLOIT PREVENTION =====
    // Subscribe cheap -> fee rises -> cancel for refund at old rate
    // The fix: refund is based on userEscrow (actual deposited amount), not current fee rate

    function test_paidFeeRate_exploitPrevented() public {
        // Alice subscribes at 1000 TOWELI/month for 2 months
        vm.prank(alice);
        premium.subscribe(2, type(uint256).max); // pays 2000

        // Owner raises fee to 5000 TOWELI/month (timelocked)
        premium.proposeFeeChange(5000 ether);
        vm.warp(block.timestamp + 24 hours + 1);
        premium.executeFeeChange();

        // Alice cancels immediately - should get back based on what she ACTUALLY paid (escrow)
        // Not based on the new higher rate
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        premium.cancelSubscription();
        uint256 refund = token.balanceOf(alice) - aliceBefore;

        // Refund should be close to 2000 (what she paid), not 10000 (2 months at new rate)
        // Tolerance widened because 24h+1s timelock warp eats into the subscription period
        assertApproxEqAbs(refund, 2000 ether, 50 ether);
    }

    // ===== JBAC NFT ACCESS =====

    function test_hasPremium_withJBACNFT() public {
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();
        vm.warp(block.timestamp + 16); // advance past MIN_ACTIVATION_DELAY
        assertTrue(premium.hasPremium(alice));
    }

    function test_hasPremium_nftCheckedAtQueryTime() public {
        vm.warp(100); // start at a known timestamp

        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();
        vm.warp(116); // advance past MIN_ACTIVATION_DELAY (15s)
        assertTrue(premium.hasPremium(alice));

        vm.prank(alice);
        nft.transferFrom(alice, bob, 1);

        assertFalse(premium.hasPremium(alice));

        vm.prank(bob);
        premium.activateNFTPremium();
        vm.warp(132); // advance past MIN_ACTIVATION_DELAY from bob's activation at 116
        assertTrue(premium.hasPremium(bob));
    }

    // ===== TREASURY CHANGE TIMELOCK (AUDIT FIX #68) =====

    function test_proposeTreasuryChange() public {
        address newTreasury = makeAddr("newTreasury");
        premium.proposeTreasuryChange(newTreasury);
        assertEq(premium.pendingTreasury(), newTreasury);
    }

    function test_executeTreasuryChange() public {
        address newTreasury = makeAddr("newTreasury");
        premium.proposeTreasuryChange(newTreasury);
        vm.warp(block.timestamp + 48 hours + 1);
        premium.executeTreasuryChange();
        assertEq(premium.treasury(), newTreasury);
    }

    function test_revert_executeTreasuryChange_tooEarly() public {
        premium.proposeTreasuryChange(makeAddr("newTreasury"));
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, premium.TREASURY_CHANGE()));
        premium.executeTreasuryChange();
    }

    function test_revert_setTreasury_deprecated() public {
        vm.expectRevert(PremiumAccess.UseProposeTreasuryChange.selector);
        premium.setTreasury(makeAddr("x"));
    }

    // ===== M-17: NFT ACTIVATION DELAY TESTS =====

    function test_hasPremium_nftRequiresMinActivationDelay() public {
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();
        // Immediately after activation (same timestamp), premium should NOT be active
        assertFalse(premium.hasPremium(alice));
    }

    function test_hasPremium_nftDeniedBeforeDelayElapsed() public {
        vm.warp(1000);
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();
        // Advance by less than MIN_ACTIVATION_DELAY (15 seconds)
        vm.warp(1000 + 10);
        assertFalse(premium.hasPremium(alice));
    }

    function test_hasPremium_nftGrantedAfterDelayElapsed() public {
        vm.warp(1000);
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();
        // Advance past MIN_ACTIVATION_DELAY (15 seconds)
        vm.warp(1000 + 16);
        assertTrue(premium.hasPremium(alice));
    }

    function test_hasPremium_nftDeniedAtExactDelay() public {
        vm.warp(1000);
        nft.mint(alice);
        vm.prank(alice);
        premium.activateNFTPremium();
        // At exactly 15 seconds, block.timestamp == activatedAt + delay, NOT >
        vm.warp(1000 + 15);
        assertFalse(premium.hasPremium(alice));
    }

    // ===== totalRevenue NOT INFLATED ON RE-SUBSCRIPTION =====

    function test_totalRevenue_notInflatedOnExtension() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalRevenue(), MONTHLY_FEE);

        // DEEP-DR-L-05: respect MIN_HOLDING_PERIOD before extension.
        vm.warp(block.timestamp + premium.MIN_HOLDING_PERIOD() + 1);

        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        // AUDIT PA-M-01 (2026-04-29) + DEEP-DR-M-06 (2026-05-01): on extension,
        // ONLY the consumed portion of the OLD escrow (~1/30 of MONTHLY_FEE
        // since ~1 day elapsed of 30) is credited to totalRevenue. The
        // unconsumed remainder is rolled into the new per-period escrow.
        //
        // PLUS the new cost (MONTHLY_FEE) is added by the existing M-06
        // unconditional `totalRevenue += cost` line. So total revenue should
        // be approximately:
        //   start: MONTHLY_FEE
        // + consumed portion of OLD escrow: ~MONTHLY_FEE * (1 day / 30 days)
        // + new cost: MONTHLY_FEE
        //   ≈ 2 * MONTHLY_FEE + ~3% of MONTHLY_FEE.
        // Tolerance widened to handle the per-second elapsed slice.
        uint256 expectedConsumed = MONTHLY_FEE * (premium.MIN_HOLDING_PERIOD() + 1) / 30 days;
        uint256 expectedTotal = 2 * MONTHLY_FEE + expectedConsumed;
        assertApproxEqAbs(premium.totalRevenue(), expectedTotal, 1 ether,
            "DEEP-DR-M-06: only consumed portion enters revenue");
    }

    function test_totalRevenue_incrementsOnNewSubscription() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalRevenue(), MONTHLY_FEE);

        // Let subscription expire
        vm.warp(block.timestamp + 31 days);

        // New subscription (not extension)
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.totalRevenue(), 2 * MONTHLY_FEE);
    }

    // ─── AUDIT PA-L-01: reconcileExpired nonReentrant parity ────────────

    /// @notice Happy-path: reconcileExpired clears refundEscrow + decrements
    ///         the subscriber count after expiry. The behavior is unchanged
    ///         by adding nonReentrant; this just confirms the modifier did
    ///         not break the normal path.
    function test_reconcileExpired_clearsEscrowAfterExpiry() public {
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        assertEq(premium.userEscrow(alice), MONTHLY_FEE);
        assertEq(premium.totalRefundEscrow(), MONTHLY_FEE);
        assertTrue(premium.isActiveSubscriber(alice));

        // Expire the subscription
        vm.warp(block.timestamp + 31 days);

        // Anyone can call (bob does)
        vm.prank(bob);
        premium.reconcileExpired(alice);

        assertEq(premium.userEscrow(alice), 0, "PA-L-01: escrow cleared");
        assertEq(premium.totalRefundEscrow(), 0, "PA-L-01: totalRefundEscrow cleared");
        assertFalse(premium.isActiveSubscriber(alice), "PA-L-01: subscriber-flag cleared");
    }

    /// @notice Storage-level proof that `reconcileExpired` honours the OZ
    ///         ReentrancyGuard. We seed the OZ ERC-7201 storage slot to
    ///         `ENTERED` (mid-call state) and confirm the function reverts.
    ///         Pre-fix (no nonReentrant) the function would happily proceed;
    ///         post-fix it reverts with `ReentrancyGuardReentrantCall`. This
    ///         is a direct test of the modifier wire, not a behavior proxy.
    function test_reconcileExpired_revertsWhenGuardEntered() public {
        // Stage: alice has an expired escrow ready to reconcile.
        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        vm.warp(block.timestamp + 31 days);

        // OZ v5.5 ReentrancyGuard storage slot (precomputed ERC-7201):
        // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ReentrancyGuard")) - 1)) & ~bytes32(uint256(0xff))
        bytes32 guardSlot = 0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00;
        bytes32 entered = bytes32(uint256(2));
        bytes32 notEntered = bytes32(uint256(1));

        // Sanity: pre-state is NOT_ENTERED.
        assertEq(vm.load(address(premium), guardSlot), notEntered, "PA-L-01: pre-state NOT_ENTERED");

        // Set the guard to ENTERED, then attempt reconcileExpired — must revert.
        vm.store(address(premium), guardSlot, entered);
        vm.expectRevert(); // OZ ReentrancyGuardReentrantCall
        premium.reconcileExpired(alice);

        // Restore guard so subsequent assertions don't bleed into other tests.
        vm.store(address(premium), guardSlot, notEntered);
    }

    receive() external payable {}
}
