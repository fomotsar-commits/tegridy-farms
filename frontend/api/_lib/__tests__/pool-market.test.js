// Pool-market proxy (api/_lib/pool-market.js) — server-side suite.
//
// This adapter exists for ONE reason: the `s-maxage` header. The proxying by
// itself is a lateral move at best (it funnels the fleet through one origin IP,
// where the direct browser fetch it replaced gave every visitor their own keyless
// budget). Only the edge cache makes it a win, so the tests below treat that
// header as the invariant rather than as a detail — a version of this file with
// the header deleted still passes every functional check and is WORSE than what
// it replaced, and nothing but a test can say so.
//
// The other half is the SSRF boundary: `network` and `pool` are interpolated
// into an upstream URL PATH, so the tests assert that a rejected id never
// reaches `fetch` at all, rather than merely that it returns a 400.
//
// Mock/req/res conventions mirror api/_lib/__tests__/heat.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

// A real Solana pool id (BAYLA/SOL) and a real EVM one (PEPE/WETH), both taken
// from src/lib/bungalows.ts so the fixtures cannot drift from the registry the
// handler actually serves.
const SOL_POOL = "31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX";
const EVM_POOL = "0xa43fe16908251ee70ef74718545e4fe6c5ccec9f";

const POOL_PAYLOAD = {
  data: { attributes: { name: "BAYLA / SOL", base_token_price_usd: "0.00056" } },
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

function mockUpstream({ ok = true, status = 200, payload = POOL_PAYLOAD } = {}) {
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

let handlePoolMarket;
let fetchMock;
let consoleErrorSpy;

beforeEach(async () => {
  vi.resetModules();
  fetchMock = mockUpstream();
  vi.stubGlobal("fetch", fetchMock);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  ({ handlePoolMarket } = await import("../pool-market.js"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleErrorSpy.mockRestore();
});

describe("pool-market — the edge cache is the point", () => {
  it("stamps a Cache-Control with a non-zero s-maxage on a successful read", async () => {
    const { res, headerSpy, statusSpy } = makeRes();
    await handlePoolMarket(makeReq({ query: { network: "solana", pool: SOL_POOL } }), res);

    expect(statusSpy).toHaveBeenCalledWith(200);
    const cc = cacheControl(headerSpy);
    expect(cc, "a 200 with no Cache-Control is worse than the direct fetch this replaced")
      .toBeDefined();
    // Pin the PROPERTY (a real shared-cache window), not the literal 45 — the
    // number is tunable, a zero or absent one is the regression.
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(cc)?.[1] ?? 0);
    expect(sMaxAge).toBeGreaterThan(0);
  });

  it("does NOT cache an upstream failure", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null } });
    const { res, headerSpy, statusSpy } = makeRes();
    await handlePoolMarket(makeReq({ query: { network: "solana", pool: SOL_POOL } }), res);

    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(cacheControl(headerSpy), "caching a failure pins the outage state in front of everyone")
      .toBeUndefined();
  });

  it("passes a 404 through as 404 rather than flattening it to 502", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => null } });
    const { res, statusSpy } = makeRes();
    await handlePoolMarket(makeReq({ query: { network: "eth", pool: EVM_POOL } }), res);
    expect(statusSpy).toHaveBeenCalledWith(404);
  });
});

describe("pool-market — the SSRF boundary", () => {
  // Each of these must be refused BEFORE any network call. Asserting only on the
  // 400 would still pass if the handler fetched first and validated after.
  const HOSTILE = [
    ["path traversal", "../../../etc/passwd"],
    ["a slash", "abc/def"],
    ["an absolute URL", "https://evil.example.com/x"],
    ["a percent-escape", "%2e%2e%2fabc"],
    ["an empty id", ""],
    ["hex of the wrong length", "0xdeadbeef"],
    ["base58 with an excluded glyph", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"],
  ];

  for (const [label, pool] of HOSTILE) {
    it(`refuses ${label} without calling upstream`, async () => {
      const { res, statusSpy } = makeRes();
      await handlePoolMarket(makeReq({ query: { network: "solana", pool } }), res);
      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(fetchMock, "a rejected id must never reach the network").not.toHaveBeenCalled();
    });
  }

  it("refuses a hostile network slug without calling upstream", async () => {
    const { res, statusSpy } = makeRes();
    await handlePoolMarket(
      makeReq({ query: { network: "../../v2/networks", pool: SOL_POOL } }),
      res,
    );
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds the upstream URL on the pinned GeckoTerminal host", async () => {
    const { res } = makeRes();
    await handlePoolMarket(makeReq({ query: { network: "eth", pool: EVM_POOL } }), res);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toBe(
      `https://api.geckoterminal.com/api/v2/networks/eth/pools/${EVM_POOL}`,
    );
  });

  it("accepts both real registry shapes", async () => {
    for (const [network, pool] of [["solana", SOL_POOL], ["eth", EVM_POOL]]) {
      const { res, statusSpy } = makeRes();
      await handlePoolMarket(makeReq({ query: { network, pool } }), res);
      expect(statusSpy, `${network}/${pool} is a live registry pool and must be served`)
        .toHaveBeenCalledWith(200);
    }
  });
});

describe("pool-market — gates", () => {
  // The origin gate is DELIBERATELY permissive outside a prod-like env
  // (aggregator-proxy.js#isProdLikeEnv), which is exactly how a previous
  // regression shipped: dev and CI skipped the gate and every curl probe
  // hand-set an Origin, so nothing exercised the real branch. These two force
  // the prod-like env so they test the code that actually runs in production.
  describe("origin gate, in a prod-like env", () => {
    const saved = { node: process.env.NODE_ENV, vercel: process.env.VERCEL_ENV };
    beforeEach(() => { process.env.NODE_ENV = "production"; });
    afterEach(() => {
      if (saved.node === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved.node;
      if (saved.vercel === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = saved.vercel;
    });

    it("refuses a disallowed origin", async () => {
      const { res, statusSpy } = makeRes();
      await handlePoolMarket(
        makeReq({
          query: { network: "solana", pool: SOL_POOL },
          headers: { origin: "https://evil.example.com" },
        }),
        res,
      );
      expect(statusSpy).toHaveBeenCalledWith(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // The app's OWN fetch is same-origin, and browsers send no Origin header on a
    // same-origin GET. A gate that rejects that is how launch-radar, heat and five
    // other resources were once dead for every real user while every probe passed.
    it("admits the app's own same-origin GET, which carries no Origin header", async () => {
      const { res, statusSpy } = makeRes();
      const req = makeReq({ query: { network: "solana", pool: SOL_POOL } });
      delete req.headers.origin;
      req.headers["sec-fetch-site"] = "same-origin";
      await handlePoolMarket(req, res);
      expect(statusSpy, "the venue's own market strip must not be 403'd").toHaveBeenCalledWith(200);
    });
  });

  it("refuses a non-GET method", async () => {
    const { res, statusSpy } = makeRes();
    await handlePoolMarket(
      makeReq({ method: "POST", query: { network: "solana", pool: SOL_POOL } }),
      res,
    );
    expect(statusSpy).toHaveBeenCalledWith(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the upstream envelope verbatim so the client schema is unchanged", async () => {
    const { res, jsonSpy } = makeRes();
    await handlePoolMarket(makeReq({ query: { network: "solana", pool: SOL_POOL } }), res);
    expect(jsonSpy).toHaveBeenCalledWith(POOL_PAYLOAD);
  });
});
