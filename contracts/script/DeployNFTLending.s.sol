// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyNFTLending} from "../src/TegridyNFTLending.sol";

/// @title  DeployNFTLending — per-wave deploy for the restored NFT P2P lending
/// @notice Gondi-style P2P loans against generic NFTs (JBAC/Nakamigos/GNSS). No oracle,
///         fixed-term, WETH-fallback payouts. Hands ownership to the multisig (2-step).
///         PROTOCOL_FEE_BPS is deploy-time policy — REVIEW.
/// @dev    Env: TREASURY, PROTOCOL_FEE_BPS (default 500 = 5% last-known), WETH,
///         SEQUENCER_FEED (optional — address(0) on mainnet), MULTISIG.
contract DeployNFTLendingScript is Script {
    function run() external {
        address treasury = vm.envAddress("TREASURY");
        uint256 protocolFeeBps = vm.envOr("PROTOCOL_FEE_BPS", uint256(500)); // REVIEW — 5% last-known live value
        address weth = vm.envAddress("WETH");
        address sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0)); // L2 sequencer uptime feed; address(0) on mainnet
        address multisig = vm.envAddress("MULTISIG");
        require(treasury != address(0) && weth != address(0), "zero env");
        require(multisig != address(0), "set MULTISIG");

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        console2.log("Protocol fee (bps):", protocolFeeBps);
        TegridyNFTLending lending = new TegridyNFTLending(treasury, protocolFeeBps, weth, sequencerFeed);
        console2.log("TegridyNFTLending deployed:", address(lending));
        lending.transferOwnership(multisig); // 2-step; multisig must acceptOwnership()
        console2.log("Ownership transfer initiated to multisig:", multisig);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership()");
        console2.log("2. Set TEGRIDY_NFT_LENDING_ADDRESS in frontend/src/lib/constants.ts ->", address(lending));
    }
}
