// AUDIT FE-CRIT-01: hardened proxy for SwapAPI.dev aggregator.
//
// Replaces the open `vercel.json` rewrite at /api/swapapi/:path*. See the
// header in api/_lib/aggregator-proxy.js for the full attack class closed.
//
// Endpoints actually used by `frontend/src/lib/aggregator.ts` (line ~91):
//   GET /v1/swap/{chainId}   → SwapAPI quote (also used as the swap-builder)
//
// Tegridy is mainnet-only (SUPPORTED_CHAIN_ID = 1) so we allowlist chainId
// `1` only. If multichain support is ever added, the chainId regex below
// is the single source of truth to widen.

import { runProxy } from "../_lib/aggregator-proxy.js";

const ALLOWED_QUERY = ["tokenIn", "tokenOut", "amount", "sender", "maxSlippage"];
// Mainnet only.
const ALLOWED_CHAIN_IDS = new Set(["1"]);

function matchPath(segments) {
  // GET /v1/swap/{chainId}
  if (
    segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "swap" &&
    ALLOWED_CHAIN_IDS.has(segments[2])
  ) {
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  return runProxy(req, res, {
    identifier: "swapapi",
    upstreamBase: "https://api.swapapi.dev",
    matchPath,
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ALLOWED_QUERY,
    rateLimit: 60,
    rateWindowSec: 60,
  });
}
