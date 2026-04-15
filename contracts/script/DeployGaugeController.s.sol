// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/GaugeController.sol";

contract DeployGaugeControllerScript is Script {
    address constant TEGRIDY_STAKING = 0x65D8b87917c59a0B33009493fB236bCccF1Ea421;
    uint256 constant EMISSION_BUDGET = 1_000_000e18;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");
        console.log("=== Deploying GaugeController ===");
        vm.startBroadcast();
        GaugeController gauge = new GaugeController(TEGRIDY_STAKING, EMISSION_BUDGET);
        console.log("GaugeController deployed:", address(gauge));
        // Transfer ownership
        address multisig = vm.envOr("MULTISIG", address(0));
        if (multisig != address(0)) {
            gauge.transferOwnership(multisig);
            console.log("Ownership transfer initiated to:", multisig);
        }
        vm.stopBroadcast();
        // Next steps
        console.log("=== NEXT STEPS ===");
        console.log("1. Add gauges: gauge.proposeAddGauge(lpFarmAddress)");
        console.log("2. Wait 24h, then: gauge.executeAddGauge(lpFarmAddress)");
        console.log("3. Update GAUGE_CONTROLLER_ADDRESS in frontend constants.ts");
    }
}
