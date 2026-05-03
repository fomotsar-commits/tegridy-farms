// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RevenueDistributor} from "../../src/RevenueDistributor.sol";

/// @title PASS5-REV-H1 -distribute() bypasses MIN_DISTRIBUTE_STAKE concentration guard
/// @notice AUDIT M-12 added `MIN_DISTRIBUTE_STAKE` to `distributePermissionless()` to block
///         the concentration attack. The sibling entrypoint `distribute()` is *also*
///         permissionless and lacks the guard -same attack works against `distribute()`
///         with effectively no minimum-stake floor.
///
/// File:   contracts/src/RevenueDistributor.sol
/// Sites:  L296-298  distribute()                  -NO MIN_DISTRIBUTE_STAKE check
///         L309-320  distributePermissionless()    -has the check (M-12)
///
/// Severity: HIGH -extracts >10% of an epoch's ETH for a fraction of the cost
/// PoC:    forge test --match-contract PASS5_REV_H1 -vv

contract MockVotingEscrowH1 {
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

    /// @dev Simulates a kick / unstake removing the user's boost from totalBoostedStake.
    function removeLock(address user) external {
        if (lockedAmounts[user] > 0) {
            totalLocked -= lockedAmounts[user];
            lockedAmounts[user] = 0;
            lockEnds[user] = 0;
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

contract MockWETH_H1 {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
    receive() external payable {}
}

contract PASS5_REV_H1_Test is Test {
    MockVotingEscrowH1 ve;
    MockWETH_H1 weth;
    RevenueDistributor dist;

    // The legitimate whale (90% of stake) and a sibling honest staker (10%).
    address constant WHALE = address(0xBEEF);
    address constant HONEST = address(0xCAFE);
    // The attacker. They don't even need a large stake -just any non-zero stake.
    address constant ATTACKER = address(0xBAD);
    address constant TREASURY = address(0xFEE);

    function setUp() public {
        vm.warp(4 hours + 1);
        ve = new MockVotingEscrowH1();
        weth = new MockWETH_H1();
        dist = new RevenueDistributor(address(ve), TREASURY, address(weth));

        // Initial honest distribution of stake -whale dominates, attacker is a small fish.
        // Whale: 900,000 ether (90% of total)
        // Honest: 100,000 ether (10%)
        // Attacker: 1 ether (0.0001%)
        ve.setLock(WHALE, 900_000 ether, block.timestamp + 365 days);
        ve.setLock(HONEST, 100_000 ether, block.timestamp + 365 days);
        ve.setLock(ATTACKER, 1 ether, block.timestamp + 365 days);
    }

    /// @notice POSITIVE CONTROL: distributePermissionless() correctly blocks
    ///         the concentration attack (M-12 fix is doing its job).
    function test_distributePermissionless_revertsAfterConcentration() public {
        // Fund the distributor with 50 ETH of accumulated swap fees.
        vm.deal(address(this), 50 ether);
        (bool ok,) = address(dist).call{value: 50 ether}("");
        assertTrue(ok);

        // Whale's lock expires + is kicked → boost goes to zero.
        // (Simulated by removeLock -same on-chain effect.)
        ve.removeLock(WHALE);
        ve.removeLock(HONEST);

        // Now total = 1 ether (just attacker). M-12's MIN_DISTRIBUTE_STAKE = 1000 ether.
        // distributePermissionless reverts.
        vm.prank(ATTACKER);
        vm.expectRevert(bytes("STAKE_TOO_LOW"));
        dist.distributePermissionless();
    }

    /// @notice POST-FIX REGRESSION: distribute() now has the same MIN_DISTRIBUTE_STAKE
    ///         guard as distributePermissionless(). Pre-PASS5-REV-H1 fix, the test
    ///         body below proved the attack succeeded (attacker captured the full
    ///         50 ETH with a 1-ether stake). Post-fix the attack reverts
    ///         "STAKE_TOO_LOW" -sibling-miss closed.
    function test_distribute_concentration_attack_blocked() public {
        // (1) Stack ETH in distributor -accumulated swap fees, ready to distribute.
        vm.deal(address(this), 50 ether);
        (bool ok,) = address(dist).call{value: 50 ether}("");
        assertTrue(ok);

        // (2) Attacker engineers the concentration window (whale + honest gone).
        ve.removeLock(WHALE);
        ve.removeLock(HONEST);

        // (3) Attacker calls distribute() -POST-FIX reverts with the same
        //     STAKE_TOO_LOW error as distributePermissionless. Sibling parity.
        vm.prank(ATTACKER);
        vm.expectRevert(bytes("STAKE_TOO_LOW"));
        dist.distribute();

        // No epoch was created.
        assertEq(dist.epochCount(), 0, "no epoch created -attack blocked");
    }

    /// @notice POST-FIX REGRESSION: partial concentration also blocked. Pre-fix
    ///         the attacker walked away with ~16.66 ETH using a 5-ether stake
    ///         against 10 honest ether. Post-fix even this case is blocked
    ///         because total (15 ether) < MIN_DISTRIBUTE_STAKE (1000 ether).
    function test_distribute_partialConcentration_blocked() public {
        ve.setLock(ATTACKER, 5 ether, block.timestamp + 365 days);
        ve.setLock(HONEST, 10 ether, block.timestamp + 365 days);
        ve.removeLock(WHALE);

        vm.deal(address(this), 50 ether);
        (bool ok,) = address(dist).call{value: 50 ether}("");
        assertTrue(ok);

        // Both entrypoints now revert symmetrically.
        vm.prank(ATTACKER);
        vm.expectRevert(bytes("STAKE_TOO_LOW"));
        dist.distributePermissionless();

        vm.prank(ATTACKER);
        vm.expectRevert(bytes("STAKE_TOO_LOW"));
        dist.distribute();

        assertEq(dist.epochCount(), 0, "no epoch created -both siblings block");
    }

    /// @notice POST-FIX HAPPY PATH: with a healthy total stake well above
    ///         MIN_DISTRIBUTE_STAKE, distribute() works normally. Verifies the
    ///         fix didn't break the legitimate use case.
    function test_distribute_happyPath_aboveMinStake() public {
        // Default setUp leaves all three stakers in place -total = 1,000,001 ether.
        vm.deal(address(this), 50 ether);
        (bool ok,) = address(dist).call{value: 50 ether}("");
        assertTrue(ok);

        // Attacker triggers (it's permissionless) -succeeds because total stake
        // is healthy.
        vm.prank(ATTACKER);
        dist.distribute();
        assertEq(dist.epochCount(), 1, "epoch should be created");

        // Attacker's share is proportional to their tiny stake (1 / 1_000_001),
        // not the entire epoch. The concentration attack is impossible because
        // the whale's stake dilutes them.
        vm.warp(block.timestamp + 1);
        uint256 attackerBalBefore = ATTACKER.balance;
        vm.prank(ATTACKER);
        dist.claim();
        uint256 attackerGain = ATTACKER.balance - attackerBalBefore;
        // Attacker's fair share: 50 ETH * 1 / 1_000_001 ≈ 0.00005 ETH (5e13 wei).
        assertLe(attackerGain, 1e15, "attacker gets only their proportional dust");
    }
}
