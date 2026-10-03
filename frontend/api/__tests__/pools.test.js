// The pool index (api/_lib/pool-index.js, ?resource=pools behind the /api/pools rewrite):
// a token's pools with each pairing coin (SOL, USDC, BAYLA), ranked within a coin by how
// much of that coin each holds, addresses only, never an empty or partial list on
// failure, strict input, a token-mint check before any scan, cached, rate-limited on misses.
//
// Two groups. "api/pools" is the index as it was when SOL was the only coin: its token
// (MINT) is USDC's own mint, itself a pairing coin searched with SOL only, so those tests
// still see the single scan they always saw. "api/pools: the pairing coins" asks about an
// ordinary token, which is scanned with all three.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { base58 } from "@scure/base";

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
      return reply(pools.map((p) => {
        // the slice is token0Vault | token1Vault; SOL sits on the side the scan put it
        const [t0] = params[1].filters.filter((f) => f.memcmp && f.memcmp.offset === 168).map((f) => f.memcmp.bytes);
        const solVault = base58.decode(p.solVault);
        const other = base58.decode(k(0, 200));
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
    const flood = Array.from({ length: mod.MAX_SCANNED + 1 }, (_, i) => ({ address: k(i, 1), solVault: k(i, 2), sol: 1 }));
    const f = chain({ pools: flood });
    const res = makeRes();
    await mod.handlePoolIndex(makeReq({ mint: MINT }), res, f);
    expect(res.statusCode).toBe(502);
    expect(calls(f, "getMultipleAccounts")).toHaveLength(0);
  });

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

// ── The pairing coins: SOL, USDC, BAYLA ────────────────────────────────────────────
const USDC = MINT;
const BAYLA = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
/** In rank order, each with the token program its vaults are under. */
const COINS = [WSOL, USDC, BAYLA];
const COIN_PROGRAM = { [WSOL]: TOKEN, [USDC]: TOKEN, [BAYLA]: TOKEN22 };
/** An ordinary token: not a pairing coin, so it is searched with all three. */
const TOKEN_X = k(1, 77);
/** Some other token nobody pairs with on this site. */
const JUNK = k(1, 99);
/** token0 < token1 by BYTES, as the pool program orders every pair. */
const byteOrder = (a, b) => (Buffer.compare(Buffer.from(base58.decode(a)), Buffer.from(base58.decode(b))) < 0 ? [a, b] : [b, a]);
/** `n` pools paired with `quote`, pool i holding `amount(i)` of it. `first` chooses where their addresses sort. */
const poolsOf = (quote, n, amount, first) => Array.from({ length: n }, (_, i) => ({ address: k(i, first), quote, vault: k(i, first + 1), amount: amount(i) }));

/**
 * A fake chain that knows which PAIR each pool is. `pools`: [{ address, quote, vault,
 * amount, token?, vaultOwner? }]: `quote` is the coin's mint, `token` the other side
 * (the chain's `token` unless given), `vaultOwner` the program the coin's vault is under
 * (the coin's own unless given; null = no such account). A scan gets only the pools of
 * the exact pair it filtered on, both mint slots in byte order, as the real RPC answers.
 * `failScan` / `failRank`: a coin's mint whose scan, or whose vault read, errors.
 */
function pairChain({ token = TOKEN_X, mint = { owner: TOKEN, data: mintBytes() }, pools = [], failScan = null, failRank = null } = {}) {
  const down = { ok: false, status: 500, headers: { get: () => null }, body: null, text: async () => "" };
  const pairs = new Map();
  const pairOf = (p) => {
    const key = `${p.token ?? token}|${p.quote}`;
    if (!pairs.has(key)) pairs.set(key, byteOrder(p.token ?? token, p.quote));
    return pairs.get(key);
  };
  const byVault = new Map(pools.map((p) => [p.vault, p]));
  const other = base58.decode(k(0, 200));
  return vi.fn(async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "getAccountInfo") return reply({ context: { slot: 1 }, value: { owner: mint.owner, lamports: 1, data: [b64(mint.data), "base64"] } });
    if (method === "getProgramAccounts") {
      const slot = (offset) => params[1].filters.find((f) => f.memcmp && f.memcmp.offset === offset)?.memcmp.bytes;
      const [t0, t1] = [slot(168), slot(200)];
      if (failScan && (t0 === failScan || t1 === failScan)) return down;
      return reply(pools.filter((p) => pairOf(p)[0] === t0 && pairOf(p)[1] === t1).map((p) => {
        // the slice is token0Vault | token1Vault: the coin's vault on the coin's side
        const vault = base58.decode(p.vault);
        const slice = p.quote === t0 ? [...vault, ...other] : [...other, ...vault];
        return { pubkey: p.address, account: { data: [b64(Uint8Array.from(slice)), "base64"], owner: "x", lamports: 1 } };
      }));
    }
    if (method === "getMultipleAccounts") {
      const asked = params[0].map((v) => byVault.get(v));
      if (failRank && asked.some((p) => p && p.quote === failRank)) return down;
      return reply({ context: { slot: 1 }, value: asked.map((p) => (p && p.vaultOwner !== null ? { owner: p.vaultOwner ?? COIN_PROGRAM[p.quote], lamports: 1, data: [b64(u64(p.amount)), "base64"] } : null)) });
    }
    throw new Error(`unexpected ${method}`);
  });
}
async function ask(query, f) {
  const res = makeRes();
  await mod.handlePoolIndex(makeReq(query), res, f);
  return res;
}
/** The two mint slots each scan filtered on. */
const scannedPairs = (f) => calls(f, "getProgramAccounts").map((c) => c.params[1].filters.filter((x) => x.memcmp && x.memcmp.offset !== 0).map((x) => x.memcmp));
/** The coin each scan was for: the mint in its filter that is not the token asked about. */
const scannedCoins = (f, token) => scannedPairs(f).map((pair) => pair.map((m) => m.bytes).find((b) => b !== token));
const budgetCharges = () => rate.checkGlobalLimit.mock.calls.map(([, o]) => o.identifier);
const addresses = (list) => list.map((p) => p.address);

describe("api/pools: the pairing coins", () => {
  it("finds a token's pools with all three coins: SOL's first, then USDC's, then BAYLA's, deepest first within each", async () => {
    const sol = [{ address: k(1, 10), quote: WSOL, vault: k(1, 11), amount: 5 }, { address: k(2, 10), quote: WSOL, vault: k(2, 11), amount: 9 }];
    // The USDC pools hold far bigger numbers than any SOL pool and still come second:
    // amounts of different coins are never compared.
    const usdc = [{ address: k(1, 20), quote: USDC, vault: k(1, 21), amount: 10n ** 15n }, { address: k(2, 20), quote: USDC, vault: k(2, 21), amount: 10n ** 12n }];
    const bayla = [{ address: k(1, 30), quote: BAYLA, vault: k(1, 31), amount: 3 }, { address: k(2, 30), quote: BAYLA, vault: k(2, 31), amount: 7 }];
    // A TOKEN/JUNK pool: no scan asks for that pair, so it costs the answer nothing.
    const junk = { address: k(1, 40), quote: JUNK, vault: k(1, 41), amount: 10n ** 18n };
    const f = pairChain({ pools: [junk, ...bayla, ...usdc, ...sol] });
    const res = await ask({ mint: TOKEN_X }, f);
    expect(res.statusCode).toBe(200);
    expect(res.body.pools).toEqual([sol[1].address, sol[0].address, usdc[0].address, usdc[1].address, bayla[1].address, bayla[0].address]);
    expect(res.body.truncated).toBe(false);
    // One scan per coin, each on BOTH mint slots, in byte order (the pair has only one).
    const want = COINS.map((coin) => { const [a, b] = byteOrder(TOKEN_X, coin); return [{ offset: 168, bytes: a }, { offset: 200, bytes: b }]; });
    expect(scannedPairs(f)).toHaveLength(3);
    expect(scannedPairs(f)).toEqual(expect.arrayContaining(want));
    for (const scan of calls(f, "getProgramAccounts")) {
      expect(scan.params[0]).toBe(mod.CP_SWAP_PROGRAM);
      expect(scan.params[1].filters).toContainEqual({ dataSize: 637 });
      expect(scan.params[1].filters).toContainEqual({ memcmp: { offset: 0, bytes: mod.POOL_DISCRIMINATOR_B58 } });
    }
    // A small answer is ranked by one vault read for all three coins.
    expect(calls(f, "getMultipleAccounts")).toHaveLength(1);
  });

  it("a pairing coin is searched only with the coins that outrank it: BAYLA with SOL and USDC, USDC with SOL", async () => {
    const half = Math.floor(mod.MAX_POOLS / 2);
    const baylaSol = poolsOf(WSOL, 100, (i) => 1 + i, 10);
    const baylaUsdc = poolsOf(USDC, 100, (i) => 1 + i, 20);
    const f = pairChain({ token: BAYLA, mint: { owner: TOKEN22, data: mintBytes(300) }, pools: [...baylaSol, ...baylaUsdc] });
    const res = await ask({ mint: BAYLA }, f);
    expect(res.statusCode).toBe(200);
    expect(scannedCoins(f, BAYLA).sort()).toEqual([WSOL, USDC].sort());
    // Two coins scanned, so each is promised half the list (an odd slot would be SOL's).
    expect(res.body.pools).toEqual([...addresses(baylaSol).reverse().slice(0, mod.MAX_POOLS - half), ...addresses(baylaUsdc).reverse().slice(0, half)]);
    expect(res.body.truncated).toBe(true);
    expect(budgetCharges()).toEqual(["pools-precheck", "pools", "pools"]);

    rate.checkGlobalLimit.mockClear();
    const usdcSol = poolsOf(WSOL, 2, (i) => 1 + i, 10);
    const g = pairChain({ token: USDC, pools: usdcSol });
    const own = await ask({ mint: USDC }, g);
    expect(scannedCoins(g, USDC)).toEqual([WSOL]);
    expect(own.body.pools).toEqual(addresses(usdcSol).reverse());
    expect(budgetCharges()).toEqual(["pools-precheck", "pools"]);
  });

  it("promises each coin an equal share of the list, and hands unused slots on in coin order", () => {
    const M = mod.MAX_POOLS;
    const third = Math.floor(M / 3);
    // every coin over its promise: each gets its promise (slots left by the division go to SOL)
    expect(mod.shareSlots([500, 500, 500])).toEqual([M - 2 * third, third, third]);
    // everything fits: nothing is cut
    expect(mod.shareSlots([3, 2, 1])).toEqual([3, 2, 1]);
    // one coin alone takes the whole list, as before the other coins existed
    expect(mod.shareSlots([500, 0, 0])).toEqual([M, 0, 0]);
    expect(mod.shareSlots([0, 0, 500])).toEqual([0, 0, M]);
    // unused slots go to the highest-ranked coin that still has pools, then the next
    expect(mod.shareSlots([40, 300, 5])).toEqual([40, M - 45, 5]);
    expect(mod.shareSlots([300, 300, 5])).toEqual([M - third - 5, third, 5]);
    expect(mod.shareSlots([10, 20, 300])).toEqual([10, 20, M - 30]);
    // two coins scanned (BAYLA's own search), and one (USDC's)
    expect(mod.shareSlots([100, 100])).toEqual([M - Math.floor(M / 2), Math.floor(M / 2)]);
    expect(mod.shareSlots([10, 100])).toEqual([10, M - 10]);
    expect(mod.shareSlots([M + 1])).toEqual([M]);
  });

  it("for any pool counts: never over the cap, never more than a coin has, never under a coin's promise, and full whenever there are enough pools", () => {
    const M = mod.MAX_POOLS;
    const counts = [0, 1, 31, 32, 33, 47, 48, 49, 95, 96, 97, 500];
    const combos = (n) => (n === 0 ? [[]] : combos(n - 1).flatMap((rest) => counts.map((c) => [...rest, c])));
    for (const coins of [1, 2, 3]) {
      const promise = Math.floor(M / coins);
      for (const totals of combos(coins)) {
        const given = mod.shareSlots(totals);
        const listed = given.reduce((a, b) => a + b, 0);
        const label = JSON.stringify(totals);
        expect(listed, label).toBe(Math.min(M, totals.reduce((a, b) => a + b, 0)));
        given.forEach((g, i) => {
          expect(g, label).toBeLessThanOrEqual(totals[i]);
          expect(g, label).toBeGreaterThanOrEqual(Math.min(totals[i], promise));
        });
      }
    }
  });

  // The flood, one way: junk paired with a LOWER coin, holding "more" in raw numbers.
  it("hundreds of junk USDC pools leave every real SOL pool that fits SOL's promise in the list", async () => {
    const promise = Math.floor(mod.MAX_POOLS / 3);
    const real = poolsOf(WSOL, promise, (i) => 1_000 + i, 250);
    const junk = poolsOf(USDC, 300, (i) => 10n ** 15n + BigInt(i), 1);
    const res = await ask({ mint: TOKEN_X }, pairChain({ pools: [...junk, ...real] }));
    expect(res.body.pools).toHaveLength(mod.MAX_POOLS);
    expect(res.body.pools.slice(0, promise)).toEqual(addresses(real).reverse());
    // The junk gets what is left, BAYLA's unused share included: its own deepest, in order.
    expect(res.body.pools.slice(promise)).toEqual(addresses(junk).reverse().slice(0, mod.MAX_POOLS - promise));
    expect(res.body.truncated).toBe(true);
  });

  // The flood, the other way: junk paired with the TOP coin must not take the whole list.
  it("hundreds of junk SOL pools leave a real USDC pool and a real BAYLA pool in the list", async () => {
    const junk = poolsOf(WSOL, 300, (i) => 10n ** 15n + BigInt(i), 1);
    const [usdc] = poolsOf(USDC, 1, () => 5, 250);
    const [bayla] = poolsOf(BAYLA, 1, () => 5, 252);
    const res = await ask({ mint: TOKEN_X }, pairChain({ pools: [...junk, usdc, bayla] }));
    expect(res.body.pools).toHaveLength(mod.MAX_POOLS);
    expect(res.body.pools.slice(-2)).toEqual([usdc.address, bayla.address]);
    expect(res.body.pools.slice(0, -2)).toEqual(addresses(junk).reverse().slice(0, mod.MAX_POOLS - 2));
    expect(res.body.truncated).toBe(true);
  });

  it("when every coin is flooded, each coin's deepest pool still leads its own share", async () => {
    const promise = Math.floor(mod.MAX_POOLS / 3);
    const flood = COINS.flatMap((coin, c) => poolsOf(coin, 300, (i) => 1 + i, 1 + 2 * c));
    const real = COINS.map((coin, c) => ({ address: k(c, 250), quote: coin, vault: k(c, 251), amount: 10n ** 12n }));
    const res = await ask({ mint: TOKEN_X }, pairChain({ pools: [...flood, ...real] }));
    expect(res.body.pools).toHaveLength(mod.MAX_POOLS);
    // SOL's share starts the list, BAYLA's ends it, USDC's sits between.
    expect([0, mod.MAX_POOLS - 2 * promise, mod.MAX_POOLS - promise].map((at) => res.body.pools[at])).toEqual(addresses(real));
    expect(res.body.truncated).toBe(true);
  });

  it("slots one coin does not use go to the coin above it first", async () => {
    const M = mod.MAX_POOLS;
    // SOL has eight pools more than its promise, USDC is flooded, BAYLA has five.
    const sol = poolsOf(WSOL, Math.floor(M / 3) + 8, (i) => 1 + i, 10);
    const usdc = poolsOf(USDC, 300, (i) => 1 + i, 20);
    const bayla = poolsOf(BAYLA, 5, (i) => 1 + i, 30);
    const res = await ask({ mint: TOKEN_X }, pairChain({ pools: [...bayla, ...usdc, ...sol] }));
    // Every SOL pool is listed: SOL is first in line for the slots BAYLA left. USDC gets the rest.
    expect(res.body.pools).toEqual([...addresses(sol).reverse(), ...addresses(usdc).reverse().slice(0, M - sol.length - bayla.length), ...addresses(bayla).reverse()]);
    expect(res.body.truncated).toBe(true);
  });

  it("a token with SOL pools only is answered as it always was: every pool by SOL depth, cut at the cap", async () => {
    const junk = poolsOf(WSOL, 100, (i) => 1_000 + i, 1);
    const real = { address: k(0, 250), quote: WSOL, vault: k(0, 251), amount: 10n ** 12n };
    const res = await ask({ mint: TOKEN_X }, pairChain({ pools: [...junk, real] }));
    expect(res.body.pools).toEqual([real.address, ...addresses(junk).reverse().slice(0, mod.MAX_POOLS - 1)]);
    expect(res.body.truncated).toBe(true);

    // Exactly the cap: all of them, and nothing was cut.
    mod.__resetPoolIndexCache();
    const fits = await ask({ mint: TOKEN_X }, pairChain({ pools: junk.slice(0, mod.MAX_POOLS) }));
    expect(fits.body.pools).toEqual(addresses(junk.slice(0, mod.MAX_POOLS)).reverse());
    expect(fits.body.truncated).toBe(false);
  });

  it("says truncated exactly when a coin had more pools than it was given", async () => {
    const M = mod.MAX_POOLS;
    const third = Math.floor(M / 3);
    const cases = [
      // [SOL, USDC, BAYLA pools] → addresses listed, truncated
      [[2, 2, 2], 6, false],
      [[third, third, third], 3 * third, false],
      [[M - 2 * third + 1, third, third], M, true],
      [[0, M, 0], M, false],
      [[0, M + 1, 0], M, true],
      [[0, 0, M + 1], M, true],
      [[1, 1, M], M, true],
      [[0, 0, 0], 0, false],
    ];
    for (const [counts, listed, truncated] of cases) {
      mod.__resetPoolIndexCache();
      const pools = COINS.flatMap((coin, c) => poolsOf(coin, counts[c], (i) => 1 + i, 10 + 10 * c));
      const res = await ask({ mint: TOKEN_X }, pairChain({ pools }));
      expect(res.statusCode, JSON.stringify(counts)).toBe(200);
      expect(res.body.pools, JSON.stringify(counts)).toHaveLength(listed);
      expect(res.body.truncated, JSON.stringify(counts)).toBe(truncated);
    }
  });

  it("ranks a BAYLA pool by its Token-2022 vault, and a vault under the wrong token program last", async () => {
    const deep = { address: k(1, 30), quote: BAYLA, vault: k(1, 31), amount: 9 };
    const shallow = { address: k(2, 30), quote: BAYLA, vault: k(2, 31), amount: 5 };
    // A real, empty vault: a zero that was read still outranks a vault that does not
    // count, although its address sorts after theirs.
    const empty = { address: k(9, 30), quote: BAYLA, vault: k(9, 31), amount: 0 };
    // Holds the biggest number of all, but under the classic token program: not a BAYLA vault.
    const wrong = { address: k(4, 30), quote: BAYLA, vault: k(4, 31), amount: 10n ** 15n, vaultOwner: TOKEN };
    const missing = { address: k(5, 30), quote: BAYLA, vault: k(5, 31), amount: 0, vaultOwner: null };
    // And the other way round: a USDC vault must be under the classic program.
    const usdcReal = { address: k(1, 20), quote: USDC, vault: k(1, 21), amount: 1 };
    const usdcWrong = { address: k(2, 20), quote: USDC, vault: k(2, 21), amount: 10n ** 15n, vaultOwner: TOKEN22 };
    const res = await ask({ mint: TOKEN_X }, pairChain({ pools: [missing, wrong, empty, shallow, deep, usdcWrong, usdcReal] }));
    expect(res.statusCode).toBe(200);
    expect(res.body.pools).toEqual([usdcReal.address, usdcWrong.address, deep.address, shallow.address, empty.address, ...[wrong.address, missing.address].sort()]);
  });

  it("one coin's scan or ranking failing is a 502, never the other coins' pools as if they were all", async () => {
    // 150 SOL pools, so ranking takes two vault reads and only ONE of them fails.
    const pools = [...poolsOf(WSOL, 150, (i) => 1 + i, 10), ...poolsOf(USDC, 1, () => 1, 20), ...poolsOf(BAYLA, 1, () => 1, 30)];
    for (const what of ["failScan", "failRank"]) {
      for (const coin of [USDC, BAYLA, WSOL]) {
        mod.__resetPoolIndexCache();
        const res = await ask({ mint: TOKEN_X }, pairChain({ pools, [what]: coin }));
        expect(res.statusCode, `${what} ${coin}`).toBe(502);
        expect(res.body.pools, `${what} ${coin}`).toBeUndefined();
        // The failure was not remembered: the next question reads the chain again.
        const again = await ask({ mint: TOKEN_X }, pairChain({ pools: pools.slice(-2) }));
        expect(again.statusCode).toBe(200);
        expect(again.body.pools).toEqual(addresses(pools.slice(-2)));
      }
    }
  });

  it("more pools than it can rank with ONE coin is a 502; the limit is per coin, not on the sum", async () => {
    const over = poolsOf(USDC, mod.MAX_SCANNED + 1, () => 1, 1);
    const f = pairChain({ pools: [...over, ...poolsOf(WSOL, 1, () => 1, 10)] });
    const res = await ask({ mint: TOKEN_X }, f);
    expect(res.statusCode).toBe(502);
    expect(res.body.pools).toBeUndefined();
    expect(calls(f, "getMultipleAccounts")).toHaveLength(0);

    // Two coins under the limit whose sum is over it: still answered.
    mod.__resetPoolIndexCache();
    const each = mod.MAX_SCANNED / 2 + 1;
    const ok = await ask({ mint: TOKEN_X }, pairChain({ pools: [...poolsOf(WSOL, each, () => 1, 1), ...poolsOf(USDC, each, () => 1, 3)] }));
    expect(ok.statusCode).toBe(200);
    expect(ok.body.pools).toHaveLength(mod.MAX_POOLS);
    expect(ok.body.truncated).toBe(true);
  }, 60_000);

  it("charges the scan budget once per scan, all of it before the first scan, and the visitor once per request", async () => {
    const pools = COINS.flatMap((coin, c) => poolsOf(coin, 1, () => 1, 10 + 10 * c));
    const f = pairChain({ pools });
    const res = await ask({ mint: TOKEN_X }, f);
    expect(res.statusCode).toBe(200);
    expect(budgetCharges()).toEqual(["pools-precheck", "pools", "pools", "pools"]);
    expect(rate.checkRateLimit).toHaveBeenCalledTimes(1);

    // A repeat question is a cache hit: no upstream call and no charge, however many coins.
    const n = f.mock.calls.length;
    const again = await ask({ mint: TOKEN_X }, f);
    expect(again.body.pools).toEqual(res.body.pools);
    expect(f.mock.calls.length).toBe(n);
    expect(budgetCharges()).toHaveLength(4);
    expect(rate.checkRateLimit).toHaveBeenCalledTimes(1);

    // An LP-mint lookup is one scan: one charge.
    rate.checkGlobalLimit.mockClear();
    await ask({ lpMint: LP }, chain({ lpPools: [k(5)] }));
    expect(budgetCharges()).toEqual(["pools-precheck", "pools"]);

    // The budget runs out on the THIRD scan's charge: no scan at all is sent.
    mod.__resetPoolIndexCache();
    let charged = 0;
    rate.checkGlobalLimit.mockImplementation(async (r, o) => {
      if (o.identifier === "pools" && ++charged === 3) { r.status(503).json({ error: "busy" }); return false; }
      return true;
    });
    const g = pairChain({ pools });
    let shed;
    try {
      shed = await ask({ mint: TOKEN_X }, g);
    } finally {
      rate.checkGlobalLimit.mockImplementation(async () => true);
    }
    expect(shed.statusCode).toBe(503);
    expect(calls(g, "getProgramAccounts")).toHaveLength(0);
  });

  it("answers in the shape it always had, so a browser on older code keeps working", async () => {
    const pools = COINS.flatMap((coin, c) => poolsOf(coin, 1, () => 1, 10 + 10 * c));
    const res = await ask({ mint: TOKEN_X }, pairChain({ pools }));
    expect(Object.keys(res.body).sort()).toEqual(["mint", "pools", "program", "readAt", "truncated"]);
    expect(res.body).toMatchObject({ mint: TOKEN_X, program: mod.CP_SWAP_PROGRAM, pools: addresses(pools), truncated: false });
    expect(res.body.pools.every((p) => typeof p === "string")).toBe(true);
    const lp = await ask({ lpMint: LP }, chain({ lpPools: [k(5)] }));
    expect(Object.keys(lp.body).sort()).toEqual(["lpMint", "pools", "program", "readAt", "truncated"]);
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
