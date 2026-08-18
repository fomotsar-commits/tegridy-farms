// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {VestingFactory} from "../src/VestingFactory.sol";

/// @title  DeployVestingFactory — build plan item #28, the team-vesting half of the rails
/// @notice Deploys `VestingFactory`, which stamps OpenZeppelin `VestingWalletCliff`
///         instances (v5.6.1 from the pinned submodule — no fork, no vendored copy, no
///         BUSL exposure) and emits the registry events the indexer's `vesting_stream`
///         table reads.
///
///         Ships with the creation fee at ZERO and the fee sink at `address(0)`. This
///         script arms neither. Fee enablement is two 48h-timelocked ceremonies in the
///         order printed at the end.
///
/// @dev    Env: MULTISIG (owner, must be a Safe), PAUSE_GUARDIAN (optional),
///         SEQUENCER_FEED (optional, must be `address(0)` on mainnet).
///
/// @dev    Pair this with `DeployLockVault.s.sol` and then `DeployLaunchLockView.s.sol`,
///         in that order — the view takes both addresses as immutable constructor args
///         and cannot be repointed afterwards.
contract DeployVestingFactoryScript is Script {
    function run() external {
        address multisig = vm.envAddress("MULTISIG");
        address pauseGuardian = vm.envOr("PAUSE_GUARDIAN", address(0));
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

        VestingFactory factory = new VestingFactory(msg.sender);
        console2.log("VestingFactory deployed:", address(factory));

        if (pauseGuardian != address(0)) {
            factory.setPauseGuardian(pauseGuardian);
            console2.log("Pause guardian set:", pauseGuardian);
        }

        factory.transferOwnership(multisig); // 2-step; multisig must acceptOwnership()
        console2.log("Ownership transfer initiated to multisig:", multisig);
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== INVARIANTS AT DEPLOY (verify on the explorer before announcing) ===");
        console2.log("createFeeWei (must be 0):", factory.createFeeWei());
        console2.log("feeSink (must be 0x0):", factory.feeSink());
        console2.log("MAX_CREATE_FEE_WEI (immutable cap):", factory.MAX_CREATE_FEE_WEI());
        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. MULTISIG.acceptOwnership()");
        if (pauseGuardian == address(0)) {
            console2.log("2. MULTISIG.setPauseGuardian(<hot 3-of-5, disjoint signers>)");
        }
        console2.log("3. Set VESTING_FACTORY_ADDRESS in frontend/src/lib/constants.ts ->", address(factory));
        console2.log("4. Deploy TegridyLockVault, then LaunchLockView with BOTH addresses.");
        console2.log("");
        console2.log("=== FEE ENABLEMENT (do NOT run as part of this deploy) ===");
        console2.log("  a. proposeFeeSink(<SwapFeeRouter leg>) ; wait 48h ; executeFeeSink(<same>)");
        console2.log("  b. proposeCreateFee(<wei, <= cap>)     ; wait 48h ; executeCreateFee(<same>)");
        console2.log("NOTE: the implemented fee is a FLAT per-stream ETH amount, not the");
        console2.log("      0.25%-of-streamed-value leg in the build note. Percent-of-value");
        console2.log("      needs a price for an arbitrary new ERC-20; this rail carries no");
        console2.log("      oracle by design. That conversion is an unresolved product call.");
    }
}
