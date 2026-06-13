import { describe, it, expect } from "vitest";
import { formatPrice } from "./formatPrice";

describe("formatPrice", () => {
  it("returns the fallback for null/undefined/NaN/Infinity", () => {
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(undefined)).toBe("—");
    expect(formatPrice(NaN)).toBe("—");
    expect(formatPrice(Infinity)).toBe("—");
    expect(formatPrice(null, { fallback: "n/a" })).toBe("n/a");
  });

  it("returns '0' for exactly zero (distinct from dust)", () => {
    expect(formatPrice(0)).toBe("0");
  });

  it("shows a dust floor marker for non-zero values below 0.0001", () => {
    expect(formatPrice(0.00003)).toBe("<0.0001");
    expect(formatPrice(0.00009999)).toBe("<0.0001");
    expect(formatPrice(-0.00003)).toBe(">-0.0001");
  });

  it("uses 4 decimals below 1,000", () => {
    expect(formatPrice(0.1234)).toBe("0.1234");
    expect(formatPrice(0.0001)).toBe("0.0001"); // exactly the floor, not dust
    expect(formatPrice(12.5)).toBe("12.5000");
  });

  it("comma-separates with 2 decimals at or above 1,000", () => {
    expect(formatPrice(1234.5)).toBe("1,234.50");
    expect(formatPrice(1000)).toBe("1,000.00");
  });
});
