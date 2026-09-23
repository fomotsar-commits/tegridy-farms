// lib/externalMarket.js reads a view-only collection's stats and items from
// its home market, and says "unavailable" rather than guess.
//
// The four EVM family collections read OpenSea by slug through /api/opensea;
// Junglets reads Magic Eden through /api/aggregator?resource=me-read. Both
// answers are validated row by row: an item that is not this collection's
// contract, an id that is not digits, an image that is not on the market's
// own CDN, a listing priced in anything but SOL at 9 decimals, is dropped or
// nulled rather than shown. Any answer that is not the expected JSON (vite
// preview answers /api with HTML) is `unavailable`, never an empty success.
//
// Numbers keep their precision. Seeds has traded 0.052768 ETH in total and
// Rare Towelie Cards 0.06 ETH; api.js rounds collection volume to an integer
// and maps a real 0 to null, which would print both as zero-or-unread.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { COLLECTIONS } from "../constants";
import { ADDR, WSOL_MINT } from "../__fixtures__/jungleBayFamily";

const load = () => import(/* @vite-ignore */ "./externalMarket" + "");

let fetchMock;
let answer;

function json(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

const urlOf = (call) => new URL(String(call[0]), "https://memetics.finance");

beforeEach(() => {
  vi.resetModules();
  answer = () => json({});
  fetchMock = vi.fn(async (...a) => answer(...a));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const osStats = (total) => ({ total, intervals: [] });
const osItem = (over = {}) => ({
  identifier: "0",
  collection: "bojungless",
  contract: ADDR.bojungles.toLowerCase(),
  token_standard: "erc721",
  name: "Bojungles #0",
  image_url: "https://i2c.seadn.io/base/0x36afee4fadc3b77ff5f1f9a040e264150afb979a/aa/bb.png",
  display_image_url: "https://i2c.seadn.io/base/0x36afee4fadc3b77ff5f1f9a040e264150afb979a/cc/dd.png",
  ...over,
});

describe("OpenSea stats for an EVM family collection", () => {
  it("asks /api/opensea for the collection's stats by its OpenSea slug", async () => {
    answer = () => json(osStats({ floor_price: null, floor_price_symbol: "", volume: 1.42308, num_owners: 100 }));
    const { fetchExternalStats } = await load();
    await fetchExternalStats(COLLECTIONS.bojungles);
    const url = urlOf(fetchMock.mock.calls[0]);
    expect(url.pathname).toBe("/api/opensea");
    expect(url.searchParams.get("path")).toBe("collections/bojungless/stats");
  });

  it("keeps full precision, and a real zero stays zero", async () => {
    const { fetchExternalStats } = await load();
    answer = () => json(osStats({ floor_price: 0.11, floor_price_symbol: "ETH", volume: 0.052768, num_owners: 89 }));
    const seeds = await fetchExternalStats(COLLECTIONS.memeticseeds);
    expect(seeds.unavailable).toBeFalsy();
    expect(seeds.volume).toBe(0.052768);
    expect(seeds.floor).toBe(0.11);
    expect(seeds.floorSymbol).toBe("ETH");
    expect(seeds.owners).toBe(89);
    expect(seeds.source).toBe("OpenSea");

    answer = () => json(osStats({ floor_price: null, volume: 0, num_owners: 0 }));
    const zero = await fetchExternalStats(COLLECTIONS.raretowelie);
    expect(zero.volume).toBe(0);
    expect(zero.owners).toBe(0);
  });

  // A floor is a price only when it is a number above zero. A floor the read
  // carried as 0 or null is none listed. A floor the read did not carry at
  // all is unread: neither a price nor a claim that nothing is listed.
  it("a successful read with a null floor means none listed: no price, never 0", async () => {
    answer = () => json(osStats({ floor_price: null, volume: 0.06, num_owners: 480 }));
    const { fetchExternalStats } = await load();
    const s = await fetchExternalStats(COLLECTIONS.raretowelie);
    expect(s.unavailable).toBeFalsy();
    expect(s.floor).toBeNull();
    expect(s.noneListed).toBe(true);
    expect(s.volume).toBe(0.06);
  });

  it("a floor of 0 means none listed, never a price of 0", async () => {
    answer = () => json(osStats({ floor_price: 0, floor_price_symbol: "", volume: 1.42308, num_owners: 100 }));
    const { fetchExternalStats } = await load();
    const s = await fetchExternalStats(COLLECTIONS.bojungles);
    expect(s.floor).toBeNull();
    expect(s.floorSymbol).toBeNull();
    expect(s.noneListed).toBe(true);
  });

  it("a floor that is not a number is unread, not none listed", async () => {
    answer = () => json(osStats({ floor_price: "0.1", volume: 1, num_owners: 1 }));
    const { fetchExternalStats } = await load();
    const s = await fetchExternalStats(COLLECTIONS.bojungles);
    expect(s.floor).toBeNull();
    expect(s.noneListed).toBe(false);
  });

  it("a missing field is null, not a number the read did not produce, and a missing floor is not none listed", async () => {
    answer = () => json(osStats({}));
    const { fetchExternalStats } = await load();
    const s = await fetchExternalStats(COLLECTIONS.junglebaymemes);
    expect(s.floor).toBeNull();
    expect(s.noneListed).toBe(false);
    expect(s.volume).toBeNull();
    expect(s.owners).toBeNull();
  });

  it("a floor above zero is a price, in the symbol the read named", async () => {
    answer = () => json(osStats({ floor_price: 0.1, floor_price_symbol: "ETH", volume: 5, num_owners: 50 }));
    const { fetchExternalStats } = await load();
    const s = await fetchExternalStats(COLLECTIONS.junglebaymemes);
    expect(s.floor).toBe(0.1);
    expect(s.floorSymbol).toBe("ETH");
    expect(s.noneListed).toBe(false);
  });

  it("a shape mismatch is unavailable, not an empty success", async () => {
    answer = () => json({ nope: true });
    const { fetchExternalStats } = await load();
    expect((await fetchExternalStats(COLLECTIONS.bojungles)).unavailable).toBe(true);
  });
});

describe("OpenSea items for an EVM family collection", () => {
  it("asks for 200 items by OpenSea slug and follows the cursor it is handed", async () => {
    answer = () => json({ nfts: [osItem()], next: "cursor-2" });
    const { fetchExternalItems } = await load();
    const first = await fetchExternalItems(COLLECTIONS.bojungles);
    let url = urlOf(fetchMock.mock.calls[0]);
    expect(url.searchParams.get("path")).toBe("collection/bojungless/nfts");
    expect(url.searchParams.get("limit")).toBe("200");
    expect(url.searchParams.has("next")).toBe(false);
    expect(first.next).toBe("cursor-2");

    await fetchExternalItems(COLLECTIONS.bojungles, "cursor-2");
    url = urlOf(fetchMock.mock.calls[1]);
    expect(url.searchParams.get("next")).toBe("cursor-2");
  });

  it("prefers the display image, on OpenSea's own CDN", async () => {
    answer = () => json({ nfts: [osItem()], next: null });
    const { fetchExternalItems } = await load();
    const { items } = await fetchExternalItems(COLLECTIONS.bojungles);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("0");
    expect(items[0].name).toBe("Bojungles #0");
    expect(items[0].image).toMatch(/^https:\/\/i2c\.seadn\.io\/.*\/dd\.png$/);
  });

  it("falls back to image_url when there is no display image", async () => {
    answer = () => json({ nfts: [osItem({ display_image_url: null })], next: null });
    const { fetchExternalItems } = await load();
    const { items } = await fetchExternalItems(COLLECTIONS.bojungles);
    expect(items[0].image).toMatch(/\/bb\.png$/);
  });

  it("drops a row from another contract and a row whose id is not digits", async () => {
    answer = () => json({
      nfts: [
        osItem({ identifier: "1" }),
        osItem({ identifier: "2", contract: ADDR.memeticseeds.toLowerCase() }),
        osItem({ identifier: "12abc" }),
        osItem({ identifier: "" }),
      ],
      next: null,
    });
    const { fetchExternalItems } = await load();
    const { items, dropped } = await fetchExternalItems(COLLECTIONS.bojungles);
    expect(items.map((i) => i.id)).toEqual(["1"]);
    expect(dropped).toBe(3);
  });

  it("a page whose rows all fail validation is unavailable, never an empty success", async () => {
    // A field renamed upstream: every row misses `contract`.
    answer = () => json({ nfts: [{ identifier: "5", contract_address: ADDR.bojungles.toLowerCase() }, { identifier: "6", contract_address: ADDR.bojungles.toLowerCase() }], next: null });
    const { fetchExternalItems } = await load();
    const res = await fetchExternalItems(COLLECTIONS.bojungles);
    expect(res.unavailable).toBe(true);
    expect(res.reason).toBe("shape");
    expect(res.items).toBeUndefined();
  });

  it("a page with no rows at all is an empty success, with nothing dropped", async () => {
    answer = () => json({ nfts: [], next: null });
    const { fetchExternalItems } = await load();
    const res = await fetchExternalItems(COLLECTIONS.bojungles);
    expect(res.unavailable).toBeFalsy();
    expect(res.items).toEqual([]);
    expect(res.dropped).toBe(0);
  });

  it("a page that drops nothing says so", async () => {
    answer = () => json({ nfts: [osItem({ identifier: "1" }), osItem({ identifier: "2" })], next: null });
    const { fetchExternalItems } = await load();
    const res = await fetchExternalItems(COLLECTIONS.bojungles);
    expect(res.items).toHaveLength(2);
    expect(res.dropped).toBe(0);
  });

  it("nulls an image that is not https on *.seadn.io", async () => {
    answer = () => json({
      nfts: [
        osItem({ identifier: "1", display_image_url: "http://i2c.seadn.io/x.png", image_url: null }),
        osItem({ identifier: "2", display_image_url: "https://evil.example/x.png", image_url: null }),
        osItem({ identifier: "3", display_image_url: "https://seadn.io.evil.example/x.png", image_url: null }),
        osItem({ identifier: "4", display_image_url: "ipfs://Qm/x.png", image_url: null }),
      ],
      next: null,
    });
    const { fetchExternalItems } = await load();
    const { items } = await fetchExternalItems(COLLECTIONS.bojungles);
    expect(items).toHaveLength(4);
    for (const i of items) expect(i.image, i.id).toBeNull();
  });
});

describe("Magic Eden for Junglets", () => {
  const listing = (over = {}) => ({
    tokenMint: "DGzxMHMKVdy1SsSRfR1wLXxA1eB5TeNMp22NADsKYPK3",
    price: 0.695,
    priceInfo: { solPrice: { rawAmount: "695000000", address: WSOL_MINT, decimals: 9 } },
    token: {
      mintAddress: "DGzxMHMKVdy1SsSRfR1wLXxA1eB5TeNMp22NADsKYPK3",
      collection: "junglet",
      collectionName: "Junglets",
      name: "Junglet #64",
      image: "https://na-assets.pinit.io/3zoVsecguqdcLcTBaSjNQyAyYLLLt1tn93agbKBJ9vSw/b69c398c-8a8f-4b56-8f82-fdb0b1d3a16e/61",
      attributes: [{ trait_type: "Artist", value: "FilthyTrikksEth" }],
    },
    ...over,
  });

  it("reads stats through me-read, and converts lamports to SOL", async () => {
    answer = () => json({ symbol: "junglet", floorPrice: 695000000, listedCount: 55 });
    const { fetchExternalStats } = await load();
    const s = await fetchExternalStats(COLLECTIONS.junglets);
    const url = urlOf(fetchMock.mock.calls[0]);
    expect(url.pathname).toBe("/api/aggregator");
    expect(url.searchParams.get("resource")).toBe("me-read");
    expect(url.searchParams.get("path")).toBe("/collections/junglet/stats");
    expect(s.floor).toBeCloseTo(0.695, 9);
    expect(s.floorSymbol).toBe("SOL");
    expect(s.listedCount).toBe(55);
    // Magic Eden's stats route reads neither; they are not invented.
    expect(s.volume).toBeNull();
    expect(s.owners).toBeNull();
    expect(s.source).toBe("Magic Eden");
  });

  it("a floorPrice of 0 or null is none listed; a missing floorPrice is unread", async () => {
    const { fetchExternalStats } = await load();
    answer = () => json({ symbol: "junglet", floorPrice: 0, listedCount: 0 });
    let s = await fetchExternalStats(COLLECTIONS.junglets);
    expect(s.floor).toBeNull();
    expect(s.noneListed).toBe(true);

    vi.resetModules();
    answer = () => json({ symbol: "junglet", floorPrice: null, listedCount: 0 });
    s = await (await load()).fetchExternalStats(COLLECTIONS.junglets);
    expect(s.floor).toBeNull();
    expect(s.noneListed).toBe(true);

    vi.resetModules();
    answer = () => json({ symbol: "junglet", listedCount: 55 });
    s = await (await load()).fetchExternalStats(COLLECTIONS.junglets);
    expect(s.floor).toBeNull();
    expect(s.noneListed).toBe(false);
  });

  it("reads listings a page of 100 at a time", async () => {
    answer = () => json([listing()]);
    const { fetchExternalItems } = await load();
    await fetchExternalItems(COLLECTIONS.junglets);
    const url = urlOf(fetchMock.mock.calls[0]);
    expect(url.searchParams.get("path")).toBe("/collections/junglet/listings");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("0");
  });

  it("keeps a valid SOL listing, priced from rawAmount, image through wsrv", async () => {
    answer = () => json([listing()]);
    const { fetchExternalItems } = await load();
    const { items } = await fetchExternalItems(COLLECTIONS.junglets);
    expect(items).toHaveLength(1);
    expect(items[0].mint).toBe("DGzxMHMKVdy1SsSRfR1wLXxA1eB5TeNMp22NADsKYPK3");
    expect(items[0].name).toBe("Junglet #64");
    expect(items[0].priceSol).toBeCloseTo(0.695, 9);
    const img = new URL(items[0].image);
    expect(img.origin).toBe("https://wsrv.nl");
    expect(img.searchParams.get("url")).toBe(listing().token.image);
  });

  it.each([
    ["another collection", (l) => ({ ...l, token: { ...l.token, collection: "degods" } })],
    ["a price in another mint", (l) => ({ ...l, priceInfo: { solPrice: { ...l.priceInfo.solPrice, address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } } })],
    ["the wrong decimals", (l) => ({ ...l, priceInfo: { solPrice: { ...l.priceInfo.solPrice, decimals: 6 } } })],
    ["a rawAmount that is not digits", (l) => ({ ...l, priceInfo: { solPrice: { ...l.priceInfo.solPrice, rawAmount: "6.95e8" } } })],
    ["no price info at all", (l) => ({ ...l, priceInfo: undefined })],
  ])("drops a listing with %s, and counts it", async (_label, mutate) => {
    const valid = listing({ tokenMint: "5kL2Jz7q3sQnUe7Fq9yL2B8pA1s3d4f5g6h7j8k9m1n2", token: { ...listing().token, name: "Junglet #65" } });
    answer = () => json([valid, mutate(listing())]);
    const { fetchExternalItems } = await load();
    const { items, dropped } = await fetchExternalItems(COLLECTIONS.junglets);
    expect(items.map((i) => i.name)).toEqual(["Junglet #65"]);
    expect(dropped).toBe(1);
  });

  it("a page of listings that all fail validation is unavailable, never an empty success", async () => {
    answer = () => json([
      listing({ priceInfo: undefined }),
      listing({ tokenMint: "5kL2Jz7q3sQnUe7Fq9yL2B8pA1s3d4f5g6h7j8k9m1n2", priceInfo: undefined }),
    ]);
    const { fetchExternalItems } = await load();
    const res = await fetchExternalItems(COLLECTIONS.junglets);
    expect(res.unavailable).toBe(true);
    expect(res.reason).toBe("shape");
  });

  it("no listings at all is an empty success", async () => {
    answer = () => json([]);
    const { fetchExternalItems } = await load();
    const res = await fetchExternalItems(COLLECTIONS.junglets);
    expect(res.unavailable).toBeFalsy();
    expect(res.items).toEqual([]);
    expect(res.dropped).toBe(0);
  });

  it("nulls an image that is not on na-assets.pinit.io, rather than proxying it", async () => {
    answer = () => json([listing({ token: { ...listing().token, image: "https://evil.example/x.png" } })]);
    const { fetchExternalItems } = await load();
    const { items } = await fetchExternalItems(COLLECTIONS.junglets);
    expect(items[0].image).toBeNull();
  });
});

describe("failures are unavailable, with a reason", () => {
  it("a 429 is rate-limited, with the wait the market asked for", async () => {
    answer = () => json("You have exceeded the requests in 1 min limit!", { status: 429, headers: { "retry-after": "60" } });
    const { fetchExternalStats } = await load();
    const s = await fetchExternalStats(COLLECTIONS.junglets);
    expect(s.unavailable).toBe(true);
    expect(s.reason).toBe("rate-limited");
    expect(s.retryAfter).toBe(60);
  });

  it("an HTML answer (vite preview has no /api) is unavailable, not an empty gallery", async () => {
    answer = () => json("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
    const { fetchExternalItems } = await load();
    const r = await fetchExternalItems(COLLECTIONS.bojungles);
    expect(r.unavailable).toBe(true);
    expect(r.items).toBeUndefined();
  });

  it("an HTML 404 is unavailable", async () => {
    answer = () => json("<html>404</html>", { status: 404 });
    const { fetchExternalStats } = await load();
    expect((await fetchExternalStats(COLLECTIONS.memeticseeds)).unavailable).toBe(true);
  });

  it("a network error is unavailable", async () => {
    answer = () => { throw new TypeError("Failed to fetch"); };
    const { fetchExternalStats } = await load();
    expect((await fetchExternalStats(COLLECTIONS.memeticseeds)).unavailable).toBe(true);
  });
});

describe("the budget", () => {
  it("merges identical reads in flight into one request", async () => {
    answer = () => json(osStats({ floor_price: null, volume: 1, num_owners: 1 }));
    const { fetchExternalStats } = await load();
    await Promise.all([
      fetchExternalStats(COLLECTIONS.bojungles),
      fetchExternalStats(COLLECTIONS.bojungles),
      fetchExternalStats(COLLECTIONS.bojungles),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves a repeat read from memory for a minute", async () => {
    answer = () => json(osStats({ floor_price: null, volume: 1, num_owners: 1 }));
    const { fetchExternalStats } = await load();
    await fetchExternalStats(COLLECTIONS.bojungles);
    await fetchExternalStats(COLLECTIONS.bojungles);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never caches a failure: the next read asks again", async () => {
    answer = () => json("busy", { status: 429, headers: { "retry-after": "1" } });
    const { fetchExternalStats } = await load();
    const first = await fetchExternalStats(COLLECTIONS.bojungles);
    expect(first.unavailable).toBe(true);
    answer = () => json(osStats({ floor_price: null, volume: 1.42308, num_owners: 100 }));
    const second = await fetchExternalStats(COLLECTIONS.bojungles);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.volume).toBe(1.42308);
  });

  it("never asks OpenSea about a collection it does not list", async () => {
    const { fetchExternalStats } = await load();
    await fetchExternalStats(COLLECTIONS.junglets);
    for (const call of fetchMock.mock.calls) expect(urlOf(call).pathname).not.toBe("/api/opensea");
  });
});
