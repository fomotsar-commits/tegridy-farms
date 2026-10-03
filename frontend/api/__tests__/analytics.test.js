// Tests for /api/analytics — the first-party analytics sink.
//
// The privacy assertions here are the load-bearing ones. PrivacyPage §3 tells
// every visitor that event records "do NOT include your wallet address"; these
// pin that as behaviour rather than intention.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { analyticsRetentionCutoff } from "../_lib/errorPolicy.js";

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
  return { method, body, headers: { origin: "https://memetics.finance", ...headers } };
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

/** The backstop purge talks to PostgREST with fetch. Each call is recorded here, and no
 *  test in this file reaches the network. */
let purgeCalls = [];
let purgeReply = () => new Response(null, { status: 204, headers: { "Content-Range": "*/0" } });

beforeEach(() => {
  inserted.length = 0;
  insertError = null;
  purgeCalls = [];
  purgeReply = () => new Response(null, { status: 204, headers: { "Content-Range": "*/0" } });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    purgeCalls.push({ url: String(url), init });
    return purgeReply();
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
      body: { events: [EVENT({ properties: { payer: "11111111111111111111111111111112" } })] },
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

  // AUDIT TF-033. PrivacyPage §3 promises event records carry no wallet
  // address. The promise is about the RECORD, not about one column, and the
  // `event` name is a caller-supplied string stored verbatim — 64 chars is
  // room enough for any address. Pinned as behaviour because the properties-
  // only DB backstop cannot see this column at all.
  it("rejects an EVM address in the EVENT NAME, not just in properties", async () => {
    const { default: handler } = await load();
    const { res, out } = makeRes();
    await handler(makeReq({
      body: { events: [EVENT({ event: "buy:0x14898258122C0740106391E6e8E4F17F3b6d456E" })] },
    }), res);
    expect(out.payload.accepted).toBe(0);
    expect(out.payload.reasons["address-shaped-value"]).toBe(1);
    expect(inserted).toHaveLength(0);
  });

  // AUDIT TF-034. `properties` is caller-shaped, so nothing stops an address
  // being the KEY. Walking Object.values alone left that route wide open.
  it("rejects an address used as an object KEY", async () => {
    const { containsAddress } = await load();
    expect(containsAddress({ ["0x" + "a".repeat(40)]: 1 })).toBe(true);
  });

  it("rejects an address key nested under an ordinary key", async () => {
    const { default: handler } = await load();
    const { res, out } = makeRes();
    await handler(makeReq({
      body: { events: [EVENT({ properties: { holders: { ["0x" + "b".repeat(40)]: 3 } } })] },
    }), res);
    expect(out.payload.accepted).toBe(0);
    expect(out.payload.reasons["address-shaped-value"]).toBe(1);
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
    expect(containsAddress("  11111111111111111111111111111112  ")).toBe(true);
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

// Kept 90 days, then deleted automatically (owner, 2026-10-03). The hourly retention
// workflow is the main purge; this one, after a stored batch and at most once an hour per
// instance, keeps the promise when GitHub's scheduler is late or down.
describe("the backstop purge after a stored batch", () => {
  const NOW = Date.UTC(2027, 0, 20, 12);
  const HOUR = 60 * 60 * 1000;
  const post = async (handler, body = { events: [EVENT()] }) => {
    const { res, out } = makeRes();
    await handler(makeReq({ body }), res);
    return out;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("deletes events received more than 90 days ago, with the service key, on the configured project", async () => {
    const { default: handler } = await load();
    const out = await post(handler);
    expect(out.status).toBe(200);
    expect(purgeCalls).toHaveLength(1);
    const u = new URL(purgeCalls[0].url);
    expect(u.origin).toBe("https://example.supabase.co");
    expect(u.pathname).toBe("/rest/v1/analytics_events");
    expect([...u.searchParams.keys()]).toEqual(["received_at"]);
    expect(u.searchParams.get("received_at")).toBe(`lt.${analyticsRetentionCutoff(NOW)}`);
    expect(purgeCalls[0].init.method).toBe("DELETE");
    expect(purgeCalls[0].init.headers).toMatchObject({ apikey: "service-key", Authorization: "Bearer service-key" });
  });

  it("runs at most once an hour per instance", async () => {
    const { default: handler } = await load();
    await post(handler);
    await post(handler);
    vi.setSystemTime(NOW + HOUR - 1);
    await post(handler);
    expect(purgeCalls).toHaveLength(1);
    vi.setSystemTime(NOW + HOUR);
    await post(handler);
    expect(purgeCalls).toHaveLength(2);
    expect(new URL(purgeCalls[1].url).searchParams.get("received_at")).toBe(`lt.${analyticsRetentionCutoff(NOW + HOUR)}`);
  });

  it("a purge that is refused does not touch the answer to the browser, and logs no key", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    purgeReply = () => new Response(JSON.stringify({ code: "42501" }), { status: 403 });
    const { default: handler } = await load();
    const out = await post(handler);
    expect(out.status).toBe(200);
    expect(out.payload.accepted).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("service-key");
  });

  it("a purge that throws does not either", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    purgeReply = () => { throw new TypeError("fetch failed"); };
    const { default: handler } = await load();
    const out = await post(handler);
    expect(out.status).toBe(200);
    expect(out.payload.accepted).toBe(1);
  });

  it("does not run after a failed insert, or when nothing was stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: handler } = await load();
    insertError = { code: "PGRST205", message: "no table" };
    expect((await post(handler)).status).toBe(503);
    insertError = null;
    expect((await post(handler, { events: [EVENT({ event: "" })] })).payload.accepted).toBe(0);
    expect((await post(handler, { events: [] })).payload.accepted).toBe(0);
    expect(purgeCalls).toEqual([]);
  });
});
