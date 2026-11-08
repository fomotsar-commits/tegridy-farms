/**
 * useVenuePairs lists our pools on both factories: the old one, then the one that charges
 * 0.006 ETH to open a pool (owner ruling 2026-10-25). The list may say "no pools" only when
 * every factory answered 0, and says "unread" when any did not answer: a list that quietly
 * drops a factory would read as complete.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { TEGRIDY_FACTORY_ADDRESS, CHAIN_ID } from '../lib/constants';

const OPENING_FACTORY = '0x0fac000000000000000000000000000000000001' as const;
const opening = vi.hoisted(() => ({ on: true }));
vi.mock('../lib/chains/liquidityVenue', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/chains/liquidityVenue')>();
  return {
    ...real,
    openingVenueOn: (chainId: number) => {
      const base = real.liquidityVenueOn(chainId);
      return opening.on && base ? { ...base, factory: OPENING_FACTORY, router: '0x0be0000000000000000000000000000000000002' } : null;
    },
  };
});

import { useVenuePairs } from './useVenuePairs';

const OLD_PAIR = '0x0a1d000000000000000000000000000000000011' as const;
const NEW_PAIR = '0x0e30000000000000000000000000000000000022' as const;
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

function factoryWith(factory: string, pairs: readonly string[] | 'unread') {
  if (pairs === 'unread') {
    wagmiMock.setReadResult({ functionName: 'allPairsLength', address: factory, result: undefined, status: 'failure' });
    return;
  }
  wagmiMock.setReadResult({ functionName: 'allPairsLength', address: factory, result: BigInt(pairs.length) });
  pairs.forEach((pair) => {
    wagmiMock.setReadResult({ functionName: 'allPairs', address: factory, result: pair });
    wagmiMock.setReadResult({ functionName: 'token0', address: pair, result: A });
    wagmiMock.setReadResult({ functionName: 'token1', address: pair, result: B });
    wagmiMock.setReadResult({ functionName: 'getReserves', address: pair, result: [10n, 20n, 0] });
    wagmiMock.setReadResult({ functionName: 'kLast', address: pair, result: 0n });
  });
}

beforeEach(() => {
  wagmiMock.reset();
  wagmiMock.setChainId(CHAIN_ID);
  opening.on = true;
  for (const t of [A, B]) {
    wagmiMock.setReadResult({ functionName: 'symbol', address: t, result: t === A ? 'AAA' : 'BBB' });
    wagmiMock.setReadResult({ functionName: 'decimals', address: t, result: 18 });
  }
});

describe('useVenuePairs: both factories', () => {
  it('lists the old factory\'s pools, then the opening factory\'s, numbered in one run', () => {
    factoryWith(TEGRIDY_FACTORY_ADDRESS, [OLD_PAIR]);
    factoryWith(OPENING_FACTORY, [NEW_PAIR]);
    const read = renderHook(() => useVenuePairs(CHAIN_ID)).result.current;
    expect(read.status).toBe('listed');
    if (read.status !== 'listed') return;
    expect(read.total).toBe(2);
    expect(read.pairs.map((p) => [p.index, p.factory, p.address])).toEqual([
      [0, TEGRIDY_FACTORY_ADDRESS, OLD_PAIR],
      [1, OPENING_FACTORY, NEW_PAIR],
    ]);
  });

  it('a pool only on the opening factory is listed', () => {
    factoryWith(TEGRIDY_FACTORY_ADDRESS, []);
    factoryWith(OPENING_FACTORY, [NEW_PAIR]);
    const read = renderHook(() => useVenuePairs(CHAIN_ID)).result.current;
    expect(read.status).toBe('listed');
    if (read.status === 'listed') expect(read.pairs[0]!.factory).toBe(OPENING_FACTORY);
  });

  it('"no pools" only when both factories answered 0', () => {
    factoryWith(TEGRIDY_FACTORY_ADDRESS, []);
    factoryWith(OPENING_FACTORY, []);
    expect(renderHook(() => useVenuePairs(CHAIN_ID)).result.current.status).toBe('empty');
  });

  it('an opening factory that did not answer makes the whole list unread, not "no pools"', () => {
    factoryWith(TEGRIDY_FACTORY_ADDRESS, []);
    factoryWith(OPENING_FACTORY, 'unread');
    expect(renderHook(() => useVenuePairs(CHAIN_ID)).result.current.status).toBe('unread');
  });

  it('with no opening factory deployed, it is the old factory\'s list as before', () => {
    opening.on = false;
    factoryWith(TEGRIDY_FACTORY_ADDRESS, [OLD_PAIR]);
    const read = renderHook(() => useVenuePairs(CHAIN_ID)).result.current;
    expect(read.status).toBe('listed');
    if (read.status === 'listed') expect(read.pairs.map((p) => p.address)).toEqual([OLD_PAIR]);
  });
});
