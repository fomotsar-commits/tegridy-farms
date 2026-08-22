// AUDIT R060: regression tests for the etherscan proxy security hardening
// from R048 (auth-header migration to v2 multichain Bearer) and R049
// (block-range cap, body cap).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  checkGlobalLimit: vi.fn(async () => true),
}));

function makeReq({ query = {}, headers = {} } = {}) {
  return {
    method: "GET",
    query,
    headers: { origin: "https://tegridyfarms.vercel.app", ...headers },
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

// R048 originally moved auth to an `Authorization: Bearer` header to keep the key
// out of the URL. VERIFIED LIVE 2026-07-19: Etherscan v2 REJECTS Bearer with
// {"status":"0","message":"NOTOK","result":"Missing/Invalid API Key"}; the same key
// succeeds as `?apikey=`. So Bearer was silently breaking every authenticated call
// (and with no key we fell back to v1, which Etherscan has since deprecated — the
// endpoint returned NOTOK either way, which is how this went unnoticed).
//
// R048's underlying concern — the key leaking into logs — still holds and is still
// covered: api/etherscan.js never logs the URL, and its error path goes through
// logSafe(), which redacts `apikey=<value>` (asserted below).
describe("etherscan — auth is querystring apikey (v2 rejects Bearer)", () => {
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

  it("sends the key as ?apikey= and NOT as a Bearer header", async () => {
    const req = makeReq({
      query: { module: "account", action: "txlist", address: "0x" + "a".repeat(40) },
    });
    const { res } = makeRes();
    await handler(req, res);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    // Querystring auth is the ONLY form Etherscan v2 accepts.
    expect(String(url)).toContain("apikey=real-etherscan-key-1234567890");
    // A Bearer header would be rejected upstream — make sure we never send one again.
    expect(opts.headers?.Authorization).toBeUndefined();
  });

  it("logSafe redacts the key if a fetch error ever embeds the URL", async () => {
    // The log-leak guard R048 was reaching for. Querystring auth is unavoidable,
    // so this is what actually keeps the secret out of logs.
    const { logSafe } = await import("../_lib/logSafe.js");
    const out = String(logSafe(new Error(
      "request to https://api.etherscan.io/v2/api?chainid=1&apikey=real-etherscan-key-1234567890 failed"
    )));
    expect(out).not.toContain("real-etherscan-key-1234567890");
    expect(out).toContain("REDACTED");
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
