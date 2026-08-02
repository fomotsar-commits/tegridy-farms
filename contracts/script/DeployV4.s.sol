// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TegridyV4Hook} from "../src/v4/TegridyV4Hook.sol";
import {TegridyV4HookAdmin} from "../src/v4/TegridyV4HookAdmin.sol";
import {TegridyV4SwapRouter} from "../src/v4/TegridyV4SwapRouter.sol";
import {TegridyBoostedLPStaker} from "../src/v4/TegridyBoostedLPStaker.sol";
import {TegridyFeeLocker} from "../src/v4/TegridyFeeLocker.sol";
import {TegridyLiquidityMigrator, IPermit2Approve, ITegridyFeeLocker} from "../src/v4/TegridyLiquidityMigrator.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

/// @title  DeployV4 — V4 migration deploy script (V4 goes live at the V2 relaunch)
/// @notice Deploys the four V4 contracts in runbook order: TegridyV4HookAdmin, the
///         HookMiner/CREATE2 TegridyV4Hook (permission-matching address),
///         TegridyV4SwapRouter (#2 trusted router), and TegridyBoostedLPStaker
///         (#3 NFT-staker, owner = MULTISIG). Wires admin<->hook and hands admin
///         ownership to the multisig (Ownable2Step).
///
/// @dev    Env: POOL_MANAGER, MULTISIG, TREASURY (POL recipient), REWARD_TOKEN
///         (TOWELI), STAKING (veTOWELI boost source), POSITION_MANAGER (V4 PM),
///         CURRENCY0 + CURRENCY1 (the pool's two tokens; sorted in-script to derive
///         the staker's immutable allowedPoolId). Fee/skim params below are
///         deploy-time policy — review before mainnet.
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
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // ─── Deploy-time policy params (REVIEW before mainnet) ────────────
    uint48 internal constant BLOCK_OFFSET = 10; // JIT window (LiquidityPenaltyHook)
    uint24 internal constant MIN_FEE = 500; // 0.05%
    uint24 internal constant MAX_FEE = 30_000; // 3%
    uint24 internal constant BASE_FEE = 3_000; // 0.30%
    uint16 internal constant MAX_POL_BPS = 1_000; // 10% ceiling
    // 0.25% initial skim (2026-08-02 economics synthesis). Trader all-in early is
    // LP fee + skim; at 100 bps the mature all-in (0.30% + 1%) would sit 4x above
    // the canonical 0.30% pool rate and invite a parallel vanilla-V4 pool to
    // drain routing. 25 bps launches inside pump.fun's 1.25% early envelope and
    // steps DOWN to ~10 via the timelocked setter as a pool matures.
    uint16 internal constant POL_BPS = 25;

    function run() external {
        address poolManager = vm.envAddress("POOL_MANAGER");
        address multisig = vm.envAddress("MULTISIG");
        address treasury = vm.envAddress("TREASURY");
        address rewardToken = vm.envAddress("REWARD_TOKEN");
        address staking = vm.envAddress("STAKING");
        address positionManager = vm.envAddress("POSITION_MANAGER");
        address currency0 = vm.envAddress("CURRENCY0");
        address currency1 = vm.envAddress("CURRENCY1");
        // Doppler's Airlock (mainnet 0xde3599a2ec440b296373a983c85c365da55d9dfa) and
        // the canonical Permit2 — both are inputs to the graduation path, not
        // things we deploy.
        address airlock = vm.envAddress("DOPPLER_AIRLOCK");
        address permit2 = vm.envAddress("PERMIT2");
        require(airlock != address(0) && permit2 != address(0), "zero migrator env");
        require(poolManager != address(0) && multisig != address(0) && treasury != address(0), "zero env");
        require(multisig != treasury, "multisig==treasury"); // minimal disjoint check
        require(rewardToken != address(0) && staking != address(0) && positionManager != address(0), "zero staker env");
        require(currency0 != currency1, "currency0==currency1");

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

        // 3. Wire admin -> hook (one-time).
        admin.setHook(address(hook));

        // 4. Deploy the trusted swap router (#2 — authenticates the user into hookData).
        TegridyV4SwapRouter router = new TegridyV4SwapRouter(IPoolManager(poolManager));

        // 5. Deploy the boosted-LP NFT-staker (#3). Its allowedPoolId is IMMUTABLE, so
        //    derive it from the canonical pool key — currencies sorted as V4 requires
        //    (currency0 < currency1). VerifyV4 re-derives and asserts this matches.
        (address lo, address hi) = currency0 < currency1 ? (currency0, currency1) : (currency1, currency0);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(lo),
            currency1: Currency.wrap(hi),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: int24(60),
            hooks: IHooks(address(hook))
        });
        bytes32 allowedPoolId = PoolId.unwrap(key.toId());
        TegridyBoostedLPStaker staker =
            new TegridyBoostedLPStaker(IERC20(rewardToken), staking, positionManager, allowedPoolId, multisig);

        // 6. Fee locker, then migrator, then bind — IN THIS ORDER.
        //
        //    The migrator takes the locker's address as a constructor immutable,
        //    and the locker must know the migrator's. That is circular and cannot
        //    be satisfied at construction, so the locker is deployed with the
        //    DEPLOYER as its binder and learns the migrator afterwards, once.
        //
        //    `bindMigrator` is write-once: until it is called nothing can register
        //    a lock, and after it is called the binding is permanent. If this
        //    script is interrupted between the two, the locker is unusable rather
        //    than hijackable — redeploy it, do not try to salvage.
        TegridyFeeLocker feeLocker = new TegridyFeeLocker(IPositionManager(positionManager), msg.sender);

        //    rescueRecipient is IMMUTABLE with no setter. It is the only address
        //    `sweepStuck` can ever pay, so a wrong value here is unrecoverable —
        //    it must be the multisig, never the deployer EOA.
        TegridyLiquidityMigrator migrator = new TegridyLiquidityMigrator(
            airlock,
            IPoolManager(poolManager),
            IPositionManager(positionManager),
            IPermit2Approve(permit2),
            IHooks(address(hook)),
            multisig,
            ITegridyFeeLocker(address(feeLocker))
        );

        feeLocker.bindMigrator(address(migrator));
        require(feeLocker.locker() == address(migrator), "locker not bound to migrator");

        // 7. Hand admin ownership to the multisig (Ownable2Step: multisig must acceptOwnership()).
        admin.transferOwnership(multisig);

        vm.stopBroadcast();

        console2.log("TegridyV4HookAdmin:    ", address(admin));
        console2.log("TegridyV4Hook:         ", address(hook));
        console2.log("TegridyV4SwapRouter:   ", address(router));
        console2.log("TegridyBoostedLPStaker:", address(staker));
        console2.log("TegridyFeeLocker:      ", address(feeLocker));
        console2.log("TegridyLiquidityMigrator:", address(migrator));
        console2.log("paramAdmin (hook):     ", hook.paramAdmin());
        console2.log("staker allowedPoolId:");
        console2.logBytes32(allowedPoolId);
        console2.log("");
        console2.log("REMAINING, and graduation REVERTS until both are done:");
        console2.log(" 1. admin.proposeInitializerAllowed(migrator, true) -> wait 48h -> executeInitializerAllowed()");
        console2.log("    Without it every graduation reverts at poolManager.initialize, and because");
        console2.log("    Airlock.migrate transfers the funds in BEFORE calling us, they strand.");
        console2.log(" 2. Whetstone must whitelist the migrator: setModuleState(migrator, 4)");
        console2.log("    See docs/WHETSTONE_MIGRATOR_PETITION.md - external party, longest lead time.");
        console2.log("also: acceptOwnership, set pauseGuardian, allowlist+initialize pool, seed POL, notifyRewardAmount");
    }
}
