// AUDIT R060: regression tests for the opensea proxy hardening.
// Coverage: contract-allowlist on POST bodies (R053-style schema enforcement),
// path traversal guard, body cap.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
}));

const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";

function makeReq({ method = "POST", query = {}, body = {}, headers = {} } = {}) {
  return {
    method,
    query,
    body,
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

describe("opensea — POST body contract-allowlist", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.OPENSEA_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: true }),
    }));
    handler = (await import("../opensea.js")).default;
  });

  it("rejects POST with non-allowlisted contract in offer item", async () => {
    const req = makeReq({
      query: { path: "orders/ethereum/seaport/listings" },
      body: {
        parameters: {
          offer: [{ itemType: 2, token: "0x" + "e".repeat(40) }],
          consideration: [],
        },
      },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Contract not supported" });
  });

  it("accepts POST with allowlisted contract in offer item", async () => {
    const req = makeReq({
      query: { path: "orders/ethereum/seaport/listings" },
      body: {
        parameters: {
          offer: [{ itemType: 2, token: NAKAMIGOS }],
          consideration: [{ itemType: 0, token: "0x0000000000000000000000000000000000000000", startAmount: "1000" }],
        },
      },
    });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
  });
});

describe("opensea — path traversal / encoded-segment guard", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    handler = (await import("../opensea.js")).default;
  });

  it("rejects URL-encoded path components (decode-then-check)", async () => {
    // %2F..%2Fadmin should decode different from raw, triggering the guard.
    const req = makeReq({
      method: "GET",
      query: { path: "orders/%2F..%2Fadmin" },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Invalid or missing path" });
  });

  it("rejects literal '..' in path", async () => {
    const req = makeReq({ method: "GET", query: { path: "orders/../admin" } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
  });
});

describe("opensea — body cap (10 KB)", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    handler = (await import("../opensea.js")).default;
  });

  it("rejects POST with body > 10 KB", async () => {
    const req = makeReq({
      query: { path: "orders/ethereum/seaport/listings" },
      body: { padding: "x".repeat(11_000) },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(413);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Request body too large (max 10KB)" });
  });
});

describe("opensea — query param validation", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    handler = (await import("../opensea.js")).default;
  });

  it("rejects non-allowlisted asset_contract_address query param", async () => {
    const req = makeReq({
      method: "GET",
      query: {
        path: "events/collection/nakamigos",
        asset_contract_address: "0x" + "9".repeat(40),
      },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Contract not supported" });
  });

  it("rejects non-numeric token_ids", async () => {
    const req = makeReq({
      method: "GET",
      query: {
        path: "events/collection/nakamigos",
        token_ids: "evil-string",
      },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Invalid token_ids — must be numeric (max 10 digits)" });
  });
});
