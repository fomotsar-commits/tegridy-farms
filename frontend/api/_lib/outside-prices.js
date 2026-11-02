// The outside price of every listed pool's token, read ONCE for everyone (island answer
// twenty-four, build 1b). `GET /api/outside-prices` answers one JSON for every token in a
// venue pool, with `read_at` per token. Vercel's edge keeps the answer (OUTSIDE_PRICES_MAX_AGE_SEC,
// then stale-while-revalidate for ten minutes), so the first visitor in each window pays one
// loop and everyone else is served; a loop that reads nothing answers 502 no-store, so a
// refusal from Jupiter never replaces the last good answer at the edge.
//
// Each token is priced as outsidePrice.ts prices it in the browser: 0.05 SOL into the token,
// then the sale back. The sale's amount is the buy's return rounded to two figures
// (`probeAmount`), so the sale's shape repeats from loop to loop and its edge keys share. The
// geometric mean of the two cancels the route's fees. Every pool the two quotes went through
// is read from the chain, and a price through one of our own programs is not an outside price.
//
// Jupiter's calls are PACED to the key's plan (JUPITER_RATE_PER_SEC: the free key is one a
// second, the Developer plan ten), one after another, never in a burst: the burst is what
// closed the Add door on every pool at once (the walk of 2026-11-01). A token the loop cannot
// price answers `unread` with this instance's last good read beside it, when it has one; the
// browser keeps its own last good read for the same ten minutes (outsidePrice.ts).

import { base58 } from "@scure/base";
import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";
import { CP_SWAP_PROGRAM, OFFSETS, POOL_DISCRIMINATOR_B58, POOL_STATE_LEN, WSOL_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./pool-index.js";
import { RANGE_PROGRAM } from "./venueTvl.js";

/** The buy's size, as outsidePrice.ts has it. */
export const PROBE_LAMPORTS = 50_000_000n;
/** A price older than this holds the Add form (the browser's rule too, FRESH_FOR_MS in outsidePrice.ts). */
export const FRESH_FOR_MS = 10 * 60_000;
export const SWR_SECS = 600;
export const DEFAULT_MAX_AGE_SEC = 60;
/** More tokens than this is a venue the loop cannot price in one function run. */
export const MAX_MINTS = 24;
export const MAX_POOLS = 200;
export const MAX_ROUTE_POOLS = 40;
/** The loop stops asking Jupiter after this long (vercel.json gives the function 60 s); what is left is said as unread. */
export const LOOP_BUDGET_MS = 50_000;
const RPC_TIMEOUT_MS = 8_000;
const JUPITER_TIMEOUT_MS = 8_000;
const SCAN_CAP_BYTES = 2 * 1024 * 1024;
/** Jupiter's own "no market" codes, as api/aggregator.js reads them. */
const NO_ROUTE_CODES = ["TOKEN_NOT_TRADABLE", "NO_ROUTES_FOUND", "COULD_NOT_FIND_ANY_ROUTE"];
const OUR_PROGRAMS = new Set([CP_SWAP_PROGRAM, RANGE_PROGRAM]);
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

/** This instance's last good read per token. Warm instances carry it between loops; a cold one starts empty. */
const lastGood = new Map();
/** The last dollar prices this instance read (price/v3, one call for every token and SOL), with when. */
let lastUsd = null;
/** Tests only. */
export function __resetOutsidePrices() {
  lastGood.clear();
  lastUsd = null;
}

/** The sale's amount: the buy's return rounded to two significant figures, so the sale's quote repeats. */
export function probeAmount(out) {
  if (typeof out !== "bigint" || out <= 0n) return 0n;
  const s = out.toString();
  if (s.length <= 2) return out;
  const head = BigInt(s.slice(0, 2));
  const rest = s.slice(2);
  const rounded = rest.charCodeAt(0) >= 53 /* '5' */ ? head + 1n : head;
  return rounded * 10n ** BigInt(rest.length);
}

/** SOL a whole token: the geometric mean of the buy's price and the sale's, each at its own amount. */
export function midPrice({ tokensOut, probe, lamportsBack, decimals }) {
  const bought = Number(tokensOut) / 10 ** decimals;
  const sold = Number(probe) / 10 ** decimals;
  if (!(bought > 0) || !(sold > 0)) return null;
  const buyPrice = Number(PROBE_LAMPORTS) / 1e9 / bought;
  const sellPrice = Number(lamportsBack) / 1e9 / sold;
  const mid = Math.sqrt(buyPrice * sellPrice);
  return Number.isFinite(mid) && mid > 0 ? mid : null;
}

/** Milliseconds between two Jupiter calls on this key's plan, with a tenth of a second to spare. */
export function spacingMs(env = process.env) {
  const rate = Number(env.JUPITER_RATE_PER_SEC);
  const perSec = Number.isFinite(rate) && rate > 0 ? Math.min(rate, 50) : 1;
  return Math.ceil(1000 / perSec) + 100;
}

export function maxAgeSec(env = process.env) {
  const n = Number(env.OUTSIDE_PRICES_MAX_AGE_SEC);
  return Number.isInteger(n) && n >= 10 && n <= SWR_SECS ? n : DEFAULT_MAX_AGE_SEC;
}

function jupiterUpstream(env) {
  const key = (env.JUPITER_API_KEY || "").trim();
  if (!key) return { base: "https://lite-api.jup.ag", headers: {}, fallback: null };
  return { base: "https://api.jup.ag", headers: { "x-api-key": key }, fallback: { base: "https://lite-api.jup.ag", headers: {} } };
}

function isAddress(s) {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
}

function solanaUrl(env) {
  return env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
}

async function solanaRpc(method, params, fetchImpl, env, capBytes = SCAN_CAP_BYTES) {
  const res = await fetchImpl(solanaUrl(env), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`the chain answered HTTP ${res.status}`);
  const { text, truncated } = await readBoundedText(res, capBytes);
  if (truncated) throw new Error("the chain's answer was over the cap");
  const parsed = JSON.parse(text);
  if (parsed?.error) throw new Error(`the chain answered an error (${String(parsed.error.code ?? "")})`);
  if (!parsed || !("result" in parsed)) throw new Error("the chain's answer carried no result");
  return parsed.result;
}

/** Every venue pool's two mints (the cp-swap program; range pools read their own coins' prices from this list too). */
export async function listPoolMints(fetchImpl, env) {
  const start = Math.min(OFFSETS.token0Mint, OFFSETS.token1Mint);
  const length = 64;
  const result = await solanaRpc(
    "getProgramAccounts",
    [
      CP_SWAP_PROGRAM,
      {
        encoding: "base64",
        commitment: "confirmed",
        dataSlice: { offset: start, length },
        filters: [{ dataSize: POOL_STATE_LEN }, { memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR_B58 } }],
      },
    ],
    fetchImpl,
    env,
  );
  if (!Array.isArray(result)) throw new Error("the pool list carried no list");
  if (result.length > MAX_POOLS) throw new Error(`more than ${MAX_POOLS} pools`);
  const key = (d, at) => base58.encode(Uint8Array.from(d.subarray(at - start, at - start + 32)));
  return result.map((item) => {
    const b64 = item?.account?.data?.[0];
    const d = typeof b64 === "string" ? Buffer.from(b64, "base64") : null;
    if (!d || d.length !== length) throw new Error("the pool list carried a wrong-sized slice");
    return { pool: String(item?.pubkey ?? ""), mints: [key(d, OFFSETS.token0Mint), key(d, OFFSETS.token1Mint)] };
  });
}

/** The tokens to price: every mint in a pool that is not SOL, each once, in the order first seen. */
export function tokensOf(pools) {
  const seen = new Set();
  const out = [];
  for (const p of pools) {
    for (const m of p.mints) {
      if (m === WSOL_MINT || seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/** Each mint's decimals, read from its account; a mint not under a token program is left out. */
async function readDecimals(mints, fetchImpl, env) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const result = await solanaRpc("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 44, length: 1 } }], fetchImpl, env);
    const value = result?.value;
    if (!Array.isArray(value) || value.length !== chunk.length) throw new Error("the mints' accounts were not all read");
    chunk.forEach((mint, j) => {
      const acc = value[j];
      const b64 = acc?.data?.[0];
      if (!acc || !TOKEN_PROGRAMS.has(acc.owner) || typeof b64 !== "string") return;
      const d = Buffer.from(b64, "base64");
      if (d.length === 1) out.set(mint, d[0]);
    });
  }
  return out;
}

/** The owner program of each route pool, or null for one the chain does not hold. */
async function readOwners(pools, fetchImpl, env) {
  const out = new Map();
  for (let i = 0; i < pools.length; i += 100) {
    const chunk = pools.slice(i, i + 100);
    const result = await solanaRpc("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }], fetchImpl, env);
    const value = result?.value;
    if (!Array.isArray(value) || value.length !== chunk.length) throw new Error("the route's pools were not all read");
    chunk.forEach((p, j) => out.set(p, value[j]?.owner ?? null));
  }
  return out;
}

/** One ExactIn quote. `ok` with the amount out and the pools it came through; `no-route` is Jupiter's own answer; `refused` is anything else. */
async function quote(up, inputMint, outputMint, amount, fetchImpl) {
  const qs = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: "50",
    swapMode: "ExactIn",
    restrictIntermediateTokens: "true",
    instructionVersion: "V2",
  });
  let res;
  try {
    res = await fetchImpl(`${up.base}/swap/v1/quote?${qs.toString()}`, { headers: { Accept: "application/json", ...up.headers }, signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS) });
  } catch (e) {
    return { kind: "refused", status: 0, detail: `Jupiter did not answer (${logSafe(e?.message ?? String(e))})` };
  }
  const { text } = await readBoundedText(res, 256 * 1024);
  if (res.status === 400) {
    try {
      const b = JSON.parse(text);
      if (typeof b?.errorCode === "string" && NO_ROUTE_CODES.includes(b.errorCode)) return { kind: "no-route" };
    } catch {
      /* not JSON: refused below */
    }
  }
  if (!res.ok) return { kind: "refused", status: res.status, detail: `Jupiter did not give a price (HTTP ${res.status})` };
  let q;
  try {
    q = JSON.parse(text);
  } catch {
    return { kind: "refused", status: res.status, detail: "Jupiter's answer was not JSON" };
  }
  if (q?.inputMint !== inputMint || q?.outputMint !== outputMint || q?.inAmount !== amount.toString()) return { kind: "refused", status: res.status, detail: "Jupiter answered for a different trade" };
  if (typeof q.outAmount !== "string" || !/^\d{1,30}$/.test(q.outAmount)) return { kind: "refused", status: res.status, detail: "Jupiter answered without an amount" };
  const out = BigInt(q.outAmount);
  if (out <= 0n) return { kind: "refused", status: res.status, detail: "Jupiter quoted nothing back" };
  if (!Array.isArray(q.routePlan) || q.routePlan.length === 0) return { kind: "refused", status: res.status, detail: "Jupiter answered without the pools its price came from" };
  const pools = [];
  for (const step of q.routePlan) {
    const key = step?.swapInfo?.ammKey;
    if (!isAddress(key)) return { kind: "refused", status: res.status, detail: "Jupiter named a pool its price came from that is not an address" };
    pools.push(key);
  }
  return { kind: "ok", out, pools };
}

/** After a 429 the key is shared with the site's other calls: one more try, after at least this long. */
export const RETRY_AFTER_429_MS = 2000;

/**
 * A quote on the keyed host, then once on the keyless one when the keyed gateway refuses it
 * (as api/aggregator.js falls back); a 429 from either host is tried once more after a pause.
 */
async function quoteWithFallback(up, inputMint, outputMint, amount, fetchImpl, pace) {
  await pace();
  let answer = await quote(up, inputMint, outputMint, amount, fetchImpl);
  if (answer.kind === "refused" && up.fallback && [401, 403, 404, 429].includes(answer.status)) {
    await pace();
    answer = await quote(up.fallback, inputMint, outputMint, amount, fetchImpl);
    if (answer.kind !== "refused" || answer.status !== 429) return answer;
    await pace(RETRY_AFTER_429_MS);
    return quote(up.fallback, inputMint, outputMint, amount, fetchImpl);
  }
  if (answer.kind === "refused" && answer.status === 429) {
    await pace(RETRY_AFTER_429_MS);
    return quote(up, inputMint, outputMint, amount, fetchImpl);
  }
  return answer;
}

/** Waits so that calls are at least `spacing` apart; `atLeast` asks for that long a pause before this one, from now. */
/** Every token's dollar price and SOL's in ONE price/v3 call, for the list's $ figures (poolList.ts readMarketPrices). Null when it could not be read; a 429 is tried once more after a pause. */
export async function readUsd(up, ids, fetchImpl, pace) {
  const ask = async (host, atLeast = 0) => {
    await pace(atLeast);
    let res;
    try {
      res = await fetchImpl(`${host.base}/price/v3?ids=${ids.join(",")}`, { headers: { Accept: "application/json", ...host.headers }, signal: AbortSignal.timeout(JUPITER_TIMEOUT_MS) });
    } catch {
      return { kind: "refused", status: 0 };
    }
    if (!res.ok) return { kind: "refused", status: res.status };
    const { text } = await readBoundedText(res, 256 * 1024);
    try {
      const body = JSON.parse(text);
      const out = {};
      for (const [mint, v] of Object.entries(body ?? {})) {
        if (v && typeof v.usdPrice === "number" && Number.isFinite(v.usdPrice) && v.usdPrice > 0) out[mint] = v.usdPrice;
      }
      return { kind: "ok", usd: out };
    } catch {
      return { kind: "refused", status: res.status };
    }
  };
  let a = await ask(up);
  if (a.kind === "refused" && up.fallback && [401, 403, 404, 429].includes(a.status)) a = await ask(up.fallback);
  if (a.kind === "refused" && a.status === 429) a = await ask(up.fallback ?? up, RETRY_AFTER_429_MS);
  return a.kind === "ok" ? a.usd : null;
}

function pacer(spacing, sleep) {
  let last = 0;
  return async (atLeast = 0) => {
    const wait = Math.max(last + spacing - Date.now(), atLeast);
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}

/**
 * The loop: every listed token's price. Never throws for one token; throws when the pool
 * list or the chain cannot be read at all.
 */
export async function readOutsidePrices({ fetchImpl, env = process.env, nowMs = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const t0 = nowMs();
  const pools = await listPoolMints(fetchImpl, env);
  const all = tokensOf(pools);
  // The first MAX_MINTS in the list's order are priced; the rest are said as unread, never dropped in silence.
  const mints = all.slice(0, MAX_MINTS);
  const decimals = await readDecimals(mints, fetchImpl, env);
  const up = jupiterUpstream(env);
  const pace = pacer(spacingMs(env), sleep);
  const prices = {};
  const unread = (mint, detail) => {
    const last = lastGood.get(mint) ?? null;
    prices[mint] = { state: "unread", detail, last };
  };
  // The dollar prices first: one call for every token and SOL, the cheapest read and the list's $ figures; the last good read stands when it fails.
  if (mints.length > 0) {
    const usd = await readUsd(up, [...mints, WSOL_MINT], fetchImpl, pace);
    if (usd && Object.keys(usd).length > 0) lastUsd = { usd, read_at: nowMs() };
  }
  const fresh = [];
  for (const mint of all.slice(MAX_MINTS)) unread(mint, `beyond the ${MAX_MINTS} tokens one loop prices`);
  for (const mint of mints) {
    const d = decimals.get(mint);
    if (d === undefined) {
      unread(mint, "the token's decimals were not read");
      continue;
    }
    if (nowMs() - t0 > LOOP_BUDGET_MS) {
      unread(mint, "the loop ran out of time before this token");
      continue;
    }
    const buy = await quoteWithFallback(up, WSOL_MINT, mint, PROBE_LAMPORTS, fetchImpl, pace);
    if (buy.kind === "no-route") {
      prices[mint] = { state: "no-route", read_at: nowMs() };
      continue;
    }
    if (buy.kind !== "ok") {
      unread(mint, buy.detail);
      continue;
    }
    const probe = probeAmount(buy.out);
    const sell = await quoteWithFallback(up, mint, WSOL_MINT, probe, fetchImpl, pace);
    if (sell.kind === "no-route") {
      unread(mint, "Jupiter priced a buy but not the sale back");
      continue;
    }
    if (sell.kind !== "ok") {
      unread(mint, sell.detail);
      continue;
    }
    const routePools = [...new Set([...buy.pools, ...sell.pools])];
    if (routePools.length > MAX_ROUTE_POOLS) {
      unread(mint, "Jupiter's price came through more pools than we can check");
      continue;
    }
    const mid = midPrice({ tokensOut: buy.out, probe, lamportsBack: sell.out, decimals: d });
    if (mid === null) {
      unread(mint, "Jupiter's quotes did not give a usable price");
      continue;
    }
    fresh.push({ mint, mid, probe, routePools, read_at: nowMs() });
  }
  // The pools behind every fresh price, read from the chain in one go: ours is not an outside price.
  if (fresh.length > 0) {
    const all = [...new Set(fresh.flatMap((f) => f.routePools))];
    let owners;
    try {
      owners = await readOwners(all, fetchImpl, env);
    } catch (e) {
      for (const f of fresh) unread(f.mint, `the pools behind Jupiter's price could not be checked (${logSafe(e?.message ?? String(e))})`);
      owners = null;
    }
    if (owners) {
      for (const f of fresh) {
        if (f.routePools.some((p) => OUR_PROGRAMS.has(owners.get(p)))) {
          unread(f.mint, "Jupiter's price came through our own pools, so it is not an outside price");
          continue;
        }
        const entry = { sol_per_token: f.mid, read_at: f.read_at, probe: f.probe.toString(), pools: f.routePools };
        lastGood.set(f.mint, entry);
        prices[f.mint] = { state: "ok", ...entry };
      }
    }
  }
  const okCount = Object.values(prices).filter((p) => p.state === "ok" || p.state === "no-route").length;
  return { read_at: nowMs(), mints: all.length, okCount, prices, usd: lastUsd?.usd ?? null, usd_read_at: lastUsd?.read_at ?? null };
}

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export async function handleOutsidePrices(req, res, { fetchImpl = globalThis.fetch, env = process.env, nowMs = () => Date.now(), sleep } = {}) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!isRequestOriginAllowed(req)) return res.status(403).json({ error: "Origin not allowed" });
  if (!(await checkRateLimit(req, res, { limit: 60, windowSec: 60, identifier: "outside-prices" }))) return;
  if (!(await checkGlobalLimit(res, { limit: 600, windowSec: 60, identifier: "outside-prices" }))) return;
  try {
    const read = await readOutsidePrices({ fetchImpl, env, nowMs, ...(sleep ? { sleep } : {}) });
    // A loop that priced nothing is a refusal: no-store, so the edge keeps the last good answer for its ten minutes.
    if (read.mints > 0 && read.okCount === 0) {
      res.setHeader("Cache-Control", "private, no-store");
      return res.status(502).json({ state: "unread", detail: "Jupiter priced none of the venue's tokens this time", read_at: read.read_at, prices: read.prices });
    }
    res.setHeader("Cache-Control", `s-maxage=${maxAgeSec(env)}, stale-while-revalidate=${SWR_SECS}`);
    return res.status(200).json({ state: "ok", read_at: read.read_at, fresh_for_ms: FRESH_FOR_MS, probe_lamports: PROBE_LAMPORTS.toString(), prices: read.prices, usd: read.usd, usd_read_at: read.usd_read_at });
  } catch (e) {
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(502).json({ state: "unread", detail: logSafe(e?.message ?? String(e)) });
  }
}
