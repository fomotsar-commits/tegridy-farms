// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {MemeBountyBoard} from "../src/MemeBountyBoard.sol";

/// @title  DeployMemeBountyBoard — per-wave deploy for the restored bounty board
/// @notice Escrowed meme-bounty board with staking-weighted voting + WETH-fallback
///         refunds. Hands ownership to the multisig (OwnableNoRenounce 2-step).
/// @dev    Env: TOWELI (vote token), STAKING (vote power source), WETH, TREASURY,
///         SEQUENCER_FEED (optional — address(0) on mainnet), MULTISIG.
contract DeployMemeBountyBoardScript is Script {
    function run() external {
        address voteToken = vm.envAddress("TOWELI");
        address staking = vm.envAddress("STAKING");
        address weth = vm.envAddress("WETH");
        address treasury = vm.envAddress("TREASURY");
        address sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0)); // L2 sequencer uptime feed; address(0) on mainnet
        address multisig = vm.envAddress("MULTISIG");
        require(voteToken != address(0) && staking != address(0) && weth != address(0) && treasury != address(0), "zero env");
        require(multisig != address(0), "set MULTISIG");
        // 2026-07-15 pre-deploy hardening: mainnet guard + Safe-owner + mainnet-feed-zero. The
        // sequencerFeed is L2-only and baked immutable; on mainnet it MUST be address(0).
        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(sequencerFeed == address(0), "mainnet: SEQUENCER_FEED must be address(0)");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        MemeBountyBoard board = new MemeBountyBoard(voteToken, staking, weth, sequencerFeed, treasury);
        console2.log("MemeBountyBoard deployed:", address(board));
        board.transferOwnership(multisig); // 2-step; multisig must acceptOwnership()
        console2.log("Ownership transfer initiated to multisig:", multisig);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership()");
        console2.log("2. Set MEME_BOUNTY_BOARD_ADDRESS in frontend/src/lib/constants.ts ->", address(board));
    }
}
