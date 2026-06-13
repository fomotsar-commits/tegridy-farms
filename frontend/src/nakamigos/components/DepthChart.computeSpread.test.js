import { describe, it, expect } from "vitest";
import { computeSpread } from "./DepthChart";

// Guards the F609 invariant: a best bid ABOVE the floor (negative spread) is a
// data-error state and must NEVER read as a healthy/narrow spread.
describe("computeSpread", () => {
  it("returns null when inputs are missing or floor is non-positive", () => {
    expect(computeSpread(null, 0.1)).toBeNull();
    expect(computeSpread(0.1, null)).toBeNull();
    expect(computeSpread(0, 0.1)).toBeNull();
  });

  it("flags a bid above floor as invalid (never green/healthy)", () => {
    // The live bug: 4.28 ETH bid against a 0.10 floor read as -4071% 'Healthy'.
    const s = computeSpread(0.1026, 4.28);
    expect(s).not.toBeNull();
    expect(s.health).toBe("invalid");
    expect(s.health).not.toBe("green");
  });

  it("classifies a tight positive spread as green", () => {
    const s = computeSpread(0.1, 0.099); // ~1% spread
    expect(s.health).toBe("green");
    expect(s.pct).toBeGreaterThan(0);
  });

  it("classifies a moderate spread as yellow and a wide one as red", () => {
    expect(computeSpread(0.1, 0.093).health).toBe("yellow"); // ~7%
    expect(computeSpread(0.1, 0.08).health).toBe("red");      // 20%
  });
});
