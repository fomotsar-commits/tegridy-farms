// AUDIT FE-CRIT-01: regression tests for the gated aggregator proxy
// wrappers that replaced the open `vercel.json` rewrites. Each rewrite was
// previously a free open proxy onto the upstream aggregator. The tests
// cover the four security gates per provider:
//   (a) wrong method  → 405
//   (b) bad path      → 404
//   (c) bad origin    → 403 (production mode)
//   (d) happy path    → 200 + body passthrough
//
// We test both the shared `aggregator-proxy.js` invariants AND each of the
// 7 provider files end-to-end; that way any future drift between the
// shared runner and a specific wrapper is caught by the wrapper's tests.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Rate-limiter is pass-through unless a test overrides it. Each test gets a
// fresh import via vi.resetModules() so module-init env reads are honored.
vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));

function makeReq({ method = "GET", query = {}, body = null, headers = {} } = {}) {
  return {
    method,
    query,
    body,
    headers: { origin: "https://tegridyfarms.vercel.app", ...headers },
  };
}

function makeRes() {
  const headerSpy = vi.fn();
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const sendSpy = vi.fn();
  const res = {
    setHeader: (k, v) => { headerSpy(k, v); return res; },
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    send: (p) => { sendSpy(p); return res; },
    end: vi.fn(),
  };
  return { res, headerSpy, statusSpy, jsonSpy, sendSpy };
}

function mockUpstreamOk(payload = { ok: true }) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k === "content-type" ? "application/json" : null) },
    body: null,
    text: async () => JSON.stringify(payload),
  }));
}

// 2026-05-27: the 7 per-provider catchalls (api/<provider>/[...path].js) were
// consolidated into ONE serverless function — api/aggregator/[provider]/[...path].js
// — to stay under the Vercel Hobby 12-function cap. Routing is by the `[provider]`
// path segment (req.query.provider). These tests import that single handler and
// pass `provider` in the query exactly the way the vercel.json rewrites do
// (/api/odos/:path* → /api/aggregator/odos/:path*). The per-provider security
// policy (matchPath / allowedQuery / method / origin) is preserved verbatim inside
// the consolidated handler, so the matrix below still exercises each provider e2e.
const AGG_HANDLER = "../aggregator/[provider]/[...path].js";

// ─── Provider matrix: name → expected good path/method ──────
// Each row: [identifier, validQuery (object), validMethod, validBody]
const MATRIX = [
  {
    id: "odos",
    mod: AGG_HANDLER,
    okPath: ["sor", "quote", "v2"],
    badPath: ["sor", "swap"],
    okMethod: "POST",
    badMethod: "GET",
    okQuery: {},
    okBody: { chainId: 1, inputTokens: [], outputTokens: [] },
  },
  {
    id: "cow",
    mod: AGG_HANDLER,
    okPath: ["mainnet", "api", "v1", "quote"],
    badPath: ["polygon", "api", "v1", "quote"],
    okMethod: "POST",
    // cow allows GET (orders/{uid} status polling, added 2026-06-02), so a
    // disallowed-method probe must use a verb that's genuinely not allowlisted.
    badMethod: "DELETE",
    okQuery: {},
    okBody: { sellToken: "0x", buyToken: "0x" },
  },
  {
    id: "lifi",
    mod: AGG_HANDLER,
    okPath: ["v1", "quote"],
    badPath: ["v1", "connections"],
    okMethod: "GET",
    badMethod: "DELETE",
    okQuery: { fromChain: "1", toChain: "1", fromToken: "0xeee", toToken: "0xeee", fromAmount: "1", fromAddress: "0xeee" },
    okBody: null,
  },
  {
    id: "kyber",
    mod: AGG_HANDLER,
    okPath: ["ethereum", "api", "v1", "routes"],
    badPath: ["polygon", "api", "v1", "routes"],
    okMethod: "GET",
    badMethod: "POST",
    okQuery: { tokenIn: "0xeee", tokenOut: "0xeee", amountIn: "100" },
    okBody: null,
  },
  {
    id: "openocean",
    mod: AGG_HANDLER,
    okPath: ["v4", "eth", "quote"],
    badPath: ["v4", "bsc", "quote"],
    okMethod: "GET",
    badMethod: "PUT",
    okQuery: { inTokenAddress: "0xeee", outTokenAddress: "0xeee", amount: "0.001" },
    okBody: null,
  },
  {
    id: "paraswap",
    mod: AGG_HANDLER,
    okPath: ["prices"],
    badPath: ["transactions", "1"],
    okMethod: "GET",
    badMethod: "POST",
    okQuery: { srcToken: "0xeee", destToken: "0xeee", amount: "1", side: "SELL", network: "1" },
    okBody: null,
  },
  {
    id: "swapapi",
    mod: AGG_HANDLER,
    okPath: ["v1", "swap", "1"],
    badPath: ["v1", "swap", "999"],
    okMethod: "GET",
    badMethod: "POST",
    okQuery: { tokenIn: "0xeee", tokenOut: "0xeee", amount: "1", sender: "0xeee", maxSlippage: "0.005" },
    okBody: null,
  },
  {
    // Jupiter Swap API (Solana fee-capture, Surface A). Quote is GET; the
    // /swap POST path is exercised separately below. badMethod must be a verb
    // that is genuinely NOT allowlisted (jupiter allows GET + POST + OPTIONS).
    id: "jupiter",
    mod: AGG_HANDLER,
    okPath: ["swap", "v1", "quote"],
    badPath: ["swap", "v1", "transaction"],
    okMethod: "GET",
    badMethod: "DELETE",
    okQuery: { inputMint: "So11111111111111111111111111111111111111112", outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "1000000", slippageBps: "50", platformFeeBps: "100" },
    okBody: null,
  },
];

describe.each(MATRIX)("aggregator proxy — $id", ({ id, mod, okPath, badPath, okMethod, badMethod, okQuery: _okQuery, okBody }) => {
  // The consolidated handler routes on req.query.provider (the `[provider]`
  // path segment). Inject it into every request, the way Vercel's rewrites do.
  const okQuery = { ..._okQuery, provider: id };
  let handler;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test"; // origin gate is permissive in non-prod
    fetchMock = mockUpstreamOk({ source: id });
    globalThis.fetch = fetchMock;
    handler = (await import(mod)).default;
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
  });

  it("(d) happy path: forwards to upstream and returns 200 with body", async () => {
    const req = makeReq({
      method: okMethod,
      query: { ...okQuery, path: okPath },
      body: okBody,
    });
    const { res, statusSpy, sendSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0];
    // Path is rebuilt from validated segments — must contain all segments.
    for (const seg of okPath) {
      expect(String(calledUrl)).toContain(seg);
    }
    // Body roundtrip: upstream returned `{ source: id }`.
    const sentBody = sendSpy.mock.calls[0]?.[0];
    expect(sentBody).toContain(`"${id}"`);
  });

  it("(a) rejects wrong HTTP method with 405", async () => {
    const req = makeReq({
      method: badMethod,
      query: { ...okQuery, path: okPath },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(405);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/Method/) }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(b) rejects non-allowlisted path with 404", async () => {
    const req = makeReq({
      method: okMethod,
      query: { ...okQuery, path: badPath },
      body: okBody,
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(404);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/Not found/i) }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(b) rejects URL-encoded path components (decode-then-check)", async () => {
    const req = makeReq({
      method: okMethod,
      query: { ...okQuery, path: ["%2e%2e", ...okPath] },
      body: okBody,
    });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(c) rejects bad origin in production mode with 403", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    handler = (await import(mod)).default;
    const req = makeReq({
      method: okMethod,
      query: { ...okQuery, path: okPath },
      body: okBody,
      headers: { origin: "https://attacker.example" },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/Origin/) }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(c) accepts allowed origin in production mode", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    fetchMock = mockUpstreamOk({ source: id });
    globalThis.fetch = fetchMock;
    handler = (await import(mod)).default;
    const req = makeReq({
      method: okMethod,
      query: { ...okQuery, path: okPath },
      body: okBody,
      headers: { origin: "https://tegridyfarms.vercel.app" },
    });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  // AUDIT FIX F1 (2026-05-25): Vercel preview deploys inherit prod secrets but
  // DO NOT set NODE_ENV=production. The pre-fix `NODE_ENV !== "production"`
  // origin gate therefore failed OPEN on every preview URL. The gate must now
  // treat VERCEL_ENV=preview as prod-like and reject non-allowlisted origins.
  it("(c) rejects bad origin in Vercel preview env (VERCEL_ENV=preview) with 403", async () => {
    vi.resetModules();
    delete process.env.NODE_ENV; // preview is NOT NODE_ENV=production
    process.env.VERCEL_ENV = "preview";
    handler = (await import(mod)).default;
    const req = makeReq({
      method: okMethod,
      query: { ...okQuery, path: okPath },
      body: okBody,
      headers: { origin: "https://attacker.example" },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/Origin/) }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns OPTIONS preflight as 200", async () => {
    const req = makeReq({ method: "OPTIONS", query: { ...okQuery, path: okPath } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("aggregator proxy — jupiter swap (POST path)", () => {
  let handler;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    fetchMock = mockUpstreamOk({ swapTransaction: "base64-tx" });
    globalThis.fetch = fetchMock;
    handler = (await import(AGG_HANDLER)).default;
  });

  it("accepts POST /swap/v1/swap and forwards the body upstream", async () => {
    const req = makeReq({
      method: "POST",
      query: { provider: "jupiter", path: ["swap", "v1", "swap"] },
      body: { userPublicKey: "abc", feeAccount: "def", quoteResponse: { x: 1 } },
    });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("swap/v1/swap");
  });
});

describe("aggregator proxy — body cap (32 KB)", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    globalThis.fetch = mockUpstreamOk();
    handler = (await import(AGG_HANDLER)).default;
  });

  it("rejects POST body over 32 KB with 413", async () => {
    // Use a body that stringifies to > 32_768 bytes.
    const bigPadding = "x".repeat(40_000);
    const req = makeReq({
      method: "POST",
      query: { provider: "odos", path: ["sor", "quote", "v2"] },
      body: { padding: bigPadding },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(413);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/too large/i) }));
  });
});

describe("aggregator proxy — query allowlist", () => {
  let handler;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    fetchMock = mockUpstreamOk();
    globalThis.fetch = fetchMock;
    handler = (await import(AGG_HANDLER)).default;
  });

  it("forwards only allowlisted query params upstream (no key smuggling)", async () => {
    const req = makeReq({
      method: "GET",
      query: {
        provider: "paraswap",
        path: ["prices"],
        srcToken: "0xeee",
        destToken: "0xeee",
        amount: "1",
        side: "SELL",
        network: "1",
        // Smuggled keys MUST NOT be forwarded.
        apiKey: "secret-leaked-key",
        cookie: "session=evil",
        authorization: "Bearer x",
      },
    });
    const { res } = makeRes();
    await handler(req, res);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain("srcToken=");
    expect(calledUrl).not.toContain("apiKey");
    expect(calledUrl).not.toContain("secret-leaked-key");
    expect(calledUrl).not.toContain("cookie=");
    expect(calledUrl).not.toContain("authorization=");
  });
});

describe("aggregator proxy — upstream over-cap defends against gzip-bomb", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    handler = (await import(AGG_HANDLER)).default;
  });

  it("returns 502 when upstream Content-Length exceeds the body cap", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (k === "content-length" ? "10000000" : k === "content-type" ? "application/json" : null) },
      body: { cancel: vi.fn() },
    }));
    const req = makeReq({
      method: "GET",
      query: { provider: "paraswap", path: ["prices"], srcToken: "0xeee", destToken: "0xeee", amount: "1", side: "SELL", network: "1" },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream response too large" });
  });
});

describe("aggregator proxy — upstream error collapse", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    handler = (await import(AGG_HANDLER)).default;
  });

  it("collapses upstream non-2xx into opaque 502 (no leakage of upstream body)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: { get: () => "application/json" },
      body: null,
      text: async () => JSON.stringify({ secret: "upstream-internal-detail" }),
    }));
    const req = makeReq({
      method: "GET",
      query: { provider: "paraswap", path: ["prices"], srcToken: "0xeee", destToken: "0xeee", amount: "1", side: "SELL", network: "1" },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream service error" });
  });
});
