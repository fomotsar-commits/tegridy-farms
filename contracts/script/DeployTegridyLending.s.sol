// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyLending} from "../src/TegridyLending.sol";
import {TegridyLendingAdmin} from "../src/TegridyLendingAdmin.sol";

/// @title  DeployTegridyLending — per-wave deploy for the restored token P2P lending (+ Admin)
/// @notice Gondi-style P2P loans against TegridyStaking positions as collateral. No oracle
///         (reads the staking `positions` mapping for collateral value), ETH-floor guard via
///         the pair+TWAP, WETH-fallback payouts. Deploys TegridyLending + its EIP-170 Admin
///         split, wires them (one-time setLendingAdmin while the deployer still owns), then
///         hands BOTH to the multisig (2-step). PROTOCOL_FEE_BPS is policy — REVIEW.
/// @dev    Env: TREASURY, PROTOCOL_FEE_BPS (default 500 = 5% last-known), WETH,
///         PAIR (TOWELI/WETH TegridyPair, for the ETH-floor), TWAP (TegridyTWAP oracle),
///         SEQUENCER_FEED (optional — address(0) on mainnet), MULTISIG.
contract DeployTegridyLendingScript is Script {
    function run() external {
        address treasury = vm.envAddress("TREASURY");
        uint256 protocolFeeBps = vm.envOr("PROTOCOL_FEE_BPS", uint256(500)); // REVIEW — 5% last-known live value
        address weth = vm.envAddress("WETH");
        address pair = vm.envAddress("PAIR");
        address twap = vm.envAddress("TWAP");
        address sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0)); // L2 sequencer uptime feed; address(0) on mainnet
        address multisig = vm.envAddress("MULTISIG");
        require(treasury != address(0) && weth != address(0) && pair != address(0) && twap != address(0), "zero env");
        require(multisig != address(0), "set MULTISIG");

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        console2.log("Protocol fee (bps):", protocolFeeBps);

        TegridyLending lending = new TegridyLending(treasury, protocolFeeBps, weth, pair, twap, sequencerFeed);
        console2.log("TegridyLending deployed:", address(lending));

        TegridyLendingAdmin admin = new TegridyLendingAdmin(address(lending));
        console2.log("TegridyLendingAdmin deployed:", address(admin));

        lending.setLendingAdmin(address(admin)); // onlyOwner, one-time — wire BEFORE handing off ownership
        console2.log("Wired lending.setLendingAdmin ->", address(admin));

        lending.transferOwnership(multisig);
        admin.transferOwnership(multisig);
        console2.log("Ownership of both transferred to multisig (2-step):", multisig);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership() on BOTH TegridyLending and TegridyLendingAdmin");
        console2.log("2. Set TEGRIDY_LENDING_ADDRESS in frontend/src/lib/constants.ts ->", address(lending));
    }
}
