// The pool index (api/_lib/pool-index.js, ?resource=pools behind the /api/pools rewrite): one filtered getProgramAccounts per question, addresses
// only, never an empty list on failure, strict input, cached, rate-limited on misses.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const rate = vi.hoisted(() => ({ checkRateLimit: vi.fn(async () => true), checkGlobalLimit: vi.fn(async () => true) }));
vi.mock("../_lib/ratelimit.js", () => rate);

const MINT = "So11111111111111111111111111111111111111112";
const OTHER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL_A = "BHMteE8u5bGJkVfsZhY7FL7ZsGTTYkQiA3Hy1u7DgP1H";
const POOL_B = "11111111111111111111111111111111";

function makeReq(query, { method = "GET", headers = {} } = {}) {
  return { method, query, headers };
}
function makeRes() {
  const r = { statusCode: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  r.end = vi.fn();
  return r;
}
function upstream(results) {
  // results: array, one per call, of either a pubkey list or an Error/status
  let i = 0;
  return vi.fn(async (_url, init) => {
    const r = results[Math.min(i++, results.length - 1)];
    if (r instanceof Error) throw r;
    if (typeof r === "number") return { ok: false, status: r, headers: { get: () => null }, body: null, text: async () => "" };
    const text = JSON.stringify(Array.isArray(r) ? { jsonrpc: "2.0", id: 1, result: r.map((pubkey) => ({ pubkey, account: {} })) } : r);
    return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => text, init };
  });
}

let mod;
beforeEach(async () => {
  vi.resetModules();
  rate.checkRateLimit.mockClear();
  rate.checkGlobalLimit.mockClear();
  process.env.NODE_ENV = "test";
  mod = await import("../_lib/pool-index.js");
  mod.__resetPoolIndexCache();
});
afterEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.SOLANA_RPC_URL;
});

describe("api/pools", () => {
  it("scans both sides of a pool for a mint, filtered to pool accounts, keys only", async () => {
    const f = upstream([[POOL_A], [POOL_B, POOL_A]]);
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, f);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ mint: MINT, program: mod.CP_SWAP_PROGRAM, pools: [POOL_B, POOL_A].sort(), truncated: false });
    expect(f).toHaveBeenCalledTimes(2);
    const offsets = f.mock.calls.map(([, init]) => {
      const b = JSON.parse(init.body);
      expect(b.method).toBe("getProgramAccounts");
      expect(b.params[0]).toBe(mod.CP_SWAP_PROGRAM);
      expect(b.params[1].dataSlice).toEqual({ offset: 0, length: 0 });
      const f0 = b.params[1].filters;
      expect(f0).toContainEqual({ dataSize: 637 });
      expect(f0).toContainEqual({ memcmp: { offset: 0, bytes: mod.POOL_DISCRIMINATOR_B58 } });
      return f0.find((x) => x.memcmp && x.memcmp.offset !== 0).memcmp;
    });
    expect(offsets).toEqual([{ offset: 168, bytes: MINT }, { offset: 200, bytes: MINT }]);
  });

  it("finds a pool by its LP mint with one scan at the lp_mint offset", async () => {
    const f = upstream([[POOL_A]]);
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ lpMint: OTHER }), res, f);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ lpMint: OTHER, pools: [POOL_A] });
    expect(JSON.parse(f.mock.calls[0][1].body).params[1].filters[2]).toEqual({ memcmp: { offset: 136, bytes: OTHER } });
  });

  it("never answers 'no pools' when the scan failed: HTTP error, thrown fetch, JSON-RPC error, missing result", async () => {
    for (const bad of [500, new Error("down"), { jsonrpc: "2.0", id: 1, error: { code: -32010, message: "x" } }, { jsonrpc: "2.0", id: 1 }]) {
      mod.__resetPoolIndexCache();
      const res = makeRes();
      await mod.handlePoolIndex(makeReq({ mint: MINT }), res, upstream([bad]));
      expect(res.statusCode).toBe(502);
      expect(res.body.pools).toBeUndefined();
    }
  });

  it("refuses an upstream answer carrying a bad address rather than passing it on", async () => {
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, upstream([["not-a-key"]]));
    expect(res.statusCode).toBe(502);
  });

  it("rejects bad input before any upstream call", async () => {
    const f = upstream([[POOL_A]]);
    const bad = [{}, { mint: "abc" }, { mint: `${MINT}x` }, { mint: [MINT, MINT] }, { mint: MINT, lpMint: OTHER }, { mint: MINT, extra: "1" }, { owner: MINT },
      // valid base58, wrong length (31 bytes)
      { mint: "1111111111111111111111111111111" }];
    for (const q of bad) {
      const res = makeRes();
      await mod.handlePoolIndex(makeReq(q), res, f);
      expect(res.statusCode, JSON.stringify(q)).toBe(400);
    }
    expect(f).not.toHaveBeenCalled();
    expect(rate.checkRateLimit).not.toHaveBeenCalled();
  });

  it("is GET only", async () => {
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }, { method: "POST" }), res, upstream([[POOL_A]]));
    expect(res.statusCode).toBe(405);
  });

  it("refuses a cross-site request in production", async () => {
    process.env.NODE_ENV = "production";
    const res = makeRes();
    const f = upstream([[POOL_A]]);
    await mod.handlePoolIndex(makeReq({ mint: MINT }, { headers: { "sec-fetch-site": "cross-site" } }), res, f);
    expect(res.statusCode).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it("serves a repeat question from cache without the upstream or the rate limiter", async () => {
    const f = upstream([[POOL_A], [], [POOL_B], []]);
    await mod.handlePoolIndex(makeReq({ mint: MINT }), makeRes(), f);
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, f);
    expect(res.body.pools).toEqual([POOL_A]);
    expect(f).toHaveBeenCalledTimes(2);
    expect(rate.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(res.headers["Cache-Control"]).toMatch(/s-maxage=30/);
  });

  it("stops at the rate limit before touching the upstream", async () => {
    rate.checkRateLimit.mockImplementationOnce(async (_req, res) => { res.status(429).json({ error: "slow" }); return false; });
    const f = upstream([[POOL_A]]);
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, f);
    expect(res.statusCode).toBe(429);
    expect(f).not.toHaveBeenCalled();
  });

  it("caps the list and says it was cut", async () => {
    // 60 distinct valid keys
    const { base58 } = await import("@scure/base");
    const many = Array.from({ length: 60 }, (_, i) => { const b = new Uint8Array(32); b[0] = i + 1; b[31] = 7; return base58.encode(b); });
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, upstream([many, []]));
    expect(res.body.pools).toHaveLength(mod.MAX_POOLS);
    expect(res.body.truncated).toBe(true);
  });

  it("reads the upstream from the server-only SOLANA_RPC_URL", async () => {
    process.env.SOLANA_RPC_URL = "http://127.0.0.1:8899";
    const f = upstream([[], []]);
    await mod.handlePoolIndex(makeReq({ mint: MINT }), makeRes(), f);
    expect(f.mock.calls[0][0]).toBe("http://127.0.0.1:8899");
  });

  it("accepts the catchall's own routing key and nothing else beside the one question", async () => {
    const f = upstream([[POOL_A], []]);
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ resource: "pools", mint: MINT }), res, f);
    expect(res.statusCode).toBe(200);
    const bad = makeRes();
    await mod.handlePoolIndex(makeReq({ resource: "pools", mint: MINT, provider: "jupiter" }), bad, f);
    expect(bad.statusCode).toBe(400);
  });
});

describe("routing: /api/pools costs no function of its own", () => {
  it("is rewritten to the catchall, above the SPA fallback", () => {
    const rewrites = JSON.parse(readFileSync(join(API_DIR, "..", "vercel.json"), "utf8")).rewrites;
    const at = rewrites.findIndex((r) => r.source === "/api/pools");
    expect(rewrites[at]?.destination).toBe("/api/aggregator?resource=pools");
    expect(at).toBeLessThan(rewrites.findIndex((r) => r.source === "/((?!api/).*)"));
  });

  it("dispatches ?resource=pools behind a lazy import, ABOVE const provider", () => {
    const src = readFileSync(join(API_DIR, "aggregator.js"), "utf8");
    const branch = src.indexOf('req.query.resource === "pools"');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(src.indexOf("const provider = req.query.provider"));
    expect(src).toContain('await import("./_lib/pool-index.js")');
  });
});
