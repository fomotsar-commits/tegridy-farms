import { describe, it, expect } from "vitest";
import { normalizeCollectionOffer, collectionOfferQuantity } from "./api-offers";
import { computeBookSides } from "./lib/bookDepth";

// A multi-quantity collection bid, exactly as OpenSea serves it: PARTIAL_OPEN,
// the WETH offer item holding quantity x unit price, the criteria consideration
// item holding the quantity, and `price.value` mirroring the WHOLE-ORDER total.
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const NAKA = "0xd774557b647330c91bf44cfeab205095f7e6c367";

const eth = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();

function collectionBid({ unitEth, quantity, maker = "0xbid", trait = null }) {
  const totalWei = eth(unitEth * quantity);
  return {
    order_hash: `0x${maker}${unitEth}${quantity}`,
    price: { currency: "WETH", decimals: 18, value: totalWei },
    criteria: { collection: { slug: "nakamigos" }, ...(trait ? { trait } : {}) },
    protocol_data: {
      parameters: {
        offerer: maker,
        offer: [{ itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: totalWei, endAmount: totalWei }],
        consideration: [
          {
            itemType: 4, // ERC721_WITH_CRITERIA
            token: NAKA,
            identifierOrCriteria: "0",
            startAmount: String(quantity),
            endAmount: String(quantity),
            recipient: maker,
          },
          { itemType: 1, token: WETH, identifierOrCriteria: "0", startAmount: eth(0.001), endAmount: eth(0.001), recipient: "0xfee" },
        ],
        orderType: 2,
      },
    },
  };
}

describe("collectionOfferQuantity", () => {
  it("reads the quantity off the criteria consideration item", () => {
    expect(collectionOfferQuantity(collectionBid({ unitEth: 0.09, quantity: 50 }).protocol_data.parameters)).toBe(50);
  });

  it("treats an order with no NFT leg as a single-item bid", () => {
    expect(collectionOfferQuantity({ consideration: [{ itemType: 1, startAmount: "5" }] })).toBe(1);
    expect(collectionOfferQuantity(undefined)).toBe(1);
  });

  it("never returns zero or a negative divisor", () => {
    expect(collectionOfferQuantity({ consideration: [{ itemType: 4, startAmount: "0" }] })).toBe(1);
    expect(collectionOfferQuantity({ consideration: [{ itemType: 4, startAmount: "oops" }] })).toBe(1);
  });
});

describe("normalizeCollectionOffer reports price PER ITEM", () => {
  it("divides a 50-item bid down to its unit price", () => {
    const o = normalizeCollectionOffer(collectionBid({ unitEth: 0.0876, quantity: 50 }));
    expect(o.quantity).toBe(50);
    expect(o.priceTotal).toBeCloseTo(4.38, 6);
    expect(o.price).toBeCloseTo(0.0876, 6);
    expect(o.quantityKnown).toBe(true);
  });

  it("leaves a single-item bid alone", () => {
    const o = normalizeCollectionOffer(collectionBid({ unitEth: 0.095, quantity: 1 }));
    expect(o.quantity).toBe(1);
    expect(o.price).toBeCloseTo(0.095, 6);
  });

  it("carries maker, hash and criteria through unchanged", () => {
    const raw = collectionBid({ unitEth: 0.1, quantity: 2, maker: "0xabc", trait: { type: "Hair", value: "Mohawk" } });
    const o = normalizeCollectionOffer(raw);
    expect(o.maker).toBe("0xabc");
    expect(o.orderHash).toBe(raw.order_hash);
    expect(o.criteria.trait).toEqual({ type: "Hair", value: "Mohawk" });
  });

  it("flags the case where the quantity is unknowable instead of pretending it is one", () => {
    const o = normalizeCollectionOffer({ order_hash: "0x1", price: { value: eth(4.38), currency: "WETH" } });
    expect(o.quantityKnown).toBe(false);
    expect(o.price).toBeCloseTo(4.38, 6);
  });

  it("yields null rather than zero when there is no amount at all", () => {
    expect(normalizeCollectionOffer({ order_hash: "0x1" }).price).toBeNull();
  });
});

describe("depth is reported, not deleted", () => {
  // The pre-fix pair: a 50-item bid at 0.0876 each read as a single 4.38 ETH
  // bid on a 0.10 floor. The panel's compensating filter then dropped it for
  // being >2x the floor, so the real bid depth vanished from the chart.
  const asks = [{ price: 0.1026 }, { price: 0.11 }, { price: 0.13 }];

  it("keeps the multi-quantity bid on the book at its unit price", () => {
    const bids = [collectionBid({ unitEth: 0.0876, quantity: 50 })].map(normalizeCollectionOffer);
    const book = computeBookSides(asks, bids);
    expect(book.bidPrices).toEqual([expect.closeTo(0.0876, 6)]);
    expect(book.bestBid).toBeCloseTo(0.0876, 6);
    expect(book.crossed).toBe(false);
    expect(book.spread).toBeCloseTo(0.1026 - 0.0876, 6);
    expect(book.spreadPct).toBeGreaterThan(0);
  });

  it("shows every bid, including ones the old 2x-floor filter would have dropped", () => {
    const bids = [
      collectionBid({ unitEth: 0.0876, quantity: 50, maker: "0xa" }),
      collectionBid({ unitEth: 0.09, quantity: 1, maker: "0xb" }),
      collectionBid({ unitEth: 0.3, quantity: 1, maker: "0xc" }), // > 2x the 0.1026 floor
    ].map(normalizeCollectionOffer);
    const book = computeBookSides(asks, bids);
    expect(book.bidPrices).toHaveLength(3);
  });

  it("withholds the spread on a crossed book instead of printing a negative one", () => {
    const bids = [collectionBid({ unitEth: 0.3, quantity: 1 })].map(normalizeCollectionOffer);
    const book = computeBookSides(asks, bids);
    expect(book.crossed).toBe(true);
    expect(book.spread).toBeNull();
    expect(book.spreadPct).toBeNull();
    expect(book.bestBid).toBeCloseTo(0.3, 6);
  });

  it("returns nulls, never zeros, for an empty side", () => {
    expect(computeBookSides(asks, []).bestBid).toBeNull();
    expect(computeBookSides([], []).bestAsk).toBeNull();
    expect(computeBookSides(asks, []).spread).toBeNull();
  });

  it("ignores non-positive and non-finite prices on both sides", () => {
    const book = computeBookSides(
      [{ price: 0 }, { price: null }, { price: 0.2 }],
      [{ price: -1 }, { price: NaN }, { price: 0.05 }],
    );
    expect(book.askPrices).toEqual([0.2]);
    expect(book.bidPrices).toEqual([0.05]);
  });
});
