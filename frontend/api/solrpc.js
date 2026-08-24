// Vercel Serverless Function — same-origin Solana JSON-RPC proxy.
//
// The Solana swap surface (Surface A) sends/confirms transactions and reads
// balances against an RPC. We do NOT let the browser hit the RPC directly: a
// production RPC (Helius/QuickNode/Triton) embeds an API key in the URL, and a
// VITE_* client var would inline that key into the public bundle (the repo's
// own [H-35] lesson). Instead the browser talks to THIS same-origin proxy and
// the keyed URL stays server-side in `SOLANA_RPC_URL`. With no key set it falls
// back to the public (rate-limited) endpoint.
//
// Hardening mirrors the aggregator proxies: POST-only, origin allowlist
// (fail-closed on prod AND Vercel preview), per-IP rate limit, request + bounded
// response body caps, no upstream credential reflection. The JSON-RPC body is
// forwarded verbatim (same as the cow/odos POST proxies) so the wallet adapter's
// internal RPC calls keep working.
import { checkRateLimit } from "./_lib/ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./_lib/bodycap.js";
import { logSafe } from "./_lib/logSafe.js";
import { isRequestOriginAllowed } from "./_lib/aggregator-proxy.js";

const SOLANA_RPC_UPSTREAM =
  process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// JSON-RPC requests are small (a signed tx is a few KB; batches a bit more).
const MAX_REQUEST_BODY_SIZE = 64 * 1024;

// AUDIT 2026-07-12 (backend audit, L-1): JSON-RPC method allowlist. Without it,
// the Origin header (a browser-CSRF control any non-browser client sets trivially)
// was the ONLY content gate, turning this into an open, arbitrary-method proxy to
// a keyed/paid Solana RPC — a caller could burn compute units with unbounded scans
// (getProgramAccounts, getBlock ranges, getSupply). Mirrors alchemy.js's
// ALLOWED_RPC_METHODS: allow only the read + tx send/confirm methods the wallet
// adapter + Jupiter swap flow actually use; reject expensive scans + cap batch size.
// EXTEND THIS SET (never the origin check) if a legitimate wallet call is rejected.
const ALLOWED_SOL_METHODS = new Set([
  // blockhash / slot / cluster meta
  "getLatestBlockhash", "getRecentBlockhash", "isBlockhashValid",
  "getSlot", "getBlockHeight", "getEpochInfo", "getVersion", "getHealth", "getGenesisHash",
  // balances / accounts
  "getBalance", "getAccountInfo", "getMultipleAccounts", "getMinimumBalanceForRentExemption",
  // tokens (client getParsed* map to these base RPC methods)
  "getTokenAccountsByOwner", "getTokenAccountBalance", "getTokenSupply", "getTokenLargestAccounts",
  // fees / priority
  "getFeeForMessage", "getRecentPrioritizationFees",
  // transaction send / confirm / inspect
  "sendTransaction", "simulateTransaction", "getSignatureStatuses", "getSignatureStatus",
  "getTransaction", "getSignaturesForAddress",
]);
const MAX_RPC_BATCH = 20;

// AUDIT FIX F1: treat Vercel preview AND production as prod-like. Preview deploys
// inherit prod env but DO NOT set NODE_ENV=production, so a bare NODE_ENV check
// would leave the origin gate open on every preview URL.
function isProdLikeEnv() {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "preview" ||
    process.env.VERCEL_ENV === "production"
  );
}

function buildAllowedOrigins() {
  const set = new Set([
    "https://memetic.fun",
    "https://www.memetic.fun",
    "https://memetics.finance",
    "https://www.memetics.finance",
    "https://tegridyfarms.vercel.app",
  ]);
  if (process.env.ALLOWED_ORIGIN) set.add(process.env.ALLOWED_ORIGIN);
  if (!isProdLikeEnv()) {
    set.add("http://localhost:8742");
    set.add("http://localhost:3000");
    set.add("http://localhost:5173");
  }
  return set;
}

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  const allowed = buildAllowedOrigins();
  const fallback = process.env.ALLOWED_ORIGIN || "https://tegridyfarms.vercel.app";
  res.setHeader("Access-Control-Allow-Origin", allowed.has(origin) ? origin : fallback);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Request-level gate (shared): for this POST-only handler it is equivalent to
  // the local isOriginAllowed — browsers always send Origin on POST — but it
  // stays correct if a GET branch is ever added (same-origin GETs carry no
  // Origin header; see aggregator-proxy.js AUDIT FIX 2026-08-24).
  if (!isRequestOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // Generous per-IP limit: an active swap polls getSignatureStatuses every ~2s
  // for up to 60s plus balance reads, so a single confirm can be ~30 calls.
  const allowed = await checkRateLimit(req, res, {
    limit: 300,
    windowSec: 60,
    identifier: "solrpc",
  });
  if (!allowed) return;

  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  if (raw.length > MAX_REQUEST_BODY_SIZE) {
    return res.status(413).json({ error: "Request body too large" });
  }

  // AUDIT 2026-07-12 (L-1): enforce the JSON-RPC method allowlist before forwarding.
  let parsedBody;
  try {
    parsedBody = typeof req.body === "object" && req.body !== null ? req.body : JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: "Invalid JSON-RPC body" });
  }
  const calls = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  if (calls.length === 0 || calls.length > MAX_RPC_BATCH) {
    return res.status(400).json({ error: "Invalid or oversized JSON-RPC batch" });
  }
  for (const c of calls) {
    if (!c || typeof c.method !== "string" || !ALLOWED_SOL_METHODS.has(c.method)) {
      return res.status(403).json({ error: `RPC method not allowed: ${c && c.method}` });
    }
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(SOLANA_RPC_UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: raw,
    });
  } catch (err) {
    console.error("[solrpc] fetch error:", logSafe(err));
    return res.status(502).json({ error: "Upstream RPC error" });
  }

  let bodyText;
  try {
    const { text, truncated } = await readBoundedText(upstreamRes, MAX_RESPONSE_BYTES);
    if (truncated) {
      console.error("[solrpc] upstream over-cap");
      return res.status(502).json({ error: "Upstream response too large" });
    }
    bodyText = text;
  } catch (err) {
    console.error("[solrpc] read error:", logSafe(err));
    return res.status(502).json({ error: "Upstream RPC error" });
  }

  // Force JSON + nosniff; never forward upstream cookies/auth or cache the
  // (per-user, signed-tx) traffic.
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");

  if (!upstreamRes.ok) {
    console.error(`[solrpc] upstream HTTP ${upstreamRes.status}`);
    return res.status(502).json({ error: "Upstream RPC error" });
  }

  return res.status(200).send(bodyText);
}
