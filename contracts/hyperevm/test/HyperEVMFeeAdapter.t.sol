// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {UniswapV3FactoryDeployer} from "briefcase/deployers/v3-core/UniswapV3FactoryDeployer.sol";
import {IUniswapV3Factory} from "v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {V3OpenFeeAdapter} from "protocol-fees/feeAdapters/V3OpenFeeAdapter.sol";
import {IV3OpenFeeAdapter} from "protocol-fees/interfaces/IV3OpenFeeAdapter.sol";
import {HyperEVMFeeAdapterDeployer} from "../src/HyperEVMFeeAdapterDeployer.sol";

/// @dev Test-only token. The pools below are Uniswap's real V3 pools (the factory is built from
///      Uniswap's exact initcode); only the coins are stand-ins.
contract TestToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    return true;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    balanceOf[msg.sender] -= amount;
    balanceOf[to] += amount;
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    allowance[from][msg.sender] -= amount;
    balanceOf[from] -= amount;
    balanceOf[to] += amount;
    return true;
  }
}

/// @notice Proves the HyperEVM fee setup does what the plan says:
///   1. the factory is Uniswap's (its pools have Uniswap's canonical pool init code hash),
///   2. after the admin Safe hands the factory to the adapter, nobody but the admin Safe holds a role,
///   3. a new pool pays the venue nothing until anyone presses "trigger", then pays Uniswap's schedule,
///   4. anyone can press "collect", and the venue's cut can only land in the treasury Safe.
contract HyperEVMFeeAdapterTest is Test {
  // Uniswap V3's canonical pool init code hash (v3-periphery PoolAddress.POOL_INIT_CODE_HASH).
  bytes32 constant POOL_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;
  uint160 constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
  uint160 constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
  uint160 constant PRICE_ONE = 79228162514264337593543950336; // 2**96

  address constant TREASURY = address(0x7EA5); // stands in for the HyperEVM treasury Safe
  address constant ADMIN = address(0xAD31); // stands in for the HyperEVM admin Safe
  address constant ANYONE = address(0xB0B);

  IUniswapV3Factory factory;
  HyperEVMFeeAdapterDeployer deployer;
  V3OpenFeeAdapter adapter;
  TestToken tokenA;
  TestToken tokenB;
  address token0;
  address token1;

  function setUp() public {
    // Exactly what Uniswap's Deploy-all.s.sol does: deploy, add the 0.01% tier, hand it to the owner.
    factory = IUniswapV3Factory(address(UniswapV3FactoryDeployer.deploy()));
    factory.enableFeeAmount(100, 1);
    factory.setOwner(ADMIN);

    deployer = new HyperEVMFeeAdapterDeployer{salt: bytes32(uint256(1))}(TREASURY, ADMIN, address(factory));
    adapter = V3OpenFeeAdapter(address(deployer.V3_OPEN_FEE_ADAPTER()));

    // The admin Safe's one transaction after reading the deploy back.
    vm.prank(ADMIN);
    factory.setOwner(address(adapter));

    tokenA = new TestToken();
    tokenB = new TestToken();
    (token0, token1) = address(tokenA) < address(tokenB)
      ? (address(tokenA), address(tokenB))
      : (address(tokenB), address(tokenA));
  }

  // ─── who holds what ──────────────────────────────────────────────

  function test_roles_onlyOurSafesHoldAnything() public view {
    assertEq(factory.owner(), address(adapter), "factory owner must be the adapter");
    assertEq(adapter.owner(), ADMIN, "adapter owner must be the admin Safe");
    assertEq(adapter.feeSetter(), ADMIN, "fee setter must be the admin Safe");
    assertEq(adapter.TOKEN_JAR(), TREASURY, "the cut must only be able to go to the treasury");
    assertEq(address(adapter.FACTORY()), address(factory), "adapter must point at OUR factory");
    assertTrue(adapter.owner() != address(deployer) && adapter.feeSetter() != address(deployer), "deployer keeps no role");
    assertTrue(adapter.owner() != address(this) && adapter.feeSetter() != address(this), "deployer EOA keeps no role");
  }

  function test_feeSchedule_isUniswapsMainnetSchedule() public view {
    assertEq(adapter.feeTierDefaults(100), 4 << 4 | 4, "0.01% tier: 1/4");
    assertEq(adapter.feeTierDefaults(500), 4 << 4 | 4, "0.05% tier: 1/4");
    assertEq(adapter.feeTierDefaults(3000), 6 << 4 | 6, "0.30% tier: 1/6");
    assertEq(adapter.feeTierDefaults(10_000), 6 << 4 | 6, "1.00% tier: 1/6");
    assertEq(adapter.defaultFee(), 4 << 4 | 4, "global default: 1/4");
    assertEq(adapter.feeTiers(0), 100);
    assertEq(adapter.feeTiers(3), 10_000);
  }

  function test_onlyAdminSafeCanChangeAnything() public {
    vm.startPrank(ANYONE);
    vm.expectRevert(IV3OpenFeeAdapter.Unauthorized.selector);
    adapter.setFeeTierDefault(3000, 0);
    vm.expectRevert(IV3OpenFeeAdapter.Unauthorized.selector);
    adapter.setPoolOverride(address(1), 0);
    vm.expectRevert("UNAUTHORIZED");
    adapter.setFeeSetter(ANYONE);
    vm.expectRevert("UNAUTHORIZED");
    adapter.setFactoryOwner(ANYONE);
    vm.expectRevert("UNAUTHORIZED");
    adapter.transferOwnership(ANYONE);
    vm.stopPrank();

    // The deployer contract cannot act either: it gave every role away in its constructor.
    vm.startPrank(address(deployer));
    vm.expectRevert(IV3OpenFeeAdapter.Unauthorized.selector);
    adapter.setFeeTierDefault(3000, 0);
    vm.expectRevert("UNAUTHORIZED");
    adapter.setFactoryOwner(address(deployer));
    vm.stopPrank();

    vm.prank(ADMIN);
    adapter.setFeeTierDefault(3000, 7 << 4 | 7);
    assertEq(adapter.feeTierDefaults(3000), 7 << 4 | 7);
  }

  // ─── the factory is Uniswap's ────────────────────────────────────

  function test_poolsHaveUniswapsCanonicalInitCodeHash() public {
    address pool = factory.createPool(token0, token1, 3000);
    address expected = address(
      uint160(
        uint256(
          keccak256(
            abi.encodePacked(
              hex"ff", address(factory), keccak256(abi.encode(token0, token1, uint24(3000))), POOL_INIT_CODE_HASH
            )
          )
        )
      )
    );
    assertEq(pool, expected, "pool code is not Uniswap's canonical V3 pool");
    assertEq(factory.feeAmountTickSpacing(100), 1, "0.01% tier enabled as Uniswap does");
    assertEq(factory.feeAmountTickSpacing(500), 10);
    assertEq(factory.feeAmountTickSpacing(3000), 60);
    assertEq(factory.feeAmountTickSpacing(10_000), 200);
  }

  // ─── the venue's cut ─────────────────────────────────────────────

  function test_newPoolPaysNothingUntilTrigger_thenUniswapsSchedule() public {
    uint24[4] memory tiers = [uint24(100), 500, 3000, 10_000];
    uint8[4] memory want = [uint8(4 << 4 | 4), 4 << 4 | 4, 6 << 4 | 6, 6 << 4 | 6];
    for (uint256 i; i < 4; i++) {
      address pool = factory.createPool(token0, token1, tiers[i]);
      IUniswapV3Pool(pool).initialize(PRICE_ONE);
      assertEq(_feeProtocol(pool), 0, "a new pool starts paying the venue nothing");
      vm.prank(ANYONE);
      adapter.triggerFeeUpdate(pool);
      assertEq(_feeProtocol(pool), want[i], "after trigger: Uniswap's schedule");
    }
  }

  function test_triggerSkipsAPoolWithNoPriceYet() public {
    address pool = factory.createPool(token0, token1, 3000);
    adapter.triggerFeeUpdate(pool); // does not revert
    assertEq(_feeProtocol(pool), 0, "no price yet: still 0, the job must come back for it");
    IUniswapV3Pool(pool).initialize(PRICE_ONE);
    adapter.triggerFeeUpdate(pool);
    assertEq(_feeProtocol(pool), 6 << 4 | 6);
  }

  function test_beforeTheSafeHandsOverTheFactory_nobodyCanSwitchTheCutOn() public {
    // A second factory still owned by the admin Safe, as it is between the deploy and the Safe's step.
    IUniswapV3Factory f2 = IUniswapV3Factory(address(UniswapV3FactoryDeployer.deploy()));
    f2.enableFeeAmount(100, 1);
    f2.setOwner(ADMIN);
    V3OpenFeeAdapter a2 = V3OpenFeeAdapter(
      address(new HyperEVMFeeAdapterDeployer{salt: bytes32(uint256(2))}(TREASURY, ADMIN, address(f2)).V3_OPEN_FEE_ADAPTER())
    );
    address pool = f2.createPool(token0, token1, 3000);
    IUniswapV3Pool(pool).initialize(PRICE_ONE);
    vm.expectRevert();
    a2.triggerFeeUpdate(pool);
    assertEq(_feeProtocol(pool), 0);
  }

  function test_deployerRefusesAFactoryWithoutTheOnePipTier() public {
    // Deploy-all adds the 0.01% tier before handing the factory over. Without it the adapter
    // setup reverts as a whole, so a half-configured adapter can never exist.
    IUniswapV3Factory f3 = IUniswapV3Factory(address(UniswapV3FactoryDeployer.deploy()));
    vm.expectRevert(IV3OpenFeeAdapter.InvalidFeeTier.selector);
    new HyperEVMFeeAdapterDeployer{salt: bytes32(uint256(3))}(TREASURY, ADMIN, address(f3));
  }

  function test_collect_anyoneCanPress_moneyOnlyReachesTheTreasury() public {
    address pool = factory.createPool(token0, token1, 3000);
    IUniswapV3Pool(pool).initialize(PRICE_ONE);
    adapter.triggerFeeUpdate(pool);

    // An LP adds full-range liquidity, then trades go through in both directions.
    TestToken(token0).mint(address(this), 1_000_000e18);
    TestToken(token1).mint(address(this), 1_000_000e18);
    IUniswapV3Pool(pool).mint(address(this), -887_220, 887_220, 1_000e18, "");
    IUniswapV3Pool(pool).swap(address(this), true, 10e18, MIN_SQRT_RATIO_PLUS_ONE, "");
    IUniswapV3Pool(pool).swap(address(this), false, 10e18, MAX_SQRT_RATIO_MINUS_ONE, "");

    (uint128 owed0, uint128 owed1) = IUniswapV3Pool(pool).protocolFees();
    // 1/6 of the 0.3% fee on each 10-coin trade: 10e18 * 3000 / 1e6 / 6 = 0.005 coin
    assertEq(owed0, 5e15, "venue's cut in token0");
    assertEq(owed1, 5e15, "venue's cut in token1");

    IV3OpenFeeAdapter.CollectParams[] memory p = new IV3OpenFeeAdapter.CollectParams[](1);
    p[0] = IV3OpenFeeAdapter.CollectParams({pool: pool, amount0Requested: type(uint128).max, amount1Requested: type(uint128).max});
    vm.prank(ANYONE);
    adapter.collect(p);

    // Uniswap V3 leaves 1 wei in the pool on a full collect (gas saving in collectProtocol).
    assertEq(TestToken(token0).balanceOf(TREASURY), owed0 - 1, "treasury got the token0 cut");
    assertEq(TestToken(token1).balanceOf(TREASURY), owed1 - 1, "treasury got the token1 cut");
    assertEq(TestToken(token0).balanceOf(ANYONE), 0, "the presser gets nothing");
    assertEq(TestToken(token0).balanceOf(address(adapter)), 0, "the adapter keeps nothing");
  }

  // ─── Uniswap pool callbacks (this test contract is the LP and the trader) ──

  function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
    if (amount0Owed > 0) TestToken(token0).transfer(msg.sender, amount0Owed);
    if (amount1Owed > 0) TestToken(token1).transfer(msg.sender, amount1Owed);
  }

  function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
    if (amount0Delta > 0) TestToken(token0).transfer(msg.sender, uint256(amount0Delta));
    if (amount1Delta > 0) TestToken(token1).transfer(msg.sender, uint256(amount1Delta));
  }

  function _feeProtocol(address pool) internal view returns (uint8 feeProtocol) {
    (,,,,, feeProtocol,) = IUniswapV3Pool(pool).slot0();
  }
}
