// AUDIT FE-CRIT-01: hardened proxy for OpenOcean aggregator API.
//
// Replaces the open `vercel.json` rewrite at /api/openocean/:path*. See the
// header in api/_lib/aggregator-proxy.js for the full attack class closed.
//
// Endpoints actually used by `frontend/src/lib/aggregator.ts` (line ~272):
//   GET /v4/eth/quote   → OpenOcean price-only quote
//
// We allowlist `eth` (mainnet) only — chain slugs `bsc`, `polygon`, etc.
// are NOT exposed because Tegridy is mainnet-only.

import { runProxy } from "../_lib/aggregator-proxy.js";

const ALLOWED_QUERY = ["inTokenAddress", "outTokenAddress", "amount", "gasPrice"];

function matchPath(segments) {
  // GET /v4/eth/quote
  if (
    segments.length === 3 &&
    segments[0] === "v4" &&
    segments[1] === "eth" &&
    segments[2] === "quote"
  ) {
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  return runProxy(req, res, {
    identifier: "openocean",
    upstreamBase: "https://open-api.openocean.finance",
    matchPath,
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ALLOWED_QUERY,
    rateLimit: 60,
    rateWindowSec: 60,
  });
}
