// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/ReferralSplitter.sol";

contract ReferralSplitterTest is Test {
    ReferralSplitter public ref;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");

    function setUp() public {
        ref = new ReferralSplitter(1000); // 10% referral fee
        vm.deal(address(this), 100 ether);
    }

    // ─── Set Referrer ─────────────────────────────────────────────────

    function test_setReferrer() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        assertEq(ref.referrerOf(alice), bob);
        assertEq(ref.totalReferred(bob), 1);
    }

    function test_revert_selfReferral() public {
        vm.prank(alice);
        vm.expectRevert(ReferralSplitter.SelfReferral.selector);
        ref.setReferrer(alice);
    }

    function test_revert_doubleReferral() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        vm.prank(alice);
        vm.expectRevert(ReferralSplitter.AlreadyReferred.selector);
        ref.setReferrer(carol);
    }

    function test_revert_zeroReferrer() public {
        vm.prank(alice);
        vm.expectRevert(ReferralSplitter.ZeroAddress.selector);
        ref.setReferrer(address(0));
    }

    // ─── Fee Recording ────────────────────────────────────────────────

    function test_recordFee_creditsReferrer() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        // Record 1 ETH fee for alice → bob gets 10% = 0.1 ETH
        ref.recordFee{value: 1 ether}(alice);

        assertEq(ref.pendingETH(bob), 0.1 ether);
        assertEq(ref.totalEarned(bob), 0.1 ether);
    }

    function test_recordFee_noReferrer_noCredit() public {
        // Carol has no referrer
        ref.recordFee{value: 1 ether}(carol);

        // Nobody gets credited
        assertEq(ref.totalReferralsPaid(), 0);
    }

    function test_recordFee_multipleFees() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        ref.recordFee{value: 1 ether}(alice);
        ref.recordFee{value: 2 ether}(alice);

        assertEq(ref.pendingETH(bob), 0.3 ether); // 10% of 3 ETH total
    }

    // ─── Claiming ─────────────────────────────────────────────────────

    function test_claimReferralRewards() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        ref.recordFee{value: 5 ether}(alice);

        uint256 balBefore = bob.balance;
        vm.prank(bob);
        ref.claimReferralRewards();
        uint256 balAfter = bob.balance;

        assertEq(balAfter - balBefore, 0.5 ether); // 10% of 5 ETH
        assertEq(ref.pendingETH(bob), 0);
    }

    function test_revert_claimNothing() public {
        vm.prank(bob);
        vm.expectRevert(ReferralSplitter.NothingToClaim.selector);
        ref.claimReferralRewards();
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function test_setReferralFee() public {
        ref.setReferralFee(2000); // 20%
        assertEq(ref.referralFeeBps(), 2000);
    }

    function test_revert_feeTooHigh() public {
        vm.expectRevert(ReferralSplitter.FeeTooHigh.selector);
        ref.setReferralFee(3001);
    }

    // ─── View ─────────────────────────────────────────────────────────

    function test_getReferralInfo() public {
        vm.prank(alice);
        ref.setReferrer(bob);
        vm.prank(carol);
        ref.setReferrer(bob);

        ref.recordFee{value: 2 ether}(alice);

        (uint256 referred, uint256 earned, uint256 pending) = ref.getReferralInfo(bob);
        assertEq(referred, 2);
        assertEq(earned, 0.2 ether);
        assertEq(pending, 0.2 ether);
    }

    receive() external payable {}
}
