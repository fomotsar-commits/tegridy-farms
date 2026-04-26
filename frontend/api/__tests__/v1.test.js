// AUDIT R060: regression tests for the v1 dev-API proxy hardening from
// R048 (auth-header migration) and R049 (rate-limit, body-cap).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";

// We mock the ratelimit module per-test so we can inject success/failure.
vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
}));

function makeReq({ query = {}, headers = {} } = {}) {
  return {
    method: "GET",
    query,
    headers: { origin: "https://nakamigos.gallery", ...headers },
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

describe("v1 — R048 auth header (Alchemy Bearer)", () => {
  let handler;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ALCHEMY_API_KEY = "v1-secret-key-1234567890abcdef";
    process.env.NODE_ENV = "test";
    fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify({ openSea: { floorPrice: 1.23 } }),
    }));
    globalThis.fetch = fetchMock;
    handler = (await import("../v1/index.js")).default;
  });

  afterEach(() => { delete process.env.ALCHEMY_API_KEY; });

  it("sets Authorization: Bearer on every Alchemy fetch (no key in URL)", async () => {
    const req = makeReq({ query: { route: "floor", contract: NAKAMIGOS } });
    const { res } = makeRes();
    await handler(req, res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("v1-secret-key");
    expect(opts.headers.Authorization).toBe("Bearer v1-secret-key-1234567890abcdef");
  });
});

describe("v1 — R049 rate-limit returns 429 on 21st request", () => {
  let handler;
  let rateLimitMock;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ALCHEMY_API_KEY = "demo";
    process.env.NODE_ENV = "test";
    // Mock checkRateLimit to deny: it must respond with 429 and return false.
    rateLimitMock = vi.fn(async (_req, res) => {
      res.status(429).json({ error: "Too many requests" });
      return false;
    });
    vi.doMock("../_lib/ratelimit.js", () => ({ checkRateLimit: rateLimitMock }));
    handler = (await import("../v1/index.js")).default;
  });

  it("hands off to checkRateLimit before any business logic; 429 short-circuits", async () => {
    const req = makeReq({ query: { route: "floor", contract: NAKAMIGOS } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    // Verify the rate-limiter is configured to 20/min (per R049 spec).
    const [, , opts] = rateLimitMock.mock.calls[0];
    expect(opts.limit).toBe(20);
    expect(opts.windowSec).toBe(60);
    expect(opts.identifier).toBe("v1");
    expect(statusSpy).toHaveBeenCalledWith(429);
  });
});

describe("v1 — R049 body cap on Alchemy response", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ALCHEMY_API_KEY = "demo";
    process.env.NODE_ENV = "test";
    // The previous describe block installed a 429-denying mock via
    // `vi.doMock`; that registration survives `resetModules`, so we must
    // re-register a pass-through here or the body-cap path is never reached.
    vi.doMock("../_lib/ratelimit.js", () => ({
      checkRateLimit: vi.fn(async () => true),
    }));
    handler = (await import("../v1/index.js")).default;
  });

  it("returns 500 when Alchemy response > 5 MB cap", async () => {
    // Content-Length header exceeds 5 MB → bodycap aborts and throws.
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: (k) => (k === "content-length" ? String(10_000_000) : null) },
      body: { cancel: vi.fn() },
    }));
    const req = makeReq({ query: { route: "floor", contract: NAKAMIGOS } });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    // The handler catches the alchemyFetch throw and returns 500 "Internal error"
    expect(statusSpy).toHaveBeenCalledWith(500);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Internal error" });
  });
});
