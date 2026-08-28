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

  // AUDIT 2026-07-12 (L-1): method allowlist — expensive/unbounded scans must be
  // rejected before hitting the (keyed/paid) upstream RPC.
  it("rejects a disallowed method (getProgramAccounts) with 403", async () => {
    const req = makeReq({
      method: "POST",
      body: { jsonrpc: "2.0", method: "getProgramAccounts", params: ["Tokenkeg…", {}], id: 1 },
    });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 2026-08-27: the lighthouse staking page reads Streamflow pools via SDK
  // program scans. getProgramAccounts stays blocked in general (L-1), but is
  // allowed when — and only when — params[0] is a Streamflow staking program
  // AND the request narrows with filters. 2026-08-28: the filters requirement
  // was added because these are PUBLIC shared programs — a filterless scan is
  // unbounded upstream work billed to the keyed RPC even when the oversized
  // response 502s. The SDK (Anchor .all()) always sends a discriminator
  // memcmp + narrowing memcmps — wire-captured 2026-08-28.
  it("allows FILTERED getProgramAccounts against the Streamflow staking programs", async () => {
    for (const program of [
      "STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH",
      "RWRDdfRbi3339VgKxTAXg4cjyniF7cbhNbMxZWiSKmj",
      "RWRDyfZa6Rk9UYi85yjYYfGmoUqffLqjo6vZdFawEez",
    ]) {
      fetchMock.mockClear();
      const req = makeReq({
        method: "POST",
        body: {
          jsonrpc: "2.0",
          method: "getProgramAccounts",
          // The exact wire shape the SDK emits (captured from
          // searchRewardPools against mainnet).
          params: [program, {
            encoding: "base64",
            commitment: "confirmed",
            filters: [
              { memcmp: { offset: 0, bytes: "PVanXA8YbR1", encoding: "base58" } },
              { memcmp: { offset: 10, bytes: "4WCpdeQ2pKLNECNDTXepwsdeePZPoNCp9AQqfACNGXPp", encoding: "base58" } },
            ],
          }],
          id: 1,
        },
      });
      const { res, statusSpy } = makeRes();
      await handler(req, res);
      expect(statusSpy).toHaveBeenCalledWith(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses FILTERLESS getProgramAccounts even against allowlisted programs (compute-burn hole)", async () => {
    for (const cfg of [
      { encoding: "base64" }, // no filters at all
      { encoding: "base64", filters: [] }, // empty filters
      { encoding: "base64", filters: [{ neither: "memcmp nor dataSize" }] }, // non-narrowing entries
      { encoding: "base64", filters: Array.from({ length: 9 }, () => ({ dataSize: 8 })) }, // absurd filter count
    ]) {
      fetchMock.mockClear();
      const req = makeReq({
        method: "POST",
        body: { jsonrpc: "2.0", method: "getProgramAccounts", params: ["STAKEvGqQTtzJZH6BWDcbpzXXn2BBerPAgQ3EGLN2GH", cfg], id: 1 },
      });
      const { res, statusSpy } = makeRes();
      await handler(req, res);
      expect(statusSpy).toHaveBeenCalledWith(403);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("still rejects getProgramAccounts with a non-string or missing program id", async () => {
    for (const params of [undefined, [], [42], [{ not: "a program" }]]) {
      fetchMock.mockClear();
      const req = makeReq({
        method: "POST",
        body: { jsonrpc: "2.0", method: "getProgramAccounts", params, id: 1 },
      });
      const { res, statusSpy } = makeRes();
      await handler(req, res);
      expect(statusSpy).toHaveBeenCalledWith(403);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("allows a whitelisted method (sendTransaction) through to upstream", async () => {
    const req = makeReq({ method: "POST", body: { jsonrpc: "2.0", method: "sendTransaction", params: ["base64tx"], id: 1 } });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized JSON-RPC batch with 400", async () => {
    const batch = Array.from({ length: 25 }, (_, i) => ({ jsonrpc: "2.0", method: "getBalance", params: [], id: i }));
    const req = makeReq({ method: "POST", body: batch });
    const { res, statusSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
