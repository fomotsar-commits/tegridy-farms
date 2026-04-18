// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/TegridyTokenURIReader.sol";

contract DeployTokenURIReaderScript is Script {
    address constant TEGRIDY_STAKING = 0x626644523d34B84818df602c991B4a06789C4819;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deployer:", deployer);
        console.log("Staking:", TEGRIDY_STAKING);

        vm.startBroadcast(deployerPrivateKey);

        TegridyTokenURIReader reader = new TegridyTokenURIReader(TEGRIDY_STAKING);
        console.log("TegridyTokenURIReader:", address(reader));

        vm.stopBroadcast();

        console.log("");
        console.log("NEXT STEPS:");
        console.log("  1. Verify on Etherscan");
        console.log("  2. Marketplaces/frontends can query reader.tokenURI(tokenId) directly");
    }
}
