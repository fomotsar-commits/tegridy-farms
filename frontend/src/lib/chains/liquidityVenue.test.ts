import { describe, it, expect } from 'vitest';
import { liquidityVenueOn } from './liquidityVenue';
import { CHAINS, CONFIGURED_CHAIN_IDS } from './registry';
import {
  TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_FACTORY_ADDRESS,
  WETH_ADDRESS,
  CHAIN_ID,
} from '../constants';

/**
 * The guard on the collision, stated as a test rather than as care.
 *
 * Seven addresses in this repo are a different LIVE contract on another chain.
 * Two of them are the constants the liquidity path used to import, so "resolve
 * the address per chain" is not a tidy-up — it is the difference between an
 * approval that works and one that hands spending rights to whatever sits at
 * that address on the chain the wallet happens to be on.
 */
describe('liquidityVenueOn', () => {
  it('mainnet resolves to EXACTLY what the constants said', () => {
    // Compared against lib/constants itself, never a copied literal — a copy
    // drifts silently and would prove nothing. This is the entire safety case
    // for replacing those imports in useAddLiquidity.
    const venue = liquidityVenueOn(CHAIN_ID);
    expect(venue).not.toBeNull();
    expect(venue!.chainId).toBe(CHAIN_ID);
    expect(venue!.router).toBe(TEGRIDY_ROUTER_ADDRESS);
    expect(venue!.factory).toBe(TEGRIDY_FACTORY_ADDRESS);
    expect(venue!.weth).toBe(WETH_ADDRESS);
  });

  it('every configured chain resolves to its OWN addresses, never mainnet leakage', () => {
    let checked = 0;
    for (const id of CONFIGURED_CHAIN_IDS) {
      const venue = liquidityVenueOn(id);
      if (!venue) continue; // a chain with no router/factory is a legitimate null
      checked++;
      const own = CHAINS[id]!.contracts;
      expect(venue.chainId, 'the venue carries the wrong chain id').toBe(id);
      expect(venue.router, `${CHAINS[id]!.name} got the wrong router`).toBe(own.router);
      expect(venue.factory, `${CHAINS[id]!.name} got the wrong factory`).toBe(own.factory);
      expect(venue.weth, `${CHAINS[id]!.name} got the wrong WETH`).toBe(own.weth);
    }
    expect(checked, 'no chain resolved at all — this test proved nothing').toBeGreaterThan(1);
  });

  it('an L2 never resolves to a mainnet address — the collision, directly', () => {
    // The failure mode is silent: 0xe9f83a07 IS a live contract on Robinhood
    // (its swapFeeRouter), so a leaked mainnet router does not revert.
    const MAINNET_ONLY = [TEGRIDY_ROUTER_ADDRESS, TEGRIDY_FACTORY_ADDRESS, WETH_ADDRESS].map((a) =>
      a.toLowerCase(),
    );
    const l2s = CONFIGURED_CHAIN_IDS.filter((id) => id !== CHAIN_ID);
    expect(l2s.length, 'no non-mainnet chain configured — nothing to guard').toBeGreaterThan(0);

    for (const id of l2s) {
      const venue = liquidityVenueOn(id);
      if (!venue) continue;
      for (const [role, addr] of [
        ['router', venue.router],
        ['factory', venue.factory],
        ['weth', venue.weth],
      ] as const) {
        expect(
          MAINNET_ONLY.includes(addr.toLowerCase()),
          `${venue.name}'s ${role} is a MAINNET address — on this chain that address ` +
            `is a live contract of a different type, so the call will not revert`,
        ).toBe(false);
      }
    }
  });

  it('refuses rather than defaulting, where we cannot serve a venue', () => {
    // Falling back to a default chain is how a wallet on Robinhood signs a
    // mainnet-addressed approval. Null is the only safe answer.
    expect(liquidityVenueOn(999_999)).toBeNull();
    expect(liquidityVenueOn(undefined)).toBeNull();
    expect(liquidityVenueOn(null)).toBeNull();
  });
});
