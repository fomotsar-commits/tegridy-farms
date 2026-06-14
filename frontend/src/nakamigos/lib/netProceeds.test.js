import { describe, it, expect } from "vitest";
import { computeNetProceeds, feeEthFromConsideration } from "./netProceeds";

describe("computeNetProceeds", () => {
  it("returns null for non-positive or non-finite gross", () => {
    expect(computeNetProceeds(0)).toBe(null);
    expect(computeNetProceeds(-1)).toBe(null);
    expect(computeNetProceeds(NaN)).toBe(null);
    expect(computeNetProceeds(undefined)).toBe(null);
    expect(computeNetProceeds(Infinity)).toBe(null);
  });

  it("EXACT tier: deducts the order's consideration fee and flags royalty included", () => {
    // 1 WETH offer, 0.02 WETH total fees (OS + platform + royalty) from the order.
    const r = computeNetProceeds(1, { feeEth: 0.02 });
    expect(r.exact).toBe(true);
    expect(r.royaltyIncluded).toBe(true);
    expect(r.fee).toBeCloseTo(0.02, 12);
    expect(r.net).toBeCloseTo(0.98, 12);
  });

  it("EXACT tier wins even when feeBps is also passed", () => {
    const r = computeNetProceeds(2, { feeEth: 0.05, feeBps: 200 });
    expect(r.exact).toBe(true);
    expect(r.fee).toBeCloseTo(0.05, 12); // uses the exact 0.05, not 2 * 200/10000 = 0.04
    expect(r.net).toBeCloseTo(1.95, 12);
  });

  it("EXACT tier clamps a fee larger than gross to gross (never negative net)", () => {
    const r = computeNetProceeds(1, { feeEth: 5 });
    expect(r.fee).toBe(1);
    expect(r.net).toBe(0);
  });

  it("EXACT tier clamps a negative fee to zero", () => {
    const r = computeNetProceeds(1, { feeEth: -0.1 });
    expect(r.fee).toBe(0);
    expect(r.net).toBe(1);
  });

  it("ESTIMATE tier: applies feeBps and flags royalty NOT included", () => {
    // 1 WETH offer, 2% marketplace fee (OS 100 + platform 100 bps).
    const r = computeNetProceeds(1, { feeBps: 200 });
    expect(r.exact).toBe(false);
    expect(r.royaltyIncluded).toBe(false);
    expect(r.fee).toBeCloseTo(0.02, 12);
    expect(r.net).toBeCloseTo(0.98, 12);
  });

  it("ESTIMATE tier with no fee info deducts nothing (gross == net)", () => {
    const r = computeNetProceeds(1.5);
    expect(r.fee).toBe(0);
    expect(r.net).toBe(1.5);
    expect(r.exact).toBe(false);
  });

  it("treats a null feeEth as missing and falls through to the estimate tier", () => {
    const r = computeNetProceeds(1, { feeEth: null, feeBps: 200 });
    expect(r.exact).toBe(false);
    expect(r.fee).toBeCloseTo(0.02, 12);
  });
});

describe("feeEthFromConsideration", () => {
  const wei = (eth) => (BigInt(Math.round(eth * 1e6)) * 1_000_000_000_000n).toString();

  it("returns null for empty / non-array input", () => {
    expect(feeEthFromConsideration(undefined)).toBe(null);
    expect(feeEthFromConsideration(null)).toBe(null);
    expect(feeEthFromConsideration([])).toBe(null);
  });

  it("returns null when there are no ERC20 (itemType 1) items", () => {
    // Only the NFT consideration item (itemType 2) — no fee items.
    expect(feeEthFromConsideration([{ itemType: 2, startAmount: "1" }])).toBe(null);
  });

  it("sums all ERC20 fee items (OS fee + platform fee + royalty)", () => {
    const consideration = [
      { itemType: 2, startAmount: "1" },        // the NFT — ignored
      { itemType: 1, startAmount: wei(0.01) },  // OpenSea fee
      { itemType: 1, startAmount: wei(0.01) },  // platform fee
      { itemType: 1, startAmount: wei(0.05) },  // royalty
    ];
    expect(feeEthFromConsideration(consideration)).toBeCloseTo(0.07, 9);
  });

  it("accepts string itemType values (API sends strings)", () => {
    const consideration = [
      { itemType: "2", startAmount: "1" },
      { itemType: "1", startAmount: wei(0.02) },
    ];
    expect(feeEthFromConsideration(consideration)).toBeCloseTo(0.02, 9);
  });

  it("skips malformed startAmounts without throwing", () => {
    const consideration = [
      { itemType: 1, startAmount: "not-a-number" },
      { itemType: 1, startAmount: wei(0.03) },
    ];
    expect(feeEthFromConsideration(consideration)).toBeCloseTo(0.03, 9);
  });

  it("round-trips into computeNetProceeds for an exact preview", () => {
    const consideration = [
      { itemType: 2, startAmount: "1" },
      { itemType: 1, startAmount: wei(0.02) }, // 2% combined fees
    ];
    const feeEth = feeEthFromConsideration(consideration);
    const r = computeNetProceeds(1, { feeEth });
    expect(r.exact).toBe(true);
    expect(r.net).toBeCloseTo(0.98, 9);
  });
});
