// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";

/// @title  StakingMonitorViewConstants — drift guard for the EIP-170 constant move
/// @notice EIP-170 golf (2026-07-23) dropped MIN/MAX_LOCK_DURATION, MIN/MAX_BOOST_BPS
///         and JBAC_BONUS_BPS from `public` to `internal` on TegridyStaking to reclaim
///         their auto-getter bytecode, and re-exposed them on StakingMonitorView so the
///         values stay readable on-chain.
///
///         The compiler CANNOT link the two sets (the host's are `internal`), so the
///         sibling holds hand-copied literals. That is a drift hazard: someone could
///         retune a bound on TegridyStaking and leave the sibling reporting the old
///         value, and nothing would fail.
///
///         This file closes that hole by pinning every sibling constant to behaviour
///         the HOST still exposes — `calculateBoost`, which stays `public` because the
///         frontend reads it. `calculateBoost` is defined purely in terms of the host's
///         four lock/boost constants:
///
///             calculateBoost(d <= MIN_LOCK_DURATION) == MIN_BOOST_BPS
///             calculateBoost(d >= MAX_LOCK_DURATION) == MAX_BOOST_BPS
///
///         so probing it at and around the sibling's claimed bounds detects any change
///         to any of the four on either side. JBAC_BONUS_BPS is pinned through the
///         boost actually written by `stakeWithBoost`.
contract StakingMonitorViewConstantsTest is Test {
    TegridyStaking staking;
    StakingMonitorView monitor;
    MockTOWELI toweli;
    MockJBAC jbac;

    address treasury = makeAddr("treasury");

    function setUp() public {
        toweli = new MockTOWELI();
        jbac = new MockJBAC();
        staking = new TegridyStaking(address(toweli), address(jbac), treasury, 1e18);
        monitor = new StakingMonitorView(address(staking));
    }

    /// @notice The sibling's MIN_BOOST_BPS is exactly what the host's curve pays at the
    ///         sibling's MIN_LOCK_DURATION. Pins MIN_BOOST_BPS *and* MIN_LOCK_DURATION.
    function test_minBoostAndMinLock_matchHostCurve() public view {
        uint256 minLock = monitor.MIN_LOCK_DURATION();
        assertEq(
            staking.calculateBoost(minLock),
            monitor.MIN_BOOST_BPS(),
            "sibling MIN_BOOST_BPS drifted from host calculateBoost(MIN_LOCK_DURATION)"
        );
        // Just past the floor the curve must already be strictly above MIN_BOOST_BPS —
        // proves the sibling's MIN_LOCK_DURATION is the true clamp point and not merely
        // some duration inside a wider flat region (which is what a host-side widening
        // of MIN_LOCK_DURATION would look like).
        //
        // The probe steps 1 hour, not 1 second: the curve is integer division
        // (elapsed * 36000 / ~125.8M seconds), so it takes ~3,494 s to gain a single
        // bps. A 1-second probe truncates to +0 and would fail against a correct
        // contract.
        assertGt(
            staking.calculateBoost(minLock + 1 hours),
            monitor.MIN_BOOST_BPS(),
            "sibling MIN_LOCK_DURATION is not the host's actual lower clamp"
        );
    }

    /// @notice The sibling's MAX_BOOST_BPS is exactly what the host's curve pays at the
    ///         sibling's MAX_LOCK_DURATION. Pins MAX_BOOST_BPS *and* MAX_LOCK_DURATION.
    function test_maxBoostAndMaxLock_matchHostCurve() public view {
        uint256 maxLock = monitor.MAX_LOCK_DURATION();
        assertEq(
            staking.calculateBoost(maxLock),
            monitor.MAX_BOOST_BPS(),
            "sibling MAX_BOOST_BPS drifted from host calculateBoost(MAX_LOCK_DURATION)"
        );
        // Just short of the ceiling the curve must be strictly below it — proves the
        // sibling's MAX_LOCK_DURATION is the true clamp point. Same 1-hour step as the
        // MIN probe, for the same integer-truncation reason.
        assertLt(
            staking.calculateBoost(maxLock - 1 hours),
            monitor.MAX_BOOST_BPS(),
            "sibling MAX_LOCK_DURATION is not the host's actual upper clamp"
        );
    }

    /// @notice JBAC_BONUS_BPS is pinned through the boost `stakeWithBoost` actually
    ///         writes: a max-lock JBAC position must carry MAX_BOOST_BPS + JBAC_BONUS_BPS.
    function test_jbacBonus_matchesHostStakeWithBoost() public {
        // The vault is required by stakeWithBoost; deploy + wire it.
        MockVault vault = new MockVault();
        staking.setJbacVault(address(vault));

        address user = makeAddr("user");
        toweli.transfer(user, 10_000e18);
        jbac.mint(user, 1);

        vm.startPrank(user);
        toweli.approve(address(staking), type(uint256).max);
        jbac.setApprovalForAll(address(staking), true);
        staking.stakeWithBoost(10_000e18, monitor.MAX_LOCK_DURATION(), 1);
        vm.stopPrank();

        (, , , , uint16 boostBps, , , , , , ) = staking.positions(1);
        assertEq(
            uint256(boostBps),
            monitor.MAX_BOOST_BPS() + monitor.JBAC_BONUS_BPS(),
            "sibling JBAC_BONUS_BPS drifted from the bonus host stakeWithBoost applies"
        );
    }
}

contract MockTOWELI is ERC20 {
    constructor() ERC20("Toweli", "TOWELI") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

contract MockJBAC is ERC721 {
    constructor() ERC721("JBAC", "JBAC") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// @dev Minimal stand-in for TegridyStakingJbacVault: only needs to accept the JBAC
///      and satisfy the host's `code.length != 0 && != 23` type-filter.
contract MockVault {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function returnJbac(uint256, uint256, address) external {}
}
