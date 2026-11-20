import { describe, it, expect } from 'vitest';
import type { PoolView } from './poolFinder';
import { fieldPoolsOf } from './fieldPools';

const view = (address: string, quoteReserve: bigint, tokenReserve: bigint) =>
  ({ address, tokenMint: `mint-${address}`, quote: { symbol: 'SOL' }, quoteReserve, tokenReserve }) as unknown as PoolView;

describe('the tank farm reads a pool as holding coins only from its own two reserves', () => {
  it('is stocked when both reserves were read above nothing, and not when either side is empty', () => {
    const out = fieldPoolsOf([view('a', 5n, 9n), view('b', 0n, 9n), view('c', 5n, 0n)], null, new Map());
    expect(out.map((p) => p.stocked)).toEqual([true, false, false]);
  });

  it('gives no dollars when the prices were not read, stocked or not', () => {
    const out = fieldPoolsOf([view('a', 5n, 9n)], null, new Map());
    expect(out[0]!.usd).toBeNull();
  });
});
