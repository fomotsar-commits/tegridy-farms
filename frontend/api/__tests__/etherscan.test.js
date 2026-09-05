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

// API-M5 (incident 2026-09-04): this proxy returned res.status(200).json(data)
// with no reference to response.ok, so a refused upstream reached the caller as
// a success. Same defect, same week, as the alchemy.js RPC path. The last two
// cases pin the DELIBERATE opposite: a NOTOK envelope is Etherscan's own unread
// channel, arrives as a 200, and must keep arriving as one.
describe("etherscan — API-M5 upstream status is not flattened to 200", () => {
  let handler;

  beforeEach(() => {
    vi.resetModules();
    process.env.ETHERSCAN_API_KEY = "real-etherscan-key-1234567890";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => { delete process.env.ETHERSCAN_API_KEY; });

  async function run(upstream) {
    globalThis.fetch = vi.fn(async () => ({
      headers: { get: () => null },
      body: null,
      ...upstream,
    }));
    handler = (await import("../etherscan.js")).default;
    const req = makeReq({
      query: { module: "account", action: "txlist", address: "0x" + "c".repeat(40) },
    });
    const { res, headerSpy, statusSpy, jsonSpy } = makeRes();
    await handler(req, res);
    return { headerSpy, statusSpy, jsonSpy };
  }

  it("a 500 upstream surfaces as 502, never 200", async () => {
    const { statusSpy, jsonSpy } = await run({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ status: "0", message: "NOTOK", result: "rate limit" }),
    });
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(statusSpy).not.toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream service error" });
  });

  it("a 403 bot challenge is caught before the parse, not misreported as bad JSON", async () => {
    const { statusSpy, jsonSpy } = await run({
      ok: false,
      status: 403,
      text: async () => "<html>Attention Required! | Cloudflare</html>",
    });
    expect(statusSpy).toHaveBeenCalledWith(502);
    // "Upstream returned invalid response" would mean the parse ran first and
    // threw away a perfectly clear upstream status.
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream service error" });
  });

  it("does not echo the upstream status or body to the client", async () => {
    const { jsonSpy } = await run({
      ok: false,
      status: 403,
      text: async () => "<html>Attention Required! | Cloudflare</html>",
    });
    const payload = JSON.stringify(jsonSpy.mock.calls[0][0]);
    expect(payload).not.toContain("Cloudflare");
    expect(payload).not.toContain("403");
  });

  it("does not pin an outage at the shared edge", async () => {
    const { headerSpy } = await run({ ok: false, status: 500, text: async () => "boom" });
    const headers = {};
    for (const [k, v] of headerSpy.mock.calls) headers[k] = v;
    expect(headers["Cache-Control"]).toBeUndefined();
  });

  it("logs the real upstream status server-side for ops", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await run({ ok: false, status: 503, text: async () => "unavailable" });
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(" ")).toContain("503");
    errSpy.mockRestore();
  });

  it("passes a 200 NOTOK envelope through untouched (Etherscan's own unread channel)", async () => {
    const envelope = { status: "0", message: "NOTOK", result: "Missing/Invalid API Key" };
    const { statusSpy, jsonSpy } = await run({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(envelope),
    });
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith(envelope);
  });

  it("still passes a genuine empty result through as 200", async () => {
    const envelope = { status: "0", message: "No transactions found", result: [] };
    const { statusSpy, jsonSpy } = await run({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(envelope),
    });
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(jsonSpy).toHaveBeenCalledWith(envelope);
  });
});
