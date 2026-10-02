// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";

contract MockTOWELI_EmergencyTouch is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 10_000_000_000 ether);
    }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockJBAC_EmergencyTouch is ERC721 {
    uint256 private _id = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256) { _mint(to, _id); return _id++; }
}

/// @title AUDIT M-AUDIT-2026-3 — Emergency-exit flow refreshes _touch
/// @notice Verifies requestEmergencyExit, cancelEmergencyExit, and
///         executeEmergencyExit all update lastActivityAt[user] so the
///         90-day USER_INACTIVITY_GATE on claimUnsettledFor cannot be
///         raced by the owner against a user who only ever interacts with
///         the emergency-exit flow.
/// @dev    Ported 2026-09-17 from commit cf1c1bae (branch
///         worktree-agent-aff47b955ab78a378), which never reached trunk; the fix
///         itself did. Two changes from the original:
///         - Time is read with `vm.getBlockTimestamp()`. `via_ir = true` folds
///           `block.timestamp` across `vm.warp`, so a bare read after a warp can
///           return the pre-warp value.
///         - Trunk later made the request/cancel touch conditional on `!paused()`
///           (AUDIT FIX 2026-05-16 M16: request+cancel spam during a pause kept the
///           gate fresh forever). The paused test below pins that half of the same
///           line; nothing else on trunk covered it.
contract AuditMediumStakingEmergencyTouchTest is Test {
    MockTOWELI_EmergencyTouch token;
    MockJBAC_EmergencyTouch nft;
    TegridyStaking staking;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");

    uint256 constant STAKE_AMT = 500_000 ether;
    uint256 constant LOCK_30D = 30 days;

    function setUp() public {
        token = new MockTOWELI_EmergencyTouch();
        nft = new MockJBAC_EmergencyTouch();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);

        token.transfer(alice, 5_000_000 ether);
        vm.prank(alice); token.approve(address(staking), type(uint256).max);
        token.approve(address(staking), type(uint256).max);

        staking.notifyRewardAmount(50_000_000 ether);
    }

    function test_M2026_3_requestEmergencyExit_touches_user() public {
        vm.prank(alice); staking.stake(STAKE_AMT, LOCK_30D);
        uint256 tokenId = staking.userTokenId(alice);

        // Warp forward enough that lastActivityAt becomes stale.
        vm.warp(vm.getBlockTimestamp() + 30 days);

        uint256 callTs = vm.getBlockTimestamp();
        vm.prank(alice); staking.requestEmergencyExit(tokenId);

        assertEq(
            staking.lastActivityAt(alice),
            callTs,
            "AUDIT M-AUDIT-2026-3: requestEmergencyExit must refresh lastActivityAt"
        );
    }

    function test_M2026_3_cancelEmergencyExit_touches_user() public {
        vm.prank(alice); staking.stake(STAKE_AMT, LOCK_30D);
        uint256 tokenId = staking.userTokenId(alice);

        vm.prank(alice); staking.requestEmergencyExit(tokenId);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 callTs = vm.getBlockTimestamp();
        vm.prank(alice); staking.cancelEmergencyExit(tokenId);

        assertEq(
            staking.lastActivityAt(alice),
            callTs,
            "AUDIT M-AUDIT-2026-3: cancelEmergencyExit must refresh lastActivityAt"
        );
    }

    function test_M2026_3_executeEmergencyExit_touches_user() public {
        vm.prank(alice); staking.stake(STAKE_AMT, LOCK_30D);
        uint256 tokenId = staking.userTokenId(alice);

        vm.prank(alice); staking.requestEmergencyExit(tokenId);
        // Warp past EMERGENCY_EXIT_DELAY (7d) and the lock's expiry to avoid the
        // earlyExit penalty branch.
        vm.warp(vm.getBlockTimestamp() + 8 days + LOCK_30D);

        uint256 callTs = vm.getBlockTimestamp();
        vm.prank(alice); staking.executeEmergencyExit(tokenId);

        assertEq(
            staking.lastActivityAt(alice),
            callTs,
            "AUDIT M-AUDIT-2026-3: executeEmergencyExit must refresh lastActivityAt"
        );
    }

    /// @dev M16: while paused, request and cancel must NOT refresh the gate. Both are
    ///      pause-independent, so an unconditional touch lets a user cycle them to keep
    ///      `lastActivityAt` fresh indefinitely.
    function test_M16_requestAndCancelEmergencyExit_doNotTouchWhilePaused() public {
        vm.prank(alice); staking.stake(STAKE_AMT, LOCK_30D);
        uint256 tokenId = staking.userTokenId(alice);
        uint256 stakedAt = staking.lastActivityAt(alice);
        assertGt(stakedAt, 0, "stake must stamp lastActivityAt");

        vm.warp(vm.getBlockTimestamp() + 30 days);
        staking.pause();

        vm.prank(alice); staking.requestEmergencyExit(tokenId);
        assertEq(staking.lastActivityAt(alice), stakedAt, "M16: paused requestEmergencyExit must not touch");

        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(alice); staking.cancelEmergencyExit(tokenId);
        assertEq(staking.lastActivityAt(alice), stakedAt, "M16: paused cancelEmergencyExit must not touch");
    }
}
