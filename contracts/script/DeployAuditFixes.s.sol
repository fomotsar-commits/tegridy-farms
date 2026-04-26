// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyRestaking.sol";
import "../src/CommunityGrants.sol";
import "../src/SwapFeeRouter.sol";
import "../src/RevenueDistributor.sol";
import "../src/MemeBountyBoard.sol";
import "../src/ReferralSplitter.sol";
import "../src/PremiumAccess.sol";
import "../src/POLAccumulator.sol";

contract DeployAuditFixesScript is Script {
    // ─── Existing addresses (unchanged) ───
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant JBAC_NFT = 0xd37264c71e9af940e49795F0d3a8336afAaFDdA9;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;
    address constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

    // ─── Original deployment parameters ───
    uint256 constant REWARD_PER_SECOND = 824300000000000000; // ~0.8243 TOWELI/s
    uint256 constant SWAP_FEE_BPS = 30;                      // 0.3%
    uint256 constant REFERRAL_FEE_BPS = 1000;                // 10%
    uint256 constant MONTHLY_FEE = 10_000 ether;             // 10,000 TOWELI

    function run() external {
        // AUDIT FIX H-11: Chain-ID guard to prevent accidental deployment on wrong chain
        require(block.chainid == 1, "MAINNET_ONLY: This script uses hardcoded mainnet addresses");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("=== AUDIT FIX REDEPLOYMENT ===");
        console.log("Deployer:", deployer);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // 1. TegridyStaking (flash-loan boost fix, emergency withdraw, timelock, snapshot voting)
        TegridyStaking staking = new TegridyStaking(TOWELI, JBAC_NFT, TREASURY, REWARD_PER_SECOND);
        console.log("1. TegridyStaking:", address(staking));

        // 2. TegridyRestaking (emergency NFT withdraw, bonus rate timelock)
        TegridyRestaking restaking = new TegridyRestaking(
            address(staking),
            TOWELI,
            WETH,
            0 // bonus rate set later after funding
        );
        console.log("2. TegridyRestaking:", address(restaking));

        // 3. ReferralSplitter (deployed before SwapFeeRouter so it can be passed as constructor arg)
        ReferralSplitter referral = new ReferralSplitter(
            REFERRAL_FEE_BPS,
            address(staking), // stakingContract for power check
            TREASURY,          // treasury for unclaimable referral funds
            WETH               // AUDIT FIX M-05/M-07: WETH fallback for revert-on-receive addresses
        );
        console.log("3. ReferralSplitter:", address(referral));

        // 4. SwapFeeRouter (referral integration, overflow protection, balance-diff, WETH fallback)
        SwapFeeRouter swapRouter = new SwapFeeRouter(
            UNISWAP_V2_ROUTER,
            TREASURY,
            SWAP_FEE_BPS,
            address(referral) // AUDIT FIX C2: ReferralSplitter integration
        );
        console.log("4. SwapFeeRouter:", address(swapRouter));

        // 5. CommunityGrants (snapshot voting via votingPowerAt)
        CommunityGrants grants = new CommunityGrants(
            address(staking), // votingEscrow = new staking contract
            TOWELI,
            TREASURY,          // feeReceiver
            WETH               // AUDIT FIX M-27: WETH for grant execution fallback
        );
        console.log("5. CommunityGrants:", address(grants));

        // 6. RevenueDistributor (registeredAtEpoch, 1-epoch wait, restaking-aware)
        RevenueDistributor revDist = new RevenueDistributor(
            address(staking), // votingEscrow = new staking contract
            TREASURY,
            WETH
        );
        console.log("6. RevenueDistributor:", address(revDist));

        // 7. MemeBountyBoard (quorum + dispute period)
        // AUDIT FIX M-06: MemeBountyBoard now requires WETH address for payout fallback
        // AUDIT R062: pass per-chain Chainlink L2 Sequencer Uptime feed via SEQUENCER_FEED env;
        //             address(0) on mainnet / non-L2 (no-op).
        address SEQUENCER_FEED = vm.envOr("SEQUENCER_FEED", address(0));
        MemeBountyBoard bountyBoard = new MemeBountyBoard(TOWELI, address(staking), WETH, SEQUENCER_FEED);
        console.log("7. MemeBountyBoard:", address(bountyBoard));

        // 8. PremiumAccess (cancelSubscription with pro-rata refund)
        PremiumAccess premium = new PremiumAccess(
            TOWELI,
            JBAC_NFT,
            TREASURY,
            MONTHLY_FEE
        );
        console.log("8. PremiumAccess:", address(premium));

        // 9. POLAccumulator (protocol-owned liquidity)
        address LP_TOKEN = vm.envAddress("LP_TOKEN"); // TOWELI/WETH pair address
        require(LP_TOKEN != address(0), "LP_TOKEN env var required");
        // AUDIT R015: TWAP env required. AUDIT R062: SEQUENCER_FEED env optional.
        address TWAP = vm.envAddress("TWAP");
        require(TWAP != address(0), "TWAP env var required");
        POLAccumulator polAccumulator = new POLAccumulator(
            TOWELI,
            UNISWAP_V2_ROUTER,
            LP_TOKEN,
            TREASURY,
            TWAP,
            SEQUENCER_FEED // R062
        );
        console.log("9. POLAccumulator:", address(polAccumulator));

        // ─── Cross-contract linking ─────────────────────────────────────
        // AUDIT FIX C2: Approve SwapFeeRouter as ReferralSplitter caller (direct setter for initial setup)
        referral.setApprovedCaller(address(swapRouter), true);
        // SECURITY FIX C-3: Lock down instant caller management after initial setup.
        // Without this, the owner can add arbitrary approved callers without the 24h timelock.
        referral.completeSetup();
        console.log("9. ReferralSplitter approved caller set + setup completed (locked)");

        // AUDIT FIX C3: Link restaking contract to RevenueDistributor (48h timelock)
        revDist.proposeRestakingChange(address(restaking));
        console.log("9. Proposed restaking link for RevenueDistributor (execute after 48h)");

        // AUDIT FIX C-02: Restaking contract now uses timelocked setter
        staking.proposeRestakingContract(address(restaking));
        console.log("10. TegridyStaking restaking contract proposed (execute after 48h)");

        // AUDIT FIX H10: Transfer ownership to multisig
        address MULTISIG = vm.envAddress("MULTISIG");
        require(MULTISIG != address(0), "MULTISIG env var required");

        staking.transferOwnership(MULTISIG);
        restaking.transferOwnership(MULTISIG);
        referral.transferOwnership(MULTISIG);
        swapRouter.transferOwnership(MULTISIG);
        grants.transferOwnership(MULTISIG);
        revDist.transferOwnership(MULTISIG);
        bountyBoard.transferOwnership(MULTISIG);
        premium.transferOwnership(MULTISIG);
        polAccumulator.transferOwnership(MULTISIG);
        console.log("12. Ownership transferred to multisig (pending acceptance):", MULTISIG);

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("");
        console.log("TegridyStaking:      ", address(staking));
        console.log("TegridyRestaking:    ", address(restaking));
        console.log("ReferralSplitter:    ", address(referral));
        console.log("SwapFeeRouter:       ", address(swapRouter));
        console.log("CommunityGrants:     ", address(grants));
        console.log("RevenueDistributor:  ", address(revDist));
        console.log("MemeBountyBoard:     ", address(bountyBoard));
        console.log("PremiumAccess:       ", address(premium));
        console.log("POLAccumulator:      ", address(polAccumulator));
        console.log("");
        console.log("NEXT STEPS:");
        console.log("1. Accept ownership from multisig: acceptOwnership() on all 9 contracts");
        console.log("2. After 48h: execute staking.executeRestakingContract()");
        console.log("3. After 48h: execute revDist.executeRestakingChange()");
        console.log("4. Transfer feeToSetter on TegridyFactory: proposeFeeToSetter(MULTISIG), wait 48h, acceptFeeToSetter()");
        console.log("5. IMPORTANT: Update TegridyFactory feeTo to point to new RevenueDistributor");
        console.log("   factory.proposeFeeToChange(address(revDist)), wait 48h, executeFeeToChange()");
        console.log("6. Fund TegridyStaking with TOWELI rewards via fund()");
        console.log("7. Fund TegridyRestaking with WETH for bonus rewards");
        console.log("8. Migrate staked positions (users withdraw from old, deposit to new)");
        console.log("9. Update frontend/src/lib/constants.ts with new addresses");
        console.log("10. Verify all contracts on Etherscan");
        console.log("11. Deploy TegridyFeeHook separately (requires CREATE2 for hook address flags)");
        console.log("NOTE: Factory and Router are NOT redeployed. Ensure they reference correct addresses.");
    }
}
