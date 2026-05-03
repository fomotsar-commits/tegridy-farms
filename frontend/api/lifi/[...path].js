// AUDIT FE-CRIT-01: hardened proxy for Li.Fi quote API.
//
// Replaces the open `vercel.json` rewrite at /api/lifi/:path*. See the
// header in api/_lib/aggregator-proxy.js for the full attack class closed.
//
// Endpoints actually used by `frontend/src/lib/aggregator.ts` (line ~204):
//   GET /v1/quote   → Li.Fi route quote
//
// All other Li.Fi endpoints (connections, contractCalls, …) are NOT exposed.

import { runProxy } from "../_lib/aggregator-proxy.js";

// Li.Fi `/v1/quote` query params used by `getLiFiQuote`:
//   fromChain, toChain, fromToken, toToken, fromAmount, fromAddress, slippage
const ALLOWED_QUERY = [
  "fromChain",
  "toChain",
  "fromToken",
  "toToken",
  "fromAmount",
  "fromAddress",
  "slippage",
];

function matchPath(segments) {
  // GET /v1/quote
  if (segments.length === 2 && segments[0] === "v1" && segments[1] === "quote") {
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  return runProxy(req, res, {
    identifier: "lifi",
    upstreamBase: "https://li.quest",
    matchPath,
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ALLOWED_QUERY,
    rateLimit: 60,
    rateWindowSec: 60,
  });
}
