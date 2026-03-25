// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/TegridyStaking.sol";
import "../src/TegridyFactory.sol";
import "../src/TegridyRouter.sol";
import "../src/TegridyRestaking.sol";

contract DeployFinalScript is Script {
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant JBAC_NFT = 0xd37264c71e9af940e49795F0d3a8336afAaFDdA9;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;

    // Reward rate: ~0.8243 TOWELI per second (same as original farm)
    uint256 constant REWARD_PER_SECOND = 824300000000000000;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deployer:", deployer);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // 1. TegridyStaking (unified lock + boost + NFT positions)
        TegridyStaking staking = new TegridyStaking(TOWELI, JBAC_NFT, TREASURY, REWARD_PER_SECOND);
        console.log("1. TegridyStaking:", address(staking));

        // 2. TegridyFactory (creates AMM pools)
        TegridyFactory factory = new TegridyFactory(deployer);
        factory.setFeeTo(TREASURY);
        console.log("2. TegridyFactory:", address(factory));

        // 3. TegridyRouter (swap + liquidity routing)
        TegridyRouter router = new TegridyRouter(address(factory), WETH);
        console.log("3. TegridyRouter:", address(router));

        // 4. TegridyRestaking (bonus yield on staking NFTs, WETH rewards)
        TegridyRestaking restaking = new TegridyRestaking(
            address(staking),
            TOWELI,
            WETH, // bonus reward token
            0     // bonus rate set later after funding
        );
        console.log("4. TegridyRestaking:", address(restaking));

        // 5. Create initial TOWELI/WETH pool on our DEX
        address toweliWethPair = factory.createPair(TOWELI, WETH);
        console.log("5. TOWELI/WETH Pair:", toweliWethPair);

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("");
        console.log("TegridyStaking:", address(staking));
        console.log("TegridyFactory:", address(factory));
        console.log("TegridyRouter:", address(router));
        console.log("TegridyRestaking:", address(restaking));
        console.log("TOWELI/WETH Pair:", toweliWethPair);
        console.log("Treasury:", TREASURY);
        console.log("");
        console.log("NEXT STEPS:");
        console.log("1. Fund TegridyStaking with TOWELI rewards via fund()");
        console.log("2. Add liquidity to TOWELI/WETH pair via router");
        console.log("3. Fund TegridyRestaking with WETH for bonus rewards");
        console.log("4. Set bonus reward rate on TegridyRestaking");
        console.log("5. Update frontend constants.ts with deployed addresses");
    }
}
