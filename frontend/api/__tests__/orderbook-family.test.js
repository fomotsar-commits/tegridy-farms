// The venue's own order book: Gold Cards can be listed and read here, and no
// family collection that the venue cannot settle can.
//
// Harness mirrors orderbook.test.js: Supabase and viem's signature recovery
// are mocked, so a create that passes the contract check goes on to the NEXT
// check (the signer), which is how a test can tell "admitted" from "refused"
// without a real signature.

import { describe, it, expect, beforeEach, vi } from "vitest";
// Warms the module graph at collection time. NOT dead code: the first re-import under
// `vi.resetModules()` below is a cold load of orderbook.js's graph, inside a `beforeEach`
// that vitest bounds at 10s, and it grows with machine load. Paid here, where no timeout
// runs, every re-import is a few ms. The resets stay: this instance is built before
// SUPABASE_* are set, so its client is null and only a re-import gets a live one.
import "../orderbook.js";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const OWNER = "0x" + "a".repeat(40);
const ATTACKER = "0x" + "b".repeat(40);
const GOLD = "0x6aa03f42c5366e2664c887eb2e90844ca00b92f3";
const VIEW_ONLY = {
  memes: "0x9edaba801123866f25993914e389924744a07e89",
  towelie: "0x2bcaad3cd618d0c0f87e153b3928e02bab757705",
  seeds: "0xb34bb1d81a4e5f9dca7360c3043ad50db2ea87f3",
  bojungles: "0x36afee4fadc3b77ff5f1f9a040e264150afb979a",
};

let recoverImpl = vi.fn(async () => ATTACKER);
vi.mock("viem", () => ({
  recoverMessageAddress: (...args) => recoverImpl(...args),
}));

function makeQueryResult(data = [], error = null, count = null) {
  const chain = {
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    gt: vi.fn(() => chain),
    gte: vi.fn(() => chain),
    lt: vi.fn(() => chain),
    or: vi.fn(() => chain),
    in: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    range: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: data[0] || null, error })),
    maybeSingle: vi.fn(async () => ({ data: data[0] || null, error })),
    then: (resolve) => resolve({ data, error, count }),
  };
  return chain;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: () => makeQueryResult([]) })),
}));

function makeReq({ method = "POST", body = {}, query = {}, headers = {} } = {}) {
  return { method, body, query, headers: { origin: "https://memetic.fun", ...headers } };
}

function makeRes() {
  const out = { status: null, json: null };
  const res = {
    setHeader: () => res,
    status: (c) => { out.status = c; return res; },
    json: (p) => { out.json = p; return res; },
    end: vi.fn(),
  };
  return { res, out };
}

function listing(token) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    parameters: {
      offerer: OWNER,
      offer: [{ itemType: 2, token, identifierOrCriteria: "1", startAmount: "1" }],
      consideration: [{ itemType: 0, token: "0x0000000000000000000000000000000000000000", startAmount: "1000000000000000000", recipient: OWNER }],
      startTime: String(nowSec),
      endTime: String(nowSec + 7 * 24 * 3600),
      salt: "0x123",
      conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
    },
    signature: "0xfake-signature-for-test",
  };
}

let handler;
beforeEach(async () => {
  vi.resetModules();
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-role";
  process.env.NODE_ENV = "test";
  recoverImpl = vi.fn(async () => ATTACKER);
  handler = (await import("../orderbook.js")).default;
});

describe("the listings feed", () => {
  it("serves Gold Cards", async () => {
    const { res, out } = makeRes();
    await handler(makeReq({ method: "GET", query: { action: "query", contract: GOLD } }), res);
    expect(out.status).toBe(200);
  });

  for (const [label, contract] of Object.entries(VIEW_ONLY)) {
    it(`refuses ${label} with 403`, async () => {
      const { res, out } = makeRes();
      await handler(makeReq({ method: "GET", query: { action: "query", contract } }), res);
      expect(out.status).toBe(403);
      expect(out.json).toEqual({ error: "Contract not supported" });
    });
  }
});

describe("creating a listing", () => {
  it("admits Gold Cards past the contract check (it then meets the signer check)", async () => {
    const { res, out } = makeRes();
    await handler(makeReq({ body: { action: "create", order: listing(GOLD) } }), res);
    expect(out.json).not.toEqual({ error: "Contract not supported" });
    expect(out.status).toBe(403);
    expect(out.json).toEqual({ error: "Signer does not match offerer" });
  });

  for (const [label, contract] of Object.entries(VIEW_ONLY)) {
    it(`refuses ${label} at the contract check`, async () => {
      const { res, out } = makeRes();
      await handler(makeReq({ body: { action: "create", order: listing(contract) } }), res);
      expect(out.status).toBe(403);
      expect(out.json).toEqual({ error: "Contract not supported" });
      expect(recoverImpl).not.toHaveBeenCalled();
    });
  }
});
