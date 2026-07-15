// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyNFTLending} from "../src/TegridyNFTLending.sol";
import {TegridyNFTLendingAdmin} from "../src/TegridyNFTLendingAdmin.sol";

/// @title  DeployNFTLending — per-wave deploy for the restored NFT P2P lending
/// @notice Gondi-style P2P loans against generic NFTs (JBAC/Nakamigos/GNSS). No oracle,
///         fixed-term, WETH-fallback payouts. Hands ownership to the multisig (2-step).
///         PROTOCOL_FEE_BPS is deploy-time policy — REVIEW.
/// @dev    Env: TREASURY, PROTOCOL_FEE_BPS (default 500 = 5% last-known), WETH,
///         SEQUENCER_FEED (optional — address(0) on mainnet), MULTISIG.
/// @dev    AUDIT FIX EIP170-01: TegridyNFTLending was split into a sister
///         TegridyNFTLendingAdmin (timelocked governance) to fit under EIP-170.
///         This script now deploys BOTH and wires them. CRITICAL ORDER:
///         `setNftLendingAdmin` is `onlyOwner` + one-shot, so it MUST run while the
///         deployer still owns the lending contract — i.e. BEFORE `transferOwnership`.
///         Both contracts' ownership is then handed to the multisig (2-step each).
contract DeployNFTLendingScript is Script {
    function run() external {
        address treasury = vm.envAddress("TREASURY");
        uint256 protocolFeeBps = vm.envOr("PROTOCOL_FEE_BPS", uint256(500)); // REVIEW — 5% last-known live value
        address weth = vm.envAddress("WETH");
        address sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0)); // L2 sequencer uptime feed; address(0) on mainnet
        address multisig = vm.envAddress("MULTISIG");
        require(treasury != address(0) && weth != address(0), "zero env");
        require(multisig != address(0), "set MULTISIG");
        // 2026-07-15 pre-deploy hardening (NEEDS-FIX in the deploy-script audit): mainnet guard
        // + Safe-owner + mainnet-feed-zero. sequencerFeed is L2-only, baked immutable via the
        // ctor one-shot; on mainnet it MUST be address(0).
        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(sequencerFeed == address(0), "mainnet: SEQUENCER_FEED must be address(0)");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        console2.log("Protocol fee (bps):", protocolFeeBps);

        // 1. Deploy the core lending contract.
        TegridyNFTLending lending = new TegridyNFTLending(treasury, protocolFeeBps, weth, sequencerFeed);
        console2.log("TegridyNFTLending deployed:", address(lending));

        // 2. Deploy the timelock-admin sister, bound to the lending contract.
        TegridyNFTLendingAdmin admin = new TegridyNFTLendingAdmin(address(lending));
        console2.log("TegridyNFTLendingAdmin deployed:", address(admin));

        // 3. Wire the admin into the lending contract. MUST happen before the
        //    ownership transfer below — setNftLendingAdmin is onlyOwner + one-shot.
        lending.setNftLendingAdmin(address(admin));
        console2.log("Admin wired into lending via setNftLendingAdmin");

        // 4. Hand both contracts to the multisig (2-step; multisig must acceptOwnership() on each).
        lending.transferOwnership(multisig);
        console2.log("Lending ownership transfer initiated to multisig:", multisig);
        admin.transferOwnership(multisig);
        console2.log("Admin ownership transfer initiated to multisig:", multisig);

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership() on TegridyNFTLending ->", address(lending));
        console2.log("2. MULTISIG.acceptOwnership() on TegridyNFTLendingAdmin ->", address(admin));
        console2.log("3. Set TEGRIDY_NFT_LENDING_ADDRESS in frontend/src/lib/constants.ts ->", address(lending));
        console2.log("   (governance entrypoints - fee/treasury/whitelist/originationFee/minApr/sweep - live on the admin)");
    }
}
