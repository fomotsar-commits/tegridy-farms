// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyHarvestVault} from "../src/vaults/TegridyHarvestVault.sol";

/// @title DeployHarvestVault — ERC-4626 auto-compounder over an existing TegridyLPFarming
/// @notice Deploys one vault, hands ownership to the Safe, and stops. It wires no fee and
///         no fee sink: the vault ships with `performanceFeeBps == 0` and
///         `feeRecipient == address(0)`, and each of those takes a separate 48h timelocked
///         propose/execute by the Safe. This script cannot turn revenue on.
///
/// @dev Every address is read from the environment rather than hardcoded. The live farm,
///      router and LP addresses belong in the operator's deploy shell (or the gated
///      runbook), not in version control where a stale constant becomes a silent
///      mis-deploy — the treasury-address drift recorded in DeployTegridyLPFarming.s.sol
///      is the precedent this avoids. The vault constructor cross-checks all three against
///      each other, so a wrong value reverts at construction rather than after funds land.
///
///      Required environment:
///        HARVEST_VAULT_ASSET   — the TOWELI/WETH TegridyPair LP token
///        HARVEST_VAULT_FARM    — live TegridyLPFarming whose stakingToken is that LP
///        HARVEST_VAULT_ROUTER  — TegridyRouter (must expose the LP's WETH leg)
///        HARVEST_VAULT_OWNER   — Safe that will own the vault
///
///      Run:
///        forge script script/DeployHarvestVault.s.sol --rpc-url mainnet --account <keystore>
///      Add --broadcast only after a dry run prints the expected wiring.
contract DeployHarvestVaultScript is Script {
    string constant VAULT_NAME = "Tegridy Auto-Compounding TOWELI/WETH";
    string constant VAULT_SYMBOL = "acTLP";

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        address asset = vm.envAddress("HARVEST_VAULT_ASSET");
        address farm = vm.envAddress("HARVEST_VAULT_FARM");
        address router = vm.envAddress("HARVEST_VAULT_ROUTER");
        address safe = vm.envAddress("HARVEST_VAULT_OWNER");

        require(asset != address(0), "ZERO_ASSET");
        require(farm != address(0), "ZERO_FARM");
        require(router != address(0), "ZERO_ROUTER");
        require(safe != address(0), "ZERO_OWNER");
        require(safe.code.length > 0, "OWNER_NOT_CONTRACT");

        console.log("=== Deploying TegridyHarvestVault ===");
        console.log("Asset (LP):", asset);
        console.log("Farm:", farm);
        console.log("Router:", router);
        console.log("Safe (incoming owner):", safe);

        vm.startBroadcast();
        console.log("Deployer:", msg.sender);

        TegridyHarvestVault vault =
            new TegridyHarvestVault(asset, farm, router, msg.sender, VAULT_NAME, VAULT_SYMBOL);
        console.log("1. TegridyHarvestVault deployed:", address(vault));

        vault.transferOwnership(safe);
        console.log("2. Ownership transfer initiated to:", safe);

        vm.stopBroadcast();

        console.log("");
        console.log("=== POST-DEPLOY STATE (assert before announcing) ===");
        console.log("performanceFeeBps (expect 0):", vault.performanceFeeBps());
        console.log("feeRecipient (expect 0x0):", vault.feeRecipient());
        console.log("farmMinStake:", vault.farmMinStake());
        console.log("");
        console.log("=== NEXT STEPS (operator) ===");
        console.log("1. Safe: acceptOwnership()");
        console.log("2. Safe: setKeeper(<harvest bot>, true) -- harvest() is allow-listed, not public");
        console.log("3. Seed a first deposit and run one harvest before any APY is rendered anywhere");
        console.log("4. Fee stays OFF until the Safe runs proposeFeeRecipient + proposePerformanceFee");
        console.log("   and executes BOTH after 48h. Either one alone charges nothing.");
        console.log("");
        console.log("=== BOOST DISCLOSURE (must reach the UI before launch) ===");
        console.log("The vault holds no TegridyStaking NFT, so the farm floors it to 1.0x.");
        console.log("Depositors do NOT inherit their own veTOWELI boost through this vault.");
    }
}
