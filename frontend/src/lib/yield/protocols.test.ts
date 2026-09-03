// THE ADDRESS GUARD.
//
// protocols.ts is the only file in this slice that carries a live address, and
// one of them is where a visitor's ETH goes. This file asserts the four
// properties that cannot be checked by reading the code:
//
//   1. every address is EIP-55 checksummed, which is what `getAddress()` emits
//      and the only form scripts/verify-yield-protocols.mjs prints;
//   2. no address is repeated, so a copy-paste that pointed Renzo at Lido's
//      contract cannot pass review by looking plausible;
//   3. no address is the zero address, which would be a live-looking row wired
//      to nothing;
//   4. every address is registered in scripts/addresses.json, with the
//      expect.type and the evidence a registry entry is required to carry.
//
// Rule 4 used to allow a second answer — an AWAITING_REGISTRATION list, because
// addresses.json was serialised across several lanes and this one could not edit
// it. All twenty-seven entries landed on 2026-09-03, so the list is gone and the
// assertion is the plain one: an address here that is not in the registry fails,
// with no escape hatch to add a name to. scripts/verify-addresses.mjs now walks
// this file too, so the same omission fails from the other direction as well.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { MULTICALL3_ADDRESS, YIELD_ADDRESSES, YIELD_FEEDS } from './protocols';

const registry = JSON.parse(
  readFileSync(join(process.cwd(), 'scripts', 'addresses.json'), 'utf-8'),
) as { ethereum: { id?: string; address: string; expect?: { type?: string }; evidence?: string }[] };

const registered = new Map(
  registry.ethereum.filter((e) => typeof e.address === 'string').map((e) => [e.address.toLowerCase(), e]),
);

const ALL: [string, string][] = [
  ['multicall3', MULTICALL3_ADDRESS],
  ...Object.entries(YIELD_ADDRESSES),
  ...Object.entries(YIELD_FEEDS).map(([k, f]) => [k, f.address] as [string, string]),
];

describe('every address a deposit could reach is checksummed, unique and real', () => {
  it.each(ALL)('%s is EIP-55 and non-zero', (name, address) => {
    expect(address, `${name} is not the checksummed form getAddress() emits`).toBe(getAddress(address as `0x${string}`));
    expect(address).not.toBe('0x0000000000000000000000000000000000000000');
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('never repeats an address across two different roles', () => {
    const seen = new Map<string, string>();
    for (const [name, address] of ALL) {
      const key = address.toLowerCase();
      expect(seen.has(key), `${name} reuses the address already used for ${seen.get(key)}`).toBe(false);
      seen.set(key, name);
    }
  });

  it('pins Multicall3 to viem\'s canonical deployment', () => {
    // The clock legs ride in this contract's aggregate3. A different Multicall3
    // would still answer, and would date every figure on the page from a
    // contract nobody verified.
    expect(MULTICALL3_ADDRESS).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
  });
});

describe('the registry knows about every address', () => {
  it.each(ALL)('%s is registered, asserted as a contract, and carries evidence', (name, address) => {
    const entry = registered.get(address.toLowerCase());
    expect(
      entry,
      `${name} (${address}) is not in scripts/addresses.json. Verify it with ` +
        'scripts/verify-yield-protocols.mjs and register it with a role, custody and evidence ' +
        'before wiring it.',
    ).toBeDefined();
    // An entry with no expect.type is READ by the --onchain pass and asserted
    // about by nothing, which prints the same green line as a real check. For an
    // address a deposit can reach that is not good enough.
    expect(entry?.expect?.type, `${name} is registered without expect.type 'contract'`).toBe('contract');
    expect((entry?.evidence ?? '').length, `${name} is registered with no evidence`).toBeGreaterThan(20);
  });
});

describe('every Chainlink feed declares what kind of instrument it is', () => {
  it.each(Object.entries(YIELD_FEEDS))('%s names a class and a heartbeat', (_key, feed) => {
    expect(['market', 'exchange-rate']).toContain(feed.marketClass);
    expect(feed.heartbeatS).toBeGreaterThan(0);
    // description() returns the bare pair name and its casing is NOT uniform
    // across feeds (weETH / ETH, but CBETH / ETH), so the pinned string has to
    // be the exact one the contract answers with.
    expect(feed.pair).toMatch(/^\S+ \/ \S+$/);
  });

  it('keeps the exchange-rate feeds out of the market-feed set', () => {
    // The rows whose peg CAN show a discount are exactly the ones with a market
    // feed. Flipping one of these would silently turn a peg column into a
    // number that can never move.
    const byClass = Object.fromEntries(
      Object.entries(YIELD_FEEDS).map(([k, f]) => [k, f.marketClass]),
    );
    expect(byClass).toEqual({
      stethEth: 'market',
      rethEth: 'market',
      cbethEth: 'market',
      weethEth: 'exchange-rate',
      ezethEth: 'exchange-rate',
      usdcUsd: 'market',
      usdsUsd: 'market',
    });
  });
});
