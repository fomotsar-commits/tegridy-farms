// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

contract MockTokenAudit is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockNFTAudit is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
    // Allow transferring to simulate selling
    function sellTo(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
    }
}

contract AuditFixesStakingTest is Test {
    TegridyStaking public staking;
    MockTokenAudit public token;
    MockNFTAudit public nft;
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public carol = makeAddr("carol");

    function setUp() public {
        token = new MockTokenAudit();
        nft = new MockNFTAudit();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);

        nft.mint(alice); // Alice gets JBAC #1

        token.transfer(alice, 10_000_000 ether);
        token.transfer(bob, 10_000_000 ether);
        token.transfer(carol, 10_000_000 ether);

        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
        vm.prank(carol);
        token.approve(address(staking), type(uint256).max);

        // Fund rewards
        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);
    }

    // ═══════════════════════════════════════════════════════════════════
    // #1 — Voting Checkpoints
    // ═══════════════════════════════════════════════════════════════════

    function test_votingPowerAt_returnsHistoricalPower() public {
        // Bob stakes at block 10 / timestamp 1000
        vm.roll(10);
        vm.warp(1000);
        vm.prank(bob);
        staking.stake(100_000 ether, 365 days);
        uint256 powerAfterFirstStake = staking.votingPowerOf(bob);
        assertGt(powerAfterFirstStake, 0);

        // Advance to block 100 / timestamp 2000 — earlyWithdraw clears position
        vm.roll(100);
        vm.warp(2000);
        uint256 bobTokenId = staking.userTokenId(bob);
        vm.prank(bob);
        staking.earlyWithdraw(bobTokenId);

        // Advance to block 200 / timestamp 3000 — restake with more tokens
        vm.roll(200);
        vm.warp(3000);
        vm.prank(bob);
        staking.stake(500_000 ether, 365 days);
        uint256 powerAfterSecondStake = staking.votingPowerOf(bob);

        // Historical query at timestamp 1000 should return the first stake's power
        uint256 historicalPower = staking.votingPowerAtTimestamp(bob, 1000);
        assertEq(historicalPower, powerAfterFirstStake, "Historical power should match first stake power");

        // At timestamp 2000, power should be 0 (after earlyWithdraw)
        uint256 powerAtWithdraw = staking.votingPowerAtTimestamp(bob, 2000);
        assertEq(powerAtWithdraw, 0, "Power at withdraw block should be zero");

        // At timestamp 3000, power should be the new stake's power
        uint256 powerAtRestake = staking.votingPowerAtTimestamp(bob, 3000);
        assertEq(powerAtRestake, powerAfterSecondStake, "Power at restake block should match");

        // New power should be higher (5x more tokens)
        assertGt(powerAfterSecondStake, powerAfterFirstStake, "New power should be greater");
    }

    function test_votingPowerAt_returnsZeroBeforeFirstCheckpoint() public {
        // No stake yet — query current timestamp
        uint256 power = staking.votingPowerAtTimestamp(alice, block.timestamp);
        assertEq(power, 0, "Should be zero before any checkpoint");

        // Stake at block N, advance both block and timestamp
        vm.roll(block.number + 50);
        vm.warp(block.timestamp + 50);
        vm.prank(alice);
        staking.stake(100_000 ether, 365 days);

        // Query a timestamp before the stake
        uint256 powerBefore = staking.votingPowerAtTimestamp(alice, block.timestamp - 1);
        assertEq(powerBefore, 0, "Should be zero for timestamp before first checkpoint");
    }

    function test_votingPowerAt_updatesOnStakeAndWithdraw() public {
        // Stake at block 10 / timestamp 1000
        vm.roll(10);
        vm.warp(1000);
        vm.prank(bob);
        staking.stake(200_000 ether, 30 days);
        uint256 powerAtStake = staking.votingPowerOf(bob);
        assertGt(powerAtStake, 0);

        // Advance block and time past lock expiry, then withdraw at block 500 / timestamp 5000
        vm.roll(500);
        uint256 withdrawTimestamp = 1000 + 31 days;
        vm.warp(withdrawTimestamp);

        uint256 bobTokenId = staking.userTokenId(bob);
        vm.prank(bob);
        staking.withdraw(bobTokenId);

        // Historical power at stake timestamp (1000) should be non-zero
        assertEq(staking.votingPowerAtTimestamp(bob, 1000), powerAtStake, "Power at stake timestamp should match");

        // Power at withdraw timestamp should be zero (position deleted)
        assertEq(staking.votingPowerAtTimestamp(bob, withdrawTimestamp), 0, "Power at withdraw timestamp should be zero");

        // Power between stake and withdraw should still show staked power
        assertEq(staking.votingPowerAtTimestamp(bob, 2000), powerAtStake, "Power between stake/withdraw should match");
    }

    function test_numCheckpoints_incrementsCorrectly() public {
        assertEq(staking.numCheckpoints(bob), 0, "No checkpoints initially");

        // Stake — creates checkpoint
        vm.prank(bob);
        staking.stake(100_000 ether, 30 days);
        assertEq(staking.numCheckpoints(bob), 1, "One checkpoint after stake");

        // Advance block, then withdraw — creates another checkpoint
        vm.roll(block.number + 10);
        vm.warp(block.timestamp + 31 days);
        uint256 bobTokenId = staking.userTokenId(bob);
        vm.prank(bob);
        staking.withdraw(bobTokenId);
        assertEq(staking.numCheckpoints(bob), 2, "Two checkpoints after withdraw");
    }

    // ═══════════════════════════════════════════════════════════════════
    // #2 — Position Transfer Guard
    // ═══════════════════════════════════════════════════════════════════

    function test_revert_transferToUserWithExistingPosition() public {
        // Alice stakes
        vm.prank(alice);
        staking.stake(100_000 ether, 30 days);
        uint256 aliceTokenId = staking.userTokenId(alice);

        // Bob stakes
        vm.prank(bob);
        staking.stake(100_000 ether, 30 days);

        // Alice tries to transfer her position NFT to Bob (who already has a position)
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(alice);
        vm.expectRevert(TegridyStaking.AlreadyHasPosition.selector);
        staking.transferFrom(alice, bob, aliceTokenId);
    }

    function test_transferToUserWithNoPosition_succeeds() public {
        // Alice stakes
        vm.prank(alice);
        staking.stake(100_000 ether, 30 days);
        uint256 aliceTokenId = staking.userTokenId(alice);

        // Carol has no position — transfer should succeed
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(alice);
        staking.transferFrom(alice, carol, aliceTokenId);

        assertEq(staking.ownerOf(aliceTokenId), carol);
        assertEq(staking.userTokenId(carol), aliceTokenId);
        assertEq(staking.userTokenId(alice), 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // #11 — Emergency Withdraw Requires Paused
    // ═══════════════════════════════════════════════════════════════════

    function test_revert_emergencyWithdraw_whenNotPaused() public {
        vm.prank(bob);
        staking.stake(100_000 ether, 365 days);
        uint256 bobTokenId = staking.userTokenId(bob);

        // Contract is NOT paused — emergencyWithdrawPosition should revert
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSignature("ExpectedPause()"));
        staking.emergencyWithdrawPosition(bobTokenId);
    }

    function test_emergencyWithdraw_whenPaused_succeeds() public {
        vm.prank(bob);
        staking.stake(100_000 ether, 365 days);
        uint256 bobTokenId = staking.userTokenId(bob);

        uint256 balBefore = token.balanceOf(bob);

        // Owner pauses the contract
        staking.pause();

        // Now emergency withdraw should work
        vm.prank(bob);
        staking.emergencyWithdrawPosition(bobTokenId);

        uint256 received = token.balanceOf(bob) - balBefore;
        assertEq(received, 100_000 ether, "Should receive full staked amount");
        assertEq(staking.userTokenId(bob), 0, "Position should be cleared");
    }

    function test_stake_reverts_whenPaused() public {
        // Owner pauses the contract
        staking.pause();

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        staking.stake(100_000 ether, 30 days);
    }

    // ═══════════════════════════════════════════════════════════════════
    // #32 — Duplicate setRewardPerSecond (deprecated)
    // ═══════════════════════════════════════════════════════════════════

    // test_revert_setRewardPerSecond_deprecated removed — function was removed to reduce contract size

    // ═══════════════════════════════════════════════════════════════════
    // #33 — Minimum Stake
    // ═══════════════════════════════════════════════════════════════════

    function test_revert_stakeBelowMinimum() public {
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.StakeTooSmall.selector);
        staking.stake(99 ether, 30 days);
    }

    function test_stakeAtMinimum_succeeds() public {
        vm.prank(bob);
        staking.stake(100 ether, 30 days);

        uint256 bobTokenId = staking.userTokenId(bob);
        assertGt(bobTokenId, 0, "Should have minted a position NFT");
        (uint256 amount,,,,,) = staking.getPosition(bobTokenId);
        assertEq(amount, 100 ether, "Staked amount should be 100e18");
    }

    // ═══════════════════════════════════════════════════════════════════
    // #16 — JBAC Boost Revalidation
    // ═══════════════════════════════════════════════════════════════════

    /// @dev AUDIT H-1 (2026-04-20): Migrated to deposit-based flow. JBAC is physically held
    ///      by the staking contract — alice cannot "sell" it until unstake. The test now
    ///      asserts the JBAC escrow invariant and early-withdraw return.
    function test_stakeWithBoost_escrowsJbac() public {
        vm.startPrank(alice);
        nft.approve(address(staking), 1);
        staking.stakeWithBoost(100_000 ether, 365 days, 1);
        uint256 aliceTokenId = staking.userTokenId(alice);

        (,uint256 boostBefore,,,,) = staking.getPosition(aliceTokenId);
        uint256 baseBoost = staking.calculateBoost(365 days);
        assertEq(boostBefore, baseBoost + 5000, "Should have JBAC bonus from deposit");
        assertEq(nft.ownerOf(1), address(staking), "JBAC escrowed in staking");

        // Alice cannot transfer the JBAC to carol — it's no longer hers.
        vm.expectRevert();
        nft.transferFrom(alice, carol, 1);
        vm.stopPrank();

        // Early withdraw returns the JBAC to alice.
        vm.prank(alice);
        staking.earlyWithdraw(aliceTokenId);
        assertEq(nft.ownerOf(1), alice, "JBAC returned on early withdraw");
    }

    /// @dev AUDIT H-1 (2026-04-20): revalidateBoost is not useful for deposit-based positions.
    function test_revalidateBoost_revertsOnDepositBased() public {
        vm.startPrank(alice);
        nft.approve(address(staking), 1);
        staking.stakeWithBoost(100_000 ether, 365 days, 1);
        uint256 aliceTokenId = staking.userTokenId(alice);

        vm.expectRevert(TegridyStaking.JbacDeposited.selector);
        staking.revalidateBoost(aliceTokenId);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════
    // #66 — Treasury Timelock
    // ═══════════════════════════════════════════════════════════════════

    function test_revert_executeTreasuryChange_tooEarly() public {
        address newTreasury = makeAddr("newTreasury");

        // Propose treasury change
        staking.proposeTreasuryChange(newTreasury);

        // Try to execute immediately — should revert
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, staking.TREASURY_CHANGE()));
        staking.executeTreasuryChange();

        // Try after 47 hours — still too early
        vm.warp(block.timestamp + 47 hours);
        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, staking.TREASURY_CHANGE()));
        staking.executeTreasuryChange();
    }

    function test_executeTreasuryChange_afterTimelock() public {
        address newTreasury = makeAddr("newTreasury");

        staking.proposeTreasuryChange(newTreasury);

        // Warp past 48 hours
        vm.warp(block.timestamp + 48 hours);

        staking.executeTreasuryChange();

        assertEq(staking.treasury(), newTreasury, "Treasury should be updated");
        assertEq(staking.pendingTreasury(), address(0), "Pending treasury should be cleared");
        assertEq(staking.treasuryChangeTime(), 0, "Timelock should be cleared");
    }

    // ═══════════════════════════════════════════════════════════════════
    // #61 — Fund Minimum
    // ═══════════════════════════════════════════════════════════════════

    function test_revert_fundBelowMinimum() public {
        // AUDIT NEW-S5 (MEDIUM): notifyRewardAmount now requires owner or notifier.
        // Whitelist bob so this suite continues to exercise the MIN_NOTIFY_AMOUNT path.
        staking.setRewardNotifier(bob, true);
        vm.prank(bob);
        vm.expectRevert(TegridyStaking.FundAmountTooSmall.selector);
        staking.notifyRewardAmount(999 ether);
    }

    function test_fund_atMinimum_succeeds() public {
        uint256 fundedBefore = staking.totalRewardsFunded();

        // AUDIT NEW-S5: whitelist bob as notifier so the auth check passes.
        staking.setRewardNotifier(bob, true);
        vm.prank(bob);
        staking.notifyRewardAmount(1000 ether);

        assertEq(staking.totalRewardsFunded(), fundedBefore + 1000 ether, "Fund amount should be recorded");
    }
}
