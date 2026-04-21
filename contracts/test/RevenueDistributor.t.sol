// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/RevenueDistributor.sol";
import {TimelockAdmin} from "../src/base/TimelockAdmin.sol";

/// @dev Mock that implements the IVotingEscrow interface expected by RevenueDistributor
contract MockVotingEscrow {
    mapping(address => uint256) public lockedAmounts;
    mapping(address => uint256) public lockEnds;
    mapping(address => uint256) public userTokenId;
    mapping(uint256 => address) public tokenOwner;
    uint256 public totalLocked;
    uint256 private _nextTokenId = 1;

    function setLock(address user, uint256 amount, uint256 end) external {
        if (userTokenId[user] == 0) {
            uint256 tid = _nextTokenId++;
            userTokenId[user] = tid;
            tokenOwner[tid] = user;
        }
        if (lockedAmounts[user] == 0) {
            totalLocked += amount;
        } else {
            totalLocked = totalLocked - lockedAmounts[user] + amount;
        }
        lockedAmounts[user] = amount;
        lockEnds[user] = end;
    }

    function removeLock(address user) external {
        totalLocked -= lockedAmounts[user];
        lockedAmounts[user] = 0;
        lockEnds[user] = 0;
        uint256 tid = userTokenId[user];
        if (tid != 0) {
            tokenOwner[tid] = address(0);
            userTokenId[user] = 0;
        }
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return lockedAmounts[user];
    }

    function votingPowerAtTimestamp(address user, uint256) external view returns (uint256) {
        return lockedAmounts[user];
    }

    function totalBoostedStake() external view returns (uint256) {
        return totalLocked;
    }

    function locks(address user) external view returns (uint256 amount, uint256 end) {
        return (lockedAmounts[user], lockEnds[user]);
    }

    function positions(uint256 tokenId) external view returns (
        uint256 amount, uint256 boostedAmount, uint256 boostBps, uint256 lockEnd,
        uint256 lockDuration, bool autoMaxLock, int256 rewardDebt, uint256 lastStakeTime,
        bool jbacBoosted, uint256 jbacTokenId, bool jbacDeposited
    ) {
        address user = tokenOwner[tokenId];
        return (lockedAmounts[user], lockedAmounts[user], 10000, lockEnds[user], 0, false, int256(0), 0, false, 0, false);
    }

    function paused() external pure returns (bool) {
        return false;
    }
}

/// @dev Mock that implements the ITegridyRestaking interface for restaked position checks
contract MockRestaking {
    struct RestakeInfo {
        uint256 tokenId;
        uint256 positionAmount;
        uint256 boostedAmount;
        int256 bonusDebt;
        uint256 depositTime;
    }

    mapping(address => RestakeInfo) private _restakers;

    function setRestaker(address user, uint256 tokenId, uint256 positionAmount) external {
        _restakers[user] = RestakeInfo({
            tokenId: tokenId,
            positionAmount: positionAmount,
            boostedAmount: positionAmount,
            bonusDebt: 0,
            depositTime: block.timestamp
        });
    }

    function restakers(address user) external view returns (
        uint256 tokenId, uint256 positionAmount, uint256 boostedAmount, int256 bonusDebt, uint256 depositTime, uint256 unsettledSnapshot
    ) {
        RestakeInfo memory info = _restakers[user];
        return (info.tokenId, info.positionAmount, info.boostedAmount, info.bonusDebt, info.depositTime, 0);
    }
}

contract MockWETHDistTest {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }
    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
    receive() external payable {}
}

contract RevenueDistributorTest is Test {
    MockVotingEscrow public ve;
    MockWETHDistTest public weth;
    RevenueDistributor public dist;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(4 hours + 1); // Ensure first distribute() doesn't hit cooldown (MIN_DISTRIBUTE_INTERVAL = 4 hours)
        ve = new MockVotingEscrow();
        weth = new MockWETHDistTest();
        dist = new RevenueDistributor(address(ve), treasury, address(weth));

        ve.setLock(alice, 100_000 ether, block.timestamp + 365 days);
        ve.setLock(bob, 100_000 ether, block.timestamp + 365 days);
    }

    /// @dev Distribute _count epochs of _amountEach ETH each, with 1-hour spacing.
    function _distributeEpochs(uint256 _count, uint256 _amountEach) internal {
        for (uint256 i = 0; i < _count; i++) {
            vm.deal(address(this), address(this).balance + _amountEach);
            (bool ok,) = address(dist).call{value: _amountEach}("");
            assertTrue(ok);
            dist.distribute();
            if (i < _count - 1) vm.warp(block.timestamp + 4 hours);
        }
    }

    // ===== EPOCH DISTRIBUTION MATH =====

    function test_distribute_createsEpoch() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);

        dist.distribute();
        assertEq(dist.epochCount(), 1);

        (uint256 totalETH, uint256 totalLock, uint256 ts) = dist.getEpoch(0);
        assertEq(totalETH, 1 ether);
        assertEq(totalLock, 200_000 ether);
        assertEq(ts, block.timestamp - 1);
    }

    function test_distribute_multipleEpochs() public {
        vm.deal(address(this), 3 ether);

        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);
        dist.distribute();

        vm.warp(block.timestamp + 4 hours);

        (ok,) = address(dist).call{value: 2 ether}("");
        assertTrue(ok);
        dist.distribute();

        assertEq(dist.epochCount(), 2);
        (uint256 eth1,,) = dist.getEpoch(0);
        (uint256 eth2,,) = dist.getEpoch(1);
        assertEq(eth1, 1 ether);
        assertEq(eth2, 2 ether);
        assertEq(dist.totalDistributed(), 3 ether);
    }

    function test_claim() public {
        _distributeEpochs(3, 1 ether);

        uint256 pending = dist.pendingETH(alice);
        assertEq(pending, 1.5 ether); // 3 * 0.5 ether

        vm.prank(alice);
        dist.claim();
        assertEq(alice.balance, 1.5 ether);
        assertEq(dist.totalClaimed(), 1.5 ether);
    }

    function test_claim_multipleEpochs() public {
        _distributeEpochs(4, 1 ether);

        uint256 pending = dist.pendingETH(alice);
        assertEq(pending, 2 ether); // 4 * 0.5 ether

        vm.prank(alice);
        dist.claim();
        assertEq(alice.balance, 2 ether);
    }

    // ===== MAX_CLAIM_EPOCHS GAS PROTECTION (SECURITY FIX #18) =====

    function test_claim_capsAtMaxEpochs() public {
        vm.deal(address(this), 501 ether);
        uint256 ts = block.timestamp;
        for (uint256 i = 0; i < 501; i++) {
            ts += 4 hours;
            vm.warp(ts);
            (bool ok,) = address(dist).call{value: 1 ether}("");
            assertTrue(ok);
            dist.distribute();
        }

        // claim() reverts when unclaimed epochs exceed MAX_CLAIM_EPOCHS (500)
        vm.prank(alice);
        vm.expectRevert(RevenueDistributor.TooManyUnclaimedEpochs.selector);
        dist.claim();

        // Use claimUpTo() to batch-claim first 500 epochs
        vm.prank(alice);
        dist.claimUpTo(500);
        assertEq(dist.lastClaimedEpoch(alice), 500);

        // Then claim the remaining 1 via regular claim()
        vm.prank(alice);
        dist.claim();
        assertEq(dist.lastClaimedEpoch(alice), 501);
    }

    function test_claimUpTo_workaround() public {
        vm.deal(address(this), 101 ether);
        uint256 ts = block.timestamp;
        for (uint256 i = 0; i < 101; i++) {
            ts += 4 hours;
            vm.warp(ts);
            (bool ok,) = address(dist).call{value: 1 ether}("");
            assertTrue(ok);
            dist.distribute();
        }

        vm.prank(alice);
        dist.claimUpTo(50);
        assertEq(dist.lastClaimedEpoch(alice), 50);

        vm.prank(alice);
        dist.claimUpTo(51);
        assertEq(dist.lastClaimedEpoch(alice), 101);
    }

    // ===== EMERGENCY WITHDRAW =====

    function test_emergencyWithdraw_noLocks() public {
        ve.removeLock(alice);
        ve.removeLock(bob);

        vm.deal(address(this), 1 ether);
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);

        dist.emergencyWithdraw();
        assertEq(treasury.balance, 1 ether);
    }

    function test_revert_emergencyWithdraw_withLocks() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);

        vm.expectRevert(RevenueDistributor.StillHasLockedTokens.selector);
        dist.emergencyWithdraw();
    }

    // ===== TREASURY CHANGE TIMELOCK (AUDIT FIX #68) =====

    function test_proposeTreasuryChange() public {
        address newTreasury = makeAddr("newTreasury");
        dist.proposeTreasuryChange(newTreasury);
        assertEq(dist.pendingTreasury(), newTreasury);
    }

    function test_executeTreasuryChange() public {
        address newTreasury = makeAddr("newTreasury");
        dist.proposeTreasuryChange(newTreasury);
        vm.warp(block.timestamp + 48 hours + 1);
        dist.executeTreasuryChange();
        assertEq(dist.treasury(), newTreasury);
    }

    function test_revert_setTreasury_deprecated() public {
        vm.expectRevert(RevenueDistributor.UseProposeTreasuryChange.selector);
        dist.setTreasury(makeAddr("x"));
    }

    // ===== PAUSE =====

    function test_pause_blocksClaim() public {
        _distributeEpochs(1, 1 ether);

        dist.pause();

        vm.prank(alice);
        vm.expectRevert();
        dist.claim();
    }

    // ===== RECONCILE ROUNDING DUST =====

    function test_reconcileRoundingDust_reverts_when_users_staking() public {
        // Distribute some ETH to create earmarked amounts
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);
        dist.distribute();

        // AUDIT FIX M-09: USERS_STILL_STAKING check was removed. The gap (1 ether)
        // is within the 1 ether GAP_TOO_LARGE threshold, so the function now succeeds.
        // Verify reconcileRoundingDust works and zeroes the gap.
        uint256 earmarkedBefore = dist.totalEarmarked();
        assertGt(earmarkedBefore, 0, "earmarked should be non-zero before reconcile");

        dist.reconcileRoundingDust();

        // After reconciliation, totalEarmarked == totalClaimed (gap zeroed)
        assertEq(dist.totalEarmarked(), dist.totalClaimed(), "gap should be zeroed after reconcile");
    }

    // ===== M-09: DISTRIBUTE COOLDOWN =====

    function test_revert_distribute_withinCooldown() public {
        vm.deal(address(this), 2 ether);
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);
        dist.distribute();

        // Immediately try to distribute again — should revert
        (ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);
        vm.expectRevert(RevenueDistributor.DistributeTooSoon.selector);
        dist.distribute();

        // After cooldown, should succeed
        vm.warp(block.timestamp + 4 hours);
        dist.distribute();
        assertEq(dist.epochCount(), 2);
    }

    function test_revert_distribute_belowMinimumAmount() public {
        // Send less than MIN_DISTRIBUTE_AMOUNT (0.1 ether)
        vm.deal(address(this), 0.09 ether);
        (bool ok,) = address(dist).call{value: 0.09 ether}("");
        assertTrue(ok);

        // Ensure cooldown is not the issue
        vm.warp(block.timestamp + 4 hours);
        vm.expectRevert("AMOUNT_TOO_SMALL");
        dist.distribute();
    }

    // ===== M-11: WETH FALLBACK IN withdrawPending =====

    function test_withdrawPending_wethFallback() public {
        // Deploy a contract that cannot receive ETH
        ETHRejecter rejecter = new ETHRejecter();
        address rejecterAddr = address(rejecter);

        // Give rejecter a lock
        ve.setLock(rejecterAddr, 100_000 ether, block.timestamp + 365 days);

        _distributeEpochs(3, 1 ether);

        // Claim will fail ETH transfer and credit pendingWithdrawals
        vm.prank(rejecterAddr);
        dist.claim();
        assertGt(dist.pendingWithdrawals(rejecterAddr), 0);

        uint256 pending = dist.pendingWithdrawals(rejecterAddr);

        // withdrawPending should fall back to WETH instead of reverting
        vm.prank(rejecterAddr);
        dist.withdrawPending();

        // Pending should be cleared
        assertEq(dist.pendingWithdrawals(rejecterAddr), 0);
    }

    // ===== EMERGENCY WITHDRAW EXCESS TIMELOCK (AC-01) =====

    function test_emergencyWithdrawExcess_requiresProposal() public {
        vm.deal(address(dist), 10 ether);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.NoPendingProposal.selector, dist.EMERGENCY_WITHDRAW_EXCESS()));
        dist.executeEmergencyWithdrawExcess();
    }

    function test_emergencyWithdrawExcess_timelockEnforced() public {
        vm.deal(address(dist), 10 ether);

        dist.proposeEmergencyWithdrawExcess();

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalNotReady.selector, dist.EMERGENCY_WITHDRAW_EXCESS()));
        dist.executeEmergencyWithdrawExcess();
    }

    function test_emergencyWithdrawExcess_succeedsAfterTimelock() public {
        vm.deal(address(dist), 10 ether);

        dist.proposeEmergencyWithdrawExcess();
        vm.warp(block.timestamp + 48 hours + 1);

        uint256 treasuryBefore = treasury.balance;
        dist.executeEmergencyWithdrawExcess();
        assertEq(treasury.balance - treasuryBefore, 10 ether);
    }

    function test_emergencyWithdrawExcess_canCancel() public {
        dist.proposeEmergencyWithdrawExcess();
        dist.cancelEmergencyWithdrawExcess();

        assertEq(dist.emergencyWithdrawProposedAt(), 0);
    }

    function test_emergencyWithdrawExcess_proposalExpires() public {
        vm.deal(address(dist), 10 ether);

        dist.proposeEmergencyWithdrawExcess();
        vm.warp(block.timestamp + 48 hours + 7 days + 1);

        vm.expectRevert(abi.encodeWithSelector(TimelockAdmin.ProposalExpired.selector, dist.EMERGENCY_WITHDRAW_EXCESS()));
        dist.executeEmergencyWithdrawExcess();
    }

    receive() external payable {}
}

contract ETHRejecter {
    // No receive() or fallback() — ETH transfers will revert
}
