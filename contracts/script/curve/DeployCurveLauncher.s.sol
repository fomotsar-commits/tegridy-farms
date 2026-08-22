// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyCurveLauncher} from "../../src/curve/TegridyCurveLauncher.sol";

interface IFactoryProbe {
    function getPair(address, address) external view returns (address);
}

/// @title  DeployCurveLauncher — the own EVM launch curve, any served chain.
/// @notice One script for mainnet (1), Base (8453), and Robinhood Chain (4663):
///         the launcher has no chain-specific code at all — no oracle, no
///         sequencer feed (pricing is path-independent constant-product), no
///         TOWELI reference. The only per-chain inputs are the canonical WETH
///         (pinned below per chainid) and OUR TegridyFactory on that chain
///         (env, because the Base/Robinhood factories deploy in the operator
///         ceremony and their addresses are not knowable here).
///
/// @dev    Roles are CONSTRUCT-WITH-FINAL-ROLES (the M6 lesson): the owner is
///         the multisig from birth — there is no deployer-owned window and no
///         post-deploy rotation step to forget.
///
/// @dev    Economics env (wei values as uint):
///           GRADUATION_ETH_WEI — required; the real-ETH completion target.
///           VIRTUAL_ETH_WEI    — optional; defaults to GRADUATION_ETH_WEI/19,
///                                the continuity-exact choice (listing at 95%
///                                of the final curve price — the band edge).
///                                Any override must still satisfy the band.
///           CURVE_FEE_BPS      — optional; default 100 (1%).
///           CREATOR_FEE_SHARE_BPS — optional; default 5000 (50% of the fee).
///           RESERVE_BPS        — optional; default 369 (3.69% of supply, the
///                                owner's 2026-08-22 decision, down from 5%).
///           RESERVE_RECIPIENT  — required when RESERVE_BPS > 0; the ecosystem
///                                reserve recipient (M.11 decided: the operator
///                                address; a Safe/vault is recommended but an
///                                owner-chosen EOA is accepted with a warning).
///         Role env:
///           FACTORY, MULTISIG, PAUSE_GUARDIAN
///
/// @dev    Run (example, Base):
///           forge script script/curve/DeployCurveLauncher.s.sol --rpc-url $BASE_RPC --sender $OP -vvv
contract DeployCurveLauncherScript is Script {
    // Canonical WETH per served chain — same constants the chain configs pin.
    address internal constant WETH_MAINNET = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant WETH_BASE = 0x4200000000000000000000000000000000000006;
    address internal constant WETH_ROBINHOOD = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    struct Config {
        address factory;
        address weth;
        address multisig;
        address pauseGuardian;
        TegridyCurveLauncher.LaunchConfig launch;
    }

    function run() external {
        Config memory cfg = _loadConfig();
        _validate(cfg);

        vm.startBroadcast();
        TegridyCurveLauncher launcher = new TegridyCurveLauncher(
            cfg.factory, cfg.weth, cfg.multisig, cfg.pauseGuardian, cfg.launch
        );
        vm.stopBroadcast();

        _assertDeployInvariants(cfg, launcher);
        _printSummary(cfg, launcher);
    }

    /// @notice Test entrypoint — same validation + invariants, no env/broadcast.
    function runForTest(Config memory cfg) external returns (TegridyCurveLauncher launcher) {
        _validate(cfg);
        launcher = new TegridyCurveLauncher(
            cfg.factory, cfg.weth, cfg.multisig, cfg.pauseGuardian, cfg.launch
        );
        _assertDeployInvariants(cfg, launcher);
    }

    function _loadConfig() internal view returns (Config memory cfg) {
        cfg.factory = vm.envAddress("FACTORY");
        cfg.multisig = vm.envAddress("MULTISIG");
        cfg.pauseGuardian = vm.envAddress("PAUSE_GUARDIAN");
        cfg.weth = _canonicalWeth();

        uint256 graduationEth = vm.envUint("GRADUATION_ETH_WEI");
        // Continuity-exact default: T = 19·Vs lists at exactly 95% of the
        // final curve price. Operators overriding VIRTUAL_ETH_WEI still hit
        // the contract's own band check.
        uint256 virtualEth = vm.envOr("VIRTUAL_ETH_WEI", graduationEth / 19);
        uint256 reserveBps = vm.envOr("RESERVE_BPS", uint256(369));

        cfg.launch = TegridyCurveLauncher.LaunchConfig({
            virtualEth: uint128(virtualEth),
            graduationEth: uint128(graduationEth),
            feeBps: uint16(vm.envOr("CURVE_FEE_BPS", uint256(100))),
            creatorFeeShareBps: uint16(vm.envOr("CREATOR_FEE_SHARE_BPS", uint256(5_000))),
            reserveBps: uint16(reserveBps),
            reserveRecipient: reserveBps > 0
                ? vm.envAddress("RESERVE_RECIPIENT")
                : vm.envOr("RESERVE_RECIPIENT", address(0))
        });
    }

    function _canonicalWeth() internal view returns (address) {
        if (block.chainid == 1) return WETH_MAINNET;
        if (block.chainid == 8453) return WETH_BASE;
        if (block.chainid == 4663) return WETH_ROBINHOOD;
        revert("CV-0: unsupported chain - serve a new chain deliberately, not by fork default");
    }

    function _validate(Config memory cfg) internal view {
        // CV-1: the factory must be a live contract that actually serves the
        // getPair selector — a wrong address here strands every graduation.
        require(cfg.factory.code.length > 0, "CV-1: FACTORY has no code");
        // Probe with a never-registered key: any real factory returns zero.
        require(
            IFactoryProbe(cfg.factory).getPair(cfg.weth, address(this)) == address(0),
            "CV-1b: FACTORY getPair probe returned nonsense"
        );
        require(cfg.weth.code.length > 0, "CV-2: WETH has no code");

        // CV-3: every role is a contract (Safe-class), and the launcher's
        // sanctioned graduation flow ships value to the reserve recipient —
        // it must be custody, never an EOA typo.
        require(cfg.multisig.code.length > 0, "CV-3: MULTISIG must be a contract (Safe)");
        require(
            cfg.pauseGuardian.code.length > 0, "CV-3b: PAUSE_GUARDIAN must be a contract (Safe)"
        );
        if (cfg.launch.reserveBps > 0) {
            // CV-3c: the reserve ships value here on every graduation, so it must
            // never be the zero address (that would burn 3.69% of each launch).
            // The on-chain launcher enforces the same non-zero rule. A custody
            // Safe/vault is STRONGLY preferred, but the owner may deliberately
            // point the reserve at an operator EOA (2026-08-22 decision) — that
            // is accepted with a loud warning rather than a hard revert, because
            // it is a legitimate, reversible policy choice (setLaunchConfig can
            // repoint future launches to a Safe later).
            require(
                cfg.launch.reserveRecipient != address(0),
                "CV-3c: RESERVE_RECIPIENT is the zero address (would burn the reserve)"
            );
            if (cfg.launch.reserveRecipient.code.length == 0) {
                console2.log(
                    "!! CV-3c WARNING: RESERVE_RECIPIENT is an EOA, not a custody contract:"
                );
                console2.log("   ", cfg.launch.reserveRecipient);
                console2.log(
                    "   A single key will hold the accumulated ecosystem reserve. Prefer a Safe/vault."
                );
            }
        }

        // CV-4: economics sanity — a graduation target this small produces an
        // untradeable dust pool. Mirrors the launcher's on-chain
        // MIN_GRADUATION_ETH (the constructor enforces the same floor now, so
        // this is an early, legible failure rather than the sole guard).
        require(cfg.launch.graduationEth >= 0.1 ether, "CV-4: GRADUATION_ETH_WEI < 0.1 ether");
    }

    function _assertDeployInvariants(Config memory cfg, TegridyCurveLauncher launcher)
        internal
        view
    {
        require(address(launcher.FACTORY()) == cfg.factory, "CV-5: factory mismatch");
        require(address(launcher.WETH()) == cfg.weth, "CV-6: weth mismatch");
        require(launcher.owner() == cfg.multisig, "CV-7: owner not multisig at birth");
        require(launcher.pauseGuardian() == cfg.pauseGuardian, "CV-8: guardian mismatch");

        (
            uint128 virtualEth,
            uint128 graduationEth,
            uint16 feeBps,
            uint16 creatorShare,
            uint16 reserveBps,
            address reserveRecipient
        ) = launcher.launchConfig();
        require(virtualEth == cfg.launch.virtualEth, "CV-9: virtualEth mismatch");
        require(graduationEth == cfg.launch.graduationEth, "CV-9b: graduationEth mismatch");
        require(feeBps == cfg.launch.feeBps, "CV-9c: feeBps mismatch");
        require(creatorShare == cfg.launch.creatorFeeShareBps, "CV-9d: creatorShare mismatch");
        require(reserveBps == cfg.launch.reserveBps, "CV-9e: reserveBps mismatch");
        require(
            reserveRecipient == cfg.launch.reserveRecipient, "CV-9f: reserveRecipient mismatch"
        );
        require(launcher.launchCount() == 0, "CV-10: launcher not pristine");
    }

    function _printSummary(Config memory cfg, TegridyCurveLauncher launcher) internal view {
        console2.log("=== TegridyCurveLauncher deployed ===");
        console2.log("chainid:            ", block.chainid);
        console2.log("launcher:           ", address(launcher));
        console2.log("factory:            ", cfg.factory);
        console2.log("weth:               ", cfg.weth);
        console2.log("owner (multisig):   ", cfg.multisig);
        console2.log("pause guardian:     ", cfg.pauseGuardian);
        console2.log("virtualEth (wei):   ", uint256(cfg.launch.virtualEth));
        console2.log("graduationEth (wei):", uint256(cfg.launch.graduationEth));
        console2.log("feeBps:             ", uint256(cfg.launch.feeBps));
        console2.log("creatorFeeShareBps: ", uint256(cfg.launch.creatorFeeShareBps));
        console2.log("reserveBps:         ", uint256(cfg.launch.reserveBps));
        console2.log("reserveRecipient:   ", cfg.launch.reserveRecipient);
        console2.log("");
        console2.log("Operator next steps:");
        console2.log(" 1. Record the launcher in frontend/scripts/addresses.json (FULL address).");
        console2.log(" 2. Etherscan/Blockscout-verify (see foundry.toml [etherscan]).");
        console2.log(" 3. Wire the frontend curve rail to this address for this chain.");
        console2.log(" 4. Dry-run one full launch on a fork: create -> buys -> graduation.");
    }
}
