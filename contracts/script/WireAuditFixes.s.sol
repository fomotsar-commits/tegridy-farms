// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

/// @notice Minimal interfaces for the wiring-only calls so this script doesn't
///         pull in every upstream contract.
interface ITegridyFactory {
    function setGuardian(address) external;
    function guardian() external view returns (address);
    function feeToSetter() external view returns (address);
}

interface ITegridyStaking {
    function setRewardNotifier(address, bool) external;
    function rewardNotifiers(address) external view returns (bool);
    function owner() external view returns (address);
}

/// @title WireAuditFixes — Post-redeploy wiring for the full-force audit batch
/// @notice Runs the small set of `setX` calls the audit introduced so the new
///         roles are populated and the new allowlists are active. Run this once
///         immediately after the Wave 1 redeploy, before ownership transfers
///         to the multisig.
///
/// Audit references (see .audit_full_force.md):
///   - NEW-A2: TegridyFactory guardian role for instant emergency pair-disable.
///             Guardian is settable by `feeToSetter`. Until a separate guardian
///             multisig exists, we point it at the deployer / ops EOA.
///   - NEW-S5: TegridyStaking.notifyRewardAmount is no longer permissionless —
///             the contract owner plus an allowlisted set of `rewardNotifiers`
///             are the only funders. Treasury, POLAccumulator, and
///             SwapFeeRouter routinely push rewards, so we allowlist each.
///
/// Usage:
///   forge script script/WireAuditFixes.s.sol:WireAuditFixesScript \
///     --rpc-url "$ETH_RPC_URL" --broadcast --verify
///
/// Env vars (all required unless defaulted):
///   PRIVATE_KEY               (deployer key that currently owns the contracts)
///   FACTORY                   (new TegridyFactory address post-redeploy)
///   STAKING                   (new TegridyStaking address post-redeploy)
///   GUARDIAN                  (address to hold NEW-A2 guardian role)
///   TREASURY                  (optional notifier — if set, allowlisted)
///   POL_ACCUMULATOR           (optional notifier — if set, allowlisted)
///   SWAP_FEE_ROUTER           (optional notifier — if set, allowlisted)
contract WireAuditFixesScript is Script {
    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        address factory = vm.envAddress("FACTORY");
        address staking = vm.envAddress("STAKING");
        address guardian = vm.envAddress("GUARDIAN");

        // Optional notifiers — use `vm.envOr` so omission is not a hard error.
        // Address(0) is treated as "skip this notifier" below.
        address treasury = vm.envOr("TREASURY", address(0));
        address polAccumulator = vm.envOr("POL_ACCUMULATOR", address(0));
        address swapFeeRouter = vm.envOr("SWAP_FEE_ROUTER", address(0));

        // Sanity: caller must actually be the current controller for both.
        address deployer = vm.addr(deployerPrivateKey);
        require(
            ITegridyFactory(factory).feeToSetter() == deployer,
            "DEPLOYER_IS_NOT_FEE_TO_SETTER"
        );
        require(
            ITegridyStaking(staking).owner() == deployer,
            "DEPLOYER_IS_NOT_STAKING_OWNER"
        );

        console.log("=== Wire audit-fix roles ===");
        console.log("Factory:       %s", factory);
        console.log("Staking:       %s", staking);
        console.log("Guardian:      %s", guardian);
        console.log("Treasury:      %s", treasury);
        console.log("POLAccum:      %s", polAccumulator);
        console.log("SwapFeeRouter: %s", swapFeeRouter);

        vm.startBroadcast(deployerPrivateKey);

        // 1. NEW-A2: set factory guardian for emergency pair-disable.
        require(guardian != address(0), "GUARDIAN_ZERO");
        ITegridyFactory(factory).setGuardian(guardian);
        console.log("[1/4] Factory guardian set -> %s", guardian);

        // 2-4. NEW-S5: allowlist reward notifiers on Staking. Any of the three
        //      optional addresses can be skipped by leaving the env var unset.
        if (treasury != address(0)) {
            ITegridyStaking(staking).setRewardNotifier(treasury, true);
            console.log("[2/4] Notifier allowlisted: treasury");
        } else {
            console.log("[2/4] SKIPPED treasury notifier (env unset)");
        }

        if (polAccumulator != address(0)) {
            ITegridyStaking(staking).setRewardNotifier(polAccumulator, true);
            console.log("[3/4] Notifier allowlisted: polAccumulator");
        } else {
            console.log("[3/4] SKIPPED polAccumulator notifier (env unset)");
        }

        if (swapFeeRouter != address(0)) {
            ITegridyStaking(staking).setRewardNotifier(swapFeeRouter, true);
            console.log("[4/4] Notifier allowlisted: swapFeeRouter");
        } else {
            console.log("[4/4] SKIPPED swapFeeRouter notifier (env unset)");
        }

        vm.stopBroadcast();

        // Post-broadcast sanity checks (non-broadcasting staticcalls).
        require(
            ITegridyFactory(factory).guardian() == guardian,
            "GUARDIAN_NOT_SET"
        );
        if (treasury != address(0)) {
            require(
                ITegridyStaking(staking).rewardNotifiers(treasury),
                "TREASURY_NOTIFIER_NOT_SET"
            );
        }
        if (polAccumulator != address(0)) {
            require(
                ITegridyStaking(staking).rewardNotifiers(polAccumulator),
                "POL_NOTIFIER_NOT_SET"
            );
        }
        if (swapFeeRouter != address(0)) {
            require(
                ITegridyStaking(staking).rewardNotifiers(swapFeeRouter),
                "SWAP_ROUTER_NOTIFIER_NOT_SET"
            );
        }

        console.log("");
        console.log("=== Wiring complete, all post-conditions verified ===");
        console.log("Next: transfer ownership of Factory + Staking to multisig");
        console.log("      (the multisig inherits guardian+owner powers).");
    }
}
