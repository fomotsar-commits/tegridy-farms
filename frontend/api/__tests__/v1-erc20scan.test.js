// erc20scan — a holder payload we could not read is never a finding about a token.
//
// Same rule the scanner adapters enforce on the client, at the one end that can
// CACHE its mistake. `getTopTokenHolders` failing without a non-2xx — a CDN
// interstitial, a gateway HTML page, a 200 whose shape drifted — used to fall
// through `catch { top = {} }` / `(top.holders || [])` into a 200 carrying
// `holders: []`, stamped `s-maxage=120`. The client renders that as ScanError
// ('empty') → "No holder data for this token — double-check the address is a token
// (not a wallet or an NFT)": a claim ABOUT SOMEBODY'S TOKEN, manufactured from our
// own failed read, and served from cache to everyone who scanned it for two minutes.
//
// An `holders: []` that IS present stays a 200. That is the read working and the
// answer being nobody, and hardening must not blunt it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TOKEN = "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce"; // SHIB — any ERC-20, not the NFT allowlist

function makeReq(query = {}) {
  return { method: "GET", query: { route: "erc20scan", contract: TOKEN, ...query }, headers: { origin: "https://memetic.fun" } };
}

function makeRes() {
  const headers = {};
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const res = {
    setHeader: (k, v) => { headers[k] = v; return res; },
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    end: vi.fn(),
  };
  return { res, headers, statusSpy, jsonSpy };
}

/** One upstream response. `text` is served verbatim so a non-JSON body is testable. */
function upstream(text, { ok = true, status = 200 } = {}) {
  return { ok, status, headers: { get: () => null }, body: null, text: async () => text };
}

const INFO = JSON.stringify({ name: "Shiba Inu", symbol: "SHIB", decimals: "18", totalSupply: "999982329055168014311278372706779", holdersCount: 1678265 });
const HOLDER = { address: "0xdead000000000000000042069420694206942069", balance: 4103927478442409, isContract: false };

describe("v1 erc20scan — an unreadable holder payload is a failed read, not an empty token", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    vi.doMock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));
    handler = (await import("../v1/index.js")).default;
  });

  afterEach(() => { delete globalThis.fetch; });

  /** getTokenInfo always succeeds; the holder read is what each case varies. */
  function serve(topResponse) {
    globalThis.fetch = vi.fn(async (url) =>
      String(url).includes("getTopTokenHolders") ? topResponse : upstream(INFO),
    );
  }

  it("does NOT cache a 200 with no holders when the body is not JSON", async () => {
    // ⚠ THE ORIGINAL BUG. A gateway/CDN page returned with HTTP 200.
    serve(upstream("<!doctype html><title>502 Bad Gateway</title>"));
    const { res, headers, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(), res);

    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(headers["Cache-Control"]).toBe("no-store");
    // The shape that used to be served: a cacheable success carrying nobody.
    expect(jsonSpy.mock.calls[0][0]).not.toHaveProperty("holders");
  });

  it("does NOT cache a 200 with no holders when the payload carries no `holders` key", async () => {
    // A 200 whose shape drifted — an upstream that renamed the field, or answered
    // an envelope we do not know. Silence, not a holder count of zero.
    serve(upstream(JSON.stringify({ ok: true })));
    const { res, headers, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(), res);

    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(jsonSpy.mock.calls[0][0]).not.toHaveProperty("holders");
  });

  it("treats a `holders` that is not a list the same way", async () => {
    serve(upstream(JSON.stringify({ holders: { "0xabc": 1 } })));
    const { res, statusSpy } = makeRes();
    await handler(makeReq(), res);
    expect(statusSpy).toHaveBeenCalledWith(502);
  });

  it("keeps a present-but-empty holder list as the real answer it is", async () => {
    // The other side of the coin: the read WORKED and the answer was nobody. That
    // is the one case where "this token has no holders" is ours to say.
    serve(upstream(JSON.stringify({ holders: [] })));
    const { res, headers, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(), res);

    expect(statusSpy).not.toHaveBeenCalledWith(502);
    expect(headers["Cache-Control"]).toMatch(/s-maxage/);
    expect(jsonSpy.mock.calls[0][0].holders).toEqual([]);
  });

  it("still serves the happy path uncut", async () => {
    serve(upstream(JSON.stringify({ holders: [HOLDER] })));
    const { res, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(), res);

    expect(statusSpy).not.toHaveBeenCalledWith(502);
    const body = jsonSpy.mock.calls[0][0];
    expect(body.symbol).toBe("SHIB");
    expect(body.holders).toHaveLength(1);
    expect(body.holders[0].address).toBe(HOLDER.address);
  });

  it("still maps an auth failure to the honest deployment-gap 403, not to 502", async () => {
    // Ethplorer code 1 = invalid API key → the client's 'unavailable' state. An
    // unreadable body must not steal that more specific answer.
    serve(upstream(JSON.stringify({ error: { code: 1, message: "Invalid API key" } })));
    const { res, headers, statusSpy } = makeRes();
    await handler(makeReq(), res);
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(headers["Cache-Control"]).toBe("no-store");
  });

  it("prefers the auth answer when a 403 also carries an unreadable body", async () => {
    serve(upstream("<html>Forbidden</html>", { ok: false, status: 403 }));
    const { res, statusSpy } = makeRes();
    await handler(makeReq(), res);
    expect(statusSpy).toHaveBeenCalledWith(403);
  });
});
