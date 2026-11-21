// @vitest-environment node
//
// The bid planner (BUILD-SPEC 3.5 step 2): edge, the arbitrage line, the ceiling, the price
// tick and the room under the inventory cap. Every expected price is worked out by hand in the
// test, not by calling the code under test.
import { describe, it, expect } from 'vitest';
import { planBid, trendIsDown } from '../planner.mjs';
import { PRICE_TICK_WEI } from '../constants.mjs';
import { testPolicy, milli } from '../../exec/__tests__/fakes.mjs';

const HOUSE = '0x2222222222222222222222222222222222222222';
const policy = testPolicy(HOUSE);
const base = { slug: 'junglebay', F: milli(40), cheapestFillable: milli(100), held: 0, outstanding: 0, policy };

describe('planBid: price', () => {
  it('bids fair value less 12% with nothing held and a flat market', () => {
    const p = planBid(base);
    expect(p.unitPriceWei).toBe(milli(35.2)); // 0.040 x 0.88
    expect(p.edgeBps).toBe(1200);
    expect(p.binding).toBe('fair');
  });

  it('adds 5 points of edge for each NFT held', () => {
    expect(planBid({ ...base, held: 1 }).unitPriceWei).toBe(milli(33.2)); // 0.040 x 0.83
    expect(planBid({ ...base, held: 2 }).unitPriceWei).toBe(milli(31.2)); // 0.040 x 0.78
  });

  it('adds 5 points when S is down more than 10% on 24 hours ago, and not at exactly 10%', () => {
    expect(planBid({ ...base, trend: { then: milli(40), now: milli(35.9) } }).unitPriceWei).toBe(milli(33.2)); // down 10.25%: 17%
    expect(planBid({ ...base, trend: { then: milli(40), now: milli(36) } }).unitPriceWei).toBe(milli(35.2)); // down 10.00%: 12%
    expect(planBid({ ...base, trend: null }).unitPriceWei).toBe(milli(35.2));
    expect(trendIsDown(-0.11, 1000)).toBe(true);
    expect(trendIsDown(-0.1, 1000)).toBe(false);
  });

  it('never bids above the arbitrage line: 99% of the cheapest fillable listing less 0.001 ETH', () => {
    const p = planBid({ ...base, cheapestFillable: milli(35) });
    // 0.035 x 0.99 - 0.001 = 0.03365, under the fair line 0.0352
    expect(p.unitPriceWei).toBe(milli(33.65));
    expect(p.binding).toBe('arbitrage');
  });

  it("never bids above the collection's ceiling", () => {
    const p = planBid({ ...base, F: milli(100) }); // fair line 0.088
    expect(p.unitPriceWei).toBe(milli(45));
    expect(p.binding).toBe('ceiling');
  });

  it('rounds the price DOWN to the 0.00001 ETH tick, never up', () => {
    const F = 40_012_500_000_000_001n; // x 0.88 = 0.035211000... ETH
    const p = planBid({ ...base, F });
    const raw = (F * 8800n) / 10_000n;
    expect(p.unitPriceWei % PRICE_TICK_WEI).toBe(0n);
    expect(p.unitPriceWei <= raw).toBe(true);
    expect(raw - p.unitPriceWei < PRICE_TICK_WEI).toBe(true);
    expect(p.unitPriceWei).toBe(35_210_000_000_000_000n); // 0.03521, not 0.03522
  });

  it('gives no bid when the price rounds to nothing', () => {
    expect(planBid({ ...base, F: 5_000_000_000_000n })).toEqual({ none: true, reason: 'price-too-low' });
  });

  it('is never moved by anyone else’s bids: it has no input for them', () => {
    const p = planBid({ ...base, bestBid: milli(44), bids: [{ priceWei: milli(44) }] });
    expect(p.unitPriceWei).toBe(milli(35.2));
  });
});

describe('planBid: quantity and room', () => {
  it('bids for maxQty when there is room', () => {
    expect(planBid(base).qty).toBe(2);
  });

  it('bids only for the room left: inventory cap less held less outstanding', () => {
    expect(planBid({ ...base, held: 2 }).qty).toBe(1); // 3 - 2 - 0
    expect(planBid({ ...base, outstanding: 2 }).qty).toBe(1); // 3 - 0 - 2: an old order's tail
    expect(planBid({ ...base, held: 1, outstanding: 1 }).qty).toBe(1);
  });

  it('gives no bid with no room, no fair value, or the collection off', () => {
    expect(planBid({ ...base, held: 3 })).toEqual({ none: true, reason: 'no-room' });
    expect(planBid({ ...base, held: 2, outstanding: 1 })).toEqual({ none: true, reason: 'no-room' });
    expect(planBid({ ...base, F: null })).toEqual({ none: true, reason: 'no-fair-value' });
    expect(planBid({ ...base, slug: 'gnssart', F: milli(16) })).toEqual({ none: true, reason: 'collection-disabled' });
    expect(planBid({ ...base, slug: 'bayc' })).toEqual({ none: true, reason: 'unknown-collection' });
  });

  it('refuses a holding that is not a whole number', () => {
    expect(() => planBid({ ...base, held: -1 })).toThrow(/whole number/);
    expect(() => planBid({ ...base, outstanding: 1.5 })).toThrow(/whole number/);
  });
});
