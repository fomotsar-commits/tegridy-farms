// The LP testkit's keys: the same on every run, and each a whole 44-character address, so a
// test that pins an address's length cannot fail by chance.
import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const draw = async (n: number) => {
  vi.resetModules();
  const { key } = await import('./testkit.fixture');
  return Array.from({ length: n }, () => key());
};

describe('the LP testkit hands out keys a test can pin', () => {
  it('every key is a whole 44-character address on the curve, and none repeats', async () => {
    const keys = await draw(500);
    const words = keys.map((k) => k.toBase58());
    expect(words.filter((w) => w.length !== 44)).toEqual([]);
    expect(keys.filter((k) => !PublicKey.isOnCurve(k.toBytes()))).toEqual([]);
    expect(new Set(words).size).toBe(words.length);
  });

  it('a fresh copy of the testkit hands out the same keys in the same order', async () => {
    const first = (await draw(20)).map((k) => k.toBase58());
    const again = (await draw(20)).map((k) => k.toBase58());
    expect(again).toEqual(first);
  });
});
