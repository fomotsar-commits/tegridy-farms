// Vercel Serverless Function — proxies frontend → Ponder indexer GraphQL.
//
// Why a proxy and not a direct fetch from the browser:
//   • The indexer URL can stay server-side (operator chooses public vs
//     private) — keeps the host name out of the bundled JS.
//   • Per-IP rate limit + CORS allowlist mirror the other /api/* proxies.
//   • Same fail-closed "503 when unset" behaviour the client handles by
//     falling back to RPC/Etherscan reads.
//
// P0-2 of the 30-day UX push (see PLAN.md).

import { checkRateLimit } from "./_lib/ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./_lib/bodycap.js";
import { logSafe } from "./_lib/logSafe.js";

// Operator sets this in Vercel project env. Empty == client falls back
// to RPC/Etherscan and the proxy answers 503.
const INDEXER_URL = (process.env.INDEXER_URL || "").trim();

const ALLOWED_ORIGINS = [
  "https://tegridyfarms.xyz",
  "https://www.tegridyfarms.xyz",
  "https://tegridyfarms.vercel.app",
  "https://nakamigos.gallery",
  "https://www.nakamigos.gallery",
];
if (process.env.NODE_ENV === "development") {
  ALLOWED_ORIGINS.push("http://localhost:5173", "http://localhost:5191", "http://localhost:3000");
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 60 req/min per IP. Plain GraphQL reads are cheap on Ponder (in-memory
  // SQLite-backed by default), so this is generous; the cap exists mainly
  // to deny pathological clients before they hammer the upstream.
  const allowed = await checkRateLimit(req, res, {
    limit: 60,
    windowSec: 60,
    identifier: "indexer",
  });
  if (!allowed) return;

  if (!INDEXER_URL) {
    // Fail closed: matches the client's `IndexerUnavailableError` path so
    // call-sites flip to their RPC/Etherscan fallback rather than spin.
    return res
      .status(503)
      .json({ error: "Indexer URL not configured" });
  }

  // Vercel parses application/json automatically; tolerate raw bodies just
  // in case (e.g. a future client that POSTs `application/graphql`).
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Body must be JSON" });
    }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Body must be a JSON object" });
  }
  if (typeof body.query !== "string" || body.query.length === 0) {
    return res.status(400).json({ error: "Missing `query` string" });
  }
  // Sanity cap on inbound query size — GraphQL queries don't legitimately
  // exceed a few KB; 64 KB is paranoid-generous and blocks DoS attempts
  // that try to fingerprint upstream behaviour via giant alias spam.
  if (body.query.length > 64 * 1024) {
    return res.status(413).json({ error: "Query too large" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let upstream;
  try {
    upstream = await fetch(INDEXER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: body.query,
        variables: body.variables ?? null,
        operationName:
          typeof body.operationName === "string" ? body.operationName : null,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    logSafe.warn("indexer:upstream-error", {
      reason:
        err && err.name === "AbortError"
          ? "timeout"
          : err && err.message ? err.message : "unknown",
    });
    // Map all upstream failures to a single opaque 502 — callers treat
    // this as "indexer flaky, retry or fall back".
    return res.status(502).json({ error: "Indexer upstream error" });
  }
  clearTimeout(timer);

  // Stream-cap the body so a buggy upstream can't OOM us.
  let raw;
  try {
    raw = await readBoundedText(upstream, MAX_RESPONSE_BYTES);
  } catch (err) {
    logSafe.warn("indexer:read-error", { message: err?.message ?? "unknown" });
    return res.status(502).json({ error: "Indexer upstream read error" });
  }
  if (raw.truncated) {
    return res.status(502).json({ error: "Indexer response too large" });
  }

  // Collapse upstream auth/connectivity failures so we don't leak
  // infrastructure state to the browser (API-M4 pattern from
  // API_INDEXER_AUDIT.md).
  if (upstream.status >= 500 || upstream.status === 401 || upstream.status === 403) {
    logSafe.warn("indexer:upstream-status", { status: upstream.status });
    return res.status(502).json({ error: "Indexer upstream error" });
  }

  res.status(upstream.status);
  res.setHeader("content-type", "application/json; charset=utf-8");
  // Short cache to absorb refetch storms on common queries; React Query's
  // `staleTime` is the primary cache layer so this is mostly belt-and-braces.
  res.setHeader("cache-control", "public, max-age=5, s-maxage=10");
  return res.send(raw.text);
}
