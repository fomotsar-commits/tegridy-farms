// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyLaunchpadV2} from "../../src/TegridyLaunchpadV2.sol";
import {TegridyLockVault} from "../../src/TegridyLockVault.sol";
import {VestingFactory} from "../../src/VestingFactory.sol";
import {AirdropFactory} from "../../src/AirdropFactory.sol";
import {LaunchRugEscrow} from "../../src/LaunchRugEscrow.sol";
import {LaunchLockView} from "../../src/LaunchLockView.sol";
import {RobinhoodChainConfig} from "./RobinhoodChainConfig.sol";

/// @title  DeployRobinhoodLaunchRail — the Robinhood Chain (4663) leg of the
///         own-launchpad rail. Mirrors script/base/DeployBaseLaunchRail.s.sol;
///         read that header first — everything it says applies here.
///
/// @dev    THE ONE DIFFERENCE: there is no Chainlink sequencer uptime feed on
///         this chain, so SEQUENCER_FEED is REQUIRED (no default) and must be the
///         AttestedSequencerUptimeFeed that DeployRobinhoodMVP deployed — run that
///         leg FIRST. The feed is baked immutably into the launchpad and every
///         TegridyDropV2 clone; pointing it at a typo or an EOA bricks every
///         dutch-auction mint this chain will ever host. The script refuses
///         anything without code, and the invariants read the feed back through
///         the launchpad after construction.
///
/// @dev    Env vars:
///           TREASURY, MULTISIG, PAUSE_GUARDIAN — Safes, as in the MVP leg
///           SEQUENCER_FEED — REQUIRED: the deployed uptime feed (see above)
///
/// @dev    Run (after DeployRobinhoodMVP):
///           forge script script/robinhood/DeployRobinhoodLaunchRail.s.sol --rpc-url $ROBINHOOD_RPC --sender $OP -vvv
contract DeployRobinhoodLaunchRailScript is Script {
    /// @notice Same 5% as the mainnet launchpad — same economics or none.
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
        // REQUIRED, deliberately: there is no canonical default to fall back to on
        // this chain, and a silent zero would compile into a bricked rail.
        cfg.sequencerFeed = vm.envAddress("SEQUENCER_FEED");
    }

    function _validate(Config memory cfg) internal view {
        RobinhoodChainConfig.requireRobinhoodChain();

        RobinhoodChainConfig.requireSafe(cfg.treasury, "TREASURY");
        RobinhoodChainConfig.requireSafe(cfg.multisig, "MULTISIG");
        RobinhoodChainConfig.requireSafe(cfg.pauseGuardian, "PAUSE_GUARDIAN");
        RobinhoodChainConfig.requireDisjoint(cfg.treasury, "TREASURY", cfg.multisig, "MULTISIG");
        RobinhoodChainConfig.requireDisjoint(cfg.treasury, "TREASURY", cfg.pauseGuardian, "PAUSE_GUARDIAN");
        RobinhoodChainConfig.requireDisjoint(cfg.multisig, "MULTISIG", cfg.pauseGuardian, "PAUSE_GUARDIAN");

        RobinhoodChainConfig.requireUptimeDialect(cfg.sequencerFeed, "SEQUENCER_FEED");
    }

    function _deploy(Config memory cfg, address deployer) internal returns (Deployed memory d) {
        TegridyLaunchpadV2 launchpad = new TegridyLaunchpadV2(
            deployer,
            LAUNCHPAD_FEE_BPS,
            cfg.treasury,
            RobinhoodChainConfig.WETH,
            cfg.sequencerFeed
        );
        d.launchpad = address(launchpad);
        d.dropTemplate = launchpad.dropTemplate();
        console.log("1. TegridyLaunchpadV2:    ", d.launchpad);
        console.log("   dropTemplate:          ", d.dropTemplate);

        TegridyLockVault lockVault = new TegridyLockVault(deployer);
        d.lockVault = address(lockVault);
        console.log("2. TegridyLockVault:      ", d.lockVault);

        VestingFactory vestingFactory = new VestingFactory(deployer);
        d.vestingFactory = address(vestingFactory);
        console.log("3. VestingFactory:        ", d.vestingFactory);

        AirdropFactory airdropFactory = new AirdropFactory(deployer);
        d.airdropFactory = address(airdropFactory);
        console.log("4. AirdropFactory:        ", d.airdropFactory);

        LaunchRugEscrow rugEscrow = new LaunchRugEscrow(RobinhoodChainConfig.WETH, deployer);
        d.rugEscrow = address(rugEscrow);
        console.log("5. LaunchRugEscrow:       ", d.rugEscrow);

        LaunchLockView lockView = new LaunchLockView(d.vestingFactory, d.lockVault);
        d.lockView = address(lockView);
        console.log("6. LaunchLockView:        ", d.lockView);

        lockVault.setPauseGuardian(cfg.pauseGuardian);
        vestingFactory.setPauseGuardian(cfg.pauseGuardian);
        airdropFactory.setPauseGuardian(cfg.pauseGuardian);
        console.log("   -> pauseGuardian wired on 3 Pausable rails:", cfg.pauseGuardian);

        launchpad.transferOwnership(cfg.multisig);
        lockVault.transferOwnership(cfg.multisig);
        vestingFactory.transferOwnership(cfg.multisig);
        airdropFactory.transferOwnership(cfg.multisig);
        rugEscrow.transferOwnership(cfg.multisig);
        console.log("   -> ownership offered to multisig on 5 contracts");
    }

    function _assertDeployInvariants(Config memory cfg, Deployed memory d) internal view {
        TegridyLaunchpadV2 lp = TegridyLaunchpadV2(d.launchpad);
        require(lp.weth() == RobinhoodChainConfig.WETH, "LR-INV-1: launchpad WETH != Robinhood WETH");
        require(lp.sequencerFeed() == cfg.sequencerFeed, "LR-INV-2: launchpad feed != configured feed");
        require(lp.sequencerFeed() != address(0), "LR-INV-3: zero feed would brick every dutch clone");
        require(lp.dropTemplate() != address(0), "LR-INV-4: drop template missing");
        require(lp.protocolFeeBps() == LAUNCHPAD_FEE_BPS, "LR-INV-5: fee != mainnet parity");
        require(lp.protocolFeeRecipient() == cfg.treasury, "LR-INV-6: fee recipient != treasury Safe");

        require(LaunchRugEscrow(payable(d.rugEscrow)).weth() == RobinhoodChainConfig.WETH, "LR-INV-7: escrow WETH != Robinhood WETH");
        require(!LaunchRugEscrow(payable(d.rugEscrow)).openingsEnabled(), "LR-INV-8: escrow openings must ship disabled");

        require(TegridyLockVault(payable(d.lockVault)).pauseGuardian() == cfg.pauseGuardian, "LR-INV-9a: lockVault guardian");
        require(VestingFactory(payable(d.vestingFactory)).pauseGuardian() == cfg.pauseGuardian, "LR-INV-9b: vestingFactory guardian");
        require(AirdropFactory(payable(d.airdropFactory)).pauseGuardian() == cfg.pauseGuardian, "LR-INV-9c: airdropFactory guardian");
    }

    function _printSummary(Config memory cfg, Deployed memory d) internal pure {
        console.log("");
        console.log("=== ROBINHOOD LAUNCH RAIL COMPLETE (6 contracts + template) ===");
        console.log("Launchpad:", d.launchpad);
        console.log("LockVault:", d.lockVault);
        console.log("VestingFactory:", d.vestingFactory);
        console.log("AirdropFactory:", d.airdropFactory);
        console.log("RugEscrow:", d.rugEscrow);
        console.log("LockView:", d.lockView);
        console.log("");
        console.log("REMEMBER WHAT THE FEED IS ON THIS CHAIN: attested, not observed. Every");
        console.log("dutch-auction clone this launchpad ever creates gates its mints on");
        console.log("the AttestedSequencerUptimeFeed at:", cfg.sequencerFeed);
        console.log("The PAUSE_GUARDIAN Safe must flip it during real outages (see the");
        console.log("DeployRobinhoodMVP runbook), or dutch mints will trade at stale prices");
        console.log("after a resume exactly as if there were no gate at all.");
        console.log("");
        console.log("NEXT STEPS (operator runbook - DO NOT SKIP):");
        console.log("  1. Safe acceptOwnership() x5 within the 14-day expiry.");
        console.log("  2. rugEscrow openings ship DISABLED - enabling is a deliberate go-live step.");
        console.log("  3. Verify all contracts + template on the Blockscout explorer.");
        console.log("  4. Register the new addresses in frontend/scripts/addresses.json (per-chain).");
        console.log("  5. Fee recipient:", cfg.treasury);
    }
}
