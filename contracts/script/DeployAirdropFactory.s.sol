// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {AirdropFactory} from "../src/AirdropFactory.sol";

/// @title  DeployAirdropFactory — build plan item #65, self-serve Merkle airdrop rail
/// @notice Deploys `AirdropFactory` and hands ownership to the multisig (2-step). The
///         factory ships with the per-claim fee at ZERO and the fee sink at
///         `address(0)`; this script deliberately does not arm either. Enabling the fee
///         is two separate 48h-timelocked ceremonies, in the order printed at the end,
///         and is an operator decision about revenue that a deploy script must not make.
///
/// @dev    Env: MULTISIG (owner, must be a Safe), PAUSE_GUARDIAN (optional — the
///         pause-only hot multisig; set later via `setPauseGuardian` if unset here),
///         SEQUENCER_FEED (optional, must be `address(0)` on mainnet).
///
/// @dev    Fleet-standard guards, matching DeployCommunityGrants / DeployLockerClaimer:
///         `block.chainid == 1`, and a code-length check on the owner so ownership
///         cannot be handed to an EOA by a fat-fingered env var. The guardian check is
///         disjointness from the owner — a guardian that shares the owner's signer set is
///         a second key to the same door, which defeats the whole reason the role exists
///         (see `src/base/PauseGuardian.sol`).
///
/// @dev    LICENSE: this rail inherits Uniswap's `merkle-distributor`, which is
///         GPL-3.0-or-later, not MIT. See
///         `src/vendor/uniswap-merkle-distributor/VENDOR.md`. Resolve that before deploy.
contract DeployAirdropFactoryScript is Script {
    function run() external {
        address multisig = vm.envAddress("MULTISIG");
        address pauseGuardian = vm.envOr("PAUSE_GUARDIAN", address(0));
        // This rail consumes no oracle and has no staleness window, so the assertion
        // exists purely to catch an L2-shaped env being run against mainnet. Kept
        // identical to the siblings on purpose: a guard present on four scripts and
        // absent on the fifth is the one that gets forgotten.
        address sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0));

        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(multisig != address(0), "set MULTISIG");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");
        require(sequencerFeed == address(0), "mainnet: SEQUENCER_FEED must be address(0)");
        if (pauseGuardian != address(0)) {
            require(pauseGuardian != multisig, "PAUSE_GUARDIAN must be disjoint from MULTISIG");
        }

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);

        // Deployer is the initial owner so the guardian can be wired in this same
        // broadcast; ownership is then 2-step-handed to the Safe below. The deployer key
        // holds nothing of value in the interim — the factory has no custody at rest and
        // no campaign exists yet.
        AirdropFactory factory = new AirdropFactory(msg.sender);
        console2.log("AirdropFactory deployed:", address(factory));

        if (pauseGuardian != address(0)) {
            factory.setPauseGuardian(pauseGuardian);
            console2.log("Pause guardian set:", pauseGuardian);
        }

        factory.transferOwnership(multisig); // 2-step; multisig must acceptOwnership()
        console2.log("Ownership transfer initiated to multisig:", multisig);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== INVARIANTS AT DEPLOY (verify on the explorer before announcing) ===");
        console2.log("claimFeeWei (must be 0):", factory.claimFeeWei());
        console2.log("feeSink (must be 0x0):", factory.feeSink());
        console2.log("MAX_CLAIM_FEE_WEI (immutable cap):", factory.MAX_CLAIM_FEE_WEI());
        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership()");
        if (pauseGuardian == address(0)) {
            console2.log("2. MULTISIG.setPauseGuardian(<hot 3-of-5, disjoint signers>)");
        }
        console2.log("3. Set AIRDROP_FACTORY_ADDRESS in frontend/src/lib/constants.ts ->", address(factory));
        console2.log("");
        console2.log("=== FEE ENABLEMENT (do NOT run as part of this deploy) ===");
        console2.log("Order matters; the contract enforces it. Sink first, fee second:");
        console2.log("  a. proposeFeeSink(<RevenueDistributor>) ; wait 48h ; executeFeeSink(<same>)");
        console2.log("  b. proposeClaimFee(<wei, <= cap>)        ; wait 48h ; executeClaimFee(<same>)");
        console2.log("Campaigns snapshot the fee at creation, so existing campaigns never re-price.");
        console2.log("The sink must have a payable receive() that survives a 2300-gas-free .call.");
    }
}
