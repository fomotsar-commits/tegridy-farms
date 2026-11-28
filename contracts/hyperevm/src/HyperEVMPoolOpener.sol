// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.29;

import {IUniswapV3Factory} from "v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/// @dev The one fee-switch call this contract makes (Uniswap's V3OpenFeeAdapter, anyone may call it).
interface IFeeSwitch {
  function FACTORY() external view returns (IUniswapV3Factory);
  function triggerFeeUpdate(address pool) external;
}

/// @title HyperEVMPoolOpener
/// @notice Anyone opens a pool on our Uniswap V3 factory by paying the venue POOL_OPENING_FEE.
///   In one transaction it opens the pool at the price the opener sets, switches the venue's cut
///   on (Uniswap's fee switch), pays the fee to the treasury Safe, and adds the pool to the list
///   the site shows. It puts no coins in: liquidity is added afterwards, through the position
///   manager, by whoever wants to.
///   A pool someone opened straight on the factory (free, and off this list) can be added to the
///   list for the same fee with `list`, at the price it already has, so nobody can keep a coin off
///   the site by opening its pools first.
/// @dev No owner, no settings, nothing it holds: every address is fixed at deploy, and the fee is
///   passed straight on. Uniswap's own contracts stay unchanged.
///   An opening costs about 4.6M gas, more than a HyperEVM fast block holds: the sender needs
///   Hyperliquid's big-block setting on. A listing is small and needs nothing.
///   If the admin Safe ever takes the factory back from the fee switch, both calls refuse (the cut
///   could not be switched on): a new opener would be deployed then.
contract HyperEVMPoolOpener {
  /// @notice What an opening or a listing pays the venue, in HYPE (owner's ruling 2026-11-26: about $15).
  uint256 public constant POOL_OPENING_FEE = 0.23 ether;

  IUniswapV3Factory public immutable FACTORY;
  IFeeSwitch public immutable FEE_SWITCH;
  /// @notice The only place the fee can go: the HyperEVM treasury Safe.
  address public immutable TREASURY;

  /// @notice Every pool opened or listed here, oldest first, each once.
  address[] public pools;
  mapping(address pool => bool) public listed;

  event PoolOpened(address indexed pool, address indexed token0, address indexed token1, uint24 fee, uint160 sqrtPriceX96, address opener);
  event PoolListed(address indexed pool, address indexed token0, address indexed token1, uint24 fee, address lister);

  error NoCode(address account);
  error WrongFactory();
  error WrongPayment(uint256 sent);
  error NotSorted();
  error NotAToken(address token);
  error AlreadyOpen(address pool);
  error AlreadyListed(address pool);
  error NotOurPool(address pool);
  error NotOpenYet(address pool);
  error PaymentFailed();

  constructor(IFeeSwitch feeSwitch, address treasury) {
    if (address(feeSwitch).code.length == 0) revert NoCode(address(feeSwitch));
    if (treasury.code.length == 0) revert NoCode(treasury); // a Safe, never a plain wallet
    IUniswapV3Factory factory = feeSwitch.FACTORY();
    if (address(factory).code.length == 0) revert NoCode(address(factory));
    if (factory.owner() != address(feeSwitch)) revert WrongFactory();
    FACTORY = factory;
    FEE_SWITCH = feeSwitch;
    TREASURY = treasury;
  }

  /// @notice Opens the token0/token1 pool at `fee` (100, 500, 3000 or 10000) and the price
  ///   `sqrtPriceX96` (token1 per token0, Uniswap's encoding), paying exactly POOL_OPENING_FEE.
  /// @dev The two tokens must be sorted, as the pool holds them, so the price can never be read
  ///   the wrong way up. A pool that exists but has no price yet (made on the factory and never
  ///   initialised) is opened here like a new one. A pool that already has a price is refused,
  ///   never listed at a price the opener did not set: `list` does that, on purpose.
  function open(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool) {
    if (msg.value != POOL_OPENING_FEE) revert WrongPayment(msg.value);
    if (token0 >= token1) revert NotSorted();
    if (token0.code.length == 0) revert NotAToken(token0);
    if (token1.code.length == 0) revert NotAToken(token1);

    pool = FACTORY.getPool(token0, token1, fee);
    if (pool == address(0)) {
      pool = FACTORY.createPool(token0, token1, fee); // refuses a fee tier the factory does not have
    } else {
      (uint160 price,,,,,,) = IUniswapV3Pool(pool).slot0();
      if (price != 0) revert AlreadyOpen(pool);
    }
    IUniswapV3Pool(pool).initialize(sqrtPriceX96); // refuses a price outside Uniswap's range

    _add(pool);
    emit PoolOpened(pool, token0, token1, fee, sqrtPriceX96, msg.sender);
    _cutOnAndPay(pool);
  }

  /// @notice Adds to the list a pool of our factory that already has a price (opened straight on
  ///   the factory), paying exactly POOL_OPENING_FEE, and switches the venue's cut on for it.
  function list(address pool) external payable {
    if (msg.value != POOL_OPENING_FEE) revert WrongPayment(msg.value);
    if (listed[pool]) revert AlreadyListed(pool);
    if (pool.code.length == 0) revert NotOurPool(pool);
    // View calls (staticcall): whatever `pool` is, it cannot change state here. Only the
    // factory's own answer decides whether it is one of our pools.
    IUniswapV3Pool p = IUniswapV3Pool(pool);
    address token0 = p.token0();
    address token1 = p.token1();
    uint24 fee = p.fee();
    if (FACTORY.getPool(token0, token1, fee) != pool) revert NotOurPool(pool);
    (uint160 price,,,,,,) = p.slot0();
    if (price == 0) revert NotOpenYet(pool); // open() it instead, at a price of its opener's choosing

    _add(pool);
    emit PoolListed(pool, token0, token1, fee, msg.sender);
    _cutOnAndPay(pool);
  }

  /// @notice How many pools are on the list.
  function poolCount() external view returns (uint256) {
    return pools.length;
  }

  function _add(address pool) private {
    listed[pool] = true;
    pools.push(pool);
  }

  function _cutOnAndPay(address pool) private {
    FEE_SWITCH.triggerFeeUpdate(pool);
    (bool ok,) = TREASURY.call{value: msg.value}("");
    if (!ok) revert PaymentFailed();
  }
}
