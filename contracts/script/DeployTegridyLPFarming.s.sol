// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/TegridyLPFarming.sol";

/// @title DeployTegridyLPFarming — Deploy audit-fixed (C-01) boosted LP staking
/// @notice Boosted Synthetix-style LP staking with TegridyStaking integration.
///         Includes the C-01 ABI-alignment fix and MAX_BOOST_BPS_CEILING (45000)
///         defence-in-depth cap.
/// @dev    Replaces the older non-boosted LPFarming. Constructor signature matches
///         test/TegridyLPFarming.t.sol:47.
contract DeployTegridyLPFarmingScript is Script {
    // ─── Mainnet Constants ───────────────────────────────────────────
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    // RELAUNCH 2026-06-06: synced to the relaunch treasury (2-of-2 Safe) from
    // frontend/src/lib/constants.ts `TREASURY_ADDRESS`. The prior value
    // (0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e) was the pre-relaunch treasury and
    // is stale — `_treasury` is the recover/sweep destination, so deploying with the
    // old address would route any recovered tokens to a wallet the relaunch Safe may
    // not control. OPERATOR: confirm this matches the Safe that should receive sweeps
    // before broadcasting.
    address constant TREASURY = 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d;

    // RELAUNCH 2026-06-07: hardcoded (each verified live on-chain) so the deploy is a single
    // command with no env vars. TEGRIDY_LP + TEGRIDY_STAKING are the live relaunch contracts;
    // MULTISIG is the relaunch Safe (== the pendingOwner already set on TegridyStaking /
    // RevenueDistributor / SwapFeeRouter), so the farm lands under the same owner as the rest.
    address constant TEGRIDY_LP = 0x55875887B43C2E23aE424AF0FC8606Fdb058a481;
    address constant TEGRIDY_STAKING = 0xcaDc93E96De58EA554c71ca609974625615E046D;
    address constant MULTISIG = 0xA36053477568Fb5382492F3A5970D35Fe896b7F8;

    uint256 constant REWARDS_DURATION = 7 days;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        address tegridyLP = TEGRIDY_LP;
        address tegridyStaking = TEGRIDY_STAKING;

        // FRESH-EYES M-13: keystore migration completion. Forge selects sender from --account/--private-key/--ledger CLI flags; reading PRIVATE_KEY from env defeats the keystore path.
        console.log("=== Deploying TegridyLPFarming (C-01 fixed) ===");
        console.log("Reward Token (TOWELI):", TOWELI);
        console.log("Staking Token (LP):", tegridyLP);
        console.log("TegridyStaking (boost source):", tegridyStaking);
        console.log("Treasury:", TREASURY);
        console.log("Rewards Duration (sec):", REWARDS_DURATION);

        vm.startBroadcast();
        console.log("Deployer:", msg.sender);

        // Deploy the audit-fixed boosted LP farming contract
        TegridyLPFarming farm = new TegridyLPFarming(
            TOWELI, // _rewardToken
            tegridyLP, // _stakingToken
            tegridyStaking, // _tegridyStaking (boost source)
            TREASURY, // _treasury
            REWARDS_DURATION // _rewardsDuration
        );
        console.log("1. TegridyLPFarming deployed:", address(farm));

        // Transfer ownership to the relaunch multisig (initiates the 2-step handover; the
        // Safe completes it with acceptOwnership(), same as the other relaunch contracts).
        farm.transferOwnership(MULTISIG);
        console.log("2. Ownership transfer initiated to:", MULTISIG);

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("TegridyLPFarming:", address(farm));
        console.log("");
        console.log("=== NEXT STEPS ===");
        console.log("1. TOWELI.approve(farm, amount)");
        console.log("2. farm.notifyRewardAmount(amount) to fund first epoch");
        console.log("3. Update LP_FARMING_ADDRESS in frontend/src/lib/constants.ts");
        console.log("4. Multisig: acceptOwnership()");
        console.log("");
        console.log("=== VERIFY C-01 FIX ===");
        console.log("cast call", address(farm), '"MAX_BOOST_BPS_CEILING()(uint256)"');
        console.log("Expected: 45000");
    }
}
