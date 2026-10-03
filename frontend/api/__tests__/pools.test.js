// The pool index (api/_lib/pool-index.js, ?resource=pools behind the /api/pools rewrite):
// TOKEN/SOL pools only, ranked by SOL depth, addresses only, never an empty list on
// failure, strict input, a token-mint check before any scan, cached, rate-limited on misses.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { base58 } from "@scure/base";
// For the size of FLOOD below. Every test still gets its own instance: the beforeEach
// resets modules and imports again.
import { MAX_SCANNED } from "../_lib/pool-index.js";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const rate = vi.hoisted(() => ({ checkRateLimit: vi.fn(async () => true), checkGlobalLimit: vi.fn(async () => true) }));
vi.mock("../_lib/ratelimit.js", () => rate);

const WSOL = "So11111111111111111111111111111111111111112";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LP = "BHMteE8u5bGJkVfsZhY7FL7ZsGTTYkQiA3Hy1u7DgP1H";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** A distinct valid 32-byte key; `first` byte chooses where it sorts. */
const k = (i, first = 9) => { const b = new Uint8Array(32); b[0] = first; b[1] = i & 255; b[2] = i >> 8; b[31] = 7; return base58.encode(b); };
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
function mintBytes(len = 82) { const d = new Uint8Array(len); d[45] = 1; if (len > 165) d[165] = 1; return d; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

function makeReq(query, { method = "GET", headers = {} } = {}) {
  return { method, query, headers };
}
function makeRes() {
  const r = { statusCode: null, body: null, headers: {} };
  r.setHeader = (h, v) => { r.headers[h] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  r.end = vi.fn();
  return r;
}
const reply = (result) => ({ ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });

/**
 * A fake chain. `mint`: the account at the asked key ({owner, data} or null). `pools`:
 * [{ address, solVault, sol }] for TOKEN/SOL scans; `lpPools`: addresses for LP-mint
 * scans. `fail`: a method name (or "all") that errors, or a status/body to return.
 */
function chain({ mint = { owner: TOKEN, data: mintBytes() }, pools = [], lpPools = [], fail = null } = {}) {
  return vi.fn(async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (fail && (fail.method === method || fail.method === "all")) {
      if (fail.throws) throw new Error("down");
      if (typeof fail.status === "number") return { ok: false, status: fail.status, headers: { get: () => null }, body: null, text: async () => "" };
      return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify(fail.body) };
    }
    if (method === "getAccountInfo") return reply({ context: { slot: 1 }, value: mint && { owner: mint.owner, lamports: 1, data: [b64(mint.data), "base64"] } });
    if (method === "getProgramAccounts") {
      const lpScan = params[1].filters.some((f) => f.memcmp && f.memcmp.offset === 136);
      if (lpScan) return reply(lpPools.map((pubkey) => ({ pubkey, account: { data: ["", "base64"], owner: "x", lamports: 1 } })));
      // the slice is token0Vault | token1Vault; SOL sits on the side the scan put it
      const [t0] = params[1].filters.filter((f) => f.memcmp && f.memcmp.offset === 168).map((f) => f.memcmp.bytes);
      const other = base58.decode(k(0, 200));
      return reply(pools.map((p) => {
        const solVault = base58.decode(p.solVault);
        const slice = t0 === WSOL ? [...solVault, ...other] : [...other, ...solVault];
        return { pubkey: p.address, account: { data: [b64(Uint8Array.from(slice)), "base64"], owner: "x", lamports: 1 } };
      }));
    }
    if (method === "getMultipleAccounts") {
      return reply({ context: { slot: 1 }, value: params[0].map((v) => { const p = pools.find((x) => x.solVault === v); return p ? { owner: TOKEN, lamports: 1, data: [b64(u64(p.sol)), "base64"] } : null; }) });
    }
    throw new Error(`unexpected ${method}`);
  });
}
const calls = (f, method) => f.mock.calls.map(([, init]) => JSON.parse(init.body)).filter((b) => b.method === method);

// One pool more than the index will rank. Built at collection, where no timeout runs:
// its 20,002 base58 encodes were a quarter of the flood test's body, and they slow with
// machine load.
const FLOOD = Array.from({ length: MAX_SCANNED + 1 }, (_, i) => ({ address: k(i, 1), solVault: k(i, 2), sol: 1 }));

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
  // S1-R01 / F2: TOKEN/JUNK pools cannot crowd the answer; one scan matches BOTH sides.
  it("scans for TOKEN/SOL pools only: both mint slots in one filtered scan, the vault keys in the slice", async () => {
    const f = chain({ pools: [{ address: k(1), solVault: k(2), sol: 5 }] });
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, f);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ mint: MINT, program: mod.CP_SWAP_PROGRAM, pools: [k(1)], truncated: false });
    const [scan] = calls(f, "getProgramAccounts");
    expect(scan.params[0]).toBe(mod.CP_SWAP_PROGRAM);
    expect(scan.params[1].dataSlice).toEqual({ offset: 72, length: 64 });
    const fl = scan.params[1].filters;
    expect(fl).toContainEqual({ dataSize: 637 });
    expect(fl).toContainEqual({ memcmp: { offset: 0, bytes: mod.POOL_DISCRIMINATOR_B58 } });
    // token0 < token1 by BYTES (initialize.rs:54), not by base58 text: WSOL's first byte
    // is 6 and this mint's is 198, so SOL is token0 although "E" < "S".
    expect(fl.filter((x) => x.memcmp && x.memcmp.offset !== 0).map((x) => x.memcmp)).toEqual([{ offset: 168, bytes: WSOL }, { offset: 200, bytes: MINT }]);
    expect(calls(f, "getProgramAccounts")).toHaveLength(1);
  });

  it("ranks by the SOL each pool holds, never by address, and cuts only after ranking", async () => {
    // 100 cheap pools whose addresses sort first, and the real pool sorting last.
    const junk = Array.from({ length: 100 }, (_, i) => ({ address: k(i, 1), solVault: k(i, 2), sol: 1_000 + i }));
    const real = { address: k(0, 250), solVault: k(0, 251), sol: 10n ** 12n };
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, chain({ pools: [...junk, real] }));
    expect(res.body.pools[0]).toBe(real.address);
    expect(res.body.pools).toHaveLength(mod.MAX_POOLS);
    expect(res.body.truncated).toBe(true);
    // the rest deepest first
    expect(res.body.pools[1]).toBe(junk[99].address);
  });

  // Review 2026-09-30: only the first 1000 pools BY ADDRESS used to be weighed, so 1000+
  // ground low-sorting dust pools kept a deep pool from ever being ranked.
  it("weighs every pool the scan found: over 1000 ground addresses cannot hide a deep pool", async () => {
    const junk = Array.from({ length: 1_001 }, (_, i) => ({ address: k(i, 1), solVault: k(i, 2), sol: 1 }));
    const real = { address: k(0, 250), solVault: k(0, 251), sol: 10n ** 12n };
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, chain({ pools: [...junk, real] }));
    expect(res.statusCode).toBe(200);
    expect(res.body.pools[0]).toBe(real.address);
  });

  it("more pools than it can rank is a 502, never a cut list", async () => {
    const f = chain({ pools: FLOOD });
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, f);
    expect(res.statusCode).toBe(502);
    expect(calls(f, "getMultipleAccounts")).toHaveLength(0);
    // 30s, not the default 5s: what is left is real work, about 40,000 base58 conversions
    // between the fake chain and the handler, and it slows with machine load. A bound
    // written here is its own clock: --testTimeout does not override it.
  }, 30_000);

  it("gives every chain call a deadline", async () => {
    const f = chain({ pools: [{ address: k(1), solVault: k(2), sol: 5 }] });
    await mod.handlePoolIndex(makeReq({ mint: MINT }), makeRes(), f);
    expect(f.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of f.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("finds a pool by its LP mint with one scan at the lp_mint offset", async () => {
    const f = chain({ lpPools: [k(5)] });
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ lpMint: LP }), res, f);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ lpMint: LP, pools: [k(5)] });
    expect(calls(f, "getProgramAccounts")[0].params[1].filters[2]).toEqual({ memcmp: { offset: 136, bytes: LP } });
  });

  // F8: a random key costs one cheap read on its own budget, never a scan.
  it("a key that is not a token mint gets a 404 before any scan, and is remembered", async () => {
    for (const mint of [null, { owner: "11111111111111111111111111111111", data: new Uint8Array(0) }, { owner: TOKEN, data: mintBytes(165) }]) {
      mod.__resetPoolIndexCache();
      rate.checkGlobalLimit.mockClear();
      const f = chain({ mint });
      const res = makeRes();
      await mod.handlePoolIndex(makeReq({ mint: MINT }), res, f);
      expect(res.statusCode).toBe(404);
      expect(calls(f, "getProgramAccounts")).toHaveLength(0);
      // only the pre-check budget was charged, never the scan budget
      expect(rate.checkGlobalLimit.mock.calls.map(([, o]) => o.identifier)).toEqual(["pools-precheck"]);
      const again = makeRes();
      await mod.handlePoolIndex(makeReq({ mint: MINT }), again, f);
      expect(again.statusCode).toBe(404);
      expect(calls(f, "getAccountInfo")).toHaveLength(1);
    }
  });

  it("a Token-2022 mint is a mint for ?mint=, but an LP mint must be a classic one", async () => {
    const t22 = { owner: TOKEN22, data: mintBytes(300) };
    const ok = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), ok, chain({ mint: t22 }));
    expect(ok.statusCode).toBe(200);
    const lp = makeRes();
    await mod.handlePoolIndex(makeReq({ lpMint: LP }), lp, chain({ mint: t22 }));
    expect(lp.statusCode).toBe(404);
  });

  it("never answers 'no pools' when a read failed: HTTP error, thrown fetch, JSON-RPC error, missing result, bad vault answer", async () => {
    const bad = [
      { method: "all", status: 500 },
      { method: "all", throws: true },
      { method: "getProgramAccounts", body: { jsonrpc: "2.0", id: 1, error: { code: -32010, message: "x" } } },
      { method: "getProgramAccounts", body: { jsonrpc: "2.0", id: 1 } },
      { method: "getAccountInfo", body: { jsonrpc: "2.0", id: 1, result: {} } },
      { method: "getMultipleAccounts", body: { jsonrpc: "2.0", id: 1, result: { value: [] } } },
    ];
    for (const fail of bad) {
      mod.__resetPoolIndexCache();
      const res = makeRes();
      await mod.handlePoolIndex(makeReq({ mint: MINT }), res, chain({ pools: [{ address: k(1), solVault: k(2), sol: 1 }], fail }));
      expect(res.statusCode, JSON.stringify(fail)).toBe(502);
      expect(res.body.pools).toBeUndefined();
    }
  });

  it("refuses an upstream answer carrying a bad address rather than passing it on", async () => {
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, chain({ pools: [{ address: "not-a-key", solVault: k(2), sol: 1 }] }));
    expect(res.statusCode).toBe(502);
  });

  it("rejects bad input before any upstream call, SOL itself included", async () => {
    const f = chain();
    const bad = [{}, { mint: "abc" }, { mint: `${MINT}x` }, { mint: [MINT, MINT] }, { mint: MINT, lpMint: LP }, { mint: MINT, extra: "1" }, { owner: MINT },
      // valid base58, wrong length (31 bytes)
      { mint: "1111111111111111111111111111111" },
      { mint: WSOL }];
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
    await mod.handlePoolIndex(makeReq({ mint: MINT }, { method: "POST" }), res, chain());
    expect(res.statusCode).toBe(405);
  });

  it("refuses a cross-site request in production", async () => {
    process.env.NODE_ENV = "production";
    const res = makeRes();
    const f = chain();
    await mod.handlePoolIndex(makeReq({ mint: MINT }, { headers: { "sec-fetch-site": "cross-site" } }), res, f);
    expect(res.statusCode).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it("serves a repeat question from cache without the upstream or the rate limiter", async () => {
    const f = chain({ pools: [{ address: k(1), solVault: k(2), sol: 1 }] });
    await mod.handlePoolIndex(makeReq({ mint: MINT }), makeRes(), f);
    const n = f.mock.calls.length;
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, f);
    expect(res.body.pools).toEqual([k(1)]);
    expect(f.mock.calls.length).toBe(n);
    expect(rate.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(res.headers["Cache-Control"]).toMatch(/s-maxage=30/);
  });

  it("stops at the rate limit before touching the upstream", async () => {
    rate.checkRateLimit.mockImplementationOnce(async (_req, res) => { res.status(429).json({ error: "slow" }); return false; });
    const f = chain();
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, f);
    expect(res.statusCode).toBe(429);
    expect(f).not.toHaveBeenCalled();
  });

  it("stops at the scan budget after the mint check, before any scan", async () => {
    rate.checkGlobalLimit.mockImplementation(async (res, o) => { if (o.identifier === "pools") { res.status(503).json({ error: "busy" }); return false; } return true; });
    const f = chain();
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, f);
    rate.checkGlobalLimit.mockImplementation(async () => true);
    expect(res.statusCode).toBe(503);
    expect(calls(f, "getProgramAccounts")).toHaveLength(0);
  });

  it("reads the upstream from the server-only SOLANA_RPC_URL", async () => {
    process.env.SOLANA_RPC_URL = "http://127.0.0.1:8899";
    const f = chain();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), makeRes(), f);
    expect(f.mock.calls[0][0]).toBe("http://127.0.0.1:8899");
  });

  it("accepts the catchall's own routing key and nothing else beside the one question", async () => {
    const f = chain();
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
