// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/TegridyStaking.sol";
import {TegridyStakingJbacVault} from "../src/TegridyStakingJbacVault.sol";
import "../src/TegridyFactory.sol";
import "../src/TegridyRouter.sol";
import "../src/TegridyRestaking.sol";
import "../src/RevenueDistributor.sol";
import "../src/SwapFeeRouter.sol";
import "../src/SwapFeeRouterAdmin.sol";
import "../src/POLAccumulator.sol";
import "../src/PremiumAccess.sol";
import "../src/ReferralSplitter.sol";
import "../src/CommunityGrants.sol";
import "../src/MemeBountyBoard.sol";
import {TegridyLending} from "../src/TegridyLending.sol";
import {TegridyLendingAdmin} from "../src/TegridyLendingAdmin.sol";

/// @title DeployFinalScript - Full protocol deployment and wiring
/// @dev TegridyFeeHook (Uniswap V4) is NOT deployed here - it requires CREATE2 salt mining.
contract DeployFinalScript is Script {
    // ─── Mainnet Constants ───────────────────────────────────────────
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant JBAC_NFT = 0xd37264c71e9af940e49795F0d3a8336afAaFDdA9;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;

    uint256 constant REWARD_PER_SECOND = 824300000000000000; // ~0.8243 TOWELI/s
    uint256 constant SWAP_FEE_BPS = 50;        // 0.5% protocol fee on swaps
    uint256 constant REFERRAL_FEE_BPS = 2000;  // 20% of protocol fee to referrers
    uint256 constant PREMIUM_MONTHLY_FEE = 0.01 ether;
    uint256 constant LENDING_FEE_BPS = 500;    // 5% protocol fee on interest

    struct Deployed {
        address staking;
        address jbacVault;
        address factory;
        address router;
        address pair;
        address restaking;
        address revenueDistributor;
        address referralSplitter;
        address swapFeeRouter;
        address swapFeeRouterAdmin;
        address polAccumulator;
        address premiumAccess;
        address communityGrants;
        address memeBountyBoard;
        address lending;
        address lendingAdmin;
    }

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        // FRESH-EYES M-13: keystore migration completion. Forge selects sender from --account/--private-key/--ledger CLI flags; reading PRIVATE_KEY from env defeats the keystore path.
        address multisig = vm.envAddress("MULTISIG");
        require(multisig != address(0), "MULTISIG env var required");

        console.log("Multisig:", multisig);

        vm.startBroadcast();
        address deployer = msg.sender;
        console.log("Deployer:", deployer);

        Deployed memory d;
        d = _deployCore(d, deployer);
        d = _deployRevenue(d);
        d = _deployCommunity(d);
        d = _deployLending(d);
        _wireAndTransfer(d, multisig);

        vm.stopBroadcast();

        _logSummary(d);
    }

    function _deployCore(Deployed memory d, address deployer) internal returns (Deployed memory) {
        // 1. TegridyStaking
        TegridyStaking staking = new TegridyStaking(TOWELI, JBAC_NFT, TREASURY, REWARD_PER_SECOND);
        d.staking = address(staking);
        console.log(" 1. TegridyStaking:", d.staking);

        // 1b. TegridyStakingJbacVault + one-shot wire BEFORE transferOwnership.
        // `setJbacVault` is owner-only and one-shot; if it isn't called while the
        // deployer still owns staking, the multisig has to call it after accepting
        // ownership. Historical deploys forgot this step entirely, leaving the
        // JBAC boost permanently unreachable on the live deployment.
        TegridyStakingJbacVault vault = new TegridyStakingJbacVault(JBAC_NFT, d.staking);
        d.jbacVault = address(vault);
        staking.setJbacVault(d.jbacVault);
        console.log(" 1b. TegridyStakingJbacVault:", d.jbacVault);
        console.log("    -> staking.setJbacVault wired (one-shot complete)");

        // 2. TegridyFactory
        // AUDIT FIX F-30-9: 3rd arg is initial guardian (must be non-zero).
        // Pass deployer EOA for bootstrap; rotate to multisig post-deploy via
        // proposeGuardianChange / executeGuardianChange (48h timelock).
        TegridyFactory factory = new TegridyFactory(deployer, TREASURY, deployer);
        d.factory = address(factory);
        console.log(" 2. TegridyFactory:", d.factory);

        // 3. TegridyRouter
        TegridyRouter router = new TegridyRouter(d.factory, WETH);
        d.router = address(router);
        console.log(" 3. TegridyRouter:", d.router);

        // 4. TOWELI/WETH Pair
        d.pair = factory.createPair(TOWELI, WETH);
        console.log(" 4. TOWELI/WETH Pair:", d.pair);

        // 5. TegridyRestaking
        TegridyRestaking restaking = new TegridyRestaking(d.staking, TOWELI, WETH, 0);
        d.restaking = address(restaking);
        console.log(" 5. TegridyRestaking:", d.restaking);

        // SIZE-REDUCTION SPRINT 2026-04-26: timelocked admin lives on TegridyStakingAdmin.
        // Deploy TegridyStakingAdmin separately and call admin.proposeRestakingContract(...).
        console.log("    -> Staking.restakingContract must be proposed via TegridyStakingAdmin");

        return d;
    }

    function _deployRevenue(Deployed memory d) internal returns (Deployed memory) {
        // 6. RevenueDistributor
        RevenueDistributor revDist = new RevenueDistributor(d.staking, TREASURY, WETH);
        d.revenueDistributor = address(revDist);
        console.log(" 6. RevenueDistributor:", d.revenueDistributor);

        revDist.proposeRestakingChange(d.restaking);
        console.log("    -> RevenueDistributor.restaking proposed (48h timelock)");

        // 7. ReferralSplitter
        ReferralSplitter splitter = new ReferralSplitter(REFERRAL_FEE_BPS, d.staking, TREASURY, WETH);
        d.referralSplitter = address(splitter);
        console.log(" 7. ReferralSplitter:", d.referralSplitter);

        // 8. SwapFeeRouter
        SwapFeeRouter sfr = new SwapFeeRouter(d.router, TREASURY, SWAP_FEE_BPS, d.referralSplitter);
        d.swapFeeRouter = address(sfr);
        console.log(" 8. SwapFeeRouter:", d.swapFeeRouter);

        // 8b. SwapFeeRouterAdmin (sister contract holding timelocked propose/execute/cancel)
        SwapFeeRouterAdmin sfrAdmin = new SwapFeeRouterAdmin(d.swapFeeRouter);
        d.swapFeeRouterAdmin = address(sfrAdmin);
        sfr.setSwapFeeRouterAdmin(d.swapFeeRouterAdmin);
        console.log(" 8b. SwapFeeRouterAdmin:", d.swapFeeRouterAdmin);

        // Approve SwapFeeRouter on ReferralSplitter, then lock instant setter
        splitter.setApprovedCaller(d.swapFeeRouter, true);
        splitter.completeSetup();
        console.log("    -> ReferralSplitter: approved SwapFeeRouter, setup locked");

        // 9. POLAccumulator (AUDIT R015: TWAP required. AUDIT R062: SEQUENCER_FEED optional.)
        address TWAP = vm.envAddress("TWAP");
        require(TWAP != address(0), "TWAP env var required");
        address SEQUENCER_FEED = vm.envOr("SEQUENCER_FEED", address(0));
        // AUDIT FIX FRESH-2026: H-9 follow-on — fail at deploy time, not first runtime call,
        //         when an L2 deploy forgets to set SEQUENCER_FEED. lib/SequencerCheck reverts
        //         SequencerFeedNotConfigured() at runtime on chainid != 1 with feed == 0; this
        //         require surfaces that loud at deploy. Mainnet (chainid 1) skip is intentional.
        require(block.chainid == 1 || SEQUENCER_FEED != address(0), "DEPLOY: L2 needs SEQUENCER_FEED env");
        POLAccumulator pol = new POLAccumulator(TOWELI, d.router, d.pair, TREASURY, TWAP, SEQUENCER_FEED);
        d.polAccumulator = address(pol);
        console.log(" 9. POLAccumulator:", d.polAccumulator);

        // 10. PremiumAccess
        PremiumAccess premium = new PremiumAccess(TOWELI, JBAC_NFT, TREASURY, PREMIUM_MONTHLY_FEE);
        d.premiumAccess = address(premium);
        console.log("10. PremiumAccess:", d.premiumAccess);

        return d;
    }

    function _deployCommunity(Deployed memory d) internal returns (Deployed memory) {
        // 11. CommunityGrants
        CommunityGrants grants = new CommunityGrants(d.staking, TOWELI, TREASURY, WETH);
        d.communityGrants = address(grants);
        console.log("11. CommunityGrants:", d.communityGrants);

        // 12. MemeBountyBoard (AUDIT R062: pass SEQUENCER_FEED env or 0 for mainnet)
        address SEQUENCER_FEED2 = vm.envOr("SEQUENCER_FEED", address(0));
        MemeBountyBoard bounty = new MemeBountyBoard(TOWELI, d.staking, WETH, SEQUENCER_FEED2, TREASURY);
        d.memeBountyBoard = address(bounty);
        console.log("12. MemeBountyBoard:", d.memeBountyBoard);

        return d;
    }

    function _deployLending(Deployed memory d) internal returns (Deployed memory) {
        // 13. TegridyLending — P2P NFT lending with TOWELI staking positions as collateral.
        //     Constructor takes (treasury, protocolFeeBps, weth, pair, twap, sequencerFeed).
        //     Same TWAP + SEQUENCER_FEED env-var contract as POLAccumulator.
        address TWAP = vm.envAddress("TWAP");
        require(TWAP != address(0), "TWAP env var required");
        address SEQUENCER_FEED = vm.envOr("SEQUENCER_FEED", address(0));
        require(
            block.chainid == 1 || SEQUENCER_FEED != address(0),
            "DEPLOY: L2 needs SEQUENCER_FEED env"
        );
        TegridyLending lending = new TegridyLending(
            TREASURY,
            LENDING_FEE_BPS,
            WETH,
            d.pair,
            TWAP,
            SEQUENCER_FEED
        );
        d.lending = address(lending);
        console.log("13. TegridyLending:", d.lending);

        // 13b. TegridyLendingAdmin (sister contract holding timelocked propose/execute/cancel)
        //      `setLendingAdmin` is owner-only and one-shot; same trap as `setJbacVault`
        //      if skipped before transferOwnership.
        TegridyLendingAdmin lendingAdmin = new TegridyLendingAdmin(d.lending);
        d.lendingAdmin = address(lendingAdmin);
        lending.setLendingAdmin(d.lendingAdmin);
        console.log("13b. TegridyLendingAdmin:", d.lendingAdmin);
        console.log("    -> lending.setLendingAdmin wired (one-shot complete)");

        return d;
    }

    function _wireAndTransfer(Deployed memory d, address multisig) internal {
        // Propose feeTo -> RevenueDistributor (48h timelock)
        TegridyFactory(d.factory).proposeFeeToChange(d.revenueDistributor);
        console.log("    -> Factory.feeTo proposed to RevenueDistributor");

        // Transfer ownership to multisig (all use Ownable2Step)
        TegridyStaking(d.staking).transferOwnership(multisig);
        TegridyRestaking(d.restaking).transferOwnership(multisig);
        RevenueDistributor(payable(d.revenueDistributor)).transferOwnership(multisig);
        SwapFeeRouter(payable(d.swapFeeRouter)).transferOwnership(multisig);
        SwapFeeRouterAdmin(d.swapFeeRouterAdmin).transferOwnership(multisig);
        POLAccumulator(payable(d.polAccumulator)).transferOwnership(multisig);
        PremiumAccess(payable(d.premiumAccess)).transferOwnership(multisig);
        ReferralSplitter(payable(d.referralSplitter)).transferOwnership(multisig);
        CommunityGrants(payable(d.communityGrants)).transferOwnership(multisig);
        MemeBountyBoard(payable(d.memeBountyBoard)).transferOwnership(multisig);
        TegridyLending(payable(d.lending)).transferOwnership(multisig);
        TegridyLendingAdmin(d.lendingAdmin).transferOwnership(multisig);
        console.log("14. Ownership transfer initiated for 11 contracts to:", multisig);

        // Propose feeToSetter transfer
        TegridyFactory(d.factory).proposeFeeToSetter(multisig);
        console.log("15. Factory feeToSetter transfer proposed to:", multisig);
    }

    function _logSummary(Deployed memory d) internal pure {
        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("TegridyStaking:         ", d.staking);
        console.log("TegridyStakingJbacVault:", d.jbacVault);
        console.log("TegridyFactory:         ", d.factory);
        console.log("TegridyRouter:          ", d.router);
        console.log("TOWELI/WETH Pair:       ", d.pair);
        console.log("TegridyRestaking:       ", d.restaking);
        console.log("RevenueDistributor:     ", d.revenueDistributor);
        console.log("ReferralSplitter:       ", d.referralSplitter);
        console.log("SwapFeeRouter:          ", d.swapFeeRouter);
        console.log("SwapFeeRouterAdmin:     ", d.swapFeeRouterAdmin);
        console.log("POLAccumulator:         ", d.polAccumulator);
        console.log("PremiumAccess:          ", d.premiumAccess);
        console.log("CommunityGrants:        ", d.communityGrants);
        console.log("MemeBountyBoard:        ", d.memeBountyBoard);
        console.log("TegridyLending:         ", d.lending);
        console.log("TegridyLendingAdmin:    ", d.lendingAdmin);
        console.log("");
        console.log("NEXT STEPS:");
        console.log("  1. Multisig: acceptOwnership() on all 11 contracts");
        console.log("     (staking, restaking, revDist, swapFeeRouter, swapFeeRouterAdmin,");
        console.log("      pol, premium, referral, grants, bounty, lending, lendingAdmin)");
        console.log("     MUST complete within OwnableNoRenounce 14-day expiry window.");
        console.log("  2. Run Verify.s.sol BEFORE announcing live to assert all wires healthy.");
        console.log("  3. After 48h: factory.executeFeeToChange()");
        console.log("  4. After timelock: factory.acceptFeeToSetter()");
        console.log("  5. After 48h: staking.executeRestakingContract()");
        console.log("  6. After 48h: revenueDistributor.executeRestakingChange()");
        console.log("  7. Fund staking with TOWELI via fund()");
        console.log("  8. Add initial liquidity to TOWELI/WETH pair");
        console.log("  9. Fund restaking with WETH + set bonus rate");
        console.log(" 10. Deploy TegridyFeeHook via CREATE2");
    }
}
