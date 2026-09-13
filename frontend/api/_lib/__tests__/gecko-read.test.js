// gecko-read proxy (api/_lib/gecko-read.js) — server-side suite.
//
// This adapter exists for ONE reason: the `s-maxage` header. The proxying by
// itself is WORSE than what it replaces — it funnels the whole fleet through
// one Vercel egress IP, where the direct browser fetch gave every visitor their
// own keyless budget. Only the edge cache makes it a win, so the tests below
// treat that header as the invariant rather than as a detail: a version of this
// file with the header deleted passes every functional check and is a
// regression, and nothing but a test can say so.
//
// The second invariant is status fidelity. Three callers (chart/ohlcv.ts,
// geckoTerminal/pools.ts, geckoTerminal/poolTrades.ts) branch on 429 to say
// "the feed is rate-limiting, try again" and on 404 to say "this SOURCE has no
// pool here", instead of a generic refusal. Flattening either to 502 deletes a
// written honesty contract without touching the file that states it.
//
// The third is the SSRF boundary: `path` is interpolated into an upstream URL
// PATH, so the tests assert a rejected path never reaches `fetch` at all,
// rather than merely that it returns a 400.
//
// Mock/req/res conventions mirror api/_lib/__tests__/pool-market.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

const EVM_POOL = "0xa43fe16908251ee70ef74718545e4fe6c5ccec9f";
const SOL_POOL = "31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX";
const PAYLOAD = { data: [{ id: `eth_${EVM_POOL}` }] };

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

function mockUpstream({ ok = true, status = 200, payload = PAYLOAD } = {}) {
  return vi.fn(async () => ({
    ok,
    status,
    headers: { get: () => null },
    body: null,
    text: async () => JSON.stringify(payload),
  }));
}

/** The Cache-Control value the handler set, or undefined if it set none. */
function cacheControl(headerSpy) {
  const hit = headerSpy.mock.calls.find(([k]) => k === "Cache-Control");
  return hit?.[1];
}

/** The URL the handler asked upstream for. */
function fetchedUrl(fetchMock) {
  return String(fetchMock.mock.calls[0]?.[0] ?? "");
}

let handleGeckoRead;
let isAllowedPath;
let fetchMock;
let consoleErrorSpy;

beforeEach(async () => {
  vi.resetModules();
  fetchMock = mockUpstream();
  vi.stubGlobal("fetch", fetchMock);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  ({ handleGeckoRead, isAllowedPath } = await import("../gecko-read.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleErrorSpy.mockRestore();
});

describe("gecko-read — the edge cache is the point", () => {
  it("stamps a Cache-Control with a non-zero s-maxage on a successful read", async () => {
    const { res, headerSpy, statusSpy } = makeRes();
    await handleGeckoRead(makeReq({ query: { path: `/networks/eth/pools/${EVM_POOL}/trades` } }), res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    const cc = cacheControl(headerSpy);
    expect(cc, "a 200 with no Cache-Control makes this proxy WORSE than the direct fetch it replaced")
      .toBeDefined();
    // Pin the PROPERTY — a real shared-cache window — not the literal 45. The
    // number is tunable; a zero or absent one is the regression.
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(cc)?.[1] ?? 0);
    expect(sMaxAge).toBeGreaterThan(0);
  });

  it("does NOT cache an upstream failure", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, headers: { get: () => null } });
    const { res, headerSpy, statusSpy } = makeRes();
    await handleGeckoRead(makeReq({ query: { path: "/networks/eth/new_pools" } }), res);

    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(cacheControl(headerSpy), "caching a failure pins the outage in front of everyone for the window")
      .toBeUndefined();
  });
});

describe("gecko-read — a refusal arrives AS the refusal it was", () => {
  it("forwards 429 verbatim, because three readers branch on it to say 'rate-limited'", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null } });
    const { res, statusSpy, headerSpy } = makeRes();
    await handleGeckoRead(makeReq({ query: { path: `/networks/eth/pools/${EVM_POOL}/trades` } }), res);
    expect(statusSpy).toHaveBeenCalledWith(429);
    expect(cacheControl(headerSpy)).toBeUndefined();
  });

  it("forwards 404 verbatim, because ohlcv.ts uses it to say 'this SOURCE has no pool here'", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => null } });
    const { res, statusSpy } = makeRes();
    await handleGeckoRead(makeReq({ query: { path: `/networks/eth/pools/${EVM_POOL}/ohlcv/hour` } }), res);
    expect(statusSpy).toHaveBeenCalledWith(404);
  });

  it("flattens every OTHER upstream status to 502", async () => {
    for (const status of [400, 403, 500, 503]) {
      fetchMock.mockResolvedValueOnce({ ok: false, status, headers: { get: () => null } });
      const { res, statusSpy } = makeRes();
      await handleGeckoRead(makeReq({ query: { path: "/networks/eth/trending_pools" } }), res);
      expect(statusSpy).toHaveBeenCalledWith(502);
    }
  });
});

describe("gecko-read — the SSRF boundary", () => {
  // Each must be refused BEFORE any network call. Asserting only on the 400
  // would still pass if the handler fetched first and validated after.
  const HOSTILE = [
    ["an absolute URL", "https://evil.example.com/networks/eth/new_pools"],
    ["a protocol-relative host", "//evil.example.com/networks/eth/new_pools"],
    ["path traversal", "/networks/eth/../../../etc/passwd"],
    ["traversal after a valid prefix", `/networks/eth/pools/${EVM_POOL}/trades/../../../../search`],
    ["a percent-escape", "/networks/eth/pools/%2e%2e%2f%2e%2e/trades"],
    ["a query smuggled into the path", "/networks/eth/new_pools?x=1"],
    ["a fragment", "/networks/eth/new_pools#x"],
    ["an endpoint outside the allowlist", "/networks/eth/pools"],
    ["a missing leading slash", "networks/eth/new_pools"],
    ["hex of the wrong length", "/networks/eth/pools/0xdeadbeef/trades"],
    ["base58 with an excluded glyph", "/networks/solana/pools/0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl/trades"],
    ["an unknown timeframe", `/networks/eth/pools/${EVM_POOL}/ohlcv/week`],
    ["an uppercase network slug", `/networks/ETH/pools/${EVM_POOL}/trades`],
    ["nothing at all", ""],
  ];

  for (const [label, path] of HOSTILE) {
    it(`refuses ${label} without calling upstream`, async () => {
      const { res, statusSpy } = makeRes();
      await handleGeckoRead(makeReq({ query: { path } }), res);
      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(fetchMock, "a rejected path must never reach the network").not.toHaveBeenCalled();
    });
  }

  it("accepts every shape the browser actually asks for", () => {
    const OK = [
      `/networks/eth/pools/${EVM_POOL}/trades`,
      `/networks/solana/pools/${SOL_POOL}/ohlcv/minute`,
      `/networks/base/pools/${EVM_POOL}/ohlcv/day`,
      `/networks/eth/pools/multi/${EVM_POOL}`,
      `/networks/eth/pools/multi/${EVM_POOL},${EVM_POOL}`,
      "/networks/eth/new_pools",
      "/networks/solana/trending_pools",
      `/networks/solana/tokens/${SOL_POOL}/pools`,
      `/simple/networks/eth/token_price/${EVM_POOL}`,
    ];
    for (const p of OK) expect(isAllowedPath(p), p).toBe(true);
  });

  it("caps a comma-joined id list at GeckoTerminal's own limit", () => {
    const thirty = Array.from({ length: 30 }, () => EVM_POOL).join(",");
    expect(isAllowedPath(`/networks/eth/pools/multi/${thirty}`)).toBe(true);
    expect(isAllowedPath(`/networks/eth/pools/multi/${thirty},${EVM_POOL}`)).toBe(false);
  });
});

describe("gecko-read — the forwarded query", () => {
  it("passes through only the allowlisted keys, and drops the rest", async () => {
    const { res } = makeRes();
    await handleGeckoRead(makeReq({
      query: {
        path: `/networks/eth/pools/${EVM_POOL}/ohlcv/hour`,
        aggregate: "4",
        limit: "90",
        currency: "usd",
        // Not in the table. Dropped rather than refused — the upstream ignores
        // what it does not know, and a 400 here would make the proxy stricter
        // than the direct fetch it replaces for no gain.
        callback: "alert(1)",
      },
    }), res);

    const url = fetchedUrl(fetchMock);
    expect(url).toContain("aggregate=4");
    expect(url).toContain("limit=90");
    expect(url).toContain("currency=usd");
    expect(url).not.toContain("callback");
  });

  it("refuses a malformed value for a key it does forward, without calling upstream", async () => {
    for (const bad of [{ limit: "9e9" }, { aggregate: "-1" }, { currency: "eur" }, { page: "1;drop" }]) {
      const { res, statusSpy } = makeRes();
      await handleGeckoRead(makeReq({
        query: { path: `/networks/eth/pools/${EVM_POOL}/ohlcv/hour`, ...bad },
      }), res);
      expect(statusSpy, JSON.stringify(bad)).toHaveBeenCalledWith(400);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("only ever asks the one host, and never one a caller named", async () => {
    const { res } = makeRes();
    await handleGeckoRead(makeReq({ query: { path: "/networks/eth/new_pools" } }), res);
    expect(fetchedUrl(fetchMock).startsWith("https://api.geckoterminal.com/api/v2/")).toBe(true);
  });
});

describe("gecko-read — the Accept header", () => {
  it("forwards the versioned Accept solanaChart.ts pins", async () => {
    const accept = "application/json;version=20230302";
    const { res } = makeRes();
    await handleGeckoRead(makeReq({
      query: { path: `/networks/solana/tokens/${SOL_POOL}/pools` },
      headers: { accept },
    }), res);
    expect(fetchMock.mock.calls[0][1].headers.Accept).toBe(accept);
  });

  it("replaces anything else with the plain default rather than relaying it", async () => {
    const { res } = makeRes();
    await handleGeckoRead(makeReq({
      query: { path: "/networks/eth/new_pools" },
      headers: { accept: "text/html, */*; q=0.01" },
    }), res);
    expect(fetchMock.mock.calls[0][1].headers.Accept).toBe("application/json");
  });
});

describe("gecko-read — the origin gate", () => {
  // The gate is DELIBERATELY permissive outside a prod-like env
  // (aggregator-proxy.js#isProdLikeEnv), which is exactly how a previous
  // regression shipped: dev and CI skipped it and every curl probe hand-set an
  // Origin, so nothing exercised the real branch. These force the prod-like env
  // so they test the code that actually runs in production.
  describe("in a prod-like env", () => {
    const saved = { node: process.env.NODE_ENV, vercel: process.env.VERCEL_ENV };
    beforeEach(() => { process.env.NODE_ENV = "production"; });
    afterEach(() => {
      if (saved.node === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved.node;
      if (saved.vercel === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = saved.vercel;
    });

    it("refuses a cross-site origin without calling upstream", async () => {
      const { res, statusSpy } = makeRes();
      await handleGeckoRead(
        makeReq({ query: { path: "/networks/eth/new_pools" }, headers: { origin: "https://evil.example.com" } }),
        res,
      );
      expect(statusSpy).toHaveBeenCalledWith(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // The app's OWN fetch is same-origin, and browsers send no Origin header on
    // a same-origin GET. A gate that rejects that is how launch-radar, heat and
    // five other resources were once dead for every real user while every probe
    // passed. This resource now carries SEVEN read surfaces, so the same mistake
    // here would dark the charts, the tape, the pulse and the price at once.
    it("admits the app's own same-origin GET, which carries no Origin header", async () => {
      const { res, statusSpy } = makeRes();
      const req = makeReq({ query: { path: "/networks/eth/new_pools" } });
      delete req.headers.origin;
      req.headers["sec-fetch-site"] = "same-origin";
      await handleGeckoRead(req, res);
      expect(statusSpy, "the venue's own reads must not be 403'd").toHaveBeenCalledWith(200);
    });
  });

  it("refuses a non-GET method", async () => {
    const { res, statusSpy } = makeRes();
    await handleGeckoRead(makeReq({ method: "POST", query: { path: "/networks/eth/new_pools" } }), res);
    expect(statusSpy).toHaveBeenCalledWith(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
