import { describe, it, expect } from 'vitest';
import {
  analyzeHolding,
  deriveHoldingExposure,
  positionShareOfTotal,
  summarizeExposures,
  UNMEASURED_REASON,
  type HoldingExposure,
} from './walletExposure';
import { analyzeDistribution, type RawHolder } from './index';

// The wallet-exposure adapter's ONE job beyond the core is honest gating: never
// present a band without real holder data, and report the wallet's own position
// share exactly. These tests pin those invariants.

function eqHolders(n: number, each: bigint = 1000n): RawHolder[] {
  return Array.from({ length: n }, (_, i) => ({
    address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    balance: each,
  }));
}

describe('positionShareOfTotal', () => {
  it('is the wallet balance over total supply', () => {
    expect(positionShareOfTotal(25n, 100n)).toBeCloseTo(0.25, 10);
  });
  it('returns null when total supply is unknown — never 0% "exposure"', () => {
    expect(positionShareOfTotal(25n, null)).toBeNull();
    expect(positionShareOfTotal(25n, 0n)).toBeNull();
  });
  it('returns 0 for a zero balance against a known supply', () => {
    expect(positionShareOfTotal(0n, 100n)).toBe(0);
  });
  it('keeps precision on 18-decimal balances above 2^53', () => {
    const supply = 1_000_000_000n * 10n ** 18n; // 1B tokens
    const bal = 2_000_000n * 10n ** 18n; // 2M tokens => 0.2%
    expect(positionShareOfTotal(bal, supply)).toBeCloseTo(0.002, 9);
  });
});

describe('deriveHoldingExposure — honest-framing gate', () => {
  it('null analysis ⇒ unmeasured, no fabricated band', () => {
    const e = deriveHoldingExposure(null);
    expect(e.status).toBe('unmeasured');
    expect(e.band).toBeNull();
    expect(e.headline).toBeNull();
    expect(e.reason).toBe(UNMEASURED_REASON);
  });

  it('an analysis over ZERO included holders is still unmeasured (no empty-set band)', () => {
    // A scanner that returns an empty holder set must NOT surface as a passing
    // "well-distributed" — that would be a fabricated safe read.
    const empty = analyzeDistribution({ holders: [], totalSupply: 1000n });
    expect(empty.metrics.includedHolders).toBe(0);
    const e = deriveHoldingExposure(empty);
    expect(e.status).toBe('unmeasured');
    expect(e.band).toBeNull();
  });

  it('a real holder distribution ⇒ measured, carrying the core band verbatim', () => {
    const analysis = analyzeHolding({ holders: eqHolders(200), totalSupply: 200_000n });
    const e = deriveHoldingExposure(analysis);
    expect(e.status).toBe('measured');
    expect(e.band).toBe(analysis.band);
    expect(e.headline).toBe(analysis.headline);
    expect(e.confidence).toBe(analysis.confidence.level);
    expect(e.band).not.toBeNull();
  });

  it('carries the observedAt from the analysis so the read is timestamped', () => {
    const analysis = analyzeHolding({ holders: eqHolders(60), observedAt: 1_700_000_000 });
    const e = deriveHoldingExposure(analysis);
    expect(e.observedAt).toBe(1_700_000_000);
  });
});

describe('summarizeExposures', () => {
  const measured = (band: HoldingExposure['band']): HoldingExposure => ({
    status: 'measured',
    analysis: null,
    band,
    headline: 'x',
    confidence: 'high',
    reason: '',
    observedAt: 0,
  });
  const unmeasured: HoldingExposure = {
    status: 'unmeasured',
    analysis: null,
    band: null,
    headline: null,
    confidence: null,
    reason: 'pending',
    observedAt: 0,
  };

  it('reports the WORST measured band and ignores unmeasured holdings', () => {
    const s = summarizeExposures([measured('well-distributed'), measured('concentrated'), unmeasured]);
    expect(s.measured).toBe(2);
    expect(s.unmeasured).toBe(1);
    expect(s.worstBand).toBe('concentrated');
  });

  it('worstBand is null when nothing was measurable — never a fake "safe"', () => {
    const s = summarizeExposures([unmeasured, unmeasured]);
    expect(s.measured).toBe(0);
    expect(s.worstBand).toBeNull();
  });
});
