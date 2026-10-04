// The pool index for our Solana pool program (cp-swap): `?resource=pools` on the
// aggregator catchall, reached through the vercel.json rewrite /api/pools (no function
// of its own; see api/SERVERLESS_BUDGET.md).
//
//   GET /api/pools?mint=<token mint>     → this token's pools with each pairing coin: SOL's
//                                           first, then USDC's, then BAYLA's, deepest first
//                                           within a coin
//   GET /api/pools?lpMint=<LP mint>      → the address of the pool whose share this is
//
// WHY A SERVER FUNCTION. The browser cannot list pools: `getProgramAccounts` stays OFF
// the /api/solrpc proxy (an open scan against a keyed RPC is the hole audit L-1 closed).
// But pools can sit at ANY address that signed their creation, so reading the "standard"
// address for a pair is not enough: a stranger can take that address first at a bad
// price or with an open time years away. This function does the scans that find them
// all, one per pairing coin, each filtered so the RPC only walks pool accounts of that
// exact pair, and caches the answer.
//
// WHICH COINS. A pool on this site pairs a token with SOL, USDC or BAYLA (owner ruling
// 2026-10-03; `QUOTE_COINS` below, in rank order). `?mint=X` scans X with every coin.
// When X is itself a coin, only with the coins that outrank it: a BAYLA/SOL pool is
// BAYLA's pool and never SOL's, so BAYLA is searched with SOL and USDC, USDC with SOL,
// and SOL itself is a 400. The same rule as the browser's `quotesFor`.
//
// WHAT IT RETURNS: ADDRESSES ONLY. The browser reads every address itself and checks it
// (owned by the program, decodes as a pool, holds the token). So this function is never
// trusted with a fact about a pool; at worst it can leave one out, which the page says.
// The answer does not say which coin an address is paired with: the browser reads that
// from the pool itself, and the shape is the one a browser on older code expects.
//
// FLOODING. Opening a pool costs little (rent only on fee tier 0), and a pool can sit at
// any keypair, whose address an attacker can grind to sort first. So the list is:
//   - pairing coins only: each scan matches BOTH mint slots (token0 < token1 is enforced
//     by initialize.rs:54 and initialize_with_permission.rs:57, so a pair has one order),
//     and a pile of TOKEN/JUNK pools costs the answer nothing;
//   - ranked, within a coin, by how much of THAT coin each pool holds, never by address.
//     A vault counts only when the coin's own token program owns it. EVERY pool a scan
//     finds is ranked. Ranking only an address-ordered subset would let ground addresses
//     decide which pools are even weighed;
//   - never ranked across coins: 5 SOL and 5 USDC are not the same depth, and this
//     function reads no price. Each coin's pools stay together, in coin order;
//   - shared by promise: with k coins scanned, each coin is promised floor(MAX_POOLS / k)
//     addresses, and what a coin does not use goes to the others, highest rank first. So
//     junk pools paired with one coin can never push a real pool paired with ANOTHER coin
//     below that coin's promise. To push a real pool off the list an attacker must put
//     more of its own coin than it holds into each of at least that many pools (32 for
//     an ordinary token, and all MAX_POOLS when the other coins have no pools);
//   - more than MAX_SCANNED pools with any one coin is a 502 ("could not read"), never a
//     cut list;
//   - `truncated` when any coin had more pools than it was given; the page then never
//     says "no pools".
//
// ALL OR NOTHING. If any coin's scan or ranking fails, the whole answer is a 502 and
// nothing is cached. A list missing one coin's pools would read as "this token has no
// pools with that coin", which nobody read.
//
// RATE LIMITS, on cache MISSES only (a cache hit costs the upstream nothing):
//   - per IP, counted per REQUEST: a visitor asked one question, whatever it costs us;
//   - the global scan budget (POOLS_GLOBAL_RPM), counted per SCAN: a `?mint=` miss is
//     charged once for each coin it scans (three for an ordinary token), all of them
//     before the first scan is sent. The budget exists to cap what the keyed RPC is
//     asked for, and the scan is the costly call. Counted per request, the same number
//     would let three times the scans through that it was set to allow. The price: 600
//     a minute now covers 200 ordinary-token misses, not 600. Raise the env if real
//     traffic needs more.
//
// Hardening: GET only; the shared request-origin gate; the query must be exactly one
// base58 32-byte key (decoded, not pattern-matched); the key must be a token mint
// (one cheap account read, on its own global budget) before any scan is paid for, and a
// key that is not one is remembered for 10 minutes, so random keys cannot spend the scan
// budget; a response cap; the keyed RPC URL never leaves the server. Upstream failure
// is a 502, never an empty list: "no pools" is only ever said when every scan answered.
import { base58 } from "@scure/base";
import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";
import { isRequestOriginAllowed } from "./aggregator-proxy.js";

/** The live cp-swap program (vault-owned), the same id on the local e2e validator. */
export const CP_SWAP_PROGRAM = "EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const BAYLA_MINT = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/**
 * The coins a pool may pair a token with, in rank order. The server's own copy of
 * `QUOTE_COINS` in src/lib/solana/lp/quotes.ts (api/ is plain JS and does not import
 * it). A test pins the two together: same mints, same token programs, same order. So a
 * coin added in one place and not the other fails CI.
 * `program` is the token program the coin's mint is under, so the one a pool's vault
 * for that coin is under.
 */
export const QUOTE_COINS = Object.freeze([
  Object.freeze({ symbol: "SOL", mint: WSOL_MINT, program: TOKEN_PROGRAM }),
  Object.freeze({ symbol: "USDC", mint: USDC_MINT, program: TOKEN_PROGRAM }),
  Object.freeze({ symbol: "BAYLA", mint: BAYLA_MINT, program: TOKEN_2022_PROGRAM }),
]);
/** PoolState: `#[repr(C, packed)]`, 637 bytes with the discriminator (frontend program.ts). */
export const POOL_STATE_LEN = 637;
export const POOL_DISCRIMINATOR_B58 = base58.encode(Uint8Array.from([247, 237, 227, 245, 215, 195, 222, 70]));
export const OFFSETS = Object.freeze({ token0Vault: 72, lpMint: 136, token0Mint: 168, token1Mint: 200 });
/**
 * Addresses returned per answer. The browser refuses a longer list (poolIndex.ts
 * `POOL_INDEX_MAX`, pinned to this by a test). It reads these plus the few it works out
 * itself: the launch pool, and two standard addresses for each coin.
 */
export const MAX_POOLS = 96;
/**
 * More pools than this for one token with ONE coin is answered as a 502, not ranked:
 * about 300 SOL of never-refunded rent to reach, and 100 vault reads (8 at a time) to
 * rank. Per coin, so three coins at the limit is 300 reads.
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
/** The scan budget: charged once per SCAN, so once per coin on a `?mint=` miss (RATE LIMITS above). */
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
 * The coins `mint` can be paired with, in rank order: every coin, or, when `mint` is
 * itself a coin, only the coins that outrank it. SOL has none. The same rule as
 * `quotesFor` in src/lib/solana/lp/quotes.ts, pinned to it by a test.
 */
export function quotesFor(mint) {
  const rank = QUOTE_COINS.findIndex((q) => q.mint === mint);
  return rank < 0 ? [...QUOTE_COINS] : QUOTE_COINS.slice(0, rank);
}

/**
 * How many addresses each scanned coin gets, given how many pools each has (`totals`, in
 * rank order). Every coin is promised floor(max / k). Slots a coin does not use go to
 * the others, highest rank first. A coin never gets less than its promise because
 * another coin has many pools.
 */
export function shareSlots(totals, max = MAX_POOLS) {
  const promised = Math.floor(max / totals.length);
  const given = totals.map((n) => Math.min(n, promised));
  let spare = max - given.reduce((a, b) => a + b, 0);
  for (let i = 0; i < totals.length && spare > 0; i++) {
    const more = Math.min(spare, totals[i] - given[i]);
    given[i] += more;
    spare -= more;
  }
  return given;
}

/**
 * One coin's scan: every pool of exactly `mint` and `coin` (both mint slots matched),
 * each with the key of its vault for the coin. Not ranked yet.
 */
async function scanPair(mint, coin, fetchImpl) {
  const coinIs0 = compareBytes(base58.decode(coin.mint), base58.decode(mint)) < 0;
  const [token0, token1] = coinIs0 ? [coin.mint, mint] : [mint, coin.mint];
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
    // `depth` is how much of the coin the vault holds. -1 until read, and it stays -1 for
    // a vault that is missing or odd, which ranks last.
    pools.push({ address, vault: base58.encode(Uint8Array.from(slice.subarray(coinIs0 ? 0 : 32, coinIs0 ? 32 : 64))), program: coin.program, depth: -1n });
  }
  if (pools.length > MAX_SCANNED) throw new Error(`more than ${MAX_SCANNED} ${coin.symbol} pools for one token`);
  return pools;
}

/**
 * Every pool of `mint` with each of `coins`: one list of addresses per coin, in the
 * order given, deepest first. One scan per coin, then every pool's vault for its coin is
 * read to rank it. Throws when ANY scan or vault read failed, so one coin's failure
 * never leaves an answer that looks whole.
 */
async function scanPools(mint, coins, fetchImpl) {
  const scans = await Promise.all(coins.map((coin) => scanPair(mint, coin, fetchImpl)));
  // Vault reads for all the coins share the calls (100 keys each, 8 calls at a time): an
  // ordinary answer is ranked by ONE read, however many coins were scanned.
  const all = scans.flat();
  const chunks = [];
  for (let i = 0; i < all.length; i += RANK_CHUNK) chunks.push(all.slice(i, i + RANK_CHUNK));
  const readChunk = async (chunk) => {
    const r = await rpc(
      "getMultipleAccounts",
      [chunk.map((p) => p.vault), { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 64, length: 8 } }],
      fetchImpl,
    );
    if (!r || typeof r !== "object" || !Array.isArray(r.value) || r.value.length !== chunk.length) {
      throw new Error("upstream vault answer has the wrong shape");
    }
    r.value.forEach((acc, j) => {
      // A vault counts only under its coin's own token program (BAYLA's is Token-2022).
      // A missing or odd vault ranks last; the browser reads and judges it anyway.
      if (acc && acc.owner === chunk[j].program) {
        const b = base64Of(acc);
        if (b.length === 8) chunk[j].depth = b.readBigUInt64LE(0);
      }
    });
  };
  for (let i = 0; i < chunks.length; i += RANK_CONCURRENCY) {
    await Promise.all(chunks.slice(i, i + RANK_CONCURRENCY).map(readChunk));
  }
  // Each coin is sorted on its own: amounts of different coins are never compared.
  const deepestFirst = (a, b) => {
    if (a.depth !== b.depth) return a.depth > b.depth ? -1 : 1;
    return a.address < b.address ? -1 : 1;
  };
  return scans.map((pools) => pools.sort(deepestFirst).map((p) => p.address));
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
  // SOL is the top coin: no coin outranks it, so it is never the token of a pool.
  const coins = which === "mint" ? quotesFor(key) : null;
  if (coins && coins.length === 0) {
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
    let truncated;
    try {
      if (!(await isTokenMint(key, which, fetchImpl))) {
        remember(cacheKey, { notAMint: true });
        return res.status(404).json({ error: "That address is not a token mint" });
      }
      if (coins) {
        // One charge per scan, all taken before the first scan is sent (RATE LIMITS above).
        for (let i = 0; i < coins.length; i++) {
          if (!(await checkGlobalLimit(res, GLOBAL))) return;
        }
        const lists = await scanPools(key, coins, fetchImpl);
        const given = shareSlots(lists.map((l) => l.length));
        found = lists.flatMap((l, i) => l.slice(0, given[i]));
        truncated = lists.some((l, i) => l.length > given[i]);
      } else {
        if (!(await checkGlobalLimit(res, GLOBAL))) return;
        const all = [...new Set(await scanLpMint(key, fetchImpl))].sort();
        found = all.slice(0, MAX_POOLS);
        truncated = all.length > MAX_POOLS;
      }
    } catch (err) {
      console.error("[pools] scan failed:", logSafe(err));
      return res.status(502).json({ error: "The pool index could not read the chain" });
    }
    payload = {
      [which]: key,
      program: CP_SWAP_PROGRAM,
      pools: found,
      truncated,
      readAt: new Date().toISOString(),
    };
    remember(cacheKey, { payload });
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=30");
  return res.status(200).json(payload);
}
