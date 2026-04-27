// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {VoteIncentives} from "../src/VoteIncentives.sol";
import {TegridyRestaking} from "../src/TegridyRestaking.sol";
import {CommunityGrants} from "../src/CommunityGrants.sol";
import {SwapFeeRouter} from "../src/SwapFeeRouter.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {MemeBountyBoard} from "../src/MemeBountyBoard.sol";
import {ReferralSplitter} from "../src/ReferralSplitter.sol";
import {PremiumAccess} from "../src/PremiumAccess.sol";

/// @title DeployV2 — Tegriddy Farms V2 Core Upgrade
/// @notice Deploys 9 contracts with V2 features:
///         - TegridyStaking: boost decay + dead code cleanup
///         - VoteIncentives: gauge voting (Velodrome pattern)
///         - SwapFeeRouter: revenue pipeline (distributeFeesToStakers)
///         - 5 dependent contracts redeployed for new staking immutable ref
///         - PremiumAccess: clean re-deploy
///
/// @dev Follows same pattern as DeployAuditFixes.s.sol (V1 deployment).
///      env vars: PRIVATE_KEY, MULTISIG, LP_TOKEN
contract DeployV2Script is Script {
    // ─── Mainnet Constants (unchanged from V1) ──────────────────────
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant JBAC_NFT = 0xd37264c71e9af940e49795F0d3a8336afAaFDdA9;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;
    address constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address constant TEGRIDY_FACTORY = 0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6;

    // ─── Deployment Parameters (unchanged from V1) ──────────────────
    uint256 constant REWARD_PER_SECOND = 824300000000000000; // ~0.8243 TOWELI/s
    uint256 constant SWAP_FEE_BPS = 30;                      // 0.3%
    uint256 constant REFERRAL_FEE_BPS = 1000;                // 10%
    uint256 constant BRIBE_FEE_BPS = 300;                    // 3%
    uint256 constant MONTHLY_FEE = 10_000 ether;             // 10,000 TOWELI

    function run() external {
        // Chain-ID guard
        require(block.chainid == 1, "MAINNET_ONLY: This script uses hardcoded mainnet addresses");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("=== TEGRIDDY FARMS V2 DEPLOYMENT ===");
        console.log("Deployer:", deployer);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // ═══════════════════════════════════════════════════════════════
        // 1. TegridyStaking V2 (boost decay + dead code cleanup)
        // ═══════════════════════════════════════════════════════════════
        TegridyStaking staking = new TegridyStaking(TOWELI, JBAC_NFT, TREASURY, REWARD_PER_SECOND);
        console.log("1. TegridyStaking V2:", address(staking));

        // ═══════════════════════════════════════════════════════════════
        // 2. VoteIncentives V2 (gauge voting)
        // ═══════════════════════════════════════════════════════════════
        VoteIncentives voteIncentives = new VoteIncentives(
            address(staking),
            TREASURY,
            WETH,
            TEGRIDY_FACTORY,
            TOWELI,            // AUDIT H-2: commit-reveal bond token
            BRIBE_FEE_BPS
        );
        console.log("2. VoteIncentives V2:", address(voteIncentives));

        // ═══════════════════════════════════════════════════════════════
        // 3. TegridyRestaking (immutable staking ref → new staking)
        // ═══════════════════════════════════════════════════════════════
        TegridyRestaking restaking = new TegridyRestaking(
            address(staking),
            TOWELI,
            WETH,
            0 // bonus rate set later after funding
        );
        console.log("3. TegridyRestaking:", address(restaking));

        // ═══════════════════════════════════════════════════════════════
        // 4. ReferralSplitter (immutable staking ref → new staking)
        // ═══════════════════════════════════════════════════════════════
        ReferralSplitter referral = new ReferralSplitter(
            REFERRAL_FEE_BPS,
            address(staking),
            TREASURY,
            WETH
        );
        console.log("4. ReferralSplitter:", address(referral));

        // ═══════════════════════════════════════════════════════════════
        // 5. SwapFeeRouter V2 (revenue pipeline + new referral ref)
        // ═══════════════════════════════════════════════════════════════
        SwapFeeRouter swapRouter = new SwapFeeRouter(
            UNISWAP_V2_ROUTER,
            TREASURY,
            SWAP_FEE_BPS,
            address(referral)
        );
        console.log("5. SwapFeeRouter V2:", address(swapRouter));

        // ═══════════════════════════════════════════════════════════════
        // 6. CommunityGrants (immutable staking ref → new staking)
        // ═══════════════════════════════════════════════════════════════
        CommunityGrants grants = new CommunityGrants(
            address(staking),
            TOWELI,
            TREASURY,
            WETH
        );
        console.log("6. CommunityGrants:", address(grants));

        // ═══════════════════════════════════════════════════════════════
        // 7. RevenueDistributor (immutable staking ref → new staking)
        // ═══════════════════════════════════════════════════════════════
        RevenueDistributor revDist = new RevenueDistributor(
            address(staking),
            TREASURY,
            WETH
        );
        console.log("7. RevenueDistributor:", address(revDist));

        // ═══════════════════════════════════════════════════════════════
        // 8. MemeBountyBoard (immutable staking ref → new staking)
        // ═══════════════════════════════════════════════════════════════
        // AUDIT R062: per-chain Chainlink L2 Sequencer Uptime feed via SEQUENCER_FEED env;
        //             address(0) on mainnet / non-L2 (no-op).
        address SEQUENCER_FEED = vm.envOr("SEQUENCER_FEED", address(0));
        MemeBountyBoard bountyBoard = new MemeBountyBoard(TOWELI, address(staking), WETH, SEQUENCER_FEED);
        console.log("8. MemeBountyBoard:", address(bountyBoard));

        // ═══════════════════════════════════════════════════════════════
        // 9. PremiumAccess (clean re-deploy)
        // ═══════════════════════════════════════════════════════════════
        PremiumAccess premium = new PremiumAccess(
            TOWELI,
            JBAC_NFT,
            TREASURY,
            MONTHLY_FEE
        );
        console.log("9. PremiumAccess:", address(premium));

        // ═══════════════════════════════════════════════════════════════
        // Cross-contract linking
        // ═══════════════════════════════════════════════════════════════

        // ReferralSplitter: approve SwapFeeRouter as caller, then lock setup
        referral.setApprovedCaller(address(swapRouter), true);
        referral.completeSetup();
        console.log(">> ReferralSplitter: approved caller set + setup locked");

        // VoteIncentives: propose TOWELI whitelist (24h timelock)
        voteIncentives.proposeWhitelistChange(TOWELI, true);
        console.log(">> VoteIncentives: TOWELI whitelist proposed (24h timelock)");

        // RevenueDistributor: propose restaking link (48h timelock)
        revDist.proposeRestakingChange(address(restaking));
        console.log(">> RevenueDistributor: restaking link proposed (48h timelock)");

        // SIZE-REDUCTION SPRINT 2026-04-26: timelocked admin lives on TegridyStakingAdmin
        console.log(">> TegridyStaking: restaking link must be proposed via TegridyStakingAdmin");

        // ═══════════════════════════════════════════════════════════════
        // Transfer ownership to multisig (Ownable2Step)
        // ═══════════════════════════════════════════════════════════════
        address MULTISIG = vm.envAddress("MULTISIG");
        require(MULTISIG != address(0), "MULTISIG env var required");

        staking.transferOwnership(MULTISIG);
        voteIncentives.transferOwnership(MULTISIG);
        restaking.transferOwnership(MULTISIG);
        referral.transferOwnership(MULTISIG);
        swapRouter.transferOwnership(MULTISIG);
        grants.transferOwnership(MULTISIG);
        revDist.transferOwnership(MULTISIG);
        bountyBoard.transferOwnership(MULTISIG);
        premium.transferOwnership(MULTISIG);
        console.log(">> Ownership transferred to multisig (pending acceptance):", MULTISIG);

        vm.stopBroadcast();

        // ═══════════════════════════════════════════════════════════════
        // Summary
        // ═══════════════════════════════════════════════════════════════
        console.log("");
        console.log("=== V2 DEPLOYMENT COMPLETE ===");
        console.log("");
        console.log("TegridyStaking V2:    ", address(staking));
        console.log("VoteIncentives V2:    ", address(voteIncentives));
        console.log("TegridyRestaking:     ", address(restaking));
        console.log("ReferralSplitter:     ", address(referral));
        console.log("SwapFeeRouter V2:     ", address(swapRouter));
        console.log("CommunityGrants:      ", address(grants));
        console.log("RevenueDistributor:   ", address(revDist));
        console.log("MemeBountyBoard:      ", address(bountyBoard));
        console.log("PremiumAccess:        ", address(premium));
        console.log("");
        console.log("=== POST-DEPLOYMENT STEPS ===");
        console.log("1. Multisig: acceptOwnership() on all 9 contracts");
        console.log("2. After 24h: VoteIncentives.executeWhitelistChange() (TOWELI)");
        console.log("3. After 48h: TegridyStaking.executeRestakingContract()");
        console.log("4. After 48h: RevenueDistributor.executeRestakingChange()");
        console.log("5. SwapFeeRouter: proposeRevenueDistributor(RevenueDistributor) -> 48h -> execute");
        console.log("6. SwapFeeRouter: proposePremiumAccessChange(PremiumAccess) -> 48h -> execute");
        console.log("7. VoteIncentives: proposeWhitelistChange(WETH, true) -> 24h -> execute");
        console.log("8. Fund TegridyStaking with TOWELI rewards via fund()");
        console.log("9. Update frontend/src/lib/constants.ts with new addresses");
        console.log("10. Verify all contracts on Etherscan");
        console.log("NOTE: POLAccumulator NOT redeployed (no staking dependency)");
    }
}
