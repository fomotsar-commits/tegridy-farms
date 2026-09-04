// AUDIT R060: regression tests for the alchemy proxy security hardening from
// R048 (auth-header migration), R049 (rate-limit + body-cap + log-range guard),
// and R050 (per-method cache-control contract).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Rate-limiter is pass-through unless a test overrides it. Each test gets a
// fresh import via vi.resetModules() so module-init env reads are honored.
const noopRateLimit = vi.fn(async () => true);
vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: noopRateLimit, checkGlobalLimit: noopRateLimit }));

const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";

function makeReq({ method = "GET", query = {}, body = null, headers = {} } = {}) {
  return {
    method,
    query,
    body,
    headers: { origin: "https://memetic.fun", ...headers },
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

function collectHeaders(headerSpy) {
  const out = {};
  for (const [k, v] of headerSpy.mock.calls) out[k] = v;
  return out;
}

describe("alchemy — R048 auth header migration", () => {
  let handler;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ALCHEMY_API_KEY = "real-secret-key-1234567890abcdef";
    process.env.NODE_ENV = "test";
    fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify({ ownersForCollection: [] }),
    }));
    globalThis.fetch = fetchMock;
    handler = (await import("../alchemy.js")).default;
  });

  afterEach(() => { delete process.env.ALCHEMY_API_KEY; });

  it("uses Authorization: Bearer header (NOT URL path) for v3 NFT endpoints", async () => {
    const { req } = { req: makeReq({ query: { endpoint: "getOwnersForContract", contractAddress: NAKAMIGOS } }) };
    const { res } = makeRes();
    await handler(req, res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    // URL must NOT contain the secret key.
    expect(String(url)).not.toContain("real-secret-key");
    // Authorization header MUST carry the key.
    expect(opts.headers.Authorization).toBe("Bearer real-secret-key-1234567890abcdef");
  });

  it("uses Authorization: Bearer header for RPC pass-through", async () => {
    const { req } = { req: makeReq({
      method: "POST",
      query: { endpoint: "rpc" },
      body: { method: "eth_blockNumber", params: [] },
    }) };
    const { res } = makeRes();
    await handler(req, res);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("real-secret-key");
    expect(opts.headers.Authorization).toBe("Bearer real-secret-key-1234567890abcdef");
  });
});

describe("alchemy — RESIL-1 fallback key failover", () => {
  let handler;
  let fetchMock;

  const failRes = (status) => ({
    ok: false,
    status,
    headers: { get: () => null },
    body: null,
    text: async () => JSON.stringify({ error: "upstream" }),
  });
  const okRes = () => ({
    ok: true,
    headers: { get: () => null },
    body: null,
    text: async () => JSON.stringify({ ownersForCollection: [] }),
  });

  beforeEach(async () => {
    vi.resetModules();
    process.env.ALCHEMY_API_KEY = "primary-key-aaaaaaaaaaaaaaaaaaaa";
    process.env.ALCHEMY_API_KEY_FALLBACK = "fallback-key-bbbbbbbbbbbbbbbb";
    process.env.NODE_ENV = "test";
    handler = (await import("../alchemy.js")).default;
  });

  afterEach(() => {
    delete process.env.ALCHEMY_API_KEY;
    delete process.env.ALCHEMY_API_KEY_FALLBACK;
  });

  it("retries once with the fallback key on upstream 401", async () => {
    fetchMock = vi.fn().mockResolvedValueOnce(failRes(401)).mockResolvedValueOnce(okRes());
    globalThis.fetch = fetchMock;
    const req = makeReq({ query: { endpoint: "getOwnersForContract", contractAddress: NAKAMIGOS } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer primary-key-aaaaaaaaaaaaaaaaaaaa");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fallback-key-bbbbbbbbbbbbbbbb");
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it("does NOT retry deterministic 4xx (404) — single fetch, opaque 502", async () => {
    fetchMock = vi.fn().mockResolvedValue(failRes(404));
    globalThis.fetch = fetchMock;
    const req = makeReq({ query: { endpoint: "getOwnersForContract", contractAddress: NAKAMIGOS } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalledWith(502);
  });

  it("makes a single fetch when ALCHEMY_API_KEY_FALLBACK is unset (pre-RESIL-1 behavior)", async () => {
    delete process.env.ALCHEMY_API_KEY_FALLBACK;
    vi.resetModules();
    handler = (await import("../alchemy.js")).default;
    fetchMock = vi.fn().mockResolvedValue(failRes(429));
    globalThis.fetch = fetchMock;
    const req = makeReq({ query: { endpoint: "getOwnersForContract", contractAddress: NAKAMIGOS } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalledWith(502);
  });
});

describe("alchemy — R049 body cap (gzip-bomb / OOM defense)", () => {
  let handler;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ALCHEMY_API_KEY = "demo"; // path-segment auth, irrelevant here
    process.env.NODE_ENV = "test";
    handler = (await import("../alchemy.js")).default;
  });

  it("returns 502 when upstream Content-Length exceeds 5 MB cap", async () => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: (k) => (k === "content-length" ? String(10_000_000) : null) },
      body: { cancel: vi.fn() },
    }));
    globalThis.fetch = fetchMock;
    const req = makeReq({ query: { endpoint: "getOwnersForContract", contractAddress: NAKAMIGOS } });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream response too large" });
  });
});

describe("alchemy — R049 eth_getLogs block-range cap", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ALCHEMY_API_KEY = "real-key-aaaaaaaaaaaaaaaaaaaaaaaa";
    process.env.NODE_ENV = "test";
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify({ result: [] }),
    }));
    handler = (await import("../alchemy.js")).default;
  });

  it("rejects eth_getLogs with delta > 10000 blocks (numeric)", async () => {
    const req = makeReq({
      method: "POST",
      query: { endpoint: "rpc" },
      body: {
        method: "eth_getLogs",
        params: [{
          address: NAKAMIGOS,
          fromBlock: "0x0",
          toBlock: "0x2710", // 10000 — boundary case is exactly cap
        }],
      },
    });
    // 10000 exactly is allowed; 10001 is not. Use 0x2711 to confirm 400.
    req.body.params[0].toBlock = "0x2711";
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Block range too large (max 10000)" });
  });

  it("accepts exactly 10000 blocks", async () => {
    const req = makeReq({
      method: "POST",
      query: { endpoint: "rpc" },
      body: {
        method: "eth_getLogs",
        params: [{
          address: NAKAMIGOS,
          fromBlock: "0x0",
          toBlock: "0x2710",
        }],
      },
    });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    // 200 = passed range gate; success depends on fetch mock.
    expect(statusSpy).toHaveBeenCalledWith(200);
  });
});

describe("alchemy — R050 cache contract per RPC method", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ALCHEMY_API_KEY = "demo";
    process.env.NODE_ENV = "test";
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify({ result: "0x123" }),
    }));
    handler = (await import("../alchemy.js")).default;
  });

  it("eth_blockNumber gets s-maxage cache header (cacheable across users)", async () => {
    const req = makeReq({
      method: "POST",
      query: { endpoint: "rpc" },
      body: { method: "eth_blockNumber", params: [] },
    });
    const { res, headerSpy } = makeRes();
    await handler(req, res);
    const headers = collectHeaders(headerSpy);
    expect(headers["Cache-Control"]).toMatch(/s-maxage/);
    expect(headers["Cache-Control"]).not.toMatch(/no-store/);
  });

  it("eth_getLogs gets private, no-store (no edge caching)", async () => {
    const req = makeReq({
      method: "POST",
      query: { endpoint: "rpc" },
      body: {
        method: "eth_getLogs",
        params: [{ address: NAKAMIGOS, fromBlock: "0x0", toBlock: "0x100" }],
      },
    });
    const { res, headerSpy } = makeRes();
    await handler(req, res);
    const headers = collectHeaders(headerSpy);
    expect(headers["Cache-Control"]).toBe("private, no-store");
  });
});

describe("alchemy — R050 CORS fallback (non-allowlisted origin)", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ALCHEMY_API_KEY = "demo";
    process.env.NODE_ENV = "test";
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify({ ok: true }),
    }));
    handler = (await import("../alchemy.js")).default;
  });

  it("disallowed origin: NO Access-Control-Allow-Credentials header", async () => {
    const req = makeReq({
      query: { endpoint: "getOwnersForContract", contractAddress: NAKAMIGOS },
      headers: { origin: "https://attacker.example" },
    });
    const { res, headerSpy } = makeRes();
    await handler(req, res);
    const headers = collectHeaders(headerSpy);
    // Per R050 fail-closed credentialed CORS: ACAO falls back but ACAC must be absent.
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });
});

// ── INCIDENT 2026-09-04 (#385) ────────────────────────────────────────────────
// Production returned `502 {"error":"Upstream returned invalid response"}` on
// every NFT endpoint for hours. The cause was a rejected ALCHEMY_API_KEY, and
// the proxy could not say so: Alchemy answers a bad key with HTTP 401,
// `content-type: application/json`, and a body of `Must be authenticated!`
// — which is NOT JSON. The handler parsed before it checked the status, so a
// clean 401 was indistinguishable from a corrupt payload.
//
// Both tests below FAIL on the pre-fix handler:
//   REST → returned 502 "Upstream returned invalid response" (parse ran first)
//   RPC  → returned **200**, because that branch never checked the status at all
describe("alchemy — #385: a rejected key must be reported as a rejected key", () => {
  let handler;

  // The real upstream shape, verbatim from probing Alchemy on 2026-09-04:
  // a 401 whose content-type claims JSON and whose body is a bare sentence.
  const authRejected = () => ({
    ok: false,
    status: 401,
    headers: { get: () => "application/json" },
    body: null,
    text: async () => "Must be authenticated!",
  });

  beforeEach(async () => {
    vi.resetModules();
    process.env.ALCHEMY_API_KEY = "revoked-key-cccccccccccccccccccc";
    delete process.env.ALCHEMY_API_KEY_FALLBACK; // single key: the 401 is final
    process.env.NODE_ENV = "test";
    handler = (await import("../alchemy.js")).default;
  });

  afterEach(() => {
    delete process.env.ALCHEMY_API_KEY;
  });

  it("REST: a final 401 with a non-JSON body is 503, not a mystery 502", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(authRejected());
    const req = makeReq({ query: { endpoint: "getFloorPrice", contractAddress: NAKAMIGOS } });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream credentials rejected" });
    // The pre-fix failure mode, pinned so it cannot come back:
    expect(statusSpy).not.toHaveBeenCalledWith(502);
    expect(jsonSpy).not.toHaveBeenCalledWith({ error: "Upstream returned invalid response" });
  });

  it("RPC: an upstream 401 must NOT be handed to the caller as HTTP 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => "application/json" },
      body: null,
      // Alchemy's RPC edge answers with a well-formed JSON-RPC error, which is
      // exactly why parsing first looked like success.
      text: async () => JSON.stringify({
        jsonrpc: "2.0", id: 1,
        error: { code: -32600, message: "Must be authenticated!" },
      }),
    });
    const req = makeReq({
      method: "POST",
      query: { endpoint: "rpc" },
      body: { method: "eth_blockNumber", params: [] },
    });
    const { res, statusSpy, jsonSpy, headerSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(503);
    expect(statusSpy).not.toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream credentials rejected" });
    // And it must not be cached at the shared edge: eth_blockNumber carries
    // `s-maxage=12`, so caching a failure would serve the auth error to every
    // visitor for 12s.
    expect(collectHeaders(headerSpy)["Cache-Control"]).toBeUndefined();
  });

  it("still maps a non-credential upstream failure to the opaque 502", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 500, headers: { get: () => null }, body: null,
      text: async () => JSON.stringify({ error: "boom" }),
    });
    const req = makeReq({ query: { endpoint: "getFloorPrice", contractAddress: NAKAMIGOS } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(502);
  });
});
