import { describe, it, expect } from "vitest";
import { estimateTokenValue, tradeDelta } from "./lib/valuation";

describe("estimateTokenValue", () => {
  it("returns plain floor when rank/supply are unknown", () => {
    expect(estimateTokenValue({ floor: 0.1 })).toBe(0.1);
    expect(estimateTokenValue({ floor: 0.1, rank: 5 })).toBe(0.1); // no supply
  });

  it("returns 0 when floor is unknown", () => {
    expect(estimateTokenValue({ floor: NaN, rank: 1, supply: 100 })).toBe(0);
    expect(estimateTokenValue({})).toBe(0);
  });

  it("scales monotonically with rarity: rarer rank → higher value, common ≈ floor", () => {
    const supply = 20000;
    const rarest = estimateTokenValue({ floor: 0.1, rank: 1, supply });
    const mid = estimateTokenValue({ floor: 0.1, rank: 10000, supply });
    const common = estimateTokenValue({ floor: 0.1, rank: 20000, supply });
    expect(rarest).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(common);
    expect(common).toBeGreaterThanOrEqual(0.1);
    expect(common).toBeLessThan(0.11); // commons sit at ~floor
    expect(rarest).toBeLessThanOrEqual(0.5); // 5× hard cap
  });

  it("matches the FairValueBadge formula exactly (single source of truth)", () => {
    const floor = 0.2, rank = 42, supply = 9696;
    const percentile = 1 - (rank - 1) / supply;
    const expected = Math.min(floor * (1 + (Math.log1p(percentile * 9) / Math.log(10)) * 1.5), floor * 5);
    expect(estimateTokenValue({ floor, rank, supply })).toBeCloseTo(expected, 12);
  });
});

describe("tradeDelta", () => {
  it("computes signed imbalance from the give side", () => {
    expect(tradeDelta(1, 1.1)).toBeCloseTo(0.1, 10);
    expect(tradeDelta(1, 0.9)).toBeCloseTo(-0.1, 10);
    expect(tradeDelta(2, 2)).toBe(0);
  });

  it("returns null when either side is unknown or zero", () => {
    expect(tradeDelta(0, 1)).toBe(null);
    expect(tradeDelta(1, 0)).toBe(null);
    expect(tradeDelta(NaN, 1)).toBe(null);
  });
});
