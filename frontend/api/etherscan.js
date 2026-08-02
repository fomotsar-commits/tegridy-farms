// Vercel Serverless Function — proxies Etherscan requests to hide API key
// SECURITY FIX: Previously the Etherscan API key was exposed client-side via VITE_ env var.
// This proxy keeps the key server-side while allowing the frontend to fetch tx history.

import { checkRateLimit } from "./_lib/ratelimit.js";
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
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { module, action, address, startblock, endblock, sort } = req.query;

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
