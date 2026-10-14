// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/ReferralSplitter.sol";

contract MG3Staking {
    function votingPowerOf(address) external pure returns (uint256) {
        return 1_000_000 ether;
    }
}

contract MG3WETH {
    mapping(address => uint256) public balanceOf;
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

/// @title AUDIT MICROSCOPE_2026_04_30 M-G3: the 30-day wait before changing referrer.
/// @notice `updateReferrer` waits 30 days from `lastReferrerChange`, but `setReferrer`
///         never wrote it, so the FIRST change compared against 0 and went through at
///         once. Foundry's default clock is 1, which hid it from the old cooldown test;
///         these run at a real mainnet time.
contract AuditMicroscope_MG3_ReferrerCooldownTest is Test {
    ReferralSplitter ref;
    address user = makeAddr("user");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    uint256 constant T0 = 1_790_000_000; // 2026-09-21, a real block time

    function setUp() public {
        vm.warp(T0);
        ref = new ReferralSplitter(1000, address(new MG3Staking()), makeAddr("treasury"), address(new MG3WETH()));
        ref.setApprovedCaller(address(this), true);
        ref.completeSetup();
        vm.deal(address(this), 10 ether);
        vm.prank(user);
        ref.setReferrer(bob);
    }

    /// Bob brought the user in; the user swaps 1 ETH of fees a day later. With the
    /// first change free, the user hops to carol first and bob's 0.1 ETH goes to carol.
    function test_MG3_firstChangeWaitsThirtyDays() public {
        vm.warp(T0 + 1 days);
        vm.prank(user);
        try ref.updateReferrer(carol) {} catch {}
        ref.recordFee{value: 1 ether}(user);

        assertEq(ref.pendingETH(bob), 0.1 ether, "M-G3: bob's referral fee went elsewhere");
        assertEq(ref.pendingETH(carol), 0, "M-G3: first referrer change skipped the 30-day wait");
        assertEq(ref.referrerOf(user), bob);
        assertEq(ref.lastReferrerChange(user), T0, "setReferrer must start the clock");
    }

    function test_MG3_firstChangeRevertsUntilDayThirty() public {
        vm.warp(T0 + 30 days - 1);
        vm.prank(user);
        vm.expectRevert(ReferralSplitter.CooldownNotElapsed.selector);
        ref.updateReferrer(carol);

        vm.warp(T0 + 30 days);
        vm.prank(user);
        ref.updateReferrer(carol);
        assertEq(ref.referrerOf(user), carol);
    }
}
