// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyFeeExecutorRouter} from "../src/TegridyFeeExecutorRouter.sol";

/// @title DeployFeeExecutorRouter — deploy the LlamaSwap-routed fee-skimming executor
/// @notice Phase 2 of docs/SWAP_REVENUE_ARCHITECTURE.md. Ships behind the per-feature audit
///         gate + the frontend `isDeployed` gate. Wires the immutable RevenueDistributor /
///         treasury sinks and seeds the GENESIS aggregator allowlist (post-deploy additions are
///         48h-timelocked, so the curated initial set is passed to the constructor).
///
/// @dev    OPERATOR — the allowlist is supplied via env so addresses are reviewed at deploy time,
///         NOT hardcoded here (a wrong/stale aggregator router in a security allowlist is
///         dangerous). Set, comma-delimited and individually VERIFIED against each aggregator's
///         official docs immediately before broadcast:
///           AGG_TARGETS  — execution targets (LlamaSwap `tx.to`): the underlying aggregator
///                          routers LlamaSwap routes through. Recommended set to verify:
///                          1inch AggregationRouter V6, 0x Settler, ParaSwap/Velora Augustus,
///                          KyberSwap MetaAggregationRouter V2, Odos Router V2.
///           AGG_SPENDERS — approval spenders (LlamaSwap `tokenApprovalAddress`): often DIFFER
///                          from the target (Permit2, ParaSwap TokenTransferProxy, 0x
///                          AllowanceHolder). Verify each against the aggregator's docs.
///         EXCLUDE CoW / intent-settlement aggregators (they don't pull from an approval).
contract DeployFeeExecutorRouterScript is Script {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    // RELAUNCH 2026-06-06 sinks (frontend/src/lib/constants.ts).
    address constant REVENUE_DISTRIBUTOR = 0xF993316E2fC079de4358c489A935E01e03E23E17;
    address constant TREASURY = 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d;
    uint256 constant FEE_BPS = 25; // 0.25%, disclosed; bounded by MAX_FEE_BPS (1%).

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        address[] memory targets = vm.envOr("AGG_TARGETS", ",", new address[](0));
        address[] memory spenders = vm.envOr("AGG_SPENDERS", ",", new address[](0));
        require(targets.length > 0, "Set AGG_TARGETS (verified aggregator routers)");
        require(spenders.length > 0, "Set AGG_SPENDERS (verified approval spenders)");

        address multisig = vm.envAddress("MULTISIG");
        require(multisig != address(0), "Set MULTISIG");

        console.log("=== Deploying TegridyFeeExecutorRouter ===");
        console.log("WETH:               ", WETH);
        console.log("RevenueDistributor: ", REVENUE_DISTRIBUTOR);
        console.log("Treasury:           ", TREASURY);
        console.log("Fee bps:            ", FEE_BPS);
        console.log("Genesis targets:    ", targets.length);
        console.log("Genesis spenders:   ", spenders.length);

        vm.startBroadcast();
        console.log("Deployer:           ", msg.sender);

        TegridyFeeExecutorRouter router =
            new TegridyFeeExecutorRouter(WETH, REVENUE_DISTRIBUTOR, TREASURY, FEE_BPS, targets, spenders);
        console.log("1. TegridyFeeExecutorRouter:", address(router));

        // Initiate 2-step ownership transfer to the multisig (OwnableNoRenounce).
        router.transferOwnership(multisig);
        console.log("2. Ownership transfer initiated to:", multisig);

        vm.stopBroadcast();

        console.log("");
        console.log("=== NEXT STEPS ===");
        console.log("1. Multisig: acceptOwnership()");
        console.log("2. Multisig: setPauseGuardian(<hot guardian>)");
        console.log("3. (optional) proposeFeeSplit/executePolAccumulator to route a slice to POL");
        console.log("4. Set FEE_EXECUTOR_ROUTER_ADDRESS in frontend/src/lib/constants.ts");
        console.log("5. Verify each allowlisted target/spender on Etherscan before enabling in UI");
    }
}
