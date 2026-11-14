// "Best collection offer", the order book and the depth chart count only bids that buy ANY
// token of the collection.
//
// Red on trunk: fetchCollectionOffers read `offers/collection/{slug}/all` and kept every row.
// Read live 2026-11-10, that page held no collection-wide bid for JBAC (50 offers on single
// JBACs at 0.079 to 0.155 WETH, floor 0.0279) and, for Nakamigos, 48 token-list bids at 3.0 to
// 3.5 WETH against a 0.08 floor. The marketplace showed them as the collection's best bid, up
// to ~44x the floor. The real collection-wide bids are on `offers/collection/{slug}`.
//
// Only the network boundary (lib/proxy) is faked. Every path answers the SAME mixed page, so
// these tests check the filter itself, not only which route is read.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeBookSides } from "./lib/bookDepth";

const h = vi.hoisted(() => ({ paths: [], page: null }));

vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openseaGet: vi.fn(async (path) => {
      h.paths.push(path);
      return h.page;
    }),
    openseaPost: vi.fn(async () => ({})),
  };
});

const JBAC = "0xd37264c71e9af940e49795f0d3a8336afaafdda9";
const wei = (eth) => (BigInt(Math.round(eth * 1e6)) * 10n ** 12n).toString();

/** One OpenSea offer row: `nft` is the Seaport consideration item the offerer wants. */
function row({ total, nft, criteria }) {
  return {
    order_hash: "0x" + Math.random().toString(16).slice(2),
    price: { currency: "WETH", decimals: 18, value: wei(total) },
    criteria,
    protocol_data: {
      parameters: {
        offerer: "0x" + "b".repeat(40),
        offer: [{ itemType: 1, token: "0xweth", identifierOrCriteria: "0", startAmount: wei(total) }],
        consideration: [nft, { itemType: 1, token: "0xweth", identifierOrCriteria: "0", startAmount: "1000" }],
      },
    },
  };
}

// A collection-wide bid for 3 JBACs at 0.0209 each (item type 4, criteria 0).
const collectionBid = row({ total: 0.0627, nft: { itemType: 4, token: JBAC, identifierOrCriteria: "0", startAmount: "3" } });
// An offer on JBAC #4321 alone (item type 2).
const singleToken = row({ total: 0.155, nft: { itemType: 2, token: JBAC, identifierOrCriteria: "4321", startAmount: "1" } });
// A bid on a hand-picked token list (item type 4, a non-zero merkle root).
const tokenList = row({
  total: 3.51,
  nft: { itemType: 4, token: JBAC, identifierOrCriteria: "0x9f3c", startAmount: "1" },
  criteria: { encoded_token_ids: "1368,2761,36" },
});
// A trait bid: buys only JBACs with a gold background.
const traitBid = row({
  total: 0.03,
  nft: { itemType: 4, token: JBAC, identifierOrCriteria: "0x7a11", startAmount: "1" },
  criteria: { trait: { type: "Background", value: "Gold" } },
});

let apiOffers;
beforeEach(async () => {
  h.paths.length = 0;
  h.page = { offers: [singleToken, tokenList, traitBid, collectionBid], next: null };
  vi.resetModules();
  apiOffers = await import("./api-offers");
});

describe("collection offers = bids that buy any token", () => {
  it("reads OpenSea's collection-offers route, not the mixed /all feed", async () => {
    await apiOffers.fetchCollectionOffers("junglebay");
    expect(h.paths).toEqual(["offers/collection/junglebay"]);
  });

  it("drops offers on one token, on a token list, and trait bids", async () => {
    const offers = await apiOffers.fetchCollectionOffers("junglebay");
    expect(offers).toHaveLength(1);
    expect(offers[0].price).toBeCloseTo(0.0209, 6);
    expect(offers[0].quantity).toBe(3);
  });

  it("the order book's best bid is the collection bid, below a 0.0279 floor, so the book is not crossed", async () => {
    const offers = await apiOffers.fetchCollectionOffers("junglebay");
    const book = computeBookSides([{ price: 0.0279 }], offers);
    expect(book.bestBid).toBeCloseTo(0.0209, 6);
    expect(book.crossed).toBe(false);
  });
});

describe("trait offers still come from the mixed feed", () => {
  it("reads /all and keeps the trait bid", async () => {
    const all = await apiOffers.fetchAllCollectionOffers("junglebay");
    expect(h.paths).toEqual(["offers/collection/junglebay/all"]);
    const traits = apiOffers.deriveTraitOffers(all);
    expect(traits).toEqual({ Background: { Gold: { priceEth: 0.03, count: 1 } } });
  });
});
