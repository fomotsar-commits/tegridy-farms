// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import "../src/TegridyStakingAdmin.sol";
import "../src/TegridyStakingJbacVault.sol";

contract EE75Token is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract EE75Nft is ERC721 {
    constructor() ERC721("JungleBay", "JBAC") {}
}

/// @title  Early exit costs 75% of principal (owner ruling 2026-10-14)
/// @notice The owner asked for the early-exit fee of the NEW staking contract to be 75% instead
///         of 25%. These tests pin the whole money split of an early exit, on BOTH paths that
///         charge it (`earlyWithdraw` and `executeEmergencyExit` while the lock is running):
///           - the position's rewards are paid first, in full (read from the monitor view in
///             the same block, then compared exactly),
///           - the holder gets 25% of principal back,
///           - the treasury gets exactly 75% of principal,
///         and that an exit AFTER the lock ends pays no fee on either path.
///         Every exact assertion below fails with the old `EARLY_WITHDRAWAL_PENALTY_BPS = 2500`.
contract StakingEarlyExit75Test is Test {
    TegridyStaking staking;
    StakingMonitorView monitor;
    TegridyStakingAdmin admin;
    TegridyStakingJbacVault vault;
    EE75Token token;
    EE75Nft nft;

    address treasury = makeAddr("treasury");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant STAKE = 10_000 ether;
    uint256 constant ODD_STAKE = 1_234.567890123456789 ether; // not divisible by 4

    function setUp() public {
        token = new EE75Token();
        nft = new EE75Nft();
        staking = new TegridyStaking(address(token), address(nft), treasury);
        monitor = new StakingMonitorView(address(staking));
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));
        vault = new TegridyStakingJbacVault(address(nft), address(staking));
        staking.setJbacVault(address(vault));

        token.transfer(bob, 10_000_000 ether); // enough for the fuzz's full per-wallet cap
        token.transfer(carol, 1_000_000 ether);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
        vm.prank(carol);
        token.approve(address(staking), type(uint256).max);

        // Fund far more than any test can emit, so "rewards in full" is never pool-capped.
        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);
    }

    function _stake(address who, uint256 amount, uint256 lock) internal returns (uint256 id) {
        vm.prank(who);
        staking.stake(amount, lock);
        id = staking.userTokenId(who);
    }

    function _warp(uint256 secs) internal {
        // via_ir folds block.timestamp across warps; read the cheatcode clock instead.
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    function test_constantIs7500() public view {
        assertEq(staking.EARLY_WITHDRAWAL_PENALTY_BPS(), 7500, "early-exit fee must be 75%");
    }

    /// earlyWithdraw mid-lock: rewards first and in full, then 25% of principal; 75% to treasury.
    function test_earlyWithdraw_paysRewardsInFull_returns25_sends75ToTreasury() public {
        // A second staker so the reward split is not trivially 100% to one position.
        _stake(carol, 5_000 ether, 365 days);
        uint256 id = _stake(bob, STAKE, 365 days);
        _warp(30 days);

        uint256 owed = monitor.earned(id);
        assertGt(owed, 0, "a month of emission must have accrued");

        uint256 bobBefore = token.balanceOf(bob);
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.expectEmit(true, true, false, true, address(staking));
        emit TegridyStaking.PenaltySentToTreasury(id, 7_500 ether);
        vm.expectEmit(true, true, false, true, address(staking));
        emit TegridyStaking.EarlyWithdrawn(bob, id, 2_500 ether, 7_500 ether);
        vm.prank(bob);
        staking.earlyWithdraw(id);

        assertEq(token.balanceOf(treasury) - treasuryBefore, 7_500 ether, "treasury gets exactly 75% of principal");
        assertEq(token.balanceOf(bob) - bobBefore, owed + 2_500 ether, "holder gets every reward plus 25% of principal");
        assertEq(staking.totalPenaltiesCollected(), 7_500 ether, "penalty bookkeeping");
        assertEq(staking.totalStaked(), 5_000 ether, "only carol's principal remains staked");
    }

    /// Rounding: the treasury share rounds DOWN, the holder keeps the remainder; nothing is lost.
    function test_earlyWithdraw_oddAmount_roundsTowardHolder_noDust() public {
        uint256 id = _stake(bob, ODD_STAKE, 90 days);
        uint256 owed = monitor.earned(id); // same block as the stake: zero
        uint256 bobBefore = token.balanceOf(bob);
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.prank(bob);
        staking.earlyWithdraw(id);

        uint256 fee = (ODD_STAKE * 7500) / 10000;
        uint256 toTreasury = token.balanceOf(treasury) - treasuryBefore;
        uint256 toBob = token.balanceOf(bob) - bobBefore;
        assertEq(toTreasury, fee, "treasury share is floor(75%)");
        assertEq(toBob, owed + ODD_STAKE - fee, "holder gets the rest");
        assertEq(toTreasury + toBob - owed, ODD_STAKE, "principal fully accounted for");
        assertGt(toTreasury * 4, ODD_STAKE * 3 - 4, "fee is 75%, not 25%");
    }

    /// The emergency-exit path charges the same 75% when its 7-day delay ends before the lock.
    function test_executeEmergencyExit_beforeLockEnd_paysRewardsInFull_returns25_sends75() public {
        _stake(carol, 5_000 ether, 365 days);
        uint256 id = _stake(bob, STAKE, 365 days);
        vm.prank(bob);
        staking.requestEmergencyExit(id);
        _warp(7 days + 1);

        uint256 owed = monitor.earned(id);
        assertGt(owed, 0, "a week of emission must have accrued");
        uint256 bobBefore = token.balanceOf(bob);
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.expectEmit(true, true, false, true, address(staking));
        emit TegridyStaking.PenaltySentToTreasury(id, 7_500 ether);
        vm.prank(bob);
        staking.executeEmergencyExit(id);

        assertEq(token.balanceOf(treasury) - treasuryBefore, 7_500 ether, "treasury gets exactly 75% of principal");
        assertEq(token.balanceOf(bob) - bobBefore, owed + 2_500 ether, "holder gets every reward plus 25% of principal");
        assertEq(staking.totalPenaltiesCollected(), 7_500 ether, "penalty bookkeeping");
    }

    /// After the lock ends: `withdraw` pays rewards + 100% of principal, nothing to treasury,
    /// and `earlyWithdraw` refuses so nobody pays the fee by mistake.
    function test_afterLockEnd_withdraw_noFee_and_earlyWithdrawRefuses() public {
        _stake(carol, 5_000 ether, 365 days);
        uint256 id = _stake(bob, STAKE, 30 days);
        _warp(30 days + 1);

        vm.prank(bob);
        vm.expectRevert(TegridyStaking.MustUseWithdraw.selector);
        staking.earlyWithdraw(id);

        uint256 owed = monitor.earned(id);
        assertGt(owed, 0, "rewards accrued over the lock");
        uint256 bobBefore = token.balanceOf(bob);
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.prank(bob);
        staking.withdraw(id);

        assertEq(token.balanceOf(treasury), treasuryBefore, "no fee after the lock ends");
        assertEq(token.balanceOf(bob) - bobBefore, owed + STAKE, "rewards plus all principal");
        assertEq(staking.totalPenaltiesCollected(), 0, "nothing collected");
    }

    /// After the lock ends, the emergency-exit path is also fee-free.
    function test_afterLockEnd_executeEmergencyExit_noFee() public {
        _stake(carol, 5_000 ether, 365 days);
        uint256 id = _stake(bob, STAKE, 7 days);
        vm.prank(bob);
        staking.requestEmergencyExit(id);
        _warp(7 days + 1);

        uint256 owed = monitor.earned(id);
        uint256 bobBefore = token.balanceOf(bob);
        uint256 treasuryBefore = token.balanceOf(treasury);

        vm.prank(bob);
        staking.executeEmergencyExit(id);

        assertEq(token.balanceOf(treasury), treasuryBefore, "no fee after the lock ends");
        assertEq(token.balanceOf(bob) - bobBefore, owed + STAKE, "rewards plus all principal");
        assertEq(staking.totalPenaltiesCollected(), 0, "nothing collected");
    }

    /// Fuzz: for any stake size and any moment inside the lock, the split is exact.
    function testFuzz_earlyWithdraw_split(uint96 rawAmount, uint32 rawElapsed) public {
        // Up to the release's per-wallet cap (DeployStakingRelease1.MAX_STAKE_PER_USER).
        uint256 amount = bound(uint256(rawAmount), 100 ether, 10_000_000 ether);
        uint256 lock = 365 days;
        uint256 elapsed = bound(uint256(rawElapsed), 0, lock - 1);
        _stake(carol, 5_000 ether, lock);
        uint256 id = _stake(bob, amount, lock);
        _warp(elapsed);

        uint256 owed = monitor.earned(id);
        uint256 bobBefore = token.balanceOf(bob);
        uint256 treasuryBefore = token.balanceOf(treasury);
        vm.prank(bob);
        staking.earlyWithdraw(id);

        uint256 fee = (amount * 7500) / 10000;
        assertEq(token.balanceOf(treasury) - treasuryBefore, fee, "treasury share");
        assertEq(token.balanceOf(bob) - bobBefore, owed + amount - fee, "holder share");
    }
}
