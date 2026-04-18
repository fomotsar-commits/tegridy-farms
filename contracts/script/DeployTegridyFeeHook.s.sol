// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TegridyFeeHook} from "../src/TegridyFeeHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @title DeployTegridyFeeHook — CREATE2 salt-mining deploy for the Uniswap V4 hook.
/// @notice Uniswap V4 requires hook addresses to encode which permissions are active
///         as the low 14 bits of the deployed address. For TegridyFeeHook, we need
///         AFTER_SWAP_FLAG (0x0040) | AFTER_SWAP_RETURNS_DELTA (0x0004) => 0x0044
///         set on the deployed address.
///
///         This script mines a salt that, when combined with the bytecode hash and
///         the deployer factory, yields a valid hook address. Mining typically takes
///         thousands to tens-of-thousands of iterations depending on how lucky the
///         deployment is.
///
///         Closes audit item B7: "TegridyFeeHook has no deploy script".
///
/// @dev Env required:
///      PRIVATE_KEY       — deployer EOA
///      POOL_MANAGER      — Uniswap V4 pool manager address on the target chain
///      REVENUE_DIST      — address of RevenueDistributor (see constants.ts)
///      MAX_MINING_ITER   — (optional) cap on salt-mining iterations. Default 200_000.
contract DeployTegridyFeeHook is Script {

    /// @dev Uniswap V4 hook flag bits we need for TegridyFeeHook:
    ///      AFTER_SWAP_FLAG              = 1 << 6  = 0x0040
    ///      AFTER_SWAP_RETURNS_DELTA_FLAG= 1 << 2  = 0x0004
    /// @dev Kept in sync with the comment in TegridyFeeHook.sol: "combined
    ///      deploy-address bitmask 0x0044". If the hook surface ever expands
    ///      (e.g. adds BEFORE_SWAP_FLAG 0x0080), update both places.
    uint160 internal constant REQUIRED_FLAGS_MASK = uint160(0xFFFF);
    uint160 internal constant REQUIRED_FLAGS_VALUE = uint160(0x0044);

    /// @dev Canonical deterministic-deployment-proxy by Arachnid. Deployed on every
    ///      major EVM chain at this address. Accepts a raw transaction of the form
    ///      `CREATE2(salt, initCode)` and returns the deployed contract address.
    ///      See: https://github.com/Arachnid/deterministic-deployment-proxy
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external returns (TegridyFeeHook hook, bytes32 salt) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address poolManager = vm.envAddress("POOL_MANAGER");
        address revenueDist = vm.envAddress("REVENUE_DIST");
        // Default 30 bps (0.3%) matches SwapFeeRouter defaults. Override via env.
        uint256 feeBps = vm.envOr("TEGRIDY_FEE_HOOK_BPS", uint256(30));
        uint256 maxIter = vm.envOr("MAX_MINING_ITER", uint256(200_000));

        require(poolManager != address(0), "POOL_MANAGER not set");
        require(revenueDist != address(0), "REVENUE_DIST not set");

        // Build the exact init code the CREATE2 deployer will use.
        // Init code = runtime bytecode constructor + ABI-encoded constructor args.
        bytes memory initCode = abi.encodePacked(
            type(TegridyFeeHook).creationCode,
            abi.encode(poolManager, revenueDist, feeBps)
        );
        bytes32 initCodeHash = keccak256(initCode);

        (salt, ) = _mineSalt(initCodeHash, maxIter);

        console2.log("Mined salt:");
        console2.logBytes32(salt);
        address predicted = _computeAddress(salt, initCodeHash);
        console2.log("Predicted hook address:", predicted);
        console2.log("Low-16 bits:", uint256(uint160(predicted)) & 0xFFFF);
        require(
            (uint160(predicted) & REQUIRED_FLAGS_MASK) == REQUIRED_FLAGS_VALUE,
            "Predicted address does not satisfy hook flag bitmask"
        );

        vm.startBroadcast(pk);
        // Deploy via inline CREATE2. The Solidity `new Contract{salt: ...}()` syntax
        // uses the *caller's* CREATE2, not the deterministic deployer — so a forge
        // script running under a different broadcaster produces a different address
        // than a production deployer would. For a true chain-wide deterministic
        // address, deploy via the CREATE2 deployer using a raw call to its
        // well-known address; the factory's logic is simply CREATE2(salt, initCode).
        hook = new TegridyFeeHook{salt: salt}(
            IPoolManager(poolManager),
            revenueDist,
            feeBps
        );
        vm.stopBroadcast();

        console2.log("TegridyFeeHook deployed to:", address(hook));
        require(
            (uint160(address(hook)) & REQUIRED_FLAGS_MASK) == REQUIRED_FLAGS_VALUE,
            "DEPLOYED HOOK ADDRESS MISSES REQUIRED FLAG BITS"
        );
        console2.log("Next steps:");
        console2.log("  1. Verify on Etherscan: forge verify-contract ...");
        console2.log("  2. Register the hook address with your V4 pool on creation.");
        console2.log("  3. Add to frontend/src/lib/constants.ts as TEGRIDY_FEE_HOOK_ADDRESS.");
        console2.log("  4. Append to docs/MIGRATION_HISTORY.md under V3 features.");
    }

    /// @dev Iteratively mine salt until we find one whose CREATE2 address satisfies
    ///      the Uniswap V4 hook flag bitmask. Pure off-chain computation —
    ///      no gas, no state mutation, runs entirely inside forge script.
    function _mineSalt(bytes32 initCodeHash, uint256 maxIter)
        internal
        view
        returns (bytes32 salt, address hookAddr)
    {
        for (uint256 i; i < maxIter; ++i) {
            bytes32 candidate = bytes32(i);
            address candidateAddr = _computeAddress(candidate, initCodeHash);
            if ((uint160(candidateAddr) & REQUIRED_FLAGS_MASK) == REQUIRED_FLAGS_VALUE) {
                return (candidate, candidateAddr);
            }
        }
        revert("Salt mining exhausted - raise MAX_MINING_ITER");
    }

    /// @dev Reconstructs the address CREATE2 would produce for the canonical
    ///      deterministic deployment proxy at CREATE2_DEPLOYER, given a salt
    ///      and init code hash. Matches the EVM's CREATE2 formula.
    function _computeAddress(bytes32 salt, bytes32 initCodeHash)
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash
        )))));
    }
}
