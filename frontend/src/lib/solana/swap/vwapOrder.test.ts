// A VWAP order's arithmetic and record: how the total is cut into slices, when each may go,
// what a missed slice carries on, the limit against the 24h average, and that a record that
// does not read exactly is never run.
import { describe, it, expect, beforeEach } from 'vitest';
import { SOL_MINT } from '../../solana';
import {
  RETRY_MS,
  advance,
  filledTotals,
  nextAction,
  orderAveragePrice,
  orderStorageKey,
  parseOrder,
  planOrder,
  readOrder,
  sliceCountsFor,
  sliceVerdict,
  sliceWeights,
  splitTotal,
  withSlice,
  writeOrder,
  type VwapOrder,
} from './vwapOrder';

const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
// Synthetic keys (32 bytes of 3s and of 4s), not anyone's wallet.
const WALLET = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const OTHER = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';
const SIG = '5LJAXrtqJJXfsfDQvWPkvfD1xQF6E3RR21RPt1R6YwaCmk65QtTaahhebRYr4qaxQ4DmpWLwVvcDdWfyBd6ugQrw';
const SOL = { mint: SOL_MINT, symbol: 'SOL', decimals: 9 };
const BAY = { mint: BAYLA, symbol: 'BAYLA', decimals: 6 };
// 2026-11-19 00:00:00 UTC.
const T0 = Date.UTC(2026, 10, 19);
const HOUR = 3_600_000;

function order(over: Partial<Parameters<typeof planOrder>[0]> = {}): VwapOrder {
  const o = planOrder({ id: 'o1', wallet: WALLET, pay: SOL, buy: BAY, total: 1_000_000_000n, startAt: T0, durationS: 4 * 3_600, count: 4, bandBps: 100, profile: null, ...over });
  if (!o) throw new Error('no plan');
  return o;
}

describe('the plan', () => {
  it('slices are at least 15 minutes apart', () => {
    expect(sliceCountsFor(3_600)).toEqual([4]);
    expect(sliceCountsFor(14_400)).toEqual([4, 8, 12]);
    expect(sliceCountsFor(86_400)).toEqual([4, 8, 12, 24]);
    expect(planOrder({ id: 'x', wallet: WALLET, pay: SOL, buy: BAY, total: 1_000n, startAt: T0, durationS: 3_600, count: 8, bandBps: 100, profile: null })).toBeNull();
  });

  it('with no day to follow, even slices, due one gap apart, summing exactly to the total', () => {
    const o = order({ total: 1_000_000_003n });
    expect(o.sizing).toBe('even');
    expect(o.slices.map((s) => s.dueAt)).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]);
    expect(o.slices.map((s) => s.planned)).toEqual(['250000000', '250000000', '250000000', '250000003']);
    expect(o.endAt).toBe(T0 + 4 * HOUR);
  });

  it('with a day to follow, a busy hour gets more, held between half and twice an even share', () => {
    // 00:00 to 04:00 UTC: hour 0 trades 3, hour 1 nothing, hour 2 ten (past twice an even share).
    const profile = new Array<number>(24).fill(3);
    profile[1] = 0;
    profile[2] = 10;
    const w = sliceWeights(T0 / 1_000, 3_600, 4, profile);
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    expect(w[2]).toBeGreaterThan(w[0]!);
    expect(w[1]).toBeLessThan(w[0]!);
    for (const x of w) {
      expect(x).toBeLessThanOrEqual(2 / 4 + 1e-9);
      expect(x).toBeGreaterThanOrEqual(0.5 / 4 * 0.8);
    }
    expect(order({ profile }).sizing).toBe('volume');
  });

  it('a profile that is not 24 clean numbers is ignored: even slices', () => {
    expect(sliceWeights(0, 900, 4, [1, 2])).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(sliceWeights(0, 900, 4, new Array(24).fill(Number.NaN))).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(sliceWeights(0, 900, 4, new Array(24).fill(0))).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it('refuses a total too small for every slice to pay something, the same coin twice, or a limit not offered', () => {
    expect(splitTotal(3n, [0.25, 0.25, 0.25, 0.25])).toBeNull();
    expect(planOrder({ id: 'x', wallet: WALLET, pay: SOL, buy: SOL, total: 10n ** 9n, startAt: T0, durationS: 3_600, count: 4, bandBps: 100, profile: null })).toBeNull();
    expect(planOrder({ id: 'x', wallet: WALLET, pay: SOL, buy: BAY, total: 10n ** 9n, startAt: T0, durationS: 3_600, count: 4, bandBps: 7, profile: null })).toBeNull();
  });
});

describe('what the runner does next', () => {
  it('waits for the first slice, then sends it when due', () => {
    const o = order();
    expect(nextAction(o, T0 - 1)).toEqual({ kind: 'wait', until: T0 });
    expect(nextAction(o, T0)).toEqual({ kind: 'send', index: 0, amount: 250_000_000n });
  });

  it('a slice that waited is asked again after a minute, never sooner', () => {
    const o = withSlice(order(), 0, { triedAt: T0 + 5_000, why: 'price' });
    expect(nextAction(o, T0 + 5_000 + RETRY_MS - 1)).toEqual({ kind: 'wait', until: T0 + 5_000 + RETRY_MS });
    expect(nextAction(o, T0 + 5_000 + RETRY_MS)).toMatchObject({ kind: 'send', index: 0 });
  });

  it('a slice whose window passed is missed, and what it was to pay goes with the next one', () => {
    const o = advance(order(), T0 + HOUR);
    expect(o.slices[0]!.state).toBe('missed');
    expect(nextAction(o, T0 + HOUR)).toEqual({ kind: 'send', index: 1, amount: 500_000_000n });
  });

  it('after a slice filled, the next waits for its own time and pays only its own part', () => {
    let o = withSlice(order(), 0, { state: 'filled', sig: SIG, paid: '250000000', got: '50000000000', gotExact: true });
    expect(nextAction(o, T0 + 10)).toEqual({ kind: 'wait', until: T0 + HOUR });
    o = advance(o, T0 + HOUR);
    expect(nextAction(o, T0 + HOUR)).toEqual({ kind: 'send', index: 1, amount: 250_000_000n });
  });

  it('a slice the person said no to in the wallet is not asked again in its window', () => {
    const o = withSlice(order(), 0, { declined: true });
    expect(nextAction(o, T0 + 10 * 60_000)).toEqual({ kind: 'wait', until: T0 + HOUR });
  });

  it('nothing is sent while a slice is out: it is settled first, even after a stop', () => {
    const out = withSlice(order(), 0, { state: 'unconfirmed', sig: SIG, sentAt: T0 });
    expect(nextAction(advance(out, T0 + 2 * HOUR), T0 + 2 * HOUR)).toEqual({ kind: 'resolve', index: 0 });
    expect(nextAction({ ...out, stoppedAt: T0 + 1 }, T0 + 2)).toEqual({ kind: 'resolve', index: 0 });
    expect(nextAction(withSlice(order(), 0, { state: 'sending' }), T0)).toEqual({ kind: 'resolve', index: 0 });
  });

  it('ends: stopped, filled, or out of time with what is left unspent', () => {
    expect(nextAction({ ...order(), stoppedAt: T0 }, T0)).toEqual({ kind: 'done', why: 'stopped' });
    let o = order();
    for (let i = 0; i < 4; i++) o = withSlice(o, i, { state: 'filled', sig: SIG, paid: o.slices[i]!.planned, got: '1' });
    expect(nextAction(o, T0)).toEqual({ kind: 'done', why: 'filled' });
    expect(nextAction(advance(order(), T0 + 4 * HOUR), T0 + 4 * HOUR)).toEqual({ kind: 'done', why: 'ended' });
  });

  it('never sends more than is left, even when earlier slices paid more than planned', () => {
    const o = advance(withSlice(order(), 0, { state: 'filled', sig: SIG, paid: '900000000', got: '1' }), T0 + 3 * HOUR);
    expect(nextAction(o, T0 + 3 * HOUR)).toEqual({ kind: 'send', index: 3, amount: 100_000_000n });
  });
});

describe('the limit against the 24h average', () => {
  // 1 BAYLA = 0.000005 SOL on average.
  const avg = { kind: 'ok' as const, baseMint: BAYLA, quoteMint: SOL_MINT, price: 0.000005 };
  const buy = { pay: SOL, buy: BAY, bandBps: 100 };
  const sell = { pay: BAY, buy: SOL, bandBps: 100 };

  it('buying: goes at or under 1% above the average, waits past it', () => {
    // 1 SOL buys 198,000 BAYLA: 0.00000505 SOL each, 1.0% above.
    expect(sliceVerdict(avg, buy, 10n ** 9n, 198_020_000_000n)).toMatchObject({ go: true });
    const v = sliceVerdict(avg, buy, 10n ** 9n, 190_000_000_000n); // 5.26% above
    expect(v.go).toBe(false);
    expect(!v.go && v.why).toContain('5.26% above the 24h average, past your 1%');
  });

  it('a price better than the average always goes', () => {
    expect(sliceVerdict(avg, buy, 10n ** 9n, 300_000_000_000n)).toMatchObject({ go: true });
    expect(sliceVerdict(avg, sell, 200_000_000_000n, 2n * 10n ** 9n)).toMatchObject({ go: true });
  });

  it('selling: waits when it gets more than 1% under the average', () => {
    const v = sliceVerdict(avg, sell, 200_000_000_000n, 900_000_000n); // 10% below
    expect(v.go).toBe(false);
    expect(!v.go && v.why).toContain('below the 24h average');
  });

  it('no average read, too little trading, no market, or another pair: waits, never goes', () => {
    for (const a of [{ kind: 'unread' as const }, { kind: 'thin' as const }, { kind: 'none' as const }]) {
      expect(sliceVerdict(a, buy, 10n ** 9n, 10n ** 15n).go).toBe(false);
    }
    expect(sliceVerdict({ ...avg, baseMint: 'mGZypHvkPkpRjUvLuwUjtz3QH5V3kj46xT6qzoa1Fm8' }, buy, 10n ** 9n, 10n ** 15n).go).toBe(false);
  });
});

describe('what the order paid and its own average', () => {
  it('counts only filled slices, and says the price the way the swap form does', () => {
    let o = order();
    o = withSlice(o, 0, { state: 'filled', sig: SIG, paid: '250000000', got: '50000000000', gotExact: true });
    o = withSlice(o, 1, { state: 'missed' });
    o = withSlice(o, 2, { state: 'filled', sig: SIG, paid: '250000000', got: '50000000000', gotExact: false });
    expect(filledTotals(o)).toEqual({ paid: 500_000_000n, got: 100_000_000_000n, filled: 2, exact: false });
    const p = orderAveragePrice(o);
    expect(p?.base.symbol).toBe('BAYLA');
    expect(p?.quote.symbol).toBe('SOL');
    expect(p?.price).toBeCloseTo(0.000005, 15);
    expect(orderAveragePrice(order())).toBeNull();
  });
});

describe('the record in this browser', () => {
  beforeEach(() => localStorage.clear());

  it('reads back exactly what was written, for that wallet only', () => {
    const o = withSlice(order(), 0, { state: 'unconfirmed', sig: SIG, sentAt: T0 + 1 });
    expect(writeOrder(o)).toBe(true);
    expect(readOrder(WALLET)).toEqual(o);
    expect(readOrder(OTHER)).toBeNull();
  });

  it('a record that is not exactly an order is never run', () => {
    const good = JSON.parse(JSON.stringify(order())) as Record<string, unknown>;
    const bad: Array<(o: Record<string, unknown> & { slices: Array<Record<string, unknown>> }) => void> = [
      (o) => { o.total = '999'; }, // slices no longer sum to it
      (o) => { o.slices[0]!.planned = '-1'; },
      (o) => { o.slices[0]!.state = 'unconfirmed'; }, // out with no signature
      (o) => { o.slices[0]!.state = 'filled'; o.slices[0]!.sig = SIG; }, // filled with no amounts
      (o) => { o.slices[1]!.dueAt = o.slices[0]!.dueAt; },
      (o) => { o.bandBps = 5_000; },
      (o) => { (o.pay as Record<string, unknown>).mint = 'not-a-mint'; },
      (o) => { o.buy = o.pay; },
      (o) => { o.wallet = OTHER; },
    ];
    expect(parseOrder(good, WALLET)).not.toBeNull();
    for (const spoil of bad) {
      const o = JSON.parse(JSON.stringify(good)) as Record<string, unknown> & { slices: Array<Record<string, unknown>> };
      spoil(o);
      expect(parseOrder(o, WALLET)).toBeNull();
    }
    localStorage.setItem(orderStorageKey(WALLET), '{not json');
    expect(readOrder(WALLET)).toBeNull();
  });
});
