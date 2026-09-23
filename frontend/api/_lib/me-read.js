// me-read: the ONE Magic Eden read this venue makes, for Junglets (Solana, not
// on OpenSea). Magic Eden sends no CORS header for this site, so it is read
// here: two fixed paths for one symbol, three fixed listing pages (208
// Junglets exist). A 200 is edge-cached; 404 and 429 are forwarded; anything
// else is a 502. The client reader (lib/externalMarket.js) validates the JSON.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed, isOriginListed, isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// A module constant, so the host can never come from the request.
const ME_BASE = "https://api-mainnet.magiceden.dev/v2";

const STATS_PATH = "/collections/junglet/stats";
const LISTINGS_PATH = "/collections/junglet/listings";
const LISTING_PAGE_SIZE = "100";
const LISTING_OFFSETS = new Set(["0", "100", "200"]);

const CACHE_SECONDS = 120;
const UPSTREAM_TIMEOUT_MS = 8000;

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (origin && isOriginAllowed(origin) && isOriginListed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** The upstream path and query for an admitted request, or null. */
function admittedRead(query) {
  const { path, ...rest } = query || {};
  delete rest.resource; // the aggregator's own dispatch key
  const keys = Object.keys(rest);
  if (path === STATS_PATH) {
    return keys.length === 0 ? { path, search: "" } : null;
  }
  if (path === LISTINGS_PATH) {
    if (keys.length !== 2 || rest.limit !== LISTING_PAGE_SIZE || !LISTING_OFFSETS.has(rest.offset)) return null;
    return { path, search: `?limit=${LISTING_PAGE_SIZE}&offset=${rest.offset}` };
  }
  return null;
}

export async function handleMeRead(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Enforced here: this branch is dispatched before runProxy and inherits no
  // gate. A present Origin must be on the allowlist in every environment.
  const origin = req.headers?.origin || "";
  if (!isRequestOriginAllowed(req) || (origin && !isOriginListed(origin))) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const read = admittedRead(req.query);
  if (!read) return res.status(400).json({ error: "Unsupported read" });

  const allowed = await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "me-read" });
  if (!allowed) return;

  // The fleet ceiling against a keyless per-IP upstream: the edge cache means
  // this only counts misses, of which there are four distinct URLs.
  const underCap = await checkGlobalLimit(res, { limit: 60, windowSec: 60, identifier: "me-read" });
  if (!underCap) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${ME_BASE}${read.path}${read.search}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      if (upstream.status === 429) {
        const retryAfter = upstream.headers?.get?.("retry-after");
        if (retryAfter && /^\d{1,5}$/.test(retryAfter)) res.setHeader("Retry-After", retryAfter);
      }
      const status = upstream.status === 404 || upstream.status === 429 ? upstream.status : 502;
      res.setHeader("Cache-Control", "no-store");
      return res.status(status).json({ error: `Upstream HTTP ${upstream.status}` });
    }

    const { text, truncated } = await readBoundedText(upstream, MAX_RESPONSE_BYTES);
    if (truncated) return res.status(502).json({ error: "Upstream response too large" });

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Upstream response was not JSON" });
    }

    res.setHeader("Cache-Control", `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 5}`);
    return res.status(200).json(json);
  } catch (err) {
    console.error("me-read error:", logSafe(err));
    return res.status(502).json({ error: "Failed to read upstream" });
  } finally {
    clearTimeout(timer);
  }
}
