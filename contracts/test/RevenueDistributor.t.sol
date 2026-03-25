// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/RevenueDistributor.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

/// @dev Mock that implements the IVotingEscrow interface expected by RevenueDistributor
contract MockVotingEscrow {
    mapping(address => uint256) public lockedAmounts;
    mapping(address => uint256) public lockEnds;
    uint256 public totalLocked;

    function setLock(address user, uint256 amount, uint256 end) external {
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
    }

    function votingPowerOf(address user) external view returns (uint256) {
        return lockedAmounts[user];
    }

    function locks(address user) external view returns (uint256 amount, uint256 end) {
        return (lockedAmounts[user], lockEnds[user]);
    }
}

contract RevenueDistributorTest is Test {
    MockVotingEscrow public ve;
    RevenueDistributor public dist;
    MockToken public token;
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public treasury = makeAddr("treasury");

    function setUp() public {
        token = new MockToken();
        ve = new MockVotingEscrow();
        dist = new RevenueDistributor(address(ve), treasury);

        // Set up locks
        ve.setLock(alice, 100_000 ether, block.timestamp + 365 days);
        ve.setLock(bob, 100_000 ether, block.timestamp + 365 days);
    }

    function test_register() public {
        vm.prank(alice);
        dist.register();
        assertTrue(dist.hasRegistered(alice));
    }

    function test_distribute_and_claim() public {
        // Register
        vm.prank(alice);
        dist.register();

        // Send ETH to distributor
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);

        // Distribute
        dist.distribute();
        assertEq(dist.epochCount(), 1);

        // Alice claims her share (50% since equal locks)
        uint256 pending = dist.pendingETH(alice);
        assertEq(pending, 0.5 ether);

        vm.prank(alice);
        dist.claim();
        assertEq(alice.balance, 0.5 ether);
    }

    function test_cannot_claim_before_register() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);
        dist.distribute();

        vm.prank(alice);
        vm.expectRevert(RevenueDistributor.NotRegistered.selector);
        dist.claim();
    }

    function test_no_retroactive_claims() public {
        // Send ETH and distribute BEFORE alice registers
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);
        dist.distribute();

        // Now alice registers
        vm.prank(alice);
        dist.register();

        // Alice should have nothing to claim (registered after epoch)
        assertEq(dist.pendingETH(alice), 0);
    }

    function test_emergency_withdraw_when_no_locks() public {
        // Remove all locks
        ve.removeLock(alice);
        ve.removeLock(bob);

        // Send ETH
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);

        // Can't distribute (no locks)
        vm.expectRevert(RevenueDistributor.NoLockedTokens.selector);
        dist.distribute();

        // Emergency withdraw should work
        dist.emergencyWithdraw();
        assertEq(treasury.balance, 1 ether);
    }

    function test_emergency_withdraw_fails_with_locks() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);

        vm.expectRevert(RevenueDistributor.StillHasLockedTokens.selector);
        dist.emergencyWithdraw();
    }

    function test_multiple_epochs() public {
        vm.prank(alice);
        dist.register();
        vm.prank(bob);
        dist.register();

        // Epoch 1
        vm.deal(address(this), 2 ether);
        (bool ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);
        dist.distribute();

        // Epoch 2
        (ok,) = address(dist).call{value: 1 ether}("");
        assertTrue(ok);
        dist.distribute();

        // Alice claims both epochs
        uint256 pending = dist.pendingETH(alice);
        assertEq(pending, 1 ether); // 0.5 + 0.5

        vm.prank(alice);
        dist.claim();
        assertEq(alice.balance, 1 ether);
    }

    receive() external payable {}
}
