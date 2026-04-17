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
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;

    uint256 constant REWARDS_DURATION = 7 days;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        // LP pair address — set after DeployFinal.s.sol creates the TOWELI/WETH pair
        address tegridyLP = vm.envAddress("TEGRIDY_LP");
        require(tegridyLP != address(0), "Set TEGRIDY_LP env var");

        // New TegridyStaking address — set after DeployFinal.s.sol
        address tegridyStaking = vm.envAddress("TEGRIDY_STAKING");
        require(tegridyStaking != address(0), "Set TEGRIDY_STAKING env var");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("=== Deploying TegridyLPFarming (C-01 fixed) ===");
        console.log("Deployer:", deployer);
        console.log("Reward Token (TOWELI):", TOWELI);
        console.log("Staking Token (LP):", tegridyLP);
        console.log("TegridyStaking (boost source):", tegridyStaking);
        console.log("Treasury:", TREASURY);
        console.log("Rewards Duration (sec):", REWARDS_DURATION);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy the audit-fixed boosted LP farming contract
        TegridyLPFarming farm = new TegridyLPFarming(
            TOWELI,           // _rewardToken
            tegridyLP,        // _stakingToken
            tegridyStaking,   // _tegridyStaking (boost source)
            TREASURY,         // _treasury
            REWARDS_DURATION  // _rewardsDuration
        );
        console.log("1. TegridyLPFarming deployed:", address(farm));

        // Transfer ownership to multisig (initiates 2-step handover)
        address multisig = vm.envOr("MULTISIG", address(0));
        if (multisig != address(0)) {
            farm.transferOwnership(multisig);
            console.log("2. Ownership transfer initiated to:", multisig);
        } else {
            console.log("2. SKIPPED ownership transfer (no MULTISIG env var)");
        }

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
