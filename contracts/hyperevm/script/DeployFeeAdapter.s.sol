// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.29;

import {Script, console2 as console} from "forge-std/Script.sol";
import {IUniswapV3Factory} from "v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {V3OpenFeeAdapter} from "protocol-fees/feeAdapters/V3OpenFeeAdapter.sol";
import {HyperEVMFeeAdapterDeployer} from "../src/HyperEVMFeeAdapterDeployer.sol";

/// @notice Step 3 of the HyperEVM deploy (README.md): Uniswap's fee switch for OUR factory.
///   TREASURY_SAFE=0x… ADMIN_SAFE=0x… V3_FACTORY=0x… \
///   forge script script/DeployFeeAdapter.s.sol --rpc-url hyperevm --account <name> --sender <deployer> --broadcast --slow
/// Refuses to run unless both Safes exist on this chain and the factory is exactly as Uniswap's
/// Deploy-all leaves it (owned by the admin Safe, 0.01% tier added). Reads everything back after.
contract DeployFeeAdapter is Script {
  function run() external returns (address adapter) {
    address treasury = vm.envAddress("TREASURY_SAFE");
    address admin = vm.envAddress("ADMIN_SAFE");
    address factory = vm.envAddress("V3_FACTORY");

    require(block.chainid == 999 || block.chainid == 998, "HyperEVM (999) or its testnet (998) only");
    require(treasury != admin, "treasury and admin must be two different Safes");
    require(treasury.code.length > 0, "TREASURY_SAFE has no code on this chain: create the Safe first");
    require(admin.code.length > 0, "ADMIN_SAFE has no code on this chain: create the Safe first");
    require(IUniswapV3Factory(factory).owner() == admin, "V3_FACTORY is not owned by ADMIN_SAFE");
    require(IUniswapV3Factory(factory).feeAmountTickSpacing(100) == 1, "V3_FACTORY lacks the 0.01% tier");

    vm.startBroadcast();
    HyperEVMFeeAdapterDeployer d = new HyperEVMFeeAdapterDeployer{salt: bytes32(uint256(1))}(treasury, admin, factory);
    vm.stopBroadcast();

    adapter = address(d.V3_OPEN_FEE_ADAPTER());
    V3OpenFeeAdapter a = V3OpenFeeAdapter(adapter);
    require(a.owner() == admin, "read-back: adapter owner");
    require(a.feeSetter() == admin, "read-back: fee setter");
    require(a.TOKEN_JAR() == treasury, "read-back: treasury");
    require(address(a.FACTORY()) == factory, "read-back: factory");

    console.log("V3OpenFeeAdapter:", adapter);
    console.log("NEXT, in the ADMIN Safe (Safe app, HyperEVM): one transaction");
    console.log("  to:   ", factory);
    console.log("  value: 0");
    console.log("  data: ", vm.toString(abi.encodeCall(IUniswapV3Factory.setOwner, (adapter))));
    console.log("  (= setOwner(adapter): hands the factory to Uniswap's fee switch)");
  }
}
