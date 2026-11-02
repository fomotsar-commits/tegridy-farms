// /api/outside-prices (island answer twenty-four, build 1b): every listed pool's outside
// price in one answer, read once for everyone. These pin: the loop prices each token the
// way outsidePrice.ts does (0.05 SOL in, the sale back at the buy's return rounded to two
// figures), paces Jupiter to the key's plan and never bursts, keeps the answer at the edge
// with ten minutes of stale-while-revalidate, says a token it could not price as unread
// with the last good read beside it, refuses a price through our own pools, and answers a
// loop that priced nothing as 502 no-store so the edge keeps the last good answer.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({ checkRateLimit: vi.fn(async () => true), checkGlobalLimit: vi.fn(async () => true) }));

import handler from "../outside-prices.js";
import { __resetOutsidePrices, probeAmount, midPrice, spacingMs, tokensOf, FRESH_FOR_MS, SWR_SECS } from "../_lib/outside-prices.js";
import { CP_SWAP_PROGRAM, WSOL_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, OFFSETS } from "../_lib/pool-index.js";
import { base58 } from "@scure/base";

const BAYLA = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_DEX = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const ROUTE_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

function makeReq({ method = "GET", query = {}, headers = { origin: "https://tegridyfarms.vercel.app" } } = {}) {
  return { method, query, headers };
}
function makeRes() {
  const out = { status: 0, body: undefined, headers: {} };
  const res = {
    setHeader: (k, v) => ((out.headers[k] = v), res),
    status: (c) => ((out.status = c), res),
    json: (b) => ((out.body = b), res),
    end: () => res,
  };
  return { res, out };
}

/** A pool slice: 64 bytes holding token0Mint then token1Mint, as the scan asks for them. */
function poolSlice(mint0, mint1) {
  const d = Buffer.alloc(64);
  Buffer.from(base58.decode(mint0)).copy(d, 0);
  Buffer.from(base58.decode(mint1)).copy(d, 32);
  return d.toString("base64");
}

/**
 * The chain and Jupiter behind one loop. `pools` lists the venue; `price` prices a mint in SOL
 * (or 'no-route', or an HTTP status to refuse with); `owners` is who owns each route pool.
 */
function world({ pools, price, owners = { [ROUTE_POOL]: OTHER_DEX }, decimals = { [BAYLA]: 6, [USDC]: 6 }, usd = {} } = {}) {
  const jupiterCalls = [];
  const chainCalls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    const u = String(url);
    if (u.includes("jup.ag")) {
      jupiterCalls.push({ at: Date.now(), url: u, headers: init?.headers ?? {} });
      if (u.includes("/price/v3?ids=")) {
        if (usd === "refused") return new Response("refused", { status: 429 });
        const ids = new URL(u).searchParams.get("ids").split(",");
        return new Response(JSON.stringify(Object.fromEntries(ids.map((id) => [id, { usdPrice: usd[id] ?? 1.5 }]))), { status: 200 });
      }
      const q = new URL(u).searchParams;
      const input = q.get("inputMint");
      const output = q.get("outputMint");
      const amount = BigInt(q.get("amount"));
      const mint = input === WSOL_MINT ? output : input;
      const p = typeof price === "function" ? price(mint, input === WSOL_MINT ? "buy" : "sell") : price[mint];
      if (p === "no-route") return new Response(JSON.stringify({ errorCode: "NO_ROUTES_FOUND" }), { status: 400 });
      if (typeof p === "number" && p >= 100) return new Response("refused", { status: p });
      const dec = decimals[mint] ?? 6;
      const fee = 0.01;
      const out = input === WSOL_MINT ? BigInt(Math.floor((Number(amount) / 1e9 / p) * 10 ** dec * (1 - fee))) : BigInt(Math.floor((Number(amount) / 10 ** dec) * p * 1e9 * (1 - fee)));
      return new Response(JSON.stringify({ inputMint: input, outputMint: output, inAmount: amount.toString(), outAmount: out.toString(), routePlan: [{ swapInfo: { ammKey: ROUTE_POOL } }] }), { status: 200 });
    }
    // The chain.
    const body = JSON.parse(init.body);
    chainCalls.push(body.method);
    if (body.method === "getProgramAccounts") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: pools.map(([mint0, mint1], i) => ({ pubkey: `pool${i}`, account: { data: [poolSlice(mint0, mint1), "base64"] } })) }));
    }
    if (body.method === "getMultipleAccounts") {
      const [keys, opts] = body.params;
      const value = keys.map((k) => {
        if (opts.dataSlice.offset === 44) {
          const d = decimals[k];
          return d === undefined ? null : { owner: k === BAYLA ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM, data: [Buffer.from([d]).toString("base64"), "base64"] };
        }
        return k in owners ? { owner: owners[k], data: ["", "base64"] } : null;
      });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } }));
    }
    return new Response("nope", { status: 500 });
  });
  return { fetchImpl, jupiterCalls, chainCalls };
}

const sleep = vi.fn(async () => {});

beforeEach(() => {
  __resetOutsidePrices();
  process.env.SOLANA_RPC_URL = "https://keyed.test/?api-key=k";
  delete process.env.JUPITER_API_KEY;
  delete process.env.JUPITER_RATE_PER_SEC;
  delete process.env.OUTSIDE_PRICES_MAX_AGE_SEC;
  sleep.mockClear();
});
afterEach(() => {
  for (const k of ["SOLANA_RPC_URL", "JUPITER_API_KEY", "JUPITER_RATE_PER_SEC", "OUTSIDE_PRICES_MAX_AGE_SEC"]) delete process.env[k];
});

describe("probeAmount: the sale's amount repeats", () => {
  it("rounds the buy's return to two significant figures", () => {
    expect(probeAmount(13_371_337n)).toBe(13_000_000n);
    expect(probeAmount(13_571_337n)).toBe(14_000_000n);
    expect(probeAmount(99_900n)).toBe(100_000n);
    expect(probeAmount(42n)).toBe(42n);
    expect(probeAmount(0n)).toBe(0n);
  });
  it("the mid cancels a route's fee each way, at two different amounts", () => {
    // 1% off each way: the mid lands within a hair of the true price.
    const mid = midPrice({ tokensOut: 6_600_000_000n, probe: 6_600_000_000n, lamportsBack: 49_005_000n, decimals: 6 });
    expect(Math.abs(mid / 7.5e-6 - 1)).toBeLessThan(0.011);
  });
  it("paces to the key's plan: one a second on the free key, ten on the Developer plan", () => {
    expect(spacingMs({})).toBe(1100);
    expect(spacingMs({ JUPITER_RATE_PER_SEC: "10" })).toBe(200);
    expect(spacingMs({ JUPITER_RATE_PER_SEC: "nonsense" })).toBe(1100);
  });
  it("prices every mint in a pool that is not SOL, once each", () => {
    expect(tokensOf([{ mints: [WSOL_MINT, BAYLA] }, { mints: [USDC, BAYLA] }, { mints: [WSOL_MINT, USDC] }])).toEqual([BAYLA, USDC]);
  });
});

describe("GET /api/outside-prices", () => {
  it("answers every listed token's price in one JSON, kept at the edge for ten minutes past its age", async () => {
    const w = world({ pools: [[WSOL_MINT, BAYLA], [USDC, BAYLA]], price: { [BAYLA]: 7.5e-6, [USDC]: 0.0055 } });
    const { res, out } = makeRes();
    await handler(makeReq(), res, { fetchImpl: w.fetchImpl, sleep });
    expect(out.status).toBe(200);
    expect(out.headers["Cache-Control"]).toBe(`s-maxage=60, stale-while-revalidate=${SWR_SECS}`);
    expect(out.body.state).toBe("ok");
    expect(out.body.fresh_for_ms).toBe(FRESH_FOR_MS);
    expect(Object.keys(out.body.prices).sort()).toEqual([USDC, BAYLA].sort());
    const bayla = out.body.prices[BAYLA];
    expect(bayla.state).toBe("ok");
    expect(Math.abs(bayla.sol_per_token / 7.5e-6 - 1)).toBeLessThan(0.011);
    expect(typeof bayla.read_at).toBe("number");
    expect(bayla.pools).toEqual([ROUTE_POOL]);
    // The dollar prices ride the same loop: one price/v3 call for every token and SOL.
    expect(out.body.usd[BAYLA]).toBe(1.5);
    expect(out.body.usd[WSOL_MINT]).toBe(1.5);
    expect(typeof out.body.usd_read_at).toBe("number");
    const v3 = w.jupiterCalls.filter((c) => c.url.includes("/price/v3?ids="));
    expect(v3).toHaveLength(1);
    // First in the loop: the cheapest read, and the list's $ figures, before any quote.
    expect(w.jupiterCalls[0].url).toContain("/price/v3?ids=");
    expect(new URL(v3[0].url).searchParams.get("ids").split(",").sort()).toEqual([USDC, BAYLA, WSOL_MINT].sort());
    // Two quotes a token, the sale at the rounded probe, through the keyless host with no key set.
    expect(w.jupiterCalls.filter((c) => c.url.includes("/swap/v1/quote?"))).toHaveLength(4);
    const quotes = w.jupiterCalls.filter((c) => c.url.includes("/swap/v1/quote?"));
    const sale = new URL(quotes[1].url).searchParams;
    expect(sale.get("inputMint")).toBe(BAYLA);
    expect(sale.get("amount")).toBe(bayla.probe);
    expect(bayla.probe).toMatch(/^\d\d0+$/);
    expect(w.jupiterCalls.every((c) => c.url.startsWith("https://lite-api.jup.ag/"))).toBe(true);
    // The marker that shares a browser quote at our edge never goes to Jupiter.
    expect(w.jupiterCalls.every((c) => !c.url.includes("priceCheck"))).toBe(true);
  });

  it("paces Jupiter's calls one after another on the key's plan, never a burst", async () => {
    const w = world({ pools: [[WSOL_MINT, BAYLA], [WSOL_MINT, USDC]], price: { [BAYLA]: 7.5e-6, [USDC]: 0.0055 } });
    const { res } = makeRes();
    await handler(makeReq(), res, { fetchImpl: w.fetchImpl, sleep });
    // Five calls (four quotes and the dollar read): the first waits for nothing, each of the next four waits the plan's spacing (the stubs answer in 0 ms).
    expect(sleep).toHaveBeenCalledTimes(4);
    for (const [ms] of sleep.mock.calls) expect(ms).toBeGreaterThan(1000);
  });

  it("with the key set, asks the keyed host with the key in x-api-key and the Developer plan's spacing", async () => {
    process.env.JUPITER_API_KEY = "k-test";
    process.env.JUPITER_RATE_PER_SEC = "10";
    const w = world({ pools: [[WSOL_MINT, BAYLA]], price: { [BAYLA]: 7.5e-6 } });
    const { res, out } = makeRes();
    await handler(makeReq(), res, { fetchImpl: w.fetchImpl, sleep });
    expect(out.status).toBe(200);
    expect(w.jupiterCalls.every((c) => c.url.startsWith("https://api.jup.ag/") && c.headers["x-api-key"] === "k-test")).toBe(true);
    for (const [ms] of sleep.mock.calls) expect(ms).toBeLessThan(300);
  });

  it("a token Jupiter refuses is unread with this instance's last good read beside it, and the others still price", async () => {
    const good = world({ pools: [[WSOL_MINT, BAYLA], [WSOL_MINT, USDC]], price: { [BAYLA]: 7.5e-6, [USDC]: 0.0055 } });
    await handler(makeReq(), makeRes().res, { fetchImpl: good.fetchImpl, sleep });
    const w = world({ pools: [[WSOL_MINT, BAYLA], [WSOL_MINT, USDC]], price: { [BAYLA]: 429, [USDC]: 0.0055 } });
    const { res, out } = makeRes();
    await handler(makeReq(), res, { fetchImpl: w.fetchImpl, sleep });
    expect(out.status).toBe(200);
    expect(out.body.prices[USDC].state).toBe("ok");
    const b = out.body.prices[BAYLA];
    expect(b.state).toBe("unread");
    expect(b.detail).toContain("HTTP 429");
    expect(b.last).not.toBeNull();
    expect(Math.abs(b.last.sol_per_token / 7.5e-6 - 1)).toBeLessThan(0.011);
  });

  it("a 429 is tried once more after a pause of at least two seconds, and prices when the second answer does", async () => {
    let asked = 0;
    const w = world({ pools: [[WSOL_MINT, BAYLA]], price: (mint, leg) => (leg === "buy" && asked++ === 0 ? 429 : 7.5e-6) });
    const { res, out } = makeRes();
    await handler(makeReq(), res, { fetchImpl: w.fetchImpl, sleep });
    expect(out.status).toBe(200);
    expect(out.body.prices[BAYLA].state).toBe("ok");
    // Three quotes: the refused buy, the buy again after the pause, the sale (and then the dollar read).
    expect(w.jupiterCalls.filter((c) => c.url.includes("/swap/v1/quote?"))).toHaveLength(3);
    expect(sleep.mock.calls.some(([ms]) => ms >= 2000)).toBe(true);
  });

  it("a refused dollar read keeps this instance's last good dollar prices, and a cold instance answers none", async () => {
    const w = world({ pools: [[WSOL_MINT, BAYLA]], price: { [BAYLA]: 7.5e-6 }, usd: "refused" });
    const { res, out } = makeRes();
    await handler(makeReq(), res, { fetchImpl: w.fetchImpl, sleep });
    expect(out.status).toBe(200);
    expect(out.body.prices[BAYLA].state).toBe("ok");
    expect(out.body.usd).toBeNull();
    expect(out.body.usd_read_at).toBeNull();
    const good = world({ pools: [[WSOL_MINT, BAYLA]], price: { [BAYLA]: 7.5e-6 }, usd: { [BAYLA]: 0.001 } });
    await handler(makeReq(), makeRes().res, { fetchImpl: good.fetchImpl, sleep });
    const again = world({ pools: [[WSOL_MINT, BAYLA]], price: { [BAYLA]: 7.5e-6 }, usd: "refused" });
    const second = makeRes();
    await handler(makeReq(), second.res, { fetchImpl: again.fetchImpl, sleep });
    expect(second.out.body.usd[BAYLA]).toBe(0.001);
  });

  it("Jupiter's own no-route answer is no-route, never unread", async () => {
    const w = world({ pools: [[WSOL_MINT, BAYLA]], price: { [BAYLA]: "no-route" } });
    const { res, out } = makeRes();
    await handler(makeReq(), res, { fetchImpl: w.fetchImpl, sleep });
    expect(out.status).toBe(200);
    expect(out.body.prices[BAYLA]).toEqual({ state: "no-route", read_at: expect.any(Number) });
  });

  it("a price that came through our own pool program is not an outside price", async () => {
    const w = world({ pools: [[WSOL_MINT, BAYLA]], price: { [BAYLA]: 7.5e-6 }, owners: { [ROUTE_POOL]: CP_SWAP_PROGRAM } });
    const { res, out } = makeRes();
    await handler(makeReq(), res, { fetchImpl: w.fetchImpl, sleep });
    // The one token priced nothing: a refusal, kept out of the edge.
    expect(out.status).toBe(502);
    expect(out.headers["Cache-Control"]).toBe("private, no-store");
    expect(out.body.prices[BAYLA].state).toBe("unread");
    expect(out.body.prices[BAYLA].detail).toMatch(/our own pools/);
  });

  it("a loop that priced nothing is 502 no-store, so the edge keeps the last good answer; a chain that will not list pools is the same", async () => {
    const w = world({ pools: [[WSOL_MINT, BAYLA], [WSOL_MINT, USDC]], price: { [BAYLA]: 429, [USDC]: 502 } });
    const { res, out } = makeRes();
    await handler(makeReq(), res, { fetchImpl: w.fetchImpl, sleep });
    expect(out.status).toBe(502);
    expect(out.headers["Cache-Control"]).toBe("private, no-store");
    expect(out.body.state).toBe("unread");

    const dead = vi.fn(async () => new Response("down", { status: 503 }));
    const second = makeRes();
    await handler(makeReq(), second.res, { fetchImpl: dead, sleep });
    expect(second.out.status).toBe(502);
    expect(second.out.headers["Cache-Control"]).toBe("private, no-store");
    expect(second.out.body).toEqual({ state: "unread", detail: expect.stringContaining("HTTP 503") });
  });

  it("a venue with no pools answers an empty list, cached, and asks Jupiter nothing", async () => {
    const w = world({ pools: [], price: {} });
    const { res, out } = makeRes();
    await handler(makeReq(), res, { fetchImpl: w.fetchImpl, sleep });
    expect(out.status).toBe(200);
    expect(out.body.prices).toEqual({});
    expect(w.jupiterCalls).toHaveLength(0);
  });

  it("is GET only, same-origin only (the origin gate binds on production, as every resource read's does)", async () => {
    const w = world({ pools: [], price: {} });
    const was = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      for (const req of [makeReq({ method: "POST" }), makeReq({ headers: { origin: "https://evil.example" } })]) {
        const { res, out } = makeRes();
        await handler(req, res, { fetchImpl: w.fetchImpl, sleep });
        expect([403, 405]).toContain(out.status);
      }
    } finally {
      if (was === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = was;
    }
    expect(w.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the pool scan asks for the two mints only", () => {
  it("slices from token0Mint for 64 bytes", async () => {
    const w = world({ pools: [[WSOL_MINT, BAYLA]], price: { [BAYLA]: 7.5e-6 } });
    await handler(makeReq(), makeRes().res, { fetchImpl: w.fetchImpl, sleep });
    const scan = w.fetchImpl.mock.calls.map(([, init]) => init?.body && JSON.parse(init.body)).find((b) => b?.method === "getProgramAccounts");
    expect(scan.params[1].dataSlice).toEqual({ offset: OFFSETS.token0Mint, length: 64 });
  });
});
