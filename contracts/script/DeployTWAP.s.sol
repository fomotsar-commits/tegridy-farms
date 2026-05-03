// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/TegridyTWAP.sol";

/// @title DeployTWAP — Deploy the on-chain TWAP oracle
/// @dev Deploys TegridyTWAP (stateless singleton — no constructor args).
///      After deployment, call update() on each pair to seed initial observations.
///      POLAccumulator can then query consult() for safe slippage bounds.
contract DeployTWAPScript is Script {
    function run() external {
        // FRESH-EYES M-13: keystore migration completion. Forge selects sender from --account/--private-key/--ledger CLI flags; reading PRIVATE_KEY from env defeats the keystore path.
        console.log("=== Deploying TegridyTWAP Oracle ===");
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast();
        console.log("Deployer:", msg.sender);

        // AUDIT R062: per-chain Chainlink L2 Sequencer Uptime feed via
        //             SEQUENCER_FEED env; address(0) on mainnet / non-L2
        //             (no-op). See lib/SequencerCheck.sol for canonical
        //             Arbitrum / OP / Base feed addresses.
        // AUDIT R014: TegridyTWAP now requires a TegridyFactory address whose
        //             isPair() vouches for any pair passed to update(). Set
        //             FACTORY env to the deployed TegridyFactory.
        address FACTORY = vm.envAddress("FACTORY");
        require(FACTORY != address(0), "FACTORY must be set");
        address SEQUENCER_FEED = vm.envOr("SEQUENCER_FEED", address(0));
        TegridyTWAP twap = new TegridyTWAP(FACTORY, SEQUENCER_FEED);
        console.log("1. TegridyTWAP deployed:", address(twap));
        console.log("   bound to TegridyFactory:", FACTORY);

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("TegridyTWAP:", address(twap));
        console.log("");
        console.log("=== NEXT STEPS ===");
        console.log("1. Call twap.update(pairAddress) on each active TegridyPair");
        console.log("2. Wait MIN_PERIOD (5 min), then call update() again to seed 2nd observation");
        console.log("3. After 2+ observations, consult() is available for TWAP queries");
        console.log("4. Integrate with POLAccumulator: use consult() to compute slippage bounds");
        console.log("5. Set up a keeper/bot to call update() every 5-30 minutes");
    }
}
