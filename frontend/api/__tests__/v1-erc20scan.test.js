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

describe("v1 erc20scan — the numbers it publishes are the numbers it read", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    vi.doMock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true) }));
    handler = (await import("../v1/index.js")).default;
  });

  afterEach(() => { delete globalThis.fetch; });

  /** `info`/`top` may be a body string, or a pre-built response to control ok/status. */
  function serve({ info = INFO, top }) {
    const wrap = (v) => (typeof v === "string" ? upstream(v) : v);
    globalThis.fetch = vi.fn(async (url) =>
      String(url).includes("getTopTokenHolders") ? wrap(top) : wrap(info),
    );
  }

  async function scan(bodies) {
    serve(bodies);
    const { res, headers, statusSpy, jsonSpy } = makeRes();
    await handler(makeReq(), res);
    return { headers, statusSpy, body: jsonSpy.mock.calls[0]?.[0] };
  }

  it("publishes the exact rawBalance, not a balance rebuilt from a 2-decimal share", async () => {
    // ⚠ THE LIVE DEFECT. Ethplorer hands over the exact integer in `rawBalance`;
    // this route ignored it and reconstructed each balance as
    // totalSupply × round(share × 1e4) / 1e6. `share` is a percentage rounded to
    // TWO decimals, so the reconstruction carried a fixed ±0.005pp error — which is
    // ~0.02% on the top holder but 6.01% on a 0.07% holder (measured on TOWELI's
    // own live scan: 700000000000000000000000 published against an actual
    // 744733489701014745728907). Every downstream metric divides these.
    const exact = "744733489701014745728907";
    const { body } = await scan({
      top: JSON.stringify({
        holders: [{ address: `0x${"a".repeat(40)}`, balance: 7.447334897010147e23, share: 0.07, rawBalance: exact }],
      }),
    });
    expect(body.holders[0].balance).toBe(exact);
  });

  it("does not let a holder under 0.005% round away to nothing", async () => {
    // The other end of the same quantization: `share` rounds to 0.00, the rebuilt
    // balance is 0, and the client drops every zero-balance row. A real holder
    // disappeared from the set, which understates concentration.
    const { body } = await scan({
      top: JSON.stringify({
        holders: [{ address: `0x${"b".repeat(40)}`, share: 0, rawBalance: "40000000000000000000" }],
      }),
    });
    expect(body.holders).toHaveLength(1);
    expect(body.holders[0].balance).toBe("40000000000000000000");
  });

  it("refuses a row whose balance cannot be read exactly rather than dropping it", async () => {
    // Dropping understates concentration — the flattering direction — and dropping
    // every row lands the client on "No holder data for this token".
    for (const bad of [{ balance: "1,000" }, { balance: "9.9e32" }, { balance: null }, { rawBalance: "0x10" }, {}]) {
      const { statusSpy } = await scan({
        top: JSON.stringify({ holders: [{ address: `0x${"c".repeat(40)}`, ...bad }] }),
      });
      expect(statusSpy, JSON.stringify(bad)).toHaveBeenCalledWith(502);
    }
  });

  it("refuses a float balance whose low digits the parse already fabricated", async () => {
    // No rawBalance to fall back on: `BigInt(Math.trunc(4.1e32))` returns a
    // confident-looking integer whose last 17 digits came from the float, not
    // from the chain.
    const { statusSpy } = await scan({
      top: JSON.stringify({ holders: [{ address: `0x${"d".repeat(40)}`, balance: 4.10436517170573e32 }] }),
    });
    expect(statusSpy).toHaveBeenCalledWith(502);
  });

  it("still accepts an exact integer balance when no rawBalance is offered", async () => {
    // Hardening must not narrow what the upstream can legitimately send: below 2^53
    // a JSON number IS the exact value (USDC's real top holders look like this).
    const { body, statusSpy } = await scan({
      top: JSON.stringify({ holders: [{ address: `0x${"e".repeat(40)}`, balance: 4187687406315896 }] }),
    });
    expect(statusSpy).not.toHaveBeenCalledWith(502);
    expect(body.holders[0].balance).toBe("4187687406315896");
  });

  it("still drops a row that is not an EVM address", async () => {
    const { body } = await scan({
      top: JSON.stringify({
        holders: [{ address: "not-an-address", rawBalance: "5" }, { address: `0x${"f".repeat(40)}`, rawBalance: "7" }],
      }),
    });
    expect(body.holders).toEqual([{ address: `0x${"f".repeat(40)}`, balance: "7", isContract: false }]);
  });

  it("does NOT publish a totalSupply it could not read", async () => {
    // `String(info.totalSupply)` yields "1e+21" for any JSON number ≥ 1e21 — the
    // size a meme-coin supply actually is — and the client's toBig stripped the
    // non-digits down to 121n, then published 100% concentration and a fired
    // single-holder-majority gate off it.
    const top = JSON.stringify({ holders: [{ address: `0x${"a".repeat(40)}`, rawBalance: "100" }] });
    for (const totalSupply of [1e21, "1e+21", "abc", "1.5", ""]) {
      const { statusSpy, headers } = await scan({ info: JSON.stringify({ totalSupply }), top });
      expect(statusSpy, String(totalSupply)).toHaveBeenCalledWith(502);
      expect(headers["Cache-Control"]).toBe("no-store");
    }
  });

  it("keeps an absent totalSupply as the documented gap it is", async () => {
    // The explorer does not always report one. That is an ANSWER: the client leaves
    // it undefined and the core's fallback to the enumerated sum is disclosed by the
    // coverage notes. Only a PRESENT-but-unreadable total is a failed read.
    const top = JSON.stringify({ holders: [{ address: `0x${"a".repeat(40)}`, rawBalance: "100" }] });
    const { body, statusSpy } = await scan({ info: JSON.stringify({ name: "T", symbol: "T" }), top });
    expect(statusSpy).not.toHaveBeenCalledWith(502);
    expect(body.totalSupply).toBeNull();
  });

  it("does NOT read a throttled getTokenInfo as 'the explorer reported no total'", async () => {
    // ⚠ The defect a typeof-object check cannot see. Ethplorer reports a rate-limit
    // as an {error:{code}} envelope — which IS an object — and the two calls race
    // one API key in parallel, so exactly one of them being rejected is routine
    // (reproduced live on `freekey`). Publishing `totalSupply: null` here makes the
    // core substitute the enumerated top-100 sum as the denominator, inflating every
    // share by 1/coverage under a tile captioned "of total supply", and a big enough
    // holder then crosses the 50% single-holder-majority gate — cached for 120s.
    const top = JSON.stringify({ holders: [{ address: `0x${"a".repeat(40)}`, rawBalance: "100" }] });
    const throttled = upstream(JSON.stringify({ error: { code: 429, message: "Request limit is reached" } }), {
      ok: false,
      status: 429,
    });
    const { statusSpy, headers, body } = await scan({ info: throttled, top });
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(body).not.toHaveProperty("totalSupply");
  });

  it("catches a 200-with-error-envelope on the info leg too", async () => {
    // The same envelope under HTTP 200 — `infoRes.ok` alone would miss this one.
    const top = JSON.stringify({ holders: [{ address: `0x${"a".repeat(40)}`, rawBalance: "100" }] });
    const { statusSpy } = await scan({ info: JSON.stringify({ error: { code: 429 } }), top });
    expect(statusSpy).toHaveBeenCalledWith(502);
  });

  it("catches a non-2xx info leg that still parses as JSON", async () => {
    const top = JSON.stringify({ holders: [{ address: `0x${"a".repeat(40)}`, rawBalance: "100" }] });
    const { statusSpy } = await scan({ info: upstream(JSON.stringify({ ok: false }), { ok: false, status: 500 }), top });
    expect(statusSpy).toHaveBeenCalledWith(502);
  });

  it("does not manufacture an empty holder set by discarding every row", async () => {
    // Rows arrived; none were attributable. Deriving `holders: []` from that is the
    // same laundering in slow motion — the client renders it as "No holder data for
    // this token" and the CDN keeps it for 120s. Non-empty in, empty out, is drift.
    const { statusSpy, headers } = await scan({
      top: JSON.stringify({ holders: [{ address: "not-an-address", rawBalance: "5" }, { address: "0xzz", rawBalance: "6" }] }),
    });
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(headers["Cache-Control"]).toBe("no-store");
  });

  it("treats an unparsable token-info body as a failed read, not as five nulls", async () => {
    // getTokenInfo carries the denominator. Degrading it to `{}` published a scan
    // whose every percentage divided by a substituted enumerated sum, from a read
    // that never happened.
    const top = JSON.stringify({ holders: [{ address: `0x${"a".repeat(40)}`, rawBalance: "100" }] });
    const { statusSpy, headers } = await scan({ info: "<!doctype html><title>502</title>", top });
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(headers["Cache-Control"]).toBe("no-store");
  });

  it("serves the fully readable payload uncut", async () => {
    const { body, statusSpy, headers } = await scan({
      top: JSON.stringify({ holders: [{ address: HOLDER.address, rawBalance: "12345", isContract: true }] }),
    });
    expect(statusSpy).not.toHaveBeenCalledWith(502);
    expect(headers["Cache-Control"]).toMatch(/s-maxage/);
    expect(body).toMatchObject({
      chain: "ethereum",
      symbol: "SHIB",
      decimals: 18,
      totalSupply: "999982329055168014311278372706779",
      holdersCount: 1678265,
      source: "ethplorer",
      holders: [{ address: HOLDER.address, balance: "12345", isContract: true }],
    });
  });
});
