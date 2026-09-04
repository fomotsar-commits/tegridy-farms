import { describe, it, expect } from 'vitest';
import { BUNGALOWS, type Bungalow } from '../bungalows';
import { TOWELI_WETH_LP_ADDRESS } from '../constants';
import { GECKO_NETWORKS } from '../geckoTerminal/pools';
import { VENUE_POOL, islandPools, islandPoolsOn } from './islandPools';

// The island view reads the SAME `market` field the bungalow charts read. These
// tests are mostly about what it refuses to invent: a resident with no recorded
// pool is skipped rather than guessed at, and the venue's own pool gets no
// special treatment at all.

function bungalow(over: Partial<Bungalow>): Bungalow {
  return { id: 'x', name: 'X', symbol: 'X', chain: 'ethereum', status: 'SETTLED', ...over } as Bungalow;
}

describe('it reads the registry rather than a second hand-kept list', () => {
  it('returns every resident that has a recorded market, and only those', () => {
    const withMarket = BUNGALOWS.filter((b) => b.market).length;
    // +1 for the venue's own pool, which is not a bungalow.
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

describe('the venue’s own pool gets no special treatment', () => {
  it('is included, on eth, at the venue’s recorded LP address', () => {
    expect(VENUE_POOL).toEqual({
      network: 'eth',
      pool: TOWELI_WETH_LP_ADDRESS,
      label: 'TOWELI (the venue’s own pool)',
    });
    expect(islandPoolsOn('eth')).toContain(TOWELI_WETH_LP_ADDRESS);
  });

  it('makes no static market claim — the label is a name, not a depth figure', () => {
    // A venue that exempted its own pool from its own honesty rules would have
    // written those rules for other people. It goes through the same parser,
    // the same null rules and the same safety read as any stranger's pool.
    expect(VENUE_POOL.label).not.toMatch(/deepest|best|largest|\$|liquidity/i);
    expect(Object.keys(VENUE_POOL).sort()).toEqual(['label', 'network', 'pool']);
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
    expect(pools[0]).toEqual(VENUE_POOL);
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
