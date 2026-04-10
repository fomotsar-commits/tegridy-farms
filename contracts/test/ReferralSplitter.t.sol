// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/ReferralSplitter.sol";

// Mock WETH contract for referral tests
contract MockWETHForReferralTest {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

// Mock staking contract for referral tests
contract MockStakingForReferralTest {
    mapping(address => uint256) public power;
    function votingPowerOf(address user) external view returns (uint256) {
        return power[user];
    }
    function setPower(address user, uint256 _power) external {
        power[user] = _power;
    }
}

/// @dev Contract that rejects ETH transfers (no receive/fallback)
contract ETHRejecter {
    function callWithdrawCallerCredit(ReferralSplitter _ref) external {
        _ref.withdrawCallerCredit();
    }

    function callRecordFee(ReferralSplitter _ref, address _user) external payable {
        _ref.recordFee{value: msg.value}(_user);
    }
}

contract ReferralSplitterTest is Test {
    ReferralSplitter public ref;
    MockStakingForReferralTest public mockStaking;
    MockWETHForReferralTest public mockWETH;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");
    address public dave = makeAddr("dave");
    address public treasuryAddr = makeAddr("treasury");

    function setUp() public {
        mockStaking = new MockStakingForReferralTest();
        mockWETH = new MockWETHForReferralTest();
        ref = new ReferralSplitter(1000, address(mockStaking), treasuryAddr, address(mockWETH)); // 10% referral fee
        vm.deal(address(this), 100 ether);
        mockStaking.setPower(bob, 1000e18);
        mockStaking.setPower(carol, 1000e18);
    }

    // ===== SELF-REFERRAL PREVENTION =====

    function test_revert_selfReferral() public {
        vm.prank(alice);
        vm.expectRevert(ReferralSplitter.SelfReferral.selector);
        ref.setReferrer(alice);
    }

    function test_revert_selfReferral_onUpdate() public {
        vm.prank(alice);
        ref.setReferrer(bob);
        vm.warp(block.timestamp + 30 days + 1);

        vm.prank(alice);
        vm.expectRevert(ReferralSplitter.SelfReferral.selector);
        ref.updateReferrer(alice);
    }

    // ===== SET REFERRER =====

    function test_setReferrer() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        assertEq(ref.referrerOf(alice), bob);
        assertEq(ref.totalReferred(bob), 1);
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

    // ===== recordFee REDIRECTS TO TREASURY WHEN REFERRER IS INVALID/UNSTAKED =====

    function test_recordFee_noReferrer_sendsToTreasury() public {
        uint256 treasuryBefore = treasuryAddr.balance;
        ref.recordFee{value: 1 ether}(carol); // carol has no referrer

        // referralShare should go to treasury
        assertEq(ref.totalReferralsPaid(), 0); // not counted as referral
    }

    function test_recordFee_referrerUnstaked_sendsToTreasury() public {
        // Alice sets dave as referrer (dave has no staking power)
        vm.prank(alice);
        ref.setReferrer(dave);

        ref.recordFee{value: 1 ether}(alice);

        // dave is unstaked, so referral share accumulated for treasury (pull-pattern)
        uint256 referrerShare = (1 ether * 1000) / 10000; // 0.1 ETH
        assertEq(ref.accumulatedTreasuryETH(), referrerShare);
        assertEq(ref.pendingETH(dave), 0); // dave gets nothing
        assertEq(ref.totalReferralsPaid(), 0); // not counted
    }

    function test_recordFee_referrerStaked_creditsReferrer() public {
        vm.prank(alice);
        ref.setReferrer(bob); // bob has staking power

        ref.recordFee{value: 1 ether}(alice);

        assertEq(ref.pendingETH(bob), 0.1 ether);
        assertEq(ref.totalReferralsPaid(), 0.1 ether);
    }

    // ===== CLAIM REQUIRES STAKED POSITION (SECURITY FIX #16) =====

    function test_claimReferralRewards_withStake() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        ref.recordFee{value: 5 ether}(alice);

        vm.warp(block.timestamp + 7 days + 1);

        uint256 balBefore = bob.balance;
        vm.prank(bob);
        ref.claimReferralRewards();

        assertEq(bob.balance - balBefore, 0.5 ether);
        assertEq(ref.pendingETH(bob), 0);
    }

    function test_claimReferralRewards_succeedsEvenWithoutStake() public {
        // SECURITY FIX H1: Earned referral rewards must be claimable even after unstaking.
        // Stake check only applies to EARNING new referrals (in recordFee), not claiming.
        // (Curve/Convex pattern — earned rewards are unconditionally claimable)
        address eve = makeAddr("eve");
        vm.prank(eve);
        ref.setReferrer(bob);
        ref.recordFee{value: 5 ether}(eve);

        // Verify bob has pending ETH
        uint256 pending = ref.pendingETH(bob);
        assertGt(pending, 0);

        // Remove bob's staking power
        mockStaking.setPower(bob, 0);

        // Warp past MIN_REFERRAL_AGE (7 days)
        vm.warp(block.timestamp + 8 days);

        // Bob should STILL be able to claim earned rewards
        vm.prank(bob);
        ref.claimReferralRewards();
        assertEq(ref.pendingETH(bob), 0, "Pending should be zero after claim");
    }

    function test_revert_claimReferralRewards_nothingToClaim() public {
        // Bob has never been set as a referrer, so referralAge check fires first
        vm.prank(bob);
        vm.expectRevert(ReferralSplitter.ReferralAgeTooRecent.selector);
        ref.claimReferralRewards();
    }

    // ===== UPDATE REFERRER COOLDOWN =====

    function test_updateReferrer() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        vm.warp(block.timestamp + 30 days + 1);

        vm.prank(alice);
        ref.updateReferrer(carol);

        assertEq(ref.referrerOf(alice), carol);
        assertEq(ref.totalReferred(bob), 0);
        assertEq(ref.totalReferred(carol), 1);
    }

    function test_revert_updateReferrer_cooldownNotElapsed() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        vm.warp(block.timestamp + 15 days);

        vm.prank(alice);
        vm.expectRevert(ReferralSplitter.CooldownNotElapsed.selector);
        ref.updateReferrer(carol);
    }

    function test_revert_updateReferrer_noExistingReferrer() public {
        vm.prank(alice);
        vm.expectRevert(ReferralSplitter.NoReferrerSet.selector);
        ref.updateReferrer(carol);
    }

    function test_updateReferrer_consecutiveUpdates_respectCooldown() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        uint256 t1 = block.timestamp + 31 days;
        vm.warp(t1);
        vm.prank(alice);
        ref.updateReferrer(carol);

        // Immediately try again
        vm.prank(alice);
        vm.expectRevert(ReferralSplitter.CooldownNotElapsed.selector);
        ref.updateReferrer(dave);

        // Wait full cooldown from t1
        vm.warp(t1 + 31 days);
        vm.prank(alice);
        ref.updateReferrer(dave);
        assertEq(ref.referrerOf(alice), dave);
    }

    // ===== ADMIN =====

    function test_setReferralFee() public {
        ref.proposeReferralFee(2000);
        vm.warp(block.timestamp + 24 hours + 1);
        ref.executeReferralFee();
        assertEq(ref.referralFeeBps(), 2000);
    }

    function test_revert_setReferralFee_tooHigh() public {
        vm.expectRevert(ReferralSplitter.FeeTooHigh.selector);
        ref.proposeReferralFee(3001);
    }

    function test_setApprovedCaller() public {
        address feeCollector = makeAddr("feeCollector");
        ref.setApprovedCaller(feeCollector, true);
        assertTrue(ref.approvedCallers(feeCollector));

        ref.setApprovedCaller(feeCollector, false);
        assertFalse(ref.approvedCallers(feeCollector));
    }

    function test_revert_recordFee_notApproved() public {
        address rando = makeAddr("rando");
        vm.deal(rando, 10 ether);

        vm.prank(rando);
        vm.expectRevert(ReferralSplitter.NotApprovedCaller.selector);
        ref.recordFee{value: 1 ether}(alice);
    }

    // ===== WETH FALLBACK: withdrawCallerCredit (M-19) =====

    function test_withdrawCallerCredit_wethFallback() public {
        // Deploy an ETH-rejecting contract as the caller
        ETHRejecter rejecter = new ETHRejecter();
        ref.setApprovedCaller(address(rejecter), true);

        // Use a user with no referrer — referralShare goes to treasury, remainder to callerCredit
        address noRef = makeAddr("noRef");
        rejecter.callRecordFee{value: 1 ether}(ref, noRef);

        // 10% referral fee: 0.1 ETH to treasury, 0.9 ETH to callerCredit
        uint256 expectedCredit = 0.9 ether;
        assertEq(ref.callerCredit(address(rejecter)), expectedCredit);

        // Withdraw — ETH send will fail, should fallback to WETH
        rejecter.callWithdrawCallerCredit(ref);

        // Caller credit should be zeroed
        assertEq(ref.callerCredit(address(rejecter)), 0);
        // WETH should have been sent to the rejecter
        assertEq(mockWETH.balanceOf(address(rejecter)), expectedCredit);
    }

    // ===== WETH FALLBACK: sweepUnclaimable (M-18) =====

    function test_sweepUnclaimable_wethFallback() public {
        // Set treasury to an ETH-rejecting contract
        ETHRejecter rejectingTreasury = new ETHRejecter();

        // Change treasury to the rejecting contract via timelock
        ref.proposeTreasury(address(rejectingTreasury));
        vm.warp(block.timestamp + 48 hours + 1);
        ref.executeTreasury();

        // Send some dust ETH directly to the splitter (not via recordFee)
        vm.deal(address(ref), 1 ether);

        // Sweep — ETH send will fail, should fallback to WETH
        ref.sweepUnclaimable();

        // WETH should have been sent to the rejecting treasury
        assertEq(mockWETH.balanceOf(address(rejectingTreasury)), 1 ether);
    }

    // ===== REFERRAL AGE REQUIREMENT (E-06) =====

    function test_claimRevertsBeforeMinReferralAge() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        ref.setApprovedCaller(address(this), true);
        ref.recordFee{value: 1 ether}(alice);

        vm.prank(bob);
        vm.expectRevert(ReferralSplitter.ReferralAgeTooRecent.selector);
        ref.claimReferralRewards();
    }

    function test_claimSucceedsAfterMinReferralAge() public {
        vm.prank(alice);
        ref.setReferrer(bob);

        ref.setApprovedCaller(address(this), true);
        ref.recordFee{value: 1 ether}(alice);

        vm.warp(block.timestamp + 7 days + 1);

        vm.prank(bob);
        ref.claimReferralRewards();

        assertEq(ref.pendingETH(bob), 0);
    }

    function test_referrerRegisteredAtSetOnFirstReferral() public {
        uint256 ts = block.timestamp;
        vm.prank(alice);
        ref.setReferrer(bob);

        assertEq(ref.referrerRegisteredAt(bob), ts);

        vm.prank(carol);
        ref.setReferrer(bob);

        assertEq(ref.referrerRegisteredAt(bob), ts, "should not change on subsequent referrals");
    }

    receive() external payable {}
}
