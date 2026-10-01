// The pool index for our Solana pool program (cp-swap): `?resource=pools` on the
// aggregator catchall, reached through the vercel.json rewrite /api/pools (no function
// of its own; see api/SERVERLESS_BUDGET.md).
//
//   GET /api/pools?mint=<token mint>     → TOKEN/SOL pools of this token, deepest SOL first
//   GET /api/pools?lpMint=<LP mint>      → the address of the pool whose share this is
//
// WHY A SERVER FUNCTION. The browser cannot list pools: `getProgramAccounts` stays OFF
// the /api/solrpc proxy (an open scan against a keyed RPC is the hole audit L-1 closed).
// But pools can sit at ANY address that signed their creation, so reading the "standard"
// address for a pair is not enough: a stranger can take that address first at a bad
// price or with an open time years away. This function does the one scan that finds
// them all, filtered so the RPC only walks pool accounts of this exact pair, and caches
// the answer.
//
// WHAT IT RETURNS: ADDRESSES ONLY. The browser reads every address itself and checks it
// (owned by the program, decodes as a pool, holds the token). So this function is never
// trusted with a fact about a pool; at worst it can leave one out, which the page says.
//
// FLOODING. Opening a pool costs little (rent only on fee tier 0), and a pool can sit at
// any keypair, whose address an attacker can grind to sort first. So the list is:
//   - TOKEN/SOL only: the scan matches BOTH mint slots (token0 < token1 is enforced by
//     initialize.rs:54 and initialize_with_permission.rs:57, so the pair has one order),
//     and a pile of TOKEN/JUNK pools costs the answer nothing;
//   - ranked by the SOL each pool holds, never by address: to push a real pool off the
//     list an attacker must put more SOL than it holds into each of MAX_POOLS pools.
//     EVERY pool the scan finds is ranked. Ranking only an address-ordered subset would
//     let ground addresses decide which pools are even weighed;
//   - more than MAX_SCANNED pools is a 502 ("could not read"), never a cut list;
//   - `truncated` when there were more; the page then never says "no pools".
//
// Hardening: GET only; the shared request-origin gate; the query must be exactly one
// base58 32-byte key (decoded, not pattern-matched); the key must be a token mint
// (one cheap account read, on its own global budget) before any scan is paid for, and a
// key that is not one is remembered for 10 minutes, so random keys cannot spend the scan
// budget; per-IP and global rate limits on cache MISSES (a cache hit costs the upstream
// nothing); a response cap; the keyed RPC URL never leaves the server. Upstream failure
// is a 502, never an empty list: "no pools" is only ever said when the scan answered.
import { base58 } from "@scure/base";
import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";
import { isRequestOriginAllowed } from "./aggregator-proxy.js";

/** The live cp-swap program (vault-owned), the same id on the local e2e validator. */
export const CP_SWAP_PROGRAM = "EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** PoolState: `#[repr(C, packed)]`, 637 bytes with the discriminator (frontend program.ts). */
export const POOL_STATE_LEN = 637;
export const POOL_DISCRIMINATOR_B58 = base58.encode(Uint8Array.from([247, 237, 227, 245, 215, 195, 222, 70]));
export const OFFSETS = Object.freeze({ token0Vault: 72, lpMint: 136, token0Mint: 168, token1Mint: 200 });
/** Addresses returned per answer (the browser reads these plus 3 it works out: 99, one call). */
export const MAX_POOLS = 96;
/**
 * More TOKEN/SOL pools than this for one token is answered as a 502, not ranked: about
 * 300 SOL of never-refunded rent to reach, and 100 vault reads (8 at a time) to rank.
 */
export const MAX_SCANNED = 10_000;
const RANK_CHUNK = 100;
const RANK_CONCURRENCY = 8;
/** Per chain call. The sibling handlers carry one too (heat.js, record-solana.js). */
const RPC_TIMEOUT_MS = 8000;

const CACHE_TTL_MS = 30_000;
const NOT_A_MINT_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
const RATE = { limit: 30, windowSec: 60, identifier: "pools" };
/** The cheap "is this a token mint" read has its own budget, so random keys cannot spend the scan budget. */
const PRECHECK = { limit: Number(process.env.POOLS_PRECHECK_GLOBAL_RPM) || 3000, windowSec: 60, identifier: "pools-precheck" };
const GLOBAL = { limit: Number(process.env.POOLS_GLOBAL_RPM) || 600, windowSec: 60, identifier: "pools" };

const cache = new Map();

/** Tests and the e2e harness only: forget every cached answer. */
export function __resetPoolIndexCache() {
  cache.clear();
}

/** A base58 string that decodes to exactly 32 bytes, re-encoded canonically; else null. */
export function parseKey(v) {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return null;
  try {
    const bytes = base58.decode(v);
    if (bytes.length !== 32) return null;
    const canonical = base58.encode(bytes);
    return canonical === v ? canonical : null;
  } catch {
    return null;
  }
}

function upstreamUrl() {
  return process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
}

/** One JSON-RPC call; returns `result`, throws on anything else (never "empty"). */
async function rpc(method, params, fetchImpl) {
  const res = await fetchImpl(upstreamUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  const { text, truncated } = await readBoundedText(res, MAX_RESPONSE_BYTES);
  if (truncated) throw new Error("upstream response over cap");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("upstream answer is not an object");
  if (parsed.error) throw new Error(`upstream error ${String(parsed.error.code ?? "")}`);
  if (!("result" in parsed)) throw new Error("upstream answer carried no result");
  return parsed.result;
}

function base64Of(account) {
  const d = account && account.data;
  const b64 = Array.isArray(d) ? d[0] : null;
  if (typeof b64 !== "string") throw new Error("upstream account carried no base64 data");
  return Buffer.from(b64, "base64");
}

/**
 * Is `key` an initialized token mint? `lpMint` must be a classic SPL mint (every pool's
 * LP mint is); a `mint` may also be Token-2022. Throws when the chain did not answer.
 */
async function isTokenMint(key, which, fetchImpl) {
  const result = await rpc("getAccountInfo", [key, { encoding: "base64", commitment: "confirmed" }], fetchImpl);
  if (!result || typeof result !== "object" || !("value" in result)) throw new Error("upstream answer carried no value");
  const v = result.value;
  if (v === null) return false;
  if (typeof v !== "object" || typeof v.owner !== "string") throw new Error("upstream account carried no owner");
  const data = base64Of(v);
  if (data.length < 82 || data[45] !== 1) return false;
  if (v.owner === TOKEN_PROGRAM) return data.length === 82;
  if (v.owner === TOKEN_2022_PROGRAM && which === "mint") return data.length === 82 || (data.length > 165 && data[165] === 1);
  return false;
}

function compareBytes(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const poolFilters = (extra) => [{ dataSize: POOL_STATE_LEN }, { memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR_B58 } }, ...extra];

/** Every pool whose LP mint is `lpMint`: addresses only. */
async function scanLpMint(lpMint, fetchImpl) {
  const result = await rpc(
    "getProgramAccounts",
    [CP_SWAP_PROGRAM, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 }, filters: poolFilters([{ memcmp: { offset: OFFSETS.lpMint, bytes: lpMint } }]) }],
    fetchImpl,
  );
  if (!Array.isArray(result)) throw new Error("upstream answer carried no result list");
  return result.map((item) => {
    const k = parseKey(item && item.pubkey);
    if (!k) throw new Error("upstream answer carried an invalid address");
    return k;
  });
}

/**
 * Every TOKEN/SOL pool of `mint`, deepest SOL side first: one scan that matches both
 * mint slots and returns each pool's two vault keys, then the SOL vault balances.
 */
async function scanSolPools(mint, fetchImpl) {
  const solIs0 = compareBytes(base58.decode(WSOL_MINT), base58.decode(mint)) < 0;
  const [token0, token1] = solIs0 ? [WSOL_MINT, mint] : [mint, WSOL_MINT];
  const result = await rpc(
    "getProgramAccounts",
    [
      CP_SWAP_PROGRAM,
      {
        encoding: "base64",
        commitment: "confirmed",
        dataSlice: { offset: OFFSETS.token0Vault, length: 64 },
        filters: poolFilters([{ memcmp: { offset: OFFSETS.token0Mint, bytes: token0 } }, { memcmp: { offset: OFFSETS.token1Mint, bytes: token1 } }]),
      },
    ],
    fetchImpl,
  );
  if (!Array.isArray(result)) throw new Error("upstream answer carried no result list");
  const seen = new Set();
  const pools = [];
  for (const item of result) {
    const address = parseKey(item && item.pubkey);
    if (!address) throw new Error("upstream answer carried an invalid address");
    const slice = base64Of(item.account);
    if (slice.length !== 64) throw new Error("upstream answer carried a wrong-sized slice");
    if (seen.has(address)) continue;
    seen.add(address);
    pools.push({ address, solVault: base58.encode(Uint8Array.from(slice.subarray(solIs0 ? 0 : 32, solIs0 ? 32 : 64))) });
  }
  if (pools.length > MAX_SCANNED) throw new Error(`more than ${MAX_SCANNED} pools for one token`);
  const ranked = pools;
  const depth = new Map();
  const chunks = [];
  for (let i = 0; i < ranked.length; i += RANK_CHUNK) chunks.push(ranked.slice(i, i + RANK_CHUNK));
  const readChunk = async (chunk) => {
    const r = await rpc(
      "getMultipleAccounts",
      [chunk.map((p) => p.solVault), { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 64, length: 8 } }],
      fetchImpl,
    );
    if (!r || typeof r !== "object" || !Array.isArray(r.value) || r.value.length !== chunk.length) {
      throw new Error("upstream vault answer has the wrong shape");
    }
    r.value.forEach((acc, j) => {
      // A missing or odd vault ranks last; the browser reads and judges it anyway.
      let amount = -1n;
      if (acc && acc.owner === TOKEN_PROGRAM) {
        const b = base64Of(acc);
        if (b.length === 8) amount = b.readBigUInt64LE(0);
      }
      depth.set(chunk[j].address, amount);
    });
  };
  for (let i = 0; i < chunks.length; i += RANK_CONCURRENCY) {
    await Promise.all(chunks.slice(i, i + RANK_CONCURRENCY).map(readChunk));
  }
  ranked.sort((a, b) => {
    const da = depth.get(a.address);
    const db = depth.get(b.address);
    if (da !== db) return da > db ? -1 : 1;
    return a.address < b.address ? -1 : 1;
  });
  return { list: ranked.map((p) => p.address), total: pools.length };
}

function remember(cacheKey, entry) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { at: Date.now(), ...entry });
}

export async function handlePoolIndex(req, res, fetchImpl = fetch) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isRequestOriginAllowed(req)) return res.status(403).json({ error: "Origin not allowed" });

  // `resource` is the catchall's own routing key (the rewrite adds it); nothing else
  // may ride along.
  const q = { ...(req.query || {}) };
  delete q.resource;
  const keys = Object.keys(q);
  const which = keys.length === 1 && (keys[0] === "mint" || keys[0] === "lpMint") ? keys[0] : null;
  const key = which ? parseKey(q[which]) : null;
  if (!which || !key) {
    return res.status(400).json({ error: "Give exactly one of mint or lpMint, as a Solana address" });
  }
  if (which === "mint" && key === WSOL_MINT) {
    return res.status(400).json({ error: "Give the other token of the pair, not SOL itself" });
  }

  const cacheKey = `${which}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.notAMint && Date.now() - hit.at < NOT_A_MINT_TTL_MS) {
    return res.status(404).json({ error: "That address is not a token mint" });
  }
  let payload;
  if (hit && hit.payload && Date.now() - hit.at < CACHE_TTL_MS) {
    payload = hit.payload;
  } else {
    if (!(await checkRateLimit(req, res, RATE))) return;
    if (!(await checkGlobalLimit(res, PRECHECK))) return;
    let found;
    let total;
    try {
      if (!(await isTokenMint(key, which, fetchImpl))) {
        remember(cacheKey, { notAMint: true });
        return res.status(404).json({ error: "That address is not a token mint" });
      }
      if (!(await checkGlobalLimit(res, GLOBAL))) return;
      if (which === "mint") {
        ({ list: found, total } = await scanSolPools(key, fetchImpl));
      } else {
        found = [...new Set(await scanLpMint(key, fetchImpl))].sort();
        total = found.length;
      }
    } catch (err) {
      console.error("[pools] scan failed:", logSafe(err));
      return res.status(502).json({ error: "The pool index could not read the chain" });
    }
    payload = {
      [which]: key,
      program: CP_SWAP_PROGRAM,
      pools: found.slice(0, MAX_POOLS),
      truncated: total > MAX_POOLS,
      readAt: new Date().toISOString(),
    };
    remember(cacheKey, { payload });
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=30");
  return res.status(200).json(payload);
}
