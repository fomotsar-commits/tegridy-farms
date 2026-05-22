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
import {TegridyRestaking} from "../src/TegridyRestaking.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {ReferralSplitter} from "../src/ReferralSplitter.sol";
import {SwapFeeRouter} from "../src/SwapFeeRouter.sol";
import {SwapFeeRouterAdmin} from "../src/SwapFeeRouterAdmin.sol";
import {POLAccumulator} from "../src/POLAccumulator.sol";
import {TegridyTokenURIReader} from "../src/TegridyTokenURIReader.sol";

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
        d = _deployCore(d, treasury, deployer, SEQUENCER_FEED);
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
        TegridyRestaking(d.restaking).setPauseGuardian(pauseGuardian);
        RevenueDistributor(payable(d.revenueDistributor)).setPauseGuardian(pauseGuardian);
        SwapFeeRouter(payable(d.swapFeeRouter)).setPauseGuardian(pauseGuardian);
        POLAccumulator(payable(d.polAccumulator)).setPauseGuardian(pauseGuardian);
        console.log("    -> pauseGuardian wired on 5 Pausable contracts:", pauseGuardian);
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
        // Initial guardian = deployer EOA; rotate to PAUSE_GUARDIAN multisig
        // post-deploy via proposeGuardianChange / executeGuardianChange.
        TegridyFactory factory = new TegridyFactory(deployer, treasury, deployer);
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

        // 6. TegridyRestaking (deployed but paused at launch per battle plan
        //    Phase 6 — restake() opens only at Phase 7.0 after MVP-cycle audit
        //    on the restaking-side flows).
        TegridyRestaking restaking = new TegridyRestaking(d.staking, TOWELI, WETH, 0);
        d.restaking = address(restaking);
        console.log(" 6. TegridyRestaking:      ", d.restaking);

        // Propose restaking on staking admin (48h timelock).
        stakingAdmin.proposeRestakingContract(d.restaking);
        console.log("    -> stakingAdmin.proposeRestakingContract queued (48h)");

        // 7. TegridyTokenURIReader
        TegridyTokenURIReader uriReader = new TegridyTokenURIReader(d.staking);
        d.tokenURIReader = address(uriReader);
        console.log(" 7. TegridyTokenURIReader: ", d.tokenURIReader);

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

        revDist.proposeRestakingChange(d.restaking);
        console.log("    -> revDist.restaking proposed (48h)");

        // 9. ReferralSplitter
        ReferralSplitter splitter = new ReferralSplitter(REFERRAL_FEE_BPS, d.staking, treasury, WETH);
        d.referralSplitter = address(splitter);
        console.log(" 9. ReferralSplitter:      ", d.referralSplitter);

        // 10. SwapFeeRouter
        SwapFeeRouter sfr = new SwapFeeRouter(d.router, treasury, SWAP_FEE_BPS, d.referralSplitter);
        d.swapFeeRouter = address(sfr);
        console.log("10. SwapFeeRouter:         ", d.swapFeeRouter);

        // 10b. SwapFeeRouterAdmin — one-shot wire BEFORE transferOwnership.
        SwapFeeRouterAdmin sfrAdmin = new SwapFeeRouterAdmin(d.swapFeeRouter);
        d.swapFeeRouterAdmin = address(sfrAdmin);
        sfr.setSwapFeeRouterAdmin(d.swapFeeRouterAdmin);
        console.log("10b. SwapFeeRouterAdmin:   ", d.swapFeeRouterAdmin);

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
        // Battle plan Phase 6: restaking is deployed but PAUSED at launch.
        // Opens only at Phase 7.0 after MVP-cycle audit on restaking flows.
        TegridyRestaking(d.restaking).pause();
        console.log("    -> TegridyRestaking paused at deploy (opens Phase 7.0)");

        // Propose feeTo -> RevenueDistributor (48h timelock).
        TegridyFactory(d.factory).proposeFeeToChange(d.revenueDistributor);
        console.log("    -> Factory.feeTo proposed to RevenueDistributor (48h)");

        // Transfer ownership to multisig on every owned MVP contract.
        TegridyStaking(d.staking).transferOwnership(multisig);
        TegridyStakingAdmin(d.stakingAdmin).transferOwnership(multisig);
        TegridyRestaking(d.restaking).transferOwnership(multisig);
        TegridyTWAP(payable(d.twap)).transferOwnership(multisig);
        RevenueDistributor(payable(d.revenueDistributor)).transferOwnership(multisig);
        SwapFeeRouter(payable(d.swapFeeRouter)).transferOwnership(multisig);
        SwapFeeRouterAdmin(d.swapFeeRouterAdmin).transferOwnership(multisig);
        POLAccumulator(payable(d.polAccumulator)).transferOwnership(multisig);
        ReferralSplitter(payable(d.referralSplitter)).transferOwnership(multisig);
        // TegridyFactory owner stays as deployer until guardian rotation completes.
        // TegridyFactory.feeToSetter is the role that needs handoff; propose it now.
        TegridyFactory(d.factory).proposeFeeToSetter(multisig);
        console.log("    -> Factory.feeToSetter proposed to multisig (48h)");

        console.log("12. Ownership transfer initiated for 9 owned MVP contracts to:", multisig);
    }

    function _logSummary(Deployed memory d) internal pure {
        console.log("");
        console.log("=== MVP DEPLOYMENT COMPLETE (15 contracts) ===");
        console.log("Toweli (token):           ", TOWELI);
        console.log(" 1. TegridyStaking:       ", d.staking);
        console.log(" 1b. JbacVault:           ", d.jbacVault);
        console.log(" 1c. StakingAdmin:        ", d.stakingAdmin);
        console.log(" 2. TegridyFactory:       ", d.factory);
        console.log(" 3. TegridyRouter:        ", d.router);
        console.log(" 4. TOWELI/WETH Pair:     ", d.pair);
        console.log(" 5. TegridyTWAP:          ", d.twap);
        console.log(" 6. TegridyRestaking:     ", d.restaking);
        console.log(" 7. TokenURIReader:       ", d.tokenURIReader);
        console.log(" 8. RevenueDistributor:   ", d.revenueDistributor);
        console.log(" 9. ReferralSplitter:     ", d.referralSplitter);
        console.log("10. SwapFeeRouter:        ", d.swapFeeRouter);
        console.log("10b. SwapFeeRouterAdmin:  ", d.swapFeeRouterAdmin);
        console.log("11. POLAccumulator:       ", d.polAccumulator);
        console.log("");
        console.log("NEXT STEPS (operator runbook - DO NOT SKIP):");
        console.log("  1. Multisig acceptOwnership() on all 9 owned contracts");
        console.log("     within OwnableNoRenounce 14-day expiry. Verify each with Verify.s.sol.");
        console.log("  2. After 48h: factory.executeFeeToChange()");
        console.log("  3. After 48h: factory.acceptFeeToSetter() from multisig");
        console.log("  4. After 48h: stakingAdmin.executeRestakingContract()");
        console.log("  5. After 48h: revenueDistributor.executeRestakingChange()");
        console.log("  6. Fund staking with TOWELI via fund()");
        console.log("  7. Add initial liquidity to TOWELI/WETH pair");
        console.log("  8. PAUSE restaking via restaking.pause() until Phase 7.0 audit clears it");
        console.log("  9. Wire PAUSE_GUARDIAN onto each contract (set pauseGuardian addr)");
        console.log(" 10. Run Verify.s.sol - must report ALL invariants green before announcing live");
    }
}
