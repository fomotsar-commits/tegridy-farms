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
    // RELAUNCH 2026-06-06: re-pointed from the stale pre-relaunch treasury
    // (0xE9B7…f53e) to the relaunch 2-of-2 Safe. This is the protocol-fee recipient
    // for EVERY launchpad mint, so it MUST be the live relaunch treasury.
    address constant TREASURY = 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d;

    // Same 5% fee as v1. Change via proposeProtocolFee() after deploy (48h timelock).
    uint16 constant LAUNCHPAD_FEE_BPS = 500;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        // FRESH-EYES M-13: keystore migration completion. Forge selects sender from --account/--private-key/--ledger CLI flags; reading PRIVATE_KEY from env defeats the keystore path.
        address multisig = vm.envAddress("MULTISIG");
        require(multisig != address(0), "MULTISIG env var required");

        console.log("=== Deploying TegridyLaunchpadV2 ===");
        console.log("Multisig:", multisig);
        console.log("Fee bps:", LAUNCHPAD_FEE_BPS);
        console.log("Fee recipient (treasury):", TREASURY);
        console.log("WETH:", WETH);

        vm.startBroadcast();
        address deployer = msg.sender;
        console.log("Deployer:", deployer);

        // AUDIT R062: per-chain Chainlink L2 Sequencer Uptime feed via SEQUENCER_FEED env;
        //             address(0) on mainnet / non-L2 (no-op).
        address SEQUENCER_FEED = vm.envOr("SEQUENCER_FEED", address(0));
        // AUDIT FIX FRESH-2026: H-9 follow-on — fail loud at deploy on L2 if feed unset.
        require(block.chainid == 1 || SEQUENCER_FEED != address(0), "DEPLOY: L2 needs SEQUENCER_FEED env");
        TegridyLaunchpadV2 factory = new TegridyLaunchpadV2(
            deployer,          // deployer owns first so we can transfer via 2-step
            LAUNCHPAD_FEE_BPS,
            TREASURY,
            WETH,
            SEQUENCER_FEED
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
