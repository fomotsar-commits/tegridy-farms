// Vercel Serverless Function — proxies OpenSea requests to hide API key
const OPENSEA_KEY = process.env.OPENSEA_API_KEY || "";
if (!process.env.OPENSEA_API_KEY) {
  console.warn("WARNING: OPENSEA_API_KEY is not set — requests will be unauthenticated");
}

// ── Shared validation helpers ──
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_BODY_SIZE = 10 * 1024; // 10 KB

function isValidAddress(addr) { return typeof addr === "string" && ETH_ADDRESS_RE.test(addr); }

function setRateLimitHeaders(res, { limit = 60, remaining = 59, reset = 60 } = {}) {
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + reset));
}

// Whitelist allowed OpenSea collection slugs (must match openseaSlug values in constants.js)
const ALLOWED_SLUGS = new Set(["nakamigos", "gnssart", "junglebay"]);

// Whitelist allowed contract addresses (lowercase) — enforced on POST bodies
const ALLOWED_CONTRACTS = new Set([
  "0xd774557b647330c91bf44cfeab205095f7e6c367", // Nakamigos
  "0xa1de9f93c56c290c48849b1393b09eb616d55dbb", // GNSS Art
  "0xd37264c71e9af940e49795f0d3a8336afaafdda9", // Jungle Bay
]);

// Whitelist of allowed path prefixes — reject anything that doesn't start with one of these
const ALLOWED_PATH_PREFIXES = ["orders/", "listings/", "offers/", "collection/", "events/"];

// Build allowed paths dynamically from allowed slugs
function isAllowedPath(path) {
  // Exact-match paths that don't follow the prefix pattern
  if (path === "criteria_offers") return true;
  // Reject paths that don't start with an allowed prefix
  if (!ALLOWED_PATH_PREFIXES.some((p) => path.startsWith(p))) return false;
  // Always allow fulfillment endpoints (buy + accept)
  if (path === "listings/fulfillment_data" || path === "offers/fulfillment_data") return true;
  // Allow order endpoints (create listings, fetch offers/bids)
  if (path === "orders/ethereum/seaport/offers" || path === "orders/ethereum/seaport/listings") return true;
  // Allow offer building
  if (path === "offers/build") return true;
  // Check collection-specific paths
  for (const slug of ALLOWED_SLUGS) {
    if (path === `listings/collection/${slug}/best`) return true;
    if (path === `collection/${slug}/stats`) return true;
    if (path === `events/collection/${slug}`) return true;
    if (path === `offers/collection/${slug}`) return true;
    if (path.startsWith(`offers/collection/${slug}/`)) return true;
  }
  return false;
}

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://nakamigos.gallery";

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const ALLOWED_ORIGINS = new Set([
    "https://nakamigos.gallery",
    "https://www.nakamigos.gallery",
  ]);
  // Only allow localhost origins in non-production environments
  if (process.env.NODE_ENV !== "production") {
    ALLOWED_ORIGINS.add("http://localhost:8742");
    ALLOWED_ORIGINS.add("http://localhost:3000");
    ALLOWED_ORIGINS.add("http://localhost:5173");
  }
  const isAllowed = ALLOWED_ORIGINS.has(origin);

  res.setHeader("Access-Control-Allow-Origin", isAllowed ? origin : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  setRateLimitHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Body size guard (POST only)
  if (req.method === "POST") {
    const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    if (bodyStr.length > MAX_BODY_SIZE) {
      return res.status(413).json({ error: "Request body too large (max 10KB)" });
    }
  }

  const { path, ...params } = req.query;

  if (!path || !isAllowedPath(path)) {
    return res.status(400).json({ error: "Invalid or missing path" });
  }

  // Validate contract addresses in POST bodies to prevent open-proxy abuse
  if (req.method === "POST" && req.body && typeof req.body === "object") {
    const seaportParams = req.body.parameters || req.body.protocol_data?.parameters;
    if (seaportParams) {
      const items = [
        ...(seaportParams.offer || []),
        ...(seaportParams.consideration || []),
      ];
      for (const item of items) {
        // itemType 2 = ERC721, 3 = ERC1155 — these carry the NFT contract
        if (item?.itemType >= 2 && item?.token) {
          if (!isValidAddress(item.token)) {
            return res.status(400).json({ error: "Invalid contract address format" });
          }
          const addr = item.token.toLowerCase();
          if (!ALLOWED_CONTRACTS.has(addr)) {
            return res.status(403).json({ error: "Contract not supported" });
          }
        }
      }
    }
  }

  // Validate query params that carry contract addresses or token IDs
  if (params.asset_contract_address) {
    if (!isValidAddress(params.asset_contract_address)) {
      return res.status(400).json({ error: "Invalid contract address format" });
    }
    if (!ALLOWED_CONTRACTS.has(params.asset_contract_address.toLowerCase())) {
      return res.status(403).json({ error: "Contract not supported" });
    }
  }
  if (params.token_ids && !/^\d{1,10}$/.test(params.token_ids)) {
    return res.status(400).json({ error: "Invalid token_ids — must be numeric (max 10 digits)" });
  }
  // Clamp limit/offset query params
  if (params.limit) {
    params.limit = String(Math.min(Math.max(1, parseInt(params.limit, 10) || 20), 200));
  }
  if (params.offset) {
    params.offset = String(Math.min(Math.max(0, parseInt(params.offset, 10) || 0), 10000));
  }

  try {
    const url = new URL(`https://api.opensea.io/api/v2/${path}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "" && k !== "path") url.searchParams.set(k, String(v));
    });

    const headers = { Accept: "application/json" };
    if (OPENSEA_KEY) headers["x-api-key"] = OPENSEA_KEY;

    let fetchOpts = { headers };
    if (req.method === "POST") {
      fetchOpts.method = "POST";
      fetchOpts.headers["Content-Type"] = "application/json";
      // Guard against undefined/null body — send empty object instead of "undefined"
      fetchOpts.body = JSON.stringify(req.body ?? {});
    }

    const response = await fetch(url.toString(), fetchOpts);

    // Safe JSON parse — upstream may return HTML error pages
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("OpenSea non-JSON response:", text.slice(0, 200));
      return res.status(502).json({ error: "Upstream returned invalid response" });
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: "OpenSea API error", status: response.status });
    }

    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Proxy fetch failed" });
  }
}
