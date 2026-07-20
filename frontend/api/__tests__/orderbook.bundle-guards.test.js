// SECURITY / INTEGRITY REGRESSION TESTS — bundle listing write path.
//
// From the bundle go-live re-audit (2026-07-19). The blocking finding was that NOTHING
// at any layer stopped the same NFT from sitting in two live orders. Two signed Seaport
// orders over one NFT are both valid, but mutually exclusive at fill time: whichever
// executes first moves the NFT and the other becomes a guaranteed revert that still
// renders with a live Buy button. The victim is an innocent BUYER.
//
// The old guard was `.eq("token_id", tokenId)`, which migration 012's CHECK constraint
// makes structurally incapable of matching a bundle row (bundles store token_id NULL and
// the set in token_ids), so it covered one of four direction pairs.
//
// Also pinned here: the create-bundle order shape. Without it a seller could post a
// RESTRICTED order with a zone they control — it renders in the public book as an
// ordinary listing but only fills when their zone allows, reverting for everyone else.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));

const SELLER = "0x" + "a".repeat(40);
const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";
const CANONICAL_CONDUIT = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";
const ZERO_ADDR = "0x" + "0".repeat(40);
const ZERO32 = "0x" + "0".repeat(64);

vi.mock("viem", () => ({
  recoverMessageAddress: vi.fn(async () => SELLER),
  decodeAbiParameters: vi.fn(() => []),
  parseAbiParameters: vi.fn(() => []),
}));
vi.mock("../_lib/seaport-verify.js", async () => {
  const actual = await vi.importActual("../_lib/seaport-verify.js");
  return {
    ...actual,
    verifySeaportSignature: vi.fn(async () => ({ ok: true })),
    verifyNftOwnership: vi.fn(async () => ({ ok: true })),
    verifyBundleOwnership: vi.fn(async () => ({ ok: true })),
    fetchNftOwner: vi.fn(async () => SELLER),
  };
});
vi.mock("../_lib/seaportHash.js", () => ({
  computeSeaportOrderHash: vi.fn(() => "0x" + "b".repeat(64)),
  isValidSeaportOrderHash: vi.fn(() => true),
}));
vi.mock("../_lib/push.js", () => ({ sendPushToWallet: vi.fn(async () => {}) }));

// ── Supabase mock ──────────────────────────────────────────────────
// `selectRows` is what a SELECT resolves to; `updates` records every cancel.
let selectRows = [];
let updates = [];
let inserted = [];
function makeChain(table) {
  const chain = {
    _isUpdate: false,
    insert: vi.fn((row) => { inserted.push({ table, row }); return chain; }),
    update: vi.fn((patch) => { chain._isUpdate = true; chain._patch = patch; return chain; }),
    select: vi.fn(() => chain),
    eq: vi.fn((col, val) => {
      if (chain._isUpdate && col === "order_hash") updates.push({ hash: val, patch: chain._patch });
      return chain;
    }),
    gt: vi.fn(() => chain), gte: vi.fn(() => chain),
    order: vi.fn(() => chain), limit: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: selectRows[0] || null, error: null })),
    maybeSingle: vi.fn(async () => ({ data: selectRows[0] || null, error: null })),
    then: (resolve) => resolve({ data: selectRows, error: null, count: selectRows.length }),
  };
  return chain;
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: (t) => makeChain(t) })),
}));

function bundleParams(tokenIds, overrides = {}) {
  return {
    offerer: SELLER,
    zone: ZERO_ADDR,
    zoneHash: ZERO32,
    orderType: 0,
    conduitKey: CANONICAL_CONDUIT,
    startTime: String(Math.floor(Date.now() / 1000)),
    endTime: String(Math.floor(Date.now() / 1000) + 86400),
    salt: "0x1",
    totalOriginalConsiderationItems: 1,
    offer: tokenIds.map((id) => ({
      itemType: 2, token: NAKAMIGOS, identifierOrCriteria: String(id),
      startAmount: "1", endAmount: "1",
    })),
    consideration: [{
      itemType: 0, token: ZERO_ADDR, identifierOrCriteria: "0",
      startAmount: "1000000000000000000", endAmount: "1000000000000000000", recipient: SELLER,
    }],
    ...overrides,
  };
}

function makeRes() {
  const calls = { status: null, json: null };
  const res = {
    setHeader: vi.fn((k, v) => { (res.headers ||= {})[k] = v; return res; }),
    status: (c) => { calls.status = c; return res; },
    json: (p) => { calls.json = p; return res; },
    end: vi.fn(),
  };
  return { res, calls };
}

async function postBundle(handler, params) {
  const { res, calls } = makeRes();
  await handler({
    method: "POST",
    headers: { origin: "https://nakamigos.gallery" },
    query: {},
    body: {
      action: "create-bundle",
      order: {
        parameters: params,
        signature: "0x" + "c".repeat(130),
        seaportSignature: "0x" + "c".repeat(130),
        seaportOrderHash: "0x" + "b".repeat(64),
        seaportCounter: "0",
        protocol_address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
      },
    },
  }, res);
  return calls;
}

describe("orderbook create-bundle — order-shape pin", () => {
  let handler;
  beforeEach(async () => {
    vi.resetModules();
    selectRows = []; updates = []; inserted = [];
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.BUNDLE_LISTING_ENABLED = "true";
    process.env.NODE_ENV = "test";
    handler = (await import("../orderbook.js")).default;
  });

  // A zone the seller controls turns a public-looking listing into one only they can
  // fill — every other buyer's transaction reverts.
  it("rejects a non-zero zone", async () => {
    const c = await postBundle(handler, bundleParams([1, 2], { zone: "0x" + "9".repeat(40) }));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/zero zone/i);
  });

  it("rejects orderType other than 0 (FULL_OPEN)", async () => {
    const c = await postBundle(handler, bundleParams([1, 2], { orderType: 2 }));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/FULL_OPEN/);
  });

  it("rejects a non-zero zoneHash", async () => {
    const c = await postBundle(handler, bundleParams([1, 2], { zoneHash: "0x" + "1".repeat(64) }));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/zoneHash/i);
  });

  it("rejects a non-canonical conduitKey", async () => {
    const c = await postBundle(handler, bundleParams([1, 2], { conduitKey: "0x" + "1".repeat(64) }));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/conduit/i);
  });

  // The honest client signs exactly this shape — the pin must not reject it.
  it("accepts the shape the real client signs", async () => {
    const c = await postBundle(handler, bundleParams([1, 2]));
    expect(c.status).not.toBe(400);
  });
});

describe("orderbook — NFT cannot sit in two live orders", () => {
  let handler;
  beforeEach(async () => {
    vi.resetModules();
    selectRows = []; updates = []; inserted = [];
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.BUNDLE_LISTING_ENABLED = "true";
    process.env.NODE_ENV = "test";
    handler = (await import("../orderbook.js")).default;
  });

  // The direction the old `.eq("token_id", ...)` guard PROVABLY could not see: migration
  // 012 forces token_id NULL on bundle rows, so the predicate never matched one.
  it("refuses a bundle overlapping another active bundle", async () => {
    selectRows = [{
      order_hash: "0xexistingbundle",
      token_id: null,
      is_bundle: true,
      token_ids: [{ contract: NAKAMIGOS, token_id: "2" }, { contract: NAKAMIGOS, token_id: "7" }],
    }];
    const c = await postBundle(handler, bundleParams([1, 2]));
    expect(c.status).toBe(409);
    expect(c.json.error).toMatch(/#2/);
    expect(c.json.conflictingBundles).toContain("0xexistingbundle");
    expect(inserted).toHaveLength(0); // never persisted
  });

  // An overlapping SINGLE is auto-cancelled instead — same relist semantics as `create`,
  // and cheap to recreate, unlike an assembled package.
  it("auto-cancels an overlapping single listing when a bundle is created", async () => {
    selectRows = [{ order_hash: "0xsingle", token_id: "2", is_bundle: false, token_ids: null }];
    const c = await postBundle(handler, bundleParams([1, 2]));
    expect(c.status).not.toBe(409);
    expect(updates.map((u) => u.hash)).toContain("0xsingle");
    expect(updates.find((u) => u.hash === "0xsingle").patch.status).toBe("cancelled");
  });

  it("allows a bundle that overlaps nothing", async () => {
    selectRows = [];
    const c = await postBundle(handler, bundleParams([1, 2]));
    expect(c.status).not.toBe(409);
  });

  // A bundle row must never be silently destroyed to make room for a single listing.
  it("refuses a single listing for an NFT already inside an active bundle", async () => {
    selectRows = [{
      order_hash: "0xbundle",
      token_id: null,
      is_bundle: true,
      token_ids: [{ contract: NAKAMIGOS, token_id: "5" }],
    }];
    const { res, calls } = makeRes();
    await handler({
      method: "POST",
      headers: { origin: "https://nakamigos.gallery" },
      query: {},
      body: {
        action: "create",
        order: {
          parameters: {
            offerer: SELLER, zone: ZERO_ADDR, zoneHash: ZERO32, orderType: 0,
            conduitKey: CANONICAL_CONDUIT,
            startTime: String(Math.floor(Date.now() / 1000)),
            endTime: String(Math.floor(Date.now() / 1000) + 86400),
            salt: "0x1", totalOriginalConsiderationItems: 1,
            offer: [{ itemType: 2, token: NAKAMIGOS, identifierOrCriteria: "5", startAmount: "1", endAmount: "1" }],
            consideration: [{
              itemType: 0, token: ZERO_ADDR, identifierOrCriteria: "0",
              startAmount: "1000000000000000000", endAmount: "1000000000000000000", recipient: SELLER,
            }],
          },
          signature: "0x" + "c".repeat(130),
          seaportSignature: "0x" + "c".repeat(130),
          seaportOrderHash: "0x" + "b".repeat(64),
          seaportCounter: "0",
          protocol_address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
        },
      },
    }, res);
    expect(calls.status).toBe(409);
    expect(calls.json.error).toMatch(/bundle/i);
    // The bundle must survive — refusing beats silently deleting an assembled package.
    expect(updates.map((u) => u.hash)).not.toContain("0xbundle");
  });
});

describe("orderbook query — seller's own view is never served from a shared cache", () => {
  let handler;
  beforeEach(async () => {
    vi.resetModules();
    selectRows = []; updates = []; inserted = [];
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.NODE_ENV = "test";
    handler = (await import("../orderbook.js")).default;
  });

  // A stale hit shows an order the seller just cancelled; the Cancel button on it sends
  // a second on-chain cancel that burns gas for nothing.
  it("sets no-store for a maker-scoped query", async () => {
    const { res } = makeRes();
    await handler({ method: "GET", body: {}, headers: { origin: "https://nakamigos.gallery" },
      query: { action: "query", contract: NAKAMIGOS, maker: SELLER, status: "active" } }, res);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("still caches the public listings feed", async () => {
    const { res } = makeRes();
    await handler({ method: "GET", body: {}, headers: { origin: "https://nakamigos.gallery" },
      query: { action: "query", contract: NAKAMIGOS, status: "active" } }, res);
    expect(res.headers["Cache-Control"]).toMatch(/s-maxage/);
  });
});
