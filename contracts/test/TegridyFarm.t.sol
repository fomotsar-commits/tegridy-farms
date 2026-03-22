// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/TegridyFarm.sol";
import "../src/FeeDistributor.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock ERC20 for testing
contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1_000_000_000e18);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TegridyFarmTest is Test {
    TegridyFarm public farm;
    FeeDistributor public distributor;
    MockERC20 public toweli;
    MockERC20 public lpToken;

    address public owner = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);

    uint256 public constant REWARD_PER_SECOND = 3.3e18; // ~2M/week
    uint256 public constant FUND_AMOUNT = 26_000_000e18;

    function setUp() public {
        toweli = new MockERC20("Towelie", "TOWELI");
        lpToken = new MockERC20("TOWELI-ETH LP", "TOWELI-LP");

        farm = new TegridyFarm(address(toweli), REWARD_PER_SECOND);

        toweli.approve(address(farm), FUND_AMOUNT);
        farm.fund(FUND_AMOUNT);
        farm.setStartTime(block.timestamp);

        // Add pools: LP pool (60%) and single-sided TOWELI pool (40%)
        farm.addPool(600, IERC20(address(lpToken)));
        farm.addPool(400, IERC20(address(toweli)));

        // Give alice and bob tokens
        lpToken.mint(alice, 1000e18);
        lpToken.mint(bob, 1000e18);
        toweli.mint(alice, 1000e18);
        toweli.mint(bob, 1000e18);

        // Approvals
        vm.prank(alice);
        lpToken.approve(address(farm), type(uint256).max);
        vm.prank(bob);
        lpToken.approve(address(farm), type(uint256).max);
        vm.prank(alice);
        toweli.approve(address(farm), type(uint256).max);
        vm.prank(bob);
        toweli.approve(address(farm), type(uint256).max);
    }

    // ─── Basic Deposit/Withdraw Tests ──────────────────────────────────

    function test_deposit() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 0); // tier 0 = 7 day lock

        (uint256 amount, uint256 boosted,,, uint256 boostBps) = farm.userInfo(0, alice);
        assertEq(amount, 100e18, "Alice should have 100 LP staked");
        assertEq(boosted, 100e18, "Boosted amount should equal amount at 1x");
        assertEq(boostBps, 10000, "Boost should be 10000 bps (1x)");
    }

    function test_depositWithBoost() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 3); // tier 3 = 180 day lock, 5x boost

        (uint256 amount, uint256 boosted,,, uint256 boostBps) = farm.userInfo(0, alice);
        assertEq(amount, 100e18);
        assertEq(boosted, 500e18, "5x boost means 500e18 boosted");
        assertEq(boostBps, 50000);
    }

    function test_withdrawAfterLock() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 0); // 7 day lock

        // Fast forward past lock
        vm.warp(block.timestamp + 7 days + 1);

        vm.prank(alice);
        farm.withdraw(0, 50e18);

        (uint256 amount,,,, ) = farm.userInfo(0, alice);
        assertEq(amount, 50e18, "Alice should have 50 LP staked after withdraw");
    }

    function test_withdrawBeforeLockReverts() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 0); // 7 day lock

        // Try to withdraw during lock
        vm.warp(block.timestamp + 3 days);
        vm.prank(alice);
        vm.expectRevert(TegridyFarm.StillLocked.selector);
        farm.withdraw(0, 50e18);
    }

    function test_withdrawExceedsStake() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 0);

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(alice);
        vm.expectRevert(TegridyFarm.InsufficientStake.selector);
        farm.withdraw(0, 200e18);
    }

    function test_emergencyWithdrawBypassesLock() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 2); // 90 day lock

        // Still locked, but emergency withdraw should work
        vm.warp(block.timestamp + 1 days);

        uint256 lpBefore = lpToken.balanceOf(alice);
        vm.prank(alice);
        farm.emergencyWithdraw(0);

        uint256 lpAfter = lpToken.balanceOf(alice);
        (uint256 amount,,,, ) = farm.userInfo(0, alice);

        assertEq(amount, 0, "Stake should be zero after emergency withdraw");
        assertEq(lpAfter - lpBefore, 100e18, "Should receive all LP tokens back");
    }

    // ─── Lock Tier Tests ────────────────────────────────────────────────

    function test_lockTierInfo() public view {
        (uint256 dur0, uint256 boost0) = farm.lockTierInfo(0);
        (uint256 dur1, uint256 boost1) = farm.lockTierInfo(1);
        (uint256 dur2, uint256 boost2) = farm.lockTierInfo(2);
        (uint256 dur3, uint256 boost3) = farm.lockTierInfo(3);

        assertEq(dur0, 7 days);   assertEq(boost0, 10000); // 1x
        assertEq(dur1, 30 days);  assertEq(boost1, 20000); // 2x
        assertEq(dur2, 90 days);  assertEq(boost2, 30000); // 3x
        assertEq(dur3, 180 days); assertEq(boost3, 50000); // 5x
    }

    function test_invalidLockTierReverts() public {
        vm.prank(alice);
        vm.expectRevert(TegridyFarm.InvalidLockTier.selector);
        farm.deposit(0, 100e18, 4); // tier 4 doesn't exist
    }

    function test_cannotReduceLock() public {
        vm.prank(alice);
        farm.deposit(0, 50e18, 2); // 90 day lock

        // Try to add more with shorter lock (7 days)
        vm.prank(alice);
        vm.expectRevert(TegridyFarm.CannotReduceLock.selector);
        farm.deposit(0, 50e18, 0);
    }

    function test_canExtendLock() public {
        vm.prank(alice);
        farm.deposit(0, 50e18, 0); // 7 day lock

        // Add more with longer lock (90 days) — should work
        vm.prank(alice);
        farm.deposit(0, 50e18, 2);

        (uint256 amount, uint256 boosted,,, uint256 boostBps) = farm.userInfo(0, alice);
        assertEq(amount, 100e18);
        assertEq(boostBps, 30000); // 3x
        assertEq(boosted, 300e18); // 100 * 3x = 300
    }

    // ─── Reward Calculation Tests (with boost) ──────────────────────────

    function test_rewardsAccrueOverTime() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 0); // 1x boost

        vm.warp(block.timestamp + 100);

        uint256 pending = farm.pendingReward(0, alice);
        // Expected: 100s * 3.3e18/s * 600/1000 = 198e18
        assertEq(pending, 198e18, "Pending rewards should match expected");
    }

    function test_boostEarnsMoreRewards() public {
        // Alice stakes 100 with 1x boost
        vm.prank(alice);
        farm.deposit(0, 100e18, 0);

        // Bob stakes same amount with 5x boost
        vm.prank(bob);
        farm.deposit(0, 100e18, 3);

        vm.warp(block.timestamp + 100);

        uint256 alicePending = farm.pendingReward(0, alice);
        uint256 bobPending = farm.pendingReward(0, bob);

        // Alice: 1x out of (1x + 5x) = 1/6 of pool rewards
        // Bob: 5x out of (1x + 5x) = 5/6 of pool rewards
        // Pool rewards for 100s = 100 * 3.3e18 * 600/1000 = 198e18
        // Alice: 198e18 / 6 = 33e18
        // Bob: 198e18 * 5 / 6 = 165e18
        assertEq(alicePending, 33e18, "Alice gets 1/6 of pool rewards");
        assertEq(bobPending, 165e18, "Bob gets 5/6 of pool rewards");
    }

    function test_rewardsSplitBetweenPools() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 0); // LP pool (60%)

        vm.prank(bob);
        farm.deposit(1, 100e18, 0); // TOWELI pool (40%)

        vm.warp(block.timestamp + 100);

        uint256 alicePending = farm.pendingReward(0, alice);
        uint256 bobPending = farm.pendingReward(1, bob);

        assertEq(alicePending, 198e18, "Alice should get 60% of rewards");
        assertEq(bobPending, 132e18, "Bob should get 40% of rewards");
    }

    function test_claimRewards() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 0);

        vm.warp(block.timestamp + 100);

        uint256 balanceBefore = toweli.balanceOf(alice);
        vm.prank(alice);
        farm.claim(0);

        uint256 balanceAfter = toweli.balanceOf(alice);
        assertEq(balanceAfter - balanceBefore, 198e18, "Should receive expected rewards");
    }

    function test_claimResetsDebt() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 0);

        vm.warp(block.timestamp + 100);
        vm.prank(alice);
        farm.claim(0);

        uint256 pending = farm.pendingReward(0, alice);
        assertEq(pending, 0, "Pending should be 0 right after claim");
    }

    // ─── Anti-MEV Tests ─────────────────────────────────────────────────

    function test_mevAttackBlocked() public {
        // Alice is an honest staker
        vm.prank(alice);
        farm.deposit(0, 100e18, 0);

        vm.warp(block.timestamp + 50);

        // MEV bot (Bob) deposits — must lock for 7 days minimum
        vm.prank(bob);
        farm.deposit(0, 1000e18, 0);

        // Bot tries to withdraw immediately — blocked by lock
        vm.prank(bob);
        vm.expectRevert(TegridyFarm.StillLocked.selector);
        farm.withdraw(0, 1000e18);
    }

    function test_sameBlockDepositNoRewards() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 0);

        uint256 pending = farm.pendingReward(0, alice);
        assertEq(pending, 0, "No rewards should accrue in same block as deposit");
    }

    // ─── Auto-Throttle Tests ────────────────────────────────────────────

    function test_effectiveRateNormalConditions() public view {
        // With 26M TOWELI remaining and 3.3/sec rate,
        // threshold = 3.3 * 7 days = 1,995,840 TOWELI
        // remaining (26M) >> threshold, so effective rate = full rate
        assertEq(farm.effectiveRewardPerSecond(), REWARD_PER_SECOND);
    }

    function test_effectiveRateThrottled() public {
        // Create a farm with very little funding
        TegridyFarm smallFarm = new TegridyFarm(address(toweli), 10e18);
        toweli.approve(address(smallFarm), 100e18);
        smallFarm.fund(100e18); // Only 100 TOWELI remaining
        smallFarm.setStartTime(block.timestamp);
        smallFarm.addPool(1000, IERC20(address(lpToken)));

        // threshold = 10e18 * 7 days = 6,048,000e18
        // remaining = 100e18 << threshold
        // effective = 10e18 * 100e18 / 6,048,000e18 ≈ very small
        uint256 effRate = smallFarm.effectiveRewardPerSecond();
        assertLt(effRate, 10e18, "Rate should be throttled");
        assertGt(effRate, 0, "Rate should not be zero");
    }

    function test_throttlePreventsSuddenDepletion() public {
        TegridyFarm smallFarm = new TegridyFarm(address(toweli), 10e18);
        toweli.approve(address(smallFarm), 100e18);
        smallFarm.fund(100e18);
        smallFarm.setStartTime(block.timestamp);
        smallFarm.addPool(1000, IERC20(address(lpToken)));

        vm.prank(alice);
        lpToken.approve(address(smallFarm), 100e18);
        vm.prank(alice);
        smallFarm.deposit(0, 100e18, 0);

        // Without throttle: 100 TOWELI / 10 per sec = depleted in 10 seconds
        // With throttle: rewards taper, never fully deplete
        vm.warp(block.timestamp + 1000);

        uint256 pending = smallFarm.pendingReward(0, alice);
        // Should get most of the 100e18 but not all (throttle slows it down)
        assertGt(pending, 0, "Should have some rewards");
        assertLe(pending, 100e18, "Should not exceed funded amount");
    }

    function test_throttleFairBetweenUsers() public {
        TegridyFarm smallFarm = new TegridyFarm(address(toweli), 10e18);
        toweli.approve(address(smallFarm), 200e18);
        smallFarm.fund(200e18);
        smallFarm.setStartTime(block.timestamp);
        smallFarm.addPool(1000, IERC20(address(lpToken)));

        vm.prank(alice);
        lpToken.approve(address(smallFarm), 100e18);
        vm.prank(bob);
        lpToken.approve(address(smallFarm), 100e18);

        // Both deposit equal amounts
        vm.prank(alice);
        smallFarm.deposit(0, 100e18, 0);
        vm.prank(bob);
        smallFarm.deposit(0, 100e18, 0);

        // Advance far past depletion
        vm.warp(block.timestamp + 10000);

        uint256 alicePending = smallFarm.pendingReward(0, alice);
        uint256 bobPending = smallFarm.pendingReward(0, bob);

        // Both should get approximately equal rewards (equal stake, equal boost)
        assertEq(alicePending, bobPending, "Equal stakers should get equal rewards");
        // Total should not exceed funded amount
        assertLe(alicePending + bobPending, 200e18, "Total should not exceed funded");
    }

    // ─── Owner Functions Tests ─────────────────────────────────────────

    function test_setRewardPerSecond() public {
        farm.setRewardPerSecond(1e18);
        assertEq(farm.rewardPerSecond(), 1e18);
    }

    function test_setRewardPerSecondExceedsMax() public {
        vm.expectRevert(TegridyFarm.ExceedsMaxRewardRate.selector);
        farm.setRewardPerSecond(11e18);
    }

    function test_setPool() public {
        farm.setPool(0, 500);
        assertEq(farm.totalAllocPoint(), 900);
    }

    function test_duplicatePoolReverts() public {
        vm.expectRevert(TegridyFarm.DuplicatePool.selector);
        farm.addPool(100, IERC20(address(lpToken)));
    }

    function test_fund() public {
        uint256 initialRemaining = farm.totalRewardsRemaining();
        toweli.approve(address(farm), 1000e18);
        farm.fund(1000e18);
        assertEq(farm.totalRewardsRemaining(), initialRemaining + 1000e18);
    }

    function test_onlyOwnerCanAddPool() public {
        MockERC20 newToken = new MockERC20("New", "NEW");
        vm.prank(alice);
        vm.expectRevert();
        farm.addPool(100, IERC20(address(newToken)));
    }

    function test_addPoolZeroAllocReverts() public {
        MockERC20 newToken = new MockERC20("New", "NEW");
        vm.expectRevert(TegridyFarm.ZeroAllocPoint.selector);
        farm.addPool(0, IERC20(address(newToken)));
    }

    function test_startTimeCanOnlyBeSetOnce() public {
        vm.expectRevert(TegridyFarm.StartTimeAlreadySet.selector);
        farm.setStartTime(block.timestamp + 1000);
    }

    function test_poolLength() public view {
        assertEq(farm.poolLength(), 2);
    }

    function test_setRewardRateToZero() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 0);

        vm.warp(block.timestamp + 50);
        farm.setRewardPerSecond(0);
        vm.warp(block.timestamp + 50);

        uint256 pending = farm.pendingReward(0, alice);
        assertEq(pending, 99e18, "Only rewards before rate change should accrue");
    }

    // ─── Emergency Withdraw Tests ───────────────────────────────────────

    function test_emergencyWithdrawEmitsForfeited() public {
        vm.prank(alice);
        farm.deposit(0, 100e18, 0);

        vm.warp(block.timestamp + 100);

        uint256 pendingBefore = farm.pendingReward(0, alice);
        assertGt(pendingBefore, 0, "Should have pending rewards");

        uint256 toweliBalanceBefore = toweli.balanceOf(alice);
        vm.prank(alice);
        farm.emergencyWithdraw(0);

        uint256 toweliBalanceAfter = toweli.balanceOf(alice);
        assertEq(toweliBalanceAfter, toweliBalanceBefore, "Emergency withdraw should not pay rewards");
    }

    // ─── FeeDistributor Tests ──────────────────────────────────────────

    function test_distributorSendsFees() public {
        distributor = new FeeDistributor(address(toweli));
        distributor.setFarm(address(farm));

        toweli.transfer(address(distributor), 1000e18);
        uint256 remainingBefore = farm.totalRewardsRemaining();
        distributor.distributeToFarm();

        uint256 remainingAfter = farm.totalRewardsRemaining();
        assertEq(remainingAfter - remainingBefore, 1000e18, "Farm should receive fees");
    }

    function test_distributorRevertNoFarm() public {
        distributor = new FeeDistributor(address(toweli));
        toweli.transfer(address(distributor), 1000e18);

        vm.expectRevert(FeeDistributor.FarmNotSet.selector);
        distributor.distributeToFarm();
    }

    function test_distributorSetFarmRejectsEOA() public {
        distributor = new FeeDistributor(address(toweli));
        vm.expectRevert(FeeDistributor.InvalidFarm.selector);
        distributor.setFarm(address(0xDEAD));
    }

    // ─── Fuzz Tests ────────────────────────────────────────────────────

    function testFuzz_depositWithdraw(uint256 amount) public {
        amount = bound(amount, 1, 1000e18);

        vm.prank(alice);
        farm.deposit(0, amount, 0);

        (uint256 staked,,,,) = farm.userInfo(0, alice);
        assertEq(staked, amount);

        // Wait for lock to expire
        vm.warp(block.timestamp + 7 days + 1);

        vm.prank(alice);
        farm.withdraw(0, amount);

        (staked,,,,) = farm.userInfo(0, alice);
        assertEq(staked, 0);
    }

    function testFuzz_rewardsNeverExceedFunded(uint256 timeElapsed) public {
        timeElapsed = bound(timeElapsed, 1, 365 days);

        vm.prank(alice);
        farm.deposit(0, 100e18, 0);

        vm.warp(block.timestamp + timeElapsed);

        uint256 pending = farm.pendingReward(0, alice);
        assertLe(pending, FUND_AMOUNT, "Rewards should never exceed funded amount");
    }

    function testFuzz_lockTier(uint256 tier) public {
        tier = bound(tier, 0, 3);

        vm.prank(alice);
        farm.deposit(0, 100e18, tier);

        (,uint256 boosted,,,uint256 boostBps) = farm.userInfo(0, alice);

        (uint256 expectedDuration, uint256 expectedBoost) = farm.lockTierInfo(tier);
        assertEq(boostBps, expectedBoost);
        assertEq(boosted, 100e18 * expectedBoost / 10000);
    }
}
