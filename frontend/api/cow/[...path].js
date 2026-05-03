// AUDIT FE-CRIT-01: hardened proxy for CowSwap (CoW Protocol) quote API.
//
// Replaces the open `vercel.json` rewrite at /api/cow/:path*. See the
// header in api/_lib/aggregator-proxy.js for the full attack class closed.
//
// Endpoints actually used by `frontend/src/lib/aggregator.ts` (line ~165):
//   POST /mainnet/api/v1/quote   → CoW quote builder (sell-amount-before-fee)
//
// CoW Protocol versions live under per-chain prefixes (`mainnet`, `gnosis`,
// `arbitrum_one`, …). We allowlist `mainnet` only — Tegridy contracts are
// mainnet-only per `aggregator.ts#SUPPORTED_CHAIN_ID = 1`.

import { runProxy } from "../_lib/aggregator-proxy.js";

// CoW POSTs everything in the body. No query params expected.
const ALLOWED_QUERY = [];

function matchPath(segments) {
  // POST /mainnet/api/v1/quote
  if (
    segments.length === 4 &&
    segments[0] === "mainnet" &&
    segments[1] === "api" &&
    segments[2] === "v1" &&
    segments[3] === "quote"
  ) {
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  return runProxy(req, res, {
    identifier: "cow",
    upstreamBase: "https://api.cow.fi",
    matchPath,
    allowedMethods: new Set(["POST", "OPTIONS"]),
    allowedQuery: ALLOWED_QUERY,
    rateLimit: 60,
    rateWindowSec: 60,
  });
}
