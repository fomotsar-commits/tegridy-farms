// The EVM lighthouse's honesty math (deriveEvmLighthouse) — every rule here
// exists because rendering the naive number would lie:
//  - raw pool balance as "vault" counts stakers' principal as funding;
//  - a stale rewardRate after periodFinish implies yield that stopped;
//  - a failed read rendered as 0 is indistinguishable from a real zero.

import { describe, it, expect } from 'vitest';
import { deriveEvmLighthouse, fmtRaw, fmtRawUp, fmtRunway, type EvmLighthouseReads } from './evmLighthouse';

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

// What the visitor pays, loses or must stake at least: rounded up at the last digit shown,
// then written exactly as fmtRaw writes it (trailing zeros trimmed, whole part grouped).
describe('fmtRawUp', () => {
  const E18 = 10n ** 18n;

  it('0.100049 and 0.10005 at 4 digits: fmtRaw cuts both to 0.1, fmtRawUp prints 0.1001', () => {
    expect(fmtRaw(100_049_000_000_000_000n, 18, 4)).toBe('0.1');
    expect(fmtRawUp(100_049_000_000_000_000n, 18, 4)).toBe('0.1001');
    expect(fmtRaw(100_050_000_000_000_000n, 18, 4)).toBe('0.1');
    expect(fmtRawUp(100_050_000_000_000_000n, 18, 4)).toBe('0.1001');
  });

  it('a 20-day penalty on 1,000 tokens (13.698...) prints 13.7, never 13.69', () => {
    const quote = (1_000n * E18 * 20n) / 1460n;
    expect(fmtRaw(quote, 18)).toBe('13.69');
    expect(fmtRawUp(quote, 18)).toBe('13.7');
  });

  it('one raw unit over a boundary moves past it, at 2 digits and at whole tokens', () => {
    expect(fmtRawUp(E18 + 1n, 18)).toBe('1.01');
    expect(fmtRawUp(E18 + 1n, 18, 0)).toBe('2');
    expect(fmtRaw(E18 + 1n, 18, 0)).toBe('1');
  });

  it('exact values, zero, null and a negative read exactly as fmtRaw', () => {
    for (const raw of [0n, E18, 1_500_000_000_000_000_000n, 250n * E18, 100n * E18]) expect(fmtRawUp(raw, 18)).toBe(fmtRaw(raw, 18));
    for (const raw of [0n, E18, 250n * E18, 100n * E18]) expect(fmtRawUp(raw, 18, 0)).toBe(fmtRaw(raw, 18, 0));
    expect(fmtRawUp(1_500_000_000_000_000_000n, 18, 0)).toBe('2');
    expect(fmtRawUp(null, 18)).toBe(fmtRaw(null, 18));
    expect(fmtRawUp(-1_500_000_000_000_000_001n, 18)).toBe(fmtRaw(-1_500_000_000_000_000_001n, 18));
  });

  it('keeps the grouping fmtRaw gives', () => {
    expect(fmtRawUp(1_234_561_000_000_000_000_000n, 18)).toBe(`${(1234).toLocaleString()}.57`);
  });

  it('over a seeded sweep: never below the amount, and less than one shown digit above it', () => {
    let seed = 0x9e3779b9n;
    const next = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n));
    for (let k = 0; k < 3000; k++) {
      const decimals = [6, 9, 18][Number(next() % 3n)]!;
      const maxFrac = [0, 2, 4][Number(next() % 3n)]!;
      const raw = next() % (999n * 10n ** BigInt(decimals));
      const [w, f = ''] = fmtRawUp(raw, decimals, maxFrac).split('.');
      const back = BigInt(w!) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
      const unit = 10n ** BigInt(Math.max(0, decimals - maxFrac));
      expect(back >= raw && back - raw < unit).toBe(true);
    }
  });
});
