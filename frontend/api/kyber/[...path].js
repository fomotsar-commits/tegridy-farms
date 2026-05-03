// AUDIT FE-CRIT-01: hardened proxy for KyberSwap aggregator API.
//
// Replaces the open `vercel.json` rewrite at /api/kyber/:path*. See the
// header in api/_lib/aggregator-proxy.js for the full attack class closed.
//
// Endpoints actually used by `frontend/src/lib/aggregator.ts` (line ~232):
//   GET /ethereum/api/v1/routes   → Kyber price-only routes endpoint
//
// We allowlist `ethereum` only (matches SUPPORTED_CHAIN_ID = 1). The /build
// endpoint is NOT exposed because Tegridy never builds Kyber transactions
// server-side; if that changes, add a separate POST allowlist entry here.
//
// Kyber asks callers to send `X-Client-Id` for request tracking; we set
// `tegridy-farms` server-side so the value is uniform across deploys and
// can't be impersonated by clients of our proxy.

import { runProxy } from "../_lib/aggregator-proxy.js";

const ALLOWED_QUERY = ["tokenIn", "tokenOut", "amountIn"];

function matchPath(segments) {
  // GET /ethereum/api/v1/routes
  if (
    segments.length === 4 &&
    segments[0] === "ethereum" &&
    segments[1] === "api" &&
    segments[2] === "v1" &&
    segments[3] === "routes"
  ) {
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  return runProxy(req, res, {
    identifier: "kyber",
    upstreamBase: "https://aggregator-api.kyberswap.com",
    matchPath,
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ALLOWED_QUERY,
    extraHeaders: { "X-Client-Id": "tegridy-farms" },
    rateLimit: 60,
    rateWindowSec: 60,
  });
}
