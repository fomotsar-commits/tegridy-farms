// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/TegridyFarm.sol";

contract FundScript is Script {
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address farmAddress = vm.envAddress("FARM_ADDRESS");
        uint256 fundAmount = vm.envUint("FUND_AMOUNT"); // In wei (18 decimals)

        vm.startBroadcast(deployerPrivateKey);

        IERC20 token = IERC20(TOWELI);
        TegridyFarm farm = TegridyFarm(farmAddress);

        // 1. Approve farm to spend TOWELI
        token.approve(farmAddress, fundAmount);
        console.log("Approved farm to spend", fundAmount, "TOWELI (wei)");

        // 2. Fund the farm
        farm.fund(fundAmount);
        console.log("Farm funded with", fundAmount, "TOWELI (wei)");

        console.log("Total rewards remaining:", farm.totalRewardsRemaining());

        vm.stopBroadcast();
    }
}
