// AUDIT FE-CRIT-01 follow-up: consolidated dispatcher for the seven gated
// DEX-aggregator proxies (cow / kyber / lifi / odos / openocean / paraswap /
// swapapi). Previously each provider had its own `frontend/api/{p}/[...path].js`
// file. Vercel counts every API file as one Serverless Function, and the
// Hobby plan's per-deployment limit for non-Next.js frameworks is **12**
// (https://vercel.com/docs/functions/runtimes#functions-created-per-deployment).
// Eight pre-existing functions + seven aggregator wrappers = 15, over the
// cap, which broke every Production deployment since 2026-05-04.
//
// This dispatcher is one function. All security gates still live in
// `_lib/aggregator-proxy.js` — unchanged. Provider configs below are
// byte-identical to the per-provider wrappers they replace (compare with
// `git show 975e5af -- frontend/api/{provider}/[...path].js`).
//
// URL contract preserved via vercel.json rewrites:
//     /api/{provider}/:path*   →   /api/agg/{provider}/:path*
// Frontend (`src/lib/aggregator.ts`) keeps calling the old per-provider
// URLs; nothing in the client changes.

import { runProxy } from "../_lib/aggregator-proxy.js";

// Strict per-provider config table. Anything not in this object returns 404
// from the dispatcher (fail-closed; provider name is not echoed back).
const PROVIDER_CONFIGS = {
  cow: {
    upstreamBase: "https://api.cow.fi",
    // POST /mainnet/api/v1/quote — mainnet only.
    matchPath: (s) =>
      s.length === 4 && s[0] === "mainnet" && s[1] === "api" && s[2] === "v1" && s[3] === "quote",
    allowedMethods: new Set(["POST", "OPTIONS"]),
    allowedQuery: [],
  },
  kyber: {
    upstreamBase: "https://aggregator-api.kyberswap.com",
    // GET /ethereum/api/v1/routes — mainnet only.
    matchPath: (s) =>
      s.length === 4 && s[0] === "ethereum" && s[1] === "api" && s[2] === "v1" && s[3] === "routes",
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ["tokenIn", "tokenOut", "amountIn"],
    extraHeaders: { "X-Client-Id": "tegridy-farms" },
  },
  lifi: {
    upstreamBase: "https://li.quest",
    // GET /v1/quote
    matchPath: (s) => s.length === 2 && s[0] === "v1" && s[1] === "quote",
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ["fromChain", "toChain", "fromToken", "toToken", "fromAmount", "fromAddress", "slippage"],
  },
  odos: {
    upstreamBase: "https://api.odos.xyz",
    // POST /sor/quote/v2
    matchPath: (s) => s.length === 3 && s[0] === "sor" && s[1] === "quote" && s[2] === "v2",
    allowedMethods: new Set(["POST", "OPTIONS"]),
    allowedQuery: [],
  },
  openocean: {
    upstreamBase: "https://open-api.openocean.finance",
    // GET /v4/eth/quote — mainnet only.
    matchPath: (s) => s.length === 3 && s[0] === "v4" && s[1] === "eth" && s[2] === "quote",
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ["inTokenAddress", "outTokenAddress", "amount", "gasPrice"],
  },
  paraswap: {
    upstreamBase: "https://api.paraswap.io",
    // GET /prices
    matchPath: (s) => s.length === 1 && s[0] === "prices",
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ["srcToken", "destToken", "amount", "side", "network"],
  },
  swapapi: {
    upstreamBase: "https://api.swapapi.dev",
    // GET /v1/swap/{chainId} — chainId 1 (mainnet) only.
    matchPath: (s) => s.length === 3 && s[0] === "v1" && s[1] === "swap" && s[2] === "1",
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ["tokenIn", "tokenOut", "amount", "sender", "maxSlippage"],
  },
};

export default async function handler(req, res) {
  // Vercel binds the catch-all to `req.query.slug`. Per Vercel's catch-all
  // semantics it can be a string (single segment) or an array (multiple).
  const rawSlug = req.query?.slug;
  const slug = Array.isArray(rawSlug) ? rawSlug : rawSlug != null && rawSlug !== "" ? [String(rawSlug)] : [];
  const provider = slug[0];

  // Strict allowlist — must be one of the seven keys above. Provider name
  // intentionally NOT echoed in the response body to avoid leaking the
  // dispatcher's internal routing table.
  if (!provider || !Object.prototype.hasOwnProperty.call(PROVIDER_CONFIGS, provider)) {
    return res.status(404).json({ error: "Not found" });
  }
  const cfg = PROVIDER_CONFIGS[provider];

  // Repackage the rest of the slug as `path` so `runProxy`'s catch-all
  // extractor sees what it expects from the old per-provider files. From
  // here on the request is indistinguishable from the pre-consolidation
  // shape — runProxy's full pipeline (origin gate, rate-limit, path
  // allowlist, body cap, query allowlist) runs unchanged.
  const restPath = slug.slice(1);
  const proxyQuery = { ...(req.query || {}), path: restPath };
  delete proxyQuery.slug;
  const proxyReq = { ...req, query: proxyQuery };

  return runProxy(proxyReq, res, {
    identifier: provider,
    upstreamBase: cfg.upstreamBase,
    matchPath: cfg.matchPath,
    allowedMethods: cfg.allowedMethods,
    allowedQuery: cfg.allowedQuery,
    extraHeaders: cfg.extraHeaders,
    rateLimit: 60,
    rateWindowSec: 60,
  });
}
