import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Read-honesty for fetchListings, the merged OpenSea + native-orderbook feed.
//
// Its result feeds a CLAIM, not just a display. Listings.jsx paints
// "No active listings for <name> right now" when `source === "opensea"` and
// nothing is listed, and the "temporarily unavailable" copy only when `source`
// is null and `error` is set (useListings passes it through as listingsError).
// So an empty result may come back error-free only when every source it tried
// was actually read.
//
// Only the NETWORK BOUNDARY is faked: ./lib/proxy for OpenSea, and global
// `fetch` for /api/orderbook. The real fetchNativeListings runs. It cannot
// throw: every failure resolves as { orders: [], error }. A test that mocks it
// to reject exercises a failure production never produces, and passes while
// the real outage renders as a healthy empty market.

const state = vi.hoisted(() => ({ openseaGet: null }));

vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  const down = vi.fn(async () => {
    throw new Error("proxy down");
  });
  return {
    ...actual,
    alchemyGet: down,
    alchemyPost: down,
    openseaPost: down,
    openseaGet: vi.fn((...args) => state.openseaGet(...args)),
  };
});

// Imported statically so the dynamic import inside fetchListings resolves from
// the module cache, and so the first test can prove the real function is used.
import * as orderbook from "./lib/orderbook";
import { fetchListings } from "./api";
import { CONTRACT } from "./constants";

const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";

function osListing(tokenId, wei) {
  return {
    order_hash: `0x${"a".repeat(63)}${tokenId}`,
    protocol_address: SEAPORT,
    price: { current: { value: wei } },
    protocol_data: {
      parameters: {
        offerer: "0x1111111111111111111111111111111111111111",
        offer: [{ identifierOrCriteria: String(tokenId) }],
      },
    },
  };
}

function nativeOrder(tokenId, eth) {
  return {
    token_id: tokenId,
    price_eth: eth,
    maker: "0x2222222222222222222222222222222222222222",
    order_hash: `0x${"b".repeat(63)}${tokenId}`,
    protocol_address: SEAPORT,
    is_bundle: false,
    currency: null,
    parameters: { offerer: "0x2222222222222222222222222222222222222222" },
  };
}

const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

// OpenSea, as seen through the proxy.
const OS = {
  down: async () => {
    throw new Error("OpenSea 429");
  },
  empty: async () => ({ listings: [], next: null }),
  one: async () => ({ listings: [osListing(7, "500000000000000000")], next: null }),
};

// The native orderbook, as seen through global fetch.
const BOOK = {
  down: () =>
    vi.fn(async () => {
      throw new TypeError("fetch failed");
    }),
  // api/orderbook.js answers an unreachable database with a 200, an EMPTY list
  // and `degraded: true` (its DEGRADED READS block) rather than an error status.
  degraded: () => vi.fn(async () => json({ orders: [], count: 0, degraded: true })),
  empty: () => vi.fn(async () => json({ orders: [], count: 0 })),
  one: () => vi.fn(async () => json({ orders: [nativeOrder(9, 0.4)], count: 1 })),
};

let fetchStub;

function setup({ os, book }) {
  state.openseaGet = OS[os];
  fetchStub = BOOK[book]();
  vi.stubGlobal("fetch", fetchStub);
}

// A failed orderbook attempt is retried after 1s and then 2s (orderbook.js
// withRetry). Fake timers skip those sleeps without changing how many attempts
// run or what the function resolves to. Every turn yields a real macrotask, so
// a dynamic import that has to load a module still gets to finish. The test's
// own timeout is the bound: a turn cap would run out while that load is in
// flight, before the retry timers even exist.
async function settle(promise) {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  while (!settled) await vi.advanceTimersByTimeAsync(500);
  return tracked;
}

const load = (opts = { contract: CONTRACT }) => settle(fetchListings("nakamigos", opts));

// Every orderbook request went out through the real fetchNativeListings.
function expectOrderbookQueried() {
  expect(fetchStub).toHaveBeenCalled();
  for (const [url] of fetchStub.mock.calls) {
    expect(String(url)).toMatch(/^\/api\/orderbook\?/);
    expect(String(url)).toContain(`contract=${CONTRACT}`);
  }
}

function expectOutage(res) {
  expect(res.listings).toEqual([]);
  expect(res.source).toBeNull();
  expect(res.error).toEqual(expect.stringMatching(/\S/));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchListings never reports an unread source as an empty market", () => {
  it("drives the real fetchNativeListings, not a double", () => {
    expect(vi.isMockFunction(orderbook.fetchNativeListings)).toBe(false);
  });

  it("both sources down (the reported outage): outage, not 'No active listings'", async () => {
    setup({ os: "down", book: "down" });
    const res = await load();
    expectOrderbookQueried();
    expectOutage(res);
  });

  // Each leg below fails exactly ONE source while the other is READ, so the
  // failure under test is the only thing that can decide the result.

  it("OpenSea read empty, orderbook down: the orderbook's resolved error counts as a failure", async () => {
    setup({ os: "empty", book: "down" });
    const res = await load();
    expectOrderbookQueried();
    expectOutage(res);
  });

  it("OpenSea read empty, orderbook degraded: a degraded 200 counts as a failure", async () => {
    setup({ os: "empty", book: "degraded" });
    const res = await load();
    expectOrderbookQueried();
    expectOutage(res);
  });

  it("OpenSea down, orderbook read empty: outage, because OpenSea's listings were never read", async () => {
    setup({ os: "down", book: "empty" });
    const res = await load();
    expectOrderbookQueried();
    expectOutage(res);
  });

  it("no contract, OpenSea down: outage (only OpenSea was attempted)", async () => {
    setup({ os: "down", book: "empty" });
    const res = await load({});
    expect(fetchStub).not.toHaveBeenCalled();
    expectOutage(res);
  });
});

describe("fetchNativeListings' failure shape, which every caller keys on", () => {
  it("a network failure resolves { orders: [], error } and never rejects", async () => {
    // Load-bearing beyond fetchListings: OrderBookPanel awaits this with no
    // .catch, so a rejection would leave its spinner up for good.
    setup({ os: "empty", book: "down" });
    const res = await settle(orderbook.fetchNativeListings(CONTRACT));
    expect(res.orders).toEqual([]);
    expect(res.error).toEqual(expect.stringMatching(/\S/));
  });

  it("a degraded 200 resolves as a failure too, and is not retried", async () => {
    // The server degrades so the UI can move on at once; retrying would stall
    // first paint behind its read deadline three times over.
    setup({ os: "empty", book: "degraded" });
    const res = await settle(orderbook.fetchNativeListings(CONTRACT));
    expect(res.orders).toEqual([]);
    expect(res.error).toEqual(expect.stringMatching(/\S/));
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("real listings are never blanked by a partial failure", () => {
  it("OpenSea down, orderbook has a listing: shows it, labelled native", async () => {
    setup({ os: "down", book: "one" });
    const res = await load();
    expectOrderbookQueried();
    expect(res.error).toBeUndefined();
    expect(res.source).toBe("native");
    expect(res.listings.map((l) => l.tokenId)).toEqual(["9"]);
  });

  it("OpenSea has a listing, orderbook down: shows it, labelled OpenSea", async () => {
    setup({ os: "one", book: "down" });
    const res = await load();
    expectOrderbookQueried();
    expect(res.error).toBeUndefined();
    expect(res.source).toBe("opensea");
    expect(res.listings.map((l) => l.tokenId)).toEqual(["7"]);
  });

  it("both sources read and empty: an honest empty market still says so", async () => {
    setup({ os: "empty", book: "empty" });
    const res = await load();
    expectOrderbookQueried();
    expect(res).toEqual({ listings: [], source: "opensea" });
  });
});

// LAST on purpose: this leg swaps the module registry, and anything after it
// would load its orderbook module afresh.
describe("a rejected orderbook load", () => {
  afterEach(() => {
    vi.doUnmock("./lib/orderbook");
    vi.resetModules();
  });

  it("OpenSea read empty, orderbook module failed to load: a rejection counts as a failure too", async () => {
    // A chunk-load failure after a deploy is the one way this path REJECTS
    // rather than resolving { error }. Fresh copy of api.js so its dynamic
    // import sees the failing module.
    vi.resetModules();
    vi.doMock("./lib/orderbook", () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    const { fetchListings: fresh } = await import("./api");
    setup({ os: "empty", book: "empty" });
    const res = await settle(fresh("nakamigos", { contract: CONTRACT }));
    expect(fetchStub).not.toHaveBeenCalled();
    expectOutage(res);
  });
});
