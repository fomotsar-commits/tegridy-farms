// SECURITY REGRESSION TESTS — the /api/orderbook read path (action=query).
//
// This feed powers the NATIVE LISTINGS table, which renders a Buy button on every
// row it returns. Two guards protect it, and both were missing/inverted before
// 2026-07-19:
//
//   1. order_type = "listing". Without it the feed also returned attacker-posted
//      "offer" rows. The create path deliberately SKIPS on-chain ownership
//      verification and the ETH-only currency guard for non-listings, so anyone
//      could POST a validly-signed order whose consideration demands SOMEONE
//      ELSE's NFT, priced from a 1-wei ERC-20 offer item so it sorts to the top of
//      the price-ascending book. A holder clicking Buy would be asked to hand over
//      their own NFT. Nothing in the app ever creates a native offer row.
//
//   2. is_bundle. The filter used to live INSIDE `if (BUNDLE_LISTING_ENABLED)`,
//      so turning the flag OFF did not harden the feed — it REMOVED the filter,
//      letting a bundle's package total leak into the per-token feed and the
//      collection floor stat. The kill-switch failed OPEN.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock("viem", () => ({ recoverMessageAddress: vi.fn(async () => "0x" + "a".repeat(40)) }));

const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";

// Chainable supabase mock that RECORDS every .eq() predicate so we can assert on them.
let eqCalls = [];
function makeQueryResult(data = []) {
  const chain = {
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    select: vi.fn(() => chain),
    eq: vi.fn((col, val) => { eqCalls.push([col, val]); return chain; }),
    gt: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: data[0] || null, error: null })),
    maybeSingle: vi.fn(async () => ({ data: data[0] || null, error: null })),
    then: (resolve) => resolve({ data, error: null, count: data.length }),
  };
  return chain;
}
let supabaseFromHandler = vi.fn(() => makeQueryResult([]));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: (...a) => supabaseFromHandler(...a) })),
}));

function makeReq(query) {
  return { method: "GET", body: {}, query, headers: { origin: "https://nakamigos.gallery" } };
}
function makeRes() {
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const res = {
    setHeader: () => res,
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    end: vi.fn(),
  };
  return { res, statusSpy, jsonSpy };
}

describe("orderbook action=query — read-path guards", () => {
  let handler;
  beforeEach(async () => {
    vi.resetModules();
    eqCalls = [];
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.NODE_ENV = "test";
    delete process.env.BUNDLE_LISTING_ENABLED;
    supabaseFromHandler = vi.fn(() => makeQueryResult([]));
    handler = (await import("../orderbook.js")).default;
  });

  it("ALWAYS filters order_type=listing — attacker-posted offers can never reach the buy surface", async () => {
    const { res } = makeRes();
    await handler(makeReq({ action: "query", contract: NAKAMIGOS, status: "active" }), res);
    expect(eqCalls).toContainEqual(["order_type", "listing"]);
  });

  it("excludes bundles by default", async () => {
    const { res } = makeRes();
    await handler(makeReq({ action: "query", contract: NAKAMIGOS, status: "active" }), res);
    expect(eqCalls).toContainEqual(["is_bundle", false]);
  });

  // The kill-switch must FAIL CLOSED: flag off => bundles still excluded from the
  // per-token feed, not "filter removed entirely".
  it("still excludes bundles when BUNDLE_LISTING_ENABLED is unset (kill-switch fails CLOSED)", async () => {
    delete process.env.BUNDLE_LISTING_ENABLED;
    const { res } = makeRes();
    await handler(makeReq({ action: "query", contract: NAKAMIGOS, status: "active" }), res);
    expect(eqCalls).toContainEqual(["is_bundle", false]);
    expect(eqCalls).toContainEqual(["order_type", "listing"]);
  });

  it("refuses to serve the bundles surface while the feature flag is off", async () => {
    delete process.env.BUNDLE_LISTING_ENABLED;
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq({ action: "query", contract: NAKAMIGOS, status: "active", bundles: "true" }), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith({ orders: [], count: 0 });
  });

  it("serves ONLY bundles (and still only listings) when the flag is on and bundles=true", async () => {
    process.env.BUNDLE_LISTING_ENABLED = "true";
    vi.resetModules();
    handler = (await import("../orderbook.js")).default;
    eqCalls = [];
    const { res } = makeRes();
    await handler(makeReq({ action: "query", contract: NAKAMIGOS, status: "active", bundles: "true" }), res);
    expect(eqCalls).toContainEqual(["is_bundle", true]);
    expect(eqCalls).toContainEqual(["order_type", "listing"]);
  });
});
