// SECURITY REGRESSION TESTS — /api/orderbook must never hand out a live fill
// capability for an order that is no longer active.
//
// A signed Seaport order is a BEARER CAPABILITY: `parameters` + `signature` are
// the complete input to Seaport.fulfillOrder / fulfillAdvancedOrder. Cancelling
// a row in OUR database does NOT invalidate that signature on-chain — it stays
// fillable until endTime or an explicit on-chain cancel / counter bump, which
// the app calls "soft cancel" and never performs automatically.
//
// The read path is public: `GET /api/orderbook?action=query&status=cancelled`
// and `?action=trade-query&status=cancelled` take no cookie and were served by
// `.select("*")`. That let a stranger enumerate superseded listings, lift the
// old signature, and fill at the OLD (pre-relist) price — a direct money loss
// for the seller who relisted higher.
//
// The invariant pinned here is capability-shaped, not string-shaped:
//   a row the API reports as anything other than "active" MUST NOT carry the
//   two fields that together constitute a fill.
// Active rows MUST still carry them (buy / accept / on-chain-cancel need them),
// so the breadth is asserted in BOTH directions.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock("viem", () => ({ recoverMessageAddress: vi.fn(async () => "0x" + "a".repeat(40)) }));

const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";

// The two fields that together are a fill capability.
const CAPABILITY_FIELDS = ["signature", "parameters"];

const SIG = "0x" + "ab".repeat(65);
const PARAMS = { offerer: "0x" + "1".repeat(40), offer: [], consideration: [], endTime: "9999999999" };

function nativeRow(status, extra = {}) {
  return {
    order_hash: "0x" + status.padEnd(64, "0"),
    order_type: "listing",
    contract_address: NAKAMIGOS,
    token_id: "42",
    maker: "0x" + "1".repeat(40),
    price_eth: 1.5,
    status,
    signature: SIG,
    parameters: PARAMS,
    protocol_address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
    ...extra,
  };
}

function tradeRow(status, extra = {}) {
  return {
    id: `id-${status}`,
    offerer: "0x" + "1".repeat(40),
    target_owner: "0x" + "2".repeat(40),
    status,
    offered: [],
    requested: [],
    eth_topup_wei: "0",
    weth_topup_wei: "0",
    signature: SIG,
    parameters: PARAMS,
    protocol_address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
    ...extra,
  };
}

// Chainable supabase mock resolving to a fixed row set.
let rowsToReturn = [];
function makeQueryResult() {
  const chain = {
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    or: vi.fn(() => chain),
    gt: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: rowsToReturn[0] || null, error: null })),
    maybeSingle: vi.fn(async () => ({ data: rowsToReturn[0] || null, error: null })),
    then: (resolve) => resolve({ data: rowsToReturn, error: null, count: rowsToReturn.length }),
  };
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: () => makeQueryResult() })),
}));

function makeReq(query) {
  return { method: "GET", body: {}, query, headers: { origin: "https://memetic.fun" } };
}
function makeRes() {
  const jsonSpy = vi.fn();
  const statusSpy = vi.fn();
  const res = {
    setHeader: () => res,
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    end: vi.fn(),
  };
  return { res, jsonSpy, statusSpy };
}

let handler;
beforeEach(async () => {
  vi.resetModules();
  rowsToReturn = [];
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-role";
  process.env.NODE_ENV = "test";
  delete process.env.BUNDLE_LISTING_ENABLED;
  handler = (await import("../orderbook.js")).default;
});

/** Every field that is NOT part of the fill capability must survive. */
function expectCapabilityStripped(served, source) {
  for (const f of CAPABILITY_FIELDS) {
    expect(Object.prototype.hasOwnProperty.call(served, f)).toBe(false);
  }
  for (const k of Object.keys(source)) {
    if (CAPABILITY_FIELDS.includes(k)) continue;
    expect(served).toHaveProperty(k);
  }
}

describe("native listings (action=query) — fill capability is active-only", () => {
  for (const status of ["cancelled", "filled"]) {
    it(`does not serve a fill capability for status=${status}`, async () => {
      const row = nativeRow(status);
      rowsToReturn = [row];
      const { res, jsonSpy } = makeRes();
      await handler(makeReq({ action: "query", contract: NAKAMIGOS, status }), res);
      const payload = jsonSpy.mock.calls.at(-1)[0];
      expect(payload.orders).toHaveLength(1);
      expect(payload.orders[0].status).toBe(status);
      expectCapabilityStripped(payload.orders[0], row);
    });
  }

  it("STILL serves parameters+signature for active rows (buy/cancel need them)", async () => {
    rowsToReturn = [nativeRow("active")];
    const { res, jsonSpy } = makeRes();
    await handler(makeReq({ action: "query", contract: NAKAMIGOS, status: "active" }), res);
    const payload = jsonSpy.mock.calls.at(-1)[0];
    expect(payload.orders[0].signature).toBe(SIG);
    expect(payload.orders[0].parameters).toEqual(PARAMS);
  });

  it("redacts per-row, not per-request — a stale non-active row in an active result set is still stripped", async () => {
    rowsToReturn = [nativeRow("active"), nativeRow("cancelled")];
    const { res, jsonSpy } = makeRes();
    await handler(makeReq({ action: "query", contract: NAKAMIGOS, status: "active" }), res);
    const payload = jsonSpy.mock.calls.at(-1)[0];
    expect(payload.orders[0].signature).toBe(SIG);
    expect(payload.orders[1].signature).toBeUndefined();
    expect(payload.orders[1].parameters).toBeUndefined();
  });
});

describe("P2P trades (action=trade-query) — fill capability is active-only", () => {
  for (const status of ["cancelled", "declined", "countered", "accepted"]) {
    it(`does not serve a fill capability for status=${status}`, async () => {
      const row = tradeRow(status);
      rowsToReturn = [row];
      const { res, jsonSpy } = makeRes();
      await handler(
        makeReq({ action: "trade-query", role: "incoming", wallet: "0x" + "2".repeat(40), status }),
        res,
      );
      const payload = jsonSpy.mock.calls.at(-1)[0];
      expect(payload.trades).toHaveLength(1);
      expectCapabilityStripped(payload.trades[0], row);
    });
  }

  it("STILL serves parameters+signature for active trades (accept needs them)", async () => {
    rowsToReturn = [tradeRow("active", { expires_at: new Date(Date.now() + 3600_000).toISOString() })];
    const { res, jsonSpy } = makeRes();
    await handler(
      makeReq({ action: "trade-query", role: "incoming", wallet: "0x" + "2".repeat(40), status: "active" }),
      res,
    );
    const payload = jsonSpy.mock.calls.at(-1)[0];
    expect(payload.trades[0].signature).toBe(SIG);
    expect(payload.trades[0].parameters).toEqual(PARAMS);
  });

  it("strips a row the server itself relabels 'expired' (status is surfaced, not stored)", async () => {
    rowsToReturn = [tradeRow("active", { expires_at: new Date(Date.now() - 3600_000).toISOString() })];
    const { res, jsonSpy } = makeRes();
    await handler(
      makeReq({ action: "trade-query", role: "incoming", wallet: "0x" + "2".repeat(40), status: "all" }),
      res,
    );
    const payload = jsonSpy.mock.calls.at(-1)[0];
    expect(payload.trades[0].status).toBe("expired");
    expect(payload.trades[0].signature).toBeUndefined();
    expect(payload.trades[0].parameters).toBeUndefined();
  });

  it("public board reads leak nothing for non-active posts", async () => {
    const row = tradeRow("cancelled", { is_open: true });
    rowsToReturn = [row];
    const { res, jsonSpy } = makeRes();
    await handler(makeReq({ action: "trade-query", role: "board", status: "cancelled" }), res);
    const payload = jsonSpy.mock.calls.at(-1)[0];
    expectCapabilityStripped(payload.trades[0], row);
  });
});
