// AUDIT FE-CRIT-01: hardened proxy for Odos quote endpoints.
//
// Replaces the open `vercel.json` rewrite that pointed `/api/odos/:path*`
// at https://api.odos.xyz/:path*. The rewrite had no rate limit, no body
// cap, no Origin allowlist, and no path allowlist — anyone could turn our
// origin into a free open proxy that burned Odos quota under our IP and
// could relay arbitrary POST bodies through our trusted host.
//
// Endpoints actually used by `frontend/src/lib/aggregator.ts` (line ~123):
//   POST /sor/quote/v2   → quote builder used by the meta-aggregator
//
// We allowlist only that path. Other Odos endpoints (e.g. /sor/swap, the
// router-info / contract-info family) are NOT exposed; if a future caller
// needs one we add it explicitly here, never via passive proxy.

import { runProxy } from "../_lib/aggregator-proxy.js";

// Odos accepts `chainId`, token addresses, slippage, etc. in the POST body —
// nothing meaningful in the query string. We forward an empty allowlist.
const ALLOWED_QUERY = [];

function matchPath(segments) {
  // POST /sor/quote/v2
  if (segments.length === 3 && segments[0] === "sor" && segments[1] === "quote" && segments[2] === "v2") {
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  return runProxy(req, res, {
    identifier: "odos",
    upstreamBase: "https://api.odos.xyz",
    matchPath,
    allowedMethods: new Set(["POST", "OPTIONS"]),
    allowedQuery: ALLOWED_QUERY,
    rateLimit: 60,
    rateWindowSec: 60,
  });
}
