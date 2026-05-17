// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
// Named imports avoid file-level interface collisions on ITegridyStaking
// (declared inside TegridyRestaking.sol via the broader deploy scripts) and
// ITegridyTWAP (declared inside POLAccumulator.sol). Pulling only the
// contract symbols into scope keeps this script self-contained.
import {TegridyLending} from "../src/TegridyLending.sol";
import {TegridyLendingAdmin} from "../src/TegridyLendingAdmin.sol";

/// @title DeployLendingScript — standalone deploy for TegridyLending + Admin
/// @notice TegridyLending was missing from every prior deploy script for
///         months. DeployAuditFixes is at the Yul stack-too-deep ceiling so
///         lending could not be added there without a major refactor.
///         This standalone script closes the gap: deploy lending + admin,
///         wire setLendingAdmin (owner-only one-shot), transfer ownership to
///         multisig. Run AFTER DeployAuditFixes (which deploys the
///         TOWELI/WETH pair and the rest of the protocol).
///
/// **Required env vars:**
///   MULTISIG           - multisig that will accept ownership
///   TREASURY           - protocol-fee recipient (often == MULTISIG today)
///   LP_TOKEN           - TOWELI/WETH pair address (from DeployAuditFixes)
///   TWAP               - TegridyTWAP oracle (deployed separately)
///   SEQUENCER_FEED     - optional; Chainlink L2 Sequencer Uptime feed
///   WETH               - canonical WETH (mainnet: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2)
///
/// **Usage:**
///   forge script script/DeployLending.s.sol:DeployLendingScript \
///       --rpc-url $ETH_RPC_URL --account deployer --broadcast
///
/// **Next steps (operator):**
///   1. Multisig acceptOwnership() on lending + lendingAdmin within 14 days
///      (OwnableNoRenounce.OWNERSHIP_TRANSFER_EXPIRY).
///   2. Update Verify.s.sol's LENDING and LENDING_ADMIN constants with the
///      addresses from this deploy, then run Verify.s.sol to confirm
///      INV-8a/b/c/d pass.
///   3. Wire the indexer to subscribe to TegridyLending events
///      (LoanOfferCreated, LoanOfferCancelled, LoanAccepted, LoanRepaid,
///      DefaultClaimed, CollateralStuck, ...).
contract DeployLendingScript is Script {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 constant LENDING_FEE_BPS = 500; // 5% protocol fee on interest

    function run() external {
        require(
            block.chainid == 1,
            "MAINNET_ONLY: this script uses hardcoded mainnet WETH"
        );

        address treasury = vm.envAddress("TREASURY");
        require(treasury != address(0), "TREASURY env var required");

        address multisig = vm.envAddress("MULTISIG");
        require(multisig != address(0), "MULTISIG env var required");

        address lpToken = vm.envAddress("LP_TOKEN");
        require(lpToken != address(0), "LP_TOKEN env var required (TOWELI/WETH pair)");

        address twap = vm.envAddress("TWAP");
        require(twap != address(0), "TWAP env var required");

        address sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0));
        // Mainnet (chainid 1) has no sequencer concept; address(0) acceptable.
        // L2 deploys must supply the Chainlink L2 Sequencer Uptime feed.

        console.log("=== TEGRIDY LENDING DEPLOY ===");
        console.log("Treasury:      ", treasury);
        console.log("Multisig:      ", multisig);
        console.log("LP_TOKEN:      ", lpToken);
        console.log("TWAP:          ", twap);
        console.log("SEQUENCER_FEED:", sequencerFeed);

        vm.startBroadcast();
        console.log("Deployer:", msg.sender);

        // 1. TegridyLending
        TegridyLending lending = new TegridyLending(
            treasury,
            LENDING_FEE_BPS,
            WETH,
            lpToken,
            twap,
            sequencerFeed
        );
        console.log("1. TegridyLending:", address(lending));

        // 2. TegridyLendingAdmin + one-shot wire BEFORE transferOwnership.
        // `setLendingAdmin` is owner-only and one-shot; if it isn't called
        // here the multisig must do it post-handover. We do it now while
        // the deployer still owns lending.
        TegridyLendingAdmin lendingAdmin = new TegridyLendingAdmin(address(lending));
        lending.setLendingAdmin(address(lendingAdmin));
        console.log("2. TegridyLendingAdmin:", address(lendingAdmin));
        console.log("   -> lending.setLendingAdmin wired (one-shot complete)");

        // 3. transferOwnership to multisig. Multisig MUST accept within 14
        // days (OwnableNoRenounce.OWNERSHIP_TRANSFER_EXPIRY) or the deployer
        // EOA permanently retains ownership.
        lending.transferOwnership(multisig);
        lendingAdmin.transferOwnership(multisig);
        console.log("3. Ownership transfer initiated for lending + lendingAdmin to:", multisig);

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("TegridyLending:      ", address(lending));
        console.log("TegridyLendingAdmin: ", address(lendingAdmin));
        console.log("");
        console.log("NEXT STEPS:");
        console.log("  1. Multisig: acceptOwnership() on lending + lendingAdmin");
        console.log("     within 14 days or the transfer expires.");
        console.log("  2. Update Verify.s.sol LENDING + LENDING_ADMIN constants.");
        console.log("  3. Run Verify.s.sol to confirm INV-8a/b/c/d pass.");
        console.log("  4. Wire indexer to subscribe to TegridyLending events.");
    }
}
