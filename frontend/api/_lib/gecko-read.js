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
// The thing that helps is the `s-maxage` header at the bottom of this file:
// the CDN answers, so upstream sees at most ~1 request per distinct URL per
// CACHE_SECONDS however many people are reading. That is the whole mechanism.
// A version of this file with the header deleted is a REGRESSION, not a
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
// WHERE IT DIFFERS FROM pool-market ON PURPOSE — status forwarding.
//   pool-market flattens every non-404 upstream failure to 502. Its one caller
//   renders a single dash-strip and does not care which failure it was. The
//   callers here DO care and say so in their own headers: chart/ohlcv.ts,
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

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// ── Config ───────────────────────────────────────────────────────────────
// The host is a module constant so it can never come from the request.
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

// The edge answers from cache for this long. Matches `pool-market`'s window
// deliberately: one number for one upstream, so a reader reasoning about the
// keyless budget has one figure to reason about rather than a per-path table
// nobody can hold in their head. Short enough that a price strip, a candle or
// a trades tape is not stale in a way a reader would notice.
const CACHE_SECONDS = 45;

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

  // Per-IP bounds one caller. The edge cache means a warm URL never reaches
  // here at all, so this only ever throttles cache misses. Set above
  // pool-market's 30 because one chart page legitimately walks several
  // timeframes, and each is a distinct cache key.
  const allowed = await checkRateLimit(req, res, {
    limit: 60,
    windowSec: 60,
    identifier: "gecko-read",
  });
  if (!allowed) return;

  // The aggregate breaker bounds the FLEET against a shared keyless upstream
  // that rate-limits US, not the individual visitor. This is the number that
  // matters now that reads are funnelled through one egress IP.
  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.GECKO_READ_GLOBAL_RPM) || 240,
    windowSec: 60,
    identifier: "gecko-read",
  });
  if (!underCap) return;

  const accept = String(req.headers?.accept || "");
  const upstreamAccept = ACCEPT_RE.test(accept) ? accept : "application/json";

  try {
    const upstream = await fetch(`${GECKO_BASE}${path}${query ? `?${query}` : ""}`, {
      headers: { Accept: upstreamAccept },
    });
    if (!upstream.ok) {
      // 404 and 429 are forwarded VERBATIM — three callers branch on those two
      // exact codes to tell a reader which kind of nothing they got. Everything
      // else becomes 502. Never cached: caching a failure would pin the outage
      // state in front of every visitor for the whole window, which is the
      // exact symptom this change exists to remove.
      const status = upstream.status === 404 || upstream.status === 429 ? upstream.status : 502;
      return res.status(status).json({ error: `Upstream HTTP ${upstream.status}` });
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
    // Set ONLY on a 200.
    res.setHeader(
      "Cache-Control",
      `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 4}`,
    );
    return res.status(200).json(json);
  } catch (err) {
    console.error("gecko-read error:", logSafe(err));
    return res.status(502).json({ error: "Failed to read upstream" });
  }
}
