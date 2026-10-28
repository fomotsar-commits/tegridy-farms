import { describe, it, expect } from 'vitest';
import * as constants from '../constants';
import { swapVenueOn, openingSwapVenue } from './swapVenue';
import { CHAINS, CONFIGURED_CHAIN_IDS } from './registry';

/**
 * The swap's addresses, per chain. Mainnet must resolve to EXACTLY what the constants
 * said (read from lib/constants, never a copy), and no L2 venue may carry a mainnet
 * constant: several of ours are a different live contract on another chain.
 */
describe('swapVenueOn', () => {
  it('resolves Ethereum to the constants the swap always used', () => {
    expect(swapVenueOn(constants.CHAIN_ID)).toEqual({
      chainId: constants.CHAIN_ID,
      name: 'Ethereum',
      weth: constants.WETH_ADDRESS,
      factory: constants.TEGRIDY_FACTORY_ADDRESS,
      router: constants.TEGRIDY_ROUTER_ADDRESS,
      swapFeeRouter: constants.SWAP_FEE_ROUTER_ADDRESS,
      uniswapV2Router: constants.UNISWAP_V2_ROUTER,
      uniswapV2Factory: constants.UNISWAP_V2_FACTORY,
      feeSink: 'distributor',
    });
  });

  it('resolves Base to Base contracts, read on chain 2026-10-17', () => {
    expect(swapVenueOn(8453)).toEqual({
      chainId: 8453,
      name: 'Base',
      weth: '0x4200000000000000000000000000000000000006',
      factory: '0x12a249A027AA7DdF184E824b4bb63ba031A39fEC',
      router: '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3',
      swapFeeRouter: '0xa24C7287eC56A7DEFDc70033803451240e267a52',
      uniswapV2Router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      uniswapV2Factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
      feeSink: 'remittance',
    });
  });

  it('resolves Robinhood Chain to Robinhood contracts, read on chain 2026-10-17', () => {
    expect(swapVenueOn(4663)).toEqual({
      chainId: 4663,
      name: 'Robinhood Chain',
      weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
      factory: '0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3',
      router: '0xB021651dACaD5dabf83ef587297E093DfA0c95Ec',
      swapFeeRouter: '0xE9F83A07b071748E795d2489651d5310fA098Db8',
      uniswapV2Router: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba',
      uniswapV2Factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
      feeSink: 'remittance',
    });
  });

  it('never hands an L2 a mainnet address in a slot where mainnet uses it', () => {
    // The collision trap: mainnet TEGRIDY_ROUTER_ADDRESS IS Robinhood's swapFeeRouter,
    // and mainnet TEGRIDY_FACTORY_ADDRESS IS Base's. Same slot, same address = the bug.
    const main = swapVenueOn(constants.CHAIN_ID)!;
    for (const id of [8453, 4663]) {
      const v = swapVenueOn(id)!;
      for (const k of ['weth', 'factory', 'router', 'swapFeeRouter', 'uniswapV2Router', 'uniswapV2Factory'] as const) {
        expect(v[k].toLowerCase(), `${v.name} ${k} is mainnet's`).not.toBe(main[k].toLowerCase());
      }
    }
  });

  it('returns null where the swap does not run, and the same object each time where it does', () => {
    expect(swapVenueOn(42161)).toBeNull();
    expect(swapVenueOn(undefined)).toBeNull();
    expect(swapVenueOn(null)).toBeNull();
    expect(swapVenueOn(8453)).toBe(swapVenueOn(8453));
  });
});

describe('openingSwapVenue: pools on the factory that charges 0.006 ETH to open', () => {
  it('is null on every configured chain until its factory, router and SwapFeeRouter are all set', () => {
    for (const id of CONFIGURED_CHAIN_IDS) {
      const own = CHAINS[id]!.contracts;
      const all = own.openingFactory && own.openingRouter && own.openingSwapFeeRouter;
      const venue = openingSwapVenue(swapVenueOn(id));
      if (!all) expect(venue, `${CHAINS[id]!.name} resolved an opening swap venue it does not have`).toBeNull();
      else {
        expect(venue!.swapFeeRouter).toBe(own.openingSwapFeeRouter);
        expect(venue!.router).toBe(own.openingRouter);
        expect(venue!.factory).toBe(own.openingFactory);
      }
    }
  });

  it('answers null for a chain with no swap venue', () => {
    expect(openingSwapVenue(null)).toBeNull();
  });
});
