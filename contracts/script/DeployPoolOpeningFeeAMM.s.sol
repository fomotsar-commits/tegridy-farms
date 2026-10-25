// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyFactory} from "../src/TegridyFactory.sol";
import {TegridyRouter} from "../src/TegridyRouter.sol";

/// @title  DeployPoolOpeningFeeAMM — a new coin-pool factory + router that charge 0.006 ETH to open a pool
/// @notice Owner ruling 2026-10-25. The live factory 0xa24C7287eC56A7DEFDc70033803451240e267a52 is
///         immutable and opens pools for free, and the live router 0xE9F83A07b071748E795d2489651d5310fA098Db8
///         is bound to it, so the fee ships as a new pair of contracts. The old ones keep working:
///         the one existing pool stays there, and anyone calling the old factory directly still
///         opens for free. Runbook: docs/POOL_OPENING_FEE_EVM.md.
/// @dev    Env: FEE_TO_SETTER (admin, a Safe), GUARDIAN (instant pair-disable, a Safe),
///         TREASURY (feeTo: gets the opening fee and the pairs' protocol share), WETH.
///         The constructor sets every role directly, so there is no handover step.
contract DeployPoolOpeningFeeAMMScript is Script {
    uint256 public constant EXPECTED_OPENING_FEE = 0.006 ether;

    struct Config {
        address feeToSetter;
        address guardian;
        address treasury;
        address weth;
    }

    function run() external returns (TegridyFactory factory, TegridyRouter router) {
        Config memory cfg = Config({
            feeToSetter: vm.envAddress("FEE_TO_SETTER"),
            guardian: vm.envAddress("GUARDIAN"),
            treasury: vm.envAddress("TREASURY"),
            weth: vm.envAddress("WETH")
        });
        _validate(cfg);

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        factory = new TegridyFactory(cfg.feeToSetter, cfg.treasury, cfg.guardian);
        router = new TegridyRouter(address(factory), cfg.weth);
        vm.stopBroadcast();

        _assertDeployInvariants(cfg, factory, router);
        console2.log("TegridyFactory deployed:", address(factory));
        console2.log("TegridyRouter deployed:", address(router));
        console2.log("Opening fee (wei):", factory.POOL_OPENING_FEE());
        console2.log("");
        console2.log("=== NEXT (operator): docs/POOL_OPENING_FEE_EVM.md, step 3 ===");
    }

    /// @notice Test entrypoint: same validation and read-backs, no env or broadcast.
    function runForTest(Config memory cfg) external returns (TegridyFactory factory, TegridyRouter router) {
        _validate(cfg);
        factory = new TegridyFactory(cfg.feeToSetter, cfg.treasury, cfg.guardian);
        router = new TegridyRouter(address(factory), cfg.weth);
        _assertDeployInvariants(cfg, factory, router);
    }

    function _validate(Config memory cfg) internal view {
        require(cfg.feeToSetter != address(0) && cfg.guardian != address(0), "set FEE_TO_SETTER and GUARDIAN");
        require(cfg.treasury != address(0) && cfg.weth != address(0), "zero env");
        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        // The live factory has the hot deployer EOA in both roles (SAFE_REHOME_RUNBOOK.md).
        // This one starts on Safes: a plain EOA (no code) or a 7702-delegated one (23 bytes) is refused.
        uint256 setterCode = cfg.feeToSetter.code.length;
        uint256 guardianCode = cfg.guardian.code.length;
        require(setterCode > 0 && setterCode != 23, "FEE_TO_SETTER must be a contract (Safe)");
        require(guardianCode > 0 && guardianCode != 23, "GUARDIAN must be a contract (Safe)");
    }

    function _assertDeployInvariants(Config memory cfg, TegridyFactory factory, TegridyRouter router)
        internal
        view
    {
        require(factory.POOL_OPENING_FEE() == EXPECTED_OPENING_FEE, "opening fee != 0.006 ETH");
        require(factory.feeTo() == cfg.treasury, "feeTo != TREASURY");
        require(factory.feeToSetter() == cfg.feeToSetter, "feeToSetter != FEE_TO_SETTER");
        require(factory.guardian() == cfg.guardian, "guardian != GUARDIAN");
        require(factory.allPairsLength() == 0, "fresh factory has pairs");
        require(router.factory() == address(factory), "router not bound to the new factory");
        require(router.WETH() == cfg.weth, "router WETH != WETH");
    }
}
