// Offer and listing reads name the ACTIVE collection, never Nakamigos.
//
// Red on trunk with GNSS Art alone, before any family collection exists:
//   - fetchTokenOfferBook passed no slug to its first leg, so it read
//     `offers/collection/nakamigos/nfts/{id}/best` for every collection;
//   - fetchMyOffers and fetchMyListings take (wallet, contract), every caller
//     passes exactly that, and both default the slug to nakamigos.
// The consequence on the accept screen: a GNSS or Jungle Bay owner of #N was
// shown Nakamigos #N's best offer, OfferPanel showed Accept because the
// wallet owns the ACTIVE token, and acceptOffer then approved and filled the
// offer's own tokenContract, which is Nakamigos. A holder of both would sell
// the wrong NFT.
//
// Only the network boundary (lib/proxy) is faked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ADDR } from "./__fixtures__/jungleBayFamily";

const h = vi.hoisted(() => ({ paths: [], get: null }));

vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openseaGet: vi.fn(async (path, params) => {
      h.paths.push(path);
      return h.get(path, params);
    }),
    openseaPost: vi.fn(async () => ({})),
  };
});

const WALLET = "0x" + "a".repeat(40);
const SEAPORT_16 = "0x0000000000000068f116a894984e2db1123eb395";

function bestOfferFor(nftContract) {
  return {
    order_hash: "0xbest",
    protocol_address: SEAPORT_16,
    price: { currency: "WETH", decimals: 18, value: "50000000000000000" },
    protocol_data: {
      parameters: {
        offerer: "0x" + "b".repeat(40),
        endTime: String(Math.floor(Date.now() / 1000) + 3600),
        offer: [{ itemType: 1, token: "0xweth", identifierOrCriteria: "0", startAmount: "50000000000000000" }],
        consideration: [{ itemType: 2, token: nftContract, identifierOrCriteria: "5", startAmount: "1", endAmount: "1" }],
      },
    },
  };
}

let apiOffers;
beforeEach(async () => {
  h.paths.length = 0;
  h.get = async () => ({ offers: [], listings: [], next: null });
  vi.resetModules();
  apiOffers = await import("./api-offers");
});

describe("the token offer book reads the active collection", () => {
  it("both answers come from gnssart's route, and no path names nakamigos", async () => {
    h.get = async () => bestOfferFor(ADDR.gnssart);
    const book = await apiOffers.fetchTokenOfferBook("5", {
      contract: ADDR.gnssart, slug: "gnssart", openseaSlug: "gnssart",
    });
    expect(h.paths.length).toBeGreaterThan(0);
    for (const p of h.paths) expect(p).toBe("offers/collection/gnssart/nfts/5/best");
    expect(h.paths.join(" ")).not.toContain("nakamigos");
    expect(book.bestOffer?.tokenContract).toBe(ADDR.gnssart);
    expect(book.offers).toHaveLength(1);
    expect(book.unavailable).toBe(false);
  });

  it("spends ONE request, not two, on the one route that answers both questions", async () => {
    // Both legs used to fetch the same `/best` URL. Every open Modal polls this
    // every 30 s on a 30-per-minute per-IP budget it shares with checkout.
    h.get = async () => bestOfferFor(ADDR.gnssart);
    await apiOffers.fetchTokenOfferBook("5", { contract: ADDR.gnssart, slug: "gnssart", openseaSlug: "gnssart" });
    expect(h.paths).toHaveLength(1);
  });

  it("an empty book is still an empty book, and an outage is still an outage", async () => {
    h.get = async () => ({});
    const empty = await apiOffers.fetchTokenOfferBook("5", { contract: ADDR.gnssart, slug: "gnssart", openseaSlug: "gnssart" });
    expect(empty).toEqual({ offers: [], bestOffer: null, unavailable: false });

    const { ApiError } = await import("./lib/proxy");
    h.get = async () => { throw new ApiError("Bad Request", 400); };
    const down = await apiOffers.fetchTokenOfferBook("5", { contract: ADDR.gnssart, slug: "gnssart", openseaSlug: "gnssart" });
    expect(down.unavailable).toBe(true);
    expect(down.offers).toEqual([]);
    expect(down.bestOffer).toBeNull();
  });

  it("fetchTokenOffers derives the slug from the contract", async () => {
    h.get = async () => bestOfferFor(ADDR.gnssart);
    await apiOffers.fetchTokenOffers("5", ADDR.gnssart);
    expect(h.paths).toEqual(["offers/collection/gnssart/nfts/5/best"]);
  });

  it("fetchTokenOfferBook reads by contract only: a contract outside the venue is unavailable, whatever the slug says", async () => {
    // Bojungles' contract with gnssart's slug: the slug used to be the
    // fallback, and the book of gnssart #5 was read for a Bojungles token.
    h.get = async () => bestOfferFor(ADDR.gnssart);
    const book = await apiOffers.fetchTokenOfferBook("5", { contract: ADDR.bojungles, slug: "gnssart", openseaSlug: "gnssart" });
    expect(book).toEqual({ offers: [], bestOffer: null, unavailable: true });
    expect(h.paths).toEqual([]);
  });

  it("fetchTokenOffers asks nothing for a contract the venue does not trade, rather than defaulting to Nakamigos", async () => {
    const res = await apiOffers.fetchTokenOffers("5", ADDR.bojungles);
    expect(res).toEqual([]);
    expect(h.paths).toEqual([]);
  });
});

describe("a wallet's own orders are read for the active collection", () => {
  it("fetchMyOffers(wallet, GNSS) reads gnssart's offers", async () => {
    await apiOffers.fetchMyOffers(WALLET, ADDR.gnssart);
    expect(h.paths).toEqual(["offers/collection/gnssart/all"]);
  });

  it("fetchMyListings(wallet, GNSS) reads gnssart's listings", async () => {
    await apiOffers.fetchMyListings(WALLET, ADDR.gnssart);
    expect(h.paths).toEqual(["listings/collection/gnssart/all"]);
  });

  it("the same two reads follow Gold Cards", async () => {
    await apiOffers.fetchMyOffers(WALLET, ADDR.junglebaygoldcards);
    await apiOffers.fetchMyListings(WALLET, ADDR.junglebaygoldcards);
    expect(h.paths).toEqual([
      "offers/collection/junglebaygoldcards/all",
      "listings/collection/junglebaygoldcards/all",
    ]);
  });

  it("fetchMyOffers says it could not ask for a contract outside the venue, instead of answering an empty list", async () => {
    await expect(apiOffers.fetchMyOffers(WALLET, ADDR.bojungles)).rejects.toMatchObject({ code: "not-venue-tradeable" });
    expect(h.paths).toEqual([]);
  });

  it("a caller that passes no contract still means Nakamigos (the default is unchanged)", async () => {
    await apiOffers.fetchMyOffers(WALLET);
    expect(h.paths).toEqual(["offers/collection/nakamigos/all"]);
  });
});

describe("BidManager's 'my bids' read names the OpenSea slug", () => {
  it("builds its path from openseaSlug, not the app slug", async () => {
    // Every venue entry has slug === openseaSlug today (registry.test.js pins
    // it), so no render can tell the two apart; the source is the only
    // place the wrong one can be seen.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src", "nakamigos", "components", "BidManager.jsx"), "utf8");
    expect(src).not.toMatch(/offers\/collection\/\$\{collection\.slug\}/);
    expect(src).toMatch(/offers\/collection\/\$\{collection\.openseaSlug\}/);
  });
});
