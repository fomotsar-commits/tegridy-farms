// AUDIT R060: regression tests for the etherscan proxy security hardening
// from R048 (auth-header migration to v2 multichain Bearer) and R049
// (block-range cap, body cap).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
}));

function makeReq({ query = {}, headers = {} } = {}) {
  return {
    method: "GET",
    query,
    headers: { origin: "https://tegridyfarms.xyz", ...headers },
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

describe("etherscan — R048 auth header (Bearer not querystring)", () => {
  let handler;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ETHERSCAN_API_KEY = "real-etherscan-key-1234567890";
    process.env.NODE_ENV = "test";
    fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify({ status: "1", message: "OK", result: [] }),
    }));
    globalThis.fetch = fetchMock;
    handler = (await import("../etherscan.js")).default;
  });

  afterEach(() => { delete process.env.ETHERSCAN_API_KEY; });

  it("sets Authorization: Bearer header on the outbound fetch", async () => {
    const req = makeReq({
      query: { module: "account", action: "txlist", address: "0x" + "a".repeat(40) },
    });
    const { res } = makeRes();
    await handler(req, res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer real-etherscan-key-1234567890");
    // URL must NOT contain the secret as a querystring param.
    expect(String(url)).not.toContain("real-etherscan-key");
    expect(String(url)).not.toContain("apikey=real");
  });

  it("uses v2 multichain endpoint with chainid param when key configured", async () => {
    const req = makeReq({
      query: { module: "account", action: "txlist", address: "0x" + "b".repeat(40) },
    });
    const { res } = makeRes();
    await handler(req, res);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v2/api");
    expect(String(url)).toContain("chainid=1");
  });
});

describe("etherscan — R049 block-range cap", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ETHERSCAN_API_KEY = "key";
    process.env.NODE_ENV = "test";
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify({ status: "1", result: [] }),
    }));
    handler = (await import("../etherscan.js")).default;
  });

  it("rejects startblock/endblock spread > 10000 with 400", async () => {
    const req = makeReq({
      query: {
        module: "account",
        action: "txlist",
        address: "0x" + "c".repeat(40),
        startblock: "0",
        endblock: "10001",
      },
    });
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Block range too large (max 10000)" });
  });
});
