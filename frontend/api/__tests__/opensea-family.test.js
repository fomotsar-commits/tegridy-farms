// The OpenSea proxy: Gold Cards joins the tradeable routes, and the four
// family collections OpenSea lists are readable by slug for stats and items
// only.
//
// A read-only slug may reach exactly two GET routes (collection stats and the
// item list) with exactly two query keys (limit, next). It can never reach a
// listing, an offer, an event feed or a POST, and its contract is admitted in
// no order body. The same change closes two older gaps: `offers/build` and
// `criteria_offers` never checked the collection slug in their body, and
// `offers/fulfillment_data` never checked the contract in its `consideration`.
//
// The read-only reads also get their own per-IP budget. The landing now makes
// eight stats reads and a view-only page adds item pages, all from the same
// visitor who may be about to accept an offer; a shared 30-per-minute bucket
// would let browsing 429 the checkout POST that follows a paid WETH approve.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ADDR, VIEW_ONLY_EVM_SLUGS, EXPECTED_FAMILY } from "../../src/nakamigos/__fixtures__/jungleBayFamily.js";

const buckets = vi.hoisted(() => new Map());
const rate = vi.hoisted(() => ({ calls: [] }));

vi.mock("../_lib/ratelimit.js", () => ({
  // A faithful per-identifier counter, so a test can spend a bucket.
  checkRateLimit: vi.fn(async (req, res, { limit, identifier }) => {
    rate.calls.push({ identifier, limit });
    const n = (buckets.get(identifier) || 0) + 1;
    buckets.set(identifier, n);
    if (n > limit) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Too many requests" });
      return false;
    }
    return true;
  }),
  checkGlobalLimit: vi.fn(async () => true),
}));

const GOLD = ADDR.junglebaygoldcards.toLowerCase();
const READ_ONLY = VIEW_ONLY_EVM_SLUGS.map((s) => EXPECTED_FAMILY[s].openseaSlug);
// The two Base ERC-721s whose OpenSea listings are bought here (venueBuy).
const BASE_BUY = ["bojungless", "seeds-from-the-memetic-garden"];
const BOJ = ADDR.bojungles.toLowerCase();
const SEEDS = ADDR.memeticseeds.toLowerCase();
const VIEW_ONLY_CONTRACTS = VIEW_ONLY_EVM_SLUGS.map((s) => ADDR[s]);

function makeReq({ method = "GET", query = {}, body = undefined, headers = {} } = {}) {
  return { method, query, body, headers: { origin: "https://memetics.finance", ...headers } };
}

function makeRes() {
  const out = { status: null, json: null, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[k] = v; return res; },
    status: (c) => { out.status = c; return res; },
    json: (p) => { out.json = p; return res; },
    end: vi.fn(),
  };
  return { res, out };
}

let handler;
let fetchMock;
let upstreamBody;

beforeEach(async () => {
  vi.resetModules();
  buckets.clear();
  rate.calls.length = 0;
  process.env.OPENSEA_API_KEY = "test-key";
  process.env.NODE_ENV = "test";
  upstreamBody = { ok: true };
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(upstreamBody),
  }));
  globalThis.fetch = fetchMock;
  vi.spyOn(console, "error").mockImplementation(() => {});
  handler = (await import("../opensea.js")).default;
});

async function call(reqInit) {
  const { res, out } = makeRes();
  await handler(makeReq(reqInit), res);
  return out;
}

describe("Gold Cards is a venue collection on the proxy", () => {
  it.each([
    "listings/collection/junglebaygoldcards/best",
    "listings/collection/junglebaygoldcards/all",
    "collections/junglebaygoldcards/stats",
    "collection/junglebaygoldcards/stats",
    "events/collection/junglebaygoldcards",
    "offers/collection/junglebaygoldcards/all",
    "offers/collection/junglebaygoldcards/nfts/1/best",
  ])("admits GET %s", async (path) => {
    const out = await call({ query: { path } });
    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("admits the Gold contract in a Seaport listing body", async () => {
    const out = await call({
      method: "POST",
      query: { path: "orders/ethereum/seaport/listings" },
      body: { parameters: { offer: [{ itemType: 2, token: GOLD }], consideration: [] } },
    });
    expect(out.status).toBe(200);
  });
});

describe("a family slug reads stats and items, and nothing else", () => {
  for (const slug of READ_ONLY) {
    describe(slug, () => {
      it("GET collections/{slug}/stats is admitted", async () => {
        const out = await call({ query: { path: `collections/${slug}/stats` } });
        expect(out.status).toBe(200);
      });

      it("GET collection/{slug}/nfts is admitted with limit and next, and forwards both", async () => {
        const out = await call({ query: { path: `collection/${slug}/nfts`, limit: "200", next: "abc" } });
        expect(out.status).toBe(200);
        const url = new URL(String(fetchMock.mock.calls[0][0]));
        expect(url.pathname).toBe(`/api/v2/collection/${slug}/nfts`);
        expect(url.searchParams.get("limit")).toBe("200");
        expect(url.searchParams.get("next")).toBe("abc");
      });

      it("the item list is edge-cached for at least five minutes", async () => {
        const out = await call({ query: { path: `collection/${slug}/nfts`, limit: "200" } });
        const sMaxAge = Number(/s-maxage=(\d+)/.exec(out.headers["Cache-Control"] || "")?.[1] ?? 0);
        expect(sMaxAge).toBeGreaterThanOrEqual(300);
      });

      it.each([
        ...(BASE_BUY.includes(slug) ? [] : [(s) => `listings/collection/${s}/best`]),
        (s) => `listings/collection/${s}/all`,
        (s) => `offers/collection/${s}/all`,
        ...(BASE_BUY.includes(slug) ? [] : [(s) => `offers/collection/${s}/nfts/1/best`]),
        (s) => `events/collection/${s}`,
      ])("refuses %s at 400, without asking OpenSea", async (build) => {
        const out = await call({ query: { path: build(slug) } });
        expect(out.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("refuses a POST to a read-only route", async () => {
        const out = await call({ method: "POST", query: { path: `collections/${slug}/stats` }, body: {} });
        expect([400, 403, 405]).toContain(out.status);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("refuses any query key other than limit and next", async () => {
        const out = await call({ query: { path: `collection/${slug}/nfts`, limit: "50", maker: "0x" + "a".repeat(40) } });
        expect(out.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it.each(["a b", "<script>", "x".repeat(1025), "abc&limit=1"])("refuses a malformed next cursor %#", async (next) => {
        const out = await call({ query: { path: `collection/${slug}/nfts`, next } });
        expect(out.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  }

  it("the Base buy slugs are exactly Bojungles and Seeds, and both are family read slugs", () => {
    for (const s of BASE_BUY) expect(READ_ONLY).toContain(s);
  });

  for (const slug of BASE_BUY) {
    describe(`${slug} also reads its best listings, to be bought here`, () => {
      it("GET listings/collection/{slug}/best is admitted with limit and next, and forwards both", async () => {
        const out = await call({ query: { path: `listings/collection/${slug}/best`, limit: "200", next: "abc" } });
        expect(out.status).toBe(200);
        const url = new URL(String(fetchMock.mock.calls[0][0]));
        expect(url.pathname).toBe(`/api/v2/listings/collection/${slug}/best`);
        expect(url.searchParams.get("limit")).toBe("200");
        expect(url.searchParams.get("next")).toBe("abc");
      });

      it("refuses a POST to it", async () => {
        const out = await call({ method: "POST", query: { path: `listings/collection/${slug}/best` }, body: {} });
        expect([400, 403, 405]).toContain(out.status);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("refuses any query key other than limit and next", async () => {
        const out = await call({ query: { path: `listings/collection/${slug}/best`, maker: "0x" + "a".repeat(40) } });
        expect(out.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  }

  it("the proxy is keyed by OpenSea slug: the app's own route key is not a slug it admits", async () => {
    // Bojungles' OpenSea slug is `bojungless` (double s). The app routes it as
    // `bojungles`, and that key must never become a second way in.
    const out = await call({ query: { path: "collection/bojungles/nfts" } });
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("no view-only contract is admitted in an order body", () => {
  it.each(VIEW_ONLY_CONTRACTS)("POST items naming %s are refused 403", async (token) => {
    const out = await call({
      method: "POST",
      query: { path: "orders/ethereum/seaport/listings" },
      body: { parameters: { offer: [{ itemType: 2, token }], consideration: [] } },
    });
    expect(out.status).toBe(403);
    expect(out.json).toEqual({ error: "Contract not supported" });
  });

  it("a criteria offer names its collection by slug, and only a venue slug is built or posted", async () => {
    for (const path of ["offers/build", "criteria_offers"]) {
      const refused = await call({
        method: "POST",
        query: { path },
        body: { criteria: { collection: { slug: "bojungless" } }, offerer: "0x" + "a".repeat(40), quantity: 1 },
      });
      expect(refused.status, path).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    const allowed = await call({
      method: "POST",
      query: { path: "offers/build" },
      body: { criteria: { collection: { slug: "junglebaygoldcards" } }, offerer: "0x" + "a".repeat(40), quantity: 1 },
    });
    expect(allowed.status).toBe(200);
  });

  it("a criteria offer body with no collection slug is refused", async () => {
    const out = await call({ method: "POST", query: { path: "offers/build" }, body: { offerer: "0x" + "a".repeat(40), quantity: 1 } });
    expect(out.status).toBe(403);
  });

  it("accepting an offer names the NFT contract it hands over, and only a venue contract passes", async () => {
    const body = (contract) => ({
      offer: { hash: "0xoffer", chain: "ethereum", protocol_address: "0x0000000000000068f116a894984e2db1123eb395" },
      fulfiller: { address: "0x" + "a".repeat(40) },
      consideration: { asset_contract_address: contract, token_id: "1" },
    });
    const refused = await call({ method: "POST", query: { path: "offers/fulfillment_data" }, body: body(ADDR.bojungles) });
    expect(refused.status).toBe(403);
    const allowed = await call({ method: "POST", query: { path: "offers/fulfillment_data" }, body: body(GOLD) });
    expect(allowed.status).toBe(200);
  });
});

// The two routes that build fill calldata on the venue's paid key. Both are
// pinned to Ethereum, and accepting an offer must name a venue contract, so
// the proxy never builds a fill for a Base or ERC-1155 family order.
describe("fill calldata is built only for Ethereum venue orders and Base buy listings", () => {
  const FULFILLER = { address: "0x" + "a".repeat(40) };
  const SEAPORT = "0x0000000000000068f116a894984e2db1123eb395";
  const buy = (listing) => ({ method: "POST", query: { path: "listings/fulfillment_data" }, body: { listing, fulfiller: FULFILLER } });
  const accept = (offer, consideration) => ({
    method: "POST",
    query: { path: "offers/fulfillment_data" },
    body: { offer, fulfiller: FULFILLER, ...(consideration ? { consideration } : {}) },
  });

  it("a buy on Ethereum is forwarded", async () => {
    const out = await call(buy({ hash: "0xlisting", chain: "ethereum", protocol_address: SEAPORT }));
    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([["solana"], [undefined], ["Ethereum"], ["Base"], ["__proto__"], ["optimism"]])("a buy whose listing names chain %s is refused and never forwarded", async (chain) => {
    const out = await call(buy({ hash: "0xlisting", chain, protocol_address: SEAPORT }));
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // What OpenSea answers for a fill: its advisory orders, naming the NFT.
  const fillMoving = (token) => ({
    fulfillment_data: {
      transaction: { to: SEAPORT, value: "1", function: "f()", input_data: {} },
      orders: [{ parameters: { offer: [{ itemType: 2, token, identifierOrCriteria: "1" }], consideration: [] } }],
    },
  });

  it.each([["Bojungles", BOJ], ["Seeds", SEEDS]])("a buy on Base whose answer moves only %s is forwarded and returned", async (_label, token) => {
    upstreamBody = fillMoving(token);
    const out = await call(buy({ hash: "0xlisting", chain: "base", protocol_address: SEAPORT }));
    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).listing.chain).toBe("base");
  });

  it.each([
    ["an Ethereum venue NFT (Gold Cards)", GOLD],
    ["the memes, a view-only ERC-1155", ADDR.junglebaymemes.toLowerCase()],
    ["an unknown contract", "0x" + "9".repeat(40)],
  ])("a buy on Base whose answer moves %s is refused with 403", async (_label, token) => {
    upstreamBody = fillMoving(token);
    const out = await call(buy({ hash: "0xlisting", chain: "base", protocol_address: SEAPORT }));
    expect(out.status).toBe(403);
  });

  it("a buy on Ethereum whose answer moves a Bojungle is refused with 403", async () => {
    upstreamBody = fillMoving(BOJ);
    const out = await call(buy({ hash: "0xlisting", chain: "ethereum", protocol_address: SEAPORT }));
    expect(out.status).toBe(403);
  });

  it("an accept on Ethereum that names a Bojungle is refused: Base NFTs are only ever bought", async () => {
    const out = await call(accept({ hash: "0xoffer", chain: "ethereum", protocol_address: SEAPORT }, { asset_contract_address: BOJ, token_id: "1" }));
    expect(out.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a buy with no listing at all is refused", async () => {
    const out = await call({ method: "POST", query: { path: "listings/fulfillment_data" }, body: { fulfiller: FULFILLER } });
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an accept on Base that names an Ethereum venue contract is refused", async () => {
    const out = await call(accept({ hash: "0xoffer", chain: "base", protocol_address: SEAPORT }, { asset_contract_address: GOLD, token_id: "1" }));
    expect(out.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([["solana"], [undefined], ["Base"], ["optimism"]])("an accept naming chain %s is refused and never forwarded", async (chain) => {
    const out = await call(accept({ hash: "0xoffer", chain, protocol_address: SEAPORT }, { asset_contract_address: BOJ, token_id: "1" }));
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([["Bojungles", BOJ], ["Seeds", SEEDS]])("an accept on Base of a %s offer is forwarded when its answer moves only that NFT", async (_label, token) => {
    upstreamBody = fillMoving(token);
    const out = await call(accept({ hash: "0xoffer", chain: "base", protocol_address: SEAPORT }, { asset_contract_address: token, token_id: "1" }));
    expect(out.status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).offer.chain).toBe("base");
  });

  it("an accept on Base whose answer moves an Ethereum venue NFT is refused with 403", async () => {
    upstreamBody = fillMoving(GOLD);
    const out = await call(accept({ hash: "0xoffer", chain: "base", protocol_address: SEAPORT }, { asset_contract_address: BOJ, token_id: "1" }));
    expect(out.status).toBe(403);
  });

  it("an accept that names no NFT contract is refused", async () => {
    const out = await call(accept({ hash: "0xoffer", chain: "ethereum", protocol_address: SEAPORT }));
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an accept on Ethereum for a venue contract is forwarded", async () => {
    const out = await call(accept({ hash: "0xoffer", chain: "ethereum", protocol_address: SEAPORT }, { asset_contract_address: GOLD, token_id: "1" }));
    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("item image URLs are sanitised like every other URL field", () => {
  it("nulls a javascript: display_image_url and display_animation_url", async () => {
    upstreamBody = {
      nfts: [{
        identifier: "0",
        contract: ADDR.bojungles.toLowerCase(),
        display_image_url: "javascript:alert(1)",
        display_animation_url: "javascript:alert(2)",
        image_url: "https://i2c.seadn.io/base/x.png",
      }],
      next: null,
    };
    const out = await call({ query: { path: "collection/bojungless/nfts", limit: "200" } });
    expect(out.status).toBe(200);
    expect(out.json.nfts[0].display_image_url).toBeNull();
    expect(out.json.nfts[0].display_animation_url).toBeNull();
    expect(out.json.nfts[0].image_url).toBe("https://i2c.seadn.io/base/x.png");
  });
});

describe("browsing cannot spend the checkout's budget", () => {
  it("thirty family reads from one visitor still leave the offer-accept POST its budget", async () => {
    for (let i = 0; i < 30; i++) {
      const slug = READ_ONLY[i % READ_ONLY.length];
      await call({ query: { path: i % 2 ? `collections/${slug}/stats` : `collection/${slug}/nfts` } });
    }
    const accept = await call({
      method: "POST",
      query: { path: "offers/fulfillment_data" },
      body: {
        offer: { hash: "0xoffer", chain: "ethereum", protocol_address: "0x0000000000000068f116a894984e2db1123eb395" },
        fulfiller: { address: "0x" + "a".repeat(40) },
        consideration: { asset_contract_address: GOLD, token_id: "1" },
      },
    });
    expect(accept.status).toBe(200);
    const buy = await call({
      method: "POST",
      query: { path: "listings/fulfillment_data" },
      body: { listing: { hash: "0xlisting", chain: "ethereum" }, fulfiller: { address: "0x" + "a".repeat(40) } },
    });
    expect(buy.status).toBe(200);
  });

  it("family reads are still rate limited per visitor, on a bucket of their own", async () => {
    await call({ query: { path: `collections/${READ_ONLY[0]}/stats` } });
    const ids = rate.calls.map((c) => c.identifier);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain("opensea");
  });

  it("checkout POSTs stay on the original bucket", async () => {
    await call({
      method: "POST",
      query: { path: "listings/fulfillment_data" },
      body: { listing: { hash: "0xlisting", chain: "ethereum" }, fulfiller: { address: "0x" + "a".repeat(40) } },
    });
    expect(rate.calls.map((c) => c.identifier)).toContain("opensea");
  });
});

// Bojungles and Seeds are bid on here, on Base: an item offer is posted to
// OpenSea's Base order book, and its maker and the token's owner read it back.
describe("Bojungles and Seeds take offers on Base", () => {
  const offerBody = (token) => ({
    parameters: {
      offer: [{ itemType: 1, token: "0x4200000000000000000000000000000000000006" }],
      consideration: [{ itemType: 2, token, identifierOrCriteria: "7" }],
    },
  });

  it.each([["Bojungles", BOJ], ["Seeds", SEEDS]])("a Base offer on %s is posted", async (_label, token) => {
    const out = await call({ method: "POST", query: { path: "orders/base/seaport/offers" }, body: offerBody(token) });
    expect(out.status).toBe(200);
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/api/v2/orders/base/seaport/offers");
  });

  it.each([["Gold Cards", GOLD], ["the memes", ADDR.junglebaymemes.toLowerCase()], ["an unknown contract", "0x" + "9".repeat(40)]])("a Base offer on %s is refused 403", async (_label, token) => {
    const out = await call({ method: "POST", query: { path: "orders/base/seaport/offers" }, body: offerBody(token) });
    expect(out.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([["Bojungles", BOJ], ["Seeds", SEEDS]])("an Ethereum offer on %s is refused 403", async (_label, token) => {
    const out = await call({ method: "POST", query: { path: "orders/ethereum/seaport/offers" }, body: offerBody(token) });
    expect(out.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["orders/base/seaport/listings", "orders/solana/seaport/offers", "orders/Base/seaport/offers"])("POST %s is not a route", async (path) => {
    const out = await call({ method: "POST", query: { path }, body: offerBody(BOJ) });
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  for (const slug of BASE_BUY) {
    it(`GET offers/collection/${slug}/nfts/{id}/best is admitted with no query`, async () => {
      const out = await call({ query: { path: `offers/collection/${slug}/nfts/42/best` } });
      expect(out.status).toBe(200);
      const bad = await call({ query: { path: `offers/collection/${slug}/nfts/42/best`, limit: "5" } });
      expect(bad.status).toBe(400);
      const notId = await call({ query: { path: `offers/collection/${slug}/nfts/4x/best` } });
      expect(notId.status).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it(`GET offers/collection/${slug}/all is admitted for one maker only`, async () => {
      const maker = "0x" + "a".repeat(40);
      const out = await call({ query: { path: `offers/collection/${slug}/all`, maker, limit: "50" } });
      expect(out.status).toBe(200);
      expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("maker")).toBe(maker);
      for (const query of [{}, { maker: "nobody" }, { maker, token_ids: "1" }]) {
        const refused = await call({ query: { path: `offers/collection/${slug}/all`, ...query } });
        expect(refused.status).toBe(400);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it("offers/build and criteria_offers still refuse a Base slug: only item offers are made on Base", async () => {
    for (const path of ["offers/build", "criteria_offers"]) {
      const out = await call({ method: "POST", query: { path }, body: { criteria: { collection: { slug: "bojungless" } } } });
      expect(out.status).toBe(403);
    }
  });
});
