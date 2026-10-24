// gecko-read — the EDGE-CACHED read path for GeckoTerminal's keyless API.
//
// WHY THIS EXISTS, and why the obvious version of it would have been worse.
//
// The prod console sweep measured 46 of 64 routes logging a failed
// GeckoTerminal read. The message the browser prints is `blocked by CORS
// policy` -> net::ERR_FAILED, and that message is WRONG about the cause:
// curled on 2026-09-05, all three failing paths (`/trades`, `/ohlcv/*`,
// `/simple/networks/*/token_price`) answer **200 with
// `access-control-allow-origin: *`**. The header is present on success and
// ABSENT on a 429, so from inside the page a throttled read is
// indistinguishable from a blocked one. It is a keyless RATE LIMIT.
//
// That inverts the naive fix. A BARE proxy puts every visitor's reads on ONE
// Vercel egress IP and burns the shared keyless budget FASTER than the direct
// browser fetch it replaces, which at least gave each visitor their own budget.
// The thing that helps is the `s-maxage` header (set in gecko-upstream.js): the
// CDN answers, so upstream sees at most ~1 request per distinct URL per fresh
// window however many people are reading. That is the whole mechanism.
// A version of this with the header deleted is a REGRESSION, not a
// no-op — `__tests__/gecko-read.test.js` pins it for exactly that reason.
//
// This is the same argument `_lib/pool-market.js` makes for ONE pool's market
// facts, and this file is deliberately its sibling rather than a second
// approach: same upstream host, same origin gate, same per-IP budget, same
// fleet breaker, same lazy dispatch from the aggregator catchall. What differs
// is only the shape of the question — pool-market answers one fixed endpoint,
// this answers the SEVEN remaining browser-direct read shapes behind one
// anchored path allowlist.
//
// STATUS FORWARDING (pool-market used to flatten a 429 to 502; since 2026-10-15
// both go through the same door and both forward it). The callers here care
// and say so in their own headers: chart/ohlcv.ts,
//   geckoTerminal/pools.ts and geckoTerminal/poolTrades.ts each branch on
//   `res.status === 429` to report "the feed is rate-limiting, try again"
//   rather than a generic refusal, and ohlcv.ts branches on 404 to say "this
//   SOURCE has no pool here" rather than making a claim about the chain.
//   Flattening 429 to 502 here would silently delete three written honesty
//   contracts, so 404 and 429 are forwarded VERBATIM and everything else
//   becomes 502.
//
// It performs the FETCH ONLY and forwards the raw JSON:API envelope. Every
// parse stays in the caller's own validated reader, so the hostile-JSON
// handling keeps exactly one tested implementation per surface and this
// adapter stays a thin, cacheable pipe.
//
// THE FETCH ITSELF lives in `_lib/gecko-upstream.js` (2026-10-15), shared with
// pool-market: one budget per minute under GeckoTerminal's own limit, a cool-down
// after it refuses us, a fresh window per read shape (candles over days keep for
// ten minutes, a trade tape for one), and the last good copy, marked with its
// age, for a caller that asks. Read that file's header before changing the
// numbers. A 404 and a refusal (429) still arrive as themselves.

import { isRequestOriginAllowed } from "./aggregator-proxy.js";
import {
  serveGeckoRead,
  GECKO_CORS_ALLOW_HEADERS,
  GECKO_CORS_EXPOSE_HEADERS,
} from "./gecko-upstream.js";

// ── The path allowlist ───────────────────────────────────────────────────
// `path` is interpolated into an UPSTREAM URL PATH, so it is gated on ANCHORED
// whole-string allowlists rather than escaped. There is no character class
// permissive enough to be convenient AND tight enough to be safe here: a
// slash, a dot, a percent or a colon in the wrong segment would let a caller
// walk the path or re-point the host. So each shape that actually exists is
// written out, and anything else is a 400 that never reaches `fetch`.
//
// Ids are pinned to the two shapes that exist rather than to a loose class: an
// EVM address, or a Solana base58 one. Base58 excludes 0/O/I/l by definition,
// so it is its own alphabet and not hex-plus-letters — writing it out is what
// makes this an allowlist instead of a slightly-narrower denylist.
const NET = "[a-z0-9_-]{1,32}";
const ID = "(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})";
// GeckoTerminal's own cap on `pools/multi` and on a comma-joined price lookup.
const MAX_IDS = 30;
const ID_LIST = `${ID}(?:,${ID}){0,${MAX_IDS - 1}}`;
const TIMEFRAME = "(?:minute|hour|day)";

const ALLOWED_PATHS = [
  // One pool's recent fills — geckoTerminal/poolTrades.ts, useProtocolActivity.
  new RegExp(`^/networks/${NET}/pools/${ID}/trades$`),
  // Candles — chart/ohlcv.ts, chart/market.ts, solanaChart.ts.
  new RegExp(`^/networks/${NET}/pools/${ID}/ohlcv/${TIMEFRAME}$`),
  // Specific pools in one call — the watchlist/island views in pools.ts.
  new RegExp(`^/networks/${NET}/pools/multi/${ID_LIST}$`),
  // The two list views — pools.ts `new`/`trending`.
  new RegExp(`^/networks/${NET}/(?:new_pools|trending_pools)$`),
  // A token's pools, used to resolve a mint's top pool — solanaChart.ts.
  new RegExp(`^/networks/${NET}/tokens/${ID}/pools$`),
  // Display price — useToweliPrice.ts.
  new RegExp(`^/simple/networks/${NET}/token_price/${ID_LIST}$`),
];

/**
 * Exported so the CLIENT builders can be tested against the SAME allowlist they
 * must satisfy. A client URL builder and a server path regex that drift apart is
 * the obvious failure mode of this design and would show up in production as a
 * 400 on a read that used to work, so `src/lib/geckoTerminal/edge.test.ts`
 * feeds every URL the browser builds through this function.
 */
export function isAllowedPath(p) {
  return ALLOWED_PATHS.some((re) => re.test(p));
}

// Query parameters are forwarded only from this table, each with its own
// anchored value rule. An unknown key is DROPPED rather than rejected: the
// upstream ignores what it does not know, and a 400 on an extra param would
// make this proxy stricter than the direct fetch it replaces for no gain.
const QUERY_RULES = {
  aggregate: /^[0-9]{1,4}$/,
  limit: /^[0-9]{1,4}$/,
  currency: /^(?:usd|token)$/,
  page: /^[0-9]{1,3}$/,
};

/** The forwarded query string, or null when a present value is malformed. */
function buildQuery(query) {
  const parts = [];
  for (const [key, rule] of Object.entries(QUERY_RULES)) {
    const raw = query?.[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const value = String(raw);
    if (!rule.test(value)) return null;
    parts.push(`${key}=${value}`);
  }
  return parts.join("&");
}

// GeckoTerminal versions its response shape through `Accept`. solanaChart.ts
// pins `application/json;version=20230302` and parses that shape, so the
// caller's header is forwarded when it matches this one anchored rule and
// replaced with the plain default otherwise. Forwarding the raw header would
// hand a caller a free request-shaping lever into a third-party host.
const ACCEPT_RE = /^application\/json(?:;version=[0-9]{8})?$/;

// Same credentialed-CORS origin set the rest of the api/ surface uses
// (api/etherscan.js, _lib/launch-radar.js, _lib/pool-market.js).
const ALLOWED_ORIGINS = [
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
  res.setHeader("Access-Control-Allow-Headers", GECKO_CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Expose-Headers", GECKO_CORS_EXPOSE_HEADERS);
}

// ── Handler ────────────────────────────────────────────────────────────────
export async function handleGeckoRead(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // ENFORCE the origin — `setCors` only sets a header. Dispatched before
  // runProxy, so this branch does not inherit aggregator-proxy.js's 403 and
  // must apply its own.
  if (!isRequestOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const path = String(req.query.path || "");
  if (!isAllowedPath(path)) {
    return res.status(400).json({ error: "Unsupported path" });
  }

  const query = buildQuery(req.query);
  if (query === null) {
    return res.status(400).json({ error: "Invalid query parameter" });
  }

  const accept = String(req.headers?.accept || "");
  const upstreamAccept = ACCEPT_RE.test(accept) ? accept : "application/json";

  // Per-IP bounds one caller's cache misses. Set above pool-market's 30 because
  // one chart page legitimately walks several timeframes, and each is a
  // distinct cache key. The budget that protects GeckoTerminal is the shared
  // one inside serveGeckoRead, not this.
  return serveGeckoRead(req, res, {
    path,
    query,
    accept: upstreamAccept,
    perIpLimit: 60,
    identifier: "gecko-read",
  });
}
