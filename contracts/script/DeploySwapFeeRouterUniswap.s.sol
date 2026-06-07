// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {SwapFeeRouter} from "../src/SwapFeeRouter.sol";
import {SwapFeeRouterAdmin} from "../src/SwapFeeRouterAdmin.sol";

/// @title DeploySwapFeeRouterUniswap — Phase 1 on-chain fee leg (docs/SWAP_REVENUE_ARCHITECTURE.md)
/// @notice Redeploys SwapFeeRouter wired to the REAL Uniswap V2 Router02 (the contract was
///         designed for this — "Wraps Uniswap V2 swaps" — but DeployMVP wired it to the internal
///         TegridyRouter). Pointing `_router` at Uniswap is clean: the constructor auto-derives
///         `WETH` and `uniFactory` from `router.WETH()` / `router.factory()`, so the staker/POL/
///         treasury split and the TWAP-floor conversion all key off the matching Uniswap factory.
///         No new attack surface (single immutable router, typed path[], no `target.call`).
///
/// @dev    referralSplitter is intentionally address(0) here: the live ReferralSplitter is
///         `setupComplete` (locked), so approving a NEW caller requires its 24h-timelocked
///         `proposeApprovedCaller` flow. This Uniswap leg simply routes 100% of its fee through
///         the staker/POL/treasury split; the referral program stays on the original SFR. Wire a
///         splitter later via the timelock if desired.
contract DeploySwapFeeRouterUniswapScript is Script {
    address constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address constant TREASURY = 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d; // relaunch 2-of-2 Safe
    address constant REVENUE_DISTRIBUTOR = 0xF993316E2fC079de4358c489A935E01e03E23E17; // relaunch
    uint256 constant SWAP_FEE_BPS = 50; // 0.5%, matches the live SwapFeeRouter

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");
        address multisig = vm.envAddress("MULTISIG");
        require(multisig != address(0), "Set MULTISIG");

        console.log("=== Deploying SwapFeeRouter (real Uniswap V2 leg) ===");
        console.log("Uniswap V2 Router02:", UNISWAP_V2_ROUTER);
        console.log("Treasury:           ", TREASURY);
        console.log("RevenueDistributor: ", REVENUE_DISTRIBUTOR);
        console.log("Fee bps:            ", SWAP_FEE_BPS);

        vm.startBroadcast();
        console.log("Deployer:           ", msg.sender);

        SwapFeeRouter sfr = new SwapFeeRouter(
            UNISWAP_V2_ROUTER,
            TREASURY,
            SWAP_FEE_BPS,
            address(0), // no referral splitter on this leg (see NatSpec)
            REVENUE_DISTRIBUTOR
        );
        // Self-check: the whole point of this script is the Uniswap wiring.
        require(address(sfr.router()) == UNISWAP_V2_ROUTER, "router != uniswap");
        console.log("1. SwapFeeRouter (uniswap):", address(sfr));
        console.log("   derived WETH:           ", sfr.WETH());
        console.log("   derived uniFactory:     ", address(sfr.uniFactory()));

        // Admin sister (one-shot wire before ownership transfer).
        SwapFeeRouterAdmin admin = new SwapFeeRouterAdmin(address(sfr));
        sfr.setSwapFeeRouterAdmin(address(admin));
        console.log("2. SwapFeeRouterAdmin:      ", address(admin));

        // Optional: wire the pause guardian pre-handoff if supplied.
        address guardian = vm.envOr("PAUSE_GUARDIAN", address(0));
        if (guardian != address(0)) {
            sfr.setPauseGuardian(guardian);
            console.log("3. PauseGuardian wired:     ", guardian);
        }

        sfr.transferOwnership(multisig);
        admin.transferOwnership(multisig);

        vm.stopBroadcast();

        console.log("");
        console.log("=== NEXT STEPS ===");
        console.log("1. Multisig: acceptOwnership() on SwapFeeRouter AND SwapFeeRouterAdmin");
        console.log("2. If guardian not wired above: multisig setPauseGuardian(<hot guardian>)");
        console.log("3. Set SWAP_FEE_ROUTER_ADDRESS in frontend/src/lib/constants.ts to this SFR");
        console.log("4. (optional) timelock a feeSplit/polAccumulator via the admin to fund POL");
        console.log("NOTE: VerifyMVP asserts the CURRENT (TegridyRouter-wired) SFR; once this");
        console.log("      Uniswap leg is canonical, point VerifyMVP's SWAP_FEE_ROUTER env here.");
    }
}
