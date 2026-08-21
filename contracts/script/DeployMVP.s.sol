// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {Toweli} from "../src/Toweli.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {TegridyStakingJbacVault} from "../src/TegridyStakingJbacVault.sol";
import {TegridyStakingAdmin} from "../src/TegridyStakingAdmin.sol";
import {TegridyFactory} from "../src/TegridyFactory.sol";
import {TegridyRouter} from "../src/TegridyRouter.sol";
import {TegridyTWAP} from "../src/TegridyTWAP.sol";
// TegridyRestaking import removed — deferred to Phase 7 (audit 2026-05-24 / C1); not deployed at MVP.
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {ReferralSplitter} from "../src/ReferralSplitter.sol";
import {SwapFeeRouter} from "../src/SwapFeeRouter.sol";
import {SwapFeeRouterAdmin} from "../src/SwapFeeRouterAdmin.sol";
import {POLAccumulator} from "../src/POLAccumulator.sol";
import {TegridyTokenURIReader} from "../src/TegridyTokenURIReader.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";

/// @title  DeployMVP — Canonical MVP-launch deploy script
/// @notice Deploys the 15 MVP contracts that constitute the day-1 economic loop:
///         AMM (Factory / Pair / Router / TWAP), Staking (Staking + JbacVault +
///         Admin + Restaking + URIReader), Revenue (Distributor + ReferralSplitter
///         + SwapFeeRouter + SwapFeeRouterAdmin + POLAccumulator), Token (Toweli).
///         Excludes Lending, NFTLending, Gauges, VoteIncentives, Drop, Launchpad,
///         FeeHook, LPFarming, CommunityGrants, MemeBountyBoard, PremiumAccess —
///         those ship in next-wave audited releases.
///
/// @dev    THREE-MULTISIG REQUIREMENT (battle-plan Phase 0.3): the script
///         requires three DISJOINT addresses via env vars:
///           - TREASURY:        cold 4-of-7 holding all protocol funds.
///           - MULTISIG:        cold 4-of-7 holding Ownable role on every
///                              contract. Different signer set from TREASURY.
///           - PAUSE_GUARDIAN:  hot 3-of-5 holding pause()-only capability
///                              once contracts adopt the guardian role (Phase
///                              0.4 follow-on). Disjoint from both above.
///         If any two are equal, the script reverts. Ronin lost $625M to
///         non-disjoint signer sets — this gate is non-negotiable.
contract DeployMVPScript is Script {
    // ─── Mainnet Constants ───────────────────────────────────────────
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant JBAC_NFT = 0xd37264c71e9af940e49795F0d3a8336afAaFDdA9;

    uint256 constant REWARD_PER_SECOND = 824300000000000000; // ~0.8243 TOWELI/s
    uint256 constant SWAP_FEE_BPS = 50;        // 0.5% protocol fee on swaps
    uint256 constant REFERRAL_FEE_BPS = 2000;  // 20% of protocol fee to referrers

    // mvp-launch Phase 0.7 / Phase 6 launch caps. Raise per Phase 7 schedule
    // after each 2-week clean-monitoring window. Aave V3 supply-cap pattern.
    uint256 constant LAUNCH_MAX_STAKE_PER_USER = 50_000 * 1e18;       //   50k TOWELI
    uint256 constant LAUNCH_MAX_TOTAL_STAKED   = 5_000_000 * 1e18;    //   5M TOWELI

    struct Deployed {
        address staking;
        address jbacVault;
        address stakingAdmin;
        address factory;
        address router;
        address pair;
        address twap;
        address restaking;
        address revenueDistributor;
        address referralSplitter;
        address swapFeeRouter;
        address swapFeeRouterAdmin;
        address polAccumulator;
        address tokenURIReader;
        address monitorView;
    }

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        address treasury       = vm.envAddress("TREASURY");
        address multisig       = vm.envAddress("MULTISIG");
        address pauseGuardian  = vm.envAddress("PAUSE_GUARDIAN");

        require(treasury      != address(0), "TREASURY env var required");
        require(multisig      != address(0), "MULTISIG env var required");
        require(pauseGuardian != address(0), "PAUSE_GUARDIAN env var required");

        // Disjoint check. A single compromise of any one multisig MUST NOT
        // capture another role. Aave Emergency Guardian and Maker GSM both
        // enforce signer-set diversity; we enforce address diversity here.
        require(treasury      != multisig,      "TREASURY == MULTISIG: signer-set must be disjoint");
        require(treasury      != pauseGuardian, "TREASURY == PAUSE_GUARDIAN: signer-set must be disjoint");
        require(multisig      != pauseGuardian, "MULTISIG == PAUSE_GUARDIAN: signer-set must be disjoint");

        // AUDIT FIX M6 (revised): PAUSE_GUARDIAN is now the factory guardian from
        // CONSTRUCTION (see _deployCore) rather than via a post-deploy rotation, so it
        // never passes through `proposeGuardianChange`'s multisig-class check — the
        // constructor only rejects address(0). Re-assert that rule here or the removal
        // of the rotation would silently permit an EOA guardian with instant
        // pair-disable power. codeLen == 23 is the EIP-7702 delegation designator: an
        // EOA wearing a contract's clothes, which the factory rejects by the same rule.
        uint256 guardianCodeLen = pauseGuardian.code.length;
        require(guardianCodeLen != 0,  "PAUSE_GUARDIAN has no code: guardian must be multisig-class");
        require(guardianCodeLen != 23, "PAUSE_GUARDIAN is a 7702-delegated EOA, not a multisig");

        console.log("Treasury:       ", treasury);
        console.log("Multisig:       ", multisig);
        console.log("Pause Guardian: ", pauseGuardian);

        address SEQUENCER_FEED = vm.envOr("SEQUENCER_FEED", address(0));
        require(
            block.chainid == 1 || SEQUENCER_FEED != address(0),
            "L2 deploy requires SEQUENCER_FEED env"
        );

        vm.startBroadcast();
        address deployer = msg.sender;
        console.log("Deployer:       ", deployer);

        Deployed memory d;
        d = _deployCore(d, treasury, deployer, pauseGuardian, SEQUENCER_FEED);
        d = _deployRevenue(d, treasury, SEQUENCER_FEED);
        _wirePauseGuardian(d, pauseGuardian);
        _wireStakeCaps(d);
        _wireAndTransfer(d, multisig);

        vm.stopBroadcast();

        _logSummary(d);
    }

    /// @dev mvp-launch Phase 0.4: wire the pause-only emergency guardian onto
    ///      every Pausable MVP contract BEFORE transferOwnership. After ownership
    ///      transfer, only the multisig can call setPauseGuardian.
    function _wirePauseGuardian(Deployed memory d, address pauseGuardian) internal {
        TegridyStaking(d.staking).setPauseGuardian(pauseGuardian);
        // TegridyRestaking deferred to Phase 7 (see _deployCore) — guardian wired then.
        RevenueDistributor(payable(d.revenueDistributor)).setPauseGuardian(pauseGuardian);
        SwapFeeRouter(payable(d.swapFeeRouter)).setPauseGuardian(pauseGuardian);
        POLAccumulator(payable(d.polAccumulator)).setPauseGuardian(pauseGuardian);
        console.log("    -> pauseGuardian wired on 4 Pausable contracts:", pauseGuardian);

        // The TegridyFactory guardian is NOT wired here. It is set in the constructor
        // (see _deployCore) and is already final by the time this runs — audit M6 is
        // satisfied without a rotation. Do not re-add `proposeGuardianChange` here:
        // audit F-30-10 makes the multisig's own `acceptFeeToSetter` force-cancel it.
    }

    /// @dev mvp-launch Phase 0.7: set launch caps BEFORE transferOwnership.
    ///      Constructor defaults are uncapped (type(uint256).max) so the
    ///      operator sets them DOWN to launch values here. Aave V3 pattern.
    function _wireStakeCaps(Deployed memory d) internal {
        TegridyStaking(d.staking).setMaxStakePerUser(LAUNCH_MAX_STAKE_PER_USER);
        TegridyStaking(d.staking).setMaxTotalStaked(LAUNCH_MAX_TOTAL_STAKED);
        console.log("    -> stake caps set: per-user", LAUNCH_MAX_STAKE_PER_USER);
        console.log("                       global  ", LAUNCH_MAX_TOTAL_STAKED);
    }

    function _deployCore(
        Deployed memory d,
        address treasury,
        address deployer,
        address pauseGuardian,
        address sequencerFeed
    ) internal returns (Deployed memory) {
        // 1. TegridyStaking
        TegridyStaking staking = new TegridyStaking(TOWELI, JBAC_NFT, treasury, REWARD_PER_SECOND);
        d.staking = address(staking);
        console.log(" 1. TegridyStaking:        ", d.staking);

        // 1b. TegridyStakingJbacVault — one-shot wire BEFORE transferOwnership.
        TegridyStakingJbacVault vault = new TegridyStakingJbacVault(JBAC_NFT, d.staking);
        d.jbacVault = address(vault);
        staking.setJbacVault(d.jbacVault);
        console.log(" 1b. TegridyStakingJbacVault:", d.jbacVault);

        // 1c. TegridyStakingAdmin — one-shot wire BEFORE transferOwnership.
        TegridyStakingAdmin stakingAdmin = new TegridyStakingAdmin(d.staking);
        d.stakingAdmin = address(stakingAdmin);
        staking.setStakingAdmin(d.stakingAdmin);
        console.log(" 1c. TegridyStakingAdmin:   ", d.stakingAdmin);

        // 2. TegridyFactory
        // Guardian = PAUSE_GUARDIAN from block one. There is NO post-deploy rotation.
        //
        // This script used to construct with the deployer EOA as guardian and queue
        // `proposeGuardianChange(pauseGuardian)` at deploy (audit M6), leaving the
        // multisig to execute it after accepting feeToSetter. THAT ORDER CANNOT WORK.
        // Audit F-30-10 made `acceptFeeToSetter` force-cancel any pending
        // GUARDIAN_CHANGE queued by the outgoing setter (TegridyFactory.sol:396-401),
        // so the multisig's own acceptance destroys the proposal the next step tries to
        // execute; `executeGuardianChange()` then reverts NoPendingProposal. Reaching a
        // multisig guardian that way needs the NEW setter to propose it again itself and
        // wait a further 48h — a window in which the deployer EOA still holds the
        // factory's instant pair-disable power.
        //
        // The constructor takes `_guardian` directly and only rejects address(0), so
        // passing the Safe here removes the sequence entirely: nothing to queue, nothing
        // to lose, and no EOA-guardian window at all. `run()` re-asserts the
        // multisig-class rule that `proposeGuardianChange` would have enforced.
        // Mirrors script/base/DeployBaseMVP.s.sol, which has always done it this way.
        //
        // feeTo stays `treasury` at construction and migrates to the RevenueDistributor
        // through the 48h timelock in _wireAndTransfer — that rotation is unaffected.
        TegridyFactory factory = new TegridyFactory(deployer, treasury, pauseGuardian);
        d.factory = address(factory);
        console.log(" 2. TegridyFactory:        ", d.factory);

        // 3. TegridyRouter
        TegridyRouter router = new TegridyRouter(d.factory, WETH);
        d.router = address(router);
        console.log(" 3. TegridyRouter:         ", d.router);

        // 4. TOWELI/WETH Pair
        d.pair = factory.createPair(TOWELI, WETH);
        console.log(" 4. TOWELI/WETH Pair:      ", d.pair);

        // 5. TegridyTWAP
        TegridyTWAP twap = new TegridyTWAP(d.factory, sequencerFeed);
        d.twap = address(twap);
        console.log(" 5. TegridyTWAP:           ", d.twap);
        // AUDIT FIX 2026-05-26 [H-18]: TWAP bootstrap is operator-paced (15-min
        // MIN_PERIOD between observations, multi-step). Loud warning so the
        // operator does NOT call POL.accumulate() until ≥4 observations exist
        // (count <= 2 paths are owner-only bootstrap; permissionless consult
        // requires count >= 4 + the 60-min cooldown after the last bypass).
        // Runbook step (NEW): post-LP-seed, call `twap.update{value: MIN_UPDATE_FEE}
        // (pair)` four times spaced ≥15 min apart, THEN wait 60 min before
        // POL.accumulate(). Total wall-clock: ~2h 45m to first POL accumulate.
        console.log(" 5b. WARN [H-18]: bootstrap TWAP via 4x update() >= 15min apart");
        console.log("                  AFTER LP seed; do NOT POL.accumulate until ~2h45m later.");

        // 6. TegridyRestaking — DEFERRED to Phase 7 (audit 2026-05-24 / C1).
        //    Restaking ships PAUSED and does not open until Phase 7.0; nothing in the
        //    MVP requires it deployed (staking.restakingContract / revDist.restaking /
        //    referral.restakingContract are all wired post-deploy via timelock and
        //    tolerate being unset, with try/catch -> 0 reads). Deferring its deployment
        //    keeps it off the MVP EIP-170 critical path AND removes the acceptOwnership
        //    proposal-flush race (H2): no restaking wiring is queued at deploy. Deploy +
        //    wire it in a dedicated Phase-7 script once TegridyRestaking is itself split
        //    under EIP-170.

        // 7. TegridyTokenURIReader
        TegridyTokenURIReader uriReader = new TegridyTokenURIReader(d.staking);
        d.tokenURIReader = address(uriReader);
        console.log(" 7. TegridyTokenURIReader: ", d.tokenURIReader);

        // 7b. StakingMonitorView (EIP-170 sibling — exposes earned + getPosition
        //     off-host so TegridyStaking can stay under 24,576 B). Read-only, no
        //     privileged role, holds no funds. Off-chain consumers (frontends,
        //     indexers) call earned/getPosition on THIS address (ABI is byte-
        //     identical to the removed on-host wrappers).
        StakingMonitorView monitorView = new StakingMonitorView(d.staking);
        d.monitorView = address(monitorView);
        console.log(" 7b. StakingMonitorView:    ", d.monitorView);

        return d;
    }

    function _deployRevenue(
        Deployed memory d,
        address treasury,
        address sequencerFeed
    ) internal returns (Deployed memory) {
        // 8. RevenueDistributor
        RevenueDistributor revDist = new RevenueDistributor(d.staking, treasury, WETH);
        d.revenueDistributor = address(revDist);
        console.log(" 8. RevenueDistributor:    ", d.revenueDistributor);

        // revDist.restaking wiring DEFERRED to Phase 7 with TegridyRestaking (C1).

        // 9. ReferralSplitter
        ReferralSplitter splitter = new ReferralSplitter(REFERRAL_FEE_BPS, d.staking, treasury, WETH);
        d.referralSplitter = address(splitter);
        console.log(" 9. ReferralSplitter:      ", d.referralSplitter);

        // 10. SwapFeeRouter
        // AUDIT FIX 2026-05-26 [DEPLOY-H1]: pass `_revenueDistributor` through the
        // constructor so SFR is wired at genesis. Pre-fix the only post-deploy
        // setter was 48 h-timelocked via SwapFeeRouterAdmin, AND the admin's
        // `acceptOwnership` flushes any pre-queued REV_DIST_CHANGE on handoff —
        // creating a ≥96 h window where `distributeFeesToStakers()` reverts
        // `ZeroAddress()` while `accumulatedETHFees` grows on every swap.
        SwapFeeRouter sfr = new SwapFeeRouter(
            d.router, treasury, SWAP_FEE_BPS, d.referralSplitter, d.revenueDistributor
        );
        d.swapFeeRouter = address(sfr);
        console.log("10. SwapFeeRouter:         ", d.swapFeeRouter);

        // 10b. SwapFeeRouterAdmin — one-shot wire BEFORE transferOwnership.
        SwapFeeRouterAdmin sfrAdmin = new SwapFeeRouterAdmin(d.swapFeeRouter);
        d.swapFeeRouterAdmin = address(sfrAdmin);
        sfr.setSwapFeeRouterAdmin(d.swapFeeRouterAdmin);
        console.log("10b. SwapFeeRouterAdmin:   ", d.swapFeeRouterAdmin);

        // AUDIT FIX 2026-05-26 [H-13]: wire L2 sequencer feed on SwapFeeRouter BEFORE
        // ownership transfer. Pre-fix, the one-shot setter was silently missed (the
        // constructor doesn't take it). Mainnet (chainid == 1) skip is intentional;
        // mainnet sequencerFeed remains address(0) by design.
        if (sequencerFeed != address(0)) {
            sfr.setSequencerFeed(sequencerFeed);
            console.log("10c. swapFeeRouter.setSequencerFeed wired (L2)");
        }

        // Approve SwapFeeRouter on ReferralSplitter, then lock instant setter.
        splitter.setApprovedCaller(d.swapFeeRouter, true);
        splitter.completeSetup();
        console.log("    -> ReferralSplitter approved, setup locked");

        // 11. POLAccumulator
        POLAccumulator pol = new POLAccumulator(TOWELI, d.router, d.pair, treasury, d.twap, sequencerFeed);
        d.polAccumulator = address(pol);
        console.log("11. POLAccumulator:        ", d.polAccumulator);

        return d;
    }

    function _wireAndTransfer(Deployed memory d, address multisig) internal {
        // TegridyRestaking deferred to Phase 7 (see _deployCore) — no restaking
        // deploy / pause / ownership-transfer here.

        // Propose feeTo -> RevenueDistributor (48h timelock).
        TegridyFactory(d.factory).proposeFeeToChange(d.revenueDistributor);
        console.log("    -> Factory.feeTo proposed to RevenueDistributor (48h)");

        // Transfer ownership to multisig on every owned MVP contract.
        TegridyStaking(d.staking).transferOwnership(multisig);
        TegridyStakingAdmin(d.stakingAdmin).transferOwnership(multisig);
        TegridyTWAP(payable(d.twap)).transferOwnership(multisig);
        RevenueDistributor(payable(d.revenueDistributor)).transferOwnership(multisig);
        SwapFeeRouter(payable(d.swapFeeRouter)).transferOwnership(multisig);
        SwapFeeRouterAdmin(d.swapFeeRouterAdmin).transferOwnership(multisig);
        POLAccumulator(payable(d.polAccumulator)).transferOwnership(multisig);
        ReferralSplitter(payable(d.referralSplitter)).transferOwnership(multisig);
        // TegridyFactory owner stays as deployer until guardian rotation completes.
        // TegridyFactory.feeToSetter is the role that needs handoff; propose it now.
        TegridyFactory(d.factory).proposeFeeToSetter(multisig);
        console.log("    -> Factory.feeToSetter proposed to multisig (24h, then a 7-day acceptance window)");

        // AUDIT FIX 2026-05-26 [H-17]: emit a loud reminder that both factory
        // rotations must be finished inside their validity windows. VerifyMVP
        // INV-11 fails loud if either is missed.
        //
        // TWO CALLERS, NOT ONE, AND THE ORDER IS LOAD-BEARING (2026-08-21).
        //
        // `executeFeeToChange()` is `require(msg.sender == feeToSetter)`
        // (TegridyFactory.sol:312). Until the acceptance lands, that is the
        // DEPLOYER, not the multisig -- an earlier version of this printout told
        // the multisig to make a call it can never make: FORBIDDEN before the
        // acceptance, and NoPendingProposal after it.
        //
        // And the delays actively invite the wrong order. FEE_TO_SETTER_DELAY is
        // 24h; FEE_TO_CHANGE_DELAY is 48h. An operator running each step the
        // moment it unlocks accepts the setter role first -- and
        // `acceptFeeToSetter` force-cancels the pending FEE_TO_CHANGE
        // (TegridyFactory.sol:381-386, the C6 fix sitting directly above the
        // F-30-10 guardian block that broke the old guardian rotation the same
        // way). `feeTo` then never reaches the RevenueDistributor, INV-11b fails
        // permanently, and recovery costs a fresh proposal from the multisig plus
        // another 48h. Waiting past 48h to accept is safe: the acceptance window
        // runs 24h -> 24h+7d.
        //
        // There is NO third call. The guardian was set at construction (audit M6,
        // revised); `executeGuardianChange()` is not part of this deploy and would
        // revert NoPendingProposal if anyone tried it.
        console.log("    -> WARN [H-17]: two calls, two different callers, IN THIS ORDER:");
        console.log("                  1) DEPLOYER  factory.executeFeeToChange()  - after 48h");
        console.log("                     (feeToSetter-only; the deployer still holds that role)");
        console.log("                  2) MULTISIG  factory.acceptFeeToSetter()   - AFTER step 1");
        console.log("                     (unlocks at 24h, valid to 24h+7d - do NOT take it early)");
        console.log("                  DANGER: accepting before step 1 force-cancels the pending");
        console.log("                  feeTo change (C6). INV-11b then fails permanently.");
        console.log("                  (both asserted by VerifyMVP INV-11a/11b)");
        console.log("                  NO guardian call - INV-11c is already true at construction.");

        console.log("12. Ownership transfer initiated for 8 owned MVP contracts to:", multisig);
    }

    function _logSummary(Deployed memory d) internal pure {
        console.log("");
        console.log("=== MVP DEPLOYMENT COMPLETE (14 contracts; Restaking deferred to Phase 7) ===");
        console.log("Toweli (token):           ", TOWELI);
        console.log(" 1. TegridyStaking:       ", d.staking);
        console.log(" 1b. JbacVault:           ", d.jbacVault);
        console.log(" 1c. StakingAdmin:        ", d.stakingAdmin);
        console.log(" 2. TegridyFactory:       ", d.factory);
        console.log(" 3. TegridyRouter:        ", d.router);
        console.log(" 4. TOWELI/WETH Pair:     ", d.pair);
        console.log(" 5. TegridyTWAP:          ", d.twap);
        console.log(" 6. TegridyRestaking:      DEFERRED to Phase 7 (C1 / EIP-170)");
        console.log(" 7. TokenURIReader:       ", d.tokenURIReader);
        console.log(" 8. RevenueDistributor:   ", d.revenueDistributor);
        console.log(" 9. ReferralSplitter:     ", d.referralSplitter);
        console.log("10. SwapFeeRouter:        ", d.swapFeeRouter);
        console.log("10b. SwapFeeRouterAdmin:  ", d.swapFeeRouterAdmin);
        console.log("11. POLAccumulator:       ", d.polAccumulator);
        console.log("");
        console.log("NEXT STEPS (operator runbook - DO NOT SKIP):");
        console.log("  1. Multisig acceptOwnership() on all 8 owned contracts");
        console.log("     within OwnableNoRenounce 14-day expiry. Verify each with Verify.s.sol.");
        console.log("  2. After 48h: factory.executeFeeToChange() -- FROM THE DEPLOYER EOA.");
        console.log("     It is feeToSetter-only and the deployer still holds that role.");
        console.log("  3. THEN factory.acceptFeeToSetter() from multisig. It unlocks at 24h, but");
        console.log("     taking it before step 2 force-cancels the pending feeTo change (C6) and");
        console.log("     INV-11b fails permanently. The window runs to 24h+7d, so waiting is free.");
        console.log("     NO guardian step follows. The factory guardian is PAUSE_GUARDIAN from");
        console.log("     construction (audit M6) - there is nothing queued to execute, and audit");
        console.log("     F-30-10 would have force-cancelled it during acceptFeeToSetter anyway.");
        console.log("     If you are re-homing an ALREADY-DEPLOYED factory whose guardian is still");
        console.log("     an EOA, the order is: acceptFeeToSetter FIRST, THEN the new setter calls");
        console.log("     proposeGuardianChange, THEN wait 48h, THEN executeGuardianChange.");
        console.log("     Queuing the proposal before the acceptance loses it. See docs/GOLIVE_HANDOFF.md.");
        console.log("  4. Fund staking with TOWELI via fund()");
        console.log("  5. Add initial liquidity to TOWELI/WETH pair (use a private relay + set min amounts to avoid the first-LP price-set/sandwich window - audit M7)");
        console.log("  6. Wire PAUSE_GUARDIAN onto each contract (set pauseGuardian addr)");
        console.log("  7. (Phase 7) TegridyRestaking is ALREADY split and under EIP-170 as of");
        console.log("     2026-08-19 (host 22,114 B, admin sister 9,298 B), and");
        console.log("     script/DeployRestaking.s.sol deploys all three. It is still NOT deployed:");
        console.log("     the mandatory external re-audit (RESTAKING_EIP170_SPLIT_DESIGN.md 5.8)");
        console.log("     gates it. After that: run DeployRestaking, then wire via");
        console.log("     stakingAdmin.proposeRestakingContract + revDist.proposeRestakingChange (48h each)");
        console.log("  8. Run Verify.s.sol - must report ALL invariants green before announcing live");
    }
}
