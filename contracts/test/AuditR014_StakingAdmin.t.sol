// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {TegridyStaking} from "../src/TegridyStaking.sol";
import {TegridyStakingAdmin} from "../src/TegridyStakingAdmin.sol";

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT R014 — TegridyStaking admin & inactivity-gate remediations.
//   • H-2: setStakingAdmin is one-shot only for first install. Subsequent
//          replacements must travel through propose/execute with the 48h
//          ADMIN_REPLACEMENT_TIMELOCK and may be cancelled mid-flight.
//   • M-9: claimUnsettledFor by the contract owner is gated by
//          USER_INACTIVITY_GATE (90 days). The user themselves and the
//          restaking contract may always claim on the user's behalf.
// ─────────────────────────────────────────────────────────────────────────────

contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
}

contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external returns (uint256 id) { id = _nextId++; _mint(to, id); }
}

contract AuditR014_StakingAdminTest is Test {
    TegridyStaking public staking;
    TegridyStakingAdmin public admin;
    MockTOWELI public token;
    MockJBAC public nft;

    address public owner = address(this);
    address public treasury = makeAddr("treasury");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public restaker = makeAddr("restaker");

    function setUp() public {
        token = new MockTOWELI();
        nft = new MockJBAC();
        staking = new TegridyStaking(address(token), address(nft), treasury, 1 ether);
        admin = new TegridyStakingAdmin(address(staking));
        staking.setStakingAdmin(address(admin));

        token.transfer(alice, 1_000_000 ether);
        token.transfer(bob, 1_000_000 ether);

        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);

        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(10_000_000 ether);
    }

    // ───────────────────── H-2: setStakingAdmin one-shot ─────────────────────

    function test_h2_setStakingAdmin_worksOnce() public {
        // setUp already wired one admin; assert state matches expectations.
        assertEq(staking.stakingAdmin(), address(admin), "first-install admin wired");
    }

    function test_h2_setStakingAdmin_revertsOnSecondCall() public {
        TegridyStakingAdmin replacement = new TegridyStakingAdmin(address(staking));
        // Owner cannot rewire via setStakingAdmin once stakingAdmin != address(0).
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.setStakingAdmin(address(replacement));
    }

    function test_h2_setStakingAdmin_revertsOnZero() public {
        // Fresh staking instance to test zero-on-first-install.
        TegridyStaking fresh = new TegridyStaking(address(token), address(nft), treasury, 1 ether);
        vm.expectRevert(TegridyStaking.ZeroAddress.selector);
        fresh.setStakingAdmin(address(0));
    }

    // ───────────────────── H-2: timelocked replacement flow ─────────────────────

    function test_h2_proposeAdminReplacement_requiresOwner() public {
        TegridyStakingAdmin replacement = new TegridyStakingAdmin(address(staking));
        vm.prank(alice);
        // OZ Ownable: OwnableUnauthorizedAccount(alice)
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice)
        );
        staking.proposeAdminReplacement(address(replacement));
    }

    function test_h2_proposeAdminReplacement_revertsOnZero() public {
        vm.expectRevert(TegridyStaking.ZeroAddress.selector);
        staking.proposeAdminReplacement(address(0));
    }

    function test_h2_proposeAdminReplacement_revertsIfNoAdminInstalled() public {
        // Fresh staking with no admin wired — propose path explicitly forbidden.
        TegridyStaking fresh = new TegridyStaking(address(token), address(nft), treasury, 1 ether);
        TegridyStakingAdmin replacement = new TegridyStakingAdmin(address(fresh));
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        fresh.proposeAdminReplacement(address(replacement));
    }

    function test_h2_proposeAdminReplacement_setsPendingState() public {
        TegridyStakingAdmin replacement = new TegridyStakingAdmin(address(staking));
        staking.proposeAdminReplacement(address(replacement));
        assertEq(staking.pendingStakingAdmin(), address(replacement), "pending stored");
        assertEq(
            staking.adminReplacementReadyAt(),
            block.timestamp + uint256(48 hours) /* ADMIN_REPLACEMENT_TIMELOCK; internal in batch-14 */,
            "ready-at = now + 48h"
        );
    }

    function test_h2_proposeAdminReplacement_revertsWhenAlreadyPending() public {
        TegridyStakingAdmin a = new TegridyStakingAdmin(address(staking));
        TegridyStakingAdmin b = new TegridyStakingAdmin(address(staking));
        staking.proposeAdminReplacement(address(a));
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.proposeAdminReplacement(address(b));
    }

    function test_h2_executeAdminReplacement_revertsBeforeTimelock() public {
        TegridyStakingAdmin replacement = new TegridyStakingAdmin(address(staking));
        staking.proposeAdminReplacement(address(replacement));

        // 1 second before the deadline.
        vm.warp(block.timestamp + uint256(48 hours) /* ADMIN_REPLACEMENT_TIMELOCK; internal in batch-14 */ - 1);
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.executeAdminReplacement();
    }

    function test_h2_executeAdminReplacement_revertsWithoutProposal() public {
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.executeAdminReplacement();
    }

    function test_h2_executeAdminReplacement_swapsAdmin() public {
        TegridyStakingAdmin replacement = new TegridyStakingAdmin(address(staking));
        staking.proposeAdminReplacement(address(replacement));
        vm.warp(block.timestamp + uint256(48 hours) /* ADMIN_REPLACEMENT_TIMELOCK; internal in batch-14 */);

        staking.executeAdminReplacement();
        assertEq(staking.stakingAdmin(), address(replacement), "admin rotated");
        assertEq(staking.pendingStakingAdmin(), address(0), "pending cleared");
        assertEq(staking.adminReplacementReadyAt(), 0, "ready-at cleared");
    }

    function test_h2_newAdmin_canCallApply_oldAdminCannot() public {
        TegridyStakingAdmin oldAdmin = admin; // captured before swap
        TegridyStakingAdmin replacement = new TegridyStakingAdmin(address(staking));
        staking.proposeAdminReplacement(address(replacement));
        vm.warp(block.timestamp + uint256(48 hours) /* ADMIN_REPLACEMENT_TIMELOCK; internal in batch-14 */);
        staking.executeAdminReplacement();

        // ── New admin contract: end-to-end timelocked rewardRate change works.
        replacement.proposeRewardRate(2 ether);
        vm.warp(block.timestamp + replacement.REWARD_RATE_TIMELOCK());
        replacement.executeRewardRateChange();
        assertEq(staking.rewardRate(), 2 ether, "new admin path applies");

        // ── Old admin contract is no longer wired: its execute*Change cannot
        //    apply because TegridyStaking's onlyAdmin gate now rejects it.
        oldAdmin.proposeRewardRate(3 ether);
        vm.warp(block.timestamp + oldAdmin.REWARD_RATE_TIMELOCK());
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        oldAdmin.executeRewardRateChange();

        // ── Direct callers of applyRewardRate (anyone else) revert too.
        vm.prank(address(oldAdmin));
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.applyRewardRate(4 ether);
    }

    function test_h2_cancelAdminReplacement_clearsState() public {
        TegridyStakingAdmin replacement = new TegridyStakingAdmin(address(staking));
        staking.proposeAdminReplacement(address(replacement));
        staking.cancelAdminReplacement();
        assertEq(staking.pendingStakingAdmin(), address(0));
        assertEq(staking.adminReplacementReadyAt(), 0);
        // Original admin still wired.
        assertEq(staking.stakingAdmin(), address(admin));
    }

    function test_h2_cancelAdminReplacement_revertsIfNoneProposed() public {
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.cancelAdminReplacement();
    }

    // ───────────────────── M-9: claimUnsettledFor inactivity gate ─────────────────────

    /// @dev Set up an unsettled-rewards balance for `alice` by transferring her
    ///      staking NFT to `bob` after rewards accrue. The transfer settles
    ///      pending rewards from `_settleRewardsOnTransfer`, which routes the
    ///      payout through `_settleUnsettled`, populating `unsettledRewards[alice]`.
    function _seedUnsettledForAlice() internal returns (uint256 unsettled) {
        vm.prank(alice);
        staking.stake(500_000 ether, 30 days);

        // Accrue rewards.
        vm.warp(block.timestamp + 7 days);

        // Transfer NFT from alice to bob: cooldown is 24h, exceeded above.
        uint256 aliceId = staking.userTokenId(alice);
        vm.prank(alice);
        staking.transferFrom(alice, bob, aliceId);

        unsettled = staking.unsettledRewards(alice);
        require(unsettled > 0, "fixture: expected some unsettled");
    }

    function test_m9_claimUnsettledFor_byOwner_revertsWhenUserActive() public {
        _seedUnsettledForAlice();

        // Alice's stake() call refreshed lastActivityAt, then NFT-out also
        // refreshed it via _update.bob's receive (alice itself was the `from`,
        // but the seed call to stake() set alice's lastActivityAt). Either way,
        // alice was active <90d ago.
        assertTrue(
            staking.lastActivityAt(alice) + uint256(90 days) /* USER_INACTIVITY_GATE; internal in batch-14 */ >= block.timestamp,
            "alice is still in the inactivity window"
        );

        vm.prank(owner);
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.claimUnsettledFor(alice);
    }

    function test_m9_claimUnsettledFor_byOwner_succeedsAfterInactivity() public {
        uint256 unsettled = _seedUnsettledForAlice();
        uint256 aliceBalBefore = token.balanceOf(alice);

        // Skip past the 90-day inactivity window. +1 second past the gate.
        vm.warp(block.timestamp + uint256(90 days) /* USER_INACTIVITY_GATE; internal in batch-14 */ + 1);

        // Owner is now allowed to claim on alice's behalf.
        vm.prank(owner);
        staking.claimUnsettledFor(alice);

        // Funds went to alice, not the caller (owner).
        assertGt(token.balanceOf(alice), aliceBalBefore, "alice received tokens");
        assertEq(staking.unsettledRewards(alice), 0, "all unsettled drained");
        // Sanity: unsettled was non-trivial.
        assertGt(unsettled, 0);
    }

    function test_m9_claimUnsettledFor_byUserAlwaysAllowed() public {
        _seedUnsettledForAlice();
        // User can always claim regardless of activity timestamp.
        vm.prank(alice);
        staking.claimUnsettledFor(alice);
        assertEq(staking.unsettledRewards(alice), 0);
    }

    function test_m9_claimUnsettledFor_byRestakingContract_unchanged() public {
        // Wire restaker as the restakingContract via the timelocked admin path.
        admin.proposeRestakingContract(restaker);
        vm.warp(block.timestamp + admin.RESTAKING_CHANGE_TIMELOCK());
        admin.executeRestakingContract();
        assertEq(staking.restakingContract(), restaker);

        _seedUnsettledForAlice();
        // Restaker can still claim on alice's behalf without the inactivity gate.
        vm.prank(restaker);
        staking.claimUnsettledFor(alice);
        assertEq(staking.unsettledRewards(alice), 0);
    }

    function test_m9_claimUnsettledFor_byRandom_reverts() public {
        _seedUnsettledForAlice();
        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        vm.expectRevert(TegridyStaking.Unauthorized.selector);
        staking.claimUnsettledFor(alice);
    }

    function test_m9_lastActivityAt_isRefreshedByGetReward() public {
        vm.prank(alice);
        staking.stake(500_000 ether, 30 days);

        // Warp a long way and then claim — getReward should refresh the timestamp.
        vm.warp(block.timestamp + 100 days);
        uint256 aliceId = staking.userTokenId(alice);
        vm.prank(alice);
        staking.getReward(aliceId);

        assertEq(staking.lastActivityAt(alice), block.timestamp, "getReward refreshed activity");
    }

    function test_m9_lastActivityAt_isRefreshedByIncreaseAmount() public {
        vm.prank(alice);
        staking.stake(500_000 ether, 30 days);

        vm.warp(block.timestamp + 5 days);
        uint256 aliceId = staking.userTokenId(alice);
        vm.prank(alice);
        staking.increaseAmount(aliceId, 100_000 ether);

        assertEq(staking.lastActivityAt(alice), block.timestamp, "increaseAmount refreshed activity");
    }

    function test_m9_lastActivityAt_isRefreshedByExtendLock() public {
        vm.prank(alice);
        staking.stake(500_000 ether, 30 days);

        vm.warp(block.timestamp + 5 days);
        uint256 aliceId = staking.userTokenId(alice);
        vm.prank(alice);
        staking.extendLock(aliceId, 60 days);

        assertEq(staking.lastActivityAt(alice), block.timestamp, "extendLock refreshed activity");
    }

    function test_m9_lastActivityAt_isRefreshedByWithdraw() public {
        vm.prank(alice);
        staking.stake(500_000 ether, 7 days);

        vm.warp(block.timestamp + 7 days + 1);
        uint256 aliceId = staking.userTokenId(alice);
        vm.prank(alice);
        staking.withdraw(aliceId);

        assertEq(staking.lastActivityAt(alice), block.timestamp, "withdraw refreshed activity");
    }

    function test_m9_lastActivityAt_isRefreshedOnNftReceive() public {
        // Bob stakes, then transfers his NFT to a fresh address `eve`. Eve's
        // lastActivityAt should be set to the transfer block.
        address eve = makeAddr("eve");
        vm.prank(bob);
        staking.stake(500_000 ether, 30 days);

        vm.warp(block.timestamp + 2 days);
        uint256 bobId = staking.userTokenId(bob);
        vm.prank(bob);
        staking.transferFrom(bob, eve, bobId);

        assertEq(staking.lastActivityAt(eve), block.timestamp, "NFT receive refreshed eve's activity");
    }

    // ─────────────── ADMIN-1: proposeMaxUnsettledRewards event ───────────────

    /// @notice Mirror the typed event topic so we can `expectEmit` it locally.
    event MaxUnsettledRewardsProposed(uint256 newCap, uint256 executeAfter);

    /// @notice AUDIT ADMIN-1 (2026-04-28): proposeMaxUnsettledRewards must emit
    ///         a typed proposal event for parity with all other propose* sisters.
    function test_admin1_proposeMaxUnsettledRewards_emitsTypedEvent() public {
        uint256 newCap = 25_000e18;
        uint256 expectedReadyAt = block.timestamp + admin.UNSETTLED_CAP_TIMELOCK();
        vm.expectEmit(false, false, false, true, address(admin));
        emit MaxUnsettledRewardsProposed(newCap, expectedReadyAt);
        admin.proposeMaxUnsettledRewards(newCap);
    }
}
