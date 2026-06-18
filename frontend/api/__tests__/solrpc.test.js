// Regression tests for the same-origin Solana JSON-RPC proxy (api/solrpc.js).
// Mirrors the aggregator-proxy gate coverage: method, origin (fail-closed in
// prod), body cap, OPTIONS, and happy-path forwarding of the JSON-RPC body.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));

function makeReq({ method = "POST", body = null, headers = {} } = {}) {
  return { method, body, headers: { origin: "https://tegridyfarms.vercel.app", ...headers } };
}

function makeRes() {
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const sendSpy = vi.fn();
  const headerSpy = vi.fn();
  const res = {
    setHeader: (k, v) => { headerSpy(k, v); return res; },
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    send: (p) => { sendSpy(p); return res; },
    end: vi.fn(),
  };
  return { res, statusSpy, jsonSpy, sendSpy, headerSpy };
}

function mockFetchOk(payload = { jsonrpc: "2.0", result: "ok", id: 1 }) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    text: async () => JSON.stringify(payload),
  }));
}

const MOD = "../solrpc.js";

describe("solrpc proxy", () => {
  let handler;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test"; // origin gate permissive in non-prod
    fetchMock = mockFetchOk();
    globalThis.fetch = fetchMock;
    handler = (await import(MOD)).default;
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
  });

  it("forwards a JSON-RPC POST and returns 200 with the body", async () => {
    const req = makeReq({ method: "POST", body: { jsonrpc: "2.0", method: "getBalance", params: [], id: 1 } });
    const { res, statusSpy, sendSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(sendSpy.mock.calls[0][0]).toContain('"result"');
  });

  it("rejects GET with 405", async () => {
    const req = makeReq({ method: "GET" });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns OPTIONS preflight as 200", async () => {
    const req = makeReq({ method: "OPTIONS" });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects bad origin in production with 403", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    handler = (await import(MOD)).default;
    const req = makeReq({ method: "POST", body: {}, headers: { origin: "https://attacker.example" } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized body with 413", async () => {
    const req = makeReq({ method: "POST", body: { padding: "x".repeat(70_000) } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
