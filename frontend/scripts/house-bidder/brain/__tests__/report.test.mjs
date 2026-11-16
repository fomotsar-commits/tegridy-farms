// @vitest-environment node
//
// The monthly report (BUILD-SPEC 3.5 step 9): hours with a live bid, bids posted, expired,
// cancelled by reason, price changes, fills, cancel-to-fill ratio, median resting time, and
// inventory with its cost, all from the ledger.
import { describe, it, expect } from 'vitest';
import { monthlyReport, reportText } from '../report.mjs';
import { milli } from '../../exec/__tests__/fakes.mjs';

const H = 3_600_000;
const T0 = Date.parse('2026-11-10T00:00:00Z');
const hash = (n) => `0x${String(n).padStart(64, '0')}`;
const post = (n, at, price, qty = 1) => ({ kind: 'post', at, orderHash: hash(n), slug: 'junglebay', qty, unitPriceWei: price.toString(), endTime: Math.floor(at / 1000) + 1800 });

describe('monthly report', () => {
  const entries = [
    post(1, T0, milli(35)), // expires after 30 min
    { kind: 'expiry', at: T0 + H / 2 + 60_000, orderHash: hash(1) },
    post(2, T0 + H, milli(35)), // cancelled after 10 min
    { kind: 'cancel', at: T0 + H + 10 * 60_000, orderHash: hash(2), reason: 'arbitrage-line', method: 'gasless' },
    post(3, T0 + 2 * H, milli(33)), // filled after 20 min: a price change
    { kind: 'fill', at: T0 + 2 * H + 20 * 60_000, orderHash: hash(3), slug: 'junglebay', tokenId: '7', unitPriceWei: milli(33).toString(), time: (T0 + 2 * H + 20 * 60_000) / 1000 },
    { kind: 'breaker', at: T0 + 3 * H, breaker: 'market', reason: 'fill-burst' },
    { kind: 'post', at: T0 + 4 * H, shadow: true, orderHash: hash(9), slug: 'junglebay', qty: 1, unitPriceWei: '1', endTime: 0 },
    post(4, Date.parse('2026-10-31T23:00:00Z'), milli(36)), // last month
  ];
  const r = monthlyReport(entries, { month: '2026-11', nowMs: Date.parse('2026-11-30T00:00:00Z') });

  it('counts bids, expiries, cancels by reason, price changes and fills for the month only', () => {
    expect(r.posted).toBe(3);
    expect(r.expired).toBe(1);
    expect(r.cancelledByReason).toEqual({ 'arbitrage-line': 1 });
    expect(r.priceChanges).toBe(2); // 0.036 (October) -> 0.035, then 0.035 -> 0.033
    expect(r.fills).toBe(1);
    expect(r.wethSpent).toBe(milli(33));
    expect(r.cancelToFill).toBe(1);
    expect(r.breakers).toEqual({ 'market:fill-burst': 1 });
  });

  it('measures hours with a live bid and the median resting time from posts to their end', () => {
    expect(r.hoursWithLiveBid).toBeCloseTo((30 + 10 + 20) / 60, 5);
    expect(r.medianRestingMinutes).toBe(20);
  });

  it('shows inventory and its cost', () => {
    expect(r.inventory).toEqual({ junglebay: { held: 1, costWei: milli(33) } });
  });

  it('leaves out of the inventory an NFT sent back to the funding wallet', () => {
    const fill = (n, tokenId, price) => ({ kind: 'fill', at: T0 + n * H, orderHash: hash(n), slug: 'junglebay', tokenId, unitPriceWei: price.toString(), time: (T0 + n * H) / 1000 });
    const back = [fill(1, '7', milli(30)), fill(2, '8', milli(34)), { kind: 'nft-returned', at: T0 + 3 * H, slug: 'junglebay', tokenId: '7', to: '0x1111111111111111111111111111111111111111', txHash: hash(77) }];
    expect(monthlyReport(back, { month: '2026-11', nowMs: Date.parse('2026-11-30T00:00:00Z') }).inventory).toEqual({ junglebay: { held: 1, costWei: milli(34) } });
  });

  it('keeps shadow lines out of a live report and live lines out of a shadow one', () => {
    expect(monthlyReport(entries, { month: '2026-11', shadow: true, nowMs: Date.parse('2026-11-30T00:00:00Z') }).posted).toBe(1);
  });

  it('says n/a for a ratio with no fills, and reads as plain text', () => {
    const none = monthlyReport([post(1, T0, milli(35))], { month: '2026-11', nowMs: Date.parse('2026-11-30T00:00:00Z') });
    expect(none.cancelToFill).toBe(null);
    expect(reportText(none)).toMatch(/cancel-to-fill ratio\s+n\/a/);
    expect(() => monthlyReport([], { month: '2026-13', nowMs: 0 })).toThrow();
  });
});
