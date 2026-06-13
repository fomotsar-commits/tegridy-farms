import { describe, it, expect } from "vitest";
import { rankTier, RANK_TIER_GOLD_PCT, RANK_TIER_BLUE_PCT } from "./constants";

// F809: three surfaces (Modal, ShareCard, TheaterMode) used three different
// rank-tier thresholds. rankTier() is the single source they now converge on,
// encoding ShareCard's gold≤0.5% / blue≤2.5% scale.
describe("rankTier (F809)", () => {
  it("classifies the top 0.5% as gold", () => {
    // 10000 supply → gold cutoff = ceil(10000 * 0.005) = 50
    expect(rankTier(1, 10000)).toBe("gold");
    expect(rankTier(50, 10000)).toBe("gold");
    expect(rankTier(51, 10000)).not.toBe("gold");
  });

  it("classifies >0.5% and ≤2.5% as blue", () => {
    // blue cutoff = ceil(10000 * 0.025) = 250
    expect(rankTier(51, 10000)).toBe("blue");
    expect(rankTier(250, 10000)).toBe("blue");
    expect(rankTier(251, 10000)).toBe("plain");
  });

  it("classifies everything below the blue cutoff as plain (not null)", () => {
    expect(rankTier(251, 10000)).toBe("plain");
    expect(rankTier(9999, 10000)).toBe("plain");
  });

  it("returns the same tier for the same rank regardless of which surface calls it", () => {
    // The whole point of the fix: one rank → one tier, everywhere.
    const supply = 20000; // Nakamigos
    const rank = 90; // 0.45% → gold (cutoff ceil(20000*0.005)=100)
    expect(rankTier(rank, supply)).toBe("gold");
    expect(rankTier(rank, supply)).toBe(rankTier(rank, supply));
  });

  it("scales thresholds with supply", () => {
    // 13333 (GNSS) → gold cutoff = ceil(13333*0.005) = 67
    expect(rankTier(67, 13333)).toBe("gold");
    expect(rankTier(68, 13333)).toBe("blue");
  });

  it("returns null for invalid/missing rank or supply", () => {
    expect(rankTier(undefined, 10000)).toBeNull();
    expect(rankTier(0, 10000)).toBeNull();
    expect(rankTier(-5, 10000)).toBeNull();
    expect(rankTier(NaN, 10000)).toBeNull();
    expect(rankTier(10, 0)).toBeNull();
    expect(rankTier(10, undefined)).toBeNull();
  });

  it("exposes the threshold constants it derives from", () => {
    expect(RANK_TIER_GOLD_PCT).toBe(0.005);
    expect(RANK_TIER_BLUE_PCT).toBe(0.025);
  });
});
