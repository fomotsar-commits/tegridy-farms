// AUDIT FE-CRIT-01: hardened proxy for ParaSwap aggregator API.
//
// Replaces the open `vercel.json` rewrite at /api/paraswap/:path*. See the
// header in api/_lib/aggregator-proxy.js for the full attack class closed.
//
// Endpoints actually used by `frontend/src/lib/aggregator.ts` (line ~301):
//   GET /prices   → ParaSwap price-only quote
//
// We allowlist `/prices` only. The /transactions/{network} endpoint (the
// build-tx step) is NOT exposed; ParaSwap orders aren't part of this code
// path — adding it would require explicit allowlist + body schema work.

import { runProxy } from "../_lib/aggregator-proxy.js";

const ALLOWED_QUERY = ["srcToken", "destToken", "amount", "side", "network"];

function matchPath(segments) {
  // GET /prices
  if (segments.length === 1 && segments[0] === "prices") {
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  return runProxy(req, res, {
    identifier: "paraswap",
    upstreamBase: "https://api.paraswap.io",
    matchPath,
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ALLOWED_QUERY,
    rateLimit: 60,
    rateWindowSec: 60,
  });
}
