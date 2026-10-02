// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyStakingJbacVault.sol";

contract SMVPauseToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract SMVPauseNFT is ERC721 {
    constructor() ERC721("JungleBay", "JBAC") {}
}

/// @title  2026-09-17: StakingMonitorView.earned must not project emission while paused
///
/// @notice The write path freezes emission during a pause (AUDIT FIX DS2-04):
///         `pause()` / `guardianPause()` settle first, `StakingRewardLib.accumulateRewards`
///         adds nothing while `isPaused` (it only advances `lastUpdateTime`), and
///         `unpause()` re-anchors `lastUpdateTime`. The view kept projecting
///         `(now - lastUpdateTime) * rewardRate` over the CURRENT `totalBoostedStake`, so
///         during a pause it showed a growing figure that `getReward` never pays. After an
///         `emergencyWithdrawPosition` shrinks the denominator it grew faster still, and it
///         snapped back at unpause. Measured: 302,400 TOWELI shown vs 43,200 paid.
///
///         The frontend shows this figure as Claimable, and during a pause as the amount a
///         locked staker "forfeits" by taking the only exit that works then.
///
/// @dev    Pins the INVARIANT, not a literal: the figure the view shows during a pause is
///         exactly what `getReward` pays at the unpause instant. The second test is the
///         other direction: while running, the view still projects, and still matches.
contract StakingMonitorViewPauseTest is Test {
    TegridyStaking staking;
    StakingMonitorView monitor;
    SMVPauseToken token;
    address treasury = makeAddr("treasury");
    address bob = makeAddr("bob");     // leaves via emergencyWithdrawPosition, halving the denominator
    address carol = makeAddr("carol"); // the staker whose displayed pending is under test

    // via_ir can fold `block.timestamp` across warps; a storage clock seeded from a literal
    // keeps every warp real.
    uint256 t = 1_000_000;

    function _go(uint256 dt) internal {
        t += dt;
        vm.warp(t);
    }

    function setUp() public {
        token = new SMVPauseToken();
        SMVPauseNFT nft = new SMVPauseNFT();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);
        monitor = new StakingMonitorView(address(staking));
        TegridyStakingAdmin admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));
        TegridyStakingJbacVault vault = new TegridyStakingJbacVault(address(nft), address(staking));
        staking.setJbacVault(address(vault));

        address[2] memory users = [bob, carol];
        for (uint256 i; i < users.length; ++i) {
            token.transfer(users[i], 1_000_000 ether);
            vm.prank(users[i]);
            token.approve(address(staking), type(uint256).max);
        }
        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);
        vm.warp(t);
    }

    function _stake(address who) internal returns (uint256 id) {
        vm.prank(who);
        staking.stake(100_000 ether, 365 days);
        id = staking.userTokenId(who);
    }

    function _claim(address who, uint256 id) internal returns (uint256 paid) {
        uint256 before = token.balanceOf(who);
        vm.prank(who);
        staking.getReward(id);
        paid = token.balanceOf(who) - before;
    }

    function test_pausedView_isFrozen_andEqualsWhatTheUnpauseClaimPays() public {
        uint256 bId = _stake(bob);
        uint256 cId = _stake(carol);

        _go(1 days);
        staking.pause();
        uint256 atPause = monitor.earned(cId);
        assertGt(atPause, 0, "fixture: the pre-pause day must have accrued");

        vm.prank(bob);
        staking.emergencyWithdrawPosition(bId);
        _go(3 days);

        uint256 midPause = monitor.earned(cId);
        assertEq(midPause, atPause, "view projected emission while paused");

        staking.unpause();
        uint256 paid = _claim(carol, cId);
        assertEq(midPause, paid, "the paused view disagrees with what getReward pays");
    }

    function test_runningView_stillProjects_andEqualsWhatTheClaimPays() public {
        _stake(bob);
        uint256 cId = _stake(carol);
        uint256 lastTouch = staking.lastUpdateTime();

        _go(1 days);
        // No reward-touching call since the stake, so a correct figure here has to come
        // from the projection, not from the stored accumulator.
        assertEq(staking.lastUpdateTime(), lastTouch, "fixture: accumulator must be stale");
        uint256 shown = monitor.earned(cId);
        assertGt(shown, 0, "running view stopped projecting");

        uint256 paid = _claim(carol, cId);
        assertEq(shown, paid, "the running view disagrees with what getReward pays");
    }
}
