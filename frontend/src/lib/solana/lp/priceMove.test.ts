// @vitest-environment node
//
// "What if the price moves" on the Add form: a constant-product position against just
// holding both tokens. Every expected figure is worked by hand from 2*sqrt(r)/(1+r) - 1.
import { describe, it, expect } from 'vitest';
import { FORECAST_WORDS } from './format';
import { livePool } from './mainnetPool.fixture';
import type { PoolView } from './poolFinder';
import { PRICE_MOVE_TITLE, priceMoveNote, vsHolding } from './priceMove';
import { USDC_QUOTE } from './quotes';

describe('vsHolding: 2*sqrt(r)/(1+r) - 1', () => {
  it('at a quarter, a half, the same, double and four times the price', () => {
    // r = 4: 2*2/5 - 1 = -0.2. r = 1/4: 2*0.5/1.25 - 1 = -0.2.
    expect(vsHolding(4)).toBeCloseTo(-0.2, 12);
    expect(vsHolding(0.25)).toBeCloseTo(-0.2, 12);
    // r = 2: 2*1.41421356237/3 - 1 = -0.05719095842. r = 1/2: 2*0.70710678119/1.5 - 1, the same.
    expect(vsHolding(2)).toBeCloseTo(-0.05719095842, 10);
    expect(vsHolding(0.5)).toBeCloseTo(-0.05719095842, 10);
    // r = 1: 2*1/2 - 1, exactly nothing.
    expect(vsHolding(1)).toBe(0);
  });

  it('is the same for a move and its inverse, and never above nothing', () => {
    for (const r of [1.0001, 1.5, 2, 3, 4, 10, 100, 1e6, 1e12]) {
      const up = vsHolding(r)!;
      expect(vsHolding(1 / r)).toBeCloseTo(up, 9);
      expect(up).toBeLessThan(0);
      expect(up).toBeGreaterThan(-1);
    }
    // Right beside 1 a float could land a hair above nothing: it is capped there.
    for (const r of [1 + 1e-15, 1 - 1e-15, 1 + 1e-9, 1 - 1e-9]) expect(vsHolding(r)).toBeLessThanOrEqual(0);
  });

  it('a further move always costs more', () => {
    const moves = [1, 1.1, 1.5, 2, 3, 4, 10, 100].map((r) => vsHolding(r)!);
    for (let i = 1; i < moves.length; i++) expect(moves[i]).toBeLessThan(moves[i - 1]!);
  });

  it('gives no figure for a price that is not a positive number', () => {
    for (const silly of [0, -0, -1, -4, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(vsHolding(silly)).toBeNull();
    for (const silly of ['2', null, undefined, 2n, {}, [4]]) expect(vsHolding(silly as unknown as number)).toBeNull();
  });

  it('stays a finite loss at the edges of what a number can hold', () => {
    for (const r of [Number.MIN_VALUE, 1e-300, 1e300, Number.MAX_VALUE]) {
      const v = vsHolding(r)!;
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeLessThanOrEqual(0);
      expect(v).toBeGreaterThanOrEqual(-1);
    }
  });
});

/** The venue's own BAYLA/SOL pool as mainnet held it, with one thing changed. */
const pool = (over: Partial<PoolView> = {}): PoolView => ({ ...livePool(), ...over });

describe('priceMoveNote: the three rows and the closing line', () => {
  it('prints the figures the function gives, a move and its inverse on one row', () => {
    const note = priceMoveNote(pool())!;
    expect(note.rows).toEqual([
      { price: 'the same', position: 'the same' },
      { price: 'double or half', position: 'about 5.7% less' },
      { price: '4 times or a quarter', position: '20% less' },
    ]);
    // Each row's figure is the function's, cut to one decimal: 5.719...% and 20%.
    expect((-vsHolding(2)! * 100).toFixed(3)).toBe('5.719');
    expect((-vsHolding(4)! * 100).toFixed(9)).toBe('20.000000000');
    expect(note.rows.length).toBeLessThanOrEqual(3);
  });

  it('names the pool’s own coin, says fees are what is meant to make up for it, and that it is not a forecast', () => {
    const note = priceMoveNote(pool())!;
    expect(note.priceHead).toBe('This token’s price in SOL, against when you added');
    expect(note.positionHead).toBe('Your position, against just holding both tokens');
    expect(note.tail).toBe('Fees are not counted in this: trading fees are what is meant to make up for it. It is arithmetic for this kind of pool, not a forecast.');
    expect(priceMoveNote(pool({ quote: USDC_QUOTE }))!.priceHead).toBe('This token’s price in USDC, against when you added');
  });

  it('on a tier that leaves liquidity providers nothing, it does not say fees make up for it', () => {
    const cfg = livePool().config!;
    // The venue and its fund take the whole trade fee (their rates are parts of a million).
    const note = priceMoveNote(pool({ config: { ...cfg, protocolFeeRate: 1_000_000n, fundFeeRate: 0n } }))!;
    expect(note.tail).toBe('Fees are not counted in this, and on this pool’s fee tier liquidity providers keep none of the trade fee. It is arithmetic for this kind of pool, not a forecast.');
    expect(note.rows).toHaveLength(3);
  });

  it('says nothing when the pool could not be read: no fee tier, or a side with nothing in it', () => {
    expect(priceMoveNote(pool({ config: null }))).toBeNull();
    expect(priceMoveNote(pool({ quoteReserve: 0n }))).toBeNull();
    expect(priceMoveNote(pool({ tokenReserve: 0n }))).toBeNull();
  });

  it('promises no return, prints no money and uses no em dash', () => {
    for (const view of [pool(), pool({ quote: USDC_QUOTE })]) {
      const note = priceMoveNote(view)!;
      const all = [PRICE_MOVE_TITLE, note.priceHead, note.positionHead, note.tail, ...note.rows.flatMap((r) => [r.price, r.position])].join(' ');
      expect(all).not.toMatch(FORECAST_WORDS);
      expect(all).not.toMatch(/[$€£]|\bUSD\b|dollar/i);
      expect(all).not.toContain('—');
    }
  });
});
