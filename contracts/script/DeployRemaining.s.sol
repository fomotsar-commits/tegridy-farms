// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/POLAccumulator.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyRestaking.sol";
import "../src/ReferralSplitter.sol";
import "../src/SwapFeeRouter.sol";
import "../src/CommunityGrants.sol";
import "../src/RevenueDistributor.sol";
import "../src/MemeBountyBoard.sol";
import "../src/PremiumAccess.sol";

/// @title DeployRemaining - Deploy POLAccumulator + run all linking transactions
/// @dev Completes the partial deployment from DeployAuditFixes
contract DeployRemainingScript is Script {
    // Already deployed contracts
    address constant STAKING = 0x626644523d34B84818df602c991B4a06789C4819;
    address constant RESTAKING = 0xfE2E5B534cfc3b35773aA26A73beF16B028B0268;
    address constant REFERRAL = 0x2ADe96633Ee51400E60De00f098280f07b92b060;
    address constant SWAP_ROUTER = 0xd8f13c7F3e0C4139D1905914a99F2E9F77A4aD37;
    address constant GRANTS = 0xEb00Fb134699634215ebF5Ea3a4D6FF3872a5B34;
    address constant REV_DIST = 0xf00964D5F5fB0a4d4AFEa0999843DA31BbE9A7aF;
    address constant BOUNTY = 0xAd9b32272376774d18F386A7676Bd06D7E33c647;
    address constant PREMIUM = 0x514553EAcfCb91E05Db0a5e9B09d69d7e9CBaf20;

    // External addresses
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;
    address constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address LP_TOKEN = vm.envAddress("LP_TOKEN");
        address MULTISIG = vm.envAddress("MULTISIG");

        console.log("=== COMPLETING DEPLOYMENT ===");
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy POLAccumulator (the only missing contract)
        POLAccumulator pol = new POLAccumulator(TOWELI, UNISWAP_V2_ROUTER, LP_TOKEN, TREASURY);
        console.log("1. POLAccumulator:", address(pol));

        // 2. Cross-contract linking
        ReferralSplitter(payable(REFERRAL)).setApprovedCaller(SWAP_ROUTER, true);
        ReferralSplitter(payable(REFERRAL)).completeSetup();
        console.log("2. ReferralSplitter: approved caller set + locked");

        RevenueDistributor(payable(REV_DIST)).proposeRestakingChange(RESTAKING);
        console.log("3. RevenueDistributor: restaking link proposed (48h)");

        TegridyStaking(STAKING).proposeRestakingContract(RESTAKING);
        console.log("4. TegridyStaking: restaking link proposed (48h)");

        // 3. Transfer ownership to multisig on ALL contracts
        TegridyStaking(STAKING).transferOwnership(MULTISIG);
        TegridyRestaking(payable(RESTAKING)).transferOwnership(MULTISIG);
        ReferralSplitter(payable(REFERRAL)).transferOwnership(MULTISIG);
        SwapFeeRouter(payable(SWAP_ROUTER)).transferOwnership(MULTISIG);
        CommunityGrants(payable(GRANTS)).transferOwnership(MULTISIG);
        RevenueDistributor(payable(REV_DIST)).transferOwnership(MULTISIG);
        MemeBountyBoard(payable(BOUNTY)).transferOwnership(MULTISIG);
        PremiumAccess(PREMIUM).transferOwnership(MULTISIG);
        pol.transferOwnership(MULTISIG);
        console.log("5. Ownership transferred to multisig on all 9 contracts");

        vm.stopBroadcast();

        console.log("");
        console.log("=== REMAINING DEPLOYMENT COMPLETE ===");
        console.log("POLAccumulator:", address(pol));
        console.log("");
        console.log("All 9 contracts are now live. Accept ownership from multisig.");
    }
}
