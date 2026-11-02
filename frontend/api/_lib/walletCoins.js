// Which ERC-20 coins a wallet holds on Ethereum or Base, and each one's price, for the dashboard:
// `?resource=wallet-coins&chain=ethereum|base&address=0x…` on the catchall. The browser cannot
// reach Alchemy's key, Blockscout or DefiLlama (the site's CSP), so this finds the coins and prices
// them. The browser then reads each balance, decimals and symbol on chain itself and does the
// dollars, so this answer is trusted only for which coins and at what price, and says nothing else.
//
// WHICH COINS: Alchemy's list of the wallet's ERC-20 balances (our key, as api/alchemy.js sends
// it). Blockscout's keyless list only when no Alchemy key is set or Alchemy could not be read.
// At most 4 pages either way; a wallet with more is answered with `truncated: true`, never as if
// the list were whole.
// AT WHAT PRICE, AND HOW MANY DECIMALS: DefiLlama's. On the Blockscout path only, a coin DefiLlama
// does not cover may use Blockscout's own rate and decimals. A coin left with no price or no
// decimals is left out: nothing can show it as worth over a dollar.
// WHICH ARE KEPT: those worth at least $1 at that balance, decimals and price (the decimals are
// used for this cut only), the 60 largest, largest first.
//
// A read that fails is a 502, never an empty list: an empty list says the wallet holds nothing.
// That includes DefiLlama being down. Falling back to Blockscout's rates alone would quietly drop
// every coin only DefiLlama prices, and the list would still read as whole.
import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { alchemyKeyChain, fetchAlchemyWithFailover } from "./alchemy-failover.js";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

/** Each chain's Alchemy and Blockscout; the keys are also DefiLlama's chain names. */
export const WALLET_COIN_CHAINS = Object.freeze({
  ethereum: Object.freeze({ alchemy: "https://eth-mainnet.g.alchemy.com/v2", blockscout: "https://eth.blockscout.com" }),
  base: Object.freeze({ alchemy: "https://base-mainnet.g.alchemy.com/v2", blockscout: "https://base.blockscout.com" }),
});
export const MAX_PAGES = 4;
export const MAX_COINS = 60;
export const MIN_USD = 1;
export const MIN_CONFIDENCE = 0.9;
const PRICE_BATCH = 50;
const CAP_BYTES = 512 * 1024;
const TIMEOUT_MS = 8000;
const CACHE_MS = 60_000;
const CACHE_MAX = 500;
const RATE = { limit: 20, windowSec: 60, identifier: "wallet-coins" };
const GLOBAL = { limit: 120, windowSec: 60, identifier: "wallet-coins" };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const cache = new Map(); // chain:address -> { at, body }, oldest first
const inflight = new Map(); // chain:address -> the read everyone asking for it waits on

/** Tests only: forget every cached answer and read in flight. */
export function __resetWalletCoins() {
  cache.clear();
  inflight.clear();
}

async function readJson(res, host) {
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}`);
  const { text, truncated } = await readBoundedText(res, CAP_BYTES);
  if (truncated) throw new Error(`answer from ${host} over cap`);
  return JSON.parse(text);
}

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return readJson(res, new URL(url).host);
}

/** Decimals as a whole number from 0 to 255, given as a number or a string of digits; else null. */
function toDecimals(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

/** Every page of a list, at most MAX_PAGES: `{ held, truncated }`. `readPage(cursor)` answers `{ coins, next }`. */
async function readPages(readPage) {
  const held = new Map(); // a coin listed on two pages counts once
  let next = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await readPage(next);
    for (const coin of r.coins) held.set(coin.address, coin);
    next = r.next;
    if (next === null) return { held: [...held.values()], truncated: false };
  }
  return { held: [...held.values()], truncated: true };
}

/** Alchemy's ERC-20 balances above zero. Throws when any page cannot be read. */
function readHeldAlchemy(chain, address) {
  return readPages(async (pageKey) => {
    const params = pageKey === null ? [address, "erc20"] : [address, "erc20", { pageKey }];
    // The key goes in a Bearer header, never the URL, and a rejected key is retried once with the
    // fallback key: api/alchemy.js's pattern. alchemy-failover.js fetches with the global fetch.
    const res = await fetchAlchemyWithFailover((key) => ({
      url: WALLET_COIN_CHAINS[chain].alchemy,
      opts: {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getTokenBalances", params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    }));
    // A JSON-RPC error (a key without this chain enabled, say) comes as HTTP 200 with no result.
    const r = (await readJson(res, `alchemy ${chain}`))?.result;
    if (!Array.isArray(r?.tokenBalances)) throw new Error(`alchemy ${chain} answer carried no balances`);
    const coins = [];
    for (const b of r.tokenBalances) {
      // An entry Alchemy could not read carries `error` and no balance: skipped, as Alchemy says.
      if (b?.error || typeof b?.contractAddress !== "string" || !ADDRESS.test(b.contractAddress)) continue;
      if (typeof b.tokenBalance !== "string" || !/^0x[0-9a-fA-F]+$/.test(b.tokenBalance)) continue;
      const raw = BigInt(b.tokenBalance);
      if (raw > 0n) coins.push({ address: b.contractAddress.toLowerCase(), raw, decimals: null, rate: null });
    }
    const next = r.pageKey ?? null;
    if (next !== null && (typeof next !== "string" || next === "")) throw new Error(`alchemy ${chain} answer has a bad page key`);
    return { coins, next };
  });
}

/** One Blockscout item as `{ address, raw, decimals, rate }`, or null when it holds nothing we can use. */
function blockscoutCoin(item) {
  const t = item?.token;
  // Newer Blockscout builds name it `address_hash`, older ones `address`.
  const address = [t?.address_hash, t?.address].find((a) => typeof a === "string" && ADDRESS.test(a));
  if (!address || typeof item.value !== "string" || !/^\d+$/.test(item.value) || BigInt(item.value) === 0n) return null;
  // The exchange rate is a string of dollars ("11.42"), or null for a coin it does not price.
  const rate = typeof t.exchange_rate === "string" || typeof t.exchange_rate === "number" ? Number(t.exchange_rate) : NaN;
  return { address: address.toLowerCase(), raw: BigInt(item.value), decimals: toDecimals(t.decimals), rate: Number.isFinite(rate) && rate > 0 ? rate : null };
}

/** Blockscout's ERC-20 balances above zero, keyless. Throws when any page cannot be read. */
function readHeldBlockscout(chain, address, fetchImpl) {
  return readPages(async (cursor) => {
    const q = new URLSearchParams({ type: "ERC-20" });
    // Blockscout pages by handing back the next page's query; `fiat_value: null` is left off.
    for (const [k, v] of Object.entries(cursor ?? {})) {
      if (v === null || v === undefined) continue;
      if (typeof v === "object") throw new Error(`blockscout ${chain} gave a page key that is not a value`);
      q.set(k, String(v));
    }
    const j = await fetchJson(`${WALLET_COIN_CHAINS[chain].blockscout}/api/v2/addresses/${address}/tokens?${q}`, fetchImpl);
    if (!Array.isArray(j?.items)) throw new Error(`blockscout ${chain} answer carried no list`);
    const next = j.next_page_params ?? null;
    if (next !== null && (typeof next !== "object" || Array.isArray(next))) throw new Error(`blockscout ${chain} answer has a bad next page`);
    return { coins: j.items.map(blockscoutCoin).filter(Boolean), next };
  });
}

/** Alchemy when a key is set and it answers, else Blockscout. Throws when the one used last cannot be read. */
async function readHeld(chain, address, fetchImpl) {
  // "demo" is this codebase's word for "no Alchemy key" (api/alchemy.js refuses on it the same way).
  if (alchemyKeyChain().some((k) => k && k !== "demo")) {
    try {
      return await readHeldAlchemy(chain, address);
    } catch (err) {
      console.error(`[wallet-coins] alchemy ${chain} not read, trying Blockscout:`, logSafe(err));
    }
  }
  return readHeldBlockscout(chain, address, fetchImpl);
}

/** DefiLlama's `{ price, decimals, confidence }` for each coin it prices; a coin it does not is missing. Throws when it cannot be read. */
async function readPrices(chain, coins, fetchImpl) {
  const batches = [];
  for (let i = 0; i < coins.length; i += PRICE_BATCH) batches.push(coins.slice(i, i + PRICE_BATCH));
  const answers = await Promise.all(batches.map((b) => fetchJson(`https://coins.llama.fi/prices/current/${b.map((c) => `${chain}:${c}`).join(",")}`, fetchImpl)));
  const out = new Map();
  for (const j of answers) {
    if (!j?.coins || typeof j.coins !== "object") throw new Error("defillama answer carried no prices");
    // It echoes each key as it was asked; read them lowercased anyway.
    for (const [key, v] of Object.entries(j.coins)) {
      const [c, coin] = key.toLowerCase().split(":");
      if (c !== chain || !Number.isFinite(v?.price) || !(v.price > 0)) continue;
      out.set(coin, { price: v.price, decimals: toDecimals(v.decimals), confidence: typeof v.confidence === "number" ? v.confidence : null });
    }
  }
  return out;
}

/** A coin's worth in dollars and its price, or null when it is left out. */
function valued(c, llama) {
  // DefiLlama's confidence falls when its price comes from a thin pool. That is how a spam airdrop
  // reads as worth thousands: its maker seeds a tiny pool at a made-up price. Such a coin is left
  // out, and not priced some other way.
  if (llama && llama.confidence !== null && llama.confidence < MIN_CONFIDENCE) return null;
  const priceUsd = llama?.price ?? c.rate; // c.rate is Blockscout's, so null on the Alchemy path
  const decimals = llama?.decimals ?? c.decimals; // likewise
  if (priceUsd === null || decimals === null) return null;
  const usd = (Number(c.raw) / 10 ** decimals) * priceUsd;
  return Number.isFinite(usd) && usd >= MIN_USD ? { address: c.address, priceUsd, usd } : null;
}

/**
 * One wallet on one chain: `{ chain, address, coins: [{ address, priceUsd }], truncated, readAt }`,
 * the coins worth at least $1, largest first. Throws when no list or DefiLlama can be read.
 */
export async function readWalletCoins(chain, address, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!Object.hasOwn(WALLET_COIN_CHAINS, chain)) throw new Error(`no such chain ${chain}`);
  if (typeof address !== "string" || !ADDRESS.test(address)) throw new Error("not an address");
  const wallet = address.toLowerCase();
  const { held, truncated } = await readHeld(chain, wallet, fetchImpl);
  const prices = held.length ? await readPrices(chain, held.map((c) => c.address), fetchImpl) : new Map();
  const coins = held
    .map((c) => valued(c, prices.get(c.address)))
    .filter((c) => c !== null)
    .sort((a, b) => b.usd - a.usd || (a.address < b.address ? -1 : 1))
    .slice(0, MAX_COINS)
    .map(({ address: a, priceUsd }) => ({ address: a, priceUsd }));
  return { chain, address: wallet, coins, truncated, readAt: new Date(now).toISOString() };
}

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function remember(key, at, body) {
  cache.delete(key);
  cache.set(key, { at, body });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

export async function handleWalletCoins(req, res, { fetchImpl = globalThis.fetch, nowMs = Date.now() } = {}) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!isRequestOriginAllowed(req)) return res.status(403).json({ error: "Origin not allowed" });

  const { chain, address } = req.query ?? {};
  if (typeof chain !== "string" || !Object.hasOwn(WALLET_COIN_CHAINS, chain)) return res.status(400).json({ error: "chain must be ethereum or base" });
  if (typeof address !== "string" || !ADDRESS.test(address)) return res.status(400).json({ error: "address must be 0x and 40 hex characters" });

  const key = `${chain}:${address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < CACHE_MS) {
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=60");
    return res.status(200).json(hit.body);
  }
  if (hit) cache.delete(key);
  // Charged only when the upstreams are read; one read at a time per wallet, shared by everyone waiting.
  if (!(await checkRateLimit(req, res, RATE))) return;
  if (!inflight.has(key) && !(await checkGlobalLimit(res, GLOBAL))) return;
  if (!inflight.has(key)) {
    inflight.set(
      key,
      readWalletCoins(chain, address, { fetchImpl, now: nowMs })
        .then((body) => {
          remember(key, nowMs, body);
          return body;
        })
        .finally(() => inflight.delete(key)),
    );
  }
  try {
    const body = await inflight.get(key);
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=60");
    return res.status(200).json(body);
  } catch (err) {
    console.error(`[wallet-coins] ${chain} not read:`, logSafe(err));
    res.setHeader("Cache-Control", "s-maxage=10");
    return res.status(502).json({ error: "Could not read this wallet's coins" });
  }
}
