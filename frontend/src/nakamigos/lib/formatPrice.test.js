import { describe, it, expect } from "vitest";
import { formatPrice, formatUsd } from "./formatPrice";

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

describe("formatUsd", () => {
  const RATE = 3000; // $3,000 / ETH

  it("returns the fallback (empty by default) when no real rate is given", () => {
    // Honesty: a null / zero / negative rate must NEVER paint a USD figure.
    expect(formatUsd(1, null)).toBe("");
    expect(formatUsd(1, 0)).toBe("");
    expect(formatUsd(1, -5)).toBe("");
    expect(formatUsd(1, NaN)).toBe("");
    expect(formatUsd(1, Infinity)).toBe("");
  });

  it("returns the fallback when the eth amount is missing or non-finite", () => {
    expect(formatUsd(null, RATE)).toBe("");
    expect(formatUsd(undefined, RATE)).toBe("");
    expect(formatUsd(NaN, RATE)).toBe("");
    expect(formatUsd(Infinity, RATE)).toBe("");
  });

  it("supports a custom fallback string", () => {
    expect(formatUsd(1, 0, { fallback: "—" })).toBe("—");
    expect(formatUsd(null, RATE, { fallback: "n/a" })).toBe("n/a");
  });

  it("renders $0 for exactly zero ETH", () => {
    expect(formatUsd(0, RATE)).toBe("≈ $0");
  });

  it("multiplies eth by the rate with 2 decimals below $1,000", () => {
    expect(formatUsd(0.1, RATE)).toBe("≈ $300.00"); // 0.1 * 3000
    expect(formatUsd(0.0345, RATE)).toBe("≈ $103.50"); // 0.0345 * 3000
    expect(formatUsd(0.0001, RATE)).toBe("≈ $0.30"); // sub-dollar still 2dp
  });

  it("drops cents and comma-separates at or above $1,000", () => {
    expect(formatUsd(1, RATE)).toBe("≈ $3,000"); // 1 * 3000
    expect(formatUsd(2.5, RATE)).toBe("≈ $7,500");
    expect(formatUsd(0.4, RATE)).toBe("≈ $1,200");
  });

  it("rounds to the nearest dollar in the >= $1,000 branch", () => {
    // 0.41005 * 3000 = 1230.15 -> rounds to 1,230
    expect(formatUsd(0.41005, RATE)).toBe("≈ $1,230");
  });

  it("shows a dust marker for a tiny non-zero USD value", () => {
    // 0.000001 * 3000 = $0.003 -> rounds to $0.00, so show <$0.01
    expect(formatUsd(0.000001, RATE)).toBe("≈ <$0.01");
  });

  it("honors a custom prefix (including empty)", () => {
    expect(formatUsd(0.1, RATE, { prefix: "" })).toBe("$300.00");
    expect(formatUsd(0.1, RATE, { prefix: "~ " })).toBe("~ $300.00");
  });
});
