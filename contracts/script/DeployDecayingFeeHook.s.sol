// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {DecayingFeeHook} from "../src/v4/DecayingFeeHook.sol";

/// @title  DeployDecayingFeeHook — build plan item #27, anti-snipe decaying-tax mode
///
/// @notice Deploys the hook only. It arrives with no pool configured, which makes it
///         unusable rather than merely unused: initializing a pool against an
///         unconfigured hook reverts, so the hook cannot silently attach itself to a
///         launch. Schedules are published one pool at a time by the owner, before that
///         pool is initialized, and can never be edited afterwards.
///
/// @dev    A v4 hook's permissions are encoded in the low bits of its ADDRESS, so this
///         mines a CREATE2 salt for the `afterInitialize | beforeSwap` pair the vendored
///         `BaseOverrideFee` declares. Forge routes `new X{salt:...}` through the
///         deterministic CREATE2 factory during broadcast, so the miner must use that
///         same deployer or the mined address will not match what lands on chain.
///
/// @dev    Env: POOL_MANAGER, MULTISIG (owner, 2-step).
contract DeployDecayingFeeHookScript is Script {
    /// @dev Deterministic CREATE2 factory Forge uses for salted `new` during broadcast.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        address poolManager = vm.envAddress("POOL_MANAGER");
        address multisig = vm.envAddress("MULTISIG");
        require(poolManager != address(0), "set POOL_MANAGER");
        require(multisig != address(0), "set MULTISIG");
        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(poolManager.code.length > 0, "POOL_MANAGER has no code");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");

        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        bytes memory ctorArgs = abi.encode(IPoolManager(poolManager), multisig);
        (address expected, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(DecayingFeeHook).creationCode, ctorArgs);

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        // Owner is set to the multisig in the constructor rather than rotated afterwards:
        // the address is mined over the constructor arguments, so changing the owner here
        // would change the mined address and invalidate the permission bits.
        DecayingFeeHook hook = new DecayingFeeHook{salt: salt}(IPoolManager(poolManager), multisig);
        require(address(hook) == expected, "hook addr mismatch");
        console2.log("DecayingFeeHook deployed:", address(hook));
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== NEXT (multisig / operator) ===");
        console2.log("1. Per launch, BEFORE initializing the pool:");
        console2.log("   configurePool(key, startFeePips, baselineFeePips, decaySeconds)");
        console2.log("   The key MUST carry LPFeeLibrary.DYNAMIC_FEE_FLAG or the call reverts.");
        console2.log("   Reference span (hundredths of a bip / seconds):", hook.REFERENCE_DECAY_SECONDS());
        console2.log("2. Initialize the pool from THIS MULTISIG ITSELF:");
        console2.log("     poolManager.initialize(key, sqrtPriceX96)");
        console2.log("   AUDIT FIX TF-016 binds the initializer to the owner. A router-relayed");
        console2.log("   init (e.g. PositionManager.initializePool) arrives with sender == the");
        console2.log("   router and is REJECTED - and some periphery swallows that revert, so it");
        console2.log("   looks like nothing happened. Without the binding, anyone could have");
        console2.log("   opened the configured key first, starting the decay clock and choosing");
        console2.log("   the opening price before the launch. (The graduation path is unaffected:");
        console2.log("   TegridyLiquidityMigrator carries TegridyV4Hook, not this hook.)");
        console2.log("3. Publish the schedule on the fact sheet BEFORE the pool is initialized.");
        console2.log("   Once initialized it is fixed forever - the owner cannot raise, extend");
        console2.log("   or cancel it, and there is no proxy.");
        console2.log("4. Trade UI: read decaySchedule(key) every block while decaying == true.");
        console2.log("   quotedFeePips is the only honest number to show; rendering");
        console2.log("   baselineFeePips during decay quotes a price the pool will not honour.");
        console2.log("   configured == false means NO SCHEDULE, not a 0% fee.");
        console2.log("   live == false means the pool does not exist yet, so quotedFeePips is");
        console2.log("   zero for that reason alone - show startFeePips and say it opens there.");
    }
}
