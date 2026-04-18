// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/SwapFeeRouter.sol";

/// @title ConfigureFeePolicy
/// @notice Two-phase runbook for the new pair-specific fee + 70/20/10 split policy.
///
///         Phase 1: `propose` — owner queues:
///           1. fee split change (70/20/10 stakers/treasury/POL) via proposeFeeSplit
///           2. POL accumulator address (POL_ACCUMULATOR_ADDRESS) via proposePolAccumulator
///           3. pair-specific fees:
///                TOWELI_WETH_LP          → 100 bps (1.00%) — captive flagship
///                TEGRIDY_LP              → 100 bps (1.00%) — Tegridy-owned pool, same
///           4. global fee bump from current 50 bps → 75 bps (fallback when no override)
///              via proposeFeeChange.
///           (Pair overrides for TOWELI/other ERC20 pairs are appended as needed — we
///           only queue the ones we know the pair address of at deploy time. Additional
///           pair overrides can be proposed in the same manner after Factory discovery.)
///
///         Phase 2: `execute` — after the timelock matures (48h for split/POL, 24h for
///           fees), call the matching execute* functions.
///
///         Run with:
///           forge script script/ConfigureFeePolicy.s.sol:ConfigureFeePolicyPropose   --broadcast
///           # wait 48h
///           forge script script/ConfigureFeePolicy.s.sol:ConfigureFeePolicyExecute   --broadcast
///
///         Safety: only the SwapFeeRouter owner can call any of these. If ownership was
///         transferred to a multisig, run these as proposals from the multisig UI instead.
abstract contract ConfigureFeePolicyBase is Script {
    // --- Deployment addresses (mainnet) ---
    address constant SWAP_FEE_ROUTER      = 0xea13Cd47a37cC5B59675bfd52BFc8ff8691937A0;
    address constant POL_ACCUMULATOR      = 0x17215f0dfA5E97c33c025E0560eeddffaD87B7Ca;

    // Pair addresses that get captive-pricing overrides. Add additional pair addresses
    // (TOWELI/USDC etc.) here as they are created by the factory.
    address constant TOWELI_WETH_UNI_LP   = 0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D;
    address constant TEGRIDY_LP           = 0xeD01d5f52EBE97360133bdeF77305ee24d5f26f6;

    // --- Policy ---
    uint256 constant NEW_STAKER_SHARE_BPS = 7_000;   // 70% to stakers
    uint256 constant NEW_POL_SHARE_BPS    = 1_000;   // 10% to POL; treasury gets 20% (remainder)
    uint256 constant NEW_GLOBAL_FEE_BPS   = 75;      // 0.75% default on pairs without override
    uint256 constant CAPTIVE_FEE_BPS      = 100;     // 1.00% on TOWELI-paired pools
}

contract ConfigureFeePolicyPropose is ConfigureFeePolicyBase {
    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        SwapFeeRouter r = SwapFeeRouter(payable(SWAP_FEE_ROUTER));

        // 1. Fee split 70/20/10 (staker/treasury/POL)
        r.proposeFeeSplit(NEW_STAKER_SHARE_BPS, NEW_POL_SHARE_BPS);
        console.log("Proposed fee split:", NEW_STAKER_SHARE_BPS, NEW_POL_SHARE_BPS);

        // 2. POL accumulator destination
        r.proposePolAccumulator(POL_ACCUMULATOR);
        console.log("Proposed POL accumulator:", POL_ACCUMULATOR);

        // 3. Global fee bump (50 -> 75 bps on non-captive paths)
        r.proposeFeeChange(NEW_GLOBAL_FEE_BPS);
        console.log("Proposed global fee bps:", NEW_GLOBAL_FEE_BPS);

        // 4a. TOWELI/WETH Uniswap pair captive override
        r.proposePairFeeChange(TOWELI_WETH_UNI_LP, CAPTIVE_FEE_BPS, false);
        console.log("Proposed captive fee on TOWELI/WETH (Uni):", CAPTIVE_FEE_BPS);

        // 4b. Tegridy-owned TOWELI/WETH pair captive override
        r.proposePairFeeChange(TEGRIDY_LP, CAPTIVE_FEE_BPS, false);
        console.log("Proposed captive fee on TEGRIDY_LP:", CAPTIVE_FEE_BPS);

        vm.stopBroadcast();

        console.log("");
        console.log("=== NEXT STEPS ===");
        console.log("Wait 48h for split + POL (longest timelock).");
        console.log("Then run: forge script ConfigureFeePolicyExecute --broadcast");
    }
}

contract ConfigureFeePolicyExecute is ConfigureFeePolicyBase {
    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        SwapFeeRouter r = SwapFeeRouter(payable(SWAP_FEE_ROUTER));

        // 1. execute split
        r.executeFeeSplit();
        console.log("Executed fee split");

        // 2. execute POL accumulator
        r.executePolAccumulator();
        console.log("Executed POL accumulator");

        // 3. execute global fee bump
        r.executeFeeChange();
        console.log("Executed global fee bump");

        // 4. execute pair overrides (one at a time — proposePairFeeChange stores one
        //    pending pair, so they must be proposed+executed in sequence. If your
        //    multisig batches differently, adjust the Phase 1 script accordingly.)
        r.executePairFeeChange();
        console.log("Executed first pair override");

        vm.stopBroadcast();

        console.log("");
        console.log("NOTE: propose/execute the second pair override (TEGRIDY_LP) in a");
        console.log("separate run since only one pair change can be queued at a time.");
    }
}
