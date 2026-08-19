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

import { runProxy } from "./_lib/aggregator-proxy.js";

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

  // Jupiter Swap API (SOLANA) — GET /swap/v1/quote, POST /swap/v1/swap.
  // 2026-06-18: Solana fee-capture surface (Surface A — see
  // docs/SOLANA_FEE_CAPTURE_PLAN.md). Keyless lite-api tier. The platform fee
  // is taken via `platformFeeBps` (quote query) + `feeAccount` (a plain
  // Tegridy-owned ATA in the swap POST body) — no Jupiter Referral Program
  // needed since Jan 2025, and NO own on-chain program / NO bridge / TOWELI
  // never touches Solana. Same hardening as the EVM aggregators: origin
  // allowlist, per-IP rate limit, 32 KB body cap, response header stripping.
  jupiter: {
    identifier: "jupiter",
    upstreamBase: "https://lite-api.jup.ag",
    // swap/v1/{quote,swap} (trade) + tokens/v2/search (any-pair token search +
    // paste-a-mint resolve). Exact segment matches only — keep the surface narrow.
    matchPath: (segments) => {
      if (
        segments.length === 3 &&
        segments[0] === "swap" &&
        segments[1] === "v1" &&
        (segments[2] === "quote" || segments[2] === "swap")
      ) {
        return true;
      }
      if (
        segments.length === 3 &&
        segments[0] === "tokens" &&
        segments[1] === "v2" &&
        segments[2] === "search"
      ) {
        return true;
      }
      // Trending rails: tokens/v2/{toptrending,toptraded,toporganicscore}/{interval}
      if (
        segments.length === 4 &&
        segments[0] === "tokens" &&
        segments[1] === "v2" &&
        (segments[2] === "toptrending" || segments[2] === "toptraded" || segments[2] === "toporganicscore") &&
        (segments[3] === "5m" || segments[3] === "1h" || segments[3] === "6h" || segments[3] === "24h")
      ) {
        return true;
      }
      // USD prices for the pay/receive legs: price/v3?ids=A,B
      if (segments.length === 2 && segments[0] === "price" && segments[1] === "v3") {
        return true;
      }
      // Shield: per-mint risk warnings for a pair — ultra/v1/shield?mints=A,B
      if (segments.length === 3 && segments[0] === "ultra" && segments[1] === "v1" && segments[2] === "shield") {
        return true;
      }
      // Limit orders (Jupiter Trigger): trigger/v1/{createOrder,execute,cancelOrder,cancelOrders,getTriggerOrders}
      if (
        segments.length === 3 &&
        segments[0] === "trigger" &&
        segments[1] === "v1" &&
        (segments[2] === "createOrder" ||
          segments[2] === "execute" ||
          segments[2] === "cancelOrder" ||
          segments[2] === "cancelOrders" ||
          segments[2] === "getTriggerOrders")
      ) {
        return true;
      }
      return false;
    },
    allowedMethods: new Set(["GET", "POST", "OPTIONS"]),
    // GET query allowlist (quote params + `query` for token search). The /swap
    // call is POST with a small JSON body (quoteResponse / userPublicKey /
    // feeAccount / wrapAndUnwrapSol …) forwarded verbatim under the 32 KB cap.
    allowedQuery: [
      "inputMint",
      "outputMint",
      "amount",
      "slippageBps",
      "swapMode",
      "platformFeeBps",
      "restrictIntermediateTokens",
      "onlyDirectRoutes",
      "asLegacyTransaction",
      "maxAccounts",
      "dexes",
      "excludeDexes",
      "query",
      "limit",
      "ids",
      "mints",
      "user",
      "orderStatus",
      "page",
    ],
    rateLimit: 60,
    rateWindowSec: 60,
  },
};

export default async function handler(req, res) {
  // RESOURCE BRANCH (2026-07-17): the catchall doubles as the home for small,
  // low-traffic first-party resources that would otherwise each cost one of the
  // scarce Hobby-plan function slots (12-cap; see api/SERVERLESS_BUDGET.md).
  // `?resource=launcher-outcomes` builds real LaunchExplorer data (GeckoTerminal
  // market + Etherscan chain stats) behind the pure outcomesReader core. Lazy
  // dynamic import so the swap hot-path (provider dispatch below) never loads it.
  if (req.query.resource === "launcher-outcomes") {
    const { handleLauncherOutcomes } = await import("./_lib/launcher-outcomes.js");
    return handleLauncherOutcomes(req, res);
  }
  // `?resource=launch-radar` forwards GeckoTerminal `new_pools` (keyless) for the
  // MARKET-WIDE Launch Radar. Deliberately separate from launcher-outcomes: that one
  // enriches the Tegridy cohort, this one is the whole market and must never be fed
  // into the cohort ledger (see _lib/launch-radar.js header).
  if (req.query.resource === "launch-radar") {
    const { handleLaunchRadar } = await import("./_lib/launch-radar.js");
    return handleLaunchRadar(req, res);
  }

  // `?resource=launch-cohort` enumerates the Airlock `Create` history so the cohort
  // surfaces can exist at all. Phase two — deciding which of those assets are OURS — stays
  // client-side in ourLaunches.ts, so provenance has exactly one implementation. Lazy
  // import: the swap hot path never pays for this. See _lib/launch-cohort.js header.
  if (req.query.resource === "launch-cohort") {
    const { handleLaunchCohort } = await import("./_lib/launch-cohort.js");
    return handleLaunchCohort(req, res);
  }

  // `?resource=heat` proxies Jungle Bay Island's held-time oracle at memetics.wtf.
  // This one is not an optimisation: the upstream answers with
  // `Access-Control-Allow-Origin: https://junglebayisland.lat`, so a browser fetch
  // from our origin is CORS-blocked and there is no client-side workaround. Going
  // through here also keeps the browser talking only to `'self'`, so vercel.json's
  // connect-src needs no new host. Lazy import: the swap hot path never pays for it.
  // See _lib/heat.js header.
  //
  // MUST stay above the `const provider` line below — a ?resource= call carries no
  // provider, so a branch placed after it never runs and falls into the 404.
  if (req.query.resource === "heat") {
    const { handleHeat } = await import("./_lib/heat.js");
    return handleHeat(req, res);
  }

  // `?resource=births` signs a birth notify with the venue's shared secret and relays it
  // to the island's enrollment socket. Server-side because the SECRET is the whole
  // guarantee — a signature the browser could produce is one anybody could produce.
  // Lazy import, same as the branches above; also above `const provider`.
  if (req.query.resource === "births") {
    const { handleBirths } = await import("./_lib/births.js");
    return handleBirths(req, res);
  }

  // `?resource=alerts` is the per-wallet alert-rule store: CRUD only, forwarded to
  // PostgREST under the caller's own SIWE JWT so RLS decides visibility. Nothing here
  // evaluates a rule — a serverless function runs only when called, so it cannot watch
  // anything while the user's tab is shut, and every response says so in its `delivery`
  // block. Lazy import, same as the branches above; also above `const provider`.
  if (req.query.resource === "alerts") {
    const { handleAlerts } = await import("./_lib/alerts.js");
    return handleAlerts(req, res);
  }

  // `?resource=record` serves a token's birth certificate as JSON, derived from chain on
  // read. The pretty, stable route is `/record/:chain/:ca.json` (a vercel.json rewrite) —
  // that URL is what `record_url` carries to the island, so it must not move.
  //
  // ⚠️ The rewrite is LOAD-BEARING, not cosmetic. vercel.json's SPA fallback is
  // `/((?!api/).*)`, whose negative lookahead only excludes `api/…`, so without the
  // rewrite `/record/…` is rewritten to index.html and answers 200 with HTML forever —
  // a health check on `res.ok` would call that route healthy. See _lib/record.js.
  if (req.query.resource === "record") {
    const { handleRecord } = await import("./_lib/record.js");
    return handleRecord(req, res);
  }

  // `?resource=airdrop` is the hosted airdrop manifest store: a claimant fetches THEIR
  // OWN leaf and proof, and a creator publishes the list before funding. There is
  // deliberately no branch that returns the recipient list — an airdrop recipient list
  // is a wallet-targeting database, so the capability does not exist rather than being
  // permission-checked. Lazy import, same as the branches above; also above
  // `const provider`. See _lib/airdrop.js.
  if (req.query.resource === "airdrop") {
    const { handleAirdrop } = await import("./_lib/airdrop.js");
    return handleAirdrop(req, res);
  }

  // FLAT function at /api/aggregator. AUDIT FIX 2026-07-10: Vercel's nested /
  // catch-all dynamic function routing under /api/aggregator (both
  // `[provider]/[...path]` and a single `[...slug]`) did NOT route reliably with
  // this project's vercel.json rewrites — multi-segment API paths (all real
  // Jupiter/EVM endpoints) 404'd at the platform level. Flat functions route
  // 100% reliably here, so the vercel.json rewrites now map
  //   /api/<provider>/<path...>  ->  /api/aggregator?provider=<provider>&p=<path...>
  // and this handler reconstructs the path from `p` (slash-joined string).
  // Unit tests pass the normalized `provider` + `path` (array) shape directly.
  const provider = req.query.provider;
  let pathSegs;
  if (typeof req.query.p === "string") {
    pathSegs = req.query.p.split("/").filter(Boolean);
  } else {
    pathSegs = req.query.path;
  }
  if (!provider || typeof provider !== "string" || !CONFIGS[provider]) {
    res.status(404).json({ error: "Unknown aggregator provider" });
    return;
  }
  // Re-expose the remaining segments as `path` so runProxy's extractCatchAllPath
  // (which reads req.query.path) keeps working unchanged.
  req.query.path = pathSegs;
  return runProxy(req, res, CONFIGS[provider]);
}
