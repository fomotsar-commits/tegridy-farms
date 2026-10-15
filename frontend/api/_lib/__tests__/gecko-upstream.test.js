// gecko-upstream (api/_lib/gecko-upstream.js): the budget, the cool-down and the
// kept copies both GeckoTerminal readers go through.
//
// The bug (2026-10-14): a visitor clicking through several bungalows got "the
// feed is rate-limiting, try again" on the chart and the trades list. Each
// bungalow is three distinct upstream URLs, GeckoTerminal's keyless API allows
// about 30 calls a minute, and the two readers let through 240 + 120 a minute.
//
// These run the REAL limiter in its in-memory mode (no Upstash env), with only
// GeckoTerminal mocked, so a "burst" here is the same code path a burst takes in
// production minus Redis. Nothing in this file touches the live site.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const SOL_POOLS = [
  "31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX",
  "8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n",
  "5qZx6GqhYhAGTSpDn2HvMh1uYkA9VTZjUCN4kgJVSJWW",
  "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump",
  "DJFP3qJroFzcvZj3YowPmrNu6WoMo6njVB3dywTewua5",
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
];

const PAYLOAD = { data: { attributes: { name: "X / SOL" } } };

function makeReq({ query = {}, headers = {} } = {}) {
  return {
    method: "GET",
    query,
    headers: { origin: "https://tegridyfarms.vercel.app", "x-real-ip": "203.0.113.7", ...headers },
  };
}

function makeRes() {
  const headers = {};
  const out = { status: null, body: undefined, headers };
  const res = {
    setHeader: (k, v) => { headers[k] = v; return res; },
    status: (c) => { out.status = c; return res; },
    json: (p) => { out.body = p; return res; },
    end: () => res,
  };
  return { res, out };
}

function okUpstream(payload = PAYLOAD) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    text: async () => JSON.stringify(payload),
  };
}

function refused(status = 429) {
  return { ok: false, status, headers: { get: () => null } };
}

/** A distinct, well-formed EVM pool address per index. */
const evm = (i) => `0x${i.toString(16).padStart(40, "0")}`;
const network = (pool) => (pool.startsWith("0x") ? "eth" : "solana");
const trades = (pool) => ({ path: `/networks/${network(pool)}/pools/${pool}/trades` });
const dayCandles = (pool) => ({ path: `/networks/solana/pools/${pool}/ohlcv/day`, aggregate: "1", limit: "90", currency: "usd" });

let handleGeckoRead;
let handlePoolMarket;
let upstream;
let fetchMock;
const saved = {};

beforeEach(async () => {
  vi.resetModules();
  for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "GECKO_UPSTREAM_RPM"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fetchMock = vi.fn(async () => okUpstream());
  vi.stubGlobal("fetch", fetchMock);
  ({ handleGeckoRead } = await import("../gecko-read.js"));
  ({ handlePoolMarket } = await import("../pool-market.js"));
  upstream = await import("../gecko-upstream.js");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function geckoRead(query, headers) {
  const { res, out } = makeRes();
  await handleGeckoRead(makeReq({ query, headers }), res);
  return out;
}

async function poolMarket(pool, headers) {
  const { res, out } = makeRes();
  await handlePoolMarket(makeReq({ query: { network: network(pool), pool }, headers }), res);
  return out;
}

const sMaxAge = (out) => Number(/s-maxage=(\d+)/.exec(out.headers["Cache-Control"] ?? "")?.[1] ?? 0);

describe("one budget under GeckoTerminal's own limit", () => {
  it("lets a burst of bungalow visits send GeckoTerminal at most 30 reads in a minute", async () => {
    // Fourteen bungalows, three reads each (market strip, candles, trades), all
    // from one visitor inside one minute: 42 distinct cache misses.
    for (const pool of SOL_POOLS) {
      await poolMarket(pool);
      await geckoRead(dayCandles(pool));
      await geckoRead(trades(pool));
    }
    expect(fetchMock.mock.calls.length, "every one of these reached GeckoTerminal before the fix")
      .toBeLessThanOrEqual(upstream.GECKO_KEYLESS_PER_MINUTE);
    expect(fetchMock.mock.calls.length).toBe(upstream.upstreamBudgetPerMinute());
  });

  it("counts both readers against the SAME budget", async () => {
    const budget = upstream.upstreamBudgetPerMinute();
    for (let i = 1; i <= budget; i++) expect((await poolMarket(evm(i))).status).toBe(200);
    // The market strips spent it; the trades reader must not have its own.
    const out = await geckoRead(trades(SOL_POOLS[0]));
    expect(out.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(budget);
  });

  it("refuses a read past the budget as a 429 with Retry-After, never a silent nothing", async () => {
    const budget = upstream.upstreamBudgetPerMinute();
    let last;
    for (let i = 1; i <= budget + 1; i++) last = await geckoRead(trades(evm(i)));
    expect(last.status).toBe(429);
    expect(Number(last.headers["Retry-After"])).toBeGreaterThan(0);
    expect(last.headers["Cache-Control"], "a refusal is never cached at the edge").toBeUndefined();
  });

  it("lets the env lower the budget but never lift it past the keyless limit", () => {
    expect(upstream.upstreamBudgetPerMinute({})).toBeLessThanOrEqual(30);
    expect(upstream.upstreamBudgetPerMinute({ GECKO_UPSTREAM_RPM: "240" })).toBe(30);
    expect(upstream.upstreamBudgetPerMinute({ GECKO_UPSTREAM_RPM: "10" })).toBe(10);
    expect(upstream.upstreamBudgetPerMinute({ GECKO_UPSTREAM_RPM: "nonsense" })).toBe(
      upstream.upstreamBudgetPerMinute({}),
    );
  });
});

describe("a refusal from GeckoTerminal is not asked again at once", () => {
  it("stops calling GeckoTerminal after a 429 until the cool-down ends", async () => {
    fetchMock.mockResolvedValueOnce(refused(429));
    const first = await geckoRead(trades(SOL_POOLS[0]));
    expect(first.status).toBe(429);
    for (const pool of SOL_POOLS.slice(1, 6)) {
      const out = await geckoRead(trades(pool));
      expect(out.status).toBe(429);
    }
    expect(fetchMock, "four more calls into a refusal is how a rate limit becomes a ban").toHaveBeenCalledTimes(1);
  });

  it("asks again once the cool-down has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    fetchMock.mockResolvedValueOnce(refused(429));
    await geckoRead(trades(SOL_POOLS[0]));
    vi.setSystemTime(new Date("2026-10-15T12:05:01Z"));
    const later = await geckoRead(trades(SOL_POOLS[1]));
    expect(later.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("the last good copy, marked with its age, only for a caller that asks", () => {
  const STALE_OK = { "x-gecko-stale-ok": "1" };

  async function readThenRefuse() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const first = await geckoRead(trades(SOL_POOLS[0]), STALE_OK);
    // Two minutes on, the copy is past its fresh window and GeckoTerminal refuses.
    vi.setSystemTime(new Date("2026-10-15T12:02:00Z"));
    fetchMock.mockResolvedValueOnce(refused(429));
    return first;
  }

  it("serves the kept copy with its true read time and the stale mark", async () => {
    const first = await readThenRefuse();
    const out = await geckoRead(trades(SOL_POOLS[0]), STALE_OK);
    expect(out.status).toBe(200);
    expect(out.body).toEqual(PAYLOAD);
    expect(out.headers["X-Gecko-Stale"]).toBe("1");
    expect(out.headers["X-Gecko-Fetched-At"], "the age must be the FIRST read's, not now")
      .toBe(first.headers["X-Gecko-Fetched-At"]);
    expect(Number(out.headers["X-Gecko-Fetched-At"])).toBe(Date.parse("2026-10-15T12:00:00Z"));
    expect(sMaxAge(out), "a kept copy must never be cached at the edge for the next visitor").toBe(0);
    expect(out.headers["Cache-Control"]).toBe("no-store");
  });

  it("gives a caller that did NOT ask the refusal, not an old number that looks new", async () => {
    await readThenRefuse();
    const out = await geckoRead(trades(SOL_POOLS[0]));
    expect(out.status).toBe(429);
    expect(out.headers["X-Gecko-Stale"]).toBeUndefined();
  });

  it("serves the kept copy when the budget is spent, without calling GeckoTerminal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    await poolMarket(SOL_POOLS[0], STALE_OK);
    vi.setSystemTime(new Date("2026-10-15T12:01:30Z"));
    const budget = upstream.upstreamBudgetPerMinute();
    for (let i = 1; i <= budget; i++) await geckoRead(trades(evm(i)));
    const calls = fetchMock.mock.calls.length;
    const out = await poolMarket(SOL_POOLS[0], STALE_OK);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(out.status).toBe(200);
    expect(out.headers["X-Gecko-Stale"]).toBe("1");
  });

  it("does not stand a kept copy in for a 404, which is an answer", async () => {
    await readThenRefuse();
    fetchMock.mockReset();
    vi.setSystemTime(new Date("2026-10-15T12:10:00Z"));
    fetchMock.mockResolvedValueOnce(refused(404));
    const out = await geckoRead(trades(SOL_POOLS[0]), STALE_OK);
    expect(out.status).toBe(404);
  });
});

describe("fresh windows and the age stamp", () => {
  it("answers a repeat inside the fresh window from memory, with the same read time", async () => {
    const a = await geckoRead(trades(SOL_POOLS[0]));
    const b = await geckoRead(trades(SOL_POOLS[0]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b.status).toBe(200);
    expect(b.headers["X-Gecko-Fetched-At"]).toBe(a.headers["X-Gecko-Fetched-At"]);
    expect(b.headers["X-Gecko-Stale"]).toBeUndefined();
  });

  it("stamps every 200 with when GeckoTerminal was read", async () => {
    const out = await poolMarket(SOL_POOLS[0]);
    expect(Number(out.headers["X-Gecko-Fetched-At"])).toBeGreaterThan(0);
  });

  it("keeps candles over days longer than a trade tape, and a tape for at least a minute", async () => {
    const tape = await geckoRead(trades(SOL_POOLS[0]));
    const days = await geckoRead(dayCandles(SOL_POOLS[0]));
    expect(sMaxAge(tape)).toBeGreaterThanOrEqual(60);
    expect(sMaxAge(days)).toBeGreaterThan(sMaxAge(tape));
  });
});
