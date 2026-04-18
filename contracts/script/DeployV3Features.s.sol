// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/TegridyLending.sol";
import "../src/TegridyDrop.sol";
import "../src/TegridyLaunchpad.sol";
import "../src/TegridyNFTPool.sol";
import "../src/TegridyNFTPoolFactory.sol";

/// @title DeployV3Features - Deploy Lending, Launchpad, and NFT AMM contracts
/// @dev Deploys 5 new protocol contracts with mainnet constants from DeployFinal.s.sol
contract DeployV3FeaturesScript is Script {
    // ─── Mainnet Constants (from DeployFinal.s.sol) ─────────────────
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant TREASURY = 0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e;
    address constant TEGRIDY_STAKING = 0x626644523d34B84818df602c991B4a06789C4819;

    // ─── Default Fees ───────────────────────────────────────────────
    uint256 constant LENDING_FEE_BPS = 500;     // 5% of interest earned
    uint16 constant LAUNCHPAD_FEE_BPS = 500;    // 5% of mint revenue
    uint256 constant POOL_FEE_BPS = 50;         // 0.5% protocol fee on NFT swaps

    struct V3Deployed {
        address lending;
        address drop;
        address launchpad;
        address nftPool;
        address nftPoolFactory;
    }

    function run() external {
        require(block.chainid == 1, "MAINNET_ONLY");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address multisig = vm.envAddress("MULTISIG");
        require(multisig != address(0), "MULTISIG env var required");

        console.log("Deployer:", deployer);
        console.log("Multisig:", multisig);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        V3Deployed memory d;

        // 1. TegridyLending - P2P NFT-collateralized lending
        TegridyLending lending = new TegridyLending(TREASURY, LENDING_FEE_BPS, WETH);
        d.lending = address(lending);
        console.log("1. TegridyLending:", d.lending);

        // 2. TegridyDrop - Template contract (used by Launchpad clones)
        //    Note: TegridyDrop is deployed automatically inside TegridyLaunchpad constructor
        //    We deploy a standalone reference here for ABI verification
        TegridyDrop drop = new TegridyDrop();
        d.drop = address(drop);
        console.log("2. TegridyDrop (template):", d.drop);

        // 3. TegridyLaunchpad - NFT collection factory (deploys TegridyDrop clones)
        TegridyLaunchpad launchpad = new TegridyLaunchpad(
            deployer,
            LAUNCHPAD_FEE_BPS,
            TREASURY,
            WETH
        );
        d.launchpad = address(launchpad);
        console.log("3. TegridyLaunchpad:", d.launchpad);

        // 4. TegridyNFTPool - Template contract (used by Factory clones)
        //    Note: TegridyNFTPool is deployed automatically inside TegridyNFTPoolFactory constructor
        //    We deploy a standalone reference here for ABI verification
        TegridyNFTPool nftPool = new TegridyNFTPool();
        d.nftPool = address(nftPool);
        console.log("4. TegridyNFTPool (template):", d.nftPool);

        // 5. TegridyNFTPoolFactory - NFT AMM pool factory
        TegridyNFTPoolFactory nftPoolFactory = new TegridyNFTPoolFactory(
            deployer,
            POOL_FEE_BPS,
            TREASURY,
            WETH
        );
        d.nftPoolFactory = address(nftPoolFactory);
        console.log("5. TegridyNFTPoolFactory:", d.nftPoolFactory);

        // ─── Transfer ownership to multisig ─────────────────────────
        lending.transferOwnership(multisig);
        launchpad.transferOwnership(multisig);
        nftPoolFactory.transferOwnership(multisig);
        console.log("");
        console.log("6. Ownership transfer initiated for 3 contracts to:", multisig);

        vm.stopBroadcast();

        // ─── Summary ────────────────────────────────────────────────
        console.log("");
        console.log("=== V3 DEPLOYMENT COMPLETE ===");
        console.log("TegridyLending:        ", d.lending);
        console.log("TegridyDrop (template):", d.drop);
        console.log("TegridyLaunchpad:      ", d.launchpad);
        console.log("TegridyNFTPool (tpl):  ", d.nftPool);
        console.log("TegridyNFTPoolFactory: ", d.nftPoolFactory);
        console.log("");
        console.log("NEXT STEPS:");
        console.log("  1. Multisig: acceptOwnership() on TegridyLending, TegridyLaunchpad, TegridyNFTPoolFactory");
        console.log("  2. Update frontend constants with deployed addresses");
        console.log("  3. Verify all 5 contracts on Etherscan");
    }
}
