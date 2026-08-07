// Vercel Serverless Function — proxies Etherscan requests to hide API key
// SECURITY FIX: Previously the Etherscan API key was exposed client-side via VITE_ env var.
// This proxy keeps the key server-side while allowing the frontend to fetch tx history.

import { checkRateLimit, checkGlobalLimit } from "./_lib/ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./_lib/bodycap.js";
import { logSafe } from "./_lib/logSafe.js";

// AUDIT R048: switched from v1 (`?apikey=...` querystring) to v2 multichain
// (Authorization: Bearer header) when a real key is set. v2 returns the same
// `{ status, message, result }` shape as v1, so callers don't change. Falls
// back to v1 querystring auth only when no key is configured (legacy dev).
// FIX 2026-07-19: v2 does NOT accept `Authorization: Bearer <key>` — it returns
// {"status":"0","message":"NOTOK","result":"Missing/Invalid API Key"}. Verified
// live against a valid key: Bearer is rejected, `?apikey=<key>` succeeds. The
// key goes in the QUERYSTRING for both v1 and v2; v2 additionally needs chainid.
// (The old Bearer path meant a correctly-configured key still failed, and with
// no key at all we fell through to v1 — which Etherscan has since deprecated —
// so this endpoint returned NOTOK either way.)
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || "";
const USE_V2 = !!ETHERSCAN_KEY;
const ETHERSCAN_BASE = USE_V2
  ? "https://api.etherscan.io/v2/api"
  : "https://api.etherscan.io/api";

function authHeaders(extra = {}) {
  // Auth travels in the querystring, never a header — see the note above.
  return { Accept: "application/json", ...extra };
}

// Shared CORS helpers
// AUDIT FIX FRESH-2026: F8 — drop `www.tegridyfarms.com`. The team owns
//         tegridyfarms.vercel.app; tegridyfarms.com appeared in this allowlist only
//         (every other API proxy uses .xyz). If unowned, an attacker could
//         register the domain and burn the team's Etherscan API quota via
//         credentialed CORS. If owned, the asymmetry is drift the rest of the
//         credentialed surface rejects. Removing aligns all proxies on one
//         origin set.
// AUDIT FIX FRESH-2026: F11 — align this origin set with alchemy.js,
//         opensea.js, orderbook.js, supabase-proxy.js. The Nakamigos UI uses
//         /api/etherscan for tx history rendering (HistoryPage.tsx), and it is
//         served from the production origins below, not a separate domain.
// 2026-08-02: the `nakamigos.gallery` entry this note originally added was
//         removed — the project does not control that domain. See auth/siwe.js.
//         Do NOT re-add it.
const ALLOWED_ORIGINS = [
  "https://memetic.fun",
  "https://www.memetic.fun",
  "https://memetics.finance",
  "https://www.memetics.finance",
  "https://tegridyfarms.vercel.app",
];
// AUDIT API-SEC: fail-closed — only admit localhost when NODE_ENV === "development".
if (process.env.NODE_ENV === "development") {
  ALLOWED_ORIGINS.push("http://localhost:5173", "http://localhost:3000");
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Whitelist allowed Etherscan modules and actions
const ALLOWED_ACTIONS = new Set([
  "txlist",
  "txlistinternal",
  "tokentx",
  "tokennfttx",
  "getabi",
  "getsourcecode",
]);

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// COST AMPLIFIER FIX 2026-08-06: `page` / `offset` were accepted from the caller
// and then silently DROPPED — never forwarded to Etherscan. Measured on prod, a
// request carrying `offset=5` came back with 99 rows / 918,663 bytes, and busier
// addresses reach 4.4 MB. Past MAX_RESPONSE_BYTES `readBoundedText` reports
// `truncated` and this endpoint 502s — permanently for that address, on every
// retry, which is what was breaking /deployer. So a dropped pagination param is
// an anonymous, unauthenticated lever that burns the shared Etherscan quota AND
// bricks a page.
//
// Etherscan's own ceiling is 10,000 rows/page; 500 is the largest page any
// surface here actually asks for (HistoryPage.tsx sends offset=500) and keeps a
// single response comfortably under the body cap.
const MAX_OFFSET = 500;
// Digit-string only. Deliberately NOT Number(): Number("") === 0, Number(" ") === 0
// and Number("1e5") === 100000, so a bare numeric coercion re-opens the same hole
// from the other side.
const PAGINATION_RE = /^\d{1,7}$/;

/**
 * Parse one pagination param. Returns the integer, `null` when absent, or
 * `undefined` when present-but-unreadable.
 *
 * Fail CLOSED on unreadable: the defect being fixed is precisely that an
 * un-forwardable value became an UNBOUNDED upstream request instead of an
 * error, so "ignore it and carry on" is the one behavior not available here.
 */
function parsePageParam(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return undefined;
  if (!PAGINATION_RE.test(s)) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(200).end();

  // AUDIT API-M1: 30 req/min per IP. Etherscan's free tier is 5 req/sec
  // (= 300/min) shared across all callers; throttling to 30/IP/min leaves
  // headroom for ~10 concurrent users before we hit the upstream ceiling.
  const allowed = await checkRateLimit(req, res, {
    limit: 30, windowSec: 60, identifier: "etherscan",
  });
  if (!allowed) return;

  // COST AMPLIFIER FIX 2026-08-06: global circuit-breaker. The per-IP cap above
  // stops ONE abusive source; it does nothing about N sources each staying under
  // 30/min, which is the shape a quota-burn actually takes. Etherscan's free tier
  // is ~300 req/min TOTAL and it is shared by every caller of this deployment, so
  // the aggregate ceiling is the one that matters. Same pattern as api/alchemy.js
  // and _lib/aggregator-proxy.js. Raise ETHERSCAN_GLOBAL_RPM (env, no redeploy)
  // if organic traffic ever reaches it.
  const underGlobalCap = await checkGlobalLimit(res, {
    limit: Number(process.env.ETHERSCAN_GLOBAL_RPM) || 300,
    windowSec: 60,
    identifier: "etherscan",
  });
  if (!underGlobalCap) return;

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { module, action, address, startblock, endblock, sort, page, offset } = req.query;

  // Validate required params
  if (!module || !action) {
    return res.status(400).json({ error: "Missing module or action" });
  }

  // Only allow account module with whitelisted actions
  if (module !== "account" && module !== "contract") {
    return res.status(400).json({ error: "Module not allowed" });
  }

  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: "Action not allowed" });
  }

  // Validate address if provided
  if (address && !ETH_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }

  // AUDIT API-M6: cap block range at 10k to avoid burning our Etherscan
  // quota on full-chain scans. A client asking for 100k+ blocks is either
  // a bug or abuse; legitimate indexers use paginated requests.
  if (startblock != null && endblock != null) {
    const s = Number(startblock), e = Number(endblock);
    if (Number.isFinite(s) && Number.isFinite(e) && e - s > 10_000) {
      return res.status(400).json({ error: "Block range too large (max 10000)" });
    }
  }

  // COST AMPLIFIER FIX 2026-08-06: validate, clamp, and actually FORWARD the
  // pagination the caller asked for. `undefined` = present but unreadable → 400,
  // never a silent drop (a silent drop is what turned a bounded request into an
  // unbounded one). An offset over the ceiling is CLAMPED rather than rejected —
  // the caller asked for "as much as you'll give me", and the ceiling is the
  // answer; only a value we cannot read at all is an error.
  const pageNum = parsePageParam(page);
  const offsetNum = parsePageParam(offset);
  if (pageNum === undefined || offsetNum === undefined) {
    return res.status(400).json({ error: "Invalid page or offset (positive integers only)" });
  }

  // Build Etherscan URL with server-side API key
  const params = new URLSearchParams({ module, action });
  // AUDIT R048 + FIX 2026-07-19: v2 requires chainid, and BOTH versions take the
  // key as an `apikey` querystring param. Previously v2 set chainid but sent the
  // key as a Bearer header, which v2 rejects outright.
  if (USE_V2) params.set("chainid", "1");
  if (ETHERSCAN_KEY) params.set("apikey", ETHERSCAN_KEY);
  if (address) params.set("address", address);
  if (startblock) params.set("startblock", String(startblock));
  if (endblock) params.set("endblock", String(endblock));
  if (sort && (sort === "asc" || sort === "desc")) params.set("sort", sort);
  // Etherscan pages from 1 when `offset` is supplied without `page`; pin it so a
  // half-specified request is deterministic rather than upstream-defined.
  if (offsetNum !== null) {
    params.set("page", String(pageNum ?? 1));
    params.set("offset", String(Math.min(offsetNum, MAX_OFFSET)));
  } else if (pageNum !== null) {
    params.set("page", String(pageNum));
  }

  try {
    const response = await fetch(`${ETHERSCAN_BASE}?${params}`, {
      headers: authHeaders(),
    });
    // AUDIT R049 H-3: bounded body read.
    const { text, truncated } = await readBoundedText(response, MAX_RESPONSE_BYTES);
    if (truncated) {
      return res.status(502).json({ error: "Upstream response too large" });
    }
    let data;
    try { data = JSON.parse(text); } catch {
      console.error("Etherscan non-JSON:", logSafe(text.slice(0, 200)));
      return res.status(502).json({ error: "Upstream returned invalid response" });
    }
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(data);
  } catch (err) {
    console.error("Etherscan proxy error:", logSafe(err));
    return res.status(502).json({ error: "Etherscan proxy error" });
  }
}
