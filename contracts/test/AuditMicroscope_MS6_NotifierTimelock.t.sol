// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyStakingAdmin.sol";

contract MS6Token is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") { _mint(msg.sender, 1_000_000_000 ether); }
}

contract MS6JBAC is ERC721 {
    constructor() ERC721("JungleBay", "JBAC") {}
}

/// @title AUDIT MICROSCOPE_2026_04_30 M-S6: who may fund staking rewards.
/// @notice `setRewardNotifier` let the owner add a reward funder in one transaction,
///         the only staking parameter with no 48h notice. Now the owner proposes on
///         TegridyStakingAdmin, waits 48h, and executes.
contract AuditMicroscope_MS6_NotifierTimelockTest is Test {
    MS6Token token;
    TegridyStaking staking;
    TegridyStakingAdmin admin;
    address notifier = makeAddr("notifier");
    uint256 constant FUND = 1_000 ether;

    function setUp() public {
        token = new MS6Token();
        staking = new TegridyStaking(address(token), address(new MS6JBAC()), makeAddr("treasury"));
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));
        token.transfer(notifier, 10 * FUND);
        vm.prank(notifier);
        token.approve(address(staking), type(uint256).max);
    }

    function _notify() internal returns (bool ok) {
        vm.prank(notifier);
        (ok, ) = address(staking).call(abi.encodeCall(TegridyStaking.notifyRewardAmount, (FUND)));
    }

    /// The owner can no longer grant a funder in the same block: the one-step setter is
    /// gone, and the would-be funder is still refused.
    function test_MS6_ownerCannotGrantInstantly() public {
        (bool granted, ) = address(staking).call(
            abi.encodeWithSignature("setRewardNotifier(address,bool)", notifier, true)
        );
        assertFalse(granted, "M-S6: a one-step notifier grant still exists");
        assertFalse(_notify(), "M-S6: notifier funded with no 48h notice");
        assertEq(staking.totalRewardsFunded(), 0);
    }

    function test_MS6_grantWaitsTheFullTimelock() public {
        admin.proposeRewardNotifier(notifier, true);
        uint256 readyAt = admin.rewardNotifierChangeReadyAt();
        assertEq(readyAt, vm.getBlockTimestamp() + 48 hours);

        vm.warp(readyAt - 1);
        vm.expectRevert();
        admin.executeRewardNotifier();
        assertFalse(_notify(), "funded before the timelock ran out");

        vm.warp(readyAt);
        admin.executeRewardNotifier();
        assertTrue(_notify(), "granted notifier could not fund");
        assertEq(staking.totalRewardsFunded(), FUND);
    }

    function test_MS6_onlyTheAdminWritesTheSet() public {
        vm.prank(address(this)); // the staking owner itself
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.applyRewardNotifier(notifier, true);

        vm.prank(notifier);
        vm.expectRevert();
        admin.proposeRewardNotifier(notifier, true);
    }

    function test_MS6_handoverCancelsAQueuedGrant() public {
        admin.proposeRewardNotifier(notifier, true);
        address next = makeAddr("nextOwner");
        admin.transferOwnership(next);
        vm.prank(next);
        admin.acceptOwnership();
        assertEq(admin.rewardNotifierChangeReadyAt(), 0);
        assertEq(admin.pendingRewardNotifier(), address(0));
    }
}
