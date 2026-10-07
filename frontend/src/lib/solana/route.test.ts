import { describe, it, expect } from 'vitest';
import { chooseRoute, type RouteCandidate } from './route';

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
  });

  it('has no tolerance band: one raw unit is enough to lose', () => {
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
  });

  it('breaks an exact tie in our favour, the one preference the rule allows', () => {
    const d = chooseRoute([agg(1_000_000n), own(1_000_000n)]);
    expect(d.chosen?.venue).toBe('own-pool');
    expect(d.edge).toBe(0);
  });

  it('is order-independent: the input array order cannot decide the winner', () => {
    const a = chooseRoute([own(5n), agg(9n)]);
    const b = chooseRoute([agg(9n), own(5n)]);
    expect(a.chosen).toEqual(b.chosen);
    expect(a.edge).toBe(b.edge);
  });

  it('falls back cleanly when only one venue quotes', () => {
    const onlyAgg = chooseRoute([agg(1_000n)]);
    expect(onlyAgg.chosen?.venue).toBe('aggregator');
    expect(onlyAgg.runnerUp).toBe(null);
    expect(onlyAgg.edge).toBe(null);

    const onlyOwn = chooseRoute([own(1_000n)]);
    expect(onlyOwn.chosen?.venue).toBe('own-pool');
    expect(onlyOwn.edge).toBe(null);
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
    expect(d.candidates).toEqual([]);
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
