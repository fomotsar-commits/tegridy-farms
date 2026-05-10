// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Toweli} from "../src/Toweli.sol";

/// @title DeployToweli — Reference deployer for the TOWELI ERC-20.
/// @notice The canonical mainnet token at 0x420698CF… was originally deployed via
///         CREATE2 salt-mining for the vanity prefix. This script is a plain
///         deployment reference for testnet forks, local anvil, and integration
///         tests. For mainnet vanity redeploys, see docs/TOKEN_DEPLOY.md.
///
/// @dev Env required:
///      PRIVATE_KEY   — deployer EOA
///      TOKEN_TREASURY — recipient for the full 1B supply at deploy time
contract DeployToweli is Script {
    function run() external returns (Toweli token) {
        // AUDIT FIX FRESH-2026 (post-fix scan8 SE-1): refuse mainnet broadcast.
        // This deployer produces a non-vanity TOWELI; mainnet must use the
        // CREATE2 vanity flow (docs/TOKEN_DEPLOY.md). Sibling-canonical to
        // every other deploy script's chain-id guard, just inverted.
        require(block.chainid != 1, "USE_VANITY_DEPLOY_FOR_MAINNET");
        // FRESH-EYES M-13: keystore migration completion. Forge selects sender from --account/--private-key/--ledger CLI flags; reading PRIVATE_KEY from env defeats the keystore path.
        address treasury = vm.envAddress("TOKEN_TREASURY");
        require(treasury != address(0), "TOKEN_TREASURY not set");

        vm.startBroadcast();
        token = new Toweli(treasury);
        vm.stopBroadcast();

        console2.log("Toweli deployed to:", address(token));
        console2.log("Full 1B supply sent to:", treasury);
        console2.log("Next steps:");
        console2.log("  1. Verify on Etherscan via `forge verify-contract`");
        console2.log("  2. Update frontend/src/lib/constants.ts TOWELI_ADDRESS");
        console2.log("  3. Distribute from treasury per TOKENOMICS.md allocation");
    }
}
