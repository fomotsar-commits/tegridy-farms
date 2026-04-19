// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TegridyFeeHook} from "../src/TegridyFeeHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @title DeployTegridyFeeHook — Deploy the Uniswap V4 hook using a precomputed salt.
/// @notice Uniswap V4 requires hook addresses to encode which permissions are active
///         as the low 14 bits of the deployed address. TegridyFeeHook needs
///         AFTER_SWAP_FLAG (0x0040) | AFTER_SWAP_RETURNS_DELTA (0x0004) => 0x0044
///         set on the deployed address.
///
///         The prior in-EVM salt miner allocated memory per iteration and hit
///         MemoryOOG around 180k iterations. Mining a 16-bit suffix needs ~65k
///         attempts on average, so we were frequently unlucky.
///
///         Fix: mine the salt off-chain with `cast create2 --ends-with 0044`
///         (runs in milliseconds, uses all CPU threads) and pass it in as
///         `CREATE2_SALT`. This script just validates and broadcasts.
///
///         Closes audit item B7.
///
/// @dev Env required:
///      PRIVATE_KEY       — deployer EOA
///      POOL_MANAGER      — Uniswap V4 pool manager address on the target chain
///      REVENUE_DIST      — address of RevenueDistributor (see constants.ts)
///      CREATE2_SALT      — 32-byte hex salt, precomputed off-chain (see README below)
///      HOOK_OWNER        — (optional) address to own the hook. Defaults to deployer EOA.
///      TEGRIDY_FEE_HOOK_BPS — (optional) fee in bps, default 30 = 0.3%
///
/// @dev How to compute CREATE2_SALT:
///      1) Build contracts: `cd contracts && forge build --skip test`
///      2) Get initCodeHash:
///          CREATION=$(cat out/TegridyFeeHook.sol/TegridyFeeHook.json | \
///             node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(d.bytecode.object);")
///          CTOR_ARGS=$(cast abi-encode "f(address,address,uint256,address)" \
///             "$POOL_MANAGER" "$REVENUE_DIST" 30 "$HOOK_OWNER")
///          INITCODE_HASH=$(cast keccak "${CREATION}${CTOR_ARGS:2}")
///      3) Mine:
///          cast create2 --ends-with 0044 --init-code-hash $INITCODE_HASH \
///            --deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C
///      4) Export the printed salt as CREATE2_SALT and broadcast this script.
contract DeployTegridyFeeHook is Script {

    uint160 internal constant REQUIRED_FLAGS_MASK = uint160(0xFFFF);
    uint160 internal constant REQUIRED_FLAGS_VALUE = uint160(0x0044);

    function run() external returns (TegridyFeeHook hook, bytes32 salt) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address poolManager = vm.envAddress("POOL_MANAGER");
        address revenueDist = vm.envAddress("REVENUE_DIST");
        address hookOwner = vm.envOr("HOOK_OWNER", vm.addr(pk));
        uint256 feeBps = vm.envOr("TEGRIDY_FEE_HOOK_BPS", uint256(30));
        salt = vm.envBytes32("CREATE2_SALT");

        require(poolManager != address(0), "POOL_MANAGER not set");
        require(revenueDist != address(0), "REVENUE_DIST not set");
        require(hookOwner != address(0), "HOOK_OWNER not set");
        require(salt != bytes32(0), "CREATE2_SALT not set (mine off-chain via cast create2)");

        console2.log("Deployer:", vm.addr(pk));
        console2.log("Hook owner:", hookOwner);
        console2.log("PoolManager:", poolManager);
        console2.log("RevenueDist:", revenueDist);
        console2.log("Fee bps:", feeBps);

        vm.startBroadcast(pk);
        hook = new TegridyFeeHook{salt: salt}(
            IPoolManager(poolManager),
            revenueDist,
            feeBps,
            hookOwner
        );
        vm.stopBroadcast();

        console2.log("TegridyFeeHook deployed to:", address(hook));
        require(
            (uint160(address(hook)) & REQUIRED_FLAGS_MASK) == REQUIRED_FLAGS_VALUE,
            "DEPLOYED HOOK ADDRESS MISSES REQUIRED FLAG BITS"
        );
        require(hook.owner() == hookOwner, "OWNER_MISMATCH_check_HOOK_OWNER_env_var");

        console2.log("Next steps:");
        console2.log("  1. Verify on Etherscan: forge verify-contract <addr> TegridyFeeHook");
        console2.log("  2. Register the hook address with your V4 pool on creation");
        console2.log("  3. Update TEGRIDY_FEE_HOOK_ADDRESS in frontend/src/lib/constants.ts");
    }
}
