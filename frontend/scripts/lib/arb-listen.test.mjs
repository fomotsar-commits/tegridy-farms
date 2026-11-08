import { describe, it, expect } from 'vitest';
import { GapBook, accountsOf, byEachVenue, coinsByAccount } from './arb-listen.mjs';

const trip = (pools, dexes, pays, netUsd = 0.05) => ({
  legs: pools.map((pool, i) => ({ pool, dex: dexes[i], rough: dexes[i] === 'dlmm' })),
  pays, netUsd, inUsd: 10, gapPct: 2, robotTakes: pools.length === 2,
});

describe('GapBook: gaps as they open and close', () => {
  it('opens a paying trip once, and closes it with the time and slots it stayed open', () => {
    const b = new GapBook();
    expect(b.seen('X', [trip(['p1', 'p2'], ['pumpswap', 'ammV4'], true)], 100, 1_000).opened).toHaveLength(1);
    expect(b.seen('X', [trip(['p1', 'p2'], ['pumpswap', 'ammV4'], true, 0.09)], 101, 1_400).opened).toHaveLength(0);
    const { closed } = b.seen('X', [trip(['p1', 'p2'], ['pumpswap', 'ammV4'], false)], 105, 3_000);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ ms: 2_000, slots: 5, bestNetUsd: 0.09, direct: true, robotTakes: true });
  });

  it('closes only the judged coin’s gaps', () => {
    const b = new GapBook();
    b.seen('X', [trip(['p1', 'p2'], ['ours', 'cpmm'], true)], 100, 0);
    b.seen('Y', [trip(['q1', 'q2'], ['ours', 'dlmm'], true)], 100, 0);
    expect(b.seen('X', [], 101, 10).closed.map((g) => g.coin)).toEqual(['X']);
    expect([...b.open.values()].map((g) => g.coin)).toEqual(['Y']);
  });

  it('counts by venue: a gap gone within its slot is not counted as open for any time', () => {
    const b = new GapBook();
    b.seen('X', [trip(['p1', 'p2'], ['whirlpool', 'dlmm'], true)], 100, 0);
    b.seen('X', [], 100, 50);
    b.seen('X', [trip(['p1', 'p2'], ['whirlpool', 'dlmm'], true)], 101, 100);
    b.seen('X', [], 104, 1_300);
    const [row] = b.counts(2_000);
    expect(row).toMatchObject({ key: 'Orca > Meteora DLMM', opened: 2, sameSlot: 1, closed: 1, medianMs: 1_200, medianSlots: 3, openNow: 0, direct: 0, rough: 2 });
    expect(b.counts(2_000, byEachVenue).map((r) => r.key).sort()).toEqual(['Meteora DLMM', 'Orca']);
  });
});

describe('which accounts move which coins', () => {
  it('a band pool by its own account; a pair pool by its account and both vaults', () => {
    expect(accountsOf({ kind: 'band', address: 'a', vaultA: 'va', vaultB: 'vb' })).toEqual(['a']);
    expect(accountsOf({ kind: 'pair', address: 'a', vaultA: 'va', vaultB: 'vb' })).toEqual(['a', 'va', 'vb']);
  });
  it('a pricing coin’s link pool moves every coin priced in it', () => {
    const link = { kind: 'pair', address: 'L', vaultA: 'L1', vaultB: 'L2' };
    const m = coinsByAccount([
      { mint: 'X', pools: [{ kind: 'band', address: 'x' }], links: [link] },
      { mint: 'Y', pools: [{ kind: 'band', address: 'y' }], links: [link] },
    ]);
    expect([...m.get('L1')].sort()).toEqual(['X', 'Y']);
    expect([...m.get('x')]).toEqual(['X']);
  });
});
