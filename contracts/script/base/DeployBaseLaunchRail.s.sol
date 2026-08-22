// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyLaunchpadV2} from "../../src/TegridyLaunchpadV2.sol";
import {TegridyLockVault} from "../../src/TegridyLockVault.sol";
import {VestingFactory} from "../../src/VestingFactory.sol";
import {AirdropFactory} from "../../src/AirdropFactory.sol";
import {LaunchRugEscrow} from "../../src/LaunchRugEscrow.sol";
import {LaunchLockView} from "../../src/LaunchLockView.sol";
import {BaseChainConfig} from "./BaseChainConfig.sol";

/// @title  DeployBaseLaunchRail — the Base (8453) leg of the own-launchpad rail.
/// @notice Deploys six contracts, all verbatim redeploys of mainnet-audited source:
///         TegridyLaunchpadV2 (which auto-deploys its TegridyDropV2 template),
///         TegridyLockVault, VestingFactory, AirdropFactory, LaunchRugEscrow, and
///         LaunchLockView. Nothing here is new Solidity. The mainnet scripts for
///         these carry `require(chainid == 1)` as POLICY, not necessity — the
///         portability audit found zero TOWELI/staking references in any of the
///         six; the only chain-specific inputs are WETH and the sequencer feed.
///
/// @dev    THE SEQUENCER FEED IS LOAD-BEARING HERE, unlike on mainnet. Audit
///         F-30-10-adjacent trap: TegridyLaunchpadV2 bakes the feed IMMUTABLY into
///         itself and into every TegridyDropV2 clone ever created from it. On
///         mainnet the feed is forced to address(0) (no sequencer concept). On any
///         other chain a zero feed does not degrade — SequencerCheck reverts
///         `SequencerFeedNotConfigured()` on every dutch-auction mint, forever,
///         with no setter to fix it. This script therefore REFUSES a zero or
///         code-less feed. Base's canonical Chainlink feed is the default.
///
/// @dev    Env vars:
///           TREASURY        — protocol-fee recipient Safe on Base
///           MULTISIG        — Ownable role Safe (disjoint signer set)
///           PAUSE_GUARDIAN  — pause-only Safe (wired on the three Pausable rails)
///           SEQUENCER_FEED  — optional override; defaults to the canonical Base feed
///
/// @dev    Run:
///           forge script script/base/DeployBaseLaunchRail.s.sol --rpc-url $BASE_RPC --sender $OP -vvv
contract DeployBaseLaunchRailScript is Script {
    /// @notice Same 5% as the mainnet launchpad. A per-chain fee is a pricing
    ///         decision; this leg deploys the same economics or none.
    uint16 internal constant LAUNCHPAD_FEE_BPS = 500;

    struct Config {
        address treasury;
        address multisig;
        address pauseGuardian;
        address sequencerFeed;
    }

    struct Deployed {
        address launchpad;
        address dropTemplate;
        address lockVault;
        address vestingFactory;
        address airdropFactory;
        address rugEscrow;
        address lockView;
    }

    function run() external {
        Config memory cfg = _loadConfig();
        _validate(cfg);

        vm.startBroadcast();
        Deployed memory d = _deploy(cfg, msg.sender);
        vm.stopBroadcast();

        _assertDeployInvariants(cfg, d);
        _printSummary(cfg, d);
    }

    /// @notice Test entrypoint — same validation and deploy body, no env, no broadcast.
    function runForTest(Config memory cfg) external returns (Deployed memory d) {
        _validate(cfg);
        d = _deploy(cfg, address(this));
        _assertDeployInvariants(cfg, d);
    }

    function _loadConfig() internal view returns (Config memory cfg) {
        cfg.treasury = vm.envAddress("TREASURY");
        cfg.multisig = vm.envAddress("MULTISIG");
        cfg.pauseGuardian = vm.envAddress("PAUSE_GUARDIAN");
        cfg.sequencerFeed = vm.envOr("SEQUENCER_FEED", BaseChainConfig.SEQUENCER_UPTIME_FEED);
    }

    function _validate(Config memory cfg) internal view {
        BaseChainConfig.requireBaseChain();

        BaseChainConfig.requireSafe(cfg.treasury, "TREASURY");
        BaseChainConfig.requireSafe(cfg.multisig, "MULTISIG");
        BaseChainConfig.requireSafe(cfg.pauseGuardian, "PAUSE_GUARDIAN");
        BaseChainConfig.requireDisjoint(cfg.treasury, "TREASURY", cfg.multisig, "MULTISIG");
        BaseChainConfig.requireDisjoint(cfg.treasury, "TREASURY", cfg.pauseGuardian, "PAUSE_GUARDIAN");
        BaseChainConfig.requireDisjoint(cfg.multisig, "MULTISIG", cfg.pauseGuardian, "PAUSE_GUARDIAN");

        // The immutable-into-every-clone trap documented in the header.
        BaseChainConfig.requireHasCode(cfg.sequencerFeed, "SEQUENCER_FEED");
    }

    function _deploy(Config memory cfg, address deployer) internal returns (Deployed memory d) {
        // 1. The launchpad factory. Deployer owns first so the wiring below works;
        //    two-step offer to the Safe at the end.
        TegridyLaunchpadV2 launchpad = new TegridyLaunchpadV2(
            deployer,
            LAUNCHPAD_FEE_BPS,
            cfg.treasury,
            BaseChainConfig.WETH,
            cfg.sequencerFeed
        );
        d.launchpad = address(launchpad);
        d.dropTemplate = launchpad.dropTemplate();
        console.log("1. TegridyLaunchpadV2:    ", d.launchpad);
        console.log("   dropTemplate:          ", d.dropTemplate);

        // 2-4. The lock/vesting/airdrop rails. Chain-agnostic; owner-only ctors.
        TegridyLockVault lockVault = new TegridyLockVault(deployer);
        d.lockVault = address(lockVault);
        console.log("2. TegridyLockVault:      ", d.lockVault);

        VestingFactory vestingFactory = new VestingFactory(deployer);
        d.vestingFactory = address(vestingFactory);
        console.log("3. VestingFactory:        ", d.vestingFactory);

        AirdropFactory airdropFactory = new AirdropFactory(deployer);
        d.airdropFactory = address(airdropFactory);
        console.log("4. AirdropFactory:        ", d.airdropFactory);

        // 5. The rug escrow. Native-ETH principal; ships with openings DISABLED —
        //    enabling is a deliberate per-chain go-live ceremony, not a deploy step.
        LaunchRugEscrow rugEscrow = new LaunchRugEscrow(BaseChainConfig.WETH, deployer);
        d.rugEscrow = address(rugEscrow);
        console.log("5. LaunchRugEscrow:       ", d.rugEscrow);

        // 6. The read-only lock view, last — it takes the two fresh rail addresses.
        LaunchLockView lockView = new LaunchLockView(d.vestingFactory, d.lockVault);
        d.lockView = address(lockView);
        console.log("6. LaunchLockView:        ", d.lockView);

        // Guardian wiring BEFORE ownership leaves the deployer (Base-MVP pattern —
        // the mainnet rail wires guardians in a later runbook step, which is
        // exactly the kind of step that gets skipped).
        lockVault.setPauseGuardian(cfg.pauseGuardian);
        vestingFactory.setPauseGuardian(cfg.pauseGuardian);
        airdropFactory.setPauseGuardian(cfg.pauseGuardian);
        console.log("   -> pauseGuardian wired on 3 Pausable rails:", cfg.pauseGuardian);

        // Two-step ownership offers to the Safe.
        launchpad.transferOwnership(cfg.multisig);
        lockVault.transferOwnership(cfg.multisig);
        vestingFactory.transferOwnership(cfg.multisig);
        airdropFactory.transferOwnership(cfg.multisig);
        rugEscrow.transferOwnership(cfg.multisig);
        console.log("   -> ownership offered to multisig on 5 contracts");
    }

    function _assertDeployInvariants(Config memory cfg, Deployed memory d) internal view {
        TegridyLaunchpadV2 lp = TegridyLaunchpadV2(d.launchpad);
        require(lp.weth() == BaseChainConfig.WETH, "LR-INV-1: launchpad WETH != Base WETH9");
        require(lp.sequencerFeed() == cfg.sequencerFeed, "LR-INV-2: launchpad feed != configured feed");
        require(lp.sequencerFeed() != address(0), "LR-INV-3: zero feed would brick every dutch clone");
        require(lp.dropTemplate() != address(0), "LR-INV-4: drop template missing");
        require(lp.protocolFeeBps() == LAUNCHPAD_FEE_BPS, "LR-INV-5: fee != mainnet parity");
        require(lp.protocolFeeRecipient() == cfg.treasury, "LR-INV-6: fee recipient != treasury Safe");

        require(LaunchRugEscrow(payable(d.rugEscrow)).weth() == BaseChainConfig.WETH, "LR-INV-7: escrow WETH != Base WETH9");
        require(!LaunchRugEscrow(payable(d.rugEscrow)).openingsEnabled(), "LR-INV-8: escrow openings must ship disabled");

        require(TegridyLockVault(payable(d.lockVault)).pauseGuardian() == cfg.pauseGuardian, "LR-INV-9a: lockVault guardian");
        require(VestingFactory(payable(d.vestingFactory)).pauseGuardian() == cfg.pauseGuardian, "LR-INV-9b: vestingFactory guardian");
        require(AirdropFactory(payable(d.airdropFactory)).pauseGuardian() == cfg.pauseGuardian, "LR-INV-9c: airdropFactory guardian");
    }

    function _printSummary(Config memory cfg, Deployed memory d) internal pure {
        console.log("");
        console.log("=== BASE LAUNCH RAIL COMPLETE (6 contracts + template) ===");
        console.log("Launchpad:", d.launchpad);
        console.log("LockVault:", d.lockVault);
        console.log("VestingFactory:", d.vestingFactory);
        console.log("AirdropFactory:", d.airdropFactory);
        console.log("RugEscrow:", d.rugEscrow);
        console.log("LockView:", d.lockView);
        console.log("");
        console.log("NEXT STEPS (operator runbook - DO NOT SKIP):");
        console.log("  1. Safe acceptOwnership() x5 (launchpad, lockVault, vestingFactory,");
        console.log("     airdropFactory, rugEscrow) within the 14-day expiry.");
        console.log("  2. rugEscrow openings ship DISABLED. Enabling them on this chain is a");
        console.log("     go-live decision the Safe makes deliberately, after surfaces exist.");
        console.log("  3. Verify launchpad + template + all rails on the explorer.");
        console.log("  4. Register the new addresses in frontend/scripts/addresses.json (per-chain");
        console.log("     section) - the registry is the single source; page constants follow it.");
        console.log("  5. Fee recipient:", cfg.treasury);
    }
}
