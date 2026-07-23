// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {TegridyStakingJbacVault} from "../src/TegridyStakingJbacVault.sol";
import {PauseGuardian} from "../src/base/PauseGuardian.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title  MVPLaunch_StakeCapsAndGuardian — invariant tests for the Phase 0
///         security primitives added on the `mvp-launch` branch.
/// @notice Covers:
///         - Per-user stake cap enforcement (Aave V3 pattern)
///         - Global stake cap enforcement
///         - PauseGuardian-only pause() entry-point (Aave Emergency Guardian)
///         - Owner-only setPauseGuardian rotation
///         - Constructor defaults uncapped (operator sets at deploy)
contract MVPLaunch_StakeCapsAndGuardianTest is Test {
    TegridyStaking staking;
    MockTOWELI token;
    MockJBAC jbac;
    TegridyStakingJbacVault vault;
    // EIP-170 sibling (2026-07-23): stakeCapUtilizationBps / stakeCapHeadroom moved here.
    StakingMonitorView monitor;

    address owner          = address(this);
    address pauseGuardian  = makeAddr("pauseGuardian");
    address attacker       = makeAddr("attacker");
    address whale          = makeAddr("whale");
    address smallStaker    = makeAddr("smallStaker");
    address treasury       = makeAddr("treasury");

    uint256 constant MIN_STAKE = 100e18;
    uint256 constant LAUNCH_PER_USER = 50_000e18;
    uint256 constant LAUNCH_GLOBAL   = 5_000_000e18;

    function setUp() public {
        token = new MockTOWELI();
        jbac = new MockJBAC();
        staking = new TegridyStaking(address(token), address(jbac), treasury, 1e18);
        vault = new TegridyStakingJbacVault(address(jbac), address(staking));
        staking.setJbacVault(address(vault));
        monitor = new StakingMonitorView(address(staking));

        // Seed stakers with TOWELI and reward pool with TOWELI.
        token.transfer(whale, 10_000_000e18);
        token.transfer(smallStaker, 1_000_000e18);
        token.transfer(attacker, 1_000_000e18);

        vm.prank(whale);
        token.approve(address(staking), type(uint256).max);
        vm.prank(smallStaker);
        token.approve(address(staking), type(uint256).max);
        vm.prank(attacker);
        token.approve(address(staking), type(uint256).max);

        token.approve(address(staking), type(uint256).max);
        staking.notifyRewardAmount(1_000_000e18);
    }

    // ─── Constructor defaults ─────────────────────────────────────────

    function test_constructor_capsDefaultUncapped() public view {
        assertEq(staking.maxStakePerUser(), type(uint256).max);
        assertEq(staking.maxTotalStaked(),  type(uint256).max);
    }

    function test_constructor_pauseGuardianDefaultsZero() public view {
        assertEq(staking.pauseGuardian(), address(0));
    }

    // ─── Cap setters ──────────────────────────────────────────────────

    function test_setMaxStakePerUser_emitsAndUpdates() public {
        vm.expectEmit(true, true, true, true, address(staking));
        emit TegridyStaking.MaxStakePerUserChanged(type(uint256).max, LAUNCH_PER_USER);
        staking.setMaxStakePerUser(LAUNCH_PER_USER);
        assertEq(staking.maxStakePerUser(), LAUNCH_PER_USER);
    }

    function test_setMaxStakePerUser_zeroReverts() public {
        vm.expectRevert(TegridyStaking.CapCannotBeZero.selector);
        staking.setMaxStakePerUser(0);
    }

    function test_setMaxStakePerUser_nonOwnerReverts() public {
        vm.prank(attacker);
        vm.expectRevert(); // OZ Ownable revert
        staking.setMaxStakePerUser(LAUNCH_PER_USER);
    }

    function test_setMaxTotalStaked_emitsAndUpdates() public {
        vm.expectEmit(true, true, true, true, address(staking));
        emit TegridyStaking.MaxTotalStakedChanged(type(uint256).max, LAUNCH_GLOBAL);
        staking.setMaxTotalStaked(LAUNCH_GLOBAL);
        assertEq(staking.maxTotalStaked(), LAUNCH_GLOBAL);
    }

    function test_setMaxTotalStaked_zeroReverts() public {
        vm.expectRevert(TegridyStaking.CapCannotBeZero.selector);
        staking.setMaxTotalStaked(0);
    }

    // ─── Per-user cap enforcement ─────────────────────────────────────

    function test_stake_perUserCap_atBoundary_passes() public {
        staking.setMaxStakePerUser(LAUNCH_PER_USER);
        staking.setMaxTotalStaked(LAUNCH_GLOBAL);
        vm.prank(whale);
        staking.stake(LAUNCH_PER_USER, 365 days);
        assertEq(staking.totalStaked(), LAUNCH_PER_USER);
    }

    function test_stake_perUserCap_oneWei_overReverts() public {
        staking.setMaxStakePerUser(LAUNCH_PER_USER);
        staking.setMaxTotalStaked(LAUNCH_GLOBAL);
        vm.prank(whale);
        vm.expectRevert(TegridyStaking.PerUserStakeCapExceeded.selector);
        staking.stake(LAUNCH_PER_USER + 1, 365 days);
    }

    // ─── Global cap enforcement ───────────────────────────────────────

    function test_stake_globalCap_atBoundary_passes() public {
        // Cap global to just enough for one whale stake; per-user cap raised.
        uint256 amt = LAUNCH_PER_USER;
        staking.setMaxStakePerUser(amt);
        staking.setMaxTotalStaked(amt);
        vm.prank(whale);
        staking.stake(amt, 365 days);
        assertEq(staking.totalStaked(), amt);
    }

    function test_stake_globalCap_secondStakerBlocked() public {
        uint256 amt = LAUNCH_PER_USER;
        staking.setMaxStakePerUser(amt);
        staking.setMaxTotalStaked(amt);

        vm.prank(whale);
        staking.stake(amt, 365 days);

        // smallStaker has nothing — second stake at any nonzero amount over
        // the remaining headroom (= 0) reverts.
        vm.prank(smallStaker);
        vm.expectRevert(TegridyStaking.TotalStakeCapExceeded.selector);
        staking.stake(MIN_STAKE, 365 days);
    }

    // ─── increaseAmount() also enforces caps ──────────────────────────

    function test_increaseAmount_perUserCap_enforced() public {
        staking.setMaxStakePerUser(LAUNCH_PER_USER);
        staking.setMaxTotalStaked(LAUNCH_GLOBAL);

        vm.prank(whale);
        staking.stake(LAUNCH_PER_USER - MIN_STAKE, 365 days);
        uint256 tokenId = staking.userTokenId(whale);

        // Increase by 2 × MIN_STAKE would push past per-user cap.
        vm.prank(whale);
        vm.expectRevert(TegridyStaking.PerUserStakeCapExceeded.selector);
        staking.increaseAmount(tokenId, 2 * MIN_STAKE);
    }

    function test_increaseAmount_globalCap_enforced() public {
        uint256 amt = LAUNCH_PER_USER;
        staking.setMaxStakePerUser(LAUNCH_GLOBAL);
        staking.setMaxTotalStaked(amt);

        vm.prank(whale);
        staking.stake(amt - MIN_STAKE, 365 days);
        uint256 tokenId = staking.userTokenId(whale);

        vm.prank(whale);
        vm.expectRevert(TegridyStaking.TotalStakeCapExceeded.selector);
        staking.increaseAmount(tokenId, 2 * MIN_STAKE);
    }

    // ─── Pause guardian role ──────────────────────────────────────────

    function test_setPauseGuardian_updatesAndEmits() public {
        vm.expectEmit(true, true, true, true, address(staking));
        emit PauseGuardian.PauseGuardianSet(address(0), pauseGuardian);
        staking.setPauseGuardian(pauseGuardian);
        assertEq(staking.pauseGuardian(), pauseGuardian);
    }

    function test_setPauseGuardian_zeroReverts() public {
        vm.expectRevert(PauseGuardian.ZeroPauseGuardian.selector);
        staking.setPauseGuardian(address(0));
    }

    function test_setPauseGuardian_nonOwnerReverts() public {
        vm.prank(attacker);
        vm.expectRevert(); // OZ Ownable revert
        staking.setPauseGuardian(pauseGuardian);
    }

    function test_setPauseGuardian_unchangedReverts() public {
        staking.setPauseGuardian(pauseGuardian);
        vm.expectRevert(PauseGuardian.PauseGuardianUnchanged.selector);
        staking.setPauseGuardian(pauseGuardian);
    }

    function test_guardianPause_callableByGuardian() public {
        staking.setPauseGuardian(pauseGuardian);
        assertFalse(Pausable(staking).paused());

        vm.prank(pauseGuardian);
        staking.guardianPause();
        assertTrue(Pausable(staking).paused());
    }

    function test_guardianPause_attackerReverts() public {
        staking.setPauseGuardian(pauseGuardian);
        vm.prank(attacker);
        vm.expectRevert(PauseGuardian.NotPauseGuardian.selector);
        staking.guardianPause();
    }

    function test_guardianPause_ownerStillCannotCallIt() public {
        // The guardian-specific entry-point is guardian-only; owner has its
        // own pause() with the rewards-snapshot semantics. This separation is
        // intentional: owner uses pause(), guardian uses guardianPause().
        // Owner happens to also be tx.origin in this test — they should still
        // hit NotPauseGuardian on the guardian-only path.
        staking.setPauseGuardian(pauseGuardian);
        vm.expectRevert(PauseGuardian.NotPauseGuardian.selector);
        staking.guardianPause();
    }

    function test_guardianCannotUnpause() public {
        staking.setPauseGuardian(pauseGuardian);
        vm.prank(pauseGuardian);
        staking.guardianPause();

        // The guardian has NO unpause path. Confirm unpause() rejects guardian.
        vm.prank(pauseGuardian);
        vm.expectRevert(); // OZ Ownable revert (onlyOwner on unpause)
        staking.unpause();
    }

    function test_ownerCanUnpauseAfterGuardianPause() public {
        staking.setPauseGuardian(pauseGuardian);
        vm.prank(pauseGuardian);
        staking.guardianPause();
        staking.unpause();
        assertFalse(Pausable(staking).paused());
    }

    // ─── Cap utilization views (monitoring helpers) ───────────────────

    function test_stakeCapUtilizationBps_unset() public view {
        // Constructor default = uncapped (type(uint256).max). Helper
        // reports 0 to avoid divide-by-very-large.
        assertEq(monitor.stakeCapUtilizationBps(), 0);
    }

    function test_stakeCapUtilizationBps_setAndStake() public {
        staking.setMaxStakePerUser(LAUNCH_PER_USER);
        staking.setMaxTotalStaked(LAUNCH_GLOBAL);

        // No stakes yet — 0%.
        assertEq(monitor.stakeCapUtilizationBps(), 0);

        // Half the cap consumed: should report 5000 bps (50%).
        uint256 half = LAUNCH_GLOBAL / 2;
        // Stagger across two whales since per-user cap is < global.
        // Use boundary: stake LAUNCH_PER_USER per whale × N whales = half.
        address whaleA = makeAddr("whaleA");
        address whaleB = makeAddr("whaleB");
        token.transfer(whaleA, half);
        token.transfer(whaleB, half);
        vm.prank(whaleA); token.approve(address(staking), type(uint256).max);
        vm.prank(whaleB); token.approve(address(staking), type(uint256).max);

        // Each whale stakes at the per-user cap until global hits half.
        uint256 perStake = LAUNCH_PER_USER;
        uint256 staked = 0;
        uint256 whaleIdx = 0;
        address[2] memory whales = [whaleA, whaleB];

        while (staked + perStake <= half && whaleIdx < whales.length) {
            // Each whale can only stake once (single-position-per-user).
            vm.prank(whales[whaleIdx]);
            staking.stake(perStake, 365 days);
            staked += perStake;
            whaleIdx++;
        }

        // At least one stake landed: utilization should be > 0.
        assertGt(monitor.stakeCapUtilizationBps(), 0);
        // And it should match the formula exactly.
        assertEq(monitor.stakeCapUtilizationBps(), (staked * 10000) / LAUNCH_GLOBAL);
    }

    function test_stakeCapHeadroom_match() public {
        staking.setMaxStakePerUser(LAUNCH_PER_USER);
        staking.setMaxTotalStaked(LAUNCH_GLOBAL);

        assertEq(monitor.stakeCapHeadroom(), LAUNCH_GLOBAL);

        vm.prank(whale);
        staking.stake(LAUNCH_PER_USER, 365 days);

        assertEq(monitor.stakeCapHeadroom(), LAUNCH_GLOBAL - LAUNCH_PER_USER);
    }

    function test_stakeCapHeadroom_zeroAtCap() public {
        staking.setMaxStakePerUser(LAUNCH_PER_USER);
        staking.setMaxTotalStaked(LAUNCH_PER_USER); // global == per-user cap

        vm.prank(whale);
        staking.stake(LAUNCH_PER_USER, 365 days);

        assertEq(monitor.stakeCapHeadroom(), 0);
        assertEq(monitor.stakeCapUtilizationBps(), 10000);
    }

    function test_guardianRotation_instant() public {
        address newGuardian = makeAddr("newGuardian");
        staking.setPauseGuardian(pauseGuardian);
        staking.setPauseGuardian(newGuardian);
        assertEq(staking.pauseGuardian(), newGuardian);

        // Old guardian no longer authorized.
        vm.prank(pauseGuardian);
        vm.expectRevert(PauseGuardian.NotPauseGuardian.selector);
        staking.guardianPause();

        // New guardian is.
        vm.prank(newGuardian);
        staking.guardianPause();
        assertTrue(Pausable(staking).paused());
    }
}

// ─── Mocks ────────────────────────────────────────────────────────────

contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 100_000_000e18);
    }
}

contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;
    constructor() ERC721("JungleBay", "JBAC") {}
    function mint(address to) external { _mint(to, _nextId++); }
}
