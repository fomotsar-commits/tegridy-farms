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
//   edge, so upstream sees at most ~1 request per pool per fresh window no
//   matter how many people are reading, instead of 2 per page view. That is what
//   makes this strictly better rather than a lateral move, and it is why the
//   Cache-Control header below is load-bearing rather than decoration. Removing
//   it would make this change actively worse than the direct fetch it replaces.
//
// It performs the FETCH ONLY and forwards the raw JSON:API envelope. The parse
// stays in the client's geckoTerminalPoolSchema (R080), so the hostile-JSON
// handling keeps exactly one tested implementation and this adapter stays a
// thin, cacheable pipe.
//
// THE FETCH ITSELF lives in `_lib/gecko-upstream.js` (2026-10-15), shared with
// gecko-read: one GeckoTerminal budget per minute for both, a cool-down after a
// refusal, a one-minute fresh window for a market strip, and the last good copy,
// marked with its age, for a caller that asks (usePoolMarket does, and prints
// the age). A refusal now arrives as 429, not 502.

import { isRequestOriginAllowed } from "./aggregator-proxy.js";
import {
  serveGeckoRead,
  GECKO_CORS_ALLOW_HEADERS,
  GECKO_CORS_EXPOSE_HEADERS,
} from "./gecko-upstream.js";

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

  // Per-IP bounds one caller's cache misses. The budget that protects
  // GeckoTerminal is the shared one inside serveGeckoRead, not this.
  return serveGeckoRead(req, res, {
    path: `/networks/${network}/pools/${pool}`,
    perIpLimit: 30,
    identifier: "pool-market",
  });
}
