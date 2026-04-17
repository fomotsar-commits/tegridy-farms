// Vercel Serverless Function — proxies Etherscan requests to hide API key
// SECURITY FIX: Previously the Etherscan API key was exposed client-side via VITE_ env var.
// This proxy keeps the key server-side while allowing the frontend to fetch tx history.

import { checkRateLimit } from "./_lib/ratelimit.js";

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || "";
const ETHERSCAN_BASE = "https://api.etherscan.io/api";

// Shared CORS helpers
const ALLOWED_ORIGINS = [
  "https://tegridyfarms.vercel.app",
  "https://www.tegridyfarms.com",
];
if (process.env.NODE_ENV !== "production") {
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
  const params = new URLSearchParams({
    module,
    action,
    apikey: ETHERSCAN_KEY,
  });
  if (address) params.set("address", address);
  if (startblock) params.set("startblock", String(startblock));
  if (endblock) params.set("endblock", String(endblock));
  if (sort && (sort === "asc" || sort === "desc")) params.set("sort", sort);

  try {
    const response = await fetch(`${ETHERSCAN_BASE}?${params}`, {
      headers: { "Accept": "application/json" },
    });
    const data = await response.json();
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: "Etherscan proxy error" });
  }
}
