// Vectors, not snapshots.
//
// Every function under test converts a raw contract answer into a percentage a
// reader will act on. A wrong exponent does not throw, does not fail a render
// and does not look wrong — it produces a plausible number. So each conversion
// is pinned against an independently-derived expected value, and each refusal is
// pinned against the input that must produce it.

import { describe, it, expect } from 'vitest';
import {
  aaveRayRateToApyPct,
  chainlinkRatio,
  classifyFeedLeg,
  compoundPerSecondToAprPct,
  compoundPerSecondToApyPct,
  previousRoundIds,
  ssrToApyPct,
  trailingNavGrowthApyPct,
  vsNav,
  type FeedRound,
} from './onchain';

const round = (over: Partial<FeedRound> = {}): FeedRound => ({
  roundId: (2n << 64n) | 820n,
  answer: 1_100_000_000_000_000_000n,
  updatedAt: 1_788_323_063n,
  answeredInRound: (2n << 64n) | 820n,
  ...over,
});

describe('rate conversions land on the same number the protocol quotes', () => {
  it('turns an Aave ray APR into a per-second compounded APY', () => {
    // 5% APR in ray compounded every second for a year is e^0.05 − 1 = 5.127%.
    expect(aaveRayRateToApyPct(50_000_000_000_000_000_000_000_000n)).toBeCloseTo(5.127, 3);
  });

  it('reads the live Aave figure as the rate Aave itself shows', () => {
    // currentLiquidityRate at mainnet block 25888268, read by
    // scripts/verify-yield-protocols.mjs.
    expect(aaveRayRateToApyPct(33_810_757_545_313_917_493_098_710n)).toBeCloseTo(3.439, 2);
  });

  it('compounds Compound per second and keeps the APR for the source string', () => {
    expect(compoundPerSecondToApyPct(1_500_000_000n)).toBeCloseTo(4.844, 2);
    expect(compoundPerSecondToAprPct(1_500_000_000n)).toBeCloseTo(4.730, 2);
    // The two must differ: printing the APR under an APY label is the drift this
    // pair of functions exists to make impossible.
    expect(compoundPerSecondToApyPct(1_500_000_000n)).not.toBeCloseTo(compoundPerSecondToAprPct(1_500_000_000n), 2);
  });

  it('treats ssr() as a growth FACTOR, not a rate', () => {
    // Live value at block 25888268 → 3.52%. Read as a rate rather than a factor
    // this would annualise to an astronomical number, which is exactly the
    // failure mode: it would not throw, it would rank first.
    expect(ssrToApyPct(1_000_000_001_096_988_989_836_188_433n)).toBeCloseTo(3.52, 1);
    expect(ssrToApyPct(1_000_000_001_547_125_957_863_212_448n)).toBeCloseTo(5.0, 1);
  });
});

describe('round-id arithmetic never crosses a phase', () => {
  it('stops at the first round of the phase instead of walking into the previous aggregator', () => {
    const ids = previousRoundIds((1n << 64n) | 3n, 8);
    expect(ids).toEqual([(1n << 64n) | 2n, (1n << 64n) | 1n]);
  });

  it('walks the full window when the phase is deep enough', () => {
    expect(previousRoundIds((2n << 64n) | 820n, 8)).toHaveLength(8);
  });
});

describe('a trailing rate is refused unless two rounds are far enough apart', () => {
  const latest = round({ answer: 1_102_580_930_735_330_000n, updatedAt: 1_788_323_063n });
  const blockTs = 1_788_335_951n;
  const block = 25_888_268n;

  it('refuses a ten-hour span rather than annualising jitter', () => {
    const near = round({ roundId: (2n << 64n) | 819n, answer: 1_102_489_816_318_585_500n, updatedAt: latest.updatedAt - 36_000n });
    const out = trailingNavGrowthApyPct('weETH / ETH', latest, [near], blockTs, block);
    expect(out.state).toBe('unavailable');
    expect(out.state === 'unavailable' && out.reason).toMatch(/20 hours/);
    // And specifically NOT a zero.
    expect(JSON.stringify(out)).not.toContain('"value":0');
  });

  it('annualises the EARLIEST qualifying round and names both of them', () => {
    // Live weETH / ETH rounds at block 25888268: eight days apart, +2.08%/yr.
    const prior = [
      round({ roundId: (2n << 64n) | 819n, answer: 1_102_489_816_318_585_500n, updatedAt: 1_788_236_651n }),
      round({ roundId: (2n << 64n) | 812n, answer: 1_102_084_452_111_205_600n, updatedAt: 1_787_631_647n }),
    ];
    const out = trailingNavGrowthApyPct('weETH / ETH', latest, prior, blockTs, block);
    expect(out.state).toBe('read');
    if (out.state !== 'read') throw new Error('unreachable');
    expect(out.value).toBeCloseTo(2.08, 1);
    // Both round ids and both timestamps, so a reader can check the span.
    expect(out.source).toContain('36893488147419104044');
    expect(out.source).toContain('36893488147419104052');
    expect(out.source).toMatch(/8\.0 days apart/);
    expect(out.source).toContain('getRoundData');
  });

  it('reports a decline as a real negative number rather than clamping at zero', () => {
    // Live ezETH / ETH: the published rate FELL over the window. Clamping this
    // would be the fabricated floor the module exists to refuse.
    const ez = round({ roundId: (2n << 64n) | 819n, answer: 1_081_546_937_469_586_650n, updatedAt: 1_788_322_979n });
    const prior = [round({ roundId: (2n << 64n) | 811n, answer: 1_081_940_564_243_566_500n, updatedAt: 1_787_631_587n })];
    const out = trailingNavGrowthApyPct('ezETH / ETH', ez, prior, blockTs, block);
    expect(out.state).toBe('read');
    expect(out.state === 'read' && out.value).toBeLessThan(0);
  });
});

describe('a Chainlink round is refused on any of four grounds', () => {
  const blockTs = 1_788_335_951n;
  const block = 25_888_268n;
  const read = (over: Partial<FeedRound>, heartbeat = 86_400) =>
    chainlinkRatio('RETH / ETH', round(over), 18, blockTs, block, heartbeat, 'ETH');

  it('refuses a non-positive answer', () => {
    expect(read({ answer: 0n }).state).toBe('unavailable');
    expect(read({ answer: -1n }).state).toBe('unavailable');
  });

  it('refuses an answer carried forward from an earlier round', () => {
    const out = read({ answeredInRound: (2n << 64n) | 819n });
    expect(out.state).toBe('unavailable');
    expect(out.state === 'unavailable' && out.reason).toMatch(/carried an answer forward/);
  });

  it('refuses a round stamped after the block that read it', () => {
    const out = read({ updatedAt: blockTs + 1n });
    expect(out.state).toBe('unavailable');
    expect(out.state === 'unavailable' && out.reason).toMatch(/stamped in the future/);
  });

  it('marks stale at twice the heartbeat and not before', () => {
    // 20h old against a 24h heartbeat is a healthy feed.
    const fresh = read({ updatedAt: blockTs - 72_000n });
    expect(fresh.state === 'read' && fresh.stale).toBe(false);
    // 49h old is two missed publications.
    const stale = read({ updatedAt: blockTs - 176_400n });
    expect(stale.state === 'read' && stale.stale).toBe(true);
  });

  it('stamps a healthy read with the ROUND\'s time, not the block\'s', () => {
    const out = read({ updatedAt: blockTs - 3_600n });
    expect(out.state).toBe('read');
    if (out.state !== 'read') throw new Error('unreachable');
    expect(out.asOf).toBe(Number(blockTs - 3_600n));
    expect(out.ageSeconds).toBe(3_600);
    expect(out.maxAgeS).toBe(172_800);
    expect(out.block).toBe(Number(block));
    expect(out.source).toContain('RETH / ETH');
  });
});

describe('feed classification refutes in one direction only', () => {
  it('refuses an exchange-rate feed that has stopped tracking its protocol', () => {
    const out = classifyFeedLeg('weETH / ETH', 'exchange-rate', 1.08, 1.1027);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toMatch(/no longer tracking/);
  });

  it('accepts an exchange-rate feed sitting on its protocol rate', () => {
    expect(classifyFeedLeg('weETH / ETH', 'exchange-rate', 1.102581, 1.102758)).toEqual({
      ok: true,
      marketClass: 'exchange-rate',
    });
  });

  it('NEVER reclassifies a market feed for trading close to NAV', () => {
    // The live numbers that refuted the spec's symmetric 5-bps test: CBETH / ETH
    // and RETH / ETH are both market feeds and sat 4.55 and 5.68 bps from their
    // protocols' rates at block 25888268 — on opposite sides of a 5-bps line.
    // A market feed must survive both.
    expect(classifyFeedLeg('CBETH / ETH', 'market', 1.137992813082469, 1.1385111805544543).ok).toBe(true);
    expect(classifyFeedLeg('RETH / ETH', 'market', 1.170216685446728, 1.1708820395403978).ok).toBe(true);
  });

  it('accepts an exchange-rate feed with no protocol rate to check against', () => {
    // ezETH: Renzo exposes no cheap on-chain rate view, so there is nothing to
    // refute with. The row says so rather than inventing a cross-check.
    expect(classifyFeedLeg('ezETH / ETH', 'exchange-rate', 1.0815, null).ok).toBe(true);
  });
});

describe('vs-NAV is a plain division', () => {
  it('reports a discount and a premium as the same kind of number', () => {
    expect(vsNav(1.0961, 1.1006)).toBeCloseTo(0.99591, 4);
    expect(vsNav(1.0002, 1)).toBe(1.0002);
  });
});
