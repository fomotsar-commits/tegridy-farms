// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {UniswapV3FactoryDeployer} from "briefcase/deployers/v3-core/UniswapV3FactoryDeployer.sol";
import {IUniswapV3Factory} from "v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {V3OpenFeeAdapter} from "protocol-fees/feeAdapters/V3OpenFeeAdapter.sol";
import {HyperEVMFeeAdapterDeployer} from "../src/HyperEVMFeeAdapterDeployer.sol";
import {HyperEVMPoolOpener, IFeeSwitch} from "../src/HyperEVMPoolOpener.sol";

/// @dev A coin with code: the opener only checks that a token is a contract.
contract Coin {}

/// @dev Stands in for the treasury Safe: a contract that takes HYPE (or, switched, refuses it).
contract Treasury {
  bool public refuse;

  function setRefuse(bool r) external {
    refuse = r;
  }

  receive() external payable {
    require(!refuse, "refused");
  }
}

/// @dev Answers token0/token1/fee/slot0 exactly as a real pool of those coins would, but was not made by the factory.
contract FakePool {
  address public immutable token0;
  address public immutable token1;
  uint24 public immutable fee;

  constructor(address t0, address t1, uint24 f) {
    (token0, token1, fee) = (t0, t1, f);
  }

  function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
    return (uint160(1 << 96), 0, 0, 1, 1, 0, true);
  }
}

/// @notice The opener, on Uniswap's exact V3 factory code and Uniswap's own fee switch:
///   1. an opening pays exactly 0.23 HYPE, and every wei of it lands in the treasury,
///   2. the pool opens at the opener's price with the venue's cut already on, and is listed,
///   3. it refuses a pool that already has a price, wrong payments, unsorted or code-less tokens,
///   4. it holds nothing, and has no owner and no setting anyone could change.
contract HyperEVMPoolOpenerTest is Test {
  uint160 constant PRICE_ONE = 79228162514264337593543950336; // 2**96
  uint256 constant FEE = 0.23 ether;
  address constant ADMIN = address(0xAD31);
  address constant OPENER = address(0x0BE7);

  IUniswapV3Factory factory;
  V3OpenFeeAdapter adapter;
  Treasury treasury;
  HyperEVMPoolOpener opener;
  address token0;
  address token1;

  event PoolOpened(address indexed pool, address indexed token0, address indexed token1, uint24 fee, uint160 sqrtPriceX96, address opener);
  event PoolListed(address indexed pool, address indexed token0, address indexed token1, uint24 fee, address lister);

  function setUp() public {
    factory = IUniswapV3Factory(address(UniswapV3FactoryDeployer.deploy()));
    factory.enableFeeAmount(100, 1);
    factory.setOwner(ADMIN);
    treasury = new Treasury();
    HyperEVMFeeAdapterDeployer d = new HyperEVMFeeAdapterDeployer{salt: bytes32(uint256(1))}(address(treasury), ADMIN, address(factory));
    adapter = V3OpenFeeAdapter(address(d.V3_OPEN_FEE_ADAPTER()));
    vm.prank(ADMIN);
    factory.setOwner(address(adapter));

    opener = new HyperEVMPoolOpener(IFeeSwitch(address(adapter)), address(treasury));
    address a = address(new Coin());
    address b = address(new Coin());
    (token0, token1) = a < b ? (a, b) : (b, a);
    vm.deal(OPENER, 10 ether);
  }

  function _open(uint24 fee, uint160 price) internal returns (address) {
    vm.prank(OPENER);
    return opener.open{value: FEE}(token0, token1, fee, price);
  }

  // ─── what it is ──────────────────────────────────────────────────

  function test_fixedAtDeploy_noOwnerNoSettings() public view {
    assertEq(opener.POOL_OPENING_FEE(), 0.23 ether, "the owner's ruling: 0.23 HYPE");
    assertEq(address(opener.FACTORY()), address(factory));
    assertEq(address(opener.FEE_SWITCH()), address(adapter));
    assertEq(opener.TREASURY(), address(treasury));
    assertEq(opener.poolCount(), 0);
  }

  function test_constructor_refusesAPlainWalletTreasury() public {
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.NoCode.selector, address(0x7EA5)));
    new HyperEVMPoolOpener(IFeeSwitch(address(adapter)), address(0x7EA5));
  }

  function test_constructor_refusesAFeeSwitchThatDoesNotOwnItsFactory() public {
    IUniswapV3Factory other = IUniswapV3Factory(address(UniswapV3FactoryDeployer.deploy()));
    other.enableFeeAmount(100, 1); // the fee-switch deployer needs the 0.01% tier
    // `other` is still owned by this test, not by its fee switch: the Safe never handed it over.
    HyperEVMFeeAdapterDeployer d = new HyperEVMFeeAdapterDeployer{salt: bytes32(uint256(2))}(address(treasury), ADMIN, address(other));
    IFeeSwitch unowned = IFeeSwitch(address(d.V3_OPEN_FEE_ADAPTER())); // read first: a getter eats expectRevert
    vm.expectRevert(HyperEVMPoolOpener.WrongFactory.selector);
    new HyperEVMPoolOpener(unowned, address(treasury));
  }

  // ─── an opening ──────────────────────────────────────────────────

  function test_open_paysTheTreasuryExactly_opensAtThePrice_cutOn_listed() public {
    uint256 before = address(treasury).balance;
    address expected = factory.getPool(token0, token1, 3000);
    assertEq(expected, address(0));

    vm.expectEmit(false, true, true, true, address(opener));
    emit PoolOpened(address(0), token0, token1, 3000, PRICE_ONE * 2, OPENER);
    address pool = _open(3000, PRICE_ONE * 2);

    assertEq(pool, factory.getPool(token0, token1, 3000), "the factory's own pool");
    (uint160 price,,,,, uint8 feeProtocol,) = IUniswapV3Pool(pool).slot0();
    assertEq(price, PRICE_ONE * 2, "opened at the opener's price");
    assertEq(feeProtocol, 6 << 4 | 6, "venue cut on: 1/6 on the 0.3% tier");
    assertEq(feeProtocol, adapter.getFee(pool));
    assertEq(IUniswapV3Pool(pool).liquidity(), 0, "no coins put in");
    assertEq(address(treasury).balance - before, FEE, "the whole fee reaches the treasury");
    assertEq(OPENER.balance, 10 ether - FEE);
    assertEq(address(opener).balance, 0, "the opener keeps nothing");
    assertEq(opener.poolCount(), 1);
    assertEq(opener.pools(0), pool);
  }

  function test_open_everyTier_eachWithItsCut() public {
    uint24[4] memory tiers = [uint24(100), 500, 3000, 10_000];
    uint8[4] memory cuts = [uint8(4 << 4 | 4), 4 << 4 | 4, 6 << 4 | 6, 6 << 4 | 6];
    for (uint256 i; i < 4; i++) {
      address pool = _open(tiers[i], PRICE_ONE);
      (,,,,, uint8 feeProtocol,) = IUniswapV3Pool(pool).slot0();
      assertEq(feeProtocol, cuts[i]);
      assertEq(opener.pools(i), pool);
    }
    assertEq(address(treasury).balance, 4 * FEE);
  }

  function test_open_aPoolMadeButNeverPriced_opensHere() public {
    address pool = factory.createPool(token0, token1, 500); // anyone may; it has no price yet
    assertEq(_open(500, PRICE_ONE), pool);
    (uint160 price,,,,, uint8 feeProtocol,) = IUniswapV3Pool(pool).slot0();
    assertEq(price, PRICE_ONE);
    assertEq(feeProtocol, 4 << 4 | 4);
    assertEq(opener.pools(0), pool);
  }

  // ─── what it refuses ─────────────────────────────────────────────

  function test_refuses_aPoolThatAlreadyHasAPrice() public {
    address pool = _open(3000, PRICE_ONE);
    vm.prank(OPENER);
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.AlreadyOpen.selector, pool));
    opener.open{value: FEE}(token0, token1, 3000, PRICE_ONE * 3);
    assertEq(opener.poolCount(), 1);
  }

  function test_refuses_aPoolSomeoneOpenedStraightOnTheFactory() public {
    address pool = factory.createPool(token0, token1, 3000);
    IUniswapV3Pool(pool).initialize(PRICE_ONE);
    vm.prank(OPENER);
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.AlreadyOpen.selector, pool));
    opener.open{value: FEE}(token0, token1, 3000, PRICE_ONE);
  }

  function test_refuses_anyPaymentButTheFee() public {
    uint256[4] memory sent = [uint256(0), FEE - 1, FEE + 1, 1 ether];
    for (uint256 i; i < 4; i++) {
      vm.prank(OPENER);
      vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.WrongPayment.selector, sent[i]));
      opener.open{value: sent[i]}(token0, token1, 3000, PRICE_ONE);
    }
    assertEq(factory.getPool(token0, token1, 3000), address(0));
  }

  function test_refuses_tokensNotSorted_orTheSameTwice() public {
    vm.startPrank(OPENER);
    vm.expectRevert(HyperEVMPoolOpener.NotSorted.selector);
    opener.open{value: FEE}(token1, token0, 3000, PRICE_ONE);
    vm.expectRevert(HyperEVMPoolOpener.NotSorted.selector);
    opener.open{value: FEE}(token0, token0, 3000, PRICE_ONE);
    vm.stopPrank();
  }

  function test_refuses_aTokenWithNoCode() public {
    address wallet = address(uint160(token1) + 1); // sorts after token0, has no code
    vm.prank(OPENER);
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.NotAToken.selector, wallet));
    opener.open{value: FEE}(token0, wallet, 3000, PRICE_ONE);
  }

  function test_refuses_aTierTheFactoryDoesNotHave() public {
    vm.prank(OPENER);
    vm.expectRevert(bytes("")); // the factory's own bare require(tickSpacing != 0)
    opener.open{value: FEE}(token0, token1, 2500, PRICE_ONE);
  }

  function test_refuses_aPriceOutsideUniswapsRange() public {
    vm.prank(OPENER);
    vm.expectRevert(bytes("R"));
    opener.open{value: FEE}(token0, token1, 3000, 1);
  }

  // ─── listing a pool opened straight on the factory ───────────────

  function _openOnFactory(uint24 fee) internal returns (address pool) {
    pool = factory.createPool(token0, token1, fee);
    IUniswapV3Pool(pool).initialize(PRICE_ONE * 5);
  }

  function test_list_aPoolOpenedElsewhere_paysTheTreasury_cutOn_listedAtItsOwnPrice() public {
    address pool = _openOnFactory(3000);
    uint256 before = address(treasury).balance;
    vm.expectEmit(true, true, true, true, address(opener));
    emit PoolListed(pool, token0, token1, 3000, OPENER);
    vm.prank(OPENER);
    opener.list{value: FEE}(pool);
    (uint160 price,,,,, uint8 feeProtocol,) = IUniswapV3Pool(pool).slot0();
    assertEq(price, PRICE_ONE * 5, "its own price, untouched");
    assertEq(feeProtocol, 6 << 4 | 6, "venue cut on");
    assertEq(address(treasury).balance - before, FEE);
    assertEq(address(opener).balance, 0);
    assertTrue(opener.listed(pool));
    assertEq(opener.poolCount(), 1);
    assertEq(opener.pools(0), pool);
  }

  function test_list_refusesAPoolAlreadyOnTheList_eitherWay() public {
    address mine = _open(500, PRICE_ONE);
    vm.prank(OPENER);
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.AlreadyListed.selector, mine));
    opener.list{value: FEE}(mine);

    address theirs = _openOnFactory(3000);
    vm.prank(OPENER);
    opener.list{value: FEE}(theirs);
    vm.prank(OPENER);
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.AlreadyListed.selector, theirs));
    opener.list{value: FEE}(theirs);
    vm.prank(OPENER);
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.AlreadyOpen.selector, theirs));
    opener.open{value: FEE}(token0, token1, 3000, PRICE_ONE);
    assertEq(opener.poolCount(), 2);
  }

  function test_list_refusesAPoolWithNoPriceYet() public {
    address pool = factory.createPool(token0, token1, 3000);
    vm.prank(OPENER);
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.NotOpenYet.selector, pool));
    opener.list{value: FEE}(pool);
  }

  function test_list_refusesAnythingButOurFactorysPool() public {
    address real = _openOnFactory(3000);
    FakePool fake = new FakePool(token0, token1, 3000); // answers like the real pool, is not it
    vm.prank(OPENER);
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.NotOurPool.selector, address(fake)));
    opener.list{value: FEE}(address(fake));
    vm.prank(OPENER);
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.NotOurPool.selector, address(0xDEAD)));
    opener.list{value: FEE}(address(0xDEAD));
    assertFalse(opener.listed(real));
    assertEq(opener.poolCount(), 0);
  }

  function test_list_refusesAnyPaymentButTheFee() public {
    address pool = _openOnFactory(3000);
    vm.prank(OPENER);
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.WrongPayment.selector, FEE - 1));
    opener.list{value: FEE - 1}(pool);
    vm.prank(OPENER);
    vm.expectRevert(abi.encodeWithSelector(HyperEVMPoolOpener.WrongPayment.selector, 0));
    opener.list(pool);
  }

  function test_aTreasuryThatRefuses_undoesTheWholeOpening() public {
    treasury.setRefuse(true);
    vm.prank(OPENER);
    vm.expectRevert(HyperEVMPoolOpener.PaymentFailed.selector);
    opener.open{value: FEE}(token0, token1, 3000, PRICE_ONE);
    assertEq(factory.getPool(token0, token1, 3000), address(0), "no pool left behind");
    assertEq(OPENER.balance, 10 ether, "nothing spent");
  }
}
