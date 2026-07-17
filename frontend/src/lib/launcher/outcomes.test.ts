import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { deriveOutcomeFlags, priceReturn, defaultOutcomeConfig, type OutcomeRecord } from './outcomes';

const NOW = 1_800_000_000;
const DAY = 86_400;

function record(over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    token: '0x01' as Address,
    tier: 'flagship',
    launchedAt: NOW - 40 * DAY,
    observedAt: NOW,
    priceEth: 0.001,
    launchPriceEth: 0.001,
    liquidityEth: 10,
    launchLiquidityEth: 10,
    holderCount: 500,
    unlocks: [],
    lastTeamActivityAt: NOW - DAY,
    ...over,
  };
}

describe('deriveOutcomeFlags — disclosed-risk detection', () => {
  it('flags a liquidity drain below the ratio with a factual disclosure', () => {
    const f = deriveOutcomeFlags(record({ liquidityEth: 3, launchLiquidityEth: 10 }));
    expect(f.liquidityDrained).toBe(true);
    expect(f.disclosures.join(' ')).toContain('70% below');
  });

  it('does not flag a healthy pool', () => {
    const f = deriveOutcomeFlags(record({ liquidityEth: 9, launchLiquidityEth: 10 }));
    expect(f.liquidityDrained).toBe(false);
    expect(f.disclosures).toContain('No adverse outcome signals recorded at this observation.');
  });

  it('flags an unlock sold within its window', () => {
    const f = deriveOutcomeFlags(record({ unlocks: [{ at: NOW - DAY, amountBps: 500, soldWithinWindow: true }] }));
    expect(f.unlockDumped).toBe(true);
  });

  it('flags likely abandonment after the silence window', () => {
    const f = deriveOutcomeFlags(record({ lastTeamActivityAt: NOW - 45 * DAY }));
    expect(f.likelyAbandoned).toBe(true);
    expect(f.disclosures.join(' ')).toContain('No creator on-chain activity');
  });

  it('never uses editorial / safety language (disclosure-only, per red-team J)', () => {
    const f = deriveOutcomeFlags(record({ liquidityEth: 1, launchLiquidityEth: 10, unlocks: [{ at: NOW, amountBps: 100, soldWithinWindow: true }] }));
    const text = f.disclosures.join(' ').toLowerCase();
    expect(text).not.toContain('rug');
    expect(text).not.toContain('scam');
    expect(text).not.toContain('safe');
  });
});

describe('priceReturn', () => {
  it('computes a signed return vs launch', () => {
    expect(priceReturn(record({ priceEth: 0.0002, launchPriceEth: 0.001 }))).toBeCloseTo(-0.8);
    expect(priceReturn(record({ priceEth: 0.003, launchPriceEth: 0.001 }))).toBeCloseTo(2);
  });
  it('is safe when launch price is zero/unknown', () => {
    expect(priceReturn(record({ launchPriceEth: 0 }))).toBe(0);
  });
});

it('default config is 50% drain ratio and 30-day abandonment', () => {
  const c = defaultOutcomeConfig();
  expect(c.liquidityDrainRatio).toBe(0.5);
  expect(c.abandonmentSeconds).toBe(30 * 86_400);
});
