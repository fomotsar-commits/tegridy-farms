// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyNFTPoolFactory} from "../src/TegridyNFTPoolFactory.sol";

/// @title  DeployNFTPoolFactory — per-wave deploy for the restored Sudoswap-style NFT AMM
/// @notice Clone-factory (EIP-1167) for per-collection bonding-curve pools. The constructor
///         deploys the pool template and stores it as the immutable poolImplementation, so a
///         template fix ships only as a new factory (runbook: docs/NFT_POOL_FACTORY_REDEPLOY.md).
///         The owner is set DIRECTLY to the multisig in the constructor; no handover step.
/// @dev    Env: MULTISIG (becomes owner), PROTOCOL_FEE_BPS (default 25: 0.25%, half the live 0.5%),
///         TREASURY (protocol fee recipient), WETH.
contract DeployNFTPoolFactoryScript is Script {
    uint256 public constant DEFAULT_PROTOCOL_FEE_BPS = 25;

    struct Config {
        address multisig;
        uint256 protocolFeeBps;
        address treasury;
        address weth;
    }

    function run() external returns (TegridyNFTPoolFactory factory) {
        Config memory cfg = Config({
            multisig: vm.envAddress("MULTISIG"),
            protocolFeeBps: vm.envOr("PROTOCOL_FEE_BPS", DEFAULT_PROTOCOL_FEE_BPS),
            treasury: vm.envAddress("TREASURY"),
            weth: vm.envAddress("WETH")
        });
        _validate(cfg);

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        factory = new TegridyNFTPoolFactory(cfg.multisig, cfg.protocolFeeBps, cfg.treasury, cfg.weth);
        vm.stopBroadcast();

        _assertDeployInvariants(cfg, factory);
        console2.log("TegridyNFTPoolFactory deployed (owner=multisig):", address(factory));
        console2.log("Pool template (poolImplementation):", factory.poolImplementation());
        console2.log("Protocol fee (bps):", cfg.protocolFeeBps);
        console2.log("");
        console2.log("=== NEXT (operator): docs/NFT_POOL_FACTORY_REDEPLOY.md, step 3 ===");
    }

    /// @notice Test entrypoint: same validation and read-backs, no env or broadcast.
    function runForTest(Config memory cfg) external returns (TegridyNFTPoolFactory factory) {
        _validate(cfg);
        factory = new TegridyNFTPoolFactory(cfg.multisig, cfg.protocolFeeBps, cfg.treasury, cfg.weth);
        _assertDeployInvariants(cfg, factory);
    }

    function _validate(Config memory cfg) internal view {
        require(cfg.multisig != address(0), "set MULTISIG");
        require(cfg.treasury != address(0) && cfg.weth != address(0), "zero env");
        // Owner is set in the ctor with no 2-step recovery, so it must be a contract (a Safe).
        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(cfg.multisig.code.length > 0, "MULTISIG must be a contract (Safe)");
    }

    function _assertDeployInvariants(Config memory cfg, TegridyNFTPoolFactory factory) internal view {
        require(factory.owner() == cfg.multisig, "owner != MULTISIG");
        require(factory.protocolFeeBps() == cfg.protocolFeeBps, "fee != PROTOCOL_FEE_BPS");
        require(factory.protocolFeeRecipient() == cfg.treasury, "fee recipient != TREASURY");
        require(factory.weth() == cfg.weth, "weth != WETH");
        require(factory.poolImplementation().code.length > 0, "no pool template");
        require(factory.getPoolCount() == 0, "fresh factory has pools");
    }
}
