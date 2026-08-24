// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {TegridyV4Hook} from "../../src/v4/TegridyV4Hook.sol";
import {TegridyV4HookAdmin} from "../../src/v4/TegridyV4HookAdmin.sol";
import {TegridyV4SwapRouter} from "../../src/v4/TegridyV4SwapRouter.sol";
import {TegridyFeeLocker} from "../../src/v4/TegridyFeeLocker.sol";
import {TegridyLiquidityMigrator, IPermit2Approve, ITegridyFeeLocker} from "../../src/v4/TegridyLiquidityMigrator.sol";
import {BaseChainConfig} from "./BaseChainConfig.sol";

/// @title  DeployBaseGraduationStack — Shape A, extended to Base (8453).
/// @notice Deploys the OWN-VENUE graduation stack on Base: hook admin,
///         the HookMiner/CREATE2 TegridyV4Hook, the trusted swap router, the fee
///         locker, and TegridyLiquidityMigrator — the SAME five contracts the
///         mainnet DeployV4.s.sol deploys, minus TegridyBoostedLPStaker (its
///         reward token is TOWELI and its boost source is TegridyStaking, both
///         mainnet-only; afterlife farming on this chain is a separate, later,
///         launch-specific decision — see DeployRobinhoodLPFarming's header).
///
/// @dev    WHY SHAPE A HERE TOO. docs/GRADUATION_VENUE_DECISION.md chose the
///         hooked-canonical-V4-pool venue on mainnet because the module is
///         written and tested (77 tests) and adds zero AMM-layer surface. The
///         owner's 2026-08-22 "every launcher graduates to us" directive resolves
///         to the SAME shape because the same facts hold and the substrate
///         exists: the full canonical V4 stack is live on Base (see
///         BaseChainConfig's provenance block). Nothing about this chain
///         justifies reviving the rejected V2-pair shape; see the decision doc's
///         4663 addendum.
///
/// @dev    Chain-specific inputs come from BaseChainConfig CONSTANTS
///         (PoolManager, PositionManager, Permit2, Airlock) — each verified
///         on-chain 2026-08-22 and cross-bound (posm.poolManager() == PoolManager)
///         — not env vars. The only env inputs are the role Safes.
///
/// @dev    Env: MULTISIG, TREASURY, PAUSE_GUARDIAN (Safes; validated).
///
/// @dev    GRADUATION STAYS DARK UNTIL TWO EXTERNAL STEPS COMPLETE, and the
///         printed runbook screams both: (1) the hook admin's 48h-timelocked
///         initializer allowance for the migrator, (2) Whetstone's 3-of-6 Safe
///         whitelisting the migrator on the 4663 Airlock (setModuleState → 4).
///         Until BOTH are done, no launch may select this migrator (create()
///         fail-fast) — and the frontend's venue probe already treats the
///         whitelist as a live read, never an assumption.
contract DeployBaseGraduationStackScript is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // ─── Deploy-time policy params — IDENTICAL to mainnet DeployV4.s.sol ─
    // Same economics or none, the standing rule. Reviewed 2026-08-22.
    uint48 internal constant BLOCK_OFFSET = 10; // JIT window (LiquidityPenaltyHook)
    uint24 internal constant MIN_FEE = 500; // 0.05%
    uint24 internal constant MAX_FEE = 30_000; // 3%
    uint24 internal constant BASE_FEE = 3_000; // 0.30%
    uint16 internal constant MAX_POL_BPS = 1_000; // 10% ceiling
    uint16 internal constant POL_BPS = 100; // 1% initial

    struct Config {
        address multisig;
        address treasury;
        address pauseGuardian;
    }

    struct Deployed {
        address hookAdmin;
        address hook;
        address swapRouter;
        address feeLocker;
        address migrator;
    }

    function run() external {
        Config memory cfg = Config({
            multisig: vm.envAddress("MULTISIG"),
            treasury: vm.envAddress("TREASURY"),
            pauseGuardian: vm.envAddress("PAUSE_GUARDIAN")
        });
        _validate(cfg);

        vm.startBroadcast();
        Deployed memory d = _deploy(cfg);
        vm.stopBroadcast();

        _assertDeployInvariants(cfg, d);
        _printSummary(cfg, d);
    }

    /// @notice Test entrypoint — same validation and deploy body, no env, no broadcast.
    /// @dev    Takes substrate overrides so a forge test can drive the whole
    ///         sequence against local mocks; `run()` always uses the verified
    ///         BaseChainConfig constants and remains the only broadcast path.
    ///         The CREATE2 executor differs by context — under `--broadcast` forge
    ///         routes salted `new` through the canonical 0x4e59… deployer, while in
    ///         a test the script contract itself executes the CREATE2 — so the
    ///         HookMiner target is a parameter, not a constant.
    function runForTest(Config memory cfg, address poolManager, address positionManager, address permit2, address airlock)
        external
        returns (Deployed memory d)
    {
        _validate(cfg);
        d = _deployWith(cfg, poolManager, positionManager, permit2, airlock, address(this), address(this));
        _assertDeployInvariants(cfg, d);
    }

    function _validate(Config memory cfg) internal view {
        BaseChainConfig.requireBaseChain();
        BaseChainConfig.requireSafe(cfg.multisig, "MULTISIG");
        BaseChainConfig.requireSafe(cfg.treasury, "TREASURY");
        BaseChainConfig.requireSafe(cfg.pauseGuardian, "PAUSE_GUARDIAN");
        BaseChainConfig.requireDisjoint(cfg.multisig, "MULTISIG", cfg.treasury, "TREASURY");
        BaseChainConfig.requireDisjoint(cfg.multisig, "MULTISIG", cfg.pauseGuardian, "PAUSE_GUARDIAN");
        BaseChainConfig.requireDisjoint(cfg.treasury, "TREASURY", cfg.pauseGuardian, "PAUSE_GUARDIAN");
    }

    function _deploy(Config memory cfg) internal returns (Deployed memory d) {
        // The broadcast path pins the substrate to the verified constants. A
        // sanity read-back on each — code presence — catches an RPC pointed at
        // the wrong chain even before the chain-id gate would.
        BaseChainConfig.requireHasCode(BaseChainConfig.UNISWAP_V4_POOL_MANAGER, "POOL_MANAGER");
        BaseChainConfig.requireHasCode(BaseChainConfig.UNISWAP_V4_POSITION_MANAGER, "POSITION_MANAGER");
        BaseChainConfig.requireHasCode(BaseChainConfig.PERMIT2, "PERMIT2");
        BaseChainConfig.requireHasCode(BaseChainConfig.DOPPLER_AIRLOCK, "DOPPLER_AIRLOCK");
        return _deployWith(
            cfg,
            BaseChainConfig.UNISWAP_V4_POOL_MANAGER,
            BaseChainConfig.UNISWAP_V4_POSITION_MANAGER,
            BaseChainConfig.PERMIT2,
            BaseChainConfig.DOPPLER_AIRLOCK,
            CREATE2_DEPLOYER,
            // Under --broadcast every call is a tx FROM the broadcaster, so the
            // locker's one-shot binder must be that EOA; in a test the script
            // contract itself executes the calls (runForTest passes itself).
            msg.sender
        );
    }

    function _deployWith(
        Config memory cfg,
        address poolManager,
        address positionManager,
        address permit2,
        address airlock,
        address create2Executor,
        address binder
    ) internal returns (Deployed memory d) {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
                | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
        );

        // 1. Admin first (hook.paramAdmin is immutable, so the admin must precede it).
        TegridyV4HookAdmin admin = new TegridyV4HookAdmin();
        d.hookAdmin = address(admin);
        console.log("1. TegridyV4HookAdmin:     ", d.hookAdmin);

        // 2. Mine an address whose low bits match the permission flags, then CREATE2-deploy.
        bytes memory ctorArgs = abi.encode(
            IPoolManager(poolManager), BLOCK_OFFSET, address(admin), MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, cfg.treasury
        );
        (address hookAddr, bytes32 salt) =
            HookMiner.find(create2Executor, flags, type(TegridyV4Hook).creationCode, ctorArgs);
        TegridyV4Hook hook = new TegridyV4Hook{salt: salt}(
            IPoolManager(poolManager), BLOCK_OFFSET, address(admin), MIN_FEE, MAX_FEE, BASE_FEE, MAX_POL_BPS, POL_BPS, cfg.treasury
        );
        require(address(hook) == hookAddr, "hook addr mismatch");
        d.hook = address(hook);
        console.log("2. TegridyV4Hook:          ", d.hook);

        // 3. Wire admin -> hook (one-time).
        admin.setHook(address(hook));

        // 4. The trusted swap router (authenticates the user into hookData).
        TegridyV4SwapRouter swapRouter = new TegridyV4SwapRouter(IPoolManager(poolManager));
        d.swapRouter = address(swapRouter);
        console.log("3. TegridyV4SwapRouter:    ", d.swapRouter);

        // 5. Fee locker, then migrator, then bind — IN THIS ORDER (write-once
        //    binding; an interruption leaves the locker unusable, never
        //    hijackable — redeploy rather than salvage). Same as mainnet.
        TegridyFeeLocker feeLocker = new TegridyFeeLocker(IPositionManager(positionManager), binder);
        d.feeLocker = address(feeLocker);
        console.log("4. TegridyFeeLocker:       ", d.feeLocker);

        //    rescueRecipient is IMMUTABLE with no setter — multisig, never the
        //    deployer EOA (the same owned-at-birth rule the uptime feed follows).
        TegridyLiquidityMigrator migrator = new TegridyLiquidityMigrator(
            airlock,
            IPoolManager(poolManager),
            IPositionManager(positionManager),
            IPermit2Approve(permit2),
            IHooks(address(hook)),
            cfg.multisig,
            ITegridyFeeLocker(address(feeLocker))
        );
        d.migrator = address(migrator);
        console.log("5. TegridyLiquidityMigrator:", d.migrator);

        feeLocker.bindMigrator(address(migrator));

        // 6. Guardian + two-step admin handoff. The hook gates setPauseGuardian
        //    to its paramAdmin (the admin contract), so the wire goes THROUGH the
        //    admin's instant pass-through — callable now because the deployer
        //    still owns the admin, and wired BEFORE the ownership offer so the
        //    step cannot be skipped later (the Base-MVP pattern).
        admin.hookSetPauseGuardian(cfg.pauseGuardian);
        admin.transferOwnership(cfg.multisig);
        console.log("   -> hook pauseGuardian wired via admin; admin ownership offered to multisig");
    }

    function _assertDeployInvariants(Config memory cfg, Deployed memory d) internal view {
        require(TegridyV4Hook(payable(d.hook)).paramAdmin() == d.hookAdmin, "G-INV-1: hook paramAdmin != admin");
        require(TegridyFeeLocker(payable(d.feeLocker)).locker() == d.migrator, "G-INV-2: locker not bound to migrator");
        require(
            TegridyLiquidityMigrator(payable(d.migrator)).rescueRecipient() == cfg.multisig,
            "G-INV-3: rescueRecipient != multisig (immutable, unrecoverable if wrong)"
        );
        require(
            address(TegridyLiquidityMigrator(payable(d.migrator)).hook()) == d.hook,
            "G-INV-4: migrator hook mismatch"
        );
        require(
            TegridyV4Hook(payable(d.hook)).pauseGuardian() == cfg.pauseGuardian,
            "G-INV-5: hook pauseGuardian unwired"
        );
        require(
            TegridyV4HookAdmin(d.hookAdmin).pendingOwner() == cfg.multisig,
            "G-INV-6: admin ownership not offered to multisig"
        );
    }

    function _printSummary(Config memory cfg, Deployed memory d) internal pure {
        console.log("");
        console.log("=== BASE GRADUATION STACK COMPLETE (Shape A on 8453) ===");
        console.log("HookAdmin: ", d.hookAdmin);
        console.log("Hook:      ", d.hook);
        console.log("SwapRouter:", d.swapRouter);
        console.log("FeeLocker: ", d.feeLocker);
        console.log("Migrator:  ", d.migrator);
        console.log("");
        console.log("GRADUATION IS DARK until BOTH of these land - in this order, and the");
        console.log("second is an EXTERNAL PARTY with the longest lead time in the plan:");
        console.log(" 1. multisig: admin.proposeInitializerAllowed(migrator, true) -> 48h ->");
        console.log("    executeInitializerAllowed(). Without it every graduation reverts at");
        console.log("    poolManager.initialize - and Airlock.migrate transfers funds in FIRST,");
        console.log("    so a launch that somehow selected the migrator early would strand.");
        console.log(" 2. Whetstone's 3-of-6 Safe (0x21E2ce70... - same signers as mainnet/Base)");
        console.log("    whitelists the migrator on the Base Airlock: setModuleState([migrator],[4]).");
        console.log("    See docs/WHETSTONE_MIGRATOR_PETITION_4663.md (the multichain rider covers Base too). Do NOT set any frontend");
        console.log("    migrator constant until getModuleState reads 4 - the venue probe checks live.");
        console.log(" 3. multisig: acceptOwnership() on the hook admin (14-day expiry).");
        console.log("");
        console.log("NOT DEPLOYED HERE: TegridyBoostedLPStaker (rewards are TOWELI + veTOWELI");
        console.log("boost - mainnet-only by standing rule). Afterlife farming on this chain");
        console.log("is a separate decision with its own reward token, like the LP farm.");
        console.log("Multisig:", cfg.multisig);
    }
}
