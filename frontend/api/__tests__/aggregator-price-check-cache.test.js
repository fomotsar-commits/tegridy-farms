// The LP price check (src/lib/solana/lp/outsidePrice.ts) reads two Jupiter quotes per
// pool through /api/jupiter, and every visitor used to make them afresh, so under load
// (and on the key's 60 a minute) an unread check held Add buttons back. Its quotes, and
// the island order's price read, are now kept at Vercel's edge for 30 seconds. These
// pin: the price check's and the price read's 200 answers are shareable; the marker never
// reaches Jupiter; the swap page's quotes, a fee-bearing quote, the swap build, every
// other path and every error stay private, no-store; the fee settings still reach
// Jupiter unchanged.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true), checkGlobalLimit: vi.fn(async () => true) }));

const AGG_HANDLER = "../aggregator.js";
const LITE = "https://lite-api.jup.ag";
const SHARED = "s-maxage=30, stale-while-revalidate=15";
const PRIVATE = "private, no-store";

// The price check's exact query (outsidePrice.ts `quote`): no fee, plus the marker.
const PRICE_CHECK = {
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2",
  amount: "50000000",
  slippageBps: "50",
  swapMode: "ExactIn",
  restrictIntermediateTokens: "true",
  priceCheck: "1",
};
const { priceCheck: _marker, ...SWAP_QUOTE } = PRICE_CHECK;
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
  const res = {
    setHeader: (k, v) => { headerSpy(k, v); return res; },
    status: (c) => { statusSpy(c); return res; },
    json: () => res,
    send: () => res,
    end: vi.fn(),
  };
  return { res, headerSpy, statusSpy };
}

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

/** Every Cache-Control the handler set, in order. */
const cacheHeaders = (headerSpy) => headerSpy.mock.calls.filter(([k]) => k === "Cache-Control").map(([, v]) => v);

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
const jupiter = (path, query = {}, method = "GET", body = null) =>
  makeReq({ method, query: { provider: "jupiter", path, ...query }, body });

describe("the price check's quote is kept at the edge for 30 seconds", () => {
  it("a 200 answer to the price check's quote is shareable, on the free host and the keyed one", async () => {
    for (const key of [undefined, "fake-jupiter-test-value"]) {
      if (key) process.env.JUPITER_API_KEY = key;
      globalThis.fetch = upstream({ status: 200, payload: { outAmount: "1" } });
      const { statusSpy, headerSpy } = await run(jupiter(["swap", "v1", "quote"], PRICE_CHECK));
      expect(statusSpy).toHaveBeenCalledWith(200);
      expect(cacheHeaders(headerSpy)).toEqual([SHARED]);
    }
  });

  it("the marker never reaches Jupiter: the upstream call is the swap page's own, to the byte", async () => {
    globalThis.fetch = upstream({ status: 200, payload: {} });
    await run(jupiter(["swap", "v1", "quote"], PRICE_CHECK));
    await run(jupiter(["swap", "v1", "quote"], SWAP_QUOTE));
    const [marked, plain] = globalThis.fetch.mock.calls.map((c) => String(c[0]));
    expect(marked).toBe(plain);
    expect(new URL(marked).searchParams.has("priceCheck")).toBe(false);
    expect(new URL(marked).origin).toBe(LITE);
  });
});

describe("the island order's price read is kept at the edge for 30 seconds", () => {
  const IDS = "So11111111111111111111111111111111111111112,7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";

  it("a 200 answer with the marker is shareable, on the free host and the keyed one; without it, private", async () => {
    for (const key of [undefined, "fake-jupiter-test-value"]) {
      if (key) process.env.JUPITER_API_KEY = key;
      globalThis.fetch = upstream({ status: 200, payload: { So11111111111111111111111111111111111111112: { usdPrice: 100 } } });
      const marked = await run(jupiter(["price", "v3"], { ids: IDS, priceCheck: "1" }));
      expect(marked.statusSpy).toHaveBeenCalledWith(200);
      expect(cacheHeaders(marked.headerSpy)).toEqual([SHARED]);
      const plain = await run(jupiter(["price", "v3"], { ids: IDS }));
      expect(cacheHeaders(plain.headerSpy)).toEqual([PRIVATE]);
    }
  });

  it("the marker never reaches Jupiter: the upstream call is the plain price read, to the byte", async () => {
    globalThis.fetch = upstream({ status: 200, payload: {} });
    await run(jupiter(["price", "v3"], { ids: IDS, priceCheck: "1" }));
    await run(jupiter(["price", "v3"], { ids: IDS }));
    const [marked, plain] = globalThis.fetch.mock.calls.map((c) => String(c[0]));
    expect(marked).toBe(plain);
    expect(new URL(marked).searchParams.has("priceCheck")).toBe(false);
  });

  it("a price read that failed is never kept", async () => {
    globalThis.fetch = upstream({ status: 500, payload: {} });
    const { headerSpy } = await run(jupiter(["price", "v3"], { ids: IDS, priceCheck: "1" }));
    expect(cacheHeaders(headerSpy).every((v) => !/s-maxage/.test(v))).toBe(true);
  });
});

describe("what every visitor asks alike is kept at the edge with no marker", () => {
  const TRENDING = "s-maxage=300, stale-while-revalidate=60";
  const SHIELD = "s-maxage=60, stale-while-revalidate=30";
  const MINTS = "So11111111111111111111111111111111111111112,7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";

  it("the trending lists are shared for 5 minutes, on the free host and the keyed one", async () => {
    for (const key of [undefined, "fake-jupiter-test-value"]) {
      if (key) process.env.JUPITER_API_KEY = key;
      for (const list of ["toptrending", "toptraded", "toporganicscore"]) {
        globalThis.fetch = upstream({ status: 200, payload: [] });
        const { statusSpy, headerSpy } = await run(jupiter(["tokens", "v2", list, "24h"], { limit: "12" }));
        expect(statusSpy).toHaveBeenCalledWith(200);
        expect(cacheHeaders(headerSpy)).toEqual([TRENDING]);
      }
    }
  });

  it("Shield's warnings are shared for 1 minute, on the free host and the keyed one", async () => {
    for (const key of [undefined, "fake-jupiter-test-value"]) {
      if (key) process.env.JUPITER_API_KEY = key;
      globalThis.fetch = upstream({ status: 200, payload: { warnings: {} } });
      const { statusSpy, headerSpy } = await run(jupiter(["ultra", "v1", "shield"], { mints: MINTS }));
      expect(statusSpy).toHaveBeenCalledWith(200);
      expect(cacheHeaders(headerSpy)).toEqual([SHIELD]);
    }
  });

  it("Shield answered by the free host after the keyed one turned it away is shared like any answer", async () => {
    process.env.JUPITER_API_KEY = "fake-jupiter-test-value";
    globalThis.fetch = upstream({ status: 404, payload: {} }, { status: 200, payload: { warnings: {} } });
    const { statusSpy, headerSpy } = await run(jupiter(["ultra", "v1", "shield"], { mints: MINTS }));
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(String(globalThis.fetch.mock.calls[1][0])).toMatch(/^https:\/\/lite-api\.jup\.ag\//);
    expect(cacheHeaders(headerSpy)).toEqual([SHIELD]);
  });

  it("a trending list or a Shield read that failed is never kept", async () => {
    for (const req of [jupiter(["tokens", "v2", "toptrending", "24h"], { limit: "12" }), jupiter(["ultra", "v1", "shield"], { mints: MINTS })]) {
      globalThis.fetch = upstream({ status: 500, payload: {} });
      const { headerSpy } = await run(req);
      expect(cacheHeaders(headerSpy).every((v) => !/s-maxage/.test(v))).toBe(true);
    }
  });
});

describe("nothing else is ever kept at the edge", () => {
  it("the swap page's quote (no marker), with or without the 0.5% fee, stays private", async () => {
    for (const query of [SWAP_QUOTE, { ...SWAP_QUOTE, platformFeeBps: "50" }]) {
      globalThis.fetch = upstream({ status: 200, payload: {} });
      const { statusSpy, headerSpy } = await run(jupiter(["swap", "v1", "quote"], query));
      expect(statusSpy).toHaveBeenCalledWith(200);
      expect(cacheHeaders(headerSpy)).toEqual([PRIVATE]);
    }
  });

  it("a quote asking for the fee is a trade: never shared even with the marker, and the fee reaches Jupiter unchanged", async () => {
    globalThis.fetch = upstream({ status: 200, payload: {} });
    const { headerSpy } = await run(jupiter(["swap", "v1", "quote"], { ...PRICE_CHECK, platformFeeBps: "50" }));
    expect(cacheHeaders(headerSpy)).toEqual([PRIVATE]);
    expect(new URL(String(globalThis.fetch.mock.calls[0][0])).searchParams.get("platformFeeBps")).toBe("50");
  });

  it("the swap build (POST) is never shared, marker or not, and its feeAccount body reaches Jupiter byte-identical", async () => {
    for (const query of [{}, { priceCheck: "1" }]) {
      globalThis.fetch = upstream({ status: 200, payload: { swapTransaction: "tx" } });
      const { statusSpy, headerSpy } = await run(jupiter(["swap", "v1", "swap"], query, "POST", SWAP_BODY));
      expect(statusSpy).toHaveBeenCalledWith(200);
      expect(cacheHeaders(headerSpy)).toEqual([PRIVATE]);
      expect(globalThis.fetch.mock.calls[0][1].body).toBe(JSON.stringify(SWAP_BODY));
    }
  });

  it("a POST to the quote path, marker and all, is never shared even on a 200", async () => {
    globalThis.fetch = upstream({ status: 200, payload: {} });
    const { statusSpy, headerSpy } = await run(jupiter(["swap", "v1", "quote"], PRICE_CHECK, "POST", {}));
    expect(statusSpy).toHaveBeenCalledWith(200);
    expect(cacheHeaders(headerSpy)).toEqual([PRIVATE]);
  });

  it("another Jupiter path carrying the marker is not shared: a visitor's token search", async () => {
    for (const [path, query] of [
      [["tokens", "v2", "search"], { query: "bayla", priceCheck: "1" }],
      [["tokens", "v2", "search"], { query: "bayla" }],
    ]) {
      globalThis.fetch = upstream({ status: 200, payload: {} });
      const { headerSpy } = await run(jupiter(path, query));
      expect(cacheHeaders(headerSpy)).toEqual([PRIVATE]);
    }
  });

  it("an error is never kept as if it were a price: 500, no route, a refused retry, a thrown fetch", async () => {
    process.env.JUPITER_API_KEY = "fake-jupiter-test-value";
    const scenarios = [
      [() => upstream({ status: 500, payload: { error: "boom" } }), 502],
      [() => upstream({ status: 400, payload: { errorCode: "NO_ROUTES_FOUND" } }), 404],
      [() => upstream({ status: 429, payload: {} }, { status: 429, payload: {} }), 502],
      [() => upstream(new TypeError("fetch failed")), 502],
    ];
    for (const [scenario, status] of scenarios) {
      globalThis.fetch = scenario();
      const { statusSpy, headerSpy } = await run(jupiter(["swap", "v1", "quote"], PRICE_CHECK));
      expect(statusSpy).toHaveBeenCalledWith(status);
      expect(cacheHeaders(headerSpy)).not.toContain(SHARED);
      expect(cacheHeaders(headerSpy).every((v) => !/s-maxage/.test(v))).toBe(true);
    }
  });

  it("other providers are untouched: an EVM quote stays private", async () => {
    globalThis.fetch = upstream({ status: 200, payload: {} });
    const { headerSpy } = await run(
      makeReq({ query: { provider: "kyber", path: ["ethereum", "api", "v1", "routes"], tokenIn: "0xeee", tokenOut: "0xeee", amountIn: "1", priceCheck: "1" } }),
    );
    expect(cacheHeaders(headerSpy)).toEqual([PRIVATE]);
  });
});
