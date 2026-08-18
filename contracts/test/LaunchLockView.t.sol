// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LaunchLockView} from "../src/LaunchLockView.sol";
import {VestingFactory} from "../src/VestingFactory.sol";
import {TegridyLockVault} from "../src/TegridyLockVault.sol";

contract MockViewToken is ERC20 {
    constructor() ERC20("View", "VW") {
        _mint(msg.sender, 1_000_000 ether);
    }
}

/// @dev Has code, answers nothing this view asks for. Stands in for the realistic
///      failure: a rail address that points at the wrong contract.
contract NotARail {
    function unrelated() external pure returns (uint256) {
        return 1;
    }
}

/// @title  LaunchLockView tests — build plan item #28 read sister
/// @notice The tests that matter here are the honesty-gating ones. Every "unavailable"
///         case must be distinguishable from a genuine zero, because a UI that collapses
///         the two turns an outage into a claim about a token.
contract LaunchLockViewTest is Test {
    VestingFactory vestingFactory;
    TegridyLockVault lockVault;
    LaunchLockView lockView;
    MockViewToken token;

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address teamMember = makeAddr("teamMember");

    function setUp() public {
        vm.warp(1_700_000_000);
        vestingFactory = new VestingFactory(owner);
        lockVault = new TegridyLockVault(owner);
        lockView = new LaunchLockView(address(vestingFactory), address(lockVault));
        token = new MockViewToken();
        token.transfer(creator, 500_000 ether);
    }

    function _vest(uint256 amount) internal {
        vm.startPrank(creator);
        token.approve(address(vestingFactory), amount);
        vestingFactory.createVesting(address(token), teamMember, amount, uint64(block.timestamp), 365 days, 90 days);
        vm.stopPrank();
    }

    function _lock(uint256 amount, uint64 unlockAt) internal returns (uint256 id) {
        vm.startPrank(creator);
        token.approve(address(lockVault), amount);
        id = lockVault.lock(address(token), amount, unlockAt);
        vm.stopPrank();
    }

    // ─── Both rails live ─────────────────────────────────────────────

    function test_Snapshot_ReportsBothRails() public {
        uint64 t = uint64(block.timestamp);
        _vest(1000 ether);
        _vest(500 ether);
        _lock(200 ether, t + 45 days);
        _lock(300 ether, t + 90 days);

        LaunchLockView.LaunchLockSnapshot memory s = lockView.snapshot(address(token), 0, 100);
        assertTrue(s.vestingSourceAvailable);
        assertTrue(s.lockSourceAvailable);
        assertEq(s.vestedInflow, 1500 ether);
        assertEq(s.vestingWalletCount, 2);
        assertEq(s.lockedTotal, 500 ether);
        assertEq(s.lockedScanned, 500 ether);
        assertEq(s.earliestUnlockAt, t + 45 days);
        assertEq(s.latestUnlockAt, t + 90 days);
        assertEq(s.activeLockCount, 2);
        assertEq(s.nextLockOffset, 0, "complete scan must report zero");
    }

    /// @dev A token with nothing vested and nothing locked reports available == true with
    ///      zeros. This is the case a UI MAY render as "unlocked / unvested".
    function test_Snapshot_GenuineZeroIsAvailable() public view {
        LaunchLockView.LaunchLockSnapshot memory s = lockView.snapshot(address(0xC0FFEE), 0, 100);
        assertTrue(s.vestingSourceAvailable, "a zero answer is still an answer");
        assertTrue(s.lockSourceAvailable);
        assertEq(s.vestedInflow, 0);
        assertEq(s.lockedTotal, 0);
        assertEq(s.activeLockCount, 0);
    }

    function test_Snapshot_PartialLockScanAnnouncesItself() public {
        uint64 t = uint64(block.timestamp);
        _lock(200 ether, t + 45 days);
        _lock(300 ether, t + 90 days);

        LaunchLockView.LaunchLockSnapshot memory s = lockView.snapshot(address(token), 0, 1);
        assertEq(s.lockedTotal, 500 ether, "the vault total is complete regardless of the scan");
        assertEq(s.lockedScanned, 200 ether, "scanned figure covers the page only");
        assertEq(s.activeLockCount, 1);
        assertEq(s.nextLockOffset, 1, "truncated scan must hand back a continuation offset");

        // Zero limit skips the per-lock scan but still returns the complete vault total.
        s = lockView.snapshot(address(token), 0, 0);
        assertTrue(s.lockSourceAvailable);
        assertEq(s.lockedTotal, 500 ether);
        assertEq(s.lockedScanned, 0);
        assertEq(s.nextLockOffset, 0);
    }

    function test_Snapshot_WithdrawnLockLeavesTheTotals() public {
        uint64 t = uint64(block.timestamp);
        uint256 id = _lock(200 ether, t + 45 days);
        vm.warp(t + 45 days);
        vm.prank(creator);
        lockVault.withdraw(id);

        LaunchLockView.LaunchLockSnapshot memory s = lockView.snapshot(address(token), 0, 100);
        assertTrue(s.lockSourceAvailable);
        assertEq(s.lockedTotal, 0);
        assertEq(s.activeLockCount, 0);
        assertEq(s.earliestUnlockAt, 0, "no active lock means no expiry to print");
    }

    // ─── Honesty gating ──────────────────────────────────────────────

    function test_Honesty_UnsetVestingRailReportsNoData() public {
        LaunchLockView v = new LaunchLockView(address(0), address(lockVault));
        uint64 t = uint64(block.timestamp);
        _lock(200 ether, t + 45 days);

        LaunchLockView.LaunchLockSnapshot memory s = v.snapshot(address(token), 0, 100);
        assertFalse(s.vestingSourceAvailable, "unset rail must report NO DATA");
        assertEq(s.vestedInflow, 0, "and its numbers must be zero, not guessed");
        assertTrue(s.lockSourceAvailable, "the other rail must still answer");
        assertEq(s.lockedTotal, 200 ether);
    }

    function test_Honesty_UnsetLockRailReportsNoData() public {
        LaunchLockView v = new LaunchLockView(address(vestingFactory), address(0));
        _vest(1000 ether);

        LaunchLockView.LaunchLockSnapshot memory s = v.snapshot(address(token), 0, 100);
        assertTrue(s.vestingSourceAvailable);
        assertEq(s.vestedInflow, 1000 ether);
        assertFalse(s.lockSourceAvailable, "unset rail must report NO DATA");
        assertEq(s.lockedTotal, 0);
        assertEq(s.activeLockCount, 0);
    }

    /// @dev The realistic outage: a rail address that has code but is not the rail. It
    ///      must degrade to "unavailable" and must NOT take the working half down with it.
    function test_Honesty_WrongRailAddressDegradesRatherThanReverting() public {
        address notARail = address(new NotARail());
        LaunchLockView v = new LaunchLockView(notARail, address(lockVault));
        uint64 t = uint64(block.timestamp);
        _lock(200 ether, t + 45 days);

        LaunchLockView.LaunchLockSnapshot memory s = v.snapshot(address(token), 0, 100);
        assertFalse(s.vestingSourceAvailable, "a reverting rail must read as NO DATA");
        assertEq(s.vestedInflow, 0);
        assertTrue(s.lockSourceAvailable, "one broken rail must not blind the other");
        assertEq(s.lockedTotal, 200 ether);
    }

    function test_Honesty_EoaRailAddressDegrades() public {
        // An address with no code returns empty data, which decodes as a revert here.
        LaunchLockView v = new LaunchLockView(address(0xDEAD), address(lockVault));
        LaunchLockView.LaunchLockSnapshot memory s = v.snapshot(address(token), 0, 100);
        assertFalse(s.vestingSourceAvailable);
        assertTrue(s.lockSourceAvailable);
    }

    function test_Constructor_RejectsBothRailsUnset() public {
        vm.expectRevert(LaunchLockView.NoSourcesConfigured.selector);
        new LaunchLockView(address(0), address(0));
    }

    function test_View_IsImmutableAndHasNoAdminSurface() public {
        assertEq(address(lockView.vestingFactory()), address(vestingFactory));
        assertEq(address(lockView.lockVault()), address(lockVault));

        (bool a,) = address(lockView).call(abi.encodeWithSignature("owner()"));
        (bool b,) = address(lockView).call(abi.encodeWithSignature("setVestingFactory(address)", address(0xBEEF)));
        (bool c,) = address(lockView).call(abi.encodeWithSignature("setLockVault(address)", address(0xBEEF)));
        assertFalse(a || b || c, "the view must be repointable only by redeploy");
    }

    // ─── Fuzz ────────────────────────────────────────────────────────

    function testFuzz_ScannedNeverExceedsVaultTotal(uint96 rawA, uint96 rawB, uint256 limit) public {
        uint256 a = bound(uint256(rawA), 1, 100_000 ether);
        uint256 b = bound(uint256(rawB), 1, 100_000 ether);
        uint64 t = uint64(block.timestamp);
        _lock(a, t + 30 days);
        _lock(b, t + 60 days);

        LaunchLockView.LaunchLockSnapshot memory s = lockView.snapshot(address(token), 0, bound(limit, 0, 5));
        assertEq(s.lockedTotal, a + b);
        assertLe(s.lockedScanned, s.lockedTotal, "a page reported more than the vault holds");
        if (s.nextLockOffset == 0 && s.activeLockCount == 2) {
            assertEq(s.lockedScanned, s.lockedTotal, "a complete scan must match the total");
        }
    }
}
