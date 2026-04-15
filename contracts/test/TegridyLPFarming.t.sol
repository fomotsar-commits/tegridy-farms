// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyLPFarming.sol";

contract MockLP is ERC20 {
    constructor() ERC20("Tegridy LP", "TLP") { _mint(msg.sender, 100_000_000 ether); }
}

contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
    function burnFrom(address owner, uint256 tokenId) external { require(ownerOf(tokenId) == owner); _burn(tokenId); }
}

/// @title TegridyLPFarming Test Suite
/// @notice Tests for boosted Synthetix-style LP farming contract
contract TegridyLPFarmingTest is Test {
    TegridyLPFarming public farm;
    TegridyStaking public staking;
    MockTOWELI public toweli;
    MockLP public lp;
    MockJBAC public jbac;

    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    uint256 constant REWARD_AMOUNT = 100_000 ether;
    uint256 constant DURATION = 7 days;

    function setUp() public {
        toweli = new MockTOWELI();
        lp = new MockLP();
        jbac = new MockJBAC();

        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1 ether);
        farm = new TegridyLPFarming(address(toweli), address(lp), address(staking), treasury, DURATION);

        lp.transfer(alice, 10_000_000 ether);
        lp.transfer(bob, 10_000_000 ether);
        vm.prank(alice);
        lp.approve(address(farm), type(uint256).max);
        vm.prank(bob);
        lp.approve(address(farm), type(uint256).max);
        toweli.approve(address(farm), type(uint256).max);
    }

    // ── Staking Basics ──────────────────────────────────────────────

    function test_stake_basic() public {
        vm.prank(alice);
        farm.stake(1000 ether);
        assertEq(farm.rawBalanceOf(alice), 1000 ether);
        assertEq(farm.totalRawSupply(), 1000 ether);
        assertGt(farm.effectiveBalanceOf(alice), 0);
    }

    /// @notice Staking 0 reverts
    function test_stake_zeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(TegridyLPFarming.ZeroAmount.selector);
        farm.stake(0);
    }

    // ── Withdrawals ─────────────────────────────────────────────────

    function test_withdraw_basic() public {
        vm.prank(alice);
        farm.stake(1000 ether);
        vm.prank(alice);
        farm.withdraw(500 ether);
        assertEq(farm.rawBalanceOf(alice), 500 ether);
    }

    function test_withdraw_excessReverts() public {
        vm.prank(alice);
        farm.stake(1000 ether);
        vm.prank(alice);
        vm.expectRevert(TegridyLPFarming.InsufficientBalance.selector);
        farm.withdraw(2000 ether);
    }

    // ── Rewards ─────────────────────────────────────────────────────

    function test_getReward_accumulatesCorrectly() public {
        farm.notifyRewardAmount(REWARD_AMOUNT, DURATION);
        vm.prank(alice);
        farm.stake(1000 ether);
        vm.warp(block.timestamp + 1 days);
        assertGt(farm.earned(alice), 0, "Should have accumulated rewards");
    }

    function test_getReward_claimsToUser() public {
        farm.notifyRewardAmount(REWARD_AMOUNT, DURATION);
        vm.prank(alice);
        farm.stake(1000 ether);
        vm.warp(block.timestamp + 3 days);
        uint256 balBefore = toweli.balanceOf(alice);
        vm.prank(alice);
        farm.getReward();
        assertGt(toweli.balanceOf(alice), balBefore, "User should receive TOWELI");
    }

    function test_notifyRewardAmount() public {
        farm.notifyRewardAmount(REWARD_AMOUNT, DURATION);
        assertGt(farm.rewardRate(), 0, "Reward rate should be set");
        assertEq(farm.periodFinish(), block.timestamp + DURATION);
    }

    function test_notifyRewardAmount_nonOwnerReverts() public {
        toweli.transfer(alice, REWARD_AMOUNT);
        vm.startPrank(alice);
        toweli.approve(address(farm), type(uint256).max);
        vm.expectRevert();
        farm.notifyRewardAmount(REWARD_AMOUNT, DURATION);
        vm.stopPrank();
    }

    // ── Emergency Withdraw ──────────────────────────────────────────

    function test_emergencyWithdraw() public {
        farm.notifyRewardAmount(REWARD_AMOUNT, DURATION);
        vm.prank(alice);
        farm.stake(1000 ether);
        vm.warp(block.timestamp + 2 days);
        assertGt(farm.earned(alice), 0, "Should have pending rewards");
        uint256 lpBefore = lp.balanceOf(alice);
        vm.prank(alice);
        farm.emergencyWithdraw();
        assertEq(farm.rawBalanceOf(alice), 0);
        assertEq(lp.balanceOf(alice), lpBefore + 1000 ether);
        assertEq(farm.rewards(alice), 0);
    }

    // ── Multi-User Distribution ─────────────────────────────────────

    function test_multipleStakers_fairDistribution() public {
        farm.notifyRewardAmount(REWARD_AMOUNT, DURATION);
        vm.prank(alice);
        farm.stake(1000 ether);
        vm.prank(bob);
        farm.stake(1000 ether);
        vm.warp(block.timestamp + 3 days);
        // Allow 1% tolerance for rounding (Alice staked 1 block earlier)
        assertApproxEqRel(farm.earned(alice), farm.earned(bob), 0.01e18);
    }

    // ── Boost Integration ───────────────────────────────────────────

    function test_boost_withStakingPosition() public {
        toweli.transfer(alice, 500_000 ether);
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(500_000 ether, 365 days);
        vm.stopPrank();
        vm.prank(alice);
        farm.stake(1000 ether);
        assertGt(farm.effectiveBalanceOf(alice), farm.rawBalanceOf(alice));
    }

    function test_boost_withoutStakingPosition() public {
        vm.prank(bob);
        farm.stake(1000 ether);
        assertEq(farm.effectiveBalanceOf(bob), farm.rawBalanceOf(bob));
    }

    function test_refreshBoost() public {
        vm.prank(alice);
        farm.stake(1000 ether);
        uint256 effectiveBefore = farm.effectiveBalanceOf(alice);
        toweli.transfer(alice, 500_000 ether);
        vm.startPrank(alice);
        toweli.approve(address(staking), type(uint256).max);
        staking.stake(500_000 ether, 365 days);
        vm.stopPrank();
        farm.refreshBoost(alice);
        assertGt(farm.effectiveBalanceOf(alice), effectiveBefore);
    }

    // ── Pause ───────────────────────────────────────────────────────

    function test_pause_blocksStake() public {
        farm.pause();
        vm.prank(alice);
        vm.expectRevert();
        farm.stake(1000 ether);
    }

    // ── Reward Rate Cap ──────────────────────────────────────────────

    function test_rewardRate_cappedAtMax() public {
        uint256 hugeAmount = 101e18 * 86400; // exceeds MAX_REWARD_RATE at 1-day duration
        toweli.approve(address(farm), type(uint256).max);
        vm.expectRevert(TegridyLPFarming.RewardRateExceedsCap.selector);
        farm.notifyRewardAmount(hugeAmount, 1 days);
    }
}
