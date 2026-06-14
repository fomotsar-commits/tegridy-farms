import { describe, it, expect } from "vitest";
import { isSelfSale, excludeSelfSales } from "./washTrade";

const A = "0xf46a0000000000000000000000000000000000aa";
const B = "0xb0b0000000000000000000000000000000000bbb".slice(0, 42);
const ADDR_B = "0x1234567890abcdef1234567890abcdef12345678";

describe("isSelfSale", () => {
  it("flags a same-wallet sale via fromFull/toFull", () => {
    expect(isSelfSale({ fromFull: A, toFull: A })).toBe(true);
  });

  it("flags a same-wallet sale via from/to (price-history shape)", () => {
    expect(isSelfSale({ from: A, to: A })).toBe(true);
  });

  it("is case-insensitive (checksummed vs lowercase)", () => {
    expect(isSelfSale({ fromFull: A.toUpperCase().replace("0X", "0x"), toFull: A })).toBe(true);
  });

  it("does NOT flag a genuine sale between two different wallets", () => {
    expect(isSelfSale({ fromFull: A, toFull: ADDR_B })).toBe(false);
    expect(isSelfSale({ from: A, to: ADDR_B })).toBe(false);
  });

  it("prefers fromFull/toFull over from/to", () => {
    // Full addrs differ -> not a self-sale even if truncated strings happen to match.
    expect(isSelfSale({ fromFull: A, toFull: ADDR_B, from: "0xf46a...00aa", to: "0xf46a...00aa" })).toBe(false);
  });

  it("returns false when a side is missing (no guessing)", () => {
    expect(isSelfSale({ fromFull: A })).toBe(false);
    expect(isSelfSale({ toFull: A })).toBe(false);
    expect(isSelfSale({ fromFull: A, toFull: null })).toBe(false);
  });

  it("returns false for truncated display addresses (not comparable)", () => {
    // "0xf46a...00aa" is not a full address, so we can't safely compare it.
    expect(isSelfSale({ from: "0xf46a...00aa", to: "0xf46a...00aa" })).toBe(false);
  });

  it("returns false for malformed / non-object input", () => {
    expect(isSelfSale(null)).toBe(false);
    expect(isSelfSale(undefined)).toBe(false);
    expect(isSelfSale("0xabc")).toBe(false);
    expect(isSelfSale({ fromFull: "not-an-address", toFull: "not-an-address" })).toBe(false);
  });
});

describe("excludeSelfSales", () => {
  it("removes self-sales but keeps genuine sales and rows with partial data", () => {
    const sales = [
      { id: 1, fromFull: A, toFull: ADDR_B },   // genuine
      { id: 2, fromFull: A, toFull: A },          // self-sale
      { id: 3, fromFull: A },                      // partial -> kept (can't tell)
      { id: 4, from: A, to: A },                   // self-sale (price-history shape)
    ];
    expect(excludeSelfSales(sales).map((s) => s.id)).toEqual([1, 3]);
  });

  it("passes through non-array input unchanged", () => {
    expect(excludeSelfSales(null)).toBe(null);
    expect(excludeSelfSales(undefined)).toBe(undefined);
  });

  it("returns an empty array when every sale is a self-sale", () => {
    expect(excludeSelfSales([{ fromFull: A, toFull: A }, { from: B, to: B }])).toEqual([]);
  });
});
