import { describe, it, expect } from 'vitest';
import { GapBook, SUSPECT_MS, accountsOf, afterCosts, byEachVenue, coinsByAccount, coinsFromMap, stage0Report, watchedOf } from './arb-listen.mjs';

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

describe('Stage 0: what a gap makes after every cost a send pays', () => {
  const t = (gainUsd, more = {}) => ({ gainUsd, feeUsd: 0.0001, floorUsd: 0.0021, inRaw: 1_000, ...more });

  it('a big gap pays 30% of its gain as the Jito tip', () => {
    const c = afterCosts(t(1), 150);
    expect(c.tipUsd).toBeCloseTo(0.3, 12);
    expect(c.netAllUsd).toBeCloseTo(1 - 0.0001 - 0.3, 12);
    expect(c.paysAll).toBe(true);
  });
  it('a small one pays at least 20,000 lamports, and one the robot would take without a tip may not pay after it', () => {
    // 20,000 lamports at $150 a SOL: $0.003.
    expect(afterCosts(t(0.01), 150)).toMatchObject({ paysAll: true });
    expect(afterCosts(t(0.01), 150).tipUsd).toBeCloseTo(0.003, 12);
    const small = t(0.005);
    expect(small.gainUsd).toBeGreaterThanOrEqual(small.floorUsd);
    expect(afterCosts(small, 150).paysAll).toBe(false);
  });
  it('nothing pays without a SOL price to count the tip, or with no size', () => {
    expect(afterCosts(t(1), undefined).paysAll).toBe(false);
    expect(afterCosts(t(1, { inRaw: 0 }), 150).paysAll).toBe(false);
  });
});

describe('Stage 0: the gap book on what pays after every cost', () => {
  const trip = (paysAll, netAllUsd, more = {}) => ({ legs: [{ pool: 'p1', dex: 'cpmm' }, { pool: 'p2', dex: 'ammV4' }], pays: true, netUsd: 9, paysAll, netAllUsd, inUsd: 10, gapPct: 2, ...more });

  it('counts a trip only when it pays after every cost, at what it makes after them', () => {
    const b = new GapBook({ pays: (x) => x.paysAll, net: (x) => x.netAllUsd });
    expect(b.seen('X', [trip(false, 0)], 100, 0).opened).toHaveLength(0);
    const [g] = b.seen('X', [trip(true, 0.05, { tipUsd: 0.02, gapNetUsd: 0.4, transferFeePct: 3 })], 101, 0).opened;
    expect(g).toMatchObject({ firstNetUsd: 0.05, tipUsd: 0.02, gapNetUsd: 0.4, transferFeePct: 3, firstInUsd: 10 });
  });
  it('keeps what a sender reaching it 1 s and 3 s after it opened would have found', () => {
    const b = new GapBook({ pays: (x) => x.paysAll, net: (x) => x.netAllUsd });
    b.seen('X', [trip(true, 0.05)], 100, 10_000);
    b.seen('X', [trip(true, 0.04)], 101, 10_500);
    b.seen('X', [trip(true, 0.03)], 105, 12_000);
    b.seen('X', [trip(true, 0.07)], 109, 13_500);
    const [g] = b.seen('X', [trip(false, 0)], 112, 14_000).closed;
    expect(g.netBy).toEqual({ 1000: 0.04, 3000: 0.03 });
    expect(g).toMatchObject({ ms: 4_000, slots: 12, bestNetUsd: 0.07, lastNetUsd: 0.07 });
  });
});

describe('Stage 0: watched accounts, the map, the report', () => {
  it('watches a CPMM, AMM v4 or our pool by its vaults, a PumpSwap pool by all three, a band pool by itself', () => {
    const pair = (dex) => ({ kind: 'pair', dex, address: 'a', vaultA: 'va', vaultB: 'vb' });
    for (const dex of ['cpmm', 'ammV4', 'ours']) expect(watchedOf(pair(dex))).toEqual(['va', 'vb']);
    expect(watchedOf(pair('pumpswap'))).toEqual(['a', 'va', 'vb']);
    expect(watchedOf({ kind: 'band', dex: 'whirlpool', address: 'a' })).toEqual(['a']);
  });

  it('takes the map’s coins with two or more pools the robot prices exactly, in the map’s order', () => {
    const map = {
      rows: [
        { mint: 'A', symbol: 'AAA', pools: [{ address: 'a1', dex: 'cpmm' }, { address: 'a2', dex: 'pumpswap' }, { address: 'a3', dex: 'dlmm' }] },
        { mint: 'B', symbol: 'BBB', pools: [{ address: 'b1', dex: 'cpmm' }, { address: 'b2', dex: 'whirlpool' }] },
        { mint: 'C', pools: [{ address: 'c1', dex: 'ammV4' }, { address: 'c2', dex: 'ours' }] },
        { mint: 'D', symbol: 'DDD', pools: [{ address: 'd1', dex: 'ammV4' }, { address: 'd2', dex: 'cpmm' }] },
      ],
    };
    expect(coinsFromMap(map)).toEqual([
      { mint: 'A', symbol: 'AAA', pools: [{ address: 'a1', dex: 'cpmm' }, { address: 'a2', dex: 'pumpswap' }] },
      { mint: 'C', symbol: '?', pools: [{ address: 'c1', dex: 'ammV4' }, { address: 'c2', dex: 'ours' }] },
      { mint: 'D', symbol: 'DDD', pools: [{ address: 'd1', dex: 'ammV4' }, { address: 'd2', dex: 'cpmm' }] },
    ]);
    expect(coinsFromMap(map, { max: 2 }).map((c) => c.mint)).toEqual(['A', 'C']);
    expect(coinsFromMap(null)).toEqual([]);
  });

  it('counts the money a sender reaching each gap 1 s and 3 s after it opened would have found', () => {
    const now = 100 * 60_000;
    const g = (coin, ms, slots, at1, at3, more = {}) => ({ coin, ms, slots, openedAt: 0, firstNetUsd: 0.2, bestNetUsd: 0.3, netBy: { 1000: at1, 3000: at3 }, ...more });
    const r = stage0Report([
      g('A', 100, 0, 0.2, 0.2), // gone in the slot it opened in: never there
      g('A', 1_200, 0, 0.2, 0.2), // the same, its second vault's update a second late: never there either
      g('A', 1_500, 4, 0.05, 0.04), // reached at 1 s, gone by 3 s
      g('B', 5_000, 12, 0.1, 0.08), // reached at both
      g('C', SUSPECT_MS + 1, 3_000, 9, 9), // open past ten minutes: a misread
      { coin: 'B', openedAt: now - 2_000, firstNetUsd: 0.06, bestNetUsd: 0.06, netBy: { 1000: 0.06, 3000: 0.06 } }, // still open
    ], now);
    expect(r).toMatchObject({ gaps: 5, sameSlot: 2, goneBeforeReach: 2, suspect: 1, stillOpen: 1 });
    expect(r.reach[1000].gaps).toBe(3);
    expect(r.reach[1000].usd).toBeCloseTo(0.05 + 0.1 + 0.06, 12);
    expect(r.reach[3000]).toEqual({ gaps: 1, usd: 0.08 });
    expect(r.topCoins[0]).toMatchObject({ coin: 'B', gaps: 2, reached1s: 2 });
    expect(r.topCoins[1]).toMatchObject({ coin: 'A', gaps: 3, reached1s: 1 });
    expect(r.topCoins[0].usdAt1s).toBeCloseTo(0.16, 12);
  });
});
