import { describe, it, expect } from 'vitest';
import { stripLayout } from './rangeStrip';

describe('the range strip lays prices on a log axis', () => {
  it('a range from half to twice the price sits evenly about it, with room at both ends', () => {
    const s = stripLayout({ now: 1, lo: 0.5, hi: 2 })!;
    expect(s.now).toBeCloseTo(50, 6);
    expect(s.now - s.band!.from).toBeCloseTo(s.band!.to - s.now, 6);
    expect(s.band!.from).toBeGreaterThan(0);
    expect(s.band!.to).toBeLessThan(100);
    expect(s.where).toBe('inside');
  });

  it('says where this pool’s price is against the range', () => {
    expect(stripLayout({ now: 1, lo: 2, hi: 4 })!.where).toBe('below');
    expect(stripLayout({ now: 5, lo: 2, hi: 4 })!.where).toBe('above');
    expect(stripLayout({ now: 1 })!.where).toBeNull();
  });

  it('the market price is drawn on the same axis, and left off when it was not read', () => {
    const s = stripLayout({ now: 1, market: 1.1, lo: 0.5, hi: 2 })!;
    expect(s.market!).toBeGreaterThan(s.now);
    expect(s.market!).toBeLessThan(s.band!.to);
    expect(stripLayout({ now: 1, market: null })!.market).toBeNull();
    expect(stripLayout({ now: 1, market: Number.NaN })!.market).toBeNull();
  });

  it('a range that is not one (low not below high, or not a price) draws no band; no pool price draws nothing', () => {
    expect(stripLayout({ now: 1, lo: 2, hi: 2 })!.band).toBeNull();
    expect(stripLayout({ now: 1, lo: 0, hi: 2 })!.band).toBeNull();
    expect(stripLayout({ now: 0 })).toBeNull();
    expect(stripLayout({ now: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('a lone price sits mid-axis, never on an edge', () => {
    const s = stripLayout({ now: 0.000042 })!;
    expect(s.now).toBeCloseTo(50, 6);
  });
});
