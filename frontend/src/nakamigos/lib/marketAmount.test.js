import { describe, it, expect } from "vitest";
import { formatMarketAmount } from "./marketAmount";

const ETHEREUM = { chain: "ethereum" };
const BASE = { chain: "base" };
const SOLANA = { chain: "solana" };

describe("formatMarketAmount", () => {
  it("an amount whose unit was never read gives no figure, so the caller shows its unread dash", () => {
    for (const symbol of [undefined, null, ""]) {
      expect(formatMarketAmount(0.11, symbol, ETHEREUM), `symbol ${symbol}`).toBeNull();
      expect(formatMarketAmount(0.11, symbol, BASE), `symbol ${symbol} on Base`).toBeNull();
    }
  });

  it("a unit the caller knows is kept: ETH, ETH on Base, SOL", () => {
    expect(formatMarketAmount(0.11, "ETH", ETHEREUM)).toBe("0.1100 ETH");
    expect(formatMarketAmount(0.052768, "ETH", BASE)).toBe("0.0528 ETH on Base");
    expect(formatMarketAmount(0.695, "SOL", SOLANA)).toBe("0.695 SOL");
  });

  it("no finite number is null", () => {
    for (const value of [null, undefined, NaN, Infinity, "0.11"]) {
      expect(formatMarketAmount(value, "ETH", ETHEREUM), String(value)).toBeNull();
    }
  });
});
