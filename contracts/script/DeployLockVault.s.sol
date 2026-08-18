// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyLockVault} from "../src/TegridyLockVault.sol";

/// @title  DeployLockVault — build plan item #28, the LP-lock half of the rails
/// @notice Deploys `TegridyLockVault`. Unlike its sibling `VestingFactory`, this contract
///         HOLDS the deposited tokens, so the deploy-time invariants below are the ones
///         that matter: the lock fee starts at zero, the sink starts unset, and no
///         owner-reachable path to a depositor's funds exists at any fee setting.
///
///         `withdraw` is not pausable. Verify that on the explorer before announcing the
///         rail — it is the property that makes a "LP locked" badge honest.
///
/// @dev    Env: MULTISIG (owner, must be a Safe), PAUSE_GUARDIAN (optional),
///         SEQUENCER_FEED (optional, must be `address(0)` on mainnet).
contract DeployLockVaultScript is Script {
    function run() external {
        address multisig = vm.envAddress("MULTISIG");
        address pauseGuardian = vm.envOr("PAUSE_GUARDIAN", address(0));
        address sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0));

        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(multisig != address(0), "set MULTISIG");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");
        require(sequencerFeed == address(0), "mainnet: SEQUENCER_FEED must be address(0)");
        if (pauseGuardian != address(0)) {
            require(pauseGuardian != multisig, "PAUSE_GUARDIAN must be disjoint from MULTISIG");
        }

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);

        TegridyLockVault vault = new TegridyLockVault(msg.sender);
        console2.log("TegridyLockVault deployed:", address(vault));

        if (pauseGuardian != address(0)) {
            vault.setPauseGuardian(pauseGuardian);
            console2.log("Pause guardian set:", pauseGuardian);
        }

        vault.transferOwnership(multisig); // 2-step; multisig must acceptOwnership()
        console2.log("Ownership transfer initiated to multisig:", multisig);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== INVARIANTS AT DEPLOY (verify on the explorer before announcing) ===");
        console2.log("lockFeeWei (must be 0):", vault.lockFeeWei());
        console2.log("feeSink (must be 0x0):", vault.feeSink());
        console2.log("MAX_LOCK_FEE_WEI (immutable cap):", vault.MAX_LOCK_FEE_WEI());
        console2.log("MIN_LOCK_DURATION:", vault.MIN_LOCK_DURATION());
        console2.log("nextLockId (must be 1; id 0 is reserved):", vault.nextLockId());
        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership()");
        if (pauseGuardian == address(0)) {
            console2.log("2. MULTISIG.setPauseGuardian(<hot 3-of-5, disjoint signers>)");
        }
        console2.log("3. Set LOCK_VAULT_ADDRESS in frontend/src/lib/constants.ts ->", address(vault));
        console2.log("4. Deploy LaunchLockView with VESTING_FACTORY + this address.");
        console2.log("");
        console2.log("=== FEE ENABLEMENT (do NOT run as part of this deploy) ===");
        console2.log("  a. proposeFeeSink(<sink>)         ; wait 48h ; executeFeeSink(<same>)");
        console2.log("  b. proposeLockFee(<wei, <= cap>)  ; wait 48h ; executeLockFee(<same>)");
    }
}
