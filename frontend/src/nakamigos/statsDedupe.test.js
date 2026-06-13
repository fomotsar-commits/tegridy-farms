import { describe, it, expect, vi, beforeEach } from "vitest";

// F516: fetchCollectionStats de-dupes concurrent in-flight calls for the same
// collection so a page that mounts several stat-consuming components (Hero,
// PortfolioTracker, PriceAlerts, OnChainProfile, …) doesn't multiply the
// /api proxy fan-out and trip our own rate limiter.

// Count how many times the underlying proxy layer is actually hit. We make the
// floor lookup the canary — it's the first alchemyGet in fetchCollectionStats.
const calls = { floor: 0, owners: 0, meta: 0 };

vi.mock("./lib/proxy", () => {
  class ApiError extends Error {
    constructor(message, status, retryAfter = null) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.retryAfter = retryAfter;
    }
    get isRetryable() {
      return this.status === 0 || this.status === 429 || (this.status >= 500 && this.status < 600);
    }
  }
  return {
    ApiError,
    alchemyGet: vi.fn(async (endpoint) => {
      if (endpoint === "getFloorPrice") {
        calls.floor++;
        // Resolve on a microtask turn so concurrent callers overlap in-flight.
        await Promise.resolve();
        return { openSea: { floorPrice: 1.23 } };
      }
      if (endpoint === "getOwnersForContract") {
        calls.owners++;
        return { owners: new Array(100).fill("0x0") };
      }
      if (endpoint === "getContractMetadata") {
        calls.meta++;
        return { totalSupply: "5000" };
      }
      return {};
    }),
    alchemyPost: vi.fn(async () => ({})),
    openseaGet: vi.fn(async () => ({ total: { volume: 42 } })),
    openseaPost: vi.fn(async () => ({})),
  };
});

// Native orderbook lookup is dynamically imported inside fetchCollectionStats.
vi.mock("./lib/orderbook", () => ({
  fetchNativeListings: vi.fn(async () => ({ orders: [] })),
}));

import { fetchCollectionStats } from "./api";

beforeEach(() => {
  calls.floor = 0;
  calls.owners = 0;
  calls.meta = 0;
});

const COL = { contract: "0xAbC0000000000000000000000000000000000001", slug: "demo", openseaSlug: "demo" };

describe("fetchCollectionStats in-flight de-dupe (F516)", () => {
  it("shares a single underlying request across concurrent callers for the same key", async () => {
    const [a, b, c] = await Promise.all([
      fetchCollectionStats(COL),
      fetchCollectionStats(COL),
      fetchCollectionStats(COL),
    ]);
    // All callers get the same resolved stats…
    expect(a.floor).toBe(1.23);
    expect(b.floor).toBe(1.23);
    expect(c.floor).toBe(1.23);
    // …but the proxy layer was only hit once.
    expect(calls.floor).toBe(1);
  });

  it("clears the in-flight entry once settled so a later call refetches", async () => {
    await fetchCollectionStats(COL);
    expect(calls.floor).toBe(1);
    // A second, sequential (non-overlapping) call is a fresh request.
    await fetchCollectionStats(COL);
    expect(calls.floor).toBe(2);
  });

  it("does not share requests across different collections", async () => {
    const other = { contract: "0xDeF0000000000000000000000000000000000002", slug: "other", openseaSlug: "other" };
    await Promise.all([fetchCollectionStats(COL), fetchCollectionStats(other)]);
    expect(calls.floor).toBe(2);
  });
});
