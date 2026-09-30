// The pool index for our Solana pool program (cp-swap): `?resource=pools` on the
// aggregator catchall, reached through the vercel.json rewrite /api/pools (no function
// of its own; see api/SERVERLESS_BUDGET.md).
//
//   GET /api/pools?mint=<token mint>     → addresses of pools that hold this token
//   GET /api/pools?lpMint=<LP mint>      → the address of the pool whose share this is
//
// WHY A SERVER FUNCTION. The browser cannot list pools: `getProgramAccounts` stays OFF
// the /api/solrpc proxy (an open scan against a keyed RPC is the hole audit L-1 closed).
// But pools can sit at ANY address that signed their creation, so reading the "standard"
// address for a pair is not enough: a stranger can take that address first at a bad
// price or with an open time years away. This function does the one scan that finds
// them all, filtered so the RPC only walks pool accounts holding the token, and caches
// the answer.
//
// WHAT IT RETURNS: ADDRESSES ONLY. The browser reads every address itself and checks it
// (owned by the program, decodes as a pool, holds the token). So this function is never
// trusted with a fact about a pool; at worst it can leave one out, which the page says.
//
// Hardening: GET only; the shared request-origin gate; the query must be exactly one
// base58 32-byte key (decoded, not pattern-matched); per-IP and global rate limits on
// cache MISSES (a cache hit costs the upstream nothing); a response cap; the keyed RPC
// URL never leaves the server. Upstream failure is a 502, never an empty list: "no pools"
// is only ever said when the scan answered.
import { base58 } from "@scure/base";
import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";
import { isRequestOriginAllowed } from "./aggregator-proxy.js";

/** The live cp-swap program (vault-owned), the same id on the local e2e validator. */
export const CP_SWAP_PROGRAM = "EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT";
/** PoolState: `#[repr(C, packed)]`, 637 bytes with the discriminator (frontend program.ts). */
export const POOL_STATE_LEN = 637;
export const POOL_DISCRIMINATOR_B58 = base58.encode(Uint8Array.from([247, 237, 227, 245, 215, 195, 222, 70]));
export const OFFSETS = Object.freeze({ lpMint: 136, token0Mint: 168, token1Mint: 200 });
export const MAX_POOLS = 50;

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 500;
const RATE = { limit: 30, windowSec: 60, identifier: "pools" };
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

/** One filtered scan: pool accounts with `key` at `offset`, keys only (dataSlice length 0). */
async function scan(offset, key, fetchImpl) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccounts",
    params: [
      CP_SWAP_PROGRAM,
      {
        encoding: "base64",
        commitment: "confirmed",
        dataSlice: { offset: 0, length: 0 },
        filters: [
          { dataSize: POOL_STATE_LEN },
          { memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR_B58 } },
          { memcmp: { offset, bytes: key } },
        ],
      },
    ],
  };
  const res = await fetchImpl(upstreamUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  const { text, truncated } = await readBoundedText(res, MAX_RESPONSE_BYTES);
  if (truncated) throw new Error("upstream response over cap");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("upstream answer is not an object");
  if (parsed.error) throw new Error(`upstream error ${String(parsed.error.code ?? "")}`);
  // A body with no `result` is a non-answer, never "no pools".
  if (!Array.isArray(parsed.result)) throw new Error("upstream answer carried no result list");
  const out = [];
  for (const item of parsed.result) {
    const k = parseKey(item && item.pubkey);
    if (!k) throw new Error("upstream answer carried an invalid address");
    out.push(k);
  }
  return out;
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

  const cacheKey = `${which}:${key}`;
  const hit = cache.get(cacheKey);
  let payload;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    payload = hit.payload;
  } else {
    if (!(await checkRateLimit(req, res, RATE))) return;
    if (!(await checkGlobalLimit(res, GLOBAL))) return;
    let found;
    try {
      const lists = which === "mint"
        ? await Promise.all([scan(OFFSETS.token0Mint, key, fetchImpl), scan(OFFSETS.token1Mint, key, fetchImpl)])
        : [await scan(OFFSETS.lpMint, key, fetchImpl)];
      found = [...new Set(lists.flat())].sort();
    } catch (err) {
      console.error("[pools] scan failed:", logSafe(err));
      return res.status(502).json({ error: "The pool index could not read the chain" });
    }
    payload = {
      [which]: key,
      program: CP_SWAP_PROGRAM,
      pools: found.slice(0, MAX_POOLS),
      truncated: found.length > MAX_POOLS,
      readAt: new Date().toISOString(),
    };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { at: Date.now(), payload });
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=30");
  return res.status(200).json(payload);
}
