// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/LPFarming.sol";

/// @title DeployLPFarming — Deploy LP staking rewards contract
/// @notice Synthetix StakingRewards adaptation for TOWELI/WETH LP farming
contract DeployLPFarmingScript is Script {
    // ─── Mainnet Constants ───────────────────────────────────────────
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;

    uint256 constant REWARDS_DURATION = 7 days;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        // LP address must be set after pair creation
        address tegridyLP = vm.envAddress("TEGRIDY_LP");
        require(tegridyLP != address(0), "Set TEGRIDY_LP env var");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("=== Deploying LPFarming ===");
        console.log("Deployer:", deployer);
        console.log("Reward Token (TOWELI):", TOWELI);
        console.log("Staking Token (LP):", tegridyLP);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy LPFarming
        LPFarming farm = new LPFarming(TOWELI, tegridyLP, TREASURY, REWARDS_DURATION);
        console.log("1. LPFarming deployed:", address(farm));

        // 2. Transfer ownership to multisig
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
        console.log("LPFarming:", address(farm));
        console.log("");
        console.log("=== NEXT STEPS ===");
        console.log("1. TOWELI.approve(farm, amount)");
        console.log("2. farm.notifyRewardAmount(amount) to fund first epoch");
        console.log("3. Update LP_FARMING_ADDRESS in frontend constants.ts");
        console.log("4. Multisig: acceptOwnership()");
    }
}
