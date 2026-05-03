// Vercel Serverless Function — proxies OpenSea requests to hide API key
import { checkRateLimit } from "./_lib/ratelimit.js";

const OPENSEA_KEY = process.env.OPENSEA_API_KEY || "";
if (!process.env.OPENSEA_API_KEY) {
  console.warn("WARNING: OPENSEA_API_KEY is not set — requests will be unauthenticated");
}

// ── Shared validation helpers ──
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_BODY_SIZE = 10 * 1024; // 10 KB
// AUDIT R053: cap price values at 1M ETH (10^24 wei). Anything above is most
// likely a parser/schema mismatch upstream and would let attackers float a
// 1M-ETH "listing" past consumer-side BigInt() to poison floor sorts.
const MAX_OPENSEA_PRICE_WEI = 10n ** 24n;
const PRICE_REGEX = /^[0-9]+$/;
// AUDIT R053: URL schemes that browsers will safely render in <img>/<iframe>.
// Anything outside this set (javascript:, data:text/html, vbscript:, file:,
// gopher:, etc.) is nulled out so the consumer never accidentally embeds an
// XSS or tracking-pixel in their UI. Note: data:image/svg+xml is EXCLUDED
// because SVG can carry inline <script> that fires in HTML rendering modes.
function isAllowedUrlScheme(url) {
  if (typeof url !== "string" || url.length === 0) return false;
  const trimmed = url.trim();
  if (trimmed.startsWith("ipfs://") || trimmed.startsWith("ar://")) return true;
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) return true;
  // Allow ONLY raster image data: URIs (png, jpeg, gif, webp). svg+xml rejected.
  if (trimmed.startsWith("data:image/")) {
    const mime = trimmed.slice(5, trimmed.indexOf(";") > 0 ? trimmed.indexOf(";") : trimmed.indexOf(","));
    if (/^image\/(png|jpeg|jpg|gif|webp|avif)$/i.test(mime)) return true;
  }
  return false;
}
const URL_FIELD_NAMES = new Set([
  "image_url", "animation_url", "external_url", "background_image_url",
  "banner_image_url", "logo_image_url", "thumbnail_url", "preview_image_url",
]);

// AUDIT R053: schema-validate a single price object. Throws on shape mismatch
// so the handler can collapse to 502. Returns the (possibly-nulled) value.
function validatePriceShape(price) {
  if (price == null) return; // optional
  if (typeof price !== "object") throw new Error("unexpected shape: price");
  const cur = price.current;
  if (cur == null) return;
  if (typeof cur !== "object") throw new Error("unexpected shape: price.current");
  if ("value" in cur && cur.value !== null) {
    if (typeof cur.value !== "string") throw new Error("unexpected shape: price.current.value not string");
    if (!PRICE_REGEX.test(cur.value)) throw new Error("unexpected shape: price.current.value not numeric");
    // Cap absurd values (likely upstream parsing artefact) — null instead of throw
    // so the rest of the response still flows.
    try {
      if (BigInt(cur.value) > MAX_OPENSEA_PRICE_WEI) cur.value = null;
    } catch {
      cur.value = null;
    }
  }
}

// AUDIT R053: walk the response object, sanitizing URL fields and validating
// price shapes. Mutates in place. Throws on schema violation.
function sanitizeOpenseaResponse(obj) {
  if (obj == null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) sanitizeOpenseaResponse(item);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (URL_FIELD_NAMES.has(k) && typeof v === "string") {
      if (!isAllowedUrlScheme(v)) obj[k] = null;
    } else if (k === "price") {
      validatePriceShape(v);
    } else if (v && typeof v === "object") {
      sanitizeOpenseaResponse(v);
    }
  }
}

// AUDIT R053: pick a Cache-Control header based on the endpoint shape.
//   - POST mutations / per-user (maker= query) → private, no-store
//   - collection stats → s-maxage=60
//   - everything else (listings, offers) → s-maxage=15 (existing default)
function selectCacheControl({ method, path, params }) {
  if (method === "POST") return "private, no-store";
  if (params && params.maker) return "private, no-store";
  if (typeof path === "string" && /^collection\/[^/]+\/stats$/.test(path)) {
    return "public, s-maxage=60, stale-while-revalidate=120";
  }
  return "s-maxage=15, stale-while-revalidate=30";
}

function isValidAddress(addr) { return typeof addr === "string" && ETH_ADDRESS_RE.test(addr); }

// AUDIT API-M1: real rate limiting now lives in _lib/ratelimit.js.

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
  // AUDIT API-M5: decode-then-check. The prior guard relied on spotting
  // "%2e" / "%2E" in the raw input, but missed single-encoded segments like
  // "%2F..%2Fadmin" that OpenSea's router could decode server-side.
  // Reject if the decoded path differs (any URL-encoding is now suspect) or
  // if decoded content contains traversal / doubled-slashes.
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return false; }
  if (decoded !== path) return false;
  if (decoded.includes("..") || decoded.includes("//")) return false;
  // (removed superseded %2e/%2E guard — the decoded-equality check above
  //  catches every encoding of every character)
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
    "https://tegridyfarms.xyz",
    "https://www.tegridyfarms.xyz",
    "https://nakamigos.gallery",
    "https://www.nakamigos.gallery",
    "https://tegridyfarms.vercel.app",
  ]);
  // AUDIT API-SEC: fail-closed — only admit localhost when NODE_ENV === "development".
  if (process.env.NODE_ENV === "development") {
    ALLOWED_ORIGINS.add("http://localhost:8742");
    ALLOWED_ORIGINS.add("http://localhost:3000");
    ALLOWED_ORIGINS.add("http://localhost:5173");
  }
  const isAllowed = ALLOWED_ORIGINS.has(origin);

  res.setHeader("Access-Control-Allow-Origin", isAllowed ? origin : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(200).end();

  // AUDIT API-M1: 30 req/min per IP. Lower than Alchemy because OpenSea has
  // tighter paid-tier quotas and we want to reserve headroom for buy/sell
  // flows that burst several requests at checkout time.
  const allowed = await checkRateLimit(req, res, {
    limit: 30, windowSec: 60, identifier: "opensea",
  });
  if (!allowed) return;

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
      // AUDIT API-M4: collapse upstream errors to opaque 502, log real status.
      console.error("OpenSea upstream error:", response.status, text.slice(0, 500));
      return res.status(502).json({ error: "Upstream service error" });
    }

    // AUDIT R053: validate + sanitize before returning. Schema mismatch (price
    // value not a digit string, etc.) collapses to 502 so the consumer cannot
    // BigInt() something unexpected. URL fields with disallowed schemes (e.g.
    // `javascript:`, `data:text/html`) are nulled so consumer UIs cannot
    // accidentally embed an XSS vector or tracking pixel.
    try {
      sanitizeOpenseaResponse(data);
    } catch (err) {
      console.error("OpenSea schema mismatch:", err.message);
      return res.status(502).json({ error: "Upstream returned data of unexpected shape" });
    }

    // AUDIT R053: cache-control varies by endpoint and per-user binding.
    res.setHeader("Cache-Control", selectCacheControl({
      method: req.method,
      path,
      params,
    }));
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Proxy fetch failed" });
  }
}
