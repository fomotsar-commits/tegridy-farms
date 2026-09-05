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
// `selectError` forces the SELECT to fail, so we can prove the overlap guard fails CLOSED.
// `gtCalls` records end_time predicates so we can prove expired rows are excluded.
let selectError = null;
let updateError = null;
let gtCalls = [];
function makeChain(table) {
  const chain = {
    _isUpdate: false,
    insert: vi.fn((row) => { inserted.push({ table, row }); return chain; }),
    update: vi.fn((patch) => { chain._isUpdate = true; chain._patch = patch; return chain; }),
    // A head:true COUNT read and a row SELECT resolve differently, and the guards that
    // consume them fail closed independently — so the mock has to be able to break one
    // without breaking the other. `selectError` breaks the row read (the overlap scan);
    // count reads are answered separately in `then`.
    select: vi.fn((_cols, opts) => { chain._isCount = opts?.head === true; return chain; }),
    eq: vi.fn((col, val) => {
      if (chain._isUpdate && col === "order_hash") updates.push({ hash: val, patch: chain._patch });
      return chain;
    }),
    gt: vi.fn((col, val) => { gtCalls.push([col, val]); return chain; }),
    gte: vi.fn(() => chain),
    order: vi.fn(() => chain), limit: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: selectRows[0] || null, error: null })),
    maybeSingle: vi.fn(async () => ({ data: selectRows[0] || null, error: null })),
    then: (resolve) => {
      if (chain._isUpdate && updateError) return resolve({ data: null, error: updateError });
      // The 20/hr throttle is a COUNT read and it now fails closed too. Keep it healthy
      // here, or `selectError` would be answered by the throttle's 503 and the
      // "FAILS CLOSED when the overlap query errors" test below would pass without ever
      // reaching the overlap guard it names.
      if (chain._isCount) return resolve({ data: null, error: null, count: selectRows.length });
      return resolve(
        selectError
          ? { data: null, error: selectError, count: null }
          : { data: selectRows, error: null, count: selectRows.length },
      );
    },
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
    headers: { origin: "https://memetic.fun" },
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
    selectRows = []; updates = []; inserted = []; selectError = null; updateError = null; gtCalls = [];
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

  // AUDIT TF-021. Seaport interpolates every consideration item linearly from
  // startAmount to endAmount across [startTime, endTime]. This orderbook derives
  // the price it DISPLAYS and STORES from startAmount alone, so a hand-crafted
  // order listing at 0.01 and ending at 100 would show "0.01" and charge the
  // curve. One price field means one price.
  it("rejects a consideration whose price decays (startAmount != endAmount)", async () => {
    const c = await postBundle(handler, bundleParams([1, 2], {
      consideration: [{
        itemType: 0, token: ZERO_ADDR, identifierOrCriteria: "0",
        startAmount: "10000000000000000",      // lists as 0.01 ETH
        endAmount: "100000000000000000000",    // actually charges up to 100 ETH
        recipient: SELLER,
      }],
    }));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/fixed price/i);
  });

  it("rejects an offer whose quantity decays", async () => {
    const c = await postBundle(handler, bundleParams([1, 2], {
      offer: [
        { itemType: 2, token: NAKAMIGOS, identifierOrCriteria: "1", startAmount: "1", endAmount: "1" },
        { itemType: 2, token: NAKAMIGOS, identifierOrCriteria: "2", startAmount: "1", endAmount: "5" },
      ],
    }));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/fixed quantity/i);
  });

  it("still accepts an ordinary fixed-price listing", async () => {
    // Non-vacuity: the guard must not have closed the normal path.
    const c = await postBundle(handler, bundleParams([1, 2]));
    expect(c.status).not.toBe(400);
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
    selectRows = []; updates = []; inserted = []; selectError = null; updateError = null; gtCalls = [];
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

  // INVERTED 2026-08-12. This test used to assert the auto-cancel, i.e. it PINNED the
  // vulnerability: "cancelling" a single was a database UPDATE and nothing more. The
  // server has no maker signer and no client path called cancelSeaportOrder, so the
  // superseded order stayed fillable on Seaport at its old price while the UI showed it
  // as gone. Seller lists at 1 ETH, bundles it at 2, and anyone holding the old
  // signature buys at 1.
  //
  // The invariant now: no code path may mark a Seaport order dead in the database
  // unless it has been invalidated ON-CHAIN first. Since the server cannot do that, it
  // refuses — the same trade the bundle-vs-bundle branch already made.
  it("refuses, and cancels NOTHING, when a bundle overlaps the seller's own single listing", async () => {
    selectRows = [{ order_hash: "0xsingle", token_id: "2", is_bundle: false, token_ids: null }];
    const c = await postBundle(handler, bundleParams([1, 2]));
    expect(c.status).toBe(409);
    expect(c.json.conflictingOrders).toContain("0xsingle");
    // The load-bearing half: a DB-only cancel must never happen. Asserting the 409 alone
    // would still pass on a version that refused AND cancelled.
    expect(updates).toHaveLength(0);
    expect(inserted).toHaveLength(0);
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
      headers: { origin: "https://memetic.fun" },
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

describe("orderbook create — a refused request must not mutate", () => {
  let handler;
  beforeEach(async () => {
    vi.resetModules();
    selectRows = []; updates = []; inserted = []; selectError = null; updateError = null; gtCalls = [];
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.BUNDLE_LISTING_ENABLED = "true";
    process.env.NODE_ENV = "test";
    handler = (await import("../orderbook.js")).default;
  });

  function singleParams(tokenId, overrides = {}) {
    return {
      offerer: SELLER, zone: ZERO_ADDR, zoneHash: ZERO32, orderType: 0,
      conduitKey: CANONICAL_CONDUIT,
      startTime: String(Math.floor(Date.now() / 1000)),
      endTime: String(Math.floor(Date.now() / 1000) + 86400),
      salt: "0x1", totalOriginalConsiderationItems: 1,
      offer: [{ itemType: 2, token: NAKAMIGOS, identifierOrCriteria: String(tokenId), startAmount: "1", endAmount: "1" }],
      consideration: [{
        itemType: 0, token: ZERO_ADDR, identifierOrCriteria: "0",
        startAmount: "1000000000000000000", endAmount: "1000000000000000000", recipient: SELLER,
      }],
      ...overrides,
    };
  }
  async function postSingle(params) {
    const { res, calls } = makeRes();
    await handler({
      method: "POST", headers: { origin: "https://memetic.fun" }, query: {},
      body: {
        action: "create",
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

  // The cancel used to run BEFORE the 409, so a request the server then refused had
  // already destroyed the seller's prior listing. A 4xx must leave no side effects.
  it("does not cancel the overlapping single when the request is refused with 409", async () => {
    selectRows = [
      { order_hash: "0xsingle", token_id: "5", is_bundle: false, token_ids: null },
      { order_hash: "0xbundle", token_id: null, is_bundle: true, token_ids: [{ contract: NAKAMIGOS, token_id: "5" }] },
    ];
    const c = await postSingle(singleParams(5));
    expect(c.status).toBe(409);
    expect(updates).toHaveLength(0); // nothing cancelled on a refused request
  });

  // Same attack the bundle path pins against, on the path already serving production.
  it("pins the order shape on the single-listing path too", async () => {
    const c = await postSingle(singleParams(5, { zone: "0x" + "9".repeat(40) }));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/zero zone/i);
  });

  it("accepts the shape the live single-listing client signs", async () => {
    const c = await postSingle(singleParams(5));
    expect(c.status).not.toBe(400);
  });
});

describe("orderbook overlap guard — the ways it could silently not work", () => {
  let handler;
  beforeEach(async () => {
    vi.resetModules();
    selectRows = []; updates = []; inserted = []; selectError = null; updateError = null; gtCalls = [];
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.BUNDLE_LISTING_ENABLED = "true";
    process.env.NODE_ENV = "test";
    handler = (await import("../orderbook.js")).default;
  });

  // Nothing transitions status off 'active' at expiry — the read path only FILTERS on
  // end_time. Without an expiry predicate here, every bundle ever created would
  // permanently brick relisting of its NFTs once it aged out, while being invisible in
  // My Listings. A guard that can never be satisfied is worse than no guard.
  it("excludes expired rows from the overlap scan", async () => {
    await postBundle(handler, bundleParams([1, 2]));
    const endTimeGuard = gtCalls.find(([col]) => col === "end_time");
    expect(endTimeGuard, "overlap scan must filter on end_time").toBeTruthy();
    expect(new Date(endTimeGuard[1]).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  // Every downstream gate BigInt-coerces, so "5" and "05" are the same on-chain token and
  // produce the same Seaport digest — but as raw strings they were different overlap keys.
  // A hand-crafted POST could use that to keep two live orders over one NFT.
  it("matches a stored non-canonical token_id against a canonical bundle key", async () => {
    selectRows = [{ order_hash: "0xsingle", token_id: "005", is_bundle: false, token_ids: null }];
    const c = await postBundle(handler, bundleParams([5, 9]));
    // This used to prove the key matched by observing the auto-cancel. That cancel was
    // DB-only and is gone (see orderbook.js), so the overlap now surfaces as a refusal —
    // which proves the same thing: "005" was recognised as token 5.
    expect(c.status).toBe(409);
    expect(c.json.conflictingOrders).toContain("0xsingle"); // matched despite "005" vs "5"
    expect(updates).toHaveLength(0);
  });

  it("matches a non-canonical incoming tokenId against a stored canonical bundle", async () => {
    selectRows = [{
      order_hash: "0xbundle", token_id: null, is_bundle: true,
      token_ids: [{ contract: NAKAMIGOS, token_id: "7" }],
    }];
    const c = await postBundle(handler, bundleParams(["007", 9]));
    expect(c.status).toBe(409);
  });

  it("treats leading-zero duplicates within one bundle as duplicates", async () => {
    const c = await postBundle(handler, bundleParams([5, "05"]));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/duplicate/i);
  });

  it("rejects a non-numeric tokenId rather than keying on it", async () => {
    const c = await postBundle(handler, bundleParams(["0x5", 9]));
    expect(c.status).toBe(400);
  });

  // This is the only control stopping two live orders over one NFT. On a paused or
  // rate-limited database it used to read as "nothing overlaps" and insert anyway.
  it("FAILS CLOSED when the overlap query errors — never inserts blind", async () => {
    selectError = { message: "connection terminated" };
    const c = await postBundle(handler, bundleParams([1, 2]));
    expect(c.status).toBe(503);
    expect(inserted).toHaveLength(0);
  });
});

describe("orderbook — round-3 blockers", () => {
  let handler;
  beforeEach(async () => {
    vi.resetModules();
    selectRows = []; updates = []; inserted = []; selectError = null; updateError = null; gtCalls = [];
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.BUNDLE_LISTING_ENABLED = "true";
    process.env.NODE_ENV = "test";
    handler = (await import("../orderbook.js")).default;
  });

  function singleOrder(overrides = {}, offerOverrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    return {
      offerer: SELLER, zone: ZERO_ADDR, zoneHash: ZERO32, orderType: 0,
      conduitKey: CANONICAL_CONDUIT,
      startTime: String(now), endTime: String(now + 86400),
      salt: "0x1", totalOriginalConsiderationItems: 1,
      offer: [{ itemType: 2, token: NAKAMIGOS, identifierOrCriteria: "5", startAmount: "1", endAmount: "1", ...offerOverrides }],
      consideration: [{
        itemType: 0, token: ZERO_ADDR, identifierOrCriteria: "0",
        startAmount: "1000000000000000000", endAmount: "1000000000000000000", recipient: SELLER,
      }],
      ...overrides,
    };
  }
  async function post(action, parameters) {
    const { res, calls } = makeRes();
    await handler({
      method: "POST", headers: { origin: "https://memetic.fun" }, query: {},
      body: {
        action,
        order: {
          parameters,
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

  // itemType 3 (ERC1155) slipped past `isListing = itemType >= 2`, and the ownership
  // check RETURNED OK for anything that wasn't ERC721 — so one changed integer stored a
  // listing for an NFT the poster does not own, rendered with a live Buy button.
  it("refuses an ERC1155 listing instead of skipping the ownership check", async () => {
    const c = await post("create", singleOrder({}, { itemType: 3 }));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/ERC721/i);
    expect(inserted).toHaveLength(0);
  });

  // Every rejection downstream of the cancel used to destroy the seller's prior listing
  // before refusing. The cancel now runs immediately before the insert.
  it("does not cancel the prior listing when a later validation rejects", async () => {
    selectRows = [{ order_hash: "0xprior", token_id: "5", is_bundle: false, token_ids: null }];
    // An unsupported protocol address rejects AFTER the overlap check.
    const { res, calls } = makeRes();
    await handler({
      method: "POST", headers: { origin: "https://memetic.fun" }, query: {},
      body: {
        action: "create",
        order: {
          parameters: singleOrder(),
          signature: "0x" + "c".repeat(130),
          seaportSignature: "0x" + "c".repeat(130),
          seaportOrderHash: "0x" + "b".repeat(64),
          seaportCounter: "0",
          protocol_address: "0x" + "9".repeat(40), // foreign target → 400, late
        },
      },
    }, res);
    expect(calls.status).toBe(400);
    expect(updates).toHaveLength(0); // prior listing survived the refusal
  });

  // An unbounded endTime threw an uncaught RangeError at the insert, after the cancel.
  it("rejects an absurd endTime instead of crashing at the insert", async () => {
    const now = Math.floor(Date.now() / 1000);
    const c = await post("create", singleOrder({ endTime: String(9e12) }));
    expect(c.status).toBe(400);
    expect(c.json.error).toMatch(/duration/i);
    void now;
  });

  // The guard had a read half and a write half. The write half — a DB-only "cancel" of
  // the superseded order — is DELETED, because it marked an order dead in the database
  // while leaving it fillable on Seaport at its old price. So the invariant is no longer
  // "the cancel fails closed"; it is that NO code path marks a Seaport order dead in the
  // database unless it was invalidated on-chain first. The server cannot do that, so it
  // refuses.
  //
  // Note what this asserts beyond the status: ZERO updates and ZERO inserts. A version
  // that refused AND still wrote the cancel would pass a status-only check.
  it("refuses a relist rather than DB-cancelling an order that is still live on-chain", async () => {
    selectRows = [{ order_hash: "0xprior", token_id: "5", is_bundle: false, token_ids: null }];
    const c = await post("create", singleOrder());
    expect(c.status).toBe(409);
    expect(c.json.conflictingOrders).toContain("0xprior");
    expect(updates).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  // A truncated scan reads as "no overlap" — the unsafe direction. Saturation must refuse.
  it("refuses when the overlap scan saturates rather than guessing", async () => {
    selectRows = Array.from({ length: 501 }, (_, i) => ({
      order_hash: `0x${i}`, token_id: String(100000 + i), is_bundle: false, token_ids: null,
    }));
    const c = await post("create", singleOrder());
    expect(c.status).toBe(503);
    expect(inserted).toHaveLength(0);
  });
});

describe("orderbook query — seller's own view is never served from a shared cache", () => {
  let handler;
  beforeEach(async () => {
    vi.resetModules();
    selectRows = []; updates = []; inserted = []; selectError = null; updateError = null; gtCalls = [];
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.NODE_ENV = "test";
    handler = (await import("../orderbook.js")).default;
  });

  // A stale hit shows an order the seller just cancelled; the Cancel button on it sends
  // a second on-chain cancel that burns gas for nothing.
  it("sets no-store for a maker-scoped query", async () => {
    const { res } = makeRes();
    await handler({ method: "GET", body: {}, headers: { origin: "https://memetic.fun" },
      query: { action: "query", contract: NAKAMIGOS, maker: SELLER, status: "active" } }, res);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("still caches the public listings feed", async () => {
    const { res } = makeRes();
    await handler({ method: "GET", body: {}, headers: { origin: "https://memetic.fun" },
      query: { action: "query", contract: NAKAMIGOS, status: "active" } }, res);
    expect(res.headers["Cache-Control"]).toMatch(/s-maxage/);
  });
});
