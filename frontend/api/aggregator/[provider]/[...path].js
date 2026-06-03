// Single consolidated aggregator proxy.
//
// 2026-05-27 — Vercel Hobby plan limits a deployment to 12 serverless
// functions. We had 15 (the 7 aggregator proxies + 8 first-party
// endpoints), so every deploy died with:
//
//   "No more than 12 Serverless Functions can be added to a Deployment
//    on the Hobby plan. Create a team (Pro plan) to deploy more."
//
// Fix: collapse the 7 per-aggregator catchalls (cow, kyber, lifi, odos,
// openocean, paraswap, swapapi) into THIS single function and route via
// the `[provider]` path segment. Net: 15 → 9 functions, well under the
// Hobby limit AND preserves the per-aggregator security policy verbatim
// (same matchPath / allowedQuery / extraHeaders / rateLimit per provider).
//
// Each provider's CONFIG block is a one-to-one copy of what previously
// lived at `api/<provider>/[...path].js`. URL paths preserved via
// `vercel.json` rewrites (`/api/odos/:path*` → `/api/aggregator/odos/:path*`
// etc.) so no frontend changes required.

import { runProxy } from "../../_lib/aggregator-proxy.js";

// ─── Per-provider configs (verbatim from the prior individual files) ─────────

const CONFIGS = {
  // CoW Protocol orderbook — POST /mainnet/api/v1/{quote,orders}, GET /mainnet/api/v1/orders/{uid}.
  // 2026-06-02: extended from quote-only to add limit-order placement + status polling.
  // (CoW's orderbook is a public, unauthenticated API; the proxy still enforces the
  // origin allowlist + per-IP rate limit + body cap + cookie/auth stripping.)
  cow: {
    identifier: "cow",
    upstreamBase: "https://api.cow.fi",
    matchPath: (segments) => {
      if (segments[0] !== "mainnet" || segments[1] !== "api" || segments[2] !== "v1") return false;
      // POST quote / POST orders (place)
      if (segments.length === 4 && (segments[3] === "quote" || segments[3] === "orders")) return true;
      // GET orders/{uid} (status) — uid is a 56-byte (112-hex-char) CoW order UID
      if (
        segments.length === 5 &&
        segments[3] === "orders" &&
        /^0x[0-9a-fA-F]{112}$/.test(segments[4])
      ) {
        return true;
      }
      return false;
    },
    allowedMethods: new Set(["GET", "POST", "OPTIONS"]),
    allowedQuery: [],
    rateLimit: 60,
    rateWindowSec: 60,
  },

  // KyberSwap — GET /ethereum/api/v1/routes (mainnet only)
  kyber: {
    identifier: "kyber",
    upstreamBase: "https://aggregator-api.kyberswap.com",
    matchPath: (segments) =>
      segments.length === 4 &&
      segments[0] === "ethereum" &&
      segments[1] === "api" &&
      segments[2] === "v1" &&
      segments[3] === "routes",
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ["tokenIn", "tokenOut", "amountIn"],
    extraHeaders: { "X-Client-Id": "tegridy-farms" },
    rateLimit: 60,
    rateWindowSec: 60,
  },

  // Li.Fi — GET /v1/quote
  lifi: {
    identifier: "lifi",
    upstreamBase: "https://li.quest",
    matchPath: (segments) =>
      segments.length === 2 &&
      segments[0] === "v1" &&
      segments[1] === "quote",
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: [
      "fromChain",
      "toChain",
      "fromToken",
      "toToken",
      "fromAmount",
      "fromAddress",
      "slippage",
    ],
    rateLimit: 60,
    rateWindowSec: 60,
  },

  // Odos — POST /sor/quote/v2
  odos: {
    identifier: "odos",
    upstreamBase: "https://api.odos.xyz",
    matchPath: (segments) =>
      segments.length === 3 &&
      segments[0] === "sor" &&
      segments[1] === "quote" &&
      segments[2] === "v2",
    allowedMethods: new Set(["POST", "OPTIONS"]),
    allowedQuery: [],
    rateLimit: 60,
    rateWindowSec: 60,
  },

  // OpenOcean — GET /v4/eth/quote (mainnet only)
  openocean: {
    identifier: "openocean",
    upstreamBase: "https://open-api.openocean.finance",
    matchPath: (segments) =>
      segments.length === 3 &&
      segments[0] === "v4" &&
      segments[1] === "eth" &&
      segments[2] === "quote",
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ["inTokenAddress", "outTokenAddress", "amount", "gasPrice"],
    rateLimit: 60,
    rateWindowSec: 60,
  },

  // ParaSwap — GET /prices
  paraswap: {
    identifier: "paraswap",
    upstreamBase: "https://api.paraswap.io",
    matchPath: (segments) =>
      segments.length === 1 && segments[0] === "prices",
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ["srcToken", "destToken", "amount", "side", "network"],
    rateLimit: 60,
    rateWindowSec: 60,
  },

  // SwapAPI.dev — GET /v1/swap/{chainId} (mainnet only)
  swapapi: {
    identifier: "swapapi",
    upstreamBase: "https://api.swapapi.dev",
    matchPath: (segments) =>
      segments.length === 3 &&
      segments[0] === "v1" &&
      segments[1] === "swap" &&
      segments[2] === "1", // mainnet only
    allowedMethods: new Set(["GET", "OPTIONS"]),
    allowedQuery: ["tokenIn", "tokenOut", "amount", "sender", "maxSlippage"],
    rateLimit: 60,
    rateWindowSec: 60,
  },
};

export default async function handler(req, res) {
  // `[provider]` is the first dynamic segment, `[...path]` is the rest.
  // Vercel exposes both via req.query.
  const provider = req.query.provider;
  if (!provider || typeof provider !== "string" || !CONFIGS[provider]) {
    res.status(404).json({ error: "Unknown aggregator provider" });
    return;
  }
  return runProxy(req, res, CONFIGS[provider]);
}
