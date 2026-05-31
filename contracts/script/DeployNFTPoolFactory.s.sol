// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyNFTPoolFactory} from "../src/TegridyNFTPoolFactory.sol";

/// @title  DeployNFTPoolFactory — per-wave deploy for the restored Sudoswap-style NFT AMM
/// @notice Clone-factory (EIP-1167) for per-collection bonding-curve pools. The owner is
///         set DIRECTLY to the multisig in the constructor (OwnableNoRenounce(_owner)), so
///         no separate handover is needed. Individual pools are user-deployed clones via
///         factory.createPool(...). PROTOCOL_FEE_BPS is deploy-time policy — REVIEW.
/// @dev    Env: MULTISIG (becomes owner), PROTOCOL_FEE_BPS (default 50 = 0.5% last-known),
///         TREASURY (protocol fee recipient), WETH.
contract DeployNFTPoolFactoryScript is Script {
    function run() external {
        address multisig = vm.envAddress("MULTISIG");
        uint256 protocolFeeBps = vm.envOr("PROTOCOL_FEE_BPS", uint256(50)); // REVIEW — 0.5% last-known live value
        address treasury = vm.envAddress("TREASURY");
        address weth = vm.envAddress("WETH");
        require(multisig != address(0), "set MULTISIG");
        require(treasury != address(0) && weth != address(0), "zero env");

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        console2.log("Protocol fee (bps):", protocolFeeBps);
        // owner = multisig directly (constructor arg) — no transferOwnership needed.
        TegridyNFTPoolFactory factory = new TegridyNFTPoolFactory(multisig, protocolFeeBps, treasury, weth);
        console2.log("TegridyNFTPoolFactory deployed (owner=multisig):", address(factory));
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (operator) ===");
        console2.log("1. Set TEGRIDY_NFT_POOL_FACTORY_ADDRESS in frontend/src/lib/constants.ts ->", address(factory));
        console2.log("   (pools are user-created clones via createPool -- no per-pool deploy script)");
    }
}
