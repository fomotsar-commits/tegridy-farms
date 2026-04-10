// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/TegridyRouter.sol";

/// @title DeployTegridyRouter — Deploy native Tegridy DEX router
/// @notice Uses existing TegridyFactory (0x8B78...) + creates TOWELI/WETH pair
contract DeployTegridyRouterScript is Script {
    // ─── Mainnet Constants ───────────────────────────────────────────
    address constant TEGRIDY_FACTORY = 0x8B786163aA3beb97822d480a0c306DfD6dEbdCB6;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("=== Deploying TegridyRouter ===");
        console.log("Deployer:", deployer);
        console.log("Factory:", TEGRIDY_FACTORY);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy TegridyRouter
        TegridyRouter router = new TegridyRouter(TEGRIDY_FACTORY, WETH);
        console.log("1. TegridyRouter deployed:", address(router));

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("TegridyRouter:", address(router));
        console.log("");
        console.log("=== NEXT STEPS (from feeToSetter wallet) ===");
        console.log("1. TegridyFactory.setFeeTo(TREASURY) to activate protocol fees");
        console.log("2. TegridyFactory.createPair(TOWELI, WETH)");
        console.log("3. Approve TOWELI to router, then addLiquidityETH to seed pool");
        console.log("4. Update TEGRIDY_ROUTER_ADDRESS in frontend constants.ts");
    }
}
