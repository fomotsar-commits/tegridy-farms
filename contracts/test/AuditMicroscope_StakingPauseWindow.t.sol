// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {TegridyStakingAdmin} from "../src/TegridyStakingAdmin.sol";
import {TegridyStakingJbacVault} from "../src/TegridyStakingJbacVault.sol";

contract MockToweli_StakingMicroscope is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MockJBAC_StakingMicroscope is ERC721 {
    constructor() ERC721("JungleBay", "JBAC") {}
}

/// @title AUDIT MICROSCOPE_2026_04_30 — TegridyStaking M-S1 regression (pause window)
/// @notice M-S1: `emergencyWithdrawPosition` is `whenPaused` with no `updateReward`, so it
///         shrinks `totalBoostedStake` without a checkpoint, and the next accrual would price
///         the un-checkpointed stretch over the smaller total, over-crediting whoever stayed.
///         No modifier closes it. The DS2-04 pause-aware accumulator (d6b1f5b1, plus
///         `guardianPause` in 10e1dcc0) does, and it takes all three of its pieces:
///           1. `pause()` / `guardianPause()` settle before pausing, so nothing earned before
///              the pause is priced over the post-withdraw total;
///           2. `StakingRewardLib.accumulateRewards` adds nothing while paused, so a paused
///              caller that does run `updateReward` cannot price the window either;
///           3. `unpause()` resets `lastUpdateTime`, so the first accrual after the pause does
///              not reach back into it.
///         Each test names the pieces it pins. Removing any one of them fails a test here.
contract AuditMicroscope_StakingPauseWindowTest is Test {
    TegridyStaking staking;
    MockToweli_StakingMicroscope token;

    address treasury = makeAddr("treasury");
    address guardian = makeAddr("guardian");
    address bob = makeAddr("bob");     // emergency-withdraws during the pause
    address carol = makeAddr("carol"); // stays staked through the pause
    address dave = makeAddr("dave");   // 7-day lock, exits mid-pause through a path that runs updateReward

    // Storage clock seeded from a literal. via_ir folds `block.timestamp` across `vm.warp`,
    // so the test never reads it back; it only ever warps to this counter.
    uint256 t = 1_000_000;

    function setUp() public {
        token = new MockToweli_StakingMicroscope();
        MockJBAC_StakingMicroscope nft = new MockJBAC_StakingMicroscope();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);
        staking.setStakingAdmin(address(new TegridyStakingAdmin(address(staking))));
        staking.setJbacVault(address(new TegridyStakingJbacVault(address(nft), address(staking))));
        staking.setPauseGuardian(guardian);

        address[3] memory users = [bob, carol, dave];
        for (uint256 i; i < 3; ++i) {
            token.transfer(users[i], 1_000_000 ether);
            vm.prank(users[i]);
            token.approve(address(staking), type(uint256).max);
        }
        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);
        vm.warp(t);
    }

    function _go(uint256 dt) internal {
        t += dt;
        vm.warp(t);
    }

    function _stake(address who, uint256 lock) internal returns (uint256 id, uint256 boosted) {
        uint256 before = staking.totalBoostedStake();
        vm.prank(who);
        staking.stake(100_000 ether, lock);
        id = staking.userTokenId(who);
        boosted = staking.totalBoostedStake() - before;
    }

    /// The M-S1 scenario. Bob and Carol stake, nothing touches rewards for a day, the contract
    /// is paused, Bob emergency-withdraws, it is unpaused three days later, and a day after
    /// that Carol claims. She is owed her share of day 1, all of the day after the unpause
    /// (she is the only staker left), and nothing for the pause window. With all three pieces
    /// gone she is paid all five days over her own stake alone, 3.3x what she is owed.
    function _assertSurvivorPaidExactShare(bool viaGuardian) internal {
        (uint256 bId,) = _stake(bob, 365 days);
        (uint256 cId, uint256 cBoost) = _stake(carol, 365 days);
        uint256 totalBoost = staking.totalBoostedStake();
        uint256 rate = staking.rewardRate();

        _go(1 days);
        if (viaGuardian) {
            vm.prank(guardian);
            staking.guardianPause();
        } else {
            staking.pause();
        }
        vm.prank(bob);
        staking.emergencyWithdrawPosition(bId);

        _go(3 days);
        staking.unpause();
        _go(1 days);

        uint256 before = token.balanceOf(carol);
        vm.prank(carol);
        staking.getReward(cId);
        uint256 paid = token.balanceOf(carol) - before;

        uint256 owed = (1 days * rate * cBoost) / totalBoost + 1 days * rate;
        // The smallest error a removed piece produces is half a day of emission (43,200e18);
        // the tolerance only absorbs the accumulator's per-step rounding.
        assertApproxEqAbs(paid, owed, 1e9, "survivor mis-paid across a pause with an emergency withdraw");
    }

    /// Pins piece 1 on `pause()` (without it day 1 is never settled and Carol is paid one day,
    /// not one and a half) and piece 3 (without it the pause window is priced over Carol alone).
    function test_MS1_survivorPaidExactShare_ownerPause() public {
        _assertSurvivorPaidExactShare(false);
    }

    /// Pins piece 1 on `guardianPause()`, a separate call site with its own settle, and piece 3.
    function test_MS1_survivorPaidExactShare_guardianPause() public {
        _assertSurvivorPaidExactShare(true);
    }

    /// Pins piece 2. `emergencyExitPosition` is pause-independent and runs `updateReward`, so
    /// once Dave's 7-day lock expires he can call it mid-pause, after Bob's withdraw has already
    /// shrunk the total. That accrual must add nothing.
    function test_MS1_pauseWindowAddsNothing_throughPausedUpdateRewardCaller() public {
        (uint256 bId,) = _stake(bob, 365 days);
        _stake(carol, 365 days);
        (uint256 dId,) = _stake(dave, 7 days);

        _go(1 days);
        staking.pause();
        uint256 rptAtPause = staking.rewardPerTokenStored();
        vm.prank(bob);
        staking.emergencyWithdrawPosition(bId);

        _go(7 days);
        vm.prank(dave);
        staking.emergencyExitPosition(dId);
        assertEq(staking.rewardPerTokenStored(), rptAtPause, "pause window accrued emission");
    }
}
