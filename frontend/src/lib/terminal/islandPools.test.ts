import { describe, it, expect } from 'vitest';
import { BUNGALOWS, type Bungalow } from '../bungalows';
import { TOWELI_WETH_LP_ADDRESS } from '../constants';
import { GECKO_NETWORKS } from '../geckoTerminal/pools';
import { TOWELI_POOL, islandPools, islandPoolsOn } from './islandPools';

// The island view reads the SAME `market` field the bungalow charts read. These
// tests are mostly about what it refuses to invent: a resident with no recorded
// pool is skipped rather than guessed at, and the hand-added TOWELI row gets no
// special treatment at all.

function bungalow(over: Partial<Bungalow>): Bungalow {
  return { id: 'x', name: 'X', symbol: 'X', chain: 'ethereum', status: 'SETTLED', ...over } as Bungalow;
}

describe('it reads the registry rather than a second hand-kept list', () => {
  it('returns every resident that has a recorded market, and only those', () => {
    const withMarket = BUNGALOWS.filter((b) => b.market).length;
    // +1 for the TOWELI row, whose market is not on its bungalow entry.
    expect(islandPools()).toHaveLength(withMarket + 1);
  });

  it('SKIPS a resident with no recorded pool instead of guessing one', () => {
    // "No market surface" is the honest state for a token whose pool this venue
    // has not recorded. Substituting the token address, or a chain default,
    // would send a real request about a pool that does not exist and render the
    // 404 as an outage.
    const pools = islandPools([bungalow({ id: 'nomarket', name: 'No Market' })]);
    expect(pools.map((p) => p.label)).not.toContain('No Market');
  });

  it('carries the resident’s NAME so island rows can be labelled', () => {
    const pools = islandPools([
      bungalow({ id: 'a', name: 'Bobo', market: { network: 'solana', pool: 'ABC', label: 'x' } }),
    ]);
    expect(pools.find((p) => p.pool === 'ABC')?.label).toBe('Bobo');
  });

  it('every pool names one of the three networks this venue reads', () => {
    for (const p of islandPools()) {
      expect(GECKO_NETWORKS).toContain(p.network);
    }
  });
});

describe('the hand-added TOWELI row gets no special treatment', () => {
  it('is included, on eth, at the recorded TOWELI/WETH LP address', () => {
    // ⚠️ THE LABEL IS NO LONGER PINNED AS A LITERAL. It used to be, and that
    // pinned the DEFECT: the string was "TOWELI (the venue’s own pool)", which
    // is a claim pages/venueVoice.test.tsx already rules out — the venue has no
    // token, so it has no pool of its own — and it is prose, read back to the
    // user by useIslandTape's ledger line. The shape and the address are what
    // this test is for; what the row may CLAIM is pinned below and in
    // venueVoice.test.tsx, where a rewording moves one assertion, not two.
    expect(TOWELI_POOL.network).toBe('eth');
    expect(TOWELI_POOL.pool).toBe(TOWELI_WETH_LP_ADDRESS);
    expect(TOWELI_POOL.label).toContain('TOWELI');
    expect(islandPoolsOn('eth')).toContain(TOWELI_WETH_LP_ADDRESS);
  });

  it('makes no static market claim, and claims no ownership by the venue', () => {
    // A venue that exempted one resident's pool from its own honesty rules would
    // have written those rules for other people. It goes through the same parser,
    // the same null rules and the same safety read as any stranger's pool — and
    // it is one resident's pool, not the house's.
    expect(TOWELI_POOL.label).not.toMatch(/deepest|best|largest|\$|liquidity/i);
    expect(TOWELI_POOL.label, 'the row claims the venue owns it').not.toMatch(/\b(venue|our|its)\b[^.]*\bown\b/i);
    expect(Object.keys(TOWELI_POOL).sort()).toEqual(['label', 'network', 'pool']);
  });

  it('is not listed twice if a resident records the same pool', () => {
    const dupe = bungalow({
      id: 'toweli',
      name: 'Toweli',
      // Different case, same pool — an EVM address is case-insensitive, so this
      // must dedupe or the multi request would ask about it twice.
      market: { network: 'eth', pool: TOWELI_WETH_LP_ADDRESS.toUpperCase(), label: 'x' },
    });
    const pools = islandPools([dupe]);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toEqual(TOWELI_POOL);
  });

  it('does NOT dedupe two Solana pools differing only in case — base58 is case-sensitive', () => {
    const a = bungalow({ id: 'a', name: 'A', market: { network: 'solana', pool: 'ABCdef', label: 'x' } });
    const b = bungalow({ id: 'b', name: 'B', market: { network: 'solana', pool: 'abcDEF', label: 'x' } });
    expect(islandPoolsOn('solana', [a, b])).toEqual(['ABCdef', 'abcDEF']);
  });
});

describe('grouping is the shape pools/multi takes', () => {
  it('returns addresses for one network only', () => {
    for (const network of GECKO_NETWORKS) {
      const addresses = islandPoolsOn(network);
      const expected = islandPools().filter((p) => p.network === network);
      expect(addresses).toEqual(expected.map((p) => p.pool));
    }
  });

  it('the three networks partition the whole list — nothing is silently lost', () => {
    const total = GECKO_NETWORKS.reduce((n, network) => n + islandPoolsOn(network).length, 0);
    expect(total).toBe(islandPools().length);
  });
});
