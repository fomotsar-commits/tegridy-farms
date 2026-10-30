// The venue's total value locked, `?resource=venue-tvl` on the catchall, for the home page.
// Read from the chains when asked, at most once a minute per instance (the edge keeps the
// answer for a minute too), and stored nowhere. A chain that cannot be read is named in the
// answer and left out of the total, which then says it is partial: never a zero.
//
// WHAT IS COUNTED, AND AT WHAT VALUE
//   - Solana, our pool program: every pool holding SOL, USDC or BAYLA, at twice that coin
//     (the highest-ranked one it holds, pool-index.js's rule). The two sides of a
//     constant-product pool are worth the same at its price.
//   - Solana, our range-pool program: the SOL, USDC and BAYLA it holds, and nothing for any
//     other coin. A range pool's price is whatever its depositors set, so valuing its other
//     side at that price would let anyone make the total say anything.
//   - Ethereum, Base and Robinhood: every pair our factory made that holds WETH, at twice it.
// Only those coins add dollars, so pools of worthless tokens add nothing: the figure moves
// only when SOL, USDC, BAYLA or ETH really sit in our pools.
//
// PRICES: SOL and ETH from Coinbase, then CoinGecko (the volume counter's spotPrice). USDC is
// a dollar. BAYLA is valued at its price in our deepest BAYLA/SOL pool, else BAYLA/USDC; with
// neither, the pools it would value are left out and the answer says so.
import { base58 } from "@scure/base";
import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";
import { CP_SWAP_PROGRAM, OFFSETS, POOL_DISCRIMINATOR_B58, POOL_STATE_LEN, QUOTE_COINS } from "./pool-index.js";
import { EVM_CHAINS } from "../../scripts/lib/venue-volume-chain.mjs";
import { spotPrice } from "../../scripts/venue-volume.mjs";

/** The range-pool program and its PoolState, copied from src/lib/solana/clmm (a test pins them). */
export const RANGE_PROGRAM = "7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso";
export const RANGE_POOL_LEN = 1544;
export const RANGE_OFFSETS = Object.freeze({ tokenMint0: 73, tokenMint1: 105, tokenVault0: 137, tokenVault1: 169 });

/** The two Solana programs, each with where its pool keeps its mints and vaults. */
export const SOLANA_PROGRAMS = Object.freeze([
  Object.freeze({
    program: CP_SWAP_PROGRAM,
    size: POOL_STATE_LEN,
    mint0: OFFSETS.token0Mint,
    mint1: OFFSETS.token1Mint,
    vault0: OFFSETS.token0Vault,
    vault1: OFFSETS.token0Vault + 32,
    doubled: true,
  }),
  Object.freeze({
    program: RANGE_PROGRAM,
    size: RANGE_POOL_LEN,
    mint0: RANGE_OFFSETS.tokenMint0,
    mint1: RANGE_OFFSETS.tokenMint1,
    vault0: RANGE_OFFSETS.tokenVault0,
    vault1: RANGE_OFFSETS.tokenVault1,
    doubled: false,
  }),
]);
export const EVM_TVL_CHAINS = Object.freeze(["ethereum", "base", "robinhood"]);

/** More pools than this on one program, or pairs on one factory, reads as "could not read". */
export const MAX_POOLS = 5000;
export const MAX_PAIRS = 1000;
const SCAN_CAP_BYTES = 8 * 1024 * 1024;
const RPC_TIMEOUT_MS = 8000;
const VAULT_CHUNK = 100;
const CACHE_MS = 60_000;
const PARTIAL_CACHE_MS = 15_000;
const RATE = { limit: 30, windowSec: 60, identifier: "venue-tvl" };
const GLOBAL = { limit: 60, windowSec: 60, identifier: "venue-tvl" };

const COIN_BY_MINT = new Map(QUOTE_COINS.map((c, rank) => [c.mint, { ...c, rank }]));
const [SOL, USDC, BAYLA] = QUOTE_COINS;

let cached = null; // { at, body }
let inflight = null;
const pairCache = new Map(); // chain -> [{ address, wethSide }], pairs never change once made
const priceCache = new Map(); // symbol -> { at, usd }

/** Tests only: forget every cached answer, pair and price. */
export function __resetVenueTvl() {
  cached = null;
  inflight = null;
  pairCache.clear();
  priceCache.clear();
}

function solanaUrl() {
  return process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
}

async function solanaRpc(method, params, fetchImpl, capBytes = 1024 * 1024) {
  const res = await fetchImpl(solanaUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`solana HTTP ${res.status}`);
  const { text, truncated } = await readBoundedText(res, capBytes);
  if (truncated) throw new Error("solana answer over cap");
  const parsed = JSON.parse(text);
  if (parsed?.error) throw new Error(`solana error ${String(parsed.error.code ?? "")}`);
  if (!parsed || !("result" in parsed)) throw new Error("solana answer carried no result");
  return parsed.result;
}

/** Every pool on one program: its two mints and two vaults. */
async function scanPrograms(layout, fetchImpl) {
  const start = Math.min(layout.mint0, layout.mint1, layout.vault0, layout.vault1);
  const length = Math.max(layout.mint0, layout.mint1, layout.vault0, layout.vault1) + 32 - start;
  const result = await solanaRpc(
    "getProgramAccounts",
    [
      layout.program,
      {
        encoding: "base64",
        commitment: "confirmed",
        dataSlice: { offset: start, length },
        filters: [{ dataSize: layout.size }, { memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR_B58 } }],
      },
    ],
    fetchImpl,
    SCAN_CAP_BYTES,
  );
  if (!Array.isArray(result)) throw new Error("solana scan carried no list");
  if (result.length > MAX_POOLS) throw new Error(`more than ${MAX_POOLS} pools on ${layout.program}`);
  const key = (d, at) => base58.encode(Uint8Array.from(d.subarray(at - start, at - start + 32)));
  return result.map((item) => {
    const b64 = item?.account?.data?.[0];
    const d = typeof b64 === "string" ? Buffer.from(b64, "base64") : null;
    if (!d || d.length !== length) throw new Error("solana scan carried a wrong-sized slice");
    return {
      sides: [
        { mint: key(d, layout.mint0), vault: key(d, layout.vault0) },
        { mint: key(d, layout.mint1), vault: key(d, layout.vault1) },
      ],
    };
  });
}

/** Each vault's balance in whole coins, checked to hold the coin under the coin's own token program. */
async function readVaults(wanted, fetchImpl) {
  const keys = [...wanted.keys()];
  const out = new Map();
  for (let i = 0; i < keys.length; i += VAULT_CHUNK) {
    const chunk = keys.slice(i, i + VAULT_CHUNK);
    const r = await solanaRpc("getMultipleAccounts", [chunk, { encoding: "jsonParsed", commitment: "confirmed" }], fetchImpl);
    if (!Array.isArray(r?.value) || r.value.length !== chunk.length) throw new Error("solana vault answer has the wrong shape");
    r.value.forEach((acc, j) => {
      const coin = wanted.get(chunk[j]);
      const info = acc?.data?.parsed?.info;
      const amount = info?.tokenAmount?.amount;
      const decimals = info?.tokenAmount?.decimals;
      if (!acc || acc.owner !== coin.program || info?.mint !== coin.mint || typeof amount !== "string" || !/^\d+$/.test(amount) || !Number.isInteger(decimals)) {
        throw new Error(`vault ${chunk[j]} does not read as a ${coin.symbol} account`);
      }
      out.set(chunk[j], Number(amount) / 10 ** decimals);
    });
  }
  return out;
}

/**
 * The Solana side: both programs, valued. `{ usd, pools, unvalued }`, where `unvalued`
 * counts pools left out because BAYLA had no price. Throws when any read failed.
 */
export async function readSolana({ fetchImpl, priceOf }) {
  const programs = await Promise.all(SOLANA_PROGRAMS.map((layout) => scanPrograms(layout, fetchImpl)));
  // What each pool counts: the cp-swap pool its top coin, doubled; a range pool every coin.
  const counted = [];
  const wanted = new Map();
  programs.forEach((pools, p) => {
    const { doubled } = SOLANA_PROGRAMS[p];
    for (const pool of pools) {
      const coinSides = pool.sides.filter((s) => COIN_BY_MINT.has(s.mint));
      if (!coinSides.length) continue;
      const sides = doubled ? [coinSides.reduce((a, b) => (COIN_BY_MINT.get(a.mint).rank <= COIN_BY_MINT.get(b.mint).rank ? a : b))] : coinSides;
      counted.push({ sides, factor: doubled ? 2 : 1, both: doubled && coinSides.length === 2 ? coinSides : null });
      // Both coin vaults of a coin/coin pool: BAYLA's price is read from them.
      for (const s of doubled ? coinSides : sides) wanted.set(s.vault, COIN_BY_MINT.get(s.mint));
    }
  });
  const held = wanted.size ? await readVaults(wanted, fetchImpl) : new Map();

  if (!counted.length) return { usd: 0, pools: 0, unvalued: 0 };
  const usd = { [SOL.mint]: await priceOf("SOL"), [USDC.mint]: 1, [BAYLA.mint]: null };
  usd[BAYLA.mint] = baylaUsd(counted, held, usd);

  let total = 0;
  let unvalued = 0;
  for (const c of counted) {
    const prices = c.sides.map((s) => usd[s.mint]);
    if (prices.some((v) => v === null)) {
      unvalued++;
      continue;
    }
    total += c.factor * c.sides.reduce((sum, s, i) => sum + held.get(s.vault) * prices[i], 0);
  }
  return { usd: total, pools: counted.length - unvalued, unvalued };
}

/** BAYLA in dollars from our deepest BAYLA/SOL pool, else BAYLA/USDC; null with neither. */
function baylaUsd(counted, held, usd) {
  for (const coin of [SOL, USDC]) {
    let best = null;
    for (const c of counted) {
      const other = c.both?.find((s) => s.mint === coin.mint);
      const bayla = c.both?.find((s) => s.mint === BAYLA.mint);
      if (!other || !bayla || !(held.get(bayla.vault) > 0)) continue;
      if (!best || held.get(other.vault) > held.get(best.other.vault)) best = { other, bayla };
    }
    if (best) return (held.get(best.other.vault) * usd[coin.mint]) / held.get(best.bayla.vault);
  }
  return null;
}

/** One eth_call over the chain's endpoints; the first that answers wins. */
function evmCall(rpcs, fetchImpl) {
  return async (to, data) => {
    let last = "";
    for (const url of rpcs) {
      try {
        const r = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
        const j = r.ok ? await r.json() : null;
        if (typeof j?.result === "string" && /^0x[0-9a-fA-F]*$/.test(j.result) && j.result.length > 2) return j.result;
        last = j?.error ? JSON.stringify(j.error).slice(0, 120) : `HTTP ${r.status}`;
      } catch (e) {
        last = e?.message ?? String(e);
      }
    }
    throw new Error(`eth_call ${data.slice(0, 10)}: ${last}`);
  };
}

const word = (hex, k) => BigInt("0x" + hex.slice(2 + 64 * k, 2 + 64 * (k + 1)));
const addressOf = (hex) => "0x" + hex.slice(-40).toLowerCase();

/** One EVM chain: every pair the factory made that holds WETH, at twice its WETH. Throws when any read failed. */
export async function readEvm(name, { fetchImpl, priceOf, chains = EVM_CHAINS }) {
  const chain = chains[name];
  const call = evmCall(chain.rpcs, fetchImpl);
  const total = Number(word(await call(chain.factory, "0x574f2ba3"), 0));
  if (total > MAX_PAIRS) throw new Error(`more than ${MAX_PAIRS} pairs on ${name}`);
  const weth = chain.weth?.toLowerCase() ?? null;
  const pairs = pairCache.get(name)?.slice(0, total) ?? [];
  for (let i = pairs.length; i < total; i++) {
    const address = addressOf(await call(chain.factory, "0x1e3dd18b" + i.toString(16).padStart(64, "0")));
    const [t0, t1] = await Promise.all([call(address, "0x0dfe1681"), call(address, "0xd21220a7")]);
    pairs.push({ address, wethSide: weth === addressOf(t0) ? 0 : weth === addressOf(t1) ? 1 : null });
  }
  pairCache.set(name, pairs);
  const priced = pairs.filter((p) => p.wethSide !== null);
  if (!priced.length) return { usd: 0, pools: 0, unvalued: 0 };
  const [ethUsd, reserves] = await Promise.all([priceOf("ETH"), Promise.all(priced.map((p) => call(p.address, "0x0902f1ac")))]);
  const wethHeld = reserves.reduce((sum, r, i) => sum + Number(word(r, priced[i].wethSide)) / 1e18, 0);
  return { usd: 2 * wethHeld * ethUsd, pools: priced.length, unvalued: 0 };
}

/** Every chain, read at once. Never throws: a chain that failed is `{ chain, read: false }`. */
export async function readVenueTvl({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const priceOf = async (symbol) => {
    const hit = priceCache.get(symbol);
    if (hit && now - hit.at < CACHE_MS) return hit.usd;
    const usd = await spotPrice(symbol, fetchImpl);
    priceCache.set(symbol, { at: now, usd });
    return usd;
  };
  const readers = [["solana", () => readSolana({ fetchImpl, priceOf })], ...EVM_TVL_CHAINS.map((name) => [name, () => readEvm(name, { fetchImpl, priceOf })])];
  const results = await Promise.all(
    readers.map(async ([chain, read]) => {
      try {
        const r = await read();
        return { chain, read: true, usd: Math.round(r.usd * 100) / 100, pools: r.pools, unvalued: r.unvalued };
      } catch (err) {
        console.error(`[venue-tvl] ${chain} not read:`, logSafe(err));
        return { chain, read: false };
      }
    }),
  );
  if (!results.some((r) => r.read)) return { state: "unread" };
  const whole = results.every((r) => r.read && r.unvalued === 0);
  const usd = results.reduce((sum, r) => sum + (r.read ? r.usd : 0), 0);
  return { state: whole ? "current" : "partial", usd: Math.round(usd * 100) / 100, chains: results, readAt: new Date(now).toISOString() };
}

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res, body) {
  if (body.state === "unread") {
    res.setHeader("Cache-Control", "s-maxage=15");
    return res.status(502).json(body);
  }
  res.setHeader("Cache-Control", body.state === "current" ? "public, max-age=0, s-maxage=60, stale-while-revalidate=60" : "public, max-age=0, s-maxage=15");
  return res.status(200).json(body);
}

export async function handleVenueTvl(req, res, { fetchImpl = globalThis.fetch, nowMs = Date.now() } = {}) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!isRequestOriginAllowed(req)) return res.status(403).json({ error: "Origin not allowed" });

  const ttl = cached?.body.state === "current" ? CACHE_MS : PARTIAL_CACHE_MS;
  if (cached && nowMs - cached.at < ttl) return send(res, cached.body);
  // Charged only when the chains are read; one read at a time per instance, shared by everyone waiting.
  if (!(await checkRateLimit(req, res, RATE))) return;
  if (!inflight && !(await checkGlobalLimit(res, GLOBAL))) return;
  inflight ??= readVenueTvl({ fetchImpl, now: nowMs })
    .then((body) => {
      if (body.state !== "unread") cached = { at: nowMs, body };
      return body;
    })
    .finally(() => {
      inflight = null;
    });
  return send(res, await inflight);
}
