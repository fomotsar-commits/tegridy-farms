// AUDIT FE-CRIT-01: shared infrastructure for the DEX-aggregator proxies.
//
// Background: every entry under `vercel.json#rewrites` that pointed at a
// third-party host (api.odos.xyz, api.cow.fi, li.quest, …) was an open
// proxy. Anyone could `curl https://tegridyfarms.vercel.app/api/odos/<arbitrary>`
// to:
//   - burn the upstream quota associated with our Vercel IP
//   - send arbitrary POST bodies through our trusted origin (potential
//     credential / CSRF amplification toward the upstream)
//   - have the upstream response served back through our origin (cookies,
//     referer policy, edge-cached for other users)
//
// This module replaces those passive rewrites with serverless wrappers
// that enforce, in order:
//   1. Method allowlist  — only GET + POST (most aggregators use one).
//   2. Origin allowlist  — fail-closed in production, permissive in dev.
//   3. Rate limit        — Upstash sliding window, per-IP, configurable.
//   4. Path allowlist    — regex / exact-prefix per provider, decode-then-
//                          check to defeat URL-encoded traversal.
//   5. Body cap          — 32 KB POST cap; readBoundedText for upstream.
//   6. Query allowlist   — explicit per-call set; no ?key passthrough.
//   7. Response cleanup  — strip Set-Cookie + Authorization-related headers,
//                          collapse upstream errors to opaque 502.
//
// Each provider file exports a default handler that calls runProxy with its
// own config. Tests mock checkRateLimit + globalThis.fetch.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// AUDIT FE-CRIT-01: keep the body cap tight. Quote APIs accept small JSON
// payloads (a few KB). 32 KB leaves comfortable headroom while staying far
// below the body-cap-vs-JSON-bomb threshold the upstream readBoundedText
// caps at on the response side.
export const MAX_REQUEST_BODY_SIZE = 32 * 1024;

// AUDIT FIX F1 (2026-05-25): treat Vercel preview AND production as "prod-like".
// Vercel preview deploys inherit the production env (incl. secrets) but DO NOT
// set NODE_ENV=production, so a bare `NODE_ENV !== "production"` check left the
// origin gate WIDE OPEN on every preview URL — anyone could curl the preview
// origin to burn the upstream aggregator quota or amplify arbitrary POSTs
// through our trusted origin. Mirrors the prod-like gate in
// supabase-proxy.js:172-174 and auth/me.js.
function isProdLikeEnv() {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "preview" ||
    process.env.VERCEL_ENV === "production"
  );
}

// Origin allowlist mirroring alchemy.js / opensea.js / orderbook.js. Kept
// in one place so security policy doesn't drift between proxies.
function buildAllowedOrigins() {
  const set = new Set([
    "https://nakamigos.gallery",
    "https://www.nakamigos.gallery",
    "https://memetic.fun",
    "https://www.memetic.fun",
    "https://memetics.finance",
    "https://www.memetics.finance",
    "https://tegridyfarms.vercel.app",
  ]);
  if (process.env.ALLOWED_ORIGIN) set.add(process.env.ALLOWED_ORIGIN);
  // Only widen to localhost in genuine dev — never on a prod-like (preview /
  // production) deploy, where an attacker-supplied `Origin: http://localhost`
  // header would otherwise pass the gate.
  if (!isProdLikeEnv()) {
    set.add("http://localhost:8742");
    set.add("http://localhost:3000");
    set.add("http://localhost:5173");
  }
  return set;
}

// AUDIT FE-CRIT-01: fail-closed origin gate. In production, an empty Origin
// (which can happen on direct curl) is treated as a non-allowed origin and
// rejected with 403 — the proxies are only meant for browser-originated
// fetches from our app.
// AUDIT FIX FRESH-2026: F-FRESH-5 — DELETE the `*.vercel.app` preview-regex
//         branch. Pre-fix any vercel.app origin (e.g. `attacker.vercel.app`
//         deployed by anyone) passed the gate in preview-env, letting any
//         tenant abuse the aggregator quota. Pattern of record: Vercel's
//         own next-cors / AWS API Gateway CORS / Cloudflare CORS all use
//         explicit allowlists, NOT regex wildcards. Preview deploys must
//         add their origin via the `ALLOWED_ORIGINS` env var (already
//         supported by `buildAllowedOrigins`).
function isOriginAllowed(origin) {
  const allowed = buildAllowedOrigins();
  // AUDIT FIX F1: fail-closed on prod-like (production + Vercel preview), not
  // just NODE_ENV==="production". See isProdLikeEnv() above.
  if (!isProdLikeEnv()) return true;
  return allowed.has(origin);
}

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  const allowed = buildAllowedOrigins();
  const fallback = process.env.ALLOWED_ORIGIN || "https://tegridyfarms.vercel.app";
  res.setHeader("Access-Control-Allow-Origin", allowed.has(origin) ? origin : fallback);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

// Decode-then-check path guard mirroring opensea.js#isAllowedPath. URL
// encoding is rejected outright so an attacker can't smuggle traversal via
// %2F..%2F or similar.
function isPathSafe(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  let decoded;
  try { decoded = decodeURIComponent(p); } catch { return false; }
  if (decoded !== p) return false;
  if (decoded.includes("..")) return false;
  if (decoded.includes("//")) return false;
  // Reject leading slash — Vercel catch-all delivers the path without one.
  if (decoded.startsWith("/")) return false;
  return true;
}

function pickQueryParams(query, allowedKeys, _pathSegments) {
  const out = new URLSearchParams();
  for (const k of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(query, k)) {
      const v = query[k];
      if (v == null) continue;
      // URLSearchParams accepts repeated values — preserve them only when
      // explicit (each entry validated individually).
      if (Array.isArray(v)) {
        for (const e of v) if (e !== undefined && e !== null) out.append(k, String(e));
      } else {
        out.set(k, String(v));
      }
    }
  }
  return out;
}

/**
 * Read incoming POST body with a hard cap so a misbehaving caller cannot
 * stream gigabytes through the lambda. Returns the parsed JSON or throws.
 *
 * Vercel's default body parser already populates req.body for JSON, so we
 * stringify-and-measure that. If it exceeds the cap, return null so the
 * caller can 413.
 */
function getBodyOrTooLarge(req) {
  if (req.method !== "POST") return { body: undefined, tooLarge: false };
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  if (raw.length > MAX_REQUEST_BODY_SIZE) return { body: undefined, tooLarge: true };
  let parsed = req.body;
  if (typeof req.body === "string") {
    try { parsed = JSON.parse(req.body); } catch { return { body: undefined, tooLarge: false, parseError: true }; }
  }
  return { body: parsed, tooLarge: false };
}

/**
 * Build the upstream URL from a Vercel `[...path].js` query.
 *
 * Vercel binds the catch-all to `query.path`, which arrives as either a
 * single string or an array of segments. We rebuild the path as a `/`-joined
 * string AFTER per-segment safety checks; nothing from `req.url` ever reaches
 * the upstream.
 */
function extractCatchAllPath(query) {
  const raw = query?.path;
  if (raw == null) return "";
  if (Array.isArray(raw)) return raw.join("/");
  return String(raw);
}

/**
 * Run a hardened proxy request.
 *
 * @param {object} cfg
 * @param {string} cfg.identifier         — rate-limit bucket identifier.
 * @param {string} cfg.upstreamBase       — e.g. "https://api.odos.xyz".
 * @param {(string[]) => boolean} cfg.matchPath — receives the path segments,
 *   returns true if the path is on the allowlist.
 * @param {Set<string>} cfg.allowedMethods — typically new Set(["GET","POST"]).
 * @param {string[]} cfg.allowedQuery     — query keys to forward upstream.
 * @param {object} [cfg.extraHeaders]     — extra request headers (e.g. kyber X-Client-Id).
 * @param {number} [cfg.rateLimit=60]     — req/window limit.
 * @param {number} [cfg.rateWindowSec=60] — window size.
 * @param {string} [cfg.cacheControl]     — Cache-Control to set on success
 *   (defaults to private, no-store).
 */
export async function runProxy(req, res, cfg) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Method allowlist
  const methods = cfg.allowedMethods || new Set(["GET", "POST"]);
  if (!methods.has(req.method)) {
    res.setHeader("Allow", [...methods].join(", "));
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Origin allowlist (fail-closed in production).
  // AUDIT FIX 2026-07-10: same-origin browser GET/HEAD requests carry NO Origin
  // header (browsers only send Origin for cross-origin requests and for all
  // non-GET methods), so a fail-closed empty-Origin gate 403'd every legitimate
  // same-origin quote fetch on production (dev is permissive, which hid this).
  // Allow a missing Origin ONLY for safe methods; state-changing methods (POST)
  // still require an allowlisted Origin — which browsers always send — so
  // cross-origin POST abuse through our trusted origin stays blocked.
  const origin = req.headers?.origin || "";
  const safeMethod = req.method === "GET" || req.method === "HEAD";
  if (!(safeMethod && !origin) && !isOriginAllowed(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // Rate limit (Upstash). Fails closed in production via _lib/ratelimit.js.
  const allowed = await checkRateLimit(req, res, {
    limit: cfg.rateLimit ?? 60,
    windowSec: cfg.rateWindowSec ?? 60,
    identifier: cfg.identifier,
  });
  if (!allowed) return;

  // AUDIT 2026-07-25: global circuit-breaker. Per-IP limits don't stop a
  // distributed flood from draining a provider's quota or poisoning our
  // shared-IP reputation with it. Cap TOTAL traffic per provider (cfg.identifier
  // keys its own bucket) and shed with 503 past the aggregate ceiling. Override
  // per provider via cfg.globalLimit, or fleet-wide via AGGREGATOR_GLOBAL_RPM.
  const underGlobalCap = await checkGlobalLimit(res, {
    limit: cfg.globalLimit ?? (Number(process.env.AGGREGATOR_GLOBAL_RPM) || 600),
    windowSec: cfg.rateWindowSec ?? 60,
    identifier: cfg.identifier,
  });
  if (!underGlobalCap) return;

  // Path allowlist
  const rawPath = extractCatchAllPath(req.query);
  if (!isPathSafe(rawPath)) {
    return res.status(404).json({ error: "Not found" });
  }
  const segments = rawPath.split("/").filter(Boolean);
  if (segments.length === 0 || !cfg.matchPath(segments)) {
    return res.status(404).json({ error: "Not found" });
  }

  // Body cap (POST only)
  const { body: reqBody, tooLarge, parseError } = getBodyOrTooLarge(req);
  if (tooLarge) {
    return res.status(413).json({ error: "Request body too large" });
  }
  if (parseError) {
    return res.status(400).json({ error: "Malformed JSON body" });
  }

  // Build upstream URL — rebuild from validated parts only. Never reflect
  // req.url's query verbatim.
  const upstream = new URL(`${cfg.upstreamBase}/${segments.join("/")}`);
  const allowedParams = pickQueryParams(req.query || {}, cfg.allowedQuery || [], segments);
  for (const [k, v] of allowedParams.entries()) upstream.searchParams.append(k, v);

  // Build outbound headers — Authorization / Cookie / Set-Cookie are NOT
  // proxied. Only a small set of upstream-required headers passes through.
  const outHeaders = { Accept: "application/json", ...(cfg.extraHeaders || {}) };
  if (req.method === "POST") {
    outHeaders["Content-Type"] = "application/json";
  }

  let upstreamRes;
  try {
    const fetchOpts = { method: req.method, headers: outHeaders };
    if (req.method === "POST") {
      fetchOpts.body = JSON.stringify(reqBody ?? {});
    }
    upstreamRes = await fetch(upstream.toString(), fetchOpts);
  } catch (err) {
    console.error(`[${cfg.identifier}] proxy fetch error:`, logSafe(err));
    return res.status(502).json({ error: "Upstream service error" });
  }

  // Bounded read protects against gzip bombs / OOM.
  let bodyText;
  try {
    const { text, truncated } = await readBoundedText(upstreamRes, MAX_RESPONSE_BYTES);
    if (truncated) {
      console.error(`[${cfg.identifier}] upstream over-cap`);
      return res.status(502).json({ error: "Upstream response too large" });
    }
    bodyText = text;
  } catch (err) {
    console.error(`[${cfg.identifier}] read error:`, logSafe(err));
    return res.status(502).json({ error: "Upstream service error" });
  }

  // AUDIT FIX 2026-05-26 [H-22] — force JSON response Content-Type + nosniff.
  // Pre-fix the proxy reflected the upstream Content-Type verbatim, so a
  // compromised aggregator returning `text/html` would be rendered as HTML by
  // any browser that hit the proxy URL directly (XSS pivot via our trusted
  // origin). All seven aggregator providers contract JSON responses; force
  // application/json + X-Content-Type-Options: nosniff so the browser cannot
  // be tricked into HTML interpretation regardless of upstream behavior.
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // AUDIT FE-CRIT-01: explicitly DO NOT forward Set-Cookie or Authorization
  // headers. Default cache header is private, no-store unless caller overrides.
  res.setHeader("Cache-Control", cfg.cacheControl || "private, no-store");

  if (!upstreamRes.ok) {
    // Log real upstream status server-side; surface a generic 502 to clients.
    console.error(`[${cfg.identifier}] upstream HTTP ${upstreamRes.status}:`, logSafe(bodyText.slice(0, 500)));
    return res.status(502).json({ error: "Upstream service error" });
  }

  return res.status(200).send(bodyText);
}

// Exported for unit testing.
export const __test__ = {
  isPathSafe,
  isOriginAllowed,
  buildAllowedOrigins,
  pickQueryParams,
  extractCatchAllPath,
};
