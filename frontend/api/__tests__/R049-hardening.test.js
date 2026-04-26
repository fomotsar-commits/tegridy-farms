// AUDIT R049 — H-2 (rate limit), H-3 (body cap), H-5 (eth_getLogs range).
//
// These tests pin the three hardening behaviors so a future refactor can't
// silently regress them. They run as pure-JS unit tests under vitest with
// fetch + ratelimit mocked.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────

// Per-test: rateLimit mock can flip between allow/deny to simulate exhausted
// per-IP quota. Default = allow. Each module-import fresh via resetModules.
const rateLimitMock = vi.fn(async () => true);
vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: (...args) => rateLimitMock(...args),
}));

// fetch mock — each test wires up the response shape it cares about.
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

// Helper: build a Response-shape object backed by a streaming body of a
// given byte size. We construct a real ReadableStream so the bodycap helper
// hits the streaming path that production uses.
function makeStreamResponse(byteSize, { ok = true, headers = {}, payload = null } = {}) {
  const data = payload != null
    ? new TextEncoder().encode(payload)
    : new Uint8Array(byteSize); // zeros — doesn't matter, we only count bytes
  const body = new ReadableStream({
    start(controller) { controller.enqueue(data); controller.close(); },
  });
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body,
    text: async () => new TextDecoder().decode(data),
    json: async () => JSON.parse(new TextDecoder().decode(data)),
  };
}

// Build a minimal req/res pair like the supabase test does.
function makeReqRes({ method = "GET", query = {}, body = null, headers = {} } = {}) {
  const req = { method, query, body, headers };
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const res = {
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  return { req, res, statusSpy, jsonSpy };
}

// ── H-2: v1 rate limit wired ──────────────────────────────────────────────

describe("R049 H-2 — v1 rate limit", () => {
  let handler;
  beforeEach(async () => {
    fetchMock.mockReset();
    rateLimitMock.mockReset();
    vi.resetModules();
    handler = (await import("../v1/index.js")).default;
  });

  it("returns 429 when checkRateLimit denies", async () => {
    rateLimitMock.mockImplementation(async (_req, res) => {
      res.status(429).json({ error: "Too many requests" });
      return false;
    });
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      query: { route: "floor", contract: "0xd774557b647330c91bf44cfeab205095f7e6c367" },
    });
    await handler(req, res);
    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(statusSpy).toHaveBeenCalledWith(429);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Too many requests" });
    // Critical: NO upstream call when rate-limited.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate limiter is called with v1-specific identifier and 20/min limit", async () => {
    rateLimitMock.mockResolvedValue(true);
    fetchMock.mockResolvedValue(makeStreamResponse(0, { payload: '{"openSea":{"floorPrice":1.5}}' }));
    const { req, res } = makeReqRes({
      query: { route: "floor", contract: "0xd774557b647330c91bf44cfeab205095f7e6c367" },
    });
    await handler(req, res);
    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    const [, , opts] = rateLimitMock.mock.calls[0];
    expect(opts).toMatchObject({ limit: 20, windowSec: 60, identifier: "v1" });
  });

  it("rate limit runs BEFORE handler logic (CORS preflight passes through)", async () => {
    rateLimitMock.mockResolvedValue(true);
    const { req, res, statusSpy } = makeReqRes({ method: "OPTIONS" });
    await handler(req, res);
    // OPTIONS short-circuits before rate check (matches alchemy.js pattern).
    expect(statusSpy).toHaveBeenCalledWith(200);
  });
});

// ── H-3: Body cap enforced on all proxies ─────────────────────────────────

describe("R049 H-3 — upstream body cap", () => {
  it("readBoundedText flags truncated when stream exceeds cap", async () => {
    const { readBoundedText } = await import("../_lib/bodycap.js");
    // 6MB > 5MB default cap.
    const big = makeStreamResponse(6_000_000);
    const { truncated, text } = await readBoundedText(big, 5_000_000);
    expect(truncated).toBe(true);
    expect(text).toBe("");
  });

  it("readBoundedText short-circuits via Content-Length without reading body", async () => {
    const { readBoundedText } = await import("../_lib/bodycap.js");
    let bodyConsumed = false;
    const fakeRes = {
      headers: { get: (k) => (k.toLowerCase() === "content-length" ? "10000000" : null) },
      body: {
        getReader() { bodyConsumed = true; return null; },
        cancel() {},
      },
      text: async () => "",
    };
    const { truncated } = await readBoundedText(fakeRes, 5_000_000);
    expect(truncated).toBe(true);
    expect(bodyConsumed).toBe(false); // never had to stream
  });

  it("readBoundedText accepts payloads under the cap", async () => {
    const { readBoundedText } = await import("../_lib/bodycap.js");
    const small = makeStreamResponse(0, { payload: '{"ok":true}' });
    const { truncated, text } = await readBoundedText(small, 5_000_000);
    expect(truncated).toBe(false);
    expect(text).toBe('{"ok":true}');
  });

  it("alchemy proxy returns 502 when upstream body exceeds cap", async () => {
    rateLimitMock.mockResolvedValue(true);
    fetchMock.mockReset();
    // Bomb-sized response (10MB) for any upstream fetch.
    fetchMock.mockResolvedValue(makeStreamResponse(10_000_000));
    vi.resetModules();
    const handler = (await import("../alchemy.js")).default;
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      query: {
        endpoint: "getFloorPrice",
        contractAddress: "0xd774557b647330c91bf44cfeab205095f7e6c367",
      },
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream response too large" });
  });

  it("etherscan proxy returns 502 when upstream body exceeds cap", async () => {
    rateLimitMock.mockResolvedValue(true);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(makeStreamResponse(10_000_000));
    vi.resetModules();
    const handler = (await import("../etherscan.js")).default;
    const { req, res, statusSpy, jsonSpy } = makeReqRes({
      method: "GET",
      query: {
        module: "account",
        action: "txlist",
        address: "0x" + "a".repeat(40),
      },
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream response too large" });
  });
});

// ── H-5: eth_getLogs block-range cap ──────────────────────────────────────

describe("R049 H-5 — eth_getLogs range cap", () => {
  let handler;
  beforeEach(async () => {
    fetchMock.mockReset();
    rateLimitMock.mockReset();
    rateLimitMock.mockResolvedValue(true);
    vi.resetModules();
    handler = (await import("../alchemy.js")).default;
  });

  function rpcReq(params) {
    return makeReqRes({
      method: "POST",
      query: { endpoint: "rpc" },
      body: { method: "eth_getLogs", params: [params] },
    });
  }

  it("rejects pure-numeric range > 10 000 blocks", async () => {
    const { req, res, statusSpy, jsonSpy } = rpcReq({
      address: "0xd774557b647330c91bf44cfeab205095f7e6c367",
      fromBlock: "0x0",
      toBlock: "0x4e20", // 20000
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Block range too large (max 10000)" });
    // Must reject BEFORE forwarding to upstream.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts numeric range <= 10 000 blocks", async () => {
    fetchMock.mockResolvedValue(makeStreamResponse(0, { payload: '{"jsonrpc":"2.0","id":1,"result":[]}' }));
    const { req, res, statusSpy } = rpcReq({
      address: "0xd774557b647330c91bf44cfeab205095f7e6c367",
      fromBlock: "0x1",
      toBlock: "0x2710", // 10000 → delta 9999
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it("rejects toBlock=latest when fromBlock makes range > 10 000", async () => {
    // First fetch is the chain-tip resolver; second would be the eth_getLogs
    // call (which we never reach because the cap rejects first).
    fetchMock.mockResolvedValueOnce(
      makeStreamResponse(0, { payload: '{"jsonrpc":"2.0","id":1,"result":"0x100000"}' }) // tip = 1048576
    );
    const { req, res, statusSpy, jsonSpy } = rpcReq({
      address: "0xd774557b647330c91bf44cfeab205095f7e6c367",
      fromBlock: "0x0",
      toBlock: "latest",
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Block range too large (max 10000)" });
    // Tip fetched once; eth_getLogs upstream NOT called.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects toBlock < fromBlock", async () => {
    const { req, res, statusSpy, jsonSpy } = rpcReq({
      address: "0xd774557b647330c91bf44cfeab205095f7e6c367",
      fromBlock: "0x100",
      toBlock: "0x10",
    });
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "toBlock must be >= fromBlock" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
