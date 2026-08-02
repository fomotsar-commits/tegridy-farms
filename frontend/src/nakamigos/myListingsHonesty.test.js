import { describe, it, expect, vi, beforeEach } from "vitest";

// Seller-listings outage honesty.
//
// `fetchMyListings` used to `return []` from its catch, so an OpenSea outage and
// "this wallet has nothing listed" were the SAME value. MyCollection rendered
// both as an absent listings banner, telling a seller they had no live listings
// when the truth was that we could not ask. Same conflation `fetchTopHolders`
// carries `fallback: true` to prevent.
//
// These two tests are a pair on purpose: one proves an outage is reported, the
// other proves a genuinely-empty wallet is NOT mislabelled as an outage. Either
// alone would pass a stub that hardcoded its half.

const { openseaGetMock } = vi.hoisted(() => ({ openseaGetMock: vi.fn() }));

// Keep the real module so `ApiError` still resolves — only the network call is
// replaced. A plain Error is neither ApiError nor TypeError, so withRetry
// (api-offers.js:44) treats it as non-retryable and this settles with no backoff.
vi.mock("./lib/proxy", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, openseaGet: openseaGetMock };
});

const WALLET = "0x0000000000000000000000000000000000000001";

describe("seller listings outage honesty", () => {
  beforeEach(() => {
    openseaGetMock.mockReset();
  });

  it("reports an outage rather than an empty listing set when the API is down", async () => {
    openseaGetMock.mockRejectedValue(new Error("listings API down"));

    const { fetchMyListings } = await import("./api-offers");
    const { CONTRACT } = await import("./constants");
    const res = await fetchMyListings(WALLET, CONTRACT);

    expect(res.fallback).toBe(true);
    expect(res.listings).toEqual([]);
  });

  it("does NOT flag a reachable wallet with zero listings as an outage", async () => {
    openseaGetMock.mockResolvedValue({ orders: [], next: null });

    const { fetchMyListings } = await import("./api-offers");
    const { CONTRACT } = await import("./constants");
    const res = await fetchMyListings(WALLET, CONTRACT);

    expect(res.fallback).toBe(false);
    expect(res.listings).toEqual([]);
  });

  it("keeps the two cases distinguishable, which is the whole point", async () => {
    const { fetchMyListings } = await import("./api-offers");
    const { CONTRACT } = await import("./constants");

    openseaGetMock.mockRejectedValue(new Error("listings API down"));
    const outage = await fetchMyListings(WALLET, CONTRACT);

    openseaGetMock.mockReset();
    openseaGetMock.mockResolvedValue({ orders: [], next: null });
    const empty = await fetchMyListings(WALLET, CONTRACT);

    // Both carry zero rows; only `fallback` separates them. If a future refactor
    // collapses the return to a bare array again, this is the assertion that goes
    // red rather than a UI regression shipping silently.
    expect(outage.listings).toEqual(empty.listings);
    expect(outage.fallback).not.toBe(empty.fallback);
  });
});
