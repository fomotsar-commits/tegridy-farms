// ═══ DEVELOPER API v1 — NFT Data & Trust Intelligence ═══
// Fills the Reservoir/SimpleHash gap. Battle-tested REST patterns
// from Alchemy, Nansen, and Reservoir's open API design.
//
// Free, anonymous (unchanged — the browser app calls these):
//   GET /api/v1?route=collections&slug=nakamigos     → collection stats
//   GET /api/v1?route=listings&slug=nakamigos         → active listings
//   GET /api/v1?route=floor&contract=0x...            → floor price oracle
//   GET /api/v1?route=holders&contract=0x...          → top holders
//   GET /api/v1?route=activity&contract=0x...         → recent sales
//   GET /api/v1?route=token&contract=0x...&tokenId=1  → token metadata
//   GET /api/v1?route=erc20scan&contract=0x...        → holder distribution
//
// Keyed (X-API-Key; 401 without one — never a degraded free answer):
//   GET /api/v1?route=scan&chain=ethereum&address=0x… → product scan envelope
//
// Platform:
//   GET  /api/v1?route=status  → what this deployment has configured
//   GET  /api/v1?route=keys    → this wallet's keys (SIWE cookie)
//   POST /api/v1?route=keys    → issue / revoke (SIWE cookie)
//
// FUNCTION BUDGET: everything above is ONE Vercel function. The Hobby plan caps a
// deployment at 12 and this repo is at 11; the keyed layer therefore extends this
// existing handler rather than adding routes. See api/SERVERLESS_BUDGET.md.

import { checkRateLimit, checkGlobalLimit } from "../_lib/ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "../_lib/bodycap.js";
import { logSafe } from "../_lib/logSafe.js";
import { fetchAlchemyWithFailover } from "../_lib/alchemy-failover.js";
import { readErc20Distribution, handleScanRoute } from "../_lib/scannerApi.js";
import {
  admitKeyedCall,
  extractPresentedKey,
  apiPlatformStatus,
  readSiweSession,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
} from "../_lib/apiAuth.js";
import { API_TIERS, API_TIER_ORDER, API_ROUTES, API_ROADMAP, API_PRICING_STATE, API_BILLING_ENABLED } from "../_lib/apiTiers.js";

// Key management is the only POST here and its largest legitimate body is
// { action, label } — a couple hundred bytes. 8 KB is generous and caps the
// deeply-nested-JSON CPU DoS the same way supabase-proxy.js does.
export const config = { api: { bodyParser: { sizeLimit: "8kb" } } };

// AUDIT R048: header auth — Alchemy NFT base URL drops the /${KEY} segment
// when a real key is configured; the bearer header is injected per-fetch.
// RESIL-1: fetches route through fetchAlchemyWithFailover so a lapsed primary
// key retries once with ALCHEMY_API_KEY_FALLBACK; builders are keyed per
// attempt (same convention as api/alchemy.js).
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || "demo";
const ALCHEMY_NFT_ROOT = "https://eth-mainnet.g.alchemy.com/nft/v3";

function alchemyNftBaseFor(key) {
  return key ? ALCHEMY_NFT_ROOT : `${ALCHEMY_NFT_ROOT}/${ALCHEMY_KEY}`;
}
function alchemyAuthHeadersFor(key, extra = {}) {
  const headers = { Accept: "application/json", ...extra };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

const ALLOWED_CONTRACTS = new Set([
  "0xd774557b647330c91bf44cfeab205095f7e6c367", // Nakamigos
  "0xa1de9f93c56c290c48849b1393b09eb616d55dbb", // GNSS Art
  "0xd37264c71e9af940e49795f0d3a8336afaafdda9", // Jungle Bay
]);

const SLUG_TO_CONTRACT = {
  nakamigos: "0xd774557b647330c91bf44cfeab205095f7e6c367",
  gnssart: "0xa1de9f93c56c290c48849b1393b09eb616d55dbb",
  junglebay: "0xd37264c71e9af940e49795f0d3a8336afaafdda9",
};

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://memetic.fun";

// Routes that refuse anonymous callers outright. `scan` is the sold surface: a
// free degraded answer here would be the product, given away, at lower quality —
// and a caller could not tell which they got.
const KEYED_ROUTES = new Set(["scan"]);

// ── Shared validation helpers ──
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const NUMERIC_ID_RE = /^\d{1,10}$/;

function isValidAddress(addr) { return typeof addr === "string" && ETH_ADDRESS_RE.test(addr); }
function isValidTokenId(id) { return typeof id === "string" && NUMERIC_ID_RE.test(id); }

const PROD_ORIGINS = [
  "https://memetic.fun",
  "https://www.memetic.fun",
  "https://memetics.finance",
  "https://www.memetics.finance",
  "https://tegridyfarms.vercel.app",
];

function allowedOrigins() {
  // AUDIT API-SEC: fail-closed — only admit localhost when NODE_ENV === "development".
  const devOrigins = process.env.NODE_ENV === "development"
    ? ["http://localhost:8742", "http://localhost:3000", "http://localhost:5173"]
    : [];
  return new Set([...PROD_ORIGINS, ...devOrigins]);
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const ALLOWED_ORIGINS = allowedOrigins();
  const known = ALLOWED_ORIGINS.has(origin);
  res.setHeader("Access-Control-Allow-Origin", known ? origin : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization");
  // Credentials only for origins we actually know: key MANAGEMENT rides the SIWE
  // cookie, and echoing an unknown origin alongside Allow-Credentials would let any
  // page mint keys for a visiting wallet. Keyed DATA calls need none of this — they
  // carry a header, and the header belongs on a server, not in a browser.
  if (known) res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
}

async function alchemyFetch(endpoint, params = {}) {
  const res = await fetchAlchemyWithFailover((key) => {
    const url = new URL(`${alchemyNftBaseFor(key)}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    });
    return { url: url.toString(), opts: { headers: alchemyAuthHeadersFor(key) } };
  });
  if (!res.ok) throw new Error(`Alchemy ${res.status}`);
  // AUDIT R049 H-3: bounded body read.
  const { text, truncated } = await readBoundedText(res, MAX_RESPONSE_BYTES);
  if (truncated) throw new Error("upstream-too-large");
  return JSON.parse(text);
}

/**
 * `route=status` — what this deployment has CONFIGURED, plus the tier catalog.
 *
 * The developer page renders from this instead of from build-time copy, so a
 * deployment with no key store cannot show a working signup. It reports
 * configuration only: never a secret, never a count, never a guess.
 */
function handleStatus(req, res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    platform: apiPlatformStatus(),
    pricingState: API_PRICING_STATE,
    billingEnabled: API_BILLING_ENABLED,
    tiers: API_TIER_ORDER.map((id) => API_TIERS[id]),
    routes: API_ROUTES,
    roadmap: API_ROADMAP,
  });
}

/** `route=keys` — SIWE-cookie-authed key management. Never key-authed: a key
 *  cannot mint another key, so a leaked key cannot outlive its own revocation. */
async function handleKeys(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // The cookie is SameSite=Strict, so a cross-site POST never carries it; this is
  // the belt to that suspender and it also covers a same-site subdomain takeover.
  if (req.method === "POST" && !allowedOrigins().has(req.headers.origin || "")) {
    return res.status(403).json({ error: "Origin not allowed", code: "origin_not_allowed" });
  }

  const rlOk = await checkRateLimit(req, res, { limit: 20, windowSec: 60, identifier: "v1-keys" });
  if (!rlOk) return;

  const session = await readSiweSession(req);
  if (!session) {
    // 401, not 503, even when SUPABASE_JWT_SECRET is unset: the reachable fact is
    // that this caller has no session. `route=status` is the surface that reports
    // whether issuance is configured at all, and the page reads it before offering
    // a button, so an unconfigured deployment never gets here with a live session.
    return res.status(401).json({ error: "Connect and sign in first.", code: "not_authenticated" });
  }

  if (req.method === "GET") {
    const out = await listApiKeys(session.wallet);
    if (!out.ok) return res.status(out.status).json({ error: out.message, code: out.code });
    return res.status(200).json({ wallet: session.wallet, keys: out.keys });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", code: "method_not_allowed" });
  }

  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const action = String(body.action || "");

  if (action === "issue") {
    // No `tier` is read from the body. Issuance mints the self-serve tier and
    // nothing else — a request that could name its own tier is a free upgrade.
    const out = await issueApiKey({ ownerWallet: session.wallet, label: body.label });
    if (!out.ok) return res.status(out.status).json({ error: out.message, code: out.code });
    return res.status(201).json({
      key: out.secret,
      metadata: out.key,
      // Said in the payload, not only in docs: the plaintext is not stored, so a
      // client that discards it has nothing to come back for.
      notice: "This is the only time this key is shown. It is stored as a hash and cannot be recovered.",
    });
  }

  if (action === "revoke") {
    const id = String(body.id || "");
    if (!id) return res.status(400).json({ error: "Missing id", code: "missing_id" });
    const out = await revokeApiKey({ ownerWallet: session.wallet, id });
    if (!out.ok) return res.status(out.status).json({ error: out.message, code: out.code });
    return res.status(200).json({ revoked: out.id });
  }

  return res.status(400).json({ error: "Unknown action", code: "unknown_action" });
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const route = req.query.route;

  // Platform routes first: neither spends an upstream call, and `status` must stay
  // reachable while the data surface is shedding load — it is how an integrator
  // finds out that it is.
  if (route === "status") {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
    return handleStatus(req, res);
  }
  if (route === "keys") return handleKeys(req, res);

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const presentedKey = extractPresentedKey(req);

  if (!presentedKey) {
    // ── ANONYMOUS PATH — unchanged from before the keyed layer ──────────────
    // AUDIT R049 H-2: real per-IP rate limit (was cosmetic-header-only).
    // 20 req/min — each v1 call fans out to 1-3 upstream Alchemy + OpenSea
    // calls, so the budget burns fast. Headers are set by checkRateLimit.
    const allowed = await checkRateLimit(req, res, {
      limit: 20, windowSec: 60, identifier: "v1",
    });
    if (!allowed) return;

    // COST AMPLIFIER FIX 2026-08-06: global circuit-breaker. The per-IP cap above
    // stops ONE abusive source but not a DISTRIBUTED flood — N callers each under
    // 20/min still fan out to metered upstreams (Alchemy compute units, an OpenSea
    // key, an Ethplorer key), and `erc20scan` accepts ANY address, so there is no
    // allowlist narrowing the surface. api/alchemy.js and _lib/aggregator-proxy.js
    // already sit behind this breaker; v1 was the gap. Sheds with 503 past the
    // aggregate ceiling; raise V1_GLOBAL_RPM (env, no redeploy) if organic traffic
    // ever reaches it.
    const underGlobalCap = await checkGlobalLimit(res, {
      limit: Number(process.env.V1_GLOBAL_RPM) || 600,
      windowSec: 60,
      identifier: "v1",
    });
    if (!underGlobalCap) return;
  } else {
    // ── KEYED PATH ─────────────────────────────────────────────────────────
    // The anonymous 20/min ceiling is deliberately NOT applied: it sits below
    // every paid tier, so leaving it in would sell 300 rpm and deliver 20. What
    // replaces it is a per-IP bound on KEY LOOKUPS — one Supabase round trip each
    // — set above the top tier's rate so no legitimate customer can reach it.
    const lookupOk = await checkRateLimit(req, res, {
      limit: Number(process.env.V1_KEY_LOOKUP_RPM) || 1500,
      windowSec: 60,
      identifier: "v1-key-auth",
    });
    if (!lookupOk) return;
  }

  // Keyed callers still pass a breaker, on their OWN bucket. The free surface's
  // 600/min must not shed a paying customer, and a paid customer must not be able
  // to burn the upstream budget without a ceiling — with billing off, every keyed
  // call is upstream spend with no revenue behind it. A 503 from here is refunded
  // by `settle` below, because shedding is our decision, not the caller's usage.
  const admission = await admitKeyedCall(req, res, { requireKey: KEYED_ROUTES.has(route) });
  if (!admission) return; // refusal already written

  if (admission.keyed) {
    const underKeyedCap = await checkGlobalLimit(res, {
      limit: Number(process.env.V1_KEYED_GLOBAL_RPM) || 2000,
      windowSec: 60,
      identifier: "v1-keyed",
    });
    if (!underKeyedCap) {
      await admission.settle(503);
      return;
    }
  }

  const { slug, contract: rawContract, tokenId, limit } = req.query;

  // Validate contract address format if provided directly
  if (rawContract && !isValidAddress(rawContract)) {
    await admission.settle(400);
    return res.status(400).json({ error: "Invalid contract address format" });
  }

  // Validate slug if provided
  if (slug && !SLUG_TO_CONTRACT[slug]) {
    await admission.settle(400);
    return res.status(400).json({ error: "Unknown collection slug" });
  }

  // Validate tokenId format if provided
  if (tokenId && !isValidTokenId(tokenId)) {
    await admission.settle(400);
    return res.status(400).json({ error: "Invalid tokenId — must be numeric (max 10 digits)" });
  }

  // Resolve contract from slug or direct param
  const contract = rawContract?.toLowerCase() || (slug && SLUG_TO_CONTRACT[slug]) || null;

  if (!route) {
    await admission.settle(400);
    return res.status(400).json({ error: "Missing route parameter" });
  }
  // The token scanner reads ANY ERC-20, not just the NFT collection allowlist. The
  // address FORMAT is still validated above; this only skips the collection
  // membership check for those read-only routes.
  if (contract && route !== "erc20scan" && route !== "scan" && !ALLOWED_CONTRACTS.has(contract)) {
    await admission.settle(403);
    return res.status(403).json({ error: "Contract not supported" });
  }

  try {
    switch (route) {
      // ── Keyed product scan ──
      // The envelope, the provenance stamp and the refusal semantics all live in
      // _lib/scannerApi.js so this route and `erc20scan` can never disagree about
      // whether a read succeeded.
      case "scan": {
        const status = await handleScanRoute(req, res, { tier: admission.tier });
        await admission.settle(status);
        return;
      }

      // Public token scanner — ANY ERC-20 (not the NFT allowlist). Proxies a
      // holder-data source server-side and normalizes to the scanner's shape. The
      // client self-gates until this returns data — never fabricates.
      case "erc20scan": {
        if (!contract) {
          await admission.settle(400);
          return res.status(400).json({ error: "Missing contract" });
        }
        const result = await readErc20Distribution(contract, { limit });

        // ── EVERY READ HAS THREE OUTCOMES AND ONLY TWO ARE ANSWERS ────────────
        //   (a) read it, the answer is no   (b) read it, the answer is yes
        //   (c) COULD NOT READ IT
        // (c) is not a finding. This route is the end of the pipe that can CACHE
        // one: a degraded 200 gets stamped s-maxage=120 and served to everyone who
        // scans that token for the next two minutes, and the client renders a body
        // with no holders as "No holder data for this token — double-check the
        // address is a token (not a wallet or an NFT)". So (c) takes the uncached
        // failure path below, and only (a)/(b) are allowed to become a 200.
        if (!result.ok) {
          res.setHeader("Cache-Control", "no-store");
          // 403 = the holder source is not enabled here (needs a paid
          // ETHPLORER_API_KEY); the client renders that as an honest "scanner not
          // enabled on this deployment yet".
          // 422 = the upstream LOOKED and this address is not an ERC-20 (a wallet or
          // an NFT). That is an answer about the address, and the client maps it to
          // the "double-check the address is a token" copy written for exactly this.
          // 502 = transient upstream failure. Neither of the three is cached.
          const status = result.kind === "auth" ? 403 : result.kind === "not-a-token" ? 422 : 502;
          await admission.settle(status);
          return res.status(status).json({
            error:
              result.kind === "auth"
                ? "Holder data source is not enabled on this deployment"
                : result.kind === "not-a-token"
                  ? "Address is not an ERC-20 token contract"
                  : "Holder data source is temporarily unavailable — try again shortly",
          });
        }

        res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
        await admission.settle(200);
        return res.json(result.data);
      }
      // ── Collection Stats ──
      case "collections": {
        if (!contract) {
          await admission.settle(400);
          return res.status(400).json({ error: "Missing slug or contract" });
        }
        const [floor, meta, owners] = await Promise.all([
          alchemyFetch("getFloorPrice", { contractAddress: contract }),
          alchemyFetch("getContractMetadata", { contractAddress: contract }),
          alchemyFetch("getOwnersForContract", { contractAddress: contract, withTokenBalances: false }),
        ]);
        res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
        await admission.settle(200);
        return res.json({
          contract,
          slug: slug || null,
          floor: floor.openSea?.floorPrice ?? null,
          owners: owners.owners?.length ?? null,
          supply: parseInt(meta.contract?.totalSupply, 10) || null,
          name: meta.contract?.name || null,
          symbol: meta.contract?.symbol || null,
        });
      }

      // ── Floor Price Oracle ──
      case "floor": {
        if (!contract) {
          await admission.settle(400);
          return res.status(400).json({ error: "Missing contract" });
        }
        const data = await alchemyFetch("getFloorPrice", { contractAddress: contract });
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
        await admission.settle(200);
        return res.json({
          contract,
          floor: data.openSea?.floorPrice ?? null,
          marketplace: "opensea",
          timestamp: new Date().toISOString(),
        });
      }

      // ── Top Holders ──
      case "holders": {
        if (!contract) {
          await admission.settle(400);
          return res.status(400).json({ error: "Missing contract" });
        }
        const data = await alchemyFetch("getOwnersForContract", {
          contractAddress: contract, withTokenBalances: true,
        });
        const holders = (data.owners || [])
          .map(o => ({ address: o.ownerAddress, count: o.tokenBalances?.length || 0 }))
          .sort((a, b) => b.count - a.count)
          .slice(0, Math.min(Math.max(1, parseInt(limit, 10) || 50), 200));
        res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
        await admission.settle(200);
        return res.json({ contract, holders });
      }

      // ── Recent Activity ──
      case "activity": {
        if (!contract) {
          await admission.settle(400);
          return res.status(400).json({ error: "Missing contract" });
        }
        const data = await alchemyFetch("getNFTSales", {
          contractAddress: contract, order: "desc", limit: String(Math.min(Math.max(1, parseInt(limit, 10) || 20), 100)),
        });
        const sales = (data.nftSales || []).map(s => ({
          tokenId: s.tokenId,
          price: s.sellerFee?.amount ? Number(BigInt(s.sellerFee.amount) * 10000n / BigInt(1e18)) / 10000 : null,
          from: s.sellerAddress,
          to: s.buyerAddress,
          marketplace: s.marketplace,
          blockNumber: s.blockNumber,
          txHash: s.transactionHash,
        }));
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
        await admission.settle(200);
        return res.json({ contract, sales });
      }

      // ── Token Metadata ──
      case "token": {
        if (!contract || !tokenId) {
          await admission.settle(400);
          return res.status(400).json({ error: "Missing contract or tokenId" });
        }
        // Validate tokenId is a reasonable numeric string (prevents injection/abuse)
        if (!/^\d{1,10}$/.test(tokenId)) {
          await admission.settle(400);
          return res.status(400).json({ error: "Invalid tokenId" });
        }
        const data = await alchemyFetch("getNFTMetadata", {
          contractAddress: contract, tokenId,
        });
        res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
        await admission.settle(200);
        return res.json({
          contract,
          tokenId: data.tokenId,
          name: data.name || `#${data.tokenId}`,
          image: data.image?.cachedUrl || data.image?.originalUrl || null,
          attributes: (data.raw?.metadata?.attributes || []).map(a => ({
            key: a.trait_type, value: a.value,
          })),
          owner: data.owners?.[0] || null,
        });
      }

      // ── Active Listings (proxy to OpenSea) ──
      case "listings": {
        const s = slug || Object.keys(SLUG_TO_CONTRACT).find(k => SLUG_TO_CONTRACT[k] === contract);
        if (!s) {
          await admission.settle(400);
          return res.status(400).json({ error: "Missing slug" });
        }
        // Validate slug against known slugs to prevent path traversal attacks
        if (!SLUG_TO_CONTRACT[s]) {
          await admission.settle(400);
          return res.status(400).json({ error: "Unknown collection slug" });
        }
        const osKey = process.env.OPENSEA_API_KEY || "";
        const headers = { Accept: "application/json" };
        if (osKey) headers["x-api-key"] = osKey;
        const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
        const osRes = await fetch(
          `https://api.opensea.io/api/v2/listings/collection/${s}/best?limit=${safeLimit}`,
          { headers },
        );
        if (!osRes.ok) throw new Error(`OpenSea ${osRes.status}`);
        // AUDIT R049 H-3: bounded body read.
        const { text, truncated } = await readBoundedText(osRes, MAX_RESPONSE_BYTES);
        if (truncated) throw new Error("upstream-too-large");
        let osData;
        try {
          osData = JSON.parse(text);
        } catch {
          throw new Error("OpenSea returned non-JSON response");
        }
        const listings = (osData.listings || []).map(l => {
          const offer = l.protocol_data?.parameters?.offer?.[0];
          const priceWei = l.price?.current?.value;
          return {
            tokenId: offer?.identifierOrCriteria || null,
            price: priceWei ? Number(BigInt(priceWei) * 10000n / BigInt(1e18)) / 10000 : null,
            maker: l.protocol_data?.parameters?.offerer || null,
            marketplace: "opensea",
            orderHash: l.order_hash || null,
          };
        }).filter(l => l.tokenId && l.price);
        res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
        await admission.settle(200);
        return res.json({ slug: s, listings });
      }

      default:
        await admission.settle(400);
        return res.status(400).json({ error: "Unknown route" });
    }
  } catch (err) {
    console.error("API v1 error:", logSafe(err));
    // Refund before responding: a 500 is our failure, and a customer must never be
    // metered for it.
    await admission.settle(500);
    return res.status(500).json({ error: "Internal error" });
  }
}
