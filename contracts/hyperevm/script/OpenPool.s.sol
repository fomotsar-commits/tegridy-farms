// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.29;

import {Script, console2 as console} from "forge-std/Script.sol";
import {IUniswapV3Pool} from "v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {V3OpenFeeAdapter} from "protocol-fees/feeAdapters/V3OpenFeeAdapter.sol";

/// @dev The one NonfungiblePositionManager call this script makes (Uniswap v3-periphery IPoolInitializer).
interface IPoolInitializer {
  function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
    external
    payable
    returns (address pool);
}

/// @notice The venue opens a pool and switches the venue's cut on in the same run.
///   NPM=0x… FEE_ADAPTER=0x… TOKEN_A=0x… TOKEN_B=0x… FEE=3000 SQRT_PRICE_X96=<from sqrt-price.mjs> \
///   forge script script/OpenPool.s.sol --rpc-url hyperevm --account <name> --sender <ops> --broadcast --slow
/// Opening a pool costs ~4.6M gas, more than a fast block holds: the sender needs big blocks ON.
/// SQRT_PRICE_X96 is for token1-per-token0 with the two tokens SORTED by address (sqrt-price.mjs does this).
contract OpenPool is Script {
  function run() external returns (address pool) {
    IPoolInitializer npm = IPoolInitializer(vm.envAddress("NPM"));
    V3OpenFeeAdapter adapter = V3OpenFeeAdapter(vm.envAddress("FEE_ADAPTER"));
    address a = vm.envAddress("TOKEN_A");
    address b = vm.envAddress("TOKEN_B");
    uint24 fee = uint24(vm.envUint("FEE"));
    uint160 sqrtPriceX96 = uint160(vm.envUint("SQRT_PRICE_X96"));
    (address token0, address token1) = a < b ? (a, b) : (b, a);

    require(block.chainid == 999 || block.chainid == 998, "HyperEVM (999) or its testnet (998) only");
    require(token0.code.length > 0 && token1.code.length > 0, "a token has no code on this chain");
    require(adapter.FACTORY().owner() == address(adapter), "the Safe has not handed the factory to the adapter yet");

    vm.startBroadcast();
    pool = npm.createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96);
    adapter.triggerFeeUpdate(pool);
    vm.stopBroadcast();

    (,,,,, uint8 feeProtocol,) = IUniswapV3Pool(pool).slot0();
    require(feeProtocol == adapter.getFee(pool), "read-back: the venue's cut is not on");
    console.log("pool:", pool);
    console.log("venue cut (packed feeProtocol):", feeProtocol);
  }
}
