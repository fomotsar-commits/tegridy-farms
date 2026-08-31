import { describe, it, expect } from 'vitest';
import {
  chooseRoute,
  ownPoolCandidate,
  aggregatorCandidate,
  type RouteCandidate,
} from './route';

/**
 * The routing rule is a best-execution promise, so the tests that matter are
 * the ones where OUR POOL LOSES. A router that only gets tested on the happy
 * path is a router that self-preferences in production and passes CI.
 */

const own = (out: bigint): RouteCandidate =>
  ({ venue: 'own-pool', outAmount: out, label: 'Tegridy pool', poolAddress: 'PooL111' });
const agg = (out: bigint): RouteCandidate =>
  ({ venue: 'aggregator', outAmount: out, label: 'Jupiter' });

describe('chooseRoute', () => {
  it('sends the trade elsewhere when elsewhere is better, by any margin', () => {
    const d = chooseRoute([own(1_000_000n), agg(1_000_001n)]);
    expect(d.chosen?.venue).toBe('aggregator');
    expect(d.runnerUp?.venue).toBe('own-pool');
    expect(d.reason).toMatch(/so the trade went there/);
  });

  it('has no tolerance band — one raw unit is enough to lose', () => {
    // A "within N bps, keep it in-house" band is how best execution quietly
    // becomes marketing. There is deliberately no such knob.
    for (const better of [1n, 2n, 10n, 1_000n]) {
      const d = chooseRoute([own(1_000_000n), agg(1_000_000n + better)]);
      expect(d.chosen?.venue, `agg better by ${better}`).toBe('aggregator');
    }
  });

  it('keeps the trade in-house when our pool is better', () => {
    const d = chooseRoute([own(1_010_000n), agg(1_000_000n)]);
    expect(d.chosen?.venue).toBe('own-pool');
    expect(d.edge).toBeCloseTo(0.01, 10);
    expect(d.reason).toMatch(/1% more output than Jupiter/);
  });

  it('breaks an exact tie in our favour — the one preference the rule allows', () => {
    const d = chooseRoute([agg(1_000_000n), own(1_000_000n)]);
    expect(d.chosen?.venue).toBe('own-pool');
    expect(d.edge).toBe(0);
    expect(d.reason).toMatch(/same output, so the trade stays here/);
  });

  it('is order-independent — the input array order cannot decide the winner', () => {
    const a = chooseRoute([own(5n), agg(9n)]);
    const b = chooseRoute([agg(9n), own(5n)]);
    expect(a.chosen).toEqual(b.chosen);
    expect(a.reason).toBe(b.reason);
  });

  it('falls back cleanly when only one venue quotes', () => {
    const onlyAgg = chooseRoute([agg(1_000n)]);
    expect(onlyAgg.chosen?.venue).toBe('aggregator');
    expect(onlyAgg.runnerUp).toBe(null);
    expect(onlyAgg.edge).toBe(null);
    expect(onlyAgg.reason).toMatch(/no pool for this pair/);

    const onlyOwn = chooseRoute([own(1_000n)]);
    expect(onlyOwn.chosen?.venue).toBe('own-pool');
    expect(onlyOwn.reason).toMatch(/only venue that quoted/);
  });

  it('treats a zero quote as no quote, never as a candidate', () => {
    const d = chooseRoute([own(0n), agg(1_000n)]);
    expect(d.candidates).toHaveLength(1);
    expect(d.chosen?.venue).toBe('aggregator');
    expect(d.runnerUp).toBe(null);
  });

  it('says so, rather than inventing a route, when nothing quotes', () => {
    const d = chooseRoute([]);
    expect(d.chosen).toBe(null);
    expect(d.reason).toBe('No venue could quote this trade.');
    expect(chooseRoute([own(0n), agg(0n)]).chosen).toBe(null);
  });

  it('compares amounts as BigInt, so precision does not decide the winner', () => {
    // Two quotes 1 unit apart, far beyond Number.MAX_SAFE_INTEGER. As doubles
    // these are equal and the tie-break would hand it to us.
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const d = chooseRoute([own(big), agg(big + 1n)]);
    expect(d.chosen?.venue).toBe('aggregator');
  });
});

describe('ownPoolCandidate', () => {
  it('carries the pool through so the surface can link it', () => {
    const c = ownPoolCandidate({ outAmount: 5n, poolAddress: 'PooL111', priceImpact: 0.01 })!;
    expect(c).toMatchObject({ venue: 'own-pool', outAmount: 5n, poolAddress: 'PooL111' });
  });
  it('is absent, not zero, when there is no pool or no quote', () => {
    expect(ownPoolCandidate(null)).toBe(null);
    expect(ownPoolCandidate({ outAmount: 0n, poolAddress: 'P' })).toBe(null);
  });
});

describe('aggregatorCandidate', () => {
  it('uses outAmount, NOT the post-slippage floor', () => {
    // otherAmountThreshold is smaller by the slippage tolerance; comparing it
    // against our un-slipped quote would bias every decision toward our pool.
    const c = aggregatorCandidate({ outAmount: '1000000', priceImpactPct: '0.0012' })!;
    expect(c.outAmount).toBe(1_000_000n);
    expect(c.priceImpact).toBeCloseTo(0.0012, 10);
  });

  it('survives a malformed quote without throwing', () => {
    expect(aggregatorCandidate(null)).toBe(null);
    expect(aggregatorCandidate({ outAmount: 'not-a-number' })).toBe(null);
    expect(aggregatorCandidate({ outAmount: '0' })).toBe(null);
    expect(aggregatorCandidate({ outAmount: '-5' })).toBe(null);
    // A non-numeric impact must not become NaN on the decision object.
    expect(aggregatorCandidate({ outAmount: '10', priceImpactPct: 'x' })!.priceImpact).toBe(undefined);
  });

  it('handles an output larger than Number.MAX_SAFE_INTEGER exactly', () => {
    const c = aggregatorCandidate({ outAmount: '18446744073709551615' })!;
    expect(c.outAmount).toBe(18_446_744_073_709_551_615n);
  });
});
