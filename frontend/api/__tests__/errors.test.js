// api/errors.js — the sink that makes errorReporting.ts work.
//
// The route exists because the client was finished and had nowhere to POST.
// These tests pin the three ways a route copied verbatim from analytics.js
// would have rejected 100% of real traffic (envelope, fields, timestamp type),
// and the two rules this route deliberately does NOT share with analytics:
// an oversize batch is truncated rather than 413'd, and an address-shaped
// value is redacted rather than dropping the whole record. Both exist because
// nothing replays `tegridy_error_log` — a 4xx here is permanent loss.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

let inserted = null;
let insertError = null;
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      insert: async (rows) => {
        inserted = rows;
        return { error: insertError };
      },
    }),
  })),
}));

const ORIGIN = "https://memetics.finance";

function makeReq(body, origin = ORIGIN) {
  return { method: "POST", body, headers: { origin } };
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
const payload = (s) => s.jsonSpy.mock.calls.at(-1)[0];

/** Exactly what errorReporting.ts's flush() puts on the wire today. */
function clientEntry(over = {}) {
  return {
    message: "TypeError: x is not a function",
    stack: "at foo (app-abc123.js:1:2)",
    timestamp: 1757030000000, // Date.now() — a NUMBER, not an ISO string
    url: "https://memetics.finance/farm",
    ...over,
  };
}

let handler;
beforeEach(async () => {
  vi.resetModules();
  inserted = null;
  insertError = null;
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-role";
  handler = (await import("../errors.js")).default;
});

describe("errors — accepts what the client actually sends", () => {
  it("takes a BARE ARRAY, the shape flush() posts today", async () => {
    // analytics.js requires { events: [...] }. A route copied from it would
    // 400 every real batch, and nothing replays the buffer, so they'd be gone.
    const s = makeRes();
    await handler(makeReq([clientEntry()]), s.res);
    expect(s.statusSpy).toHaveBeenCalledWith(200);
    expect(payload(s).accepted).toBe(1);
  });

  it("also takes { errors: [...] } so a future client need not stay bare", async () => {
    const s = makeRes();
    await handler(makeReq({ errors: [clientEntry()] }), s.res);
    expect(payload(s).accepted).toBe(1);
  });

  it("accepts a NUMERIC timestamp — the client sends Date.now()", async () => {
    // analytics's validateEvent does `typeof timestamp === 'string' ? ... : NaN`,
    // so every real entry would have failed bad-timestamp even after the
    // envelope was fixed.
    const s = makeRes();
    await handler(makeReq([clientEntry({ timestamp: 1757030000000 })]), s.res);
    expect(payload(s).accepted).toBe(1);
    expect(inserted[0].occurred_at).toBe(new Date(1757030000000).toISOString());
  });

  it("accepts an ISO timestamp too, so either client generation works", async () => {
    const s = makeRes();
    await handler(makeReq([clientEntry({ timestamp: "2026-09-04T12:00:00.000Z" })]), s.res);
    expect(payload(s).accepted).toBe(1);
  });

  it("needs no event name or session id — ErrorEntry has neither", async () => {
    const s = makeRes();
    await handler(makeReq([clientEntry()]), s.res);
    expect(payload(s).accepted).toBe(1);
    expect(inserted[0]).not.toHaveProperty("session_id");
    expect(inserted[0]).not.toHaveProperty("event");
  });
});

describe("errors — an oversize batch is truncated, never 413'd", () => {
  it("stores what fits and reports the remainder", async () => {
    // The client has NO batch cap: MAX_BUFFER=50 bounds only the localStorage
    // merge, while batch.push() is unbounded. A crash loop legitimately makes
    // a batch of hundreds, which is when the data matters most.
    const s = makeRes();
    await handler(makeReq(Array.from({ length: 130 }, () => clientEntry())), s.res);
    expect(s.statusSpy).toHaveBeenCalledWith(200);
    expect(s.statusSpy).not.toHaveBeenCalledWith(413);
    expect(payload(s).accepted).toBe(100);
    expect(payload(s).reasons["batch-truncated"]).toBe(30);
    expect(inserted).toHaveLength(100);
  });
});

describe("errors — address-shaped values are redacted, not dropped", () => {
  it("keeps the stack and blanks only the offending field", async () => {
    // The likeliest carrier is the URL PATH: sanitizeUrl() clears search and
    // hash but never scrubs the path, and App.tsx routes include read/:address.
    const addr = "0x" + "a".repeat(40);
    const s = makeRes();
    await handler(makeReq([clientEntry({ url: `https://memetics.finance/read/${addr}` })]), s.res);

    expect(payload(s).accepted).toBe(1);
    expect(inserted[0].url).not.toContain(addr);
    // The record survives — dropping a stack trace over a substring in the URL
    // would throw away the thing we came for.
    expect(inserted[0].stack).toBe("at foo (app-abc123.js:1:2)");
    expect(inserted[0].message).toBe("TypeError: x is not a function");
  });

  it("redacts an address embedded mid-message", async () => {
    const s = makeRes();
    await handler(makeReq([clientEntry({ message: `failed for 0x${"b".repeat(40)} on call` })]), s.res);
    expect(payload(s).accepted).toBe(1);
    expect(inserted[0].message).not.toMatch(/0x[a-fA-F0-9]{40}/);
  });

  it("no row ever reaches the table carrying a 40-hex address", async () => {
    // The property the DB CHECK also enforces. Asserted here so a future
    // refactor of the redactor is caught before the insert raises in prod.
    const s = makeRes();
    await handler(makeReq([
      clientEntry({ message: `0x${"c".repeat(40)}` }),
      clientEntry({ stack: `at f (0x${"d".repeat(40)})` }),
      clientEntry({ componentStack: `in C (0x${"e".repeat(40)})` }),
    ]), s.res);
    const serialised = JSON.stringify(inserted);
    expect(serialised).not.toMatch(/0x[a-fA-F0-9]{40}/);
    expect(inserted).toHaveLength(3);
  });
});

describe("errors — refusals", () => {
  it("rejects a foreign origin", async () => {
    const s = makeRes();
    await handler(makeReq([clientEntry()], "https://evil.example"), s.res);
    expect(s.statusSpy).toHaveBeenCalledWith(403);
  });

  it("says so when the sink is unconfigured rather than 200-ing into the void", async () => {
    // A sink that reports success while storing nothing is the exact failure
    // this route was written to end.
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    vi.resetModules();
    const h = (await import("../errors.js")).default;
    const s = makeRes();
    await h(makeReq([clientEntry()]), s.res);
    expect(s.statusSpy).toHaveBeenCalledWith(503);
  });

  it("reports an insert failure as 503, not as success", async () => {
    insertError = { message: "connection refused" };
    const s = makeRes();
    await handler(makeReq([clientEntry()]), s.res);
    expect(s.statusSpy).toHaveBeenCalledWith(503);
  });

  it("does not leak upstream error text to the caller", async () => {
    insertError = { message: "FATAL: password authentication failed for user postgres" };
    const s = makeRes();
    await handler(makeReq([clientEntry()]), s.res);
    expect(JSON.stringify(payload(s))).not.toMatch(/password|postgres/i);
  });

  it("rejects a body that is not an error batch", async () => {
    const s = makeRes();
    await handler(makeReq({ nope: true }), s.res);
    expect(s.statusSpy).toHaveBeenCalledWith(400);
  });

  it("counts a malformed entry without losing its siblings", async () => {
    const s = makeRes();
    await handler(makeReq([clientEntry(), { message: 42 }, clientEntry()]), s.res);
    expect(payload(s).accepted).toBe(2);
    expect(payload(s).reasons["bad-message"]).toBe(1);
  });

  it("an empty batch is a no-op, not an error", async () => {
    const s = makeRes();
    await handler(makeReq([]), s.res);
    expect(s.statusSpy).toHaveBeenCalledWith(200);
    expect(payload(s).accepted).toBe(0);
  });
});
