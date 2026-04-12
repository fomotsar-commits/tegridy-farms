// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/LPFarming.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Simple mock ERC20 for testing
contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 100_000_000e18);
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract LPFarmingTest is Test {
    LPFarming public farm;
    MockERC20 public rewardToken;
    MockERC20 public stakingToken;
    MockERC20 public strayToken;

    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public treasury = address(0x7EA50);
    address public owner;

    uint256 public constant REWARDS_DURATION = 7 days;
    uint256 public constant REWARD_AMOUNT = 70_000e18; // 10k/day for 7 days

    function setUp() public {
        owner = address(this);
        rewardToken = new MockERC20("Towelie", "TOWELI");
        stakingToken = new MockERC20("Tegridy LP", "TGLP");
        strayToken = new MockERC20("Stray", "STRAY");

        farm = new LPFarming(
            address(rewardToken),
            address(stakingToken),
            treasury,
            REWARDS_DURATION
        );

        // Distribute LP tokens to users
        stakingToken.transfer(alice, 10_000e18);
        stakingToken.transfer(bob, 10_000e18);

        // Approve farm for users
        vm.prank(alice);
        stakingToken.approve(address(farm), type(uint256).max);
        vm.prank(bob);
        stakingToken.approve(address(farm), type(uint256).max);
    }

    /// @dev Helper: fund rewards and start period
    function _fundRewards(uint256 amount) internal {
        rewardToken.approve(address(farm), amount);
        farm.notifyRewardAmount(amount);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  CONSTRUCTOR                                                ║
    // ═══════════════════════════════════════════════════════════════

    function test_constructor() public view {
        assertEq(address(farm.rewardToken()), address(rewardToken));
        assertEq(address(farm.stakingToken()), address(stakingToken));
        assertEq(farm.treasury(), treasury);
        assertEq(farm.rewardsDuration(), REWARDS_DURATION);
        assertEq(farm.owner(), owner);
    }

    function test_constructor_revertZeroRewardToken() public {
        vm.expectRevert(LPFarming.ZeroAddress.selector);
        new LPFarming(address(0), address(stakingToken), treasury, REWARDS_DURATION);
    }

    function test_constructor_revertZeroStakingToken() public {
        vm.expectRevert(LPFarming.ZeroAddress.selector);
        new LPFarming(address(rewardToken), address(0), treasury, REWARDS_DURATION);
    }

    function test_constructor_revertZeroTreasury() public {
        vm.expectRevert(LPFarming.ZeroAddress.selector);
        new LPFarming(address(rewardToken), address(stakingToken), address(0), REWARDS_DURATION);
    }

    function test_constructor_revertDurationTooShort() public {
        vm.expectRevert(LPFarming.DurationOutOfRange.selector);
        new LPFarming(address(rewardToken), address(stakingToken), treasury, 1 hours);
    }

    function test_constructor_revertDurationTooLong() public {
        vm.expectRevert(LPFarming.DurationOutOfRange.selector);
        new LPFarming(address(rewardToken), address(stakingToken), treasury, 91 days);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  STAKE                                                      ║
    // ═══════════════════════════════════════════════════════════════

    function test_stake() public {
        vm.prank(alice);
        farm.stake(1000e18);
        assertEq(farm.balanceOf(alice), 1000e18);
        assertEq(farm.totalSupply(), 1000e18);
        assertEq(stakingToken.balanceOf(alice), 9000e18);
    }

    function test_stake_emitsEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit LPFarming.Staked(alice, 1000e18);
        farm.stake(1000e18);
    }

    function test_stake_revertZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(LPFarming.ZeroAmount.selector);
        farm.stake(0);
    }

    function test_stake_revertWhenPaused() public {
        farm.pause();
        vm.prank(alice);
        vm.expectRevert();
        farm.stake(1000e18);
    }

    function test_stake_multipleUsers() public {
        vm.prank(alice);
        farm.stake(3000e18);
        vm.prank(bob);
        farm.stake(1000e18);
        assertEq(farm.totalSupply(), 4000e18);
        assertEq(farm.balanceOf(alice), 3000e18);
        assertEq(farm.balanceOf(bob), 1000e18);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  WITHDRAW                                                   ║
    // ═══════════════════════════════════════════════════════════════

    function test_withdraw() public {
        vm.prank(alice);
        farm.stake(1000e18);

        vm.prank(alice);
        farm.withdraw(500e18);
        assertEq(farm.balanceOf(alice), 500e18);
        assertEq(farm.totalSupply(), 500e18);
        assertEq(stakingToken.balanceOf(alice), 9500e18);
    }

    function test_withdraw_full() public {
        vm.prank(alice);
        farm.stake(1000e18);

        vm.prank(alice);
        farm.withdraw(1000e18);
        assertEq(farm.balanceOf(alice), 0);
        assertEq(farm.totalSupply(), 0);
    }

    function test_withdraw_revertZero() public {
        vm.prank(alice);
        vm.expectRevert(LPFarming.ZeroAmount.selector);
        farm.withdraw(0);
    }

    function test_withdraw_revertInsufficientBalance() public {
        vm.prank(alice);
        farm.stake(1000e18);
        vm.prank(alice);
        vm.expectRevert(LPFarming.InsufficientBalance.selector);
        farm.withdraw(1001e18);
    }

    function test_withdraw_allowedWhenPaused() public {
        vm.prank(alice);
        farm.stake(1000e18);
        farm.pause();
        vm.prank(alice);
        farm.withdraw(1000e18); // Should not revert
        assertEq(farm.balanceOf(alice), 0);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  REWARDS                                                    ║
    // ═══════════════════════════════════════════════════════════════

    function test_getReward_afterTimeElapsed() public {
        vm.prank(alice);
        farm.stake(1000e18);
        _fundRewards(REWARD_AMOUNT);

        vm.warp(block.timestamp + 1 days);

        uint256 pending = farm.earned(alice);
        assertGt(pending, 0);

        uint256 balBefore = rewardToken.balanceOf(alice);
        vm.prank(alice);
        farm.getReward();
        uint256 received = rewardToken.balanceOf(alice) - balBefore;
        assertGt(received, 0);
        assertApproxEqRel(received, REWARD_AMOUNT / 7, 0.01e18); // ~1/7 of total
    }

    function test_getReward_zeroWhenNoStake() public {
        _fundRewards(REWARD_AMOUNT);
        vm.warp(block.timestamp + 1 days);

        assertEq(farm.earned(alice), 0);
    }

    function test_getReward_proportionalDistribution() public {
        // Alice stakes 3x, Bob stakes 1x — alice should get 3x rewards
        vm.prank(alice);
        farm.stake(3000e18);
        vm.prank(bob);
        farm.stake(1000e18);

        _fundRewards(REWARD_AMOUNT);
        vm.warp(block.timestamp + 7 days + 1);

        uint256 aliceEarned = farm.earned(alice);
        uint256 bobEarned = farm.earned(bob);

        // Alice should earn ~3x bob (within 1% tolerance)
        assertApproxEqRel(aliceEarned, bobEarned * 3, 0.01e18);
        // Total should be ~REWARD_AMOUNT
        assertApproxEqRel(aliceEarned + bobEarned, REWARD_AMOUNT, 0.01e18);
    }

    function test_getReward_allowedWhenPaused() public {
        vm.prank(alice);
        farm.stake(1000e18);
        _fundRewards(REWARD_AMOUNT);
        vm.warp(block.timestamp + 1 days);

        farm.pause();
        vm.prank(alice);
        farm.getReward(); // Should not revert
    }

    function test_earned_matchesClaim() public {
        vm.prank(alice);
        farm.stake(1000e18);
        _fundRewards(REWARD_AMOUNT);
        vm.warp(block.timestamp + 3 days);

        uint256 expectedReward = farm.earned(alice);
        uint256 balBefore = rewardToken.balanceOf(alice);
        vm.prank(alice);
        farm.getReward();
        uint256 actualReward = rewardToken.balanceOf(alice) - balBefore;

        assertEq(actualReward, expectedReward);
    }

    function test_rewardsCappedByBalance() public {
        vm.prank(alice);
        farm.stake(1000e18);
        _fundRewards(REWARD_AMOUNT);

        // Warp way past period end
        vm.warp(block.timestamp + 30 days);

        uint256 earned = farm.earned(alice);
        // Should not exceed funded amount
        assertLe(earned, REWARD_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  EXIT                                                       ║
    // ═══════════════════════════════════════════════════════════════

    function test_exit() public {
        vm.prank(alice);
        farm.stake(1000e18);
        _fundRewards(REWARD_AMOUNT);
        vm.warp(block.timestamp + 3 days);

        uint256 lpBefore = stakingToken.balanceOf(alice);
        uint256 rewardBefore = rewardToken.balanceOf(alice);

        vm.prank(alice);
        farm.exit();

        assertEq(farm.balanceOf(alice), 0);
        assertEq(stakingToken.balanceOf(alice), lpBefore + 1000e18);
        assertGt(rewardToken.balanceOf(alice), rewardBefore);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  EMERGENCY WITHDRAW                                         ║
    // ═══════════════════════════════════════════════════════════════

    function test_emergencyWithdraw() public {
        vm.prank(alice);
        farm.stake(1000e18);
        _fundRewards(REWARD_AMOUNT);
        vm.warp(block.timestamp + 3 days);

        uint256 pendingBefore = farm.earned(alice);
        assertGt(pendingBefore, 0);

        vm.prank(alice);
        farm.emergencyWithdraw();

        assertEq(farm.balanceOf(alice), 0);
        assertEq(farm.totalSupply(), 0);
        assertEq(stakingToken.balanceOf(alice), 10_000e18); // All LP back
        // Rewards forfeited
        assertEq(farm.earned(alice), 0);
    }

    function test_emergencyWithdraw_revertZeroBalance() public {
        vm.prank(alice);
        vm.expectRevert(LPFarming.ZeroAmount.selector);
        farm.emergencyWithdraw();
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  NOTIFY REWARD AMOUNT                                       ║
    // ═══════════════════════════════════════════════════════════════

    function test_notifyRewardAmount() public {
        _fundRewards(REWARD_AMOUNT);
        assertEq(farm.periodFinish(), block.timestamp + REWARDS_DURATION);
        assertEq(farm.rewardRate(), REWARD_AMOUNT / REWARDS_DURATION);
        assertEq(farm.totalRewardsFunded(), REWARD_AMOUNT);
    }

    function test_notifyRewardAmount_onlyOwner() public {
        // Only owner can fund
        rewardToken.transfer(alice, REWARD_AMOUNT);
        vm.startPrank(alice);
        rewardToken.approve(address(farm), REWARD_AMOUNT);
        vm.expectRevert();
        farm.notifyRewardAmount(REWARD_AMOUNT);
        vm.stopPrank();
    }

    function test_notifyRewardAmount_revertBelowMinimum() public {
        rewardToken.approve(address(farm), 999e18);
        vm.expectRevert(LPFarming.NotifyAmountTooSmall.selector);
        farm.notifyRewardAmount(999e18);
    }

    function test_notifyRewardAmount_rolloverExisting() public {
        _fundRewards(REWARD_AMOUNT);

        // Half way through period, add more
        vm.warp(block.timestamp + 3.5 days);

        uint256 newAmount = 35_000e18;
        rewardToken.approve(address(farm), newAmount);
        farm.notifyRewardAmount(newAmount);

        // Rate should include leftover + new
        assertGt(farm.rewardRate(), 0);
        assertEq(farm.periodFinish(), block.timestamp + REWARDS_DURATION);
    }

    function test_getRewardForDuration() public {
        _fundRewards(REWARD_AMOUNT);
        uint256 rewardForDuration = farm.rewardRate() * farm.rewardsDuration();
        assertApproxEqRel(rewardForDuration, REWARD_AMOUNT, 0.01e18);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  TIMELOCKED ADMIN — REWARDS DURATION                        ║
    // ═══════════════════════════════════════════════════════════════

    function test_proposeRewardsDurationChange() public {
        farm.proposeRewardsDurationChange(14 days);
        assertEq(farm.pendingRewardsDuration(), 14 days);
        assertTrue(farm.hasPendingProposal(farm.REWARDS_DURATION_CHANGE()));
    }

    function test_executeRewardsDurationChange() public {
        farm.proposeRewardsDurationChange(14 days);
        vm.warp(block.timestamp + 24 hours + 1);
        farm.executeRewardsDurationChange();
        assertEq(farm.rewardsDuration(), 14 days);
        assertEq(farm.pendingRewardsDuration(), 0);
    }

    function test_rewardsDuration_revertBeforeTimelock() public {
        farm.proposeRewardsDurationChange(14 days);
        vm.expectRevert();
        farm.executeRewardsDurationChange();
    }

    function test_rewardsDuration_revertDuringActivePeriod() public {
        _fundRewards(REWARD_AMOUNT);
        vm.expectRevert(LPFarming.PreviousPeriodNotComplete.selector);
        farm.proposeRewardsDurationChange(14 days);
    }

    function test_cancelRewardsDurationProposal() public {
        farm.proposeRewardsDurationChange(14 days);
        farm.cancelRewardsDurationProposal();
        assertEq(farm.pendingRewardsDuration(), 0);
        assertFalse(farm.hasPendingProposal(farm.REWARDS_DURATION_CHANGE()));
    }

    function test_rewardsDuration_revertNonOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        farm.proposeRewardsDurationChange(14 days);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  TIMELOCKED ADMIN — TREASURY                                ║
    // ═══════════════════════════════════════════════════════════════

    function test_proposeTreasuryChange() public {
        address newTreasury = address(0xDA0);
        farm.proposeTreasuryChange(newTreasury);
        assertEq(farm.pendingTreasury(), newTreasury);
    }

    function test_executeTreasuryChange() public {
        address newTreasury = address(0xDA0);
        farm.proposeTreasuryChange(newTreasury);
        vm.warp(block.timestamp + 48 hours + 1);
        farm.executeTreasuryChange();
        assertEq(farm.treasury(), newTreasury);
    }

    function test_treasury_revertBeforeTimelock() public {
        farm.proposeTreasuryChange(address(0xDA0));
        vm.expectRevert();
        farm.executeTreasuryChange();
    }

    function test_treasury_revertZeroAddress() public {
        vm.expectRevert(LPFarming.ZeroAddress.selector);
        farm.proposeTreasuryChange(address(0));
    }

    function test_cancelTreasuryProposal() public {
        farm.proposeTreasuryChange(address(0xDA0));
        farm.cancelTreasuryProposal();
        assertEq(farm.pendingTreasury(), address(0));
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  PAUSE                                                      ║
    // ═══════════════════════════════════════════════════════════════

    function test_pause_blocksStake() public {
        farm.pause();
        vm.prank(alice);
        vm.expectRevert();
        farm.stake(1000e18);
    }

    function test_pause_allowsWithdrawAndClaim() public {
        vm.prank(alice);
        farm.stake(1000e18);
        _fundRewards(REWARD_AMOUNT);
        vm.warp(block.timestamp + 1 days);

        farm.pause();

        vm.startPrank(alice);
        farm.withdraw(500e18); // Should work
        farm.getReward(); // Should work
        vm.stopPrank();
    }

    function test_unpause() public {
        farm.pause();
        farm.unpause();
        vm.prank(alice);
        farm.stake(1000e18); // Should work
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  RECOVER ERC20                                              ║
    // ═══════════════════════════════════════════════════════════════

    function test_recoverERC20() public {
        strayToken.transfer(address(farm), 5000e18);
        farm.recoverERC20(address(strayToken), 5000e18);
        assertEq(strayToken.balanceOf(treasury), 5000e18);
    }

    function test_recoverERC20_revertStakingToken() public {
        vm.expectRevert(LPFarming.CannotRecoverStakingToken.selector);
        farm.recoverERC20(address(stakingToken), 1e18);
    }

    function test_recoverERC20_revertRewardToken() public {
        vm.expectRevert(LPFarming.CannotRecoverRewardToken.selector);
        farm.recoverERC20(address(rewardToken), 1e18);
    }

    function test_recoverERC20_revertNonOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        farm.recoverERC20(address(strayToken), 1e18);
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  VIEW HELPERS                                               ║
    // ═══════════════════════════════════════════════════════════════

    function test_lastTimeRewardApplicable() public {
        assertEq(farm.lastTimeRewardApplicable(), 0); // periodFinish = 0

        _fundRewards(REWARD_AMOUNT);
        assertEq(farm.lastTimeRewardApplicable(), block.timestamp);

        vm.warp(block.timestamp + 3 days);
        assertEq(farm.lastTimeRewardApplicable(), block.timestamp);

        vm.warp(block.timestamp + 30 days); // past periodFinish
        assertEq(farm.lastTimeRewardApplicable(), farm.periodFinish());
    }

    // ═══════════════════════════════════════════════════════════════
    // ║  FUZZ                                                       ║
    // ═══════════════════════════════════════════════════════════════

    function testFuzz_stakeWithdrawCycle(uint256 amount) public {
        amount = bound(amount, 1, 10_000e18);

        vm.startPrank(alice);
        farm.stake(amount);
        assertEq(farm.balanceOf(alice), amount);

        farm.withdraw(amount);
        assertEq(farm.balanceOf(alice), 0);
        vm.stopPrank();
    }

    function testFuzz_rewardDistribution(uint256 aliceAmt, uint256 bobAmt) public {
        aliceAmt = bound(aliceAmt, 1e18, 10_000e18);
        bobAmt = bound(bobAmt, 1e18, 10_000e18);

        vm.prank(alice);
        farm.stake(aliceAmt);
        vm.prank(bob);
        farm.stake(bobAmt);

        _fundRewards(REWARD_AMOUNT);
        vm.warp(block.timestamp + 7 days + 1);

        uint256 aliceEarned = farm.earned(alice);
        uint256 bobEarned = farm.earned(bob);
        uint256 totalEarned = aliceEarned + bobEarned;

        // Total earned should approximate total rewards (within 1%)
        assertApproxEqRel(totalEarned, REWARD_AMOUNT, 0.01e18);

        // Ratio should match stake ratio
        if (aliceAmt > 0 && bobAmt > 0) {
            uint256 expectedRatio = (aliceAmt * 1e18) / bobAmt;
            uint256 actualRatio = (aliceEarned * 1e18) / bobEarned;
            assertApproxEqRel(actualRatio, expectedRatio, 0.01e18);
        }
    }

    function testFuzz_multipleNotify(uint256 amount1, uint256 amount2) public {
        amount1 = bound(amount1, 1000e18, 1_000_000e18);
        amount2 = bound(amount2, 1000e18, 1_000_000e18);

        rewardToken.approve(address(farm), amount1 + amount2);
        farm.notifyRewardAmount(amount1);

        vm.warp(block.timestamp + 3 days);
        farm.notifyRewardAmount(amount2);

        assertGt(farm.rewardRate(), 0);
        assertEq(farm.periodFinish(), block.timestamp + REWARDS_DURATION);
    }
}
