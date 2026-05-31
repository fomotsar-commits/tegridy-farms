// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {TegridyV4Hook} from "../src/v4/TegridyV4Hook.sol";
import {TegridyV4HookAdmin} from "../src/v4/TegridyV4HookAdmin.sol";

/// @title  DeployV4 — V4 migration deploy script (V4 goes live at the V2 relaunch)
/// @notice Deploys TegridyV4HookAdmin, mines + CREATE2-deploys TegridyV4Hook at a
///         permission-matching address, wires them, and hands admin ownership to
///         the multisig.
///
/// @dev    Env: POOL_MANAGER, MULTISIG, TREASURY (POL recipient). Fee/skim params
///         below are deploy-time policy — review before mainnet.
///
/// @dev    Forge routes salted `new{salt}` through the canonical CREATE2 deployer
///         (0x4e59…) during broadcast, so HookMiner.find uses that same deployer.
///
/// @dev    OPERATIONAL STEPS NOT IN THIS SCRIPT (done by the multisig, post-deploy,
///         with treasury keys — kept out of an automated script intentionally):
///           1. allowlist the TOWELI/WETH dynamic-fee pool key (admin.proposePoolAllowed)
///           2. manager.initialize(key, sqrtPrice) with LPFeeLibrary.DYNAMIC_FEE_FLAG
///           3. seed full-range POL via PositionManager from the treasury
///           4. set the PauseGuardian via hook.setPauseGuardian (the hook supports it — Batch 6)
///           5. MULTISIG.acceptOwnership() on the admin (Ownable2Step)
contract DeployV4Script is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // ─── Deploy-time policy params (REVIEW before mainnet) ────────────
    uint48 internal constant BLOCK_OFFSET = 10; // JIT window (LiquidityPenaltyHook)
    uint24 internal constant MIN_FEE = 500; // 0.05%
    uint24 internal constant MAX_FEE = 30_000; // 3%
    uint24 internal constant BASE_FEE = 3_000; // 0.30%
    uint16 internal constant MAX_POL_BPS = 1_000; // 10% ceiling
    uint16 internal constant POL_BPS = 100; // 1% initial

    function run() external {
        address poolManager = vm.envAddress("POOL_MANAGER");
        address multisig = vm.envAddress("MULTISIG");
        address treasury = vm.envAddress("TREASURY");
        require(poolManager != address(0) && multisig != address(0) && treasury != address(0), "zero env");
        require(multisig != treasury, "multisig==treasury"); // minimal disjoint check

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
                | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
        );

        vm.startBroadcast();

        // 1. Admin first (hook.paramAdmin is immutable, so the admin must precede it).
        TegridyV4HookAdmin admin = new TegridyV4HookAdmin();

        // 2. Mine an address whose low bits match the permission flags, then CREATE2-deploy.
        bytes memory ctorArgs = abi.encode(
            IPoolManager(poolManager), BLOCK_OFFSET, address(admin), MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, treasury
        );
        (address hookAddr, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, flags, type(TegridyV4Hook).creationCode, ctorArgs);
        TegridyV4Hook hook = new TegridyV4Hook{salt: salt}(
            IPoolManager(poolManager), BLOCK_OFFSET, address(admin), MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, treasury
        );
        require(address(hook) == hookAddr, "hook addr mismatch");

        // 3. Wire admin -> hook (one-time) and hand admin ownership to the multisig.
        admin.setHook(address(hook));
        admin.transferOwnership(multisig); // Ownable2Step: multisig must acceptOwnership()

        vm.stopBroadcast();

        console2.log("TegridyV4HookAdmin:", address(admin));
        console2.log("TegridyV4Hook:     ", address(hook));
        console2.log("paramAdmin (hook): ", hook.paramAdmin());
        console2.log("next: multisig.acceptOwnership(), allowlist pool, initialize, seed POL");
    }
}
