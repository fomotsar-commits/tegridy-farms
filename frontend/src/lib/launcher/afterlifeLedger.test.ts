import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { summarizeAfterlife } from './afterlifeLedger';
import type { OutcomeRecord } from './outcomes';

const DAY = 86_400;
const NOW = 1_800_000_000;

/** Build an OutcomeRecord with healthy defaults; override per case. */
function rec(over: Partial<OutcomeRecord> & { token: Address }): OutcomeRecord {
  return {
    tier: 'flagship',
    launchedAt: NOW - 10 * DAY,
    observedAt: NOW,
    priceEth: 1,
    launchPriceEth: 1,
    liquidityEth: 10,
    launchLiquidityEth: 10,
    holderCount: 100,
    unlocks: [],
    lastTeamActivityAt: NOW - DAY, // recent → not abandoned
    marketObserved: true,
    ...over,
  };
}

describe('summarizeAfterlife — honest cohort ledger', () => {
  it('self-gates to all-zero / null on empty input (no fabricated launches)', () => {
    const s = summarizeAfterlife([]);
    expect(s.tracked).toBe(0);
    expect(s.observed).toBe(0);
    expect(s.unavailable).toBe(0);
    expect(s.clean).toBe(0);
    expect(s.liquidityDrained).toBe(0);
    expect(s.stillLiquid).toBe(0);
    expect(s.medianPriceReturn).toBeNull();
    expect(s.asOf).toBeNull();
  });

  it('counts a healthy launch as clean + still-liquid, with a factual price move', () => {
    const s = summarizeAfterlife([
      rec({ token: '0x01' as Address, priceEth: 2, launchPriceEth: 1 }),
    ]);
    expect(s.tracked).toBe(1);
    expect(s.observed).toBe(1);
    expect(s.clean).toBe(1);
    expect(s.stillLiquid).toBe(1);
    expect(s.liquidityDrained).toBe(0);
    expect(s.medianPriceReturn).toBe(1); // +100%
  });

  it('flags a liquidity drain and excludes it from still-liquid/clean', () => {
    const s = summarizeAfterlife([
      // 1 ETH now vs 10 ETH at launch → 90% below → drained.
      rec({ token: '0x02' as Address, liquidityEth: 1, launchLiquidityEth: 10 }),
    ]);
    expect(s.liquidityDrained).toBe(1);
    expect(s.stillLiquid).toBe(0);
    expect(s.clean).toBe(0);
  });

  it('counts unlock dumps and abandonment, which can overlap on one launch', () => {
    const s = summarizeAfterlife([
      rec({
        token: '0x03' as Address,
        unlocks: [{ at: NOW - 5 * DAY, amountBps: 500, soldWithinWindow: true }],
        lastTeamActivityAt: NOW - 60 * DAY, // > 30d default → abandoned
      }),
    ]);
    expect(s.unlockDumped).toBe(1);
    expect(s.likelyAbandoned).toBe(1);
    expect(s.clean).toBe(0);
    // Adverse flags overlap: they must NOT be assumed to sum to `observed`.
    expect(s.observed).toBe(1);
  });

  it('NEVER derives adverse/clean signals from a market-unavailable record', () => {
    // A drained-LOOKING record, but marketObserved:false → its price/liquidity are
    // baseline mirrors, so it must count ONLY toward tracked + unavailable.
    const s = summarizeAfterlife([
      rec({
        token: '0x04' as Address,
        marketObserved: false,
        liquidityEth: 0,
        launchLiquidityEth: 10,
        priceEth: 0,
        launchPriceEth: 1,
      }),
    ]);
    expect(s.tracked).toBe(1);
    expect(s.unavailable).toBe(1);
    expect(s.observed).toBe(0);
    expect(s.liquidityDrained).toBe(0); // not fabricated from an unobserved read
    expect(s.clean).toBe(0);
    expect(s.stillLiquid).toBe(0);
    expect(s.medianPriceReturn).toBeNull(); // no observed price to report
    expect(s.asOf).toBe(NOW); // but the as-of stamp still spans it
  });

  it('reports the median price move over observed, positive-launch-price records only', () => {
    const s = summarizeAfterlife([
      rec({ token: '0x05' as Address, priceEth: 2, launchPriceEth: 1 }), // +100%
      rec({ token: '0x06' as Address, priceEth: 0.5, launchPriceEth: 1 }), // -50%
      rec({ token: '0x07' as Address, priceEth: 1, launchPriceEth: 1 }), // 0%
    ]);
    expect(s.medianPriceReturn).toBe(0); // median of {-0.5, 0, 1}
  });

  it('takes asOf as the MAX observedAt across all records', () => {
    const s = summarizeAfterlife([
      rec({ token: '0x08' as Address, observedAt: NOW - DAY }),
      rec({ token: '0x09' as Address, observedAt: NOW }),
    ]);
    expect(s.asOf).toBe(NOW);
  });
});
