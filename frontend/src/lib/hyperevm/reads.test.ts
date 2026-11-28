// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readCoins } from './coins';
import { MAX_RETRIES, readUnits } from './reads';
import type { HyperEvmReader, ReadCall, ReadResult } from './pools';

/**
 * Reads of coins anyone could have written (CodeRabbit's review of #1350, 2026-11-28): a coin
 * that makes its whole batch throw, or burns the gas of the calls after it, must cost only its
 * own answer. Every healthy coin beside it is read, however many batches such coins sit in, and
 * a coin the budget could not reach is "could not read", never "not a coin".
 */
const addr = (n: number) => `0x${(0x1000 + n).toString(16).padStart(40, '0')}` as `0x${string}`;
const coinCalls = (a: `0x${string}`): ReadCall[] => (['symbol', 'name', 'decimals'] as const).map((functionName) => ({ address: a, abi: [], functionName }));
const answer = (c: ReadCall): unknown => (c.functionName === 'decimals' ? 18 : 'C');

/** A chain where any batch holding a call to a `throwers` coin throws, and each read is counted. */
function chain(throwers: Set<string>, burners: Set<string> = new Set()): HyperEvmReader & { reads: number } {
  const r = {
    reads: 0,
    simulateContract: async () => ({ result: [] }),
    multicall: async ({ contracts }: { contracts: readonly ReadCall[] }): Promise<ReadResult[]> => {
      r.reads += 1;
      if (contracts.some((c) => throwers.has(c.address))) throw new Error('out of gas');
      // A gas burner fails its own calls and every call after it in the same read.
      let burnt = false;
      return contracts.map((c): ReadResult => {
        if (burners.has(c.address)) burnt = true;
        return burnt ? { status: 'failure' } : { status: 'success', result: answer(c) };
      });
    },
  };
  return r;
}

describe('reads of coins anyone could have written', () => {
  it('60 coins in three batches, each batch with one coin that throws it: all 57 healthy coins are read', async () => {
    const coins = Array.from({ length: 60 }, (_, i) => addr(i));
    const bad = new Set([coins[5]!, coins[27]!, coins[59]!]);
    const reader = chain(bad);
    const m = await readCoins(reader, coins);
    for (const c of coins) {
      if (bad.has(c)) expect(m.has(c)).toBe(false); // could not read: left out, not "not a coin"
      else expect(m.get(c)?.symbol).toBe('C');
    }
    expect(reader.reads).toBeLessThanOrEqual(3 + MAX_RETRIES);
  });

  it('a coin that burns the gas of the calls after it costs only its own answer, kept as its own', async () => {
    const coins = Array.from({ length: 20 }, (_, i) => addr(i));
    const reader = chain(new Set(), new Set([coins[3]!]));
    const m = await readCoins(reader, coins);
    expect(m.get(coins[3]!)).toBeNull(); // read alone, it answers, but not as a coin
    for (const c of coins) if (c !== coins[3]) expect(m.get(c)?.symbol).toBe('C');
  });

  it('never asks again more than its budget, and what it could not reach is unread, never a failed answer', async () => {
    const units = Array.from({ length: 400 }, (_, i) => coinCalls(addr(i)));
    // Two throwing coins in every batch of 20: more than the budget can take apart.
    const bad = new Set(units.flatMap((_, i) => (i % 20 === 2 || i % 20 === 17 ? [addr(i)] : [])));
    const reader = chain(bad);
    const out = await readUnits(reader, units);
    expect(reader.reads).toBe(20 + MAX_RETRIES);
    let read = 0;
    out.forEach((u, i) => {
      if (u === null) return;
      read += 1;
      expect(bad.has(addr(i))).toBe(false);
      expect(u.every((r) => r.status === 'success')).toBe(true);
    });
    // The budget reads whole batches, first to last: all 18 healthy coins of the first batch are read.
    expect(out.slice(0, 20).filter((u) => u !== null).length).toBe(18);
    expect(read).toBeGreaterThanOrEqual(18);
  });

  it('a later healthy batch is still read once the budget is spent on earlier ones', async () => {
    const units = Array.from({ length: 220 }, (_, i) => coinCalls(addr(i)));
    // Every batch but the last holds a throwing coin.
    const bad = new Set(units.flatMap((_, i) => (i < 200 && i % 20 === 7 ? [addr(i)] : [])));
    const out = await readUnits(chain(bad), units);
    expect(out.slice(200).every((u) => u !== null && u.every((r) => r.status === 'success'))).toBe(true);
  });

  it('a healthy batch is read in one go, with nothing asked again', async () => {
    const reader = chain(new Set());
    const out = await readUnits(reader, Array.from({ length: 45 }, (_, i) => coinCalls(addr(i))));
    expect(reader.reads).toBe(3);
    expect(out.every((u) => u !== null && u.every((r) => r.status === 'success'))).toBe(true);
  });
});
