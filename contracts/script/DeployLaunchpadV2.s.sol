// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/TegridyLaunchpadV2.sol";

/// @title DeployLaunchpadV2 — Deploy the click-deploy NFT launchpad factory
/// @notice Ships alongside v1. v1 stays live for existing collections; v2
///         accepts a single CollectionConfig struct for one-shot creator deploys.
///         Constructor auto-deploys the TegridyDropV2 template; getDropTemplate()
///         exposes it for verification.
contract DeployLaunchpadV2Script is Script {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;

    // Same 5% fee as v1. Change via proposeProtocolFee() after deploy (48h timelock).
    uint16 constant LAUNCHPAD_FEE_BPS = 500;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address multisig = vm.envAddress("MULTISIG");
        require(multisig != address(0), "MULTISIG env var required");

        console.log("=== Deploying TegridyLaunchpadV2 ===");
        console.log("Deployer:", deployer);
        console.log("Multisig:", multisig);
        console.log("Fee bps:", LAUNCHPAD_FEE_BPS);
        console.log("Fee recipient (treasury):", TREASURY);
        console.log("WETH:", WETH);

        vm.startBroadcast(deployerPrivateKey);

        TegridyLaunchpadV2 factory = new TegridyLaunchpadV2(
            deployer,          // deployer owns first so we can transfer via 2-step
            LAUNCHPAD_FEE_BPS,
            TREASURY,
            WETH
        );

        console.log("1. TegridyLaunchpadV2:", address(factory));
        console.log("   dropTemplate:", factory.dropTemplate());

        // Kick off 2-step ownership transfer to multisig.
        factory.transferOwnership(multisig);
        console.log("2. Ownership transfer initiated to multisig");

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("TegridyLaunchpadV2:", address(factory));
        console.log("Drop template (v2):", factory.dropTemplate());
        console.log("");
        console.log("=== NEXT STEPS ===");
        console.log("1. Multisig: acceptOwnership() on TegridyLaunchpadV2");
        console.log("2. Update frontend/src/lib/constants.ts:");
        console.log("   - Set TEGRIDY_LAUNCHPAD_V2_ADDRESS");
        console.log("   - (V1 TEGRIDY_LAUNCHPAD_ADDRESS was retired 2026-04-19)");
        console.log("3. Update frontend/wagmi.config.ts with v2 ABI + address");
        console.log("4. Regenerate: cd frontend && npm run wagmi:generate");
        console.log("5. Verify on Etherscan:");
        console.log("   forge verify-contract <factory> TegridyLaunchpadV2 --chain mainnet");
        console.log("   forge verify-contract <template> TegridyDropV2 --chain mainnet");
    }
}
