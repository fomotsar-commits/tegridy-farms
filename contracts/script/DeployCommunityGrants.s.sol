// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {CommunityGrants} from "../src/CommunityGrants.sol";

/// @title  DeployCommunityGrants — per-wave deploy for the restored grants/governance
/// @notice veTOWELI governance proposals with OZ-Governor-style snapshot quorum +
///         WETH-fallback payouts. Hands ownership to the multisig (2-step).
/// @dev    Env: STAKING (votingEscrow / vote power), TOWELI, TREASURY (feeReceiver),
///         WETH, MULTISIG.
contract DeployCommunityGrantsScript is Script {
    function run() external {
        address votingEscrow = vm.envAddress("STAKING");
        address toweli = vm.envAddress("TOWELI");
        address feeReceiver = vm.envAddress("TREASURY");
        address weth = vm.envAddress("WETH");
        address multisig = vm.envAddress("MULTISIG");
        require(votingEscrow != address(0) && toweli != address(0) && feeReceiver != address(0) && weth != address(0), "zero env");
        require(multisig != address(0), "set MULTISIG");
        // 2026-07-15 pre-deploy hardening: fleet-standard mainnet + Safe-owner guards.
        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        CommunityGrants grants = new CommunityGrants(votingEscrow, toweli, feeReceiver, weth);
        console2.log("CommunityGrants deployed:", address(grants));
        grants.transferOwnership(multisig); // 2-step; multisig must acceptOwnership()
        console2.log("Ownership transfer initiated to multisig:", multisig);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership()");
        console2.log("2. Set COMMUNITY_GRANTS_ADDRESS in frontend/src/lib/constants.ts ->", address(grants));
    }
}
