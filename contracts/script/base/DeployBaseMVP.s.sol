// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyFactory} from "../../src/TegridyFactory.sol";
import {TegridyRouter} from "../../src/TegridyRouter.sol";
import {TegridyTWAP} from "../../src/TegridyTWAP.sol";
import {SwapFeeRouter} from "../../src/SwapFeeRouter.sol";
import {SwapFeeRouterAdmin} from "../../src/SwapFeeRouterAdmin.sol";
import {BaseChainConfig} from "./BaseChainConfig.sol";

/// @title  DeployBaseMVP — the Base (8453) leg of the audited mainnet spine.
/// @notice Deploys five contracts, all verbatim redeploys of mainnet-audited
///         source: TegridyFactory, TegridyRouter, TegridyTWAP, SwapFeeRouter,
///         SwapFeeRouterAdmin. Nothing here is new Solidity.
///
/// @dev    WHAT IS DELIBERATELY ABSENT, AND WHY IT IS NOT AN OVERSIGHT.
///
///         The mainnet MVP set is fifteen contracts. Nine of them cannot exist on
///         Base without breaking a standing rule, so they are not deployed and no
///         script here pretends otherwise:
///
///           TegridyStaking / JbacVault / StakingAdmin / TokenURIReader /
///           StakingMonitorView — all take TOWELI, and TOWELI is fixed-supply and
///           lives on mainnet. A Base "TOWELI" would be a second supply.
///
///           RevenueDistributor — its constructor takes a votingEscrow and its whole
///           job is paying veTOWELI holders pro rata. There is no veTOWELI on Base,
///           so there is nothing on this chain for it to read or to pay.
///
///           ReferralSplitter — constructor requires a non-zero staking contract and
///           reads `votingPowerOf` from it to tier referral rates. Wiring it to an
///           address that is not a staking contract would make every read fall into
///           the catch arm and every referrer silently base-tier. SwapFeeRouter takes
///           `address(0)` for the splitter, which is the honest configuration: this
///           chain has no referral program, rather than a broken one.
///
///           POLAccumulator — buys TOWELI/WETH LP. No TOWELI, no pair, no POL.
///
///         So Base captures fees and remits them; it does not distribute them.
///
/// @dev    THE REMITTANCE SAFE IS NOT A REVENUE DISTRIBUTOR.
///
///         `SwapFeeRouter.revenueDistributor` is a non-zero constructor invariant and
///         the destination is only ever sent plain ETH under a 50k stipend, so a Safe
///         satisfies it. On Base that slot holds FEE_REMITTANCE: a Safe whose only
///         purpose is to hold captured fees until the operator bridges them to the
///         mainnet RevenueDistributor on the published cadence.
///
///         The consequence, which every surface reading this chain must respect:
///         `FeesDistributed(revenueDistributor, amount)` emitted on Base means "moved
///         into the bridge queue", NOT "paid to stakers". A frontend or indexer that
///         sums this event across chains and calls the total staker yield is
///         publishing a number that has not happened yet.
///
/// @dev    Env vars (all four are Safes; all four are checked for code):
///           TREASURY        — protocol funds Safe on Base
///           MULTISIG        — Ownable role Safe on Base; disjoint signer set
///           PAUSE_GUARDIAN  — pause-only Safe on Base; disjoint from both above
///           FEE_REMITTANCE  — Safe that receives captured fees for bridging;
///                             disjoint from all three so the bridge cadence can be
///                             reconciled against a balance nothing else touches
///           SEQUENCER_FEED  — optional override; defaults to the canonical Base feed
///
/// @dev    Run:
///           forge script script/base/DeployBaseMVP.s.sol --rpc-url $BASE_RPC --sender $OP -vvv
///         Real run adds `--broadcast` plus a keystore/Ledger signer. Dry-run first
///         and read every printed invariant before broadcasting.
contract DeployBaseMVPScript is Script {
    struct Config {
        address treasury;
        address multisig;
        address pauseGuardian;
        address feeRemittance;
        address sequencerFeed;
    }

    struct Deployed {
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
    ///         whole sequence deterministically.
    /// @dev    The script contract is the creator here, which is why it also passes
    ///         itself as `deployer`: the factory's feeToSetter and guardian must be an
    ///         address that can still make the wiring calls that follow. Under a real
    ///         broadcast that address is the operator EOA. `run()` remains the only
    ///         path that moves anything on a live chain.
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
        // Defaulted rather than required so the canonical feed is what ships unless
        // an operator consciously overrides it; the validation below refuses a zero
        // either way, so the override cannot be used to disable the gate.
        cfg.sequencerFeed = vm.envOr("SEQUENCER_FEED", BaseChainConfig.SEQUENCER_UPTIME_FEED);
    }

    function _validate(Config memory cfg) internal view {
        BaseChainConfig.requireBaseChain();

        BaseChainConfig.requireSafe(cfg.treasury, "TREASURY");
        BaseChainConfig.requireSafe(cfg.multisig, "MULTISIG");
        BaseChainConfig.requireSafe(cfg.pauseGuardian, "PAUSE_GUARDIAN");
        BaseChainConfig.requireSafe(cfg.feeRemittance, "FEE_REMITTANCE");

        // Ronin lost $625M to a signer set that was not disjoint. The mainnet script
        // enforces the first three pairs; FEE_REMITTANCE joins them because a sink
        // that shares an address with the owner or the guardian turns one key
        // compromise into both control and custody.
        BaseChainConfig.requireDisjoint(cfg.treasury, "TREASURY", cfg.multisig, "MULTISIG");
        BaseChainConfig.requireDisjoint(cfg.treasury, "TREASURY", cfg.pauseGuardian, "PAUSE_GUARDIAN");
        BaseChainConfig.requireDisjoint(cfg.multisig, "MULTISIG", cfg.pauseGuardian, "PAUSE_GUARDIAN");
        // Also disjoint from TREASURY: the remitted balance is what the published
        // bridge cadence is reconciled against, and a balance the treasury also spends
        // from cannot be reconciled at all.
        BaseChainConfig.requireDisjoint(cfg.feeRemittance, "FEE_REMITTANCE", cfg.treasury, "TREASURY");
        BaseChainConfig.requireDisjoint(cfg.feeRemittance, "FEE_REMITTANCE", cfg.multisig, "MULTISIG");
        BaseChainConfig.requireDisjoint(cfg.feeRemittance, "FEE_REMITTANCE", cfg.pauseGuardian, "PAUSE_GUARDIAN");

        // A feed with no code — or with code but the wrong round dialect — passes
        // every constructor and then reverts every gated read once real money is
        // flowing. Probe the dialect while it is still a typo.
        BaseChainConfig.requireUptimeDialect(cfg.sequencerFeed, "SEQUENCER_FEED");
    }

    // ─── Deploy ──────────────────────────────────────────────────────

    function _deploy(Config memory cfg, address deployer) internal returns (Deployed memory d) {
        // Factory. Both feeTo and guardian are set to their FINAL destinations at
        // construction rather than proposed afterwards.
        //
        // feeTo: on mainnet it has to migrate from treasury to the RevenueDistributor
        // through a 48h timelock, and audit H-17 records what happens when that manual
        // acceptance is forgotten. Base has no such migration.
        //
        // guardian: mainnet constructs with the deployer EOA and queues
        // `proposeGuardianChange` at deploy (audit M6), which the Safe is then meant to
        // execute after it accepts feeToSetter. That ORDER CANNOT WORK. Audit F-30-10
        // made `acceptFeeToSetter` force-cancel any pending GUARDIAN_CHANGE queued by
        // the outgoing setter, so the Safe's acceptance destroys the very proposal the
        // next step tries to execute; reaching a Safe guardian requires the Safe to
        // propose it again itself and wait another 48h. Constructing with the guardian
        // Safe removes the whole sequence: there is no window in which the deployer EOA
        // holds the factory's pair-disable power, and no queued proposal to lose.
        TegridyFactory factory = new TegridyFactory(deployer, cfg.feeRemittance, cfg.pauseGuardian);
        d.factory = address(factory);
        console.log("1. TegridyFactory:        ", d.factory);

        TegridyRouter router = new TegridyRouter(d.factory, BaseChainConfig.WETH);
        d.router = address(router);
        console.log("2. TegridyRouter:         ", d.router);

        // No pair is created here. The mainnet script creates TOWELI/WETH at deploy;
        // TOWELI does not exist on this chain and creating some other pair would be
        // this script picking a listing.
        TegridyTWAP twap = new TegridyTWAP(d.factory, cfg.sequencerFeed);
        d.twap = address(twap);
        console.log("3. TegridyTWAP:           ", d.twap);

        // referralSplitter = address(0): see the header. revenueDistributor =
        // FEE_REMITTANCE: also see the header, and read it twice.
        SwapFeeRouter sfr = new SwapFeeRouter(
            d.router,
            cfg.treasury,
            BaseChainConfig.SWAP_FEE_BPS,
            address(0),
            cfg.feeRemittance
        );
        d.swapFeeRouter = address(sfr);
        console.log("4. SwapFeeRouter:         ", d.swapFeeRouter);

        // AUDIT H-13: the sequencer feed is a one-shot post-construction setter and is
        // the single wire whose omission is invisible until the first conversion.
        sfr.setSequencerFeed(cfg.sequencerFeed);
        console.log("   -> swapFeeRouter.setSequencerFeed:", cfg.sequencerFeed);

        SwapFeeRouterAdmin sfrAdmin = new SwapFeeRouterAdmin(d.swapFeeRouter);
        d.swapFeeRouterAdmin = address(sfrAdmin);
        sfr.setSwapFeeRouterAdmin(d.swapFeeRouterAdmin);
        console.log("5. SwapFeeRouterAdmin:    ", d.swapFeeRouterAdmin);

        // Guardian wiring before ownership leaves the deployer, exactly as mainnet.
        sfr.setPauseGuardian(cfg.pauseGuardian);
        console.log("   -> swapFeeRouter.pauseGuardian:", cfg.pauseGuardian);

        // Two-step ownership out to the Safe. Nothing is owned by the Safe until it
        // accepts, and OwnableNoRenounce expires the offer after 14 days.
        twap.transferOwnership(cfg.multisig);
        sfr.transferOwnership(cfg.multisig);
        sfrAdmin.transferOwnership(cfg.multisig);
        factory.proposeFeeToSetter(cfg.multisig);
        console.log("   -> ownership offered to multisig on 3 contracts + factory setter");
    }

    // ─── Deploy-time invariants ──────────────────────────────────────

    /// @dev Read back what was just written, on the chain it was written to. These
    ///      are the same facts VerifyBaseMVP re-checks after the Safe has accepted;
    ///      failing here aborts the broadcast instead of leaving a half-wired
    ///      deployment for someone to discover later.
    function _assertDeployInvariants(Config memory cfg, Deployed memory d) internal view {
        require(TegridyRouter(payable(d.router)).WETH() == BaseChainConfig.WETH, "D-INV-1: router WETH != Base WETH9");
        require(TegridyRouter(payable(d.router)).factory() == d.factory, "D-INV-2: router factory mismatch");
        require(address(TegridyTWAP(payable(d.twap)).factory()) == d.factory, "D-INV-3: twap factory mismatch");
        require(TegridyTWAP(payable(d.twap)).sequencerFeed() == cfg.sequencerFeed, "D-INV-4: twap sequencerFeed unset");

        SwapFeeRouter sfr = SwapFeeRouter(payable(d.swapFeeRouter));
        require(sfr.WETH() == BaseChainConfig.WETH, "D-INV-5: swapFeeRouter WETH != Base WETH9");
        require(sfr.sequencerFeed() == cfg.sequencerFeed, "D-INV-6: swapFeeRouter sequencerFeed unset (H-13)");
        require(sfr.revenueDistributor() == cfg.feeRemittance, "D-INV-7: swapFeeRouter sink != FEE_REMITTANCE");
        require(address(sfr.referralSplitter()) == address(0), "D-INV-8: referral splitter wired on a chain with no veTOWELI");
        require(sfr.polAccumulator() == address(0), "D-INV-9: POL accumulator wired on a chain with no TOWELI pair");
        require(sfr.feeBps() == BaseChainConfig.SWAP_FEE_BPS, "D-INV-10: feeBps != mainnet parity");
        require(sfr.swapFeeRouterAdmin() == d.swapFeeRouterAdmin, "D-INV-11: swapFeeRouterAdmin unwired");
        require(sfr.pauseGuardian() == cfg.pauseGuardian, "D-INV-12: swapFeeRouter pauseGuardian unwired");

        require(TegridyFactory(d.factory).feeTo() == cfg.feeRemittance, "D-INV-13: factory feeTo != FEE_REMITTANCE");
        // Constructed, not rotated — so this is already final and no 48h proposal is
        // outstanding for the Safe's acceptFeeToSetter to force-cancel (F-30-10).
        require(TegridyFactory(d.factory).guardian() == cfg.pauseGuardian, "D-INV-14: factory guardian != PAUSE_GUARDIAN");
    }

    // ─── Output ──────────────────────────────────────────────────────

    function _printPlan(Config memory cfg) internal view {
        console.log("=== DeployBaseMVP (chain 8453) ===");
        console.log("Chain ID:        ", block.chainid);
        console.log("Treasury:        ", cfg.treasury);
        console.log("Multisig:        ", cfg.multisig);
        console.log("Pause Guardian:  ", cfg.pauseGuardian);
        console.log("Fee remittance:  ", cfg.feeRemittance);
        console.log("Sequencer feed:  ", cfg.sequencerFeed);
        console.log("WETH (Base):     ", BaseChainConfig.WETH);
        console.log("");
    }

    function _printSummary(Config memory cfg, Deployed memory d) internal pure {
        console.log("");
        console.log("=== BASE DEPLOYMENT COMPLETE (5 contracts) ===");
        console.log("1. TegridyFactory:        ", d.factory);
        console.log("2. TegridyRouter:         ", d.router);
        console.log("3. TegridyTWAP:           ", d.twap);
        console.log("4. SwapFeeRouter:         ", d.swapFeeRouter);
        console.log("5. SwapFeeRouterAdmin:    ", d.swapFeeRouterAdmin);
        console.log("");
        console.log("NOT DEPLOYED ON THIS CHAIN, BY DESIGN:");
        console.log("  Staking / JbacVault / StakingAdmin / URIReader / MonitorView (TOWELI is mainnet-only)");
        console.log("  RevenueDistributor (needs veTOWELI)  ReferralSplitter (needs veTOWELI)  POLAccumulator (needs the TOWELI pair)");
        console.log("");
        console.log("READ THIS BEFORE WIRING ANY SURFACE:");
        console.log("  swapFeeRouter.revenueDistributor is a REMITTANCE SAFE:", cfg.feeRemittance);
        console.log("  FeesDistributed on Base means 'queued for the bridge', not 'paid to stakers'.");
        console.log("  Base fees become staker yield only when a bridge cycle lands at the mainnet distributor.");
        console.log("");
        console.log("NEXT STEPS (operator runbook - DO NOT SKIP):");
        console.log("  1. Safe acceptOwnership() on TWAP / SwapFeeRouter / SwapFeeRouterAdmin");
        console.log("     within the OwnableNoRenounce 14-day expiry.");
        console.log("  2. After 48h: factory.acceptFeeToSetter() from the Safe.");
        console.log("     No guardian rotation follows - the guardian was set at construction.");
        console.log("  3. Run script/CheckCanonicalWETH.s.sol against router + swapFeeRouter.");
        console.log("  4. Run script/base/VerifyBaseMVP.s.sol - every invariant green before any surface points here.");
        console.log("  5. Publish the bridge cadence BEFORE the first fee lands, not after.");
    }
}
