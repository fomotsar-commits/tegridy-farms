// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "./mocks/MockTokens.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyFactory.sol";
import "../src/TegridyRouter.sol";
import "../src/TegridyRestaking.sol";
import "../src/RevenueDistributor.sol";
import "../src/SwapFeeRouter.sol";
import "../src/POLAccumulator.sol";
import "../src/PremiumAccess.sol";
import "../src/ReferralSplitter.sol";
import "../src/CommunityGrants.sol";
import "../src/MemeBountyBoard.sol";

/// @title DeploySepoliaScript - Full testnet deployment with mock tokens
/// @notice Deploys mock TOWELI, WETH, JBAC NFT + all 12 protocol contracts
///         Deployer is used as both owner and treasury for testing convenience.
contract DeploySepoliaScript is Script {
    uint256 constant REWARD_PER_SECOND = 824300000000000000; // ~0.8243 TOWELI/s
    uint256 constant SWAP_FEE_BPS = 50;
    uint256 constant REFERRAL_FEE_BPS = 2000;
    uint256 constant PREMIUM_MONTHLY_FEE = 0.001 ether; // Lower for testnet

    // Initial liquidity amounts (low for testnet)
    uint256 constant INITIAL_TOWELI_LIQUIDITY = 1_000_000 ether; // 1M TOWELI
    uint256 constant INITIAL_ETH_LIQUIDITY = 0.005 ether;
    uint256 constant STAKING_FUND_AMOUNT = 10_000_000 ether; // 10M TOWELI for rewards

    struct Deployed {
        address toweli;
        address weth;
        address jbac;
        address staking;
        address factory;
        address router;
        address pair;
        address restaking;
        address revenueDistributor;
        address referralSplitter;
        address swapFeeRouter;
        address polAccumulator;
        address premiumAccess;
        address communityGrants;
        address memeBountyBoard;
    }

    function run() external {
        require(block.chainid == 11155111, "SEPOLIA_ONLY");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("=== TEGRIDDY FARMS SEPOLIA DEPLOYMENT ===");
        console.log("Deployer:", deployer);
        console.log("Deployer balance:", deployer.balance);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        Deployed memory d;

        // ─── 1. Deploy Mock Tokens ───────────────────────────────────
        MockTOWELI toweli = new MockTOWELI();
        d.toweli = address(toweli);
        console.log(" 1. MockTOWELI:", d.toweli);

        MockWETH weth = new MockWETH();
        d.weth = address(weth);
        console.log(" 2. MockWETH:", d.weth);

        MockJBAC jbac = new MockJBAC();
        d.jbac = address(jbac);
        console.log(" 3. MockJBAC:", d.jbac);

        // Mint some JBACs for deployer (for testing boost)
        jbac.mintBatch(deployer, 5);
        console.log("    -> Minted 5 JBACs to deployer");

        // ─── 2. Core Protocol ────────────────────────────────────────
        d = _deployCore(d, deployer);
        d = _deployRevenue(d, deployer);
        d = _deployCommunity(d, deployer);

        // ─── 3. Wire Contracts ───────────────────────────────────────
        _wire(d, deployer);

        // ─── 4. Fund & Seed Liquidity ────────────────────────────────
        _fundAndSeed(d, deployer, toweli, weth);

        vm.stopBroadcast();

        _logSummary(d, deployer);
    }

    function _deployCore(Deployed memory d, address deployer) internal returns (Deployed memory) {
        TegridyStaking staking = new TegridyStaking(d.toweli, d.jbac, deployer, REWARD_PER_SECOND);
        d.staking = address(staking);
        console.log(" 4. TegridyStaking:", d.staking);

        TegridyFactory factory = new TegridyFactory(deployer, deployer);
        d.factory = address(factory);
        console.log(" 5. TegridyFactory:", d.factory);

        TegridyRouter router = new TegridyRouter(d.factory, d.weth);
        d.router = address(router);
        console.log(" 6. TegridyRouter:", d.router);

        d.pair = factory.createPair(d.toweli, d.weth);
        console.log(" 7. TOWELI/WETH Pair:", d.pair);

        TegridyRestaking restaking = new TegridyRestaking(d.staking, d.toweli, d.weth, 0);
        d.restaking = address(restaking);
        console.log(" 8. TegridyRestaking:", d.restaking);

        // Propose restaking wiring (timelocked — execute after 48h)
        staking.proposeRestakingContract(d.restaking);
        console.log("    -> Staking.restakingContract proposed");

        return d;
    }

    function _deployRevenue(Deployed memory d, address deployer) internal returns (Deployed memory) {
        RevenueDistributor revDist = new RevenueDistributor(d.staking, deployer, d.weth);
        d.revenueDistributor = address(revDist);
        console.log(" 9. RevenueDistributor:", d.revenueDistributor);

        revDist.proposeRestakingChange(d.restaking);
        console.log("    -> RevenueDistributor.restaking proposed");

        ReferralSplitter splitter = new ReferralSplitter(REFERRAL_FEE_BPS, d.staking, deployer, d.weth);
        d.referralSplitter = address(splitter);
        console.log("10. ReferralSplitter:", d.referralSplitter);

        SwapFeeRouter sfr = new SwapFeeRouter(d.router, deployer, SWAP_FEE_BPS, d.referralSplitter);
        d.swapFeeRouter = address(sfr);
        console.log("11. SwapFeeRouter:", d.swapFeeRouter);

        splitter.setApprovedCaller(d.swapFeeRouter, true);
        splitter.completeSetup();
        console.log("    -> ReferralSplitter: approved SwapFeeRouter, setup locked");

        POLAccumulator pol = new POLAccumulator(d.toweli, d.router, d.pair, deployer);
        d.polAccumulator = address(pol);
        console.log("12. POLAccumulator:", d.polAccumulator);

        PremiumAccess premium = new PremiumAccess(d.toweli, d.jbac, deployer, PREMIUM_MONTHLY_FEE);
        d.premiumAccess = address(premium);
        console.log("13. PremiumAccess:", d.premiumAccess);

        return d;
    }

    function _deployCommunity(Deployed memory d, address deployer) internal returns (Deployed memory) {
        CommunityGrants grants = new CommunityGrants(d.staking, d.toweli, deployer, d.weth);
        d.communityGrants = address(grants);
        console.log("14. CommunityGrants:", d.communityGrants);

        MemeBountyBoard bounty = new MemeBountyBoard(d.toweli, d.staking, d.weth);
        d.memeBountyBoard = address(bounty);
        console.log("15. MemeBountyBoard:", d.memeBountyBoard);

        return d;
    }

    function _wire(Deployed memory d, address deployer) internal {
        // Propose feeTo -> RevenueDistributor
        TegridyFactory(d.factory).proposeFeeToChange(d.revenueDistributor);
        console.log("    -> Factory.feeTo proposed to RevenueDistributor");

        console.log("");
        console.log("=== WIRING COMPLETE ===");
        console.log("NOTE: Timelocked operations need manual execution after delay:");
        console.log("  - staking.executeRestakingContract() after 48h");
        console.log("  - revenueDistributor.executeRestakingChange() after 48h");
        console.log("  - factory.executeFeeToChange() after 48h");
    }

    function _fundAndSeed(Deployed memory d, address deployer, MockTOWELI toweli, MockWETH weth) internal {
        console.log("");
        console.log("=== FUNDING & LIQUIDITY ===");

        // Fund staking with rewards
        toweli.approve(d.staking, STAKING_FUND_AMOUNT);
        TegridyStaking(d.staking).notifyRewardAmount(STAKING_FUND_AMOUNT);
        console.log("    -> Funded staking with 200M TOWELI");

        // Add initial liquidity: TOWELI + ETH -> LP
        toweli.approve(d.router, INITIAL_TOWELI_LIQUIDITY);
        TegridyRouter(payable(d.router)).addLiquidityETH{value: INITIAL_ETH_LIQUIDITY}(
            d.toweli,
            INITIAL_TOWELI_LIQUIDITY,
            0, // min TOWELI (testnet, accept any)
            0, // min ETH (testnet, accept any)
            deployer,
            block.timestamp + 300
        );
        console.log("    -> Added liquidity: 1M TOWELI + 0.005 ETH");

        // Wrap some ETH as WETH for testing
        weth.deposit{value: 0.001 ether}();
        console.log("    -> Wrapped 0.001 ETH as WETH for testing");
    }

    function _logSummary(Deployed memory d, address deployer) internal pure {
        console.log("");
        console.log("========================================");
        console.log("  SEPOLIA DEPLOYMENT COMPLETE");
        console.log("========================================");
        console.log("");
        console.log("MOCK TOKENS:");
        console.log("  TOWELI:    ", d.toweli);
        console.log("  WETH:      ", d.weth);
        console.log("  JBAC NFT:  ", d.jbac);
        console.log("");
        console.log("PROTOCOL:");
        console.log("  Staking:          ", d.staking);
        console.log("  Factory:          ", d.factory);
        console.log("  Router:           ", d.router);
        console.log("  TOWELI/WETH Pair: ", d.pair);
        console.log("  Restaking:        ", d.restaking);
        console.log("  RevenueDistributor:", d.revenueDistributor);
        console.log("  ReferralSplitter: ", d.referralSplitter);
        console.log("  SwapFeeRouter:    ", d.swapFeeRouter);
        console.log("  POLAccumulator:   ", d.polAccumulator);
        console.log("  PremiumAccess:    ", d.premiumAccess);
        console.log("  CommunityGrants:  ", d.communityGrants);
        console.log("  MemeBountyBoard:  ", d.memeBountyBoard);
        console.log("");
        console.log("TREASURY: ", deployer);
        console.log("OWNER:    ", deployer);
        console.log("");
        console.log("AFTER 48H, EXECUTE:");
        console.log("  cast send <staking> 'executeRestakingContract()' --private-key $PRIVATE_KEY --rpc-url sepolia");
        console.log("  cast send <revDist> 'executeRestakingChange()' --private-key $PRIVATE_KEY --rpc-url sepolia");
        console.log("  cast send <factory> 'executeFeeToChange()' --private-key $PRIVATE_KEY --rpc-url sepolia");
    }
}
