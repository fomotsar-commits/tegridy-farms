// launcher-outcomes — a market we could not read is never "no live market".
//
// A market read has three outcomes and only two are answers: (a) read it, there is
// no pool; (b) read it, here is the pool; (c) COULD NOT READ IT. `geckoFetchJson`
// returned null for 429, any non-2xx, an over-cap body and a JSON parse failure —
// indistinguishable from (a) — so the record went out as `marketObserved:false`,
// which /deployer renders as a "No live market" pill plus a note speculating the
// pool "may have been withdrawn". Rug-adjacent language about somebody's token,
// manufactured from our own throttling.
//
// This is the ROUTINE case, not the exotic one: GeckoTerminal's keyless ceiling is
// ~30/min from one IP and a single /deployer request can issue up to 50 reads.
//
// The detection core already ships the right destination — `unobserved`, "State
// unknown — this is not a signal about the token" — it was simply unreachable
// because the wire carried no third state. These tests pin that the wire carries it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../_lib/ratelimit.js", () => ({
  checkRateLimit: vi.fn(async () => true),
  // The aggregate breaker added 2026-08-12. One POST here is worth up to 200 upstream
  // reads, so per-IP alone never bounded the fan-out. NOTE: each describe below
  // re-declares this via vi.doMock in its own beforeEach (they vi.resetModules to get a
  // fresh handler), so THAT is the mock that actually binds — this one only keeps the
  // static import graph honest.
  checkGlobalLimit: vi.fn(async () => true),
}));

const TOKEN = "0x420698cfdeddea6bc78d59bc17798113ad278f9d";
const CREATOR = "0x1489825812345678901234567890123456789abc";

function makeReq(baselines) {
  return {
    method: "POST",
    headers: { origin: "https://memetic.fun" },
    body: { baselines },
  };
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

const baseline = () => ({
  token: TOKEN,
  creator: CREATOR,
  tier: "listable",
  launchedAt: 1_780_000_000,
  launchPriceEth: 0.000001,
  launchLiquidityEth: 4,
});

/** One upstream response; `text` is served verbatim so a non-JSON body is testable. */
function upstream(text, { ok = true, status = 200 } = {}) {
  return { ok, status, headers: { get: () => null }, body: null, text: async () => text };
}

/** A GeckoTerminal pool payload for the token→pools discovery path. */
function pool({ priceNative = "0.000002", reserveUsd = "40000", priceUsd = "0.005" } = {}) {
  const attributes = {
    base_token_price_native_currency: priceNative,
    transactions: { h24: { buyers: 12 } },
  };
  if (reserveUsd !== null) attributes.reserve_in_usd = reserveUsd;
  if (priceUsd !== null) attributes.base_token_price_usd = priceUsd;
  return JSON.stringify({ data: [{ attributes }] });
}

describe("launcher-outcomes — a failed market read is not a verdict", () => {
  let handler;

  beforeEach(async () => {
    vi.resetModules();
    process.env.NODE_ENV = "test";
    vi.doMock("../_lib/ratelimit.js", () => ({
      checkRateLimit: vi.fn(async () => true),
      checkGlobalLimit: vi.fn(async () => true),
    }));
    handler = (await import("../_lib/launcher-outcomes.js")).handleLauncherOutcomes;
  });

  afterEach(() => { delete globalThis.fetch; });

  /** Serve one response for GeckoTerminal; Etherscan always answers empty. */
  function serveGecko(resp) {
    globalThis.fetch = vi.fn(async (url) =>
      String(url).includes("geckoterminal")
        ? resp
        : upstream(JSON.stringify({ status: "1", message: "OK", result: [] })),
    );
  }

  async function record(resp) {
    serveGecko(resp);
    const { res, jsonSpy } = makeRes();
    await handler(makeReq([baseline()]), res);
    return jsonSpy.mock.calls[0][0].outcomes[TOKEN];
  }

  it("flags a 429 as a failed read rather than an absent pool", async () => {
    // ⚠ THE ORIGINAL BUG, and the most likely one to fire in production.
    const rec = await record(upstream("", { ok: false, status: 429 }));
    expect(rec.marketReadFailed).toBe(true);
    expect(rec.marketObserved).toBe(false);
  });

  it("treats any non-2xx and any unparseable body the same way", async () => {
    for (const resp of [
      upstream("", { ok: false, status: 500 }),
      upstream("", { ok: false, status: 404 }),
      upstream("<!doctype html><title>gateway</title>"), // 200 carrying HTML
      upstream("{ not json"),
    ]) {
      expect((await record(resp)).marketReadFailed).toBe(true);
    }
  });

  it("keeps a genuinely pool-less token as the real answer it is", async () => {
    // GT replied and listed nothing. THIS is the case "No live market" was written
    // for, and hardening must not blunt it.
    const rec = await record(upstream(JSON.stringify({ data: [] })));
    expect(rec.marketReadFailed).toBe(false);
    expect(rec.marketObserved).toBe(false);
  });

  it("still publishes a fully readable pool as observed", async () => {
    const rec = await record(upstream(pool()));
    expect(rec.marketReadFailed).toBe(false);
    expect(rec.marketObserved).toBe(true);
    expect(rec.liquidityEth).toBeGreaterThan(0);
    expect(rec.priceEth).toBeGreaterThan(0);
  });

  it("does not call a pool THIN because its reserve field never arrived", async () => {
    // ⚠ The nastiest of the set, because it does not look like a failure. `priceEth`
    // alone satisfied `marketIsObserved` while `liquidityEth` had been initialised to
    // 0, so the core classified the token `thin-market` and published "liquidity is
    // thin (~0.0e+0 ETH) — an exit of any size would move the price sharply" about a
    // pool whose size we never read. Routine on freshly indexed pools.
    const rec = await record(upstream(pool({ reserveUsd: null })));
    expect(rec.marketReadFailed).toBe(true);
    expect(rec.marketObserved).toBe(false);
  });

  it("does not treat a real zero-liquidity pool as unreadable", async () => {
    // A reserve that IS there and IS zero is an answer, not a gap.
    const rec = await record(upstream(pool({ reserveUsd: "0" })));
    expect(rec.marketReadFailed).toBe(false);
    expect(rec.marketObserved).toBe(true);
  });

  it("never reports a launch summary built on an unread market", async () => {
    serveGecko(upstream("", { ok: false, status: 429 }));
    const { res, jsonSpy } = makeRes();
    await handler(makeReq([baseline()]), res);
    expect(jsonSpy.mock.calls[0][0].launches).toEqual([]);
  });
});

// This route is the most expensive thing we expose anonymously: MAX_BASELINES is 50 and
// each baseline costs up to 4 upstream reads, so ONE request is worth ~200 — against an
// Etherscan free tier of ~300/min shared with the whole app. A per-IP limit bounds one
// attacker and does nothing about a distributed one, where every individual IP looks
// polite. Until 2026-08-12 the aggregate breaker was simply absent here, because the
// `?resource=` branch returns before runProxy, which is where the breaker lives.
describe("the aggregate breaker gates the fan-out", () => {
  let handler;
  let globalLimitMock;

  beforeEach(async () => {
    // Same shape as the describe above: resetModules + doMock, because the handler has
    // to be re-imported to pick up a fresh mock.
    vi.resetModules();
    process.env.NODE_ENV = "test";
    globalLimitMock = vi.fn(async () => true);
    vi.doMock("../_lib/ratelimit.js", () => ({
      checkRateLimit: vi.fn(async () => true),
      checkGlobalLimit: globalLimitMock,
    }));
    handler = (await import("../_lib/launcher-outcomes.js")).handleLauncherOutcomes;
  });

  afterEach(() => { delete globalThis.fetch; });

  it("does not reach a single upstream when the global cap is blown", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    globalLimitMock.mockImplementation(async () => false);

    const { res } = makeRes();
    await handler(makeReq([baseline()]), res);

    // The load-bearing assertion is the ZERO fan-out, not the status code: a status-only
    // check could be satisfied by an unrelated upstream failure that still spent the
    // budget. Pre-fix, checkGlobalLimit was not imported at all, so this call went
    // straight through and fetch fired.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks the breaker under its OWN identifier, not a shared bucket", async () => {
    // Sharing a bucket with `etherscan` would make this fan-out and /api/etherscan shed
    // each other's traffic — a throttle on one surface silently starving another.
    globalThis.fetch = vi.fn(async () => upstream(JSON.stringify({ status: "1", message: "OK", result: [] })));
    const { res } = makeRes();
    await handler(makeReq([baseline()]), res);

    expect(globalLimitMock).toHaveBeenCalled();
    const cfg = globalLimitMock.mock.calls[0][1];
    expect(cfg.identifier).toBe("launcher-outcomes");
    expect(cfg.limit).toBeGreaterThan(0);
  });
});
