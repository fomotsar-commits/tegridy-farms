// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.29;

import {Script, console2 as console} from "forge-std/Script.sol";
import {V3OpenFeeAdapter} from "protocol-fees/feeAdapters/V3OpenFeeAdapter.sol";
import {HyperEVMPoolOpener, IFeeSwitch} from "../src/HyperEVMPoolOpener.sol";

/// @notice After the fee switch owns the factory: the contract through which anyone opens a pool
///   for POOL_OPENING_FEE (0.23 HYPE), paid to the treasury Safe.
///   FEE_ADAPTER=0x… TREASURY_SAFE=0x… \
///   forge script script/DeployPoolOpener.s.sol --rpc-url hyperevm --account <name> --sender <deployer> --broadcast --slow
/// One small transaction. The opener has no owner: the deployer keeps nothing.
contract DeployPoolOpener is Script {
  function run() external returns (HyperEVMPoolOpener opener) {
    V3OpenFeeAdapter adapter = V3OpenFeeAdapter(vm.envAddress("FEE_ADAPTER"));
    address treasury = vm.envAddress("TREASURY_SAFE");

    require(block.chainid == 999 || block.chainid == 998, "HyperEVM (999) or its testnet (998) only");
    require(address(adapter).code.length > 0, "FEE_ADAPTER has no code on this chain");
    require(adapter.TOKEN_JAR() == treasury, "TREASURY_SAFE is not where the fee switch sends the venue's cut");
    require(adapter.FACTORY().owner() == address(adapter), "the Safe has not handed the factory to the fee switch yet");

    vm.startBroadcast();
    opener = new HyperEVMPoolOpener(IFeeSwitch(address(adapter)), treasury);
    vm.stopBroadcast();

    require(opener.TREASURY() == treasury, "read-back: treasury");
    require(address(opener.FEE_SWITCH()) == address(adapter), "read-back: fee switch");
    require(address(opener.FACTORY()) == address(adapter.FACTORY()), "read-back: factory");
    require(opener.POOL_OPENING_FEE() == 0.23 ether, "read-back: fee");
    require(opener.poolCount() == 0, "read-back: no pools yet");
    console.log("HyperEVMPoolOpener:", address(opener));
    console.log("opening fee (wei):", opener.POOL_OPENING_FEE());
    console.log("paid to:", treasury);
  }
}
