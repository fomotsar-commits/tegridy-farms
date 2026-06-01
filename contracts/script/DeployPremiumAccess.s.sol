// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {PremiumAccess} from "../src/PremiumAccess.sol";

/// @title  DeployPremiumAccess — per-wave deploy for the restored Gold Card feature
/// @notice Deploys PremiumAccess (TOWELI-paid subscription + JBAC-NFT lifetime
///         access) and hands ownership to the multisig (OwnableNoRenounce =
///         2-step; the multisig must call acceptOwnership()).
///
/// @dev    Pattern mirrors DeployV4.s.sol / DeployTegridyLPFarming.s.sol:
///         env-driven addresses with zero-checks, deploy, transferOwnership →
///         multisig, then log address + the operator steps kept OUT of the
///         automated script.
///
/// @dev    Env: TOWELI, JBAC_NFT, TREASURY, MONTHLY_FEE (wei of TOWELI/month),
///         MULTISIG.
///
/// @dev    OPERATIONAL STEPS NOT IN THIS SCRIPT (multisig, post-deploy):
///           1. MULTISIG.acceptOwnership()
///           2. (optional) set the PauseGuardian if/when wired
///           3. Update PREMIUM_ACCESS_ADDRESS in frontend/src/lib/constants.ts
///              with the deployed address — the /premium page auto-un-gates.
contract DeployPremiumAccessScript is Script {
    function run() external {
        address toweli = vm.envAddress("TOWELI");
        address jbacNFT = vm.envAddress("JBAC_NFT");
        address treasury = vm.envAddress("TREASURY");
        uint256 monthlyFee = vm.envUint("MONTHLY_FEE");
        address multisig = vm.envAddress("MULTISIG");
        require(toweli != address(0) && jbacNFT != address(0) && treasury != address(0), "zero env");
        require(multisig != address(0), "set MULTISIG"); // never silently leave deployer as owner
        require(monthlyFee > 0, "set MONTHLY_FEE");

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);

        PremiumAccess premium = new PremiumAccess(toweli, jbacNFT, treasury, monthlyFee);
        console2.log("PremiumAccess deployed:", address(premium));

        premium.transferOwnership(multisig); // OwnableNoRenounce 2-step; multisig must acceptOwnership()
        console2.log("Ownership transfer initiated to multisig:", multisig);

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership()");
        console2.log("2. Set PREMIUM_ACCESS_ADDRESS in frontend/src/lib/constants.ts ->", address(premium));
    }
}
