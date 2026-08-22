// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyFactory} from "../../src/TegridyFactory.sol";
import {TegridyRouter} from "../../src/TegridyRouter.sol";
import {TegridyTWAP} from "../../src/TegridyTWAP.sol";
import {SwapFeeRouter} from "../../src/SwapFeeRouter.sol";
import {SwapFeeRouterAdmin} from "../../src/SwapFeeRouterAdmin.sol";
import {AttestedSequencerUptimeFeed} from "../../src/AttestedSequencerUptimeFeed.sol";
import {RobinhoodChainConfig} from "./RobinhoodChainConfig.sol";

/// @title  DeployRobinhoodMVP — the Robinhood Chain (4663) leg of the audited
///         mainnet spine.
/// @notice Deploys six contracts. Five are verbatim redeploys of mainnet-audited
///         source — TegridyFactory, TegridyRouter, TegridyTWAP, SwapFeeRouter,
///         SwapFeeRouterAdmin — exactly the Base (8453) set. The sixth exists
///         because of the one way this chain differs from Base:
///
///         CHAINLINK HAS NO SEQUENCER UPTIME FEED HERE. SequencerCheck refuses a
///         zero feed on any chainid != 1, so without a feed the fee-conversion
///         path, the TWAP, and every future dutch-auction drop would revert in
///         production. This script deploys AttestedSequencerUptimeFeed — the
///         guardian-attested, Chainlink-dialect stand-in — FIRST, and constructs
///         every consumer against it. When Chainlink ships a real feed on 4663,
///         the owner Safe calls `forwardTo(feed)` once and the stand-in becomes a
///         permanent passthrough; nothing else redeploys. An operator who already
///         has a real Chainlink feed address may pass it as SEQUENCER_FEED and no
///         stand-in is deployed.
///
/// @dev    Everything DeployBaseMVP.s.sol's header says about what is deliberately
///         absent applies here unchanged, for the same reasons: no staking, no
///         RevenueDistributor, no ReferralSplitter, no POLAccumulator — TOWELI and
///         veTOWELI live on mainnet only. `FeesDistributed` on this chain means
///         "moved into the bridge queue", NOT "paid to stakers".
///
/// @dev    Env vars (first four are Safes; all checked for code):
///           TREASURY        — protocol funds Safe on Robinhood Chain
///           MULTISIG        — Ownable role Safe; disjoint signer set
///           PAUSE_GUARDIAN  — pause-only Safe; also the uptime-feed ATTESTOR
///           FEE_REMITTANCE  — Safe that receives captured fees for bridging
///           SEQUENCER_FEED  — optional: a real Chainlink uptime feed if one exists
///                             by deploy day; leave unset to deploy the attested
///                             stand-in (the expected path today)
///
/// @dev    Run:
///           forge script script/robinhood/DeployRobinhoodMVP.s.sol --rpc-url $ROBINHOOD_RPC --sender $OP -vvv
///         Real run adds `--broadcast` plus a keystore/Ledger signer. Dry-run first
///         and read every printed invariant before broadcasting.
contract DeployRobinhoodMVPScript is Script {
    struct Config {
        address treasury;
        address multisig;
        address pauseGuardian;
        address feeRemittance;
        /// @dev address(0) = deploy the AttestedSequencerUptimeFeed stand-in.
        address sequencerFeed;
    }

    struct Deployed {
        address uptimeFeed;
        bool uptimeFeedIsAttested;
        address factory;
        address router;
        address twap;
        address swapFeeRouter;
        address swapFeeRouterAdmin;
    }

    function run() external {
        Config memory cfg = _loadConfig();
        _validate(cfg);
        _printPlan(cfg);

        vm.startBroadcast();
        Deployed memory d = _deploy(cfg, msg.sender);
        vm.stopBroadcast();

        _assertDeployInvariants(cfg, d);
        _printSummary(cfg, d);
    }

    /// @notice Test entrypoint. Same validation and the same deploy body as `run()`,
    ///         without env reads and without broadcast, so a forge test can drive the
    ///         whole sequence deterministically. Mirrors DeployBaseMVP.runForTest.
    function runForTest(Config memory cfg) external returns (Deployed memory d) {
        _validate(cfg);
        d = _deploy(cfg, address(this));
        _assertDeployInvariants(cfg, d);
    }

    // ─── Config ──────────────────────────────────────────────────────

    function _loadConfig() internal view returns (Config memory cfg) {
        cfg.treasury = vm.envAddress("TREASURY");
        cfg.multisig = vm.envAddress("MULTISIG");
        cfg.pauseGuardian = vm.envAddress("PAUSE_GUARDIAN");
        cfg.feeRemittance = vm.envAddress("FEE_REMITTANCE");
        // Unset means "Chainlink still has no feed here" — the expected state; the
        // stand-in gets deployed. A non-zero value must be a real uptime feed.
        cfg.sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0));
    }

    function _validate(Config memory cfg) internal view {
        RobinhoodChainConfig.requireRobinhoodChain();

        RobinhoodChainConfig.requireSafe(cfg.treasury, "TREASURY");
        RobinhoodChainConfig.requireSafe(cfg.multisig, "MULTISIG");
        RobinhoodChainConfig.requireSafe(cfg.pauseGuardian, "PAUSE_GUARDIAN");
        RobinhoodChainConfig.requireSafe(cfg.feeRemittance, "FEE_REMITTANCE");

        RobinhoodChainConfig.requireDisjoint(cfg.treasury, "TREASURY", cfg.multisig, "MULTISIG");
        RobinhoodChainConfig.requireDisjoint(cfg.treasury, "TREASURY", cfg.pauseGuardian, "PAUSE_GUARDIAN");
        RobinhoodChainConfig.requireDisjoint(cfg.multisig, "MULTISIG", cfg.pauseGuardian, "PAUSE_GUARDIAN");
        RobinhoodChainConfig.requireDisjoint(cfg.feeRemittance, "FEE_REMITTANCE", cfg.treasury, "TREASURY");
        RobinhoodChainConfig.requireDisjoint(cfg.feeRemittance, "FEE_REMITTANCE", cfg.multisig, "MULTISIG");
        RobinhoodChainConfig.requireDisjoint(cfg.feeRemittance, "FEE_REMITTANCE", cfg.pauseGuardian, "PAUSE_GUARDIAN");

        // If the operator claims a real Chainlink feed exists, it must at least be
        // a contract. (The stand-in path needs no check here — it is deployed below
        // and cannot be a typo.)
        if (cfg.sequencerFeed != address(0)) {
            RobinhoodChainConfig.requireHasCode(cfg.sequencerFeed, "SEQUENCER_FEED");
        }
    }

    // ─── Deploy ──────────────────────────────────────────────────────

    function _deploy(Config memory cfg, address deployer) internal returns (Deployed memory d) {
        // 0. The uptime feed, before anything that consumes it. Attestor is the
        //    PAUSE_GUARDIAN Safe — "notice an incident and act" is already its job.
        //    Ownership (attestor rotation + the one-shot forwardTo) is offered to
        //    the MULTISIG Safe two-step, like every other owned contract here.
        if (cfg.sequencerFeed == address(0)) {
            AttestedSequencerUptimeFeed feed = new AttestedSequencerUptimeFeed(cfg.pauseGuardian);
            feed.transferOwnership(cfg.multisig);
            d.uptimeFeed = address(feed);
            d.uptimeFeedIsAttested = true;
            console.log("0. AttestedSequencerUptimeFeed:", d.uptimeFeed);
            console.log("   attestor (PAUSE_GUARDIAN):  ", cfg.pauseGuardian);
        } else {
            d.uptimeFeed = cfg.sequencerFeed;
            d.uptimeFeedIsAttested = false;
            console.log("0. Chainlink uptime feed (operator-supplied):", d.uptimeFeed);
        }

        // Factory. Both feeTo and guardian set to their FINAL destinations at
        // construction — no rotation, nothing for F-30-10 to force-cancel, and no
        // window in which the deployer EOA holds pair-disable power. Same as Base.
        TegridyFactory factory = new TegridyFactory(deployer, cfg.feeRemittance, cfg.pauseGuardian);
        d.factory = address(factory);
        console.log("1. TegridyFactory:        ", d.factory);

        TegridyRouter router = new TegridyRouter(d.factory, RobinhoodChainConfig.WETH);
        d.router = address(router);
        console.log("2. TegridyRouter:         ", d.router);

        // No pair is created here — same reasoning as Base: creating a pair would
        // be this script picking a listing.
        TegridyTWAP twap = new TegridyTWAP(d.factory, d.uptimeFeed);
        d.twap = address(twap);
        console.log("3. TegridyTWAP:           ", d.twap);

        // referralSplitter = address(0), revenueDistributor = FEE_REMITTANCE:
        // read DeployBaseMVP.s.sol's header for why, then read it twice.
        SwapFeeRouter sfr = new SwapFeeRouter(
            d.router,
            cfg.treasury,
            RobinhoodChainConfig.SWAP_FEE_BPS,
            address(0),
            cfg.feeRemittance
        );
        d.swapFeeRouter = address(sfr);
        console.log("4. SwapFeeRouter:         ", d.swapFeeRouter);

        // AUDIT H-13: the one wire whose omission is invisible until the first
        // conversion — and on this chain it would not be silent staleness but a
        // hard SequencerFeedNotConfigured revert.
        sfr.setSequencerFeed(d.uptimeFeed);
        console.log("   -> swapFeeRouter.setSequencerFeed:", d.uptimeFeed);

        SwapFeeRouterAdmin sfrAdmin = new SwapFeeRouterAdmin(d.swapFeeRouter);
        d.swapFeeRouterAdmin = address(sfrAdmin);
        sfr.setSwapFeeRouterAdmin(d.swapFeeRouterAdmin);
        console.log("5. SwapFeeRouterAdmin:    ", d.swapFeeRouterAdmin);

        sfr.setPauseGuardian(cfg.pauseGuardian);
        console.log("   -> swapFeeRouter.pauseGuardian:", cfg.pauseGuardian);

        // Two-step ownership out to the Safe; OwnableNoRenounce expires unaccepted
        // offers after 14 days.
        twap.transferOwnership(cfg.multisig);
        sfr.transferOwnership(cfg.multisig);
        sfrAdmin.transferOwnership(cfg.multisig);
        factory.proposeFeeToSetter(cfg.multisig);
        console.log("   -> ownership offered to multisig on 3 contracts + factory setter");
        if (d.uptimeFeedIsAttested) {
            console.log("   -> uptime-feed ownership offered to multisig (accept it too)");
        }
    }

    // ─── Deploy-time invariants ──────────────────────────────────────

    /// @dev Read back what was just written, on the chain it was written to.
    ///      Failing here aborts the broadcast instead of leaving a half-wired
    ///      deployment for someone to discover later.
    function _assertDeployInvariants(Config memory cfg, Deployed memory d) internal view {
        require(TegridyRouter(payable(d.router)).WETH() == RobinhoodChainConfig.WETH, "R-DINV-1: router WETH != Robinhood WETH");
        require(TegridyRouter(payable(d.router)).factory() == d.factory, "R-DINV-2: router factory mismatch");
        require(address(TegridyTWAP(payable(d.twap)).factory()) == d.factory, "R-DINV-3: twap factory mismatch");
        require(TegridyTWAP(payable(d.twap)).sequencerFeed() == d.uptimeFeed, "R-DINV-4: twap sequencerFeed != uptime feed");

        SwapFeeRouter sfr = SwapFeeRouter(payable(d.swapFeeRouter));
        require(sfr.WETH() == RobinhoodChainConfig.WETH, "R-DINV-5: swapFeeRouter WETH != Robinhood WETH");
        require(sfr.sequencerFeed() == d.uptimeFeed, "R-DINV-6: swapFeeRouter sequencerFeed unset (H-13)");
        require(sfr.revenueDistributor() == cfg.feeRemittance, "R-DINV-7: swapFeeRouter sink != FEE_REMITTANCE");
        require(address(sfr.referralSplitter()) == address(0), "R-DINV-8: referral splitter wired on a chain with no veTOWELI");
        require(sfr.polAccumulator() == address(0), "R-DINV-9: POL accumulator wired on a chain with no TOWELI pair");
        require(sfr.feeBps() == RobinhoodChainConfig.SWAP_FEE_BPS, "R-DINV-10: feeBps != mainnet parity");
        require(sfr.swapFeeRouterAdmin() == d.swapFeeRouterAdmin, "R-DINV-11: swapFeeRouterAdmin unwired");
        require(sfr.pauseGuardian() == cfg.pauseGuardian, "R-DINV-12: swapFeeRouter pauseGuardian unwired");

        require(TegridyFactory(d.factory).feeTo() == cfg.feeRemittance, "R-DINV-13: factory feeTo != FEE_REMITTANCE");
        require(TegridyFactory(d.factory).guardian() == cfg.pauseGuardian, "R-DINV-14: factory guardian != PAUSE_GUARDIAN");

        // The chain-specific ones: the feed exists, and if it is ours, it is wired
        // to the right roles and reports "up" from deploy.
        require(d.uptimeFeed.code.length > 0, "R-DINV-15: uptime feed has no code");
        if (d.uptimeFeedIsAttested) {
            AttestedSequencerUptimeFeed feed = AttestedSequencerUptimeFeed(d.uptimeFeed);
            require(feed.attestor() == cfg.pauseGuardian, "R-DINV-16: feed attestor != PAUSE_GUARDIAN");
            require(feed.chainlinkFeed() == address(0), "R-DINV-17: feed already forwarded at deploy?!");
            (, int256 answer,,,) = feed.latestRoundData();
            require(answer == 0, "R-DINV-18: feed not reporting up at deploy");
        }
    }

    // ─── Output ──────────────────────────────────────────────────────

    function _printPlan(Config memory cfg) internal view {
        console.log("=== DeployRobinhoodMVP (chain 4663) ===");
        console.log("Chain ID:        ", block.chainid);
        console.log("Treasury:        ", cfg.treasury);
        console.log("Multisig:        ", cfg.multisig);
        console.log("Pause Guardian:  ", cfg.pauseGuardian);
        console.log("Fee remittance:  ", cfg.feeRemittance);
        if (cfg.sequencerFeed == address(0)) {
            console.log("Sequencer feed:   attested stand-in WILL BE DEPLOYED (no Chainlink on 4663)");
        } else {
            console.log("Sequencer feed:  ", cfg.sequencerFeed);
        }
        console.log("WETH (Robinhood):", RobinhoodChainConfig.WETH);
        console.log("");
    }

    function _printSummary(Config memory cfg, Deployed memory d) internal pure {
        console.log("");
        console.log("=== ROBINHOOD DEPLOYMENT COMPLETE (6 contracts) ===");
        console.log("0. UptimeFeed:            ", d.uptimeFeed);
        console.log("1. TegridyFactory:        ", d.factory);
        console.log("2. TegridyRouter:         ", d.router);
        console.log("3. TegridyTWAP:           ", d.twap);
        console.log("4. SwapFeeRouter:         ", d.swapFeeRouter);
        console.log("5. SwapFeeRouterAdmin:    ", d.swapFeeRouterAdmin);
        console.log("");
        console.log("NOT DEPLOYED ON THIS CHAIN, BY DESIGN (same policy as Base):");
        console.log("  Staking / JbacVault / StakingAdmin / URIReader / MonitorView (TOWELI is mainnet-only)");
        console.log("  RevenueDistributor (needs veTOWELI)  ReferralSplitter (needs veTOWELI)  POLAccumulator (needs the TOWELI pair)");
        console.log("");
        console.log("THE UPTIME FEED IS ATTESTED, NOT OBSERVED - READ THIS:");
        console.log("  The PAUSE_GUARDIAN Safe is the attestor. During a real sequencer outage it");
        console.log("  MUST setStatus(true), and setStatus(false) on resume - that flip is what");
        console.log("  arms consumers' post-resume grace windows. Add it to the incident runbook");
        console.log("  NOW. The day Chainlink ships a 4663 uptime feed, the multisig calls");
        console.log("  forwardTo(feed) once and the attestation surface is gone forever.");
        console.log("");
        console.log("NEXT STEPS (operator runbook - DO NOT SKIP):");
        console.log("  1. Safe acceptOwnership() on TWAP / SwapFeeRouter / SwapFeeRouterAdmin");
        console.log("     AND the uptime feed (4 accepts), within the 14-day expiry.");
        console.log("  2. After 24h (7-day validity): factory.acceptFeeToSetter() from the Safe.");
        console.log("     No guardian rotation follows - the guardian was set at construction.");
        console.log("  3. Run script/CheckCanonicalWETH.s.sol against router + swapFeeRouter.");
        console.log("  4. Run script/robinhood/VerifyRobinhoodMVP.s.sol - every invariant green");
        console.log("     before any surface points here.");
        console.log("  5. Publish the bridge cadence BEFORE the first fee lands, not after.");
        console.log("  6. Fee sink:", cfg.feeRemittance);
        console.log("     FeesDistributed here means 'queued for the bridge', not 'paid to stakers'.");
    }
}
