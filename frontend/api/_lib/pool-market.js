// Pool-market resource adapter — the network boundary for ONE pool's market
// facts (GeckoTerminal `/networks/:network/pools/:pool`, keyless).
//
// WHY THIS LIVES IN THE AGGREGATOR CATCHALL (not a new api/*.js file):
//   NOT the function cap. That cap was lifted on 2026-09-04 when the project moved
//   to Vercel Pro, and api/SERVERLESS_BUDGET.md now warns in as many words that a
//   constraint doc which outlives its constraint "does not go quiet — it keeps
//   being obeyed". This file would have been the next thing it talked into a
//   branch, so the reason is written out fresh instead of inherited:
//
//   It is a sibling of launch-radar.js in the strictest sense — same keyless
//   upstream host, same read-only GET shape, same need for an origin gate, a
//   per-IP budget and a fleet-wide breaker. Sharing the catchall means those four
//   gates have ONE implementation across both, which is the same argument
//   SERVERLESS_BUDGET.md now makes for keeping the eight swap providers
//   consolidated. A separate route would be a second copy of the gate stack to
//   keep in step, for a handler whose whole body is one fetch.
//
//   Dispatched behind a LAZY dynamic import, so the swap hot-path never loads it.
//
// WHY IT EXISTS AT ALL — the field review of 2026-09-04:
//   usePoolMarket fetched api.geckoterminal.com DIRECTLY from the browser, twice
//   per bungalow page view, with no cache anywhere. Its own header said "there is
//   no same-origin proxy for it in production, so adding one here would need an
//   operator step" — that was true when it was written and is not true now:
//   ?resource=launch-radar already proxies the same keyless host with no operator
//   step, so the plumbing this needed already existed.
//
//   The reviewer saw the consequence: a first load showed price, liquidity, FDV
//   and the buy/sell split, and a reload minutes later showed dashes across the
//   whole panel. Every visitor spent their own IP's keyless budget, and a visitor
//   who reloaded a few times spent it on themselves.
//
// WHAT THE CACHE ACTUALLY BUYS, stated precisely, because the direction is not
// the obvious one:
//   Fetching direct from the browser gives each visitor their OWN per-IP budget
//   upstream, which is genuinely better than a naive proxy — a proxy funnels the
//   whole fleet through one origin IP and would hit the keyless limit SOONER.
//   The win is not the proxy, it is `s-maxage`: Vercel's CDN answers from the
//   edge, so upstream sees at most ~1 request per pool per CACHE_SECONDS no
//   matter how many people are reading, instead of 2 per page view. That is what
//   makes this strictly better rather than a lateral move, and it is why the
//   Cache-Control header below is load-bearing rather than decoration. Removing
//   it would make this change actively worse than the direct fetch it replaces.
//
// It performs the FETCH ONLY and forwards the raw JSON:API envelope. The parse
// stays in the client's geckoTerminalPoolSchema (R080), so the hostile-JSON
// handling keeps exactly one tested implementation and this adapter stays a
// thin, cacheable pipe.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// ── Config ───────────────────────────────────────────────────────────────
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

// The edge answers from cache for this long, so the keyless upstream sees at
// most ~1.3 requests per minute per pool regardless of traffic. Short enough
// that a market strip is not stale in a way a reader would notice.
const CACHE_SECONDS = 45;

// Both of these are interpolated into an UPSTREAM URL PATH, so they are gated on
// ANCHORED allowlists rather than escaped. A slash, a dot, a percent or a colon
// would let a caller walk the path or re-point the host, and the host itself is a
// module constant above so it can never come from the request.
//
// The pool id is pinned to the two shapes that actually exist rather than to a
// permissive character class: an EVM pool address, or a Solana base58 one. Base58
// excludes 0/O/I/l by definition, so the alphabet is not the hex alphabet plus
// letters — it is its own thing, and writing it out is what makes this a
// allowlist instead of a slightly-narrower denylist.
const NETWORK_RE = /^[a-z0-9_-]{1,32}$/;
const EVM_POOL_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_POOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isPoolId(v) {
  return EVM_POOL_RE.test(v) || SOL_POOL_RE.test(v);
}

// Same credentialed-CORS origin set the rest of the api/ surface uses
// (api/etherscan.js, _lib/launch-radar.js).
const ALLOWED_ORIGINS = [
  "https://memetic.fun",
  "https://www.memetic.fun",
  "https://memetics.finance",
  "https://www.memetics.finance",
  "https://tegridyfarms.vercel.app",
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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── Handler ────────────────────────────────────────────────────────────────
export async function handlePoolMarket(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // ENFORCE the origin — `setCors` only sets a header. Dispatched before runProxy,
  // so this branch does not inherit aggregator-proxy.js's 403 and must apply it.
  if (!isRequestOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const network = String(req.query.network || "");
  const pool = String(req.query.pool || "");
  if (!NETWORK_RE.test(network) || !isPoolId(pool)) {
    return res.status(400).json({ error: "Invalid network or pool" });
  }

  // Per-IP bounds one caller. The edge cache means a warm pool never reaches
  // here at all, so this only ever throttles cache misses.
  const allowed = await checkRateLimit(req, res, {
    limit: 30,
    windowSec: 60,
    identifier: "pool-market",
  });
  if (!allowed) return;

  // The aggregate breaker bounds the fleet against a shared keyless upstream that
  // rate-limits US, not the individual visitor.
  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.POOL_MARKET_GLOBAL_RPM) || 120,
    windowSec: 60,
    identifier: "pool-market",
  });
  if (!underCap) return;

  try {
    const upstream = await fetch(`${GECKO_BASE}/networks/${network}/pools/${pool}`, {
      headers: { Accept: "application/json" },
    });
    if (!upstream.ok) {
      // Pass the upstream's own shape of failure through rather than flattening
      // every fault to one code: a 404 is "no such pool" and is permanent, a 429
      // is "try later". Never cached — see below.
      return res
        .status(upstream.status === 404 ? 404 : 502)
        .json({ error: `Upstream HTTP ${upstream.status}` });
    }

    const { text, truncated } = await readBoundedText(upstream, MAX_RESPONSE_BYTES);
    if (truncated) return res.status(502).json({ error: "Upstream response too large" });

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Upstream response was not JSON" });
    }

    // The header is the whole point of this file (see the note at the top).
    // It is set ONLY on a 200: caching a failure would pin the honest-outage
    // state in front of every visitor for the whole window, which is the exact
    // symptom this change exists to remove.
    res.setHeader(
      "Cache-Control",
      `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 4}`,
    );
    return res.status(200).json(json);
  } catch (err) {
    console.error("pool-market error:", logSafe(err));
    return res.status(502).json({ error: "Failed to read pool" });
  }
}
