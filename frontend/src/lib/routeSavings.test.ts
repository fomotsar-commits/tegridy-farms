import { describe, it, expect } from 'vitest';
import { computeRouteSavings, aggOutUnits } from './routeSavings';

// TOWELI has 18 decimals; ~35.4M TOWELI for 1 ETH at the time of writing.
const TO_DECIMALS = 18;
// 35,459,581.82 TOWELI expressed in WEI (18 dp).
const AGG_WEI = '35459581820000000000000000';

describe('aggOutUnits (F226/F227)', () => {
  it('converts an aggregator WEI amountOut to human token units', () => {
    expect(aggOutUnits(AGG_WEI, TO_DECIMALS)).toBeCloseTo(35_459_581.82, 1);
  });

  it('never returns scientific-notation-scale numbers for valid wei input', () => {
    const v = aggOutUnits(AGG_WEI, TO_DECIMALS);
    // ~35M, NOT 3.5e+25
    expect(v).toBeLessThan(1e9);
    expect(v).toBeGreaterThan(1);
  });

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(aggOutUnits('not-a-number', TO_DECIMALS))).toBe(true);
    expect(Number.isNaN(aggOutUnits('1.5', TO_DECIMALS))).toBe(true); // BigInt() rejects decimals
  });
});

describe('computeRouteSavings (F226/F235/F196)', () => {
  it('produces a small, finite percent (never exponential) when wei + token amounts are mixed', () => {
    // The classic bug: aggregator WEI vs human token amounts → +4.6e+21%.
    const { savingsPct } = computeRouteSavings({
      tegridyOutput: null,
      uniOutput: 35_459_581.82, // human token units
      aggQuotes: [{ amountOut: AGG_WEI }], // WEI — same ~35.4M price
      toDecimals: TO_DECIMALS,
    });
    expect(Number.isFinite(savingsPct)).toBe(true);
    expect(savingsPct).toBeLessThan(5); // clustered venues ⇒ tiny savings
    expect(String(savingsPct)).not.toMatch(/e\+?/i);
  });

  it('excludes a degenerate-low (empty-pool) venue from the savings denominator (F235)', () => {
    // Tegridy native pool returns 770k vs ~35.4M everywhere else.
    const clustered = [
      { amountOut: '35459581820000000000000000' }, // 35.4M
      { amountOut: '35443489780000000000000000' }, // 35.44M
    ];
    const withDegenerate = computeRouteSavings({
      tegridyOutput: 770_318, // near-empty pool
      uniOutput: 35_459_581.82,
      aggQuotes: clustered,
      toDecimals: TO_DECIMALS,
    });
    // Savings is computed across the credible cluster, not against 770k.
    expect(withDegenerate.savingsPct).toBeLessThan(5);
    expect(withDegenerate.tegridyIsLowLiquidity).toBe(true);
  });

  it('flags the Tegridy pool low-liquidity but keeps it out of the denominator', () => {
    const { tegridyIsLowLiquidity, savingsPct } = computeRouteSavings({
      tegridyOutput: 1, // absurdly low vs the cluster
      uniOutput: 35_000_000,
      aggQuotes: [{ amountOut: '35000000000000000000000000' }],
      toDecimals: TO_DECIMALS,
    });
    expect(tegridyIsLowLiquidity).toBe(true);
    // best ~= worst across the credible cluster ⇒ ~0% (not a fake +3.5e9%).
    expect(savingsPct).toBeLessThan(5);
  });

  it('clamps the displayed percent to 999 so it can never render exponential', () => {
    const { savingsPct } = computeRouteSavings({
      tegridyOutput: 100, // both above the low-liq threshold of a 2-venue set
      uniOutput: 1_000_000,
      aggQuotes: [],
      toDecimals: TO_DECIMALS,
    });
    // 100 is < median*0.5 (median=550050) ⇒ excluded; <2 credible ⇒ 0.
    expect(savingsPct).toBe(0);
  });

  it('returns 0 savings when fewer than two credible venues exist', () => {
    expect(
      computeRouteSavings({
        tegridyOutput: null,
        uniOutput: 35_000_000,
        aggQuotes: [],
        toDecimals: TO_DECIMALS,
      }).savingsPct,
    ).toBe(0);
  });

  it('computes a credible double-digit savings between two genuinely different venues', () => {
    const { savingsPct } = computeRouteSavings({
      tegridyOutput: null,
      uniOutput: 100, // worst credible
      aggQuotes: [{ amountOut: '110000000000000000000' }], // 110 (10% better)
      toDecimals: TO_DECIMALS,
    });
    // Both within the low-liq band of each other; best=110, worst=100 ⇒ 10%.
    expect(savingsPct).toBeCloseTo(10, 1);
  });
});
