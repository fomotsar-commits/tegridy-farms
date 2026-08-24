// Heat-oracle proxy (api/_lib/heat.js) — server-side suite. This adapter had
// ZERO tests (docs/UNFINISHED_INVENTORY_2026_08_13.md). It covers the gates in
// dispatch order (method → origin → per-IP budget → global budget), the SSRF
// address boundary, every upstream-failure collapse, and the two invariants the
// file's own comments call load-bearing:
//   - an outage (including a timeout) must NEVER read as a low score, and
//   - the server-side abort (4500ms) must fire strictly before the browser
//     client's 6000ms ceiling, or the honest 502 becomes dead code.
//
// Mock/req/res conventions mirror api/__tests__/aggregator-proxy.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Rate-limiter is pass-through unless a test overrides it. Each test gets a
// fresh import via vi.resetModules(), so a test that needs to force a refusal
// re-imports "../ratelimit.js" to grab the SAME mock instance the freshly
// imported handler holds.
vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const ETH = "0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca";
const SOL = "So11111111111111111111111111111111111111112";

const HEAT_PAYLOAD = {
  address: ETH,
  degrees: 8123,
  tier: "blazing",
  as_of_unix: 1755400000,
};

function makeReq({ method = "GET", query = {}, headers = {} } = {}) {
  return {
    method,
    query,
    headers: { origin: "https://tegridyfarms.vercel.app", ...headers },
  };
}

function makeRes() {
  const headerSpy = vi.fn();
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const endSpy = vi.fn();
  const res = {
    setHeader: (k, v) => { headerSpy(k, v); return res; },
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    end: endSpy,
  };
  return { res, headerSpy, statusSpy, jsonSpy, endSpy };
}

function mockUpstreamOk(payload = HEAT_PAYLOAD) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    text: async () => JSON.stringify(payload),
  }));
}

let handleHeat;
let fetchMock;
let consoleErrorSpy;

beforeEach(async () => {
  vi.resetModules();
  // resetModules does NOT re-run the vi.mock factory — the ratelimit spies are
  // one shared pair for the whole file, so wipe their call history per test.
  vi.clearAllMocks();
  process.env.NODE_ENV = "test"; // origin gate is permissive in non-prod
  fetchMock = mockUpstreamOk();
  vi.stubGlobal("fetch", fetchMock);
  // The catch path logs console.error("heat error", …); keep test output clean.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  ({ handleHeat } = await import("../heat.js"));
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
  delete process.env.ALLOWED_ORIGIN;
  delete process.env.HEAT_GLOBAL_RPM;
});

// ─── Method gate ────────────────────────────────────────────────────────────

describe("method gate", () => {
  it.each(["POST", "PUT", "DELETE"])(
    "rejects %s with 405 before origin, budgets, or upstream",
    async (method) => {
      const { checkRateLimit } = await import("../ratelimit.js");
      const { res, statusSpy, jsonSpy } = makeRes();
      await handleHeat(makeReq({ method, query: { address: ETH } }), res);
      expect(statusSpy).toHaveBeenCalledWith(405);
      expect(jsonSpy).toHaveBeenCalledWith({ error: "Method not allowed" });
      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("OPTIONS preflight returns 200 and ends without a body or budget spend", async () => {
    const { checkRateLimit } = await import("../ratelimit.js");
    const { res, statusSpy, jsonSpy, endSpy } = makeRes();
    await handleHeat(makeReq({ method: "OPTIONS" }), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(endSpy).toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("echoes an allowlisted Origin and always Varies on it", async () => {
    const { res, headerSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    expect(headerSpy).toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      "https://tegridyfarms.vercel.app",
    );
    expect(headerSpy).toHaveBeenCalledWith("Vary", "Origin");
    expect(headerSpy).toHaveBeenCalledWith("Access-Control-Allow-Methods", "GET, OPTIONS");
  });
});

// ─── Origin gate (prod-like) ────────────────────────────────────────────────
// This proxy exists BECAUSE the island CORS-locks its oracle; without the 403
// we are the open proxy that lock was meant to prevent.

describe("origin gate — production mode", () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    ({ handleHeat } = await import("../heat.js"));
  });

  it("rejects a non-allowlisted origin with 403 before budgets or upstream", async () => {
    const { checkRateLimit } = await import("../ratelimit.js");
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleHeat(
      makeReq({ query: { address: ETH }, headers: { origin: "https://attacker.example" } }),
      res,
    );
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Origin not allowed" });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // AUDIT FIX 2026-08-24: the old assertion here ("missing Origin → 403,
  // fail-closed") pinned the bug that killed this surface in production —
  // same-origin browser GETs carry NO Origin header, so the launch gate 403'd
  // every real user while curl probes (which hand-set Origin) passed. The gate
  // now admits absent-Origin GETs unless Sec-Fetch-Site says cross-site;
  // headerless clients (curl) are bounded by the rate limits, which is the only
  // control that ever actually applied to them — Origin is freely forgeable
  // outside a browser.
  it("admits a same-origin browser GET: no Origin, Sec-Fetch-Site same-origin", async () => {
    const { res, statusSpy } = makeRes();
    await handleHeat(
      makeReq({ query: { address: ETH }, headers: { origin: "", "sec-fetch-site": "same-origin" } }),
      res,
    );
    expect(statusSpy).not.toHaveBeenCalledWith(403);
  });

  it("rejects a hostile page's no-cors GET: no Origin, Sec-Fetch-Site cross-site", async () => {
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleHeat(
      makeReq({ query: { address: ETH }, headers: { origin: "", "sec-fetch-site": "cross-site" } }),
      res,
    );
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Origin not allowed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a bad origin in Vercel preview env (VERCEL_ENV=preview) with 403", async () => {
    vi.resetModules();
    delete process.env.NODE_ENV; // preview is NOT NODE_ENV=production
    process.env.VERCEL_ENV = "preview";
    ({ handleHeat } = await import("../heat.js"));
    const { res, statusSpy } = makeRes();
    await handleHeat(
      makeReq({ query: { address: ETH }, headers: { origin: "https://attacker.example" } }),
      res,
    );
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves an allowlisted origin in production with 200", async () => {
    const { res, statusSpy } = makeRes();
    await handleHeat(
      makeReq({ query: { address: ETH }, headers: { origin: "https://memetic.fun" } }),
      res,
    );
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors the ALLOWED_ORIGIN env escape hatch (documented preview flow)", async () => {
    process.env.ALLOWED_ORIGIN = "https://pr-42-tegridy.vercel.app";
    const { res, statusSpy } = makeRes();
    await handleHeat(
      makeReq({ query: { address: ETH }, headers: { origin: "https://pr-42-tegridy.vercel.app" } }),
      res,
    );
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it("OPTIONS from a non-allowlisted origin still 200s but never echoes ACAO", async () => {
    const { res, statusSpy, headerSpy } = makeRes();
    await handleHeat(
      makeReq({ method: "OPTIONS", headers: { origin: "https://attacker.example" } }),
      res,
    );
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(headerSpy).not.toHaveBeenCalledWith("Access-Control-Allow-Origin", expect.anything());
  });
});

// ─── Rate limits ────────────────────────────────────────────────────────────

describe("rate limits — both budgets sit BEFORE the upstream fetch", () => {
  it("per-IP refusal short-circuits: no global check, no upstream, no body of ours", async () => {
    const { checkRateLimit, checkGlobalLimit } = await import("../ratelimit.js");
    checkRateLimit.mockResolvedValueOnce(false);
    const req = makeReq({ query: { address: ETH } });
    const { res, jsonSpy } = makeRes();
    await handleHeat(req, res);
    expect(checkRateLimit).toHaveBeenCalledWith(req, res, {
      limit: 20,
      windowSec: 60,
      identifier: "heat",
    });
    expect(checkGlobalLimit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // The limiter owns the 429 response; the handler must add nothing.
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("global-cap refusal short-circuits before the upstream fetch", async () => {
    const { checkGlobalLimit } = await import("../ratelimit.js");
    checkGlobalLimit.mockResolvedValueOnce(false);
    const { res, jsonSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    expect(checkGlobalLimit).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ identifier: "heat", windowSec: 60 }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("per-IP budget runs first, and the global cap defaults to 300 rpm", async () => {
    const { checkRateLimit, checkGlobalLimit } = await import("../ratelimit.js");
    const { res } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    expect(checkGlobalLimit).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ limit: 300 }),
    );
    expect(checkRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      checkGlobalLimit.mock.invocationCallOrder[0],
    );
  });

  it("HEAT_GLOBAL_RPM overrides the global cap at request time", async () => {
    process.env.HEAT_GLOBAL_RPM = "60";
    const { checkGlobalLimit } = await import("../ratelimit.js");
    const { res } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    expect(checkGlobalLimit).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ limit: 60 }),
    );
  });
});

// ─── Address validation — the SSRF boundary ─────────────────────────────────
// The path interpolates a caller-supplied address into the upstream URL, so
// nothing that fails BOTH anchored regexes may ever reach fetch.

describe("address validation", () => {
  it("400 when address is missing entirely", async () => {
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleHeat(makeReq({ query: {} }), res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Invalid address" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["free text", "not-an-address"],
    ["short hex", "0x1234"],
    ["39-nibble eth", ETH.slice(0, -1)],
    ["42-nibble eth", `${ETH}ff`],
    ["non-hex eth chars", `0x${"g".repeat(40)}`],
    ["31-char base58 (too short)", "1".repeat(31)],
    ["45-char base58 (too long)", "1".repeat(45)],
    ["base58 with excluded chars 0OIl", `0OIl${"1".repeat(30)}`],
    ["path traversal", "../../etc/passwd"],
    ["encoded traversal", "%2e%2e%2fadmin"],
    ["scheme smuggling", "https://evil.example/x"],
    ["query smuggling", `${ETH}?admin=1`],
  ])("400 for %s — and no upstream fetch", async (_label, address) => {
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleHeat(makeReq({ query: { address } }), res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Invalid address" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400 for a duplicated query param (?address=a&address=b arrives as an array)", async () => {
    const { res, statusSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: [ETH, ETH] } }), res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a mixed-case ETH address and hits exactly the pinned host", async () => {
    const mixed = "0x279E7CFF2dbc93ff1f5CAE6cbd072f98d75987CA";
    const { res, statusSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: mixed } }), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://memetics.wtf/api/heat/${mixed}`);
  });

  it("accepts a Solana base58 address", async () => {
    const { res, statusSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: SOL } }), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://memetics.wtf/api/heat/${SOL}`);
  });

  it("trims surrounding whitespace before validating", async () => {
    const { res, statusSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: `  ${ETH}  ` } }), res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://memetics.wtf/api/heat/${ETH}`);
  });
});

// ─── Upstream failure collapse ──────────────────────────────────────────────

describe("upstream failure collapse", () => {
  it("forwards an upstream 400 as our own 400 Invalid address (their validation, honest status)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify({ error: "island says no" }),
    })));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Invalid address" });
  });

  it.each([429, 500, 503])(
    "collapses upstream %i into an opaque 502 Heat oracle unavailable",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: false,
        status,
        headers: { get: () => null },
        body: null,
        text: async () => JSON.stringify({ secret: "upstream-internal-detail" }),
      })));
      const { res, statusSpy, jsonSpy } = makeRes();
      await handleHeat(makeReq({ query: { address: ETH } }), res);
      expect(statusSpy).toHaveBeenCalledWith(502);
      expect(jsonSpy).toHaveBeenCalledWith({ error: "Heat oracle unavailable" });
    },
  );

  it("502 when upstream returns non-JSON — html is never re-emitted from our origin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      text: async () => "<html>the island is a teapot</html>",
    })));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Heat oracle returned non-JSON" });
  });

  it("502 when upstream declares an over-cap Content-Length (body cancelled, never read)", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (k === "content-length" ? "10000000" : null) },
      body: { cancel },
    })));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream response too large" });
    expect(cancel).toHaveBeenCalled();
  });

  it("502 when an undeclared body streams past the cap (readBoundedText truncation)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      text: async () => `{"pad":"${"x".repeat(6_000_000)}"}`,
    })));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream response too large" });
  });

  it("502 on plain network failure (fetch rejects)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Heat oracle unavailable" });
  });

  it("502 on AbortError — a timeout is an outage, NEVER a low score", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(statusSpy).not.toHaveBeenCalledWith(200);
    // Exactly one body, and it carries no score-shaped fields.
    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Heat oracle unavailable" });
  });
});

// ─── Timeout behavior — the abort really is armed at 4500ms ─────────────────

describe("upstream timeout", () => {
  it("aborts a hanging upstream at exactly UPSTREAM_TIMEOUT_MS and reports 502", async () => {
    vi.useFakeTimers();
    const hangingFetch = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
          );
        }),
    );
    vi.stubGlobal("fetch", hangingFetch);
    const { res, statusSpy, jsonSpy } = makeRes();
    const inflight = handleHeat(makeReq({ query: { address: ETH } }), res);

    // Flush the awaited rate-limit microtasks so the timer is armed.
    for (let i = 0; i < 10 && hangingFetch.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(hangingFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4499);
    expect(statusSpy).not.toHaveBeenCalled(); // still patiently waiting at 4499ms

    await vi.advanceTimersByTimeAsync(2); // …and the axe falls at 4500ms
    await inflight;
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Heat oracle unavailable" });
  });
});

// ─── Success path ───────────────────────────────────────────────────────────

describe("success path", () => {
  it("re-emits upstream JSON with observedAt stamped and the short edge-cache window", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { res, statusSpy, jsonSpy, headerSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    const after = Math.floor(Date.now() / 1000);

    expect(statusSpy).toHaveBeenCalledWith(200);
    const body = jsonSpy.mock.calls[0][0];
    // Upstream fields pass through untouched — heat is the ISLAND's measurement.
    expect(body).toMatchObject({
      address: ETH,
      degrees: 8123,
      tier: "blazing",
      as_of_unix: 1755400000,
    });
    // observedAt is OUR read time, distinct from the upstream's as_of_unix.
    expect(typeof body.observedAt).toBe("number");
    expect(body.observedAt).toBeGreaterThanOrEqual(before);
    expect(body.observedAt).toBeLessThanOrEqual(after);
    expect(headerSpy).toHaveBeenCalledWith(
      "Cache-Control",
      "s-maxage=60, stale-while-revalidate=120",
    );
  });

  it("requests the pinned upstream with an Accept: application/json header and an abort signal", async () => {
    const { res } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://memetics.wtf/api/heat/${ETH}`);
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("our observedAt beats an upstream-forged observedAt", async () => {
    const before = Math.floor(Date.now() / 1000);
    vi.stubGlobal("fetch", mockUpstreamOk({ ...HEAT_PAYLOAD, observedAt: 1 }));
    const { res, jsonSpy } = makeRes();
    await handleHeat(makeReq({ query: { address: ETH } }), res);
    expect(jsonSpy.mock.calls[0][0].observedAt).toBeGreaterThanOrEqual(before);
  });
});

// ─── Timeout ordering tripwire ──────────────────────────────────────────────
// Neither constant is exported (deliberately — nothing else should import
// them), so assert against the source text, the same pattern
// launch-cohort.test.js uses for CREATE_TOPIC0. If either number moves the
// wrong way, a hanging island would always surface as the browser's generic
// abort and the server's honest 502 would be dead code.

describe("timeout ordering — server abort must beat the browser abort", () => {
  it("UPSTREAM_TIMEOUT_MS (heat.js) is strictly below CLIENT_TIMEOUT_MS (heatClient.ts)", () => {
    const serverSrc = readFileSync(join(process.cwd(), "api/_lib/heat.js"), "utf8");
    const clientSrc = readFileSync(
      join(process.cwd(), "src/lib/heat/heatClient.ts"),
      "utf8",
    );
    const server = Number(serverSrc.match(/UPSTREAM_TIMEOUT_MS = (\d+)/)?.[1]);
    const client = Number(clientSrc.match(/CLIENT_TIMEOUT_MS = (\d+)/)?.[1]);
    expect(Number.isFinite(server), "UPSTREAM_TIMEOUT_MS must parse from heat.js").toBe(true);
    expect(Number.isFinite(client), "CLIENT_TIMEOUT_MS must parse from heatClient.ts").toBe(true);
    expect(server).toBeLessThan(client);
    // Directive: the browser gives up at a hard <=6s ceiling.
    expect(client).toBeLessThanOrEqual(6000);
  });
});
