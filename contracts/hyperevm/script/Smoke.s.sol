// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.29;

import {Script, console2 as console} from "forge-std/Script.sol";
import {IUniswapV3Pool} from "v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {V3OpenFeeAdapter} from "protocol-fees/feeAdapters/V3OpenFeeAdapter.sol";
import {IV3OpenFeeAdapter} from "protocol-fees/interfaces/IV3OpenFeeAdapter.sol";

interface IERC20Min {
  function approve(address, uint256) external returns (bool);
  function balanceOf(address) external view returns (uint256);
}

interface IWETH9 is IERC20Min {
  function deposit() external payable;
}

interface INPM {
  struct MintParams {
    address token0;
    address token1;
    uint24 fee;
    int24 tickLower;
    int24 tickUpper;
    uint256 amount0Desired;
    uint256 amount1Desired;
    uint256 amount0Min;
    uint256 amount1Min;
    address recipient;
    uint256 deadline;
  }

  function createAndInitializePoolIfNecessary(address, address, uint24, uint160) external payable returns (address);
  function mint(MintParams calldata) external payable returns (uint256, uint128, uint256, uint256);
}

interface IUniversalRouter {
  function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
  function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

contract SmokeToken {
  string public name = "Tegridy HyperEVM smoke";
  string public symbol = "SMOKE";
  uint8 public decimals = 18;
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  constructor(uint256 supply) {
    balanceOf[msg.sender] = supply;
  }

  function approve(address s, uint256 a) external returns (bool) {
    allowance[msg.sender][s] = a;
    return true;
  }

  function transfer(address to, uint256 a) external returns (bool) {
    balanceOf[msg.sender] -= a;
    balanceOf[to] += a;
    return true;
  }

  function transferFrom(address f, address to, uint256 a) external returns (bool) {
    if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
    balanceOf[f] -= a;
    balanceOf[to] += a;
    return true;
  }
}

/// @notice Dress rehearsal of the money path, on a local fork or testnet 998 ONLY:
///   open a pool + switch the cut on, add liquidity, buy and sell through OUR UniversalRouter with the
///   site fee (PAY_PORTION, in the order the site sends it), then collect the pool cut. Every payment
///   to the treasury is read back. It makes a junk SMOKE pool, so chain 999 needs REHEARSAL=yes (a fork).
///   NPM=… UNIVERSAL_ROUTER=… FEE_ADAPTER=… TREASURY_SAFE=… [REHEARSAL=yes] forge script script/Smoke.s.sol --broadcast
contract Smoke is Script {
  address constant WHYPE = 0x5555555555555555555555555555555555555555;
  address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
  // universal-router Commands.sol / ActionConstants.sol
  uint8 constant V3_SWAP_EXACT_IN = 0x00;
  uint8 constant PAY_PORTION = 0x06;
  uint8 constant WRAP_ETH = 0x0b;
  uint8 constant UNWRAP_WETH = 0x0c;
  address constant MSG_SENDER = address(1);
  address constant ADDRESS_THIS = address(2);
  uint256 constant CONTRACT_BALANCE = 1 << 255;
  uint256 constant SITE_FEE_BIPS = 50; // a stand-in rate: the real one is the owner's decision
  uint24 constant FEE = 3000;

  INPM npm;
  IUniversalRouter ur;
  V3OpenFeeAdapter adapter;
  address treasury;
  SmokeToken smoke;
  address pool;
  address t0;
  address t1;

  function run() external {
    bool rehearsal = keccak256(bytes(vm.envOr("REHEARSAL", string("")))) == keccak256("yes");
    require(block.chainid == 998 || (block.chainid == 999 && rehearsal), "998, or a 999 fork with REHEARSAL=yes");
    npm = INPM(vm.envAddress("NPM"));
    ur = IUniversalRouter(vm.envAddress("UNIVERSAL_ROUTER"));
    adapter = V3OpenFeeAdapter(vm.envAddress("FEE_ADAPTER"));
    treasury = vm.envAddress("TREASURY_SAFE");
    require(adapter.TOKEN_JAR() == treasury, "TREASURY_SAFE is not where the adapter pays");

    vm.startBroadcast();
    _openPoolAndAddLiquidity();
    uint256 feeOnBuy = _buy();
    uint256 feeOnSell = _sell();
    (uint256 cut0, uint256 cut1) = _collect();
    vm.stopBroadcast();

    console.log("pool:", pool);
    console.log("site fee on the buy (HYPE wei):", feeOnBuy);
    console.log("site fee on the sell (wrapped HYPE wei):", feeOnSell);
    console.log("pool cut collected token0 / token1 (wei):", cut0, cut1);
    console.log("SMOKE PASSED: every venue payment reached the treasury");
  }

  /// 1. open the pool at 1 SMOKE = 1 wrapped HYPE, switch the venue cut on, add 1 + 1 across the full range
  function _openPoolAndAddLiquidity() internal {
    smoke = new SmokeToken(1_000_000 ether);
    IWETH9(WHYPE).deposit{value: 1 ether}();
    (t0, t1) = WHYPE < address(smoke) ? (WHYPE, address(smoke)) : (address(smoke), WHYPE);
    pool = npm.createAndInitializePoolIfNecessary(t0, t1, FEE, 79228162514264337593543950336);
    adapter.triggerFeeUpdate(pool);
    (,,,,, uint8 feeProtocol,) = IUniswapV3Pool(pool).slot0();
    require(feeProtocol == 6 << 4 | 6, "the venue cut is not on after trigger");
    IWETH9(WHYPE).approve(address(npm), type(uint256).max);
    smoke.approve(address(npm), type(uint256).max);
    npm.mint(INPM.MintParams(t0, t1, FEE, -887_220, 887_220, 1 ether, 1 ether, 0, 0, msg.sender, block.timestamp + 600));
  }

  /// 2. buy SMOKE with 0.1 HYPE: the site fee comes off the HYPE first (the site's buyWithEth order)
  function _buy() internal returns (uint256 fee) {
    uint256 before = treasury.balance;
    bytes[] memory inputs = new bytes[](3);
    inputs[0] = abi.encode(address(0), treasury, SITE_FEE_BIPS);
    inputs[1] = abi.encode(ADDRESS_THIS, CONTRACT_BALANCE);
    inputs[2] = abi.encode(
      MSG_SENDER, CONTRACT_BALANCE, uint256(0), abi.encodePacked(WHYPE, FEE, address(smoke)), false, new uint256[](0)
    );
    ur.execute{value: 0.1 ether}(abi.encodePacked(PAY_PORTION, WRAP_ETH, V3_SWAP_EXACT_IN), inputs, block.timestamp + 600);
    fee = treasury.balance - before;
    require(fee == 0.1 ether * SITE_FEE_BIPS / 10_000, "buy: the treasury did not get the site fee");
    require(smoke.balanceOf(msg.sender) > 1_000_000 ether - 1 ether, "buy: the buyer got no SMOKE");
  }

  /// 3. sell 0.05 SMOKE: swap into wrapped HYPE held by the router, fee off that, unwrap the rest to the seller
  function _sell() internal returns (uint256 fee) {
    uint256 before = IERC20Min(WHYPE).balanceOf(treasury);
    smoke.approve(PERMIT2, type(uint256).max);
    IPermit2(PERMIT2).approve(address(smoke), address(ur), type(uint160).max, uint48(block.timestamp + 600));
    bytes[] memory inputs = new bytes[](3);
    inputs[0] = abi.encode(
      ADDRESS_THIS, uint256(0.05 ether), uint256(0), abi.encodePacked(address(smoke), FEE, WHYPE), true, new uint256[](0)
    );
    inputs[1] = abi.encode(WHYPE, treasury, SITE_FEE_BIPS);
    inputs[2] = abi.encode(MSG_SENDER, uint256(0));
    ur.execute(abi.encodePacked(V3_SWAP_EXACT_IN, PAY_PORTION, UNWRAP_WETH), inputs, block.timestamp + 600);
    fee = IERC20Min(WHYPE).balanceOf(treasury) - before;
    require(fee > 0, "sell: the treasury did not get the site fee");
  }

  /// 4. the pool cut (1/6 of the 0.3% fee) built up in both coins; anyone collects it into the treasury
  function _collect() internal returns (uint256 cut0, uint256 cut1) {
    (uint128 owed0, uint128 owed1) = IUniswapV3Pool(pool).protocolFees();
    require(owed0 > 1 && owed1 > 1, "the pool cut did not build up");
    uint256 b0 = IERC20Min(t0).balanceOf(treasury);
    uint256 b1 = IERC20Min(t1).balanceOf(treasury);
    IV3OpenFeeAdapter.CollectParams[] memory p = new IV3OpenFeeAdapter.CollectParams[](1);
    p[0] = IV3OpenFeeAdapter.CollectParams(pool, type(uint128).max, type(uint128).max);
    adapter.collect(p);
    cut0 = IERC20Min(t0).balanceOf(treasury) - b0;
    cut1 = IERC20Min(t1).balanceOf(treasury) - b1;
    require(cut0 == owed0 - 1 && cut1 == owed1 - 1, "collect: the cut did not reach the treasury");
  }
}
