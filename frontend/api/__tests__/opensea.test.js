// AUDIT R060: regression tests for the opensea proxy hardening.
// Coverage: contract-allowlist on POST bodies (R053-style schema enforcement),
// path traversal guard, body cap.

import { describe, it, expect, beforeEach, vi } from "vitest";

// AUDIT FIX TF-019: opensea.js gained the global circuit-breaker that
// alchemy.js and etherscan.js already carried. Hoisted mocks so the breaker
// can be driven per-test.
const checkGlobalLimitMock = vi.fn(async () => true);
vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: (...args) => checkGlobalLimitMock(...args),
}));

const NAKAMIGOS = "0xd774557b647330c91bf44cfeab205095f7e6c367";

function makeReq({ method = "POST", query = {}, body = {}, headers = {} } = {}) {
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

// AUDIT TF-019. The per-IP cap bounds ONE source; it does nothing about a
// distributed flood of many IPs each staying under 30/min, and the CORS
// headers this proxy sets bound browsers only — never curl. That made the
// paid OpenSea key the last key-holding surface with no aggregate ceiling.
// The property pinned here is "an aggregate ceiling is consulted, and it can
// shed load BEFORE the upstream call is paid for" — not the numeric limit,
// which is env-tunable by design.
describe("opensea — global circuit-breaker", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.OPENSEA_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
    checkGlobalLimitMock.mockClear().mockResolvedValue(true);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: true }),
    }));
    handler = (await import("../opensea.js")).default;
  });

  const statsReq = () =>
    makeReq({ method: "GET", query: { path: "collection/nakamigos/stats" } });

  it("consults the aggregate breaker for this endpoint", async () => {
    const { res } = makeRes();
    await handler(statsReq(), res);
    expect(checkGlobalLimitMock).toHaveBeenCalledTimes(1);
    expect(checkGlobalLimitMock.mock.calls[0][1]).toMatchObject({ identifier: "opensea" });
  });

  it("sheds load before paying for the upstream call", async () => {
    checkGlobalLimitMock.mockResolvedValueOnce(false);
    const { res } = makeRes();
    await handler(statsReq(), res);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

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

describe("opensea — collection stats path allowlist (F514)", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.OPENSEA_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ total: { volume: 1234 } }),
    }));
    handler = (await import("../opensea.js")).default;
  });

  it("accepts the plural collections/{slug}/stats path (OpenSea v2 form)", async () => {
    const req = makeReq({ method: "GET", query: { path: "collections/nakamigos/stats" } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    // Reaches OpenSea (200) instead of 400-ing in the allowlist.
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it("still accepts the singular collection/{slug}/stats path", async () => {
    const req = makeReq({ method: "GET", query: { path: "collection/nakamigos/stats" } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it("rejects collections/{slug}/stats for a non-allowlisted slug", async () => {
    const req = makeReq({ method: "GET", query: { path: "collections/evilcollection/stats" } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
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
