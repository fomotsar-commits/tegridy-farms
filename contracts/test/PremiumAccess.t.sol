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

        vm.warp(block.timestamp + 1); // advance past startedAt to satisfy ALREADY_SUBSCRIBED_THIS_BLOCK check

        vm.prank(alice);
        premium.subscribe(1, type(uint256).max); // extend
        // Approximate: 1 second elapsed consumes a tiny fraction of escrow from first subscription
        assertApproxEqAbs(premium.userEscrow(alice), 2 * MONTHLY_FEE, 1 ether);
        assertApproxEqAbs(premium.totalRefundEscrow(), 2 * MONTHLY_FEE, 1 ether);
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

        vm.warp(block.timestamp + 1); // advance past startedAt to satisfy SAME_BLOCK_CANCEL check

        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        premium.cancelSubscription();
        uint256 refund = token.balanceOf(alice) - aliceBefore;

        assertApproxEqAbs(refund, MONTHLY_FEE, 10 ether);
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

        vm.warp(block.timestamp + 1);

        vm.prank(alice);
        premium.subscribe(1, type(uint256).max);
        // totalRevenue should still be MONTHLY_FEE (extension doesn't add revenue)
        assertEq(premium.totalRevenue(), MONTHLY_FEE);
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

    receive() external payable {}
}
