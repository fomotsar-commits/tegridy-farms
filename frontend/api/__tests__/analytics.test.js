// Tests for /api/analytics — the first-party analytics sink.
//
// The privacy assertions here are the load-bearing ones. PrivacyPage §3 tells
// every visitor that event records "do NOT include your wallet address"; these
// pin that as behaviour rather than intention.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));

const inserted = [];
let insertError = null;
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: async (rows) => {
        if (insertError) return { error: insertError };
        inserted.push(...rows);
        return { error: null };
      },
    }),
  }),
}));

function makeReq({ method = "POST", body = {}, headers = {} } = {}) {
  return { method, body, headers: { origin: "https://memetic.fun", ...headers } };
}

function makeRes() {
  const out = { status: 0, payload: null, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[k] = v; return res; },
    status: (c) => { out.status = c; return res; },
    json: (p) => { out.payload = p; return res; },
    end: () => res,
  };
  return { res, out };
}

const EVENT = (over = {}) => ({
  event: "page_view",
  properties: { page: "home" },
  sessionId: "sess-abc123",
  timestamp: "2026-08-02T12:00:00.000Z",
  ...over,
});

async function load() {
  vi.resetModules();
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-key";
  return import("../analytics.js");
}

beforeEach(() => { inserted.length = 0; insertError = null; });

describe("privacy — no wallet address may be stored", () => {
  it("rejects an EVM address anywhere in properties", async () => {
    const { default: handler } = await load();
    const { res, out } = makeRes();
    await handler(makeReq({
      body: { events: [EVENT({ properties: { wallet: "0x14898258122C0740106391E6e8E4F17F3b6d456E" } })] },
    }), res);
    expect(out.status).toBe(200);
    expect(out.payload.accepted).toBe(0);
    expect(out.payload.reasons["address-shaped-value"]).toBe(1);
    expect(inserted).toHaveLength(0);
  });

  it("rejects a Solana pubkey as a whole value", async () => {
    const { default: handler } = await load();
    const { res, out } = makeRes();
    await handler(makeReq({
      body: { events: [EVENT({ properties: { payer: "GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd" } })] },
    }), res);
    expect(out.payload.accepted).toBe(0);
    expect(out.payload.reasons["address-shaped-value"]).toBe(1);
  });

  it("finds an address NESTED inside objects and arrays", async () => {
    const { default: handler } = await load();
    const { res, out } = makeRes();
    await handler(makeReq({
      body: { events: [EVENT({ properties: { a: { b: [{ c: "0x" + "a".repeat(40) }] } } })] },
    }), res);
    expect(out.payload.accepted).toBe(0);
  });

  it("does NOT reject ordinary long strings — the false positive that would break the sink", async () => {
    const { containsAddress } = await load();
    // 40 chars of base58-legal alphanumerics INSIDE a longer value. A substring
    // regex trips on this; the whole-value test must not. This is precisely the
    // case that made a base58 CHECK constraint unsafe in migration 013.
    expect(containsAddress("route=uniswapV3ThenCurveThenBalancerFallbackPath")).toBe(false);
    expect(containsAddress("nakamigos")).toBe(false);
    expect(containsAddress({ page: "/launch", route: "native" })).toBe(false);
  });

  it("still catches a bare pubkey with surrounding whitespace", async () => {
    const { containsAddress } = await load();
    expect(containsAddress("  GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd  ")).toBe(true);
  });

  it("is bounded against deeply nested hostile payloads", async () => {
    const { containsAddress } = await load();
    let deep = "0x" + "a".repeat(40);
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    // Bounded at depth 6 — it returns false rather than blowing the stack. The
    // database CHECK is the backstop for exactly this case.
    expect(() => containsAddress(deep)).not.toThrow();
  });
});

describe("gating", () => {
  it("refuses a non-allowlisted origin", async () => {
    const { default: handler } = await load();
    const { res, out } = makeRes();
    await handler(makeReq({ headers: { origin: "https://evil.example" }, body: { events: [EVENT()] } }), res);
    expect(out.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it("never sets Access-Control-Allow-Credentials", async () => {
    const { default: handler } = await load();
    const { res, out } = makeRes();
    await handler(makeReq({ body: { events: [EVENT()] } }), res);
    expect(out.headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("rejects non-POST", async () => {
    const { default: handler } = await load();
    const { res, out } = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(out.status).toBe(405);
  });
});

describe("validation + storage", () => {
  it("stores a well-formed event", async () => {
    const { default: handler } = await load();
    const { res, out } = makeRes();
    await handler(makeReq({ body: { events: [EVENT()] } }), res);
    expect(out.status).toBe(200);
    expect(out.payload.accepted).toBe(1);
    expect(inserted[0]).toMatchObject({
      event: "page_view",
      session_id: "sess-abc123",
      occurred_at: "2026-08-02T12:00:00.000Z",
    });
    // There must be no wallet column written, ever.
    expect(Object.keys(inserted[0])).not.toContain("wallet");
  });

  it("accepts the good events in a mixed batch and reports the rest", async () => {
    const { default: handler } = await load();
    const { res, out } = makeRes();
    await handler(makeReq({
      body: { events: [EVENT(), EVENT({ event: "" }), EVENT({ timestamp: "not-a-date" })] },
    }), res);
    expect(out.payload.accepted).toBe(1);
    expect(out.payload.rejected).toBe(2);
    expect(inserted).toHaveLength(1);
  });

  it("rejects an oversized batch rather than truncating it", async () => {
    const { default: handler } = await load();
    const { res, out } = makeRes();
    await handler(makeReq({ body: { events: Array.from({ length: 201 }, () => EVENT()) } }), res);
    expect(out.status).toBe(413);
  });

  it("503s when the sink is unconfigured — never a silent 200", async () => {
    vi.resetModules();
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    const { default: handler } = await import("../analytics.js");
    const { res, out } = makeRes();
    await handler(makeReq({ body: { events: [EVENT()] } }), res);
    expect(out.status).toBe(503);
  });

  it("503s on an insert failure so the client re-queues", async () => {
    const { default: handler } = await load();
    insertError = { message: "relation \"analytics_events\" does not exist" };
    const { res, out } = makeRes();
    await handler(makeReq({ body: { events: [EVENT()] } }), res);
    expect(out.status).toBe(503);
  });
});
