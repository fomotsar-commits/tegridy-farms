import { describe, it, expect } from "vitest";
import { feeBpsOf, normalizeCollectionOffer } from "./offerNormalize";

const BIDDER = "0x" + "b".repeat(40);
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const OPENSEA = "0x0000a26b00c1F0DF003000390027140000fAa719";
const CREATOR = "0xa3cc58eaa3800dc163726e031a2da49a9bb64eb3";
const JBAC = "0xd37264c71e9af940e49795F0d3a8336afAaFDdA9";

const bid = ({ offer, fees = [], qty = 1, toBidder = [] }) => ({
  offerer: BIDDER,
  offer: [{ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: String(offer), endAmount: String(offer) }],
  consideration: [
    { itemType: 4, token: JBAC, identifierOrCriteria: "0", startAmount: String(qty), endAmount: String(qty), recipient: BIDDER },
    ...fees.map(([recipient, amount]) => ({ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: String(amount), endAmount: String(amount), recipient })),
    ...toBidder.map((amount) => ({ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: String(amount), endAmount: String(amount), recipient: BIDDER.toUpperCase().replace("0X", "0x") })),
  ],
});

describe("feeBpsOf: a bid's own fee lines, as bps of its offer", () => {
  it("OpenSea's 1% line is 100 bps", () => {
    expect(feeBpsOf(bid({ offer: 30_000_000_000_000_000n, fees: [[OPENSEA, 300_000_000_000_000n]] }))).toBe(100);
  });

  it("every line not paid to the bidder counts: 1% + a 7% royalty is 800", () => {
    expect(feeBpsOf(bid({ offer: 10n ** 18n, fees: [[OPENSEA, 10n ** 16n], [CREATOR, 7n * 10n ** 16n]] }))).toBe(800);
  });

  it("holds per item on a bid for 2 (a share, not a total)", () => {
    expect(feeBpsOf(bid({ offer: 40_000_000_000_000_000n, qty: 2, fees: [[OPENSEA, 400_000_000_000_000n]] }))).toBe(100);
  });

  it("a payment line back to the bidder (any case) is not a fee, nor is the NFT line", () => {
    expect(feeBpsOf(bid({ offer: 10n ** 18n, fees: [[OPENSEA, 10n ** 16n]], toBidder: [5n * 10n ** 16n] }))).toBe(100);
  });

  it("keeps two decimals of a bps", () => {
    expect(feeBpsOf(bid({ offer: 10n ** 18n, fees: [[OPENSEA, 369n * 10n ** 14n]] }))).toBe(369);
    expect(feeBpsOf(bid({ offer: 3n * 10n ** 18n, fees: [[OPENSEA, 10n ** 16n]] }))).toBe(33.33);
  });

  it("null, never 0, when the lines are not known", () => {
    expect(feeBpsOf(undefined)).toBeNull();
    expect(feeBpsOf({ offerer: BIDDER })).toBeNull();
    expect(feeBpsOf(bid({ offer: 0n }))).toBeNull();
    expect(feeBpsOf(bid({ offer: "1e18" }))).toBeNull();
  });
});

describe("normalizeCollectionOffer carries feeBps", () => {
  it("from the row's own parameters", () => {
    const row = { order_hash: "0x1", protocol_data: { parameters: bid({ offer: 30_000_000_000_000_000n, fees: [[OPENSEA, 300_000_000_000_000n]] }) } };
    expect(normalizeCollectionOffer(row).feeBps).toBe(100);
    expect(normalizeCollectionOffer({ order_hash: "0x2", price: { value: "1" } }).feeBps).toBeNull();
  });
});
