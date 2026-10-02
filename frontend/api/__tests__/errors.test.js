// api/errors.js, the sink that makes errorReporting.ts work.
//
// What these tests pin, in the order the route checks them:
//   1. ORIGIN. The allowlist is the analytics.js allowlist, character for character.
//   2. THE GAP. Until the operator has applied migration 026 and set the Upstash and
//      Supabase variables, the route answers 503 with a Retry-After, stores nothing,
//      never throws, logs once rather than per request, and says nothing about why.
//   3. CONSENT. Only a batch the client marked `consent: "granted"` is stored. A bare
//      array or any other value is refused whole.
//   4. SCRUB. Before a row is written: page URLs keep their host and route words only,
//      query values are masked, tokens are masked, email addresses, wallet addresses (EVM
//      and Solana) and long opaque strings are redacted, NULs and half surrogate pairs
//      cannot reach Postgres, and every field is cut to its column ceiling
//      AFTER the scrub, so a cut can never leave half an address behind.
//   5. RATE LIMITS. The per-IP limiter and the aggregate breaker are called with the
//      signatures ratelimit.js actually exports. errors.ratelimit.test.js runs the real
//      limiter.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkRateLimit, checkGlobalLimit } from "../_lib/ratelimit.js";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

let inserted = null;
let insertError = null;
let insertThrows = null;
let insertCalls = 0;
let createClientThrows = false;
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => {
    if (createClientThrows) throw new Error("Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL.");
    return {
      from: () => ({
        insert: async (rows) => {
          insertCalls += 1;
          if (insertThrows) throw insertThrows;
          inserted = rows;
          return { error: insertError };
        },
      }),
    };
  }),
}));

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://memetics.finance";
const SINK_UNAVAILABLE = { error: "Error sink unavailable" };

function makeReq(body, { origin = ORIGIN, ip = "203.0.113.7" } = {}) {
  return { method: "POST", body, headers: { origin, "x-real-ip": ip } };
}
function makeRes() {
  const s = { headers: {}, statusSpy: vi.fn(), jsonSpy: vi.fn() };
  s.res = {
    headersSent: false,
    setHeader: (k, v) => { s.headers[String(k).toLowerCase()] = v; return s.res; },
    status: (c) => { s.statusSpy(c); return s.res; },
    json: (p) => { s.jsonSpy(p); return s.res; },
    end: vi.fn(),
  };
  return s;
}
const payload = (s) => s.jsonSpy.mock.calls.at(-1)[0];
const status = (s) => s.statusSpy.mock.calls.at(-1)[0];

/** The envelope errorReporting.ts posts: consent stated, entries named. */
const consented = (errors) => ({ consent: "granted", errors });

/** One entry exactly as errorReporting.ts builds it. */
function clientEntry(over = {}) {
  return {
    message: "TypeError: x is not a function",
    stack: "at foo (app-abc123.js:1:2)",
    timestamp: Date.now() - 1000, // Date.now(), a NUMBER, not an ISO string
    url: "https://memetics.finance/farm",
    ...over,
  };
}

/** Post one consented entry and return the row that reached the table. */
async function storedRow(over) {
  const s = makeRes();
  await handler(makeReq(consented([clientEntry(over)])), s.res);
  expect(status(s)).toBe(200);
  expect(inserted).toHaveLength(1);
  return inserted[0];
}

// Fixtures are BUILT, never written out whole, so no line of this file is a
// credential-shaped literal for the repo's secret scanner to flag.
const EVM = "0x" + "ab".repeat(20);
const MINT = "Mint" + "9".repeat(40); // 44 base58 characters: the width of a Solana key
const SOY_MINT = "8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump"; // public, listed in lib/bungalows.ts
const FAKE_KEY = "FAKEKEYFAKEKEYFAKEKEYFAKEKEY0000";
const FAKE_JWT = ["eyJ" + "a".repeat(20), "eyJ" + "b".repeat(20), "c".repeat(20)].join(".");

let handler;
beforeEach(async () => {
  vi.resetModules();
  vi.mocked(checkRateLimit).mockClear();
  vi.mocked(checkGlobalLimit).mockClear();
  inserted = null;
  insertError = null;
  insertThrows = null;
  insertCalls = 0;
  createClientThrows = false;
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "service-role";
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token";
  handler = (await import("../errors.js")).default;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("errors: accepts what the client actually sends", () => {
  it("stores a consented batch", async () => {
    const s = makeRes();
    await handler(makeReq(consented([clientEntry()])), s.res);
    expect(status(s)).toBe(200);
    expect(payload(s).accepted).toBe(1);
  });

  it("accepts a NUMERIC timestamp, which is what the client sends", async () => {
    const ts = Date.now() - 5000;
    const row = await storedRow({ timestamp: ts });
    expect(row.occurred_at).toBe(new Date(ts).toISOString());
  });

  it("accepts an ISO timestamp too", async () => {
    const iso = new Date(Date.now() - 5000).toISOString();
    const row = await storedRow({ timestamp: iso });
    expect(row.occurred_at).toBe(iso);
  });

  it("needs no event name or session id, and stores neither", async () => {
    const row = await storedRow();
    expect(row).not.toHaveProperty("session_id");
    expect(row).not.toHaveProperty("event");
  });
});

describe("errors: only a consented batch is stored", () => {
  it("refuses a bare array, which states no consent", async () => {
    const s = makeRes();
    await handler(makeReq([clientEntry()]), s.res);
    expect(status(s)).toBe(400);
    expect(insertCalls).toBe(0);
  });

  it("refuses a named batch with no consent field", async () => {
    const s = makeRes();
    await handler(makeReq({ errors: [clientEntry()] }), s.res);
    expect(status(s)).toBe(400);
    expect(insertCalls).toBe(0);
  });

  it("refuses any consent value other than granted", async () => {
    for (const consent of ["denied", "pending", true, "GRANTED"]) {
      const s = makeRes();
      await handler(makeReq({ consent, errors: [clientEntry()] }), s.res);
      expect(status(s)).toBe(400);
    }
    expect(insertCalls).toBe(0);
  });
});

describe("errors: the gap before the operator steps fails closed", () => {
  it("refuses everything while Upstash is unset, before touching the limiter or the table", async () => {
    // Without Upstash the aggregate breaker is a per-instance counter, so the real
    // ceiling is instances x 600/min. Nothing a user sees depends on this route, so
    // refusing costs nothing: the client keeps its buffer and backs off.
    delete process.env.UPSTASH_REDIS_REST_URL;
    const s = makeRes();
    await handler(makeReq(consented([clientEntry()])), s.res);
    expect(status(s)).toBe(503);
    expect(payload(s)).toEqual(SINK_UNAVAILABLE);
    expect(Number(s.headers["retry-after"])).toBeGreaterThan(0);
    expect(insertCalls).toBe(0);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("refuses while the token half of Upstash is unset too", async () => {
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const s = makeRes();
    await handler(makeReq(consented([clientEntry()])), s.res);
    expect(status(s)).toBe(503);
    expect(insertCalls).toBe(0);
  });

  it("refuses while Supabase is unset, with the same words", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    vi.resetModules();
    const h = (await import("../errors.js")).default;
    const s = makeRes();
    await h(makeReq(consented([clientEntry()])), s.res);
    expect(status(s)).toBe(503);
    expect(payload(s)).toEqual(SINK_UNAVAILABLE);
    expect(Number(s.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("table not created yet: 503 with Retry-After, then stops asking the database", async () => {
    // PostgREST answers PGRST205 until 026 is applied and the schema cache reloads.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    insertError = { code: "PGRST205", message: "Could not find the table 'public.error_events' in the schema cache" };

    const first = makeRes();
    await handler(makeReq(consented([clientEntry()])), first.res);
    expect(status(first)).toBe(503);
    expect(payload(first)).toEqual(SINK_UNAVAILABLE);
    expect(Number(first.headers["retry-after"])).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) {
      const s = makeRes();
      await handler(makeReq(consented([clientEntry()])), s.res);
      expect(status(s)).toBe(503);
      expect(Number(s.headers["retry-after"])).toBeGreaterThan(0);
    }
    // One database round trip and one log line, not six of each.
    expect(insertCalls).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("an insert that THROWS is a 503, not a crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    insertThrows = new TypeError("fetch failed");
    const s = makeRes();
    await expect(handler(makeReq(consented([clientEntry()])), s.res)).resolves.not.toThrow();
    expect(status(s)).toBe(503);
    expect(payload(s)).toEqual(SINK_UNAVAILABLE);
  });

  it("a Supabase client that cannot be built is a 503, not a crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    createClientThrows = true;
    vi.resetModules();
    const h = (await import("../errors.js")).default;
    const s = makeRes();
    await expect(h(makeReq(consented([clientEntry()])), s.res)).resolves.not.toThrow();
    expect(status(s)).toBe(503);
    expect(payload(s)).toEqual(SINK_UNAVAILABLE);
  });

  it("a timestamp no Date can hold rejects that entry, and does not crash the batch", async () => {
    // new Date(1e20).toISOString() throws RangeError.
    const s = makeRes();
    await handler(makeReq(consented([clientEntry({ timestamp: 1e20 }), clientEntry()])), s.res);
    expect(status(s)).toBe(200);
    expect(payload(s).accepted).toBe(1);
    expect(payload(s).reasons["bad-timestamp"]).toBe(1);
  });

  it("says nothing about the upstream failure to the caller", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    insertError = { message: "FATAL: password authentication failed for user postgres" };
    const s = makeRes();
    await handler(makeReq(consented([clientEntry()])), s.res);
    expect(payload(s)).toEqual(SINK_UNAVAILABLE);
  });

  it("does not log the service key or the row content when an insert fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    insertError = { message: `insert failed: Authorization: Bearer ${FAKE_JWT}` };
    const s = makeRes();
    await handler(makeReq(consented([clientEntry({ message: "the-row-text-itself" })])), s.res);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(FAKE_JWT);
    expect(logged).not.toContain("service-role");
    expect(logged).not.toContain("the-row-text-itself");
  });
});

describe("errors: scrubbed before storage", () => {
  it("page URL keeps its host and route words, and loses the wallet, query and fragment", async () => {
    const row = await storedRow({ url: `https://memetics.finance/read/${EVM}?ref=abc#frag` });
    const u = new URL(row.url);
    expect(u.host).toBe("memetics.finance");
    expect(u.pathname.startsWith("/read/")).toBe(true);
    expect(row.url).not.toContain(EVM.slice(2, 12));
    expect(row.url).not.toContain("abc");
    expect(row.url).not.toContain("frag");
  });

  it("page URL loses a Solana mint in its path", async () => {
    const row = await storedRow({ url: `https://memetics.finance/launch/${SOY_MINT}` });
    expect(new URL(row.url).host).toBe("memetics.finance");
    expect(row.url).not.toContain(SOY_MINT.slice(0, 12));
  });

  it("a page URL that does not parse is not stored at all", async () => {
    const row = await storedRow({ url: "not a url ?wallet=abc" });
    expect(row.url).toBeNull();
  });

  it("a keyed RPC URL in a message keeps its host and loses its key", async () => {
    const row = await storedRow({
      message: `Failed to fetch https://solana-mainnet.g.alchemy.com/v2/${FAKE_KEY} (status 401)`,
    });
    expect(row.message).toContain("solana-mainnet.g.alchemy.com");
    expect(row.message).not.toContain(FAKE_KEY.slice(0, 8));
  });

  it("query-string values are masked even on a path with no host", async () => {
    const row = await storedRow({ message: "GET /api/orderbook?action=query&wallet=abcdef123&sig=zzz9 failed" });
    expect(row.message).not.toContain("abcdef123");
    expect(row.message).not.toContain("zzz9");
    expect(row.message).toContain("wallet=");
  });

  it("bearer tokens, JWTs and key=value secrets are masked", async () => {
    const row = await storedRow({
      message: `Authorization: Bearer ${FAKE_JWT}; then token=s3cr3tvalue and password: hunter2x`,
    });
    expect(row.message).not.toContain(FAKE_JWT.slice(0, 12));
    expect(row.message).not.toContain("s3cr3tvalue");
    expect(row.message).not.toContain("hunter2x");
  });

  it("a Solana address in the middle of a stack trace is redacted", async () => {
    const row = await storedRow({ stack: `Error: no account ${MINT} at load (index.js:1:2)` });
    expect(row.stack).not.toContain(MINT.slice(0, 12));
    expect(row.stack).toContain("Error: no account");
  });

  it("a long opaque token is redacted", async () => {
    const row = await storedRow({ componentStack: `in Provider (key ${FAKE_KEY}z9z9)` });
    expect(row.component_stack).not.toContain(FAKE_KEY.slice(0, 8));
  });

  it("an EVM address glued to other text is redacted, and the rest of the record survives", async () => {
    const row = await storedRow({ message: `failed forx${EVM}y on call` });
    expect(row.message).not.toMatch(/0x[a-fA-F0-9]{40}/);
    expect(row.message).toContain("on call");
    expect(row.stack).toBe("at foo (app-abc123.js:1:2)");
  });

  it("our own build files in a stack trace stay readable, line and column included", async () => {
    const frame = "at Ze (https://memetics.finance/assets/index-DdX3k9ab.js:12:3456)";
    const row = await storedRow({ stack: frame });
    expect(row.stack).toBe(frame);
  });

  it("no row ever reaches the table carrying a 40-hex address", async () => {
    const s = makeRes();
    await handler(makeReq(consented([
      clientEntry({ message: EVM }),
      clientEntry({ stack: `at f (${EVM})` }),
      clientEntry({ componentStack: `in C (${EVM})` }),
      clientEntry({ url: `https://memetics.finance/read/${EVM}` }),
    ])), s.res);
    expect(inserted).toHaveLength(4);
    expect(JSON.stringify(inserted)).not.toMatch(/0x[a-fA-F0-9]{40}/);
  });

  it("scrubs BEFORE it cuts, so the cut cannot leave part of an address behind", async () => {
    // An address straddling the 2000-character ceiling. Cut first and 30 of its 40
    // hex digits survive, which is no longer "an address" to any 40-hex test.
    // Placed so the 2000-character cut lands 20 hex digits into the address.
    const row = await storedRow({ message: "x ".repeat(989) + EVM });
    expect(row.message).not.toMatch(/0x[a-f0-9]{6,}/i);
  });

  it("the same holds for an address glued to a letter, which logSafe's word-bounded test skips", async () => {
    // logSafe cuts its own output at 2000. Run it before the address pass and this
    // address is halved first: 19 hex digits survive, too short for any 40-hex or
    // 32-character rule to see.
    const row = await storedRow({ message: "x ".repeat(989) + "z" + EVM });
    expect(row.message).not.toMatch(/0x[a-f0-9]{6,}/i);
  });

  it("an email address is removed, and a versioned package name is not taken for one", async () => {
    // PrivacyPage §2: "We do not collect or store: email addresses".
    const row = await storedRow({
      message: "sign-in failed for alice.smith+tag@example.co.uk (react-dom@18.2.0)",
      stack: "Error: no profile for bob@mail.example.com\n    at load (index.js:1:2)",
    });
    expect(row.message).not.toContain("alice");
    expect(row.message).not.toContain("example.co.uk");
    expect(row.message).toContain("react-dom@18.2.0");
    expect(row.stack).not.toContain("bob@");
    expect(row.stack).toContain("at load (index.js:1:2)");
  });

  it("a NUL or half an emoji cannot make Postgres refuse the whole batch", async () => {
    // Postgres text refuses U+0000 and its JSON parser refuses a lone surrogate. Either
    // one fails the insert for every entry in the batch, and the client re-sends that
    // same batch after every backoff for a week. Half an emoji comes from a cut: the
    // client's at 500 characters, or this route's own at 2000.
    const smile = "\u{1F600}";
    const row = await storedRow({
      message: "revert data \u0000\u0000 decoded",
      stack: "s".repeat(1999) + smile,
      componentStack: ("c".repeat(499) + smile).slice(0, 500),
    });
    for (const v of [row.message, row.stack, row.component_stack]) {
      expect(v).not.toContain("\u0000");
      expect(v.isWellFormed()).toBe(true);
    }
    expect(row.message).toContain("decoded");
    expect(row.stack.length).toBeLessThanOrEqual(2000);
  });

  it("long fields are cut to the column ceilings", async () => {
    const row = await storedRow({
      message: "m ".repeat(3000),
      stack: "s ".repeat(6000),
      componentStack: "c ".repeat(6000),
      url: "https://memetics.finance/" + "a/".repeat(600),
    });
    expect(row.message.length).toBeLessThanOrEqual(2000);
    expect(row.stack.length).toBeLessThanOrEqual(2000);
    expect(row.component_stack.length).toBeLessThanOrEqual(2000);
    expect(row.url.length).toBeLessThanOrEqual(500);
  });
});

describe("errors: an oversize batch is truncated, never 413'd", () => {
  it("stores what fits and reports the remainder", async () => {
    const s = makeRes();
    await handler(makeReq(consented(Array.from({ length: 130 }, () => clientEntry()))), s.res);
    expect(status(s)).toBe(200);
    expect(payload(s).accepted).toBe(100);
    expect(payload(s).reasons["batch-truncated"]).toBe(30);
    expect(inserted).toHaveLength(100);
  });
});

describe("errors: origin and rate limits", () => {
  it("rejects a foreign origin", async () => {
    const s = makeRes();
    await handler(makeReq(consented([clientEntry()]), { origin: "https://evil.example" }), s.res);
    expect(status(s)).toBe(403);
    expect(insertCalls).toBe(0);
  });

  it("rejects memetic.fun, which serves another project", async () => {
    const s = makeRes();
    await handler(makeReq(consented([clientEntry()]), { origin: "https://memetic.fun" }), s.res);
    expect(status(s)).toBe(403);
  });

  it("admits exactly the origins analytics.js admits, character for character", () => {
    const allowlist = (file) => {
      const src = readFileSync(join(API_DIR, file), "utf8").replace(/\r\n/g, "\n");
      const fn = src.match(/function buildAllowedOrigins\(\) \{\n[\s\S]*?\n\}\n/);
      expect(fn, `buildAllowedOrigins in ${file}`).not.toBeNull();
      return fn[0];
    };
    expect(allowlist("errors.js")).toBe(allowlist("analytics.js"));
  });

  it("calls the per-IP limiter and the aggregate breaker with the signatures ratelimit.js exports", async () => {
    // checkGlobalLimit is (res, opts). Called as (req, res, opts) it reads its limits
    // off the response object and calls setHeader on the request: a TypeError on every
    // POST that clears the per-IP check.
    const req = makeReq(consented([clientEntry()]));
    const s = makeRes();
    await handler(req, s.res);
    expect(checkRateLimit).toHaveBeenCalledWith(req, s.res, { limit: 30, windowSec: 60, identifier: "errors" });
    expect(checkGlobalLimit).toHaveBeenCalledWith(s.res, { limit: 600, windowSec: 60, identifier: "errors" });
  });
});

describe("errors: refusals", () => {
  it("rejects a body that is not an error batch", async () => {
    const s = makeRes();
    await handler(makeReq({ consent: "granted", nope: true }), s.res);
    expect(status(s)).toBe(400);
  });

  it("counts a malformed entry without losing its siblings", async () => {
    const s = makeRes();
    await handler(makeReq(consented([clientEntry(), { message: 42 }, clientEntry()])), s.res);
    expect(payload(s).accepted).toBe(2);
    expect(payload(s).reasons["bad-message"]).toBe(1);
  });

  it("an empty batch is a no-op, not an error", async () => {
    const s = makeRes();
    await handler(makeReq(consented([])), s.res);
    expect(status(s)).toBe(200);
    expect(payload(s).accepted).toBe(0);
  });

  it("answers a GET with 405", async () => {
    const s = makeRes();
    await handler({ method: "GET", headers: { origin: ORIGIN } }, s.res);
    expect(status(s)).toBe(405);
  });
});
