import { describe, it, expect } from 'vitest';
import { GapBook, HANDOVER_TTL_MS, Outcomes, SUSPECT_MS, accountsOf, afterCosts, byEachVenue, coinsByAccount, coinsFromMap, gapsFromLog, handoverOf, handoverStands, outcomeOf, outcomesFromLog, stage0Report, watchedOf } from './arb-listen.mjs';

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
    // A band pool's tick arrays and a bin pool's bin arrays, once read, move its price too.
    expect(accountsOf({ kind: 'band', address: 'a', arrays: ['t1', 't2'] })).toEqual(['a', 't1', 't2']);
    expect(accountsOf({ kind: 'bins', address: 'a', vaultA: 'va', vaultB: 'vb', arrays: ['b1'] })).toEqual(['a', 'va', 'vb', 'b1']);
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
    // Tick arrays change only with liquidity: re-read, not watched. Bin arrays change with every swap: watched.
    expect(watchedOf({ kind: 'band', dex: 'clmm', address: 'a', arrays: ['t1'] })).toEqual(['a']);
    expect(watchedOf({ kind: 'band', dex: 'whirlpool', address: 'a', arrays: ['o', 't1'], oracle: 'o' })).toEqual(['a', 'o']);
    expect(watchedOf({ kind: 'bins', dex: 'dlmm', address: 'a', vaultA: 'va', vaultB: 'vb', arrays: ['b1', 'b2'] })).toEqual(['a', 'b1', 'b2']);
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

describe('Stage 0: the gaps in the listener’s log', () => {
  const line = (event, route, openedAt, at, more = {}) => JSON.stringify({ event, at: new Date(at).toISOString(), route, openedAt, coin: 'X', firstNetUsd: 0.1, bestNetUsd: 0.1, netBy: { 1000: 0.1, 3000: 0.1 }, ...more });
  it('keeps each gap once: its close when it closed, its open when it never did', () => {
    const lines = [
      line('open', 'a>b', 1_000, 1_000),
      line('open', 'c>d', 2_000, 2_000),
      'not json, a line cut short',
      line('close', 'a>b', 1_000, 4_000, { ms: 3_000, slots: 7 }),
      line('open', 'a>b', 9_000, 9_000),
    ];
    const { gaps, firstAt, lastAt } = gapsFromLog(lines);
    expect(gaps.map((g) => [g.route, g.openedAt, g.ms])).toEqual([['a>b', 1_000, 3_000], ['c>d', 2_000, undefined], ['a>b', 9_000, undefined]]);
    expect(gaps[0]).not.toHaveProperty('event');
    expect([firstAt, lastAt]).toEqual([1_000, 9_000]);
    expect(stage0Report(gaps, lastAt)).toMatchObject({ gaps: 3, stillOpen: 2 });
  });
  it('from a time on: only gaps that opened since', () => {
    const lines = [line('open', 'a>b', 1_000, 1_000), line('close', 'a>b', 1_000, 4_000, { ms: 3_000, slots: 7 }), line('open', 'c>d', 5_000, 5_000)];
    expect(gapsFromLog(lines, 2_000).gaps.map((g) => g.route)).toEqual(['c>d']);
  });
});

const SOL = 'So11111111111111111111111111111111111111112';
const M = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
/** A trip as tripsFor judges it and afterCosts prices it: two legs, our pool then a DLMM pool. */
const payingTrip = (over = {}) => ({
  coin: SOL,
  legs: [{ pool: 'p1', dex: 'ours', from: SOL, to: M, fee: 0.003 }, { pool: 'p2', dex: 'dlmm', from: M, to: SOL, fee: 0.001 }],
  inRaw: 1e9, outs: [2e9, 1.001e9], inUsd: 90, gainUsd: 0.09, feeUsd: 0.004, floorUsd: 0.006, netUsd: 0.086, tipUsd: 0.027, netAllUsd: 0.059, gapPct: 1.1, transferFeePct: 0, paysAll: true,
  ...over,
});
const ctx = (over = {}) => ({ coin: { mint: M, symbol: 'X', decimals: 6 }, slot: 5, now: 1000, usd: new Map([[SOL, 90], ['USDC', 1]]), programOf: (m) => (m === M ? 'Tok22' : 'Tok'), arraysOf: (pool) => (pool === 'p2' ? ['arr1', 'arr2'] : []), ...over });

describe('handoverOf: the record the engine hands the robot', () => {
  it('names the route, each leg with the accounts its quote read, the size and pays as decimal strings, the prices, and when it stops standing', () => {
    const r = handoverOf(payingTrip(), ctx());
    expect(r).toMatchObject({ id: 'p1>p2@5@1000', route: 'p1>p2', at: 1000, slot: 5, expiresAt: 1000 + HANDOVER_TTL_MS, coin: SOL, mint: M, symbol: 'X', decimals: 6, inRaw: '1000000000', outs: ['2000000000', '1001000000'], netAllUsd: 0.059, tipUsd: 0.027, gapPct: 1.1 });
    expect(r.legs[1]).toEqual({ pool: 'p2', dex: 'dlmm', from: M, to: SOL, fee: 0.001, inCut: 0, outCut: 0, accounts: ['arr1', 'arr2'] });
    expect(r.legs[0].accounts).toEqual([]);
    expect(r.mints).toEqual({ [SOL]: 'Tok', [M]: 'Tok22' });
    expect(r.usd).toEqual({ [SOL]: 90 });
    expect(handoverStands(r, 1000 + HANDOVER_TTL_MS - 1)).toBe(true);
    expect(handoverStands(r, 1000 + HANDOVER_TTL_MS)).toBe(false);
  });
  it('floors a fractional size and pay to whole units', () => {
    const r = handoverOf(payingTrip({ inRaw: 123.9, outs: [456.7, 124.2] }), ctx());
    expect(r.inRaw).toBe('123');
    expect(r.outs).toEqual(['456', '124']);
  });
  it('carries a transfer fee’s cuts on the legs that pay it', () => {
    const t = payingTrip({ transferFeePct: 3 });
    t.legs[0].outCut = 0.03;
    t.legs[1].inCut = 0.03;
    const r = handoverOf(t, ctx());
    expect(r.legs.map((l) => [l.inCut, l.outCut])).toEqual([[0, 0.03], [0.03, 0]]);
    expect(r.transferFeePct).toBe(3);
  });
  it.each([
    ['a trip that does not pay after every cost', { paysAll: false }],
    ['no size', { inRaw: 0 }],
    ['no pays', { outs: undefined }],
    ['a pay of nothing', { outs: [2e9, 0] }],
    ['pays that do not match the legs', { outs: [2e9] }],
    ['four legs', { legs: [{ pool: 'a', dex: 'ours', from: SOL, to: M }, { pool: 'b', dex: 'ours', from: M, to: 'U' }, { pool: 'c', dex: 'ours', from: 'U', to: 'T' }, { pool: 'd', dex: 'ours', from: 'T', to: SOL }], outs: [1, 1, 1, 1] }],
    ['a leg on an exchange the robot does not build for', { legs: [{ pool: 'p1', dex: 'ours', from: SOL, to: M }, { pool: 'p2', dex: 'phoenix', from: M, to: SOL }] }],
  ])('hands nothing over for %s', (_what, over) => {
    expect(handoverOf(payingTrip(over), ctx())).toBeNull();
  });
});

describe('outcomeOf and Outcomes: what the robot said it did', () => {
  it('takes an id, an outcome word, a time and a note, stripped of hidden marks and cut short', () => {
    expect(outcomeOf({ id: 'p1>p2@5@1000', outcome: 'test-\u200bchecks', ms: 412.6, note: 'x'.repeat(300) })).toEqual({ id: 'p1>p2@5@1000', outcome: 'test-checks', ms: 413, note: 'x'.repeat(240), route: 'p1>p2' });
    expect(outcomeOf({ id: 'p1>p2@5@1000', outcome: 'stale' })).toMatchObject({ ms: null, note: null });
  });
  it('refuses what is not an outcome', () => {
    expect(outcomeOf(null)).toBeNull();
    expect(outcomeOf({ outcome: 'sent' })).toBeNull();
    expect(outcomeOf({ id: 'x', outcome: 7 })).toBeNull();
  });
  it('counts by outcome word, keeps the latest whole, and gives the median time to act', () => {
    const o = new Outcomes(2);
    o.add(outcomeOf({ id: 'a@1@1', outcome: 'stale', ms: 900 }), 1);
    o.add(outcomeOf({ id: 'b@1@1', outcome: 'test-checks', ms: 300 }), 2);
    o.add(outcomeOf({ id: 'c@1@1', outcome: 'stale', ms: 1200 }), 3);
    expect(o.counts()).toEqual({ total: 3, byOutcome: { stale: 2, 'test-checks': 1 }, medianActMs: 900 });
    expect(o.latest.map((x) => x.id)).toEqual(['c@1@1', 'b@1@1']);
    expect(new Outcomes().counts()).toEqual({ total: 0, byOutcome: {}, medianActMs: null });
  });
});

describe('outcomesFromLog: the robot’s answers in the gap log', () => {
  it('tallies outcome lines, skipping gaps and junk, and says the share gone before a trip could land', () => {
    const lines = [
      JSON.stringify({ event: 'open', route: 'a>b', openedAt: 1 }),
      JSON.stringify({ event: 'outcome', at: '2026-11-07T17:00:00Z', id: 'a>b@1@1', outcome: 'stale', ms: 1200 }),
      JSON.stringify({ event: 'outcome', at: '2026-11-07T17:00:01Z', id: 'a>b@1@2', outcome: 'test-checks', ms: 400 }),
      JSON.stringify({ event: 'outcome', at: '2026-11-07T17:00:02Z', id: 'a>b@1@3', outcome: 'not-sent', ms: 350 }),
      JSON.stringify({ event: 'outcome', at: '2026-11-07T16:00:00Z', id: 'old@1@1', outcome: 'sent', ms: 300 }),
      'not json',
    ];
    const r = outcomesFromLog(lines, Date.parse('2026-11-07T16:30:00Z'));
    expect(r).toMatchObject({ total: 3, byOutcome: { stale: 1, 'test-checks': 1, 'not-sent': 1 }, medianActMs: 400, died: 2, wouldLand: 1 });
    expect(r.diedShare).toBeCloseTo(2 / 3, 6);
    expect(outcomesFromLog([]).diedShare).toBeNull();
  });
});
