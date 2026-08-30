// The EVM lighthouse's honesty math (deriveEvmLighthouse) — every rule here
// exists because rendering the naive number would lie:
//  - raw pool balance as "vault" counts stakers' principal as funding;
//  - a stale rewardRate after periodFinish implies yield that stopped;
//  - a failed read rendered as 0 is indistinguishable from a real zero.

import { describe, it, expect } from 'vitest';
import { deriveEvmLighthouse, fmtRaw, fmtRunway, type EvmLighthouseReads } from './evmLighthouse';

const NOW = 1_756_500_000n;

function reads(over: Partial<EvmLighthouseReads> = {}): EvmLighthouseReads {
  return {
    totalStakedRaw: 200n * 10n ** 18n,
    poolTokenBalanceRaw: 260n * 10n ** 18n, // 200 principal + 60 funded
    rewardRateRaw: 1_000n,
    periodFinishSecs: NOW + 86_400n * 30n,
    rewardsDurationSecs: 86_400n * 60n,
    userStakedRaw: 10n * 10n ** 18n,
    userEarnedRaw: 5n * 10n ** 17n,
    ...over,
  };
}

describe('deriveEvmLighthouse', () => {
  it('the vault is balance MINUS principal — the same-token law, display half', () => {
    const v = deriveEvmLighthouse(reads(), NOW);
    expect(v.vaultRaw).toBe(60n * 10n ** 18n);
    // A pool holding ONLY principal is an unfunded pool, not a 200-token vault.
    const dry = deriveEvmLighthouse(reads({ poolTokenBalanceRaw: 200n * 10n ** 18n }), NOW);
    expect(dry.vaultRaw).toBe(0n);
  });

  it('never renders a negative vault (donation-drained edge clamps to 0)', () => {
    const v = deriveEvmLighthouse(reads({ poolTokenBalanceRaw: 150n * 10n ** 18n }), NOW);
    expect(v.vaultRaw).toBe(0n);
  });

  it('paying-now dies with the period; configured survives it', () => {
    const live = deriveEvmLighthouse(reads(), NOW);
    expect(live.periodActive).toBe(true);
    expect(live.payingNowRawPerSec).toBe(1_000n);

    const over = deriveEvmLighthouse(reads({ periodFinishSecs: NOW - 1n }), NOW);
    expect(over.periodActive).toBe(false);
    expect(over.payingNowRawPerSec).toBe(0n); // a real, labeled zero
    expect(over.configuredRawPerSec).toBe(1_000n); // still stated as configuration
    expect(over.runwaySecs).toBe(0n);
  });

  it('a never-funded pool (periodFinish 0) reads as inactive, not broken', () => {
    const v = deriveEvmLighthouse(reads({ periodFinishSecs: 0n, rewardRateRaw: 0n }), NOW);
    expect(v.periodActive).toBe(false);
    expect(v.payingNowRawPerSec).toBe(0n);
    expect(v.coreKnown).toBe(true);
  });

  it('an unreadable core figure is an outage, and every derived number it touches goes null', () => {
    const v = deriveEvmLighthouse(reads({ poolTokenBalanceRaw: null }), NOW);
    expect(v.coreKnown).toBe(false);
    expect(v.vaultRaw).toBeNull(); // NOT 0 — an outage must never dress as empty
    const v2 = deriveEvmLighthouse(reads({ periodFinishSecs: null }), NOW);
    expect(v2.payingNowRawPerSec).toBeNull();
    expect(v2.runwaySecs).toBeNull();
  });

  it('runway is exact seconds to periodFinish', () => {
    const v = deriveEvmLighthouse(reads(), NOW);
    expect(v.runwaySecs).toBe(86_400n * 30n);
  });
});

describe('formatters', () => {
  it('fmtRaw renders null as a dash, never a zero', () => {
    expect(fmtRaw(null, 18)).toBe('—');
    expect(fmtRaw(0n, 18)).toBe('0');
    expect(fmtRaw(1_500_000_000_000_000_000n, 18)).toBe('1.5');
  });
  it('fmtRunway says ended at 0 and dashes on outage', () => {
    expect(fmtRunway(null)).toBe('—');
    expect(fmtRunway(0n)).toBe('ended');
    expect(fmtRunway(90_000n)).toBe('1d 1h');
  });
});
