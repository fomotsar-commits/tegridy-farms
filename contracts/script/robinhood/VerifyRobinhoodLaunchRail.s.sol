// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyLaunchpadV2} from "../../src/TegridyLaunchpadV2.sol";
import {TegridyLockVault} from "../../src/TegridyLockVault.sol";
import {VestingFactory} from "../../src/VestingFactory.sol";
import {AirdropFactory} from "../../src/AirdropFactory.sol";
import {LaunchRugEscrow} from "../../src/LaunchRugEscrow.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RobinhoodChainConfig} from "./RobinhoodChainConfig.sol";

/// @title  VerifyRobinhoodLaunchRail — post-ceremony invariant check for the
///         Robinhood Chain (4663) launch rail (and, optionally, the LP farm).
/// @notice DeployRobinhoodLaunchRail offers five ownerships two-step; a missed accept
///         rots silently for 14 days and then strands the contract with the
///         deployer. This script is what makes that visible: run it after the
///         Safe's acceptance batch, green before any surface points at the rail.
///
/// @dev    Env vars: TREASURY, MULTISIG, PAUSE_GUARDIAN, SEQUENCER_FEED,
///         LAUNCHPAD, LOCK_VAULT, VESTING_FACTORY, AIRDROP_FACTORY, RUG_ESCROW,
///         and optionally FARM (0 /unset to skip — farming deploys later).
contract VerifyRobinhoodLaunchRailScript is Script {
    struct Inventory {
        address treasury;
        address multisig;
        address pauseGuardian;
        address sequencerFeed;
        address launchpad;
        address lockVault;
        address vestingFactory;
        address airdropFactory;
        address rugEscrow;
        address farm; // optional; address(0) skips the farm block
    }

    function run() external view {
        Inventory memory inv = Inventory({
            treasury: vm.envAddress("TREASURY"),
            multisig: vm.envAddress("MULTISIG"),
            pauseGuardian: vm.envAddress("PAUSE_GUARDIAN"),
            sequencerFeed: vm.envAddress("SEQUENCER_FEED"),
            launchpad: vm.envAddress("LAUNCHPAD"),
            lockVault: vm.envAddress("LOCK_VAULT"),
            vestingFactory: vm.envAddress("VESTING_FACTORY"),
            airdropFactory: vm.envAddress("AIRDROP_FACTORY"),
            rugEscrow: vm.envAddress("RUG_ESCROW"),
            farm: vm.envOr("FARM", address(0))
        });
        check(inv);
    }

    function check(Inventory memory inv) public view {
        require(block.chainid == RobinhoodChainConfig.CHAIN_ID, "LRV-0: not Robinhood Chain (4663)");
        console.log("LRV-0:  chain is Robinhood (4663) ................ OK");

        // Ownership accepted, nothing stale, on every owned rail contract.
        address[5] memory owned =
            [inv.launchpad, inv.lockVault, inv.vestingFactory, inv.airdropFactory, inv.rugEscrow];
        string[5] memory names = ["launchpad", "lockVault", "vestingFactory", "airdropFactory", "rugEscrow"];
        for (uint256 i = 0; i < owned.length; i++) {
            require(
                Ownable(owned[i]).owner() == inv.multisig,
                string.concat("LRV-1: ", names[i], " owner != multisig (accept missed?)")
            );
            require(
                _pendingOwner(owned[i]) == address(0),
                string.concat("LRV-2: ", names[i], " pendingOwner not cleared")
            );
        }
        console.log("LRV-1:  five ownerships accepted by the Safe ..... OK");
        console.log("LRV-2:  no stale pending-owner ................... OK");

        TegridyLaunchpadV2 lp = TegridyLaunchpadV2(inv.launchpad);
        require(lp.weth() == RobinhoodChainConfig.WETH, "LRV-3a: launchpad WETH != Robinhood WETH");
        require(lp.sequencerFeed() == inv.sequencerFeed, "LRV-3b: launchpad feed mismatch");
        RobinhoodChainConfig.requireUptimeDialect(lp.sequencerFeed(), "LRV-3c: launchpad feed");
        require(lp.dropTemplate() != address(0), "LRV-3d: drop template missing");
        require(lp.protocolFeeRecipient() == inv.treasury, "LRV-3e: fee recipient != treasury");
        console.log("LRV-3:  launchpad wiring (WETH/feed/template) .... OK");

        require(
            LaunchRugEscrow(payable(inv.rugEscrow)).weth() == RobinhoodChainConfig.WETH,
            "LRV-4: escrow WETH != Robinhood WETH"
        );
        console.log("LRV-4:  escrow WETH canonical .................... OK");
        if (LaunchRugEscrow(payable(inv.rugEscrow)).openingsEnabled()) {
            console.log("LRV-4b: escrow openings are ENABLED - someone took that go-live step.");
        } else {
            console.log("LRV-4b: escrow openings still disabled (the shipping state).");
        }

        require(
            TegridyLockVault(payable(inv.lockVault)).pauseGuardian() == inv.pauseGuardian,
            "LRV-5a: lockVault guardian"
        );
        require(
            VestingFactory(payable(inv.vestingFactory)).pauseGuardian() == inv.pauseGuardian,
            "LRV-5b: vestingFactory guardian"
        );
        require(
            AirdropFactory(payable(inv.airdropFactory)).pauseGuardian() == inv.pauseGuardian,
            "LRV-5c: airdropFactory guardian"
        );
        console.log("LRV-5:  pauseGuardian wired on 3 Pausable rails .. OK");

        if (inv.farm != address(0)) {
            require(Ownable(inv.farm).owner() == inv.multisig, "LRV-6a: farm owner != multisig");
            require(_pendingOwner(inv.farm) == address(0), "LRV-6b: farm pendingOwner not cleared");
            console.log("LRV-6:  farm ownership accepted .................. OK");
        } else {
            console.log("LRV-6:  no farm passed (deploys later) ........... skipped");
        }

        console.log("");
        console.log("=== ALL ROBINHOOD LAUNCH-RAIL INVARIANTS GREEN ===");
    }

    function _pendingOwner(address c) internal view returns (address p) {
        (bool ok, bytes memory data) = c.staticcall(abi.encodeWithSignature("pendingOwner()"));
        if (!ok || data.length < 32) return address(0);
        p = abi.decode(data, (address));
    }
}
