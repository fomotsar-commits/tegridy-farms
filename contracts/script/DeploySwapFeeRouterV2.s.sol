// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/SwapFeeRouter.sol";

/// @title DeploySwapFeeRouterV2 - Deploy upgraded SwapFeeRouter with dynamic fees + premium discount
contract DeploySwapFeeRouterV2Script is Script {
    // ─── Mainnet Constants ───────────────────────────────────────────
    address constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;
    address constant REFERRAL_SPLITTER = 0x5A2c3382B3aDf54E44E6e94C859e24D7A3c07411;
    address constant PREMIUM_ACCESS = 0x84AA3Bf462ca7C07Ba20E4A1fA2ff8Fb78f08aF7;

    uint256 constant SWAP_FEE_BPS = 30; // 0.3%
    uint256 constant PREMIUM_DISCOUNT_BPS = 5000; // 50% off for Gold Card holders

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("=== Deploying SwapFeeRouter V2 ===");
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy SwapFeeRouter V2
        SwapFeeRouter sfr = new SwapFeeRouter(
            UNISWAP_V2_ROUTER,
            TREASURY,
            SWAP_FEE_BPS,
            REFERRAL_SPLITTER
        );
        console.log("1. SwapFeeRouter V2 deployed:", address(sfr));
        console.log("   Fee:", SWAP_FEE_BPS, "bps");

        // 2. Propose PremiumAccess integration (48h timelock)
        sfr.proposePremiumAccessChange(PREMIUM_ACCESS);
        console.log("2. PremiumAccess change proposed (48h timelock)");

        // 3. Propose premium discount (24h timelock)
        sfr.proposePremiumDiscountChange(PREMIUM_DISCOUNT_BPS);
        console.log("3. Premium discount proposed:", PREMIUM_DISCOUNT_BPS, "bps (24h timelock)");

        // 4. Transfer ownership to multisig
        address multisig = vm.envOr("MULTISIG", address(0));
        if (multisig != address(0)) {
            sfr.transferOwnership(multisig);
            console.log("4. Ownership transfer initiated to:", multisig);
        } else {
            console.log("4. SKIPPED ownership transfer (no MULTISIG env var)");
        }

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("SwapFeeRouter V2:", address(sfr));
        console.log("");
        console.log("=== NEXT STEPS ===");
        console.log("1. Update frontend SWAP_FEE_ROUTER_ADDRESS in constants.ts");
        console.log("2. Approve new SwapFeeRouter on ReferralSplitter (setApprovedCaller)");
        console.log("3. In 24h: executePremiumDiscountChange()");
        console.log("4. In 48h: executePremiumAccessChange()");
        console.log("5. Set per-pair fee overrides as needed (proposePairFeeChange)");
    }
}
