// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {GaugeController} from "../src/GaugeController.sol";

/// @title  DeployGaugeController — per-wave deploy for the restored gauge voting
/// @notice ve-style gauge voting with H-2 commit-reveal. Hands ownership to the
///         multisig (2-step). EMISSION_BUDGET is deploy-time policy — REVIEW.
/// @dev    Env: STAKING (vote power source), EMISSION_BUDGET (TOWELI/epoch, default
///         1,000,000e18 = last-known), MULTISIG.
contract DeployGaugeControllerScript is Script {
    function run() external {
        address staking = vm.envAddress("STAKING");
        // REVIEW before mainnet — default is the last-known live value (1M TOWELI/epoch).
        uint256 emissionBudget = vm.envOr("EMISSION_BUDGET", uint256(1_000_000 ether));
        address multisig = vm.envAddress("MULTISIG");
        require(staking != address(0), "zero env");
        require(multisig != address(0), "set MULTISIG");
        // 2026-07-15 pre-deploy hardening: fleet-standard guards (siblings DeployMVP/DeployTWAP/
        // DeployLaunchpadV2 carry these). Refuse a wrong-network broadcast + require the owner
        // to be a contract (Safe) so a typo'd/EOA MULTISIG can't take pending ownership.
        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        console2.log("Emission budget (TOWELI/epoch):", emissionBudget);
        GaugeController gauge = new GaugeController(staking, emissionBudget);
        console2.log("GaugeController deployed:", address(gauge));
        gauge.transferOwnership(multisig); // 2-step; multisig must acceptOwnership()
        console2.log("Ownership transfer initiated to multisig:", multisig);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership()");
        console2.log("2. Set GAUGE_CONTROLLER_ADDRESS in frontend/src/lib/constants.ts ->", address(gauge));
    }
}
