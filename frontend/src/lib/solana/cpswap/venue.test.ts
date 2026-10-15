import { describe, it, expect } from 'vitest';
import * as venue from './venue';
import { feeSplit, solOf, LAMPORTS_PER_SOL } from './venue';

// Fee arithmetic over a config the chain returned. The module keeps no rates of its own,
// so a page has nothing to fall back to when a read fails.

describe('venue.ts', () => {
  it('carries no fee tier of its own, so a failed read has no guess to show', () => {
    const tiers = Object.entries(venue as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'object' && v !== null && 'tradeFeeRate' in v)
      .map(([k]) => k);
    expect(tiers).toEqual([]);
    // The operator argument list for a tier that already exists on mainnet.
    expect(venue).not.toHaveProperty('createAmmConfigArgs');
  });
});

describe('feeSplit', () => {
  it('reads a 0.25% tier with a 20% venue share as 0.20% to LPs and 0.05% to the venue', () => {
    // Shaped like mainnet config 0 on 2026-10-01: trade 2500, protocol 200000, fund 0.
    const s = feeSplit({ tradeFeeRate: 2_500n, protocolFeeRate: 200_000n, fundFeeRate: 0n });
    expect(s.tradeFeePct).toBeCloseTo(0.25, 10);
    expect(s.venueShareOfFeePct).toBeCloseTo(20, 10);
    expect(s.venueTakesPct).toBeCloseTo(0.05, 10);
    expect(s.lpKeepsPct).toBeCloseTo(0.2, 10);
  });

  it('counts the fund share as the venue\'s too', () => {
    const s = feeSplit({ tradeFeeRate: 2_500n, protocolFeeRate: 120_000n, fundFeeRate: 40_000n });
    expect(s.venueShareOfFeePct).toBeCloseTo(16, 10);
    expect(s.venueTakesPct).toBeCloseTo(0.04, 10);
    expect(s.lpKeepsPct).toBeCloseTo(0.21, 10);
  });

  it('always accounts for every basis point of the trade fee: LP + venue == the trade fee', () => {
    for (const c of [
      { tradeFeeRate: 2_500n, protocolFeeRate: 200_000n, fundFeeRate: 0n },
      { tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n },
      { tradeFeeRate: 10_000n, protocolFeeRate: 500_000n, fundFeeRate: 0n },
      { tradeFeeRate: 100n, protocolFeeRate: 0n, fundFeeRate: 0n },
      { tradeFeeRate: 0n, protocolFeeRate: 120_000n, fundFeeRate: 40_000n },
    ]) {
      const s = feeSplit(c);
      expect(s.lpKeepsPct + s.venueTakesPct).toBeCloseTo(s.tradeFeePct, 10);
    }
  });

  it('forms each part exactly, rather than by subtracting floats', () => {
    // 0.3 - 0.075 is 0.22499999999999998 in doubles, which a two-decimal display
    // renders as 0.22 — understating an LP's cut by half a basis point on the
    // one number this venue asks them to judge it by.
    const s = feeSplit({ tradeFeeRate: 3_000n, protocolFeeRate: 250_000n, fundFeeRate: 0n });
    expect(s.lpKeepsPct).toBe(0.225);
    expect(s.venueTakesPct).toBe(0.075);
    expect(s.lpKeepsPct.toFixed(2)).toBe('0.23');
  });
});

describe('solOf', () => {
  it('converts without floating-point drift at sane magnitudes', () => {
    expect(solOf(LAMPORTS_PER_SOL)).toBe(1);
    expect(solOf(0n)).toBe(0);
    expect(solOf(150_000_000n)).toBe(0.15);
  });
});
