// Launcher-outcomes resource adapter — the ONLY network boundary behind the
// pure outcomesReader core (frontend/src/lib/launcher/outcomesReader.ts).
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   Vercel Hobby caps a deployment at 12 serverless functions (main=9). Adding
//   a standalone /api/launcher-outcomes.js would spend one of the 3 remaining
//   slots for a low-traffic disclosure surface. Instead the aggregator catchall
//   (already load-bearing, already deployed) dispatches ?resource=launcher-outcomes
//   here via a LAZY dynamic import, so the swap hot-path never pays for this
//   module and the function count stays at 9. See api/SERVERLESS_BUDGET.md.
//
// WHAT IT DOES:
//   - Builds a concrete LauncherDataFetcher (the interface in outcomesReader.ts)
//       fetchMarket    -> GeckoTerminal (keyless, ETH-denominated, null on 429/fail)
//       fetchChainStats-> Etherscan (server-side key ONLY, null on miss)
//   - Consumes a launch list (LaunchBaseline[]) supplied by the CALLER. Launch
//     DISCOVERY is out of scope here — GeckoTerminal `new_pools` or an indexer
//     supplies the baseline list; this adapter only ENRICHES a provided list.
//   - Calls buildOutcomeRecords / buildLaunchSummaries and returns
//       { launches: LaunchSummary[], outcomes: Record<address, OutcomeRecord> }
//
// DISCLOSURE-ONLY: every field is factual market/chain data. A null upstream
// degrades safely inside the reader (marketObserved:false, no fabricated crash),
// never throws, never invents a rosy or a damning signal.

import { checkRateLimit } from "./ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// ── Pure reader core — JS PORT of src/lib/launcher/outcomesReader.ts ──────────
// Ported to plain JS (NOT imported from src/) DELIBERATELY: a Vercel serverless
// function compiles under node16 moduleResolution, but the frontend TS uses
// extensionless bundler-style relative imports (e.g. `./factSheet`), which node16
// rejects (TS2835) — shipping the function broken (FUNCTION_INVOCATION_FAILED at
// invoke). Keeping this function self-contained removes that api→src boundary hazard.
// KEEP IN SYNC with outcomesReader.ts — the frontend source of truth (unit-tested there);
// this is a faithful 1:1 port of its pure logic (no types, same behavior).
function finiteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function nonNegOr(value, fallback) {
  const n = finiteOr(value, fallback);
  return n < 0 ? fallback : n;
}
function marketIsObserved(m) {
  return m != null && Number.isFinite(m.priceEth) && Number.isFinite(m.liquidityEth);
}
function normalizeMarket(m) {
  if (!m) return { priceEth: 0, liquidityEth: 0, uniqueBuyers24h: 0, feeRevenueEth24h: 0 };
  return {
    priceEth: nonNegOr(m.priceEth, 0),
    liquidityEth: nonNegOr(m.liquidityEth, 0),
    uniqueBuyers24h: Math.floor(nonNegOr(m.uniqueBuyers24h, 0)),
    feeRevenueEth24h: nonNegOr(m.feeRevenueEth24h, 0),
  };
}
function normalizeChain(c) {
  if (!c) return { holderCount: null, lastTeamActivityAt: null };
  return {
    holderCount: c.holderCount == null ? null : Math.max(0, Math.floor(finiteOr(c.holderCount, 0))),
    lastTeamActivityAt:
      c.lastTeamActivityAt == null ? null : Math.max(0, Math.floor(finiteOr(c.lastTeamActivityAt, 0))),
  };
}
async function safeCall(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}
async function buildOutcomeRecord(baseline, fetcher, observedAt) {
  const rawMarket = await safeCall(() => fetcher.fetchMarket(baseline.token));
  const marketObserved = marketIsObserved(rawMarket);
  const market = normalizeMarket(rawMarket);
  const chain = normalizeChain(await safeCall(() => fetcher.fetchChainStats(baseline.token, baseline.creator)));
  const launchPriceEth = nonNegOr(baseline.launchPriceEth, 0);
  const launchLiquidityEth = nonNegOr(baseline.launchLiquidityEth, 0);
  return {
    token: baseline.token,
    tier: baseline.tier,
    launchedAt: baseline.launchedAt,
    observedAt,
    priceEth: marketObserved ? market.priceEth : launchPriceEth,
    launchPriceEth,
    liquidityEth: marketObserved ? market.liquidityEth : launchLiquidityEth,
    launchLiquidityEth,
    holderCount: chain.holderCount ?? 0,
    unlocks: baseline.unlocks ?? [],
    lastTeamActivityAt: chain.lastTeamActivityAt,
    marketObserved,
  };
}
async function buildLaunchSummary(baseline, fetcher) {
  const rawMarket = await safeCall(() => fetcher.fetchMarket(baseline.token));
  if (!marketIsObserved(rawMarket)) return null;
  const market = normalizeMarket(rawMarket);
  const chain = normalizeChain(await safeCall(() => fetcher.fetchChainStats(baseline.token, baseline.creator)));
  return {
    token: baseline.token,
    tier: baseline.tier,
    launchedAt: baseline.launchedAt,
    uniqueBuyers24h: market.uniqueBuyers24h,
    liquidityEth: market.liquidityEth,
    feeRevenueEth24h: market.feeRevenueEth24h,
    holderCount: chain.holderCount ?? 0,
  };
}
async function buildOutcomeRecords(baselines, fetcher, observedAt) {
  return Promise.all(baselines.map((b) => buildOutcomeRecord(b, fetcher, observedAt)));
}
async function buildLaunchSummaries(baselines, fetcher) {
  const rows = await Promise.all(baselines.map((b) => buildLaunchSummary(b, fetcher)));
  return rows.filter((r) => r !== null);
}

// ── Config ───────────────────────────────────────────────────────────────
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const GECKO_NETWORK = "eth";

// Etherscan: mirror api/etherscan.js — v2 multichain when a key is set, else the
// (now-deprecated) v1 base. Auth ALWAYS travels in the querystring: v2 rejects
// `Authorization: Bearer` outright. The key is SERVER-SIDE ONLY.
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || "";
const ETHERSCAN_USE_V2 = !!ETHERSCAN_KEY;
const ETHERSCAN_BASE = ETHERSCAN_USE_V2
  ? "https://api.etherscan.io/v2/api"
  : "https://api.etherscan.io/api";

// Bound the upstream fan-out. buildOutcomeRecords and buildLaunchSummaries each
// enrich the SAME baselines, so unshared they'd DOUBLE every read (2 GeckoTerminal
// + 4 Etherscan per token). The per-request memoized fetchers below collapse that
// duplication back to at most 1 GeckoTerminal read + 2 Etherscan reads (holderCount
// + creator txlist) per unique token. 50 therefore caps a request at ~50 GT + ~100
// Etherscan reads, and the ~5-in-flight limiter around fetchMarket keeps GeckoTerminal
// under its ~30/min keyless ceiling regardless of how the reader fans out.
const MAX_BASELINES = 50;
// Max concurrent GeckoTerminal reads in flight for one request. Keyless GT tolerates
// ~30/min from an IP; ~5 in flight leaves ample headroom under bursty fan-out.
const MAX_MARKET_CONCURRENCY = 5;

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TIERS = new Set(["flagship", "listable", "none"]);

// Same credentialed-CORS origin set the rest of the api/ surface uses
// (api/etherscan.js). Same-origin (the app calling its own /api) is the norm;
// the allowlist just keeps parity with the other proxies.
const ALLOWED_ORIGINS = [
  "https://tegridyfarms.vercel.app",
  "https://nakamigos.gallery",
  "https://www.nakamigos.gallery",
];
if (process.env.NODE_ENV === "development") {
  ALLOWED_ORIGINS.push("http://localhost:5173", "http://localhost:3000");
}

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── Safe numeric parsing (upstream strings are hostile) ────────────────────
function num(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── GeckoTerminal market fetch (keyless) ───────────────────────────────────
//
// The reader's fetchMarket signature is (token) → so we resolve token→pool
// here. Preferred path: the caller passes the pool address it already learned
// during discovery (GeckoTerminal `new_pools` returns POOLS) via poolByToken.
// Fallback: GET /tokens/{token}/pools and take the deepest (index 0, GT sorts
// by liquidity). Either way we read the pool object's attributes:
//   base_token_price_native_currency -> priceEth (token price in ETH)
//   reserve_in_usd + base_token_price_usd + base_token_price_native_currency
//     -> liquidityEth, deriving ETH/USD from the base token itself
//        (usdPerEth = base_token_price_usd / base_token_price_native_currency)
//        so we never need a side-channel ETH price and it works regardless of
//        which side of the pair is WETH.
//   transactions.h24.buyers -> uniqueBuyers24h
// feeRevenueEth24h is NOT exposed by GeckoTerminal, so it stays 0 (unknown ≠
// fabricated) — it only feeds the log-scaled activity term in ordering.ts.
//
// Returns null on ANY failure or 429 (never throws) so the reader degrades.
async function geckoFetchJson(url) {
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (resp.status === 429 || !resp.ok) return null;
  const { text, truncated } = await readBoundedText(resp, MAX_RESPONSE_BYTES);
  if (truncated) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function poolAttrsToMarket(attrs) {
  if (!attrs) return null;
  const priceEth = num(attrs.base_token_price_native_currency);
  if (priceEth == null) return null;

  // Derive liquidity in ETH from the USD reserve + implied ETH/USD.
  let liquidityEth = 0;
  const reserveUsd = num(attrs.reserve_in_usd);
  const baseUsd = num(attrs.base_token_price_usd);
  if (reserveUsd != null && baseUsd != null && priceEth > 0) {
    const usdPerEth = baseUsd / priceEth; // (USD/token) / (ETH/token) = USD/ETH
    if (usdPerEth > 0) liquidityEth = reserveUsd / usdPerEth;
  }

  const buyers = num(attrs.transactions?.h24?.buyers);
  return {
    priceEth,
    liquidityEth,
    uniqueBuyers24h: buyers != null && buyers >= 0 ? Math.floor(buyers) : 0,
    feeRevenueEth24h: 0, // not exposed by GeckoTerminal — conservative unknown
  };
}

// Extract the pool's BASE token address (lowercased) from a GeckoTerminal pool
// object. GT returns it as relationships.base_token.data.id in "{network}_{addr}"
// form (e.g. "eth_0xabc…"); we pull the 0x…40hex out tolerantly. Returns null if
// the shape is missing so callers treat an unverifiable pool as a mismatch.
function poolBaseTokenAddress(json) {
  const id = json?.data?.relationships?.base_token?.data?.id;
  if (typeof id !== "string") return null;
  const m = id.match(/0x[a-fA-F0-9]{40}/);
  return m ? m[0].toLowerCase() : null;
}

function makeFetchMarket(poolByToken) {
  return async function fetchMarket(token) {
    try {
      const key = String(token).toLowerCase();
      const pool = poolByToken[key];
      if (pool && ETH_ADDRESS_RE.test(pool)) {
        const json = await geckoFetchJson(
          `${GECKO_BASE}/networks/${GECKO_NETWORK}/pools/${pool}`,
        );
        if (json) {
          // L11: the caller-supplied pool is UNTRUSTED. poolAttrsToMarket reads
          // base_token_price_native_currency as THIS token's price — so a stale or
          // hostile mapping pointing at an unrelated (possibly healthy) pool would
          // attribute that pool's price/liquidity to `token`. Only trust the mapping
          // when the pool's base token actually IS the requested token; otherwise
          // fall through to the token→pool discovery path below rather than lie.
          if (poolBaseTokenAddress(json) === key) {
            return poolAttrsToMarket(json?.data?.attributes);
          }
        } else {
          // Upstream miss/429 for a mapped pool — degrade to null (don't spend a
          // second GT read chasing discovery; the reader mirrors the baseline).
          return null;
        }
      }
      // Fallback: resolve the token's deepest pool. GT scopes /tokens/{token}/pools
      // to the token itself, so pools it returns already belong to the token.
      const json = await geckoFetchJson(
        `${GECKO_BASE}/networks/${GECKO_NETWORK}/tokens/${key}/pools?page=1`,
      );
      const first = Array.isArray(json?.data) ? json.data[0] : null;
      return poolAttrsToMarket(first?.attributes);
    } catch {
      return null;
    }
  };
}

// ── Etherscan chain-stats fetch (server-side key ONLY) ─────────────────────
async function etherscanCall(params) {
  const qs = new URLSearchParams(params);
  // FIX 2026-07-19: mirrors api/etherscan.js — v2 REJECTS `Authorization: Bearer`
  // ("Missing/Invalid API Key", verified live). The key belongs in the
  // querystring for both versions; v2 additionally needs chainid.
  if (ETHERSCAN_USE_V2) qs.set("chainid", "1");
  if (ETHERSCAN_KEY) qs.set("apikey", ETHERSCAN_KEY);
  const headers = { Accept: "application/json" };
  const resp = await fetch(`${ETHERSCAN_BASE}?${qs}`, { headers });
  if (resp.status === 429 || !resp.ok) return null;
  const { text, truncated } = await readBoundedText(resp, MAX_RESPONSE_BYTES);
  if (truncated) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchChainStats(token, creator) {
  let holderCount = null;
  let lastTeamActivityAt = null;

  // Holder count — Pro-gated stat; free tier returns status "0" → stays null.
  try {
    const j = await etherscanCall({
      module: "token",
      action: "tokenholdercount",
      contractaddress: String(token),
    });
    if (j && j.status === "1") {
      const n = num(j.result);
      if (n != null && n >= 0) holderCount = Math.floor(n);
    }
  } catch {
    /* null */
  }

  // Creator's most recent tx (newest-first, 1 row).
  if (creator && ETH_ADDRESS_RE.test(String(creator))) {
    try {
      const j = await etherscanCall({
        module: "account",
        action: "txlist",
        address: String(creator),
        startblock: "0",
        endblock: "99999999",
        page: "1",
        offset: "1",
        sort: "desc",
      });
      const row = j && j.status === "1" && Array.isArray(j.result) ? j.result[0] : null;
      const ts = row ? num(row.timeStamp) : null;
      if (ts != null && ts >= 0) lastTeamActivityAt = Math.floor(ts);
    } catch {
      /* null */
    }
  }

  return { holderCount, lastTeamActivityAt };
}

// ── Per-request memoization + bounded concurrency ──────────────────────────
//
// The reader enriches the SAME baseline list twice (buildOutcomeRecords AND
// buildLaunchSummaries), and both run their own unbounded Promise.all. Left raw,
// that fires 2 GeckoTerminal reads per token with no ceiling — one 50-baseline
// POST would burst ~100 GT fetches from one IP and trip the ~30/min keyless
// limit, 429-ing the whole disclosure feed to "unavailable".
//
// makeMemoizedFetcher fixes both, per request (never module-global — stale market
// data must not leak across POSTs):
//   • MEMOIZE: repeated fetchMarket/fetchChainStats for the same lowercased token
//     return the SAME in-flight Promise, collapsing the record/summary duplication.
//   • BOUND: a tiny hand-rolled semaphore caps GeckoTerminal reads at ~5 in flight.
//     Memoization means each unique token enters the limiter once.

// Dependency-light concurrency limiter (no p-limit). run(task) queues `task`
// (a () => Promise) and resolves with its result once a slot is free; at most
// `maxInFlight` tasks execute at once. Rejections propagate but never wedge the
// queue (the slot is always released).
function createConcurrencyLimiter(maxInFlight) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= maxInFlight || queue.length === 0) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  };
  return function run(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  };
}

// Build the { fetchMarket, fetchChainStats } the reader consumes, scoped to ONE
// request: memoized by lowercased token and (for market reads) concurrency-bounded.
function makeMemoizedFetcher(poolByToken) {
  const rawFetchMarket = makeFetchMarket(poolByToken);
  const limit = createConcurrencyLimiter(MAX_MARKET_CONCURRENCY);
  const marketCache = new Map();
  const chainCache = new Map();

  function fetchMarket(token) {
    const key = String(token).toLowerCase();
    let p = marketCache.get(key);
    if (!p) {
      // Memoize the LIMITER-wrapped promise so the two readers share one queued
      // read and each unique token consumes exactly one concurrency slot.
      p = limit(() => rawFetchMarket(token));
      marketCache.set(key, p);
    }
    return p;
  }

  function fetchChainStatsMemo(token, creator) {
    const key = String(token).toLowerCase();
    let p = chainCache.get(key);
    if (!p) {
      p = fetchChainStats(token, creator);
      chainCache.set(key, p);
    }
    return p;
  }

  return { fetchMarket, fetchChainStats: fetchChainStatsMemo };
}

// ── Input sanitation ───────────────────────────────────────────────────────
// The reader normalizes hostile NUMBERS, but we still validate addresses/tier
// here so we never issue upstream calls for garbage tokens (quota protection).
function sanitizeBaseline(raw) {
  if (!raw || typeof raw !== "object") return null;
  const token = typeof raw.token === "string" ? raw.token : "";
  if (!ETH_ADDRESS_RE.test(token)) return null;
  const tier = TIERS.has(raw.tier) ? raw.tier : "none";
  const creator =
    typeof raw.creator === "string" && ETH_ADDRESS_RE.test(raw.creator) ? raw.creator : null;
  const unlocks = Array.isArray(raw.unlocks)
    ? raw.unlocks
        .filter((u) => u && typeof u === "object")
        .map((u) => ({
          at: num(u.at) ?? 0,
          amountBps: num(u.amountBps) ?? 0,
          soldWithinWindow: !!u.soldWithinWindow,
        }))
    : undefined;
  return {
    token,
    tier,
    creator,
    launchedAt: num(raw.launchedAt) ?? 0,
    launchPriceEth: num(raw.launchPriceEth) ?? 0,
    launchLiquidityEth: num(raw.launchLiquidityEth) ?? 0,
    ...(unlocks ? { unlocks } : {}),
  };
}

function sanitizePoolMap(raw) {
  const out = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (ETH_ADDRESS_RE.test(k) && typeof v === "string" && ETH_ADDRESS_RE.test(v)) {
        out[k.toLowerCase()] = v;
      }
    }
  }
  return out;
}

function parseBody(req) {
  const b = req.body;
  if (b == null) return {};
  if (typeof b === "string") {
    try {
      return JSON.parse(b);
    } catch {
      return {};
    }
  }
  return typeof b === "object" ? b : {};
}

// ── Handler ────────────────────────────────────────────────────────────────
export async function handleLauncherOutcomes(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Fans out to GeckoTerminal + Etherscan → throttle tighter than a plain proxy.
  const allowed = await checkRateLimit(req, res, {
    limit: 20,
    windowSec: 60,
    identifier: "launcher-outcomes",
  });
  if (!allowed) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = parseBody(req);
  const rawList = Array.isArray(body.baselines) ? body.baselines : null;
  if (!rawList) {
    return res.status(400).json({ error: "Expected { baselines: LaunchBaseline[] }" });
  }
  if (rawList.length > MAX_BASELINES) {
    return res.status(400).json({ error: `Too many baselines (max ${MAX_BASELINES})` });
  }

  const baselines = rawList.map(sanitizeBaseline).filter(Boolean);
  const poolByToken = sanitizePoolMap(body.poolByToken);

  // observedAt is computed SERVER-SIDE (a client value could skew the
  // abandonment/recency math). Deterministic within one request.
  const observedAt = Math.floor(Date.now() / 1000);

  // Per-request memoized + concurrency-bounded fetchers: the record and summary
  // passes share every in-flight upstream read instead of duplicating it, and
  // GeckoTerminal stays under ~5 concurrent reads no matter the fan-out.
  const fetcher = makeMemoizedFetcher(poolByToken);

  try {
    const [records, summaries] = await Promise.all([
      buildOutcomeRecords(baselines, fetcher, observedAt),
      buildLaunchSummaries(baselines, fetcher),
    ]);

    const outcomes = {};
    for (const r of records) outcomes[String(r.token).toLowerCase()] = r;

    // Cache briefly at the edge — outcomes move slowly and the fan-out is heavy.
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({ launches: summaries, outcomes });
  } catch (err) {
    console.error("launcher-outcomes error:", logSafe(err));
    return res.status(502).json({ error: "Failed to assemble launcher outcomes" });
  }
}
