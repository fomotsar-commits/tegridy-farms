// Jupiter is retiring its keyless lite-api host. The /api/jupiter proxy carries
// every Solana swap (with the venue's platform fee) and every pool price check,
// so these pin: no key = lite-api exactly as before; a server-only
// JUPITER_API_KEY = api.jup.ag with `x-api-key`; a 401/403/429 there is tried
// once on lite-api, nothing else is; the fee settings reach Jupiter unchanged on
// both hosts; the key never comes back out; other providers are untouched.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true), checkGlobalLimit: vi.fn(async () => true) }));

const AGG_HANDLER = "../aggregator.js";
const LITE = "https://lite-api.jup.ag";
const KEYED = "https://api.jup.ag";
const FAKE_JUP = "fake-jupiter-test-value";

const QUOTE_QUERY = {
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2",
  amount: "50000000",
  slippageBps: "50",
  platformFeeBps: "50",
};
const QUOTE_SEARCH =
  "inputMint=So11111111111111111111111111111111111111112&outputMint=64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2&amount=50000000&slippageBps=50&platformFeeBps=50";
const SWAP_BODY = {
  quoteResponse: { inAmount: "50000000", outAmount: "123", platformFee: { amount: "1", feeBps: 50 } },
  userPublicKey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  feeAccount: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  wrapAndUnwrapSol: true,
};

function makeReq({ method = "GET", query = {}, body = null } = {}) {
  return { method, query, body, headers: { origin: "https://tegridyfarms.vercel.app" } };
}

function makeRes() {
  const headerSpy = vi.fn();
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const sendSpy = vi.fn();
  const res = {
    setHeader: (k, v) => { headerSpy(k, v); return res; },
    status: (c) => { statusSpy(c); return res; },
    json: (p) => { jsonSpy(p); return res; },
    send: (p) => { sendSpy(p); return res; },
    end: vi.fn(),
  };
  return { res, headerSpy, statusSpy, jsonSpy, sendSpy };
}

// Each step answers one upstream call in order: { status, payload } or an Error to throw.
function upstream(...steps) {
  let i = 0;
  return vi.fn(async () => {
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: () => null },
      body: null,
      text: async () => JSON.stringify(step.payload),
    };
  });
}

const callUrl = (fetchMock, n) => new URL(String(fetchMock.mock.calls[n][0]));
const callHeaders = (fetchMock, n) => fetchMock.mock.calls[n][1].headers;
const callBody = (fetchMock, n) => fetchMock.mock.calls[n][1].body;

let handler;
let consoleSpies;

beforeEach(async () => {
  vi.resetModules();
  process.env.NODE_ENV = "test";
  delete process.env.JUPITER_API_KEY;
  consoleSpies = ["error", "warn", "log", "info"].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  handler = (await import(AGG_HANDLER)).default;
});

afterEach(() => {
  delete process.env.JUPITER_API_KEY;
  delete process.env.NODE_ENV;
  for (const spy of consoleSpies) spy.mockRestore();
});

async function run(req) {
  const out = makeRes();
  await handler(req, out.res);
  return out;
}
const quoteReq = () => makeReq({ method: "GET", query: { provider: "jupiter", path: ["swap", "v1", "quote"], ...QUOTE_QUERY } });
const swapReq = () => makeReq({ method: "POST", query: { provider: "jupiter", path: ["swap", "v1", "swap"] }, body: SWAP_BODY });

describe("jupiter key — host and header", () => {
  it("no key: lite-api, no key header, the same URL and headers as before", async () => {
    globalThis.fetch = upstream({ status: 200, payload: { ok: 1 } });
    const { statusSpy } = await run(quoteReq());
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(String(globalThis.fetch.mock.calls[0][0])).toBe(`${LITE}/swap/v1/quote?${QUOTE_SEARCH}`);
    expect(callHeaders(globalThis.fetch, 0)).toEqual({ Accept: "application/json" });
  });

  it("a blank or whitespace-only key counts as unset", async () => {
    for (const blank of ["", "   ", "\n\t "]) {
      process.env.JUPITER_API_KEY = blank;
      globalThis.fetch = upstream({ status: 200, payload: { ok: 1 } });
      await run(quoteReq());
      expect(callUrl(globalThis.fetch, 0).origin).toBe(LITE);
      expect(callHeaders(globalThis.fetch, 0)).toEqual({ Accept: "application/json" });
    }
  });

  it("key set: api.jup.ag with x-api-key carrying the exact (trimmed) key", async () => {
    process.env.JUPITER_API_KEY = `  ${FAKE_JUP}\n`;
    globalThis.fetch = upstream({ status: 200, payload: { ok: 1 } });
    const { statusSpy } = await run(quoteReq());
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(String(globalThis.fetch.mock.calls[0][0])).toBe(`${KEYED}/swap/v1/quote?${QUOTE_SEARCH}`);
    expect(callHeaders(globalThis.fetch, 0)).toEqual({ Accept: "application/json", "x-api-key": FAKE_JUP });
  });

  it("reads the key per request, not once at import", async () => {
    globalThis.fetch = upstream({ status: 200, payload: { ok: 1 } });
    await run(quoteReq());
    process.env.JUPITER_API_KEY = FAKE_JUP;
    await run(quoteReq());
    delete process.env.JUPITER_API_KEY;
    await run(quoteReq());
    expect([0, 1, 2].map((n) => callUrl(globalThis.fetch, n).origin)).toEqual([LITE, KEYED, LITE]);
  });
});

describe("jupiter key — the 0.5% fee settings reach Jupiter unchanged on both hosts", () => {
  it("platformFeeBps in the quote query string", async () => {
    globalThis.fetch = upstream({ status: 200, payload: { ok: 1 } });
    await run(quoteReq());
    process.env.JUPITER_API_KEY = FAKE_JUP;
    await run(quoteReq());
    const [lite, keyed] = [callUrl(globalThis.fetch, 0), callUrl(globalThis.fetch, 1)];
    expect([lite.origin, keyed.origin]).toEqual([LITE, KEYED]);
    expect(lite.searchParams.get("platformFeeBps")).toBe("50");
    expect(keyed.searchParams.get("platformFeeBps")).toBe("50");
    expect(keyed.pathname + keyed.search).toBe(lite.pathname + lite.search);
  });

  // Without V2, a SOL fee on a coin that is Token-2022 is refused (Jupiter's 6014) and the
  // swap goes out with no fee: measured 2026-10-23 on SOL -> BAYLA.
  it("instructionVersion=V2 in the quote query string", async () => {
    const v2 = () => makeReq({ method: "GET", query: { provider: "jupiter", path: ["swap", "v1", "quote"], ...QUOTE_QUERY, instructionVersion: "V2" } });
    globalThis.fetch = upstream({ status: 200, payload: { ok: 1 } });
    await run(v2());
    process.env.JUPITER_API_KEY = FAKE_JUP;
    await run(v2());
    const [lite, keyed] = [callUrl(globalThis.fetch, 0), callUrl(globalThis.fetch, 1)];
    expect([lite.origin, keyed.origin]).toEqual([LITE, KEYED]);
    expect(lite.searchParams.get("instructionVersion")).toBe("V2");
    expect(keyed.searchParams.get("instructionVersion")).toBe("V2");
    expect(keyed.searchParams.get("platformFeeBps")).toBe("50");
  });

  it("feeAccount in the POST /swap/v1/swap body, byte-identical", async () => {
    globalThis.fetch = upstream({ status: 200, payload: { swapTransaction: "tx" } });
    await run(swapReq());
    process.env.JUPITER_API_KEY = FAKE_JUP;
    await run(swapReq());
    expect([callUrl(globalThis.fetch, 0).origin, callUrl(globalThis.fetch, 1).origin]).toEqual([LITE, KEYED]);
    const [liteBody, keyedBody] = [callBody(globalThis.fetch, 0), callBody(globalThis.fetch, 1)];
    expect(liteBody).toBe(JSON.stringify(SWAP_BODY));
    expect(keyedBody).toBe(liteBody);
    expect(JSON.parse(keyedBody).feeAccount).toBe(SWAP_BODY.feeAccount);
  });
});

describe("jupiter key — one fallback to lite-api, only when the gateway refused the call", () => {
  for (const refused of [401, 403, 404, 429]) {
    it(`keyed ${refused}: the same GET once more on lite-api without the key, and its answer is returned`, async () => {
      process.env.JUPITER_API_KEY = FAKE_JUP;
      globalThis.fetch = upstream({ status: refused, payload: { error: "refused" } }, { status: 200, payload: { from: "lite" } });
      const { statusSpy, sendSpy } = await run(quoteReq());
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(String(globalThis.fetch.mock.calls[0][0])).toBe(`${KEYED}/swap/v1/quote?${QUOTE_SEARCH}`);
      expect(String(globalThis.fetch.mock.calls[1][0])).toBe(`${LITE}/swap/v1/quote?${QUOTE_SEARCH}`);
      expect(callHeaders(globalThis.fetch, 1)).toEqual({ Accept: "application/json" });
      // One budget for both tries: the retry rides the first try's deadline.
      expect(globalThis.fetch.mock.calls[1][1].signal).toBe(globalThis.fetch.mock.calls[0][1].signal);
      expect(statusSpy).toHaveBeenCalledWith(200);
      expect(sendSpy).toHaveBeenCalledWith(JSON.stringify({ from: "lite" }));
      const warns = console.warn.mock.calls.map((c) => c.join(" "));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(String(refused));
      expect(warns[0]).toContain(LITE);
    });
  }

  it("a POST refused with 401 is retried once with the same body", async () => {
    process.env.JUPITER_API_KEY = FAKE_JUP;
    globalThis.fetch = upstream({ status: 401, payload: { error: "bad key" } }, { status: 200, payload: { signature: "sig" } });
    const body = { signedTransaction: "AQID", requestId: "req-1" };
    const { statusSpy } = await run(makeReq({ method: "POST", query: { provider: "jupiter", path: ["trigger", "v1", "execute"] }, body }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect([callUrl(globalThis.fetch, 0).origin, callUrl(globalThis.fetch, 1).origin]).toEqual([KEYED, LITE]);
    expect(callBody(globalThis.fetch, 1)).toBe(JSON.stringify(body));
    expect(callBody(globalThis.fetch, 1)).toBe(callBody(globalThis.fetch, 0));
    expect(callHeaders(globalThis.fetch, 1)).toEqual({ Accept: "application/json", "Content-Type": "application/json" });
    expect(statusSpy).toHaveBeenCalledWith(200);
  });

  it("a POST answered 500 is NOT retried (it may have been processed)", async () => {
    process.env.JUPITER_API_KEY = FAKE_JUP;
    globalThis.fetch = upstream({ status: 500, payload: { error: "boom" } }, { status: 200, payload: {} });
    const { statusSpy, jsonSpy } = await run(makeReq({ method: "POST", query: { provider: "jupiter", path: ["trigger", "v1", "execute"] }, body: { signedTransaction: "AQID" } }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(callUrl(globalThis.fetch, 0).origin).toBe(KEYED);
    expect(statusSpy).toHaveBeenCalledWith(502);
    expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream service error" });
  });

  it("keyed 500 on a GET: no retry, 502 as today", async () => {
    process.env.JUPITER_API_KEY = FAKE_JUP;
    globalThis.fetch = upstream({ status: 500, payload: { error: "boom" } }, { status: 200, payload: {} });
    const { statusSpy } = await run(quoteReq());
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(callUrl(globalThis.fetch, 0).origin).toBe(KEYED);
    expect(statusSpy).toHaveBeenCalledWith(502);
  });

  it("a thrown fetch error or timeout: no retry, 502 as today", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    for (const err of [new TypeError("fetch failed"), timeout]) {
      process.env.JUPITER_API_KEY = FAKE_JUP;
      globalThis.fetch = upstream(err, { status: 200, payload: {} });
      const { statusSpy, jsonSpy } = await run(quoteReq());
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(callUrl(globalThis.fetch, 0).origin).toBe(KEYED);
      expect(statusSpy).toHaveBeenCalledWith(502);
      expect(jsonSpy).toHaveBeenCalledWith({ error: "Upstream service error" });
    }
  });

  it("only one fallback: a refused retry is a 502, not a third call", async () => {
    process.env.JUPITER_API_KEY = FAKE_JUP;
    globalThis.fetch = upstream({ status: 429, payload: {} }, { status: 429, payload: {} }, { status: 200, payload: {} });
    const { statusSpy } = await run(quoteReq());
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(statusSpy).toHaveBeenCalledWith(502);
  });
});

describe("jupiter key — the key never leaves the server", () => {
  it("is sent to Jupiter, and appears in no response body, response header or log line", async () => {
    process.env.JUPITER_API_KEY = FAKE_JUP;
    const scenarios = [
      () => upstream({ status: 200, payload: { ok: 1 } }),
      () => upstream({ status: 401, payload: { error: "bad key" } }, { status: 200, payload: { ok: 1 } }),
      () => upstream({ status: 403, payload: { error: "no access" } }, { status: 503, payload: { error: "down" } }),
      () => upstream({ status: 500, payload: { error: "boom" } }),
      () => upstream({ status: 400, payload: { errorCode: "NO_ROUTES_FOUND" } }),
      () => upstream(new TypeError("fetch failed")),
    ];
    for (const scenario of scenarios) {
      for (const req of [quoteReq(), swapReq()]) {
        globalThis.fetch = scenario();
        const { headerSpy, jsonSpy, sendSpy } = await run(req);
        const out = JSON.stringify([headerSpy.mock.calls, jsonSpy.mock.calls, sendSpy.mock.calls]);
        expect(out).not.toContain(FAKE_JUP);
        // The key did go upstream: this is not passing because the key was never used.
        expect(callHeaders(globalThis.fetch, 0)["x-api-key"]).toBe(FAKE_JUP);
      }
    }
    const logged = JSON.stringify(consoleSpies.map((s) => s.mock.calls));
    expect(console.warn).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
    expect(logged).not.toContain(FAKE_JUP);
  });
});

describe("jupiter key — other providers are untouched", () => {
  it("odos: same host, same headers, and a 401 is a plain 502 with no retry", async () => {
    process.env.JUPITER_API_KEY = FAKE_JUP;
    const body = { chainId: 1, inputTokens: [], outputTokens: [] };
    const req = () => makeReq({ method: "POST", query: { provider: "odos", path: ["sor", "quote", "v2"] }, body });
    globalThis.fetch = upstream({ status: 200, payload: { ok: 1 } });
    const ok = await run(req());
    expect(ok.statusSpy).toHaveBeenCalledWith(200);
    expect(String(globalThis.fetch.mock.calls[0][0])).toBe("https://api.odos.xyz/sor/quote/v2");
    expect(callHeaders(globalThis.fetch, 0)).toEqual({ Accept: "application/json", "Content-Type": "application/json" });
    expect(callBody(globalThis.fetch, 0)).toBe(JSON.stringify(body));

    globalThis.fetch = upstream({ status: 401, payload: {} }, { status: 200, payload: {} });
    const refused = await run(req());
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(refused.statusSpy).toHaveBeenCalledWith(502);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("kyber: its own fixed header and nothing else", async () => {
    process.env.JUPITER_API_KEY = FAKE_JUP;
    globalThis.fetch = upstream({ status: 429, payload: {} }, { status: 200, payload: {} });
    await run(makeReq({ method: "GET", query: { provider: "kyber", path: ["ethereum", "api", "v1", "routes"], tokenIn: "0xeee", tokenOut: "0xeee", amountIn: "1" } }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(String(globalThis.fetch.mock.calls[0][0])).toBe("https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=0xeee&tokenOut=0xeee&amountIn=1");
    expect(callHeaders(globalThis.fetch, 0)).toEqual({ Accept: "application/json", "X-Client-Id": "tegridy-farms" });
  });
});
