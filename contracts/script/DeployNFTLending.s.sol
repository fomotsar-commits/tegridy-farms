// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/TegridyNFTLending.sol";

/// @title DeployNFTLending - Deploy the generic NFT P2P Lending contract
/// @dev Deploys TegridyNFTLending with mainnet constants from DeployFinal.s.sol
contract DeployNFTLendingScript is Script {
    // ─── Mainnet Constants (from DeployFinal.s.sol) ─────────────────
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;

    // ─── Default Fees ───────────────────────────────────────────────
    uint256 constant NFT_LENDING_FEE_BPS = 500; // 5% of interest earned

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address multisig = vm.envAddress("MULTISIG");
        require(multisig != address(0), "MULTISIG env var required");

        console.log("Deployer:", deployer);
        console.log("Multisig:", multisig);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy TegridyNFTLending - P2P generic NFT-collateralized lending
        TegridyNFTLending nftLending = new TegridyNFTLending(TREASURY, NFT_LENDING_FEE_BPS, WETH);
        console.log("1. TegridyNFTLending:", address(nftLending));

        // 2. Transfer ownership to multisig
        nftLending.transferOwnership(multisig);
        console.log("2. Ownership transfer initiated to:", multisig);

        vm.stopBroadcast();

        // ─── Summary ────────────────────────────────────────────────
        console.log("");
        console.log("=== NFT LENDING DEPLOYMENT COMPLETE ===");
        console.log("TegridyNFTLending:", address(nftLending));
        console.log("");
        console.log("Whitelisted collections (set in constructor):");
        console.log("  - JBAC:      0xd37264c71e9af940e49795F0d3a8336afAaFDdA9");
        console.log("  - Nakamigos: 0xd774557b647330C91Bf44cfEAB205095f7E6c367");
        console.log("  - GNSS Art:  0xa1De9f93c56C290C48849B1393b09eB616D55dbb");
        console.log("");
        console.log("NEXT STEPS:");
        console.log("  1. Multisig: acceptOwnership() on TegridyNFTLending");
        console.log("  2. Update frontend constants with deployed address");
        console.log("  3. Verify contract on Etherscan");
    }
}
