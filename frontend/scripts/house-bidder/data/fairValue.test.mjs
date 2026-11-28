// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { fairValue, DEFAULT_FAIR_VALUE_PARAMS } from './fairValue.mjs';

const ETH = 10n ** 18n;
const FINNEY = 10n ** 15n; // 0.001 ETH
const DAY = 86_400;
const NOW = 1_800_000_000;
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
let n = 0;
const hash = () => `0x${(++n).toString(16).padStart(64, '0')}`;

/** A kept tape sale: `ageDays` before NOW, `finney` thousandths of an ETH, kind 'listing' unless a bid. */
const sale = ({ ageDays = 1, finney = 1000, seller = addr(++n), kind = 'listing' } = {}) => ({ txHash: hash(), time: NOW - Math.round(ageDays * DAY), tokenId: String(n), priceWei: BigInt(finney) * FINNEY, seller, buyer: addr(9000 + n), kind });
/** `count` sales from `sellers` distinct sellers, all at the same age and price. */
const sales = (count, { sellers = count, ...rest } = {}) => Array.from({ length: count }, (_, i) => sale({ seller: addr(5000 + (i % sellers)), ...rest }));

/** A public ETH listing `ageMin` minutes old. */
const listing = ({ maker, finney, ageMin = 120, createdAgeMin, endsInMin = 600, taker = null, currency = 'ETH' }) => ({
  orderHash: hash(),
  tokenId: String(n),
  priceWei: BigInt(finney) * FINNEY,
  maker,
  startTime: NOW - ageMin * 60,
  endTime: NOW + endsInMin * 60,
  createdAt: createdAgeMin == null ? NOW - ageMin * 60 : NOW - createdAgeMin * 60,
  taker,
  currency,
});
const allFillable = (ls) => new Map(ls.map((l) => [l.orderHash, { fillable: true }]));
/** Five sellers' listings at 900..1300 finney, all old and fillable: L is the third, 1100. */
const book = () => [900, 1000, 1100, 1200, 1300].map((f, i) => listing({ maker: addr(700 + i), finney: f }));

describe('fairValue: S from the tape', () => {
  it('refuses to price a thin tape: under 8 sales', () => {
    const r = fairValue({ tape: sales(7), listings: book(), fillable: allFillable(book()), now: NOW });
    expect(r).toMatchObject({ S: null, F: null, reason: 'thin', n: 7 });
    const ok = fairValue({ tape: sales(8), listings: [], now: NOW });
    expect(ok.S).toBe(ETH);
  });

  it('refuses to price a tape from under 5 distinct sellers', () => {
    const r = fairValue({ tape: sales(12, { sellers: 4 }), listings: [], now: NOW });
    expect(r).toMatchObject({ S: null, reason: 'thin', n: 12, sellers: 4 });
  });

  it('reads only the last 14 days of the tape', () => {
    const tape = [...sales(8), ...sales(10, { ageDays: 15, finney: 5000 })];
    const r = fairValue({ tape, listings: [], now: NOW });
    expect(r.n).toBe(8);
    expect(r.S).toBe(ETH);
  });

  it('uses the weighted median under 15 sales, so one odd print cannot move S', () => {
    const tape = [...sales(9), sale({ finney: 10_000 })];
    const r = fairValue({ tape, listings: [], now: NOW });
    expect(r.method).toBe('median');
    expect(r.S).toBe(ETH);
  });

  it('uses the volume-weighted average from 15 sales', () => {
    const tape = [...sales(14), sale({ finney: 2500 })];
    const r = fairValue({ tape, listings: [], now: NOW });
    expect(r.method).toBe('vwap');
    // (14 x 1 + 2.5) / 15 = 1.1 ETH exactly: every sale has the same age and kind, so the same weight.
    expect(r.S).toBe(1100n * FINNEY);
  });

  it('weights a sale into a bid 1.5x', () => {
    // Age 0, so recency weighs every sale exactly 1 and only the bid weight differs.
    const tape = [...sales(10, { ageDays: 0, finney: 1000 }), ...sales(5, { ageDays: 0, finney: 700, kind: 'bid' })];
    const r = fairValue({ tape, listings: [], now: NOW });
    // (10 x 1.0 x 2 + 5 x 0.7 x 3) / (10 x 2 + 5 x 3): weights 1 and 1.5 written as 2 and 3.
    expect(r.S).toBe((10n * 1000n * FINNEY * 2n + 5n * 700n * FINNEY * 3n) / 35n);
  });

  it('halves the weight of a sale every 7 days', () => {
    const tape = [...sales(10, { ageDays: 0, finney: 1000 }), ...sales(5, { ageDays: 7, finney: 2000 })];
    const r = fairValue({ tape, listings: [], now: NOW });
    // (10 x 1.0 + 5 x 0.5 x 2.0) / (10 + 2.5) = 1.2 ETH.
    expect(r.S).toBe(1200n * FINNEY);
  });

  it('reads now in milliseconds or seconds alike', () => {
    const a = fairValue({ tape: sales(9), listings: book(), fillable: allFillable(book()), now: NOW });
    const b = fairValue({ tape: sales(9), listings: book(), fillable: allFillable(book()), now: NOW * 1000 });
    expect(b.S).toBe(a.S);
    expect(b.n).toBe(a.n);
  });
});

describe('fairValue: L from fillable, aged listings of distinct sellers', () => {
  const tape = sales(9, { finney: 5000 });

  it('is the 3rd cheapest of the per-seller cheapest listings', () => {
    const ls = [...book(), listing({ maker: addr(700), finney: 950 }), listing({ maker: addr(700), finney: 960 })];
    const r = fairValue({ tape, listings: ls, fillable: allFillable(ls), now: NOW });
    // Seller 700's three listings count once (at 900): sellers rank 900, 1000, 1100.
    expect(r.L).toBe(1100n * FINNEY);
  });

  it('skips a listing the chain says cannot be filled', () => {
    const ls = book();
    const fillable = allFillable(ls);
    fillable.set(ls[0].orderHash, { fillable: false, reason: 'not-owner' });
    const r = fairValue({ tape, listings: ls, fillable, now: NOW });
    expect(r.L).toBe(1200n * FINNEY);
    // Nobody can buy a stale listing either, so it does not set the arbitrage line.
    expect(r.cheapestFillable).toBe(1000n * FINNEY);
  });

  it('skips a listing younger than 30 minutes, judged from when OpenSea received it', () => {
    const fresh = listing({ maker: addr(800), finney: 500, ageMin: 10 });
    // Backdated: startTime two days ago, but OpenSea only received it 5 minutes ago.
    const backdated = listing({ maker: addr(801), finney: 600, ageMin: 2 * 24 * 60, createdAgeMin: 5 });
    const ls = [...book(), fresh, backdated];
    const r = fairValue({ tape, listings: ls, fillable: allFillable(ls), now: NOW });
    expect(r.L).toBe(1100n * FINNEY);
    // Any age counts for the arbitrage line: a flipper can buy a fresh listing at once.
    expect(r.cheapestFillable).toBe(500n * FINNEY);
  });

  it('never counts a house listing', () => {
    const ls = [listing({ maker: addr(1), finney: 100 }), ...book()];
    const r = fairValue({ tape, listings: ls, fillable: allFillable(ls), now: NOW, houseWallets: [addr(1)] });
    expect(r.L).toBe(1100n * FINNEY);
    expect(r.cheapestFillable).toBe(900n * FINNEY);
  });

  it('skips private, expired and non-ETH listings', () => {
    const ls = [
      listing({ maker: addr(810), finney: 100, taker: addr(42) }),
      listing({ maker: addr(811), finney: 100, endsInMin: -1 }),
      listing({ maker: addr(812), finney: 100, currency: 'USDC' }),
      ...book(),
    ];
    const r = fairValue({ tape, listings: ls, fillable: allFillable(ls), now: NOW });
    expect(r.L).toBe(1100n * FINNEY);
    expect(r.cheapestFillable).toBe(900n * FINNEY);
  });

  it('gives no L, and no F, with fewer than 3 qualifying sellers', () => {
    const ls = book().slice(0, 2);
    const r = fairValue({ tape: sales(9), listings: ls, fillable: allFillable(ls), now: NOW });
    expect(r).toMatchObject({ L: null, F: null, reason: 'no-listings' });
    expect(r.S).toBe(ETH);
  });
});

describe('fairValue: F, the rise cap and the breaker floor', () => {
  it('is the lower of S and L', () => {
    const ls = book();
    const low = fairValue({ tape: sales(9, { finney: 800 }), listings: ls, fillable: allFillable(ls), now: NOW });
    expect(low.F).toBe(800n * FINNEY);
    const high = fairValue({ tape: sales(9, { finney: 5000 }), listings: ls, fillable: allFillable(ls), now: NOW });
    expect(high.F).toBe(1100n * FINNEY);
  });

  it('rises at most 5% an hour from the previous F', () => {
    const ls = book();
    const prev = { version: 1, F: (1000n * FINNEY).toString(), atSec: NOW - 3_600 };
    // S is 2.0 ETH and L 2.2 ETH, so F would jump from 1.0 to 2.0 in an hour without the cap.
    const r = fairValue({ tape: sales(9, { finney: 2000 }), listings: ls.map((l) => ({ ...l, priceWei: l.priceWei * 2n })), fillable: allFillable(ls), now: NOW, prev });
    expect(r.Fraw).toBe(2000n * FINNEY);
    expect(r.F).toBe(1050n * FINNEY);
    expect(r.capped).toBe(true);
    expect(r.state).toEqual({ version: 1, F: (1050n * FINNEY).toString(), atSec: NOW });
  });

  it('falls at once', () => {
    const ls = book();
    const prev = { version: 1, F: (3000n * FINNEY).toString(), atSec: NOW - 60 };
    const r = fairValue({ tape: sales(9, { finney: 800 }), listings: ls, fillable: allFillable(ls), now: NOW, prev });
    expect(r.F).toBe(800n * FINNEY);
    expect(r.capped).toBe(false);
  });

  it('does not bank rise allowance while F is missing', () => {
    const prev = { version: 1, F: (1000n * FINNEY).toString(), atSec: NOW - 5 * 3_600 };
    const thin = fairValue({ tape: sales(3), listings: [], now: NOW, prev });
    expect(thin.F).toBe(null);
    expect(thin.state).toEqual({ version: 1, F: (1000n * FINNEY).toString(), atSec: NOW });
    // One hour later F is back at 2 ETH raw: it may only be 5% over the last F, not 30%.
    const ls = book().map((l) => ({ ...l, priceWei: l.priceWei * 2n }));
    const back = fairValue({ tape: sales(9, { finney: 2000 }), listings: ls, fillable: allFillable(ls), now: NOW + 3_600, prev: thin.state });
    expect(back.F).toBe(1050n * FINNEY);
  });

  it('gives the breakers a floor that still works when fillability is unknown, but not when known bad', () => {
    const ls = book();
    const none = fairValue({ tape: sales(9), listings: ls, fillable: new Map(), now: NOW });
    expect(none.L).toBe(null);
    expect(none.floorProxy).toBe(1100n * FINNEY);
    const bad = new Map([[ls[0].orderHash, { fillable: false }]]);
    expect(fairValue({ tape: sales(9), listings: ls, fillable: bad, now: NOW }).floorProxy).toBe(1200n * FINNEY);
    const fresh = ls.map((l) => ({ ...l, startTime: NOW - 60, createdAt: NOW - 60 }));
    expect(fairValue({ tape: sales(9), listings: fresh, fillable: new Map(), now: NOW }).floorProxy).toBe(null);
  });

  it('keeps the documented defaults', () => {
    expect(DEFAULT_FAIR_VALUE_PARAMS).toEqual({ windowDays: 14, halfLifeDays: 7, bidWeight: 1.5, minSales: 8, minSellers: 5, medianBelow: 15, listingRank: 3, listingMinAgeMin: 30, riseCapPerHour: 0.05 });
  });
});
