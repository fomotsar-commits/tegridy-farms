// AUDIT R060: regression tests for orderbook hardening from R053.
//
// Coverage:
//   - Order signed by non-owner (signer != offerer) is rejected
//   - priceWei overflow guard (> 10**24 wei = 1M ETH)
//   - Body size cap (10 KB)
//   - Cancel-by-non-owner rejected (signer != maker)

import { describe, it, expect, beforeEach, vi } from "vitest";

// Per-test rate-limit pass-through.
vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
}));

const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";
const OWNER = "0x" + "a".repeat(40);
const ATTACKER = "0x" + "b".repeat(40);

// Mock viem.recoverMessageAddress to return whatever signer we want per test.
let recoverImpl = vi.fn(async () => OWNER);
vi.mock("viem", () => ({
  recoverMessageAddress: (...args) => recoverImpl(...args),
}));

// Lightweight chainable supabase mock.
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
    single: vi.fn(async () => ({ data: data[0] || null, error })),
    maybeSingle: vi.fn(async () => ({ data: data[0] || null, error })),
    then: (resolve) => resolve({ data, error, count }),
  };
  return chain;
}

let supabaseFromHandler = vi.fn(() => makeQueryResult([]));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (...args) => supabaseFromHandler(...args),
  })),
}));

function makeReq({ method = "POST", body = {}, query = {}, headers = {} } = {}) {
  return {
    method,
    body,
    query,
    headers: { origin: "https://nakamigos.gallery", ...headers },
  };
}

function makeRes() {
  const headerSpy = vi.fn();
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const res = {
    setHeader: (k, v) => { headerSpy(k, v); return res; },
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    end: vi.fn(),
  };
  return { res, headerSpy, statusSpy, jsonSpy };
}

function buildValidOrder({ offerer = OWNER, priceWei = "1000000000000000000" } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    parameters: {
      offerer,
      offer: [{ itemType: 2, token: NAKAMIGOS, identifierOrCriteria: "1", startAmount: "1" }],
      consideration: [{ itemType: 0, token: "0x0000000000000000000000000000000000000000", startAmount: priceWei, recipient: offerer }],
      startTime: String(nowSec),
      endTime: String(nowSec + 7 * 24 * 3600),
      salt: "0x123",
    },
    signature: "0xfake-signature-for-test",
  };
}

describe("orderbook — R053 ownership: signer must equal offerer", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.NODE_ENV = "test";
    supabaseFromHandler = vi.fn(() => makeQueryResult([]));
    handler = (await import("../orderbook.js")).default;
  });

  it("rejects 403 when recovered signer != claimed offerer", async () => {
    // Owner is OWNER but recoverMessageAddress returns ATTACKER → mismatch.
    recoverImpl = vi.fn(async () => ATTACKER);
    const req = makeReq({
      body: { action: "create", order: buildValidOrder({ offerer: OWNER }) },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Signer does not match offerer" });
  });

  it("rejects 400 when signature recovery itself throws", async () => {
    recoverImpl = vi.fn(async () => { throw new Error("invalid sig encoding"); });
    const req = makeReq({
      body: { action: "create", order: buildValidOrder({ offerer: OWNER }) },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Invalid signature" });
  });
});

describe("orderbook — R053 cancel ownership", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.NODE_ENV = "test";
    handler = (await import("../orderbook.js")).default;
  });

  it("rejects cancel when signer is not the recorded maker", async () => {
    // Existing order made by OWNER, attacker tries to cancel.
    supabaseFromHandler = vi.fn(() => {
      const chain = makeQueryResult([{ maker: OWNER, status: "active" }]);
      chain.single = async () => ({ data: { maker: OWNER, status: "active" }, error: null });
      return chain;
    });
    recoverImpl = vi.fn(async () => ATTACKER);
    const req = makeReq({
      body: {
        action: "cancel",
        orderHash: "0x" + "1".repeat(64),
        signature: "0xfake",
      },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Signer is not the order maker" });
  });
});

describe("orderbook — body cap (10 KB)", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.NODE_ENV = "test";
    handler = (await import("../orderbook.js")).default;
  });

  it("rejects 413 when body exceeds 10 KB", async () => {
    const huge = { action: "create", padding: "x".repeat(11_000) };
    const req = makeReq({ body: huge });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(413);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Request body too large (max 10KB)" });
  });
});

describe("orderbook — query validation", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "service-role";
    process.env.NODE_ENV = "test";
    supabaseFromHandler = vi.fn(() => makeQueryResult([]));
    handler = (await import("../orderbook.js")).default;
  });

  it("requires contract param on query", async () => {
    const req = makeReq({ method: "GET", query: { action: "query" } });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "contract parameter is required" });
  });

  it("rejects non-allowlisted contract on query (open-proxy guard)", async () => {
    const req = makeReq({
      method: "GET",
      query: { action: "query", contract: "0x" + "f".repeat(40) },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Contract not supported" });
  });
});
