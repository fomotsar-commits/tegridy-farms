// Vercel Serverless Function — proxies Alchemy requests to hide API key
import { checkRateLimit, checkGlobalLimit } from "./_lib/ratelimit.js";
import { readBoundedText, MAX_RESPONSE_BYTES } from "./_lib/bodycap.js";
import { logSafe } from "./_lib/logSafe.js";
import { fetchAlchemyWithFailover } from "./_lib/alchemy-failover.js";

// AUDIT R048: prefer Authorization: Bearer header over URL path embedding so
// the key never appears in Vercel access logs, observability tracers, or
// upstream HTML error pages that echo the request URL. Falls back to URL
// path embedding only when no real key is configured (legacy/demo dev).
// RESIL-1: every upstream fetch goes through fetchAlchemyWithFailover, which
// retries ONCE with the optional ALCHEMY_API_KEY_FALLBACK on 401/403/429/5xx
// — a lapsed primary key no longer blacks out the marketplace. The builders
// below are keyed per attempt so URL shape + Authorization track the key.
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || "demo";
if (!process.env.ALCHEMY_API_KEY && process.env.NODE_ENV === "production") {
  console.warn("WARNING: ALCHEMY_API_KEY is not set — using demo key in production");
}
const NFT_V3_ROOT = "https://eth-mainnet.g.alchemy.com/nft/v3";
const RPC_ROOT = "https://eth-mainnet.g.alchemy.com/v2";

function nftBaseFor(key) {
  return key ? NFT_V3_ROOT : `${NFT_V3_ROOT}/${ALCHEMY_KEY}`;
}
function rpcBaseFor(key) {
  return key ? RPC_ROOT : `${RPC_ROOT}/${ALCHEMY_KEY}`;
}
function authHeadersFor(key, extra = {}) {
  const headers = { Accept: "application/json", ...extra };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

// ── Shared validation helpers ──
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const NUMERIC_ID_RE = /^\d{1,10}$/;
const MAX_BODY_SIZE = 10 * 1024; // 10 KB
const MAX_BLOCK_RANGE = 10_000n; // AUDIT R049 H-5: cap eth_getLogs block delta

function isValidAddress(addr) { return typeof addr === "string" && ETH_ADDRESS_RE.test(addr); }
function isValidTokenId(id) { return typeof id === "string" && NUMERIC_ID_RE.test(id); }

// AUDIT API-M1: real rate limiting now lives in _lib/ratelimit.js (Upstash
// Redis sliding window). The cosmetic-header helper is removed; the limiter
// sets proper X-RateLimit-* + Retry-After headers itself.

// Whitelist allowed JSON-RPC methods (for raw RPC calls via endpoint=rpc)
const ALLOWED_RPC_METHODS = new Set(["eth_blockNumber", "eth_getLogs"]);

// Whitelist allowed endpoints to prevent abuse
const ALLOWED_ENDPOINTS = new Set([
  "getNFTsForContract",
  "getFloorPrice",
  "getContractMetadata",
  "getOwnersForContract",
  "getNFTSales",
  "getNFTsForOwner",
  "getNFTMetadata",
  "getNFTMetadataBatch",
]);

// Whitelist allowed contract addresses (lowercase) to prevent open-proxy abuse
const ALLOWED_CONTRACTS = new Set([
  "0xd774557b647330c91bf44cfeab205095f7e6c367", // Nakamigos
  "0xa1de9f93c56c290c48849b1393b09eb616d55dbb", // GNSS Art
  "0xd37264c71e9af940e49795f0d3a8336afaafdda9", // Jungle Bay
]);

// Endpoints that require a contractAddress query param (must be in ALLOWED_CONTRACTS)
const CONTRACT_REQUIRED_ENDPOINTS = new Set([
  "getNFTsForContract",
  "getFloorPrice",
  "getContractMetadata",
  "getOwnersForContract",
  "getNFTSales",
  "getNFTMetadata",
]);

// Endpoints that accept contractAddresses[] array param (owner-scoped queries)
const CONTRACT_ARRAY_ENDPOINTS = new Set([
  "getNFTsForOwner",
]);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://memetic.fun";

// AUDIT R049 H-5: resolve "latest" to a numeric block tip via eth_blockNumber
// so the same delta cap applies whether the client sends numeric blocks or
// "latest". Bounded by readBoundedText so it can't reintroduce H-3.
async function resolveChainTip() {
  const res = await fetchAlchemyWithFailover((key) => ({
    url: rpcBaseFor(key),
    opts: {
      method: "POST",
      headers: authHeadersFor(key, { "Content-Type": "application/json" }),
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
    },
  }));
  const { text } = await readBoundedText(res, MAX_RESPONSE_BYTES);
  const data = JSON.parse(text);
  if (!data?.result || typeof data.result !== "string") throw new Error("tip-resolve-failed");
  return BigInt(data.result);
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const ALLOWED_ORIGINS = new Set([
    "https://memetic.fun",
    "https://www.memetic.fun",
    "https://memetics.finance",
    "https://www.memetics.finance",
    "https://tegridyfarms.vercel.app",
  ]);
  // AUDIT API-SEC: fail-closed CORS. Only admit localhost when NODE_ENV is
  // explicitly "development". An unset / mistyped NODE_ENV on a production
  // deploy would previously have enabled localhost origins; this guard
  // inverts that default.
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

  // AUDIT API-M1: 60 requests / minute per IP. Alchemy's own plan limit is
  // much higher but we clamp here to bound cost-per-IP and block obvious
  // abuse. Returns 429 + Retry-After on exceeded; fails open if Upstash
  // env vars aren't configured.
  const allowed = await checkRateLimit(req, res, {
    limit: 60, windowSec: 60, identifier: "alchemy",
  });
  if (!allowed) return;

  // AUDIT 2026-07-25: global circuit-breaker. The per-IP cap above stops one
  // abusive source but NOT a distributed flood — many IPs each under 60/min
  // still burn Alchemy compute units (metered $). Cap TOTAL alchemy traffic
  // across all callers and shed load with 503 past the aggregate ceiling.
  // Default is generous so it never trips on organic load; raise
  // ALCHEMY_GLOBAL_RPM instantly (env, no redeploy) if a real spike hits it.
  const underGlobalCap = await checkGlobalLimit(res, {
    // ~40 req/s aggregate: far above any realistic organic peak for this app,
    // far below what an unchecked flood would bill in Alchemy compute units.
    limit: Number(process.env.ALCHEMY_GLOBAL_RPM) || 2400,
    windowSec: 60,
    identifier: "alchemy",
  });
  if (!underGlobalCap) return;

  // Body size guard (POST only)
  if (req.method === "POST") {
    const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    if (bodyStr.length > MAX_BODY_SIZE) {
      return res.status(413).json({ error: "Request body too large (max 10KB)" });
    }
  }

  const { endpoint, ...params } = req.query;

  // Handle raw JSON-RPC calls (e.g., eth_blockNumber, eth_getLogs) via endpoint=rpc
  if (endpoint === "rpc" && req.method === "POST") {
    const method = req.body?.method;
    if (!method || !ALLOWED_RPC_METHODS.has(method)) {
      return res.status(400).json({ error: "RPC method not allowed" });
    }

    // Validate eth_getLogs params — only allow querying whitelisted contracts
    if (method === "eth_getLogs") {
      const logParams = req.body.params?.[0];
      if (!logParams || typeof logParams !== "object") {
        return res.status(400).json({ error: "eth_getLogs requires a filter object" });
      }
      const addr = logParams.address;
      if (!addr || !isValidAddress(addr)) {
        return res.status(400).json({ error: "eth_getLogs requires a valid contract address" });
      }
      if (!ALLOWED_CONTRACTS.has(addr.toLowerCase())) {
        return res.status(403).json({ error: "Contract not supported" });
      }
      // Validate fromBlock/toBlock — only allow "latest" or hex block numbers
      const blockRe = /^(latest|0x[0-9a-fA-F]{1,16})$/;
      if (logParams.fromBlock && !blockRe.test(logParams.fromBlock)) {
        return res.status(400).json({ error: "Invalid fromBlock value" });
      }
      if (logParams.toBlock && !blockRe.test(logParams.toBlock)) {
        return res.status(400).json({ error: "Invalid toBlock value" });
      }

      // AUDIT R049 H-5: cap delta(fromBlock, toBlock) at 10_000 to prevent
      // unbounded chain scans that burn Alchemy compute units AND trigger
      // the H-3 OOM path.
      const fromRaw = logParams.fromBlock ?? "latest";
      const toRaw = logParams.toBlock ?? "latest";
      try {
        let fromBig, toBig;
        if (fromRaw === "latest" || toRaw === "latest") {
          const tip = await resolveChainTip();
          fromBig = fromRaw === "latest" ? tip : BigInt(fromRaw);
          toBig = toRaw === "latest" ? tip : BigInt(toRaw);
        } else {
          fromBig = BigInt(fromRaw);
          toBig = BigInt(toRaw);
        }
        if (toBig < fromBig) {
          return res.status(400).json({ error: "toBlock must be >= fromBlock" });
        }
        if (toBig - fromBig > MAX_BLOCK_RANGE) {
          return res.status(400).json({ error: "Block range too large (max 10000)" });
        }
      } catch (err) {
        if (String(err?.message).includes("tip-resolve-failed")) {
          return res.status(502).json({ error: "Upstream service error" });
        }
        return res.status(400).json({ error: "Invalid block range" });
      }
    }

    try {
      const rpcRes = await fetchAlchemyWithFailover((key) => ({
        url: rpcBaseFor(key),
        opts: {
          method: "POST",
          headers: authHeadersFor(key, { "Content-Type": "application/json" }),
          body: JSON.stringify({ jsonrpc: "2.0", method, params: req.body.params || [], id: 1 }),
        },
      }));
      // AUDIT R049 H-3: bounded body read.
      const { text, truncated } = await readBoundedText(rpcRes, MAX_RESPONSE_BYTES);
      if (truncated) {
        return res.status(502).json({ error: "Upstream response too large" });
      }
      // INCIDENT 2026-09-04 (#385): this path had NO status check, so an
      // upstream 401 came back to the caller as **HTTP 200** carrying a
      // JSON-RPC error member. A client checking the status code read a
      // rejected key as a successful call — the repo's most-repeated defect
      // class, on a live path. The REST branch below has always checked
      // `response.ok`; this one never did.
      if (!rpcRes.ok) {
        const rejected = rpcRes.status === 401 || rpcRes.status === 403;
        console.error(
          rejected
            ? `Alchemy RPC REJECTED OUR CREDENTIALS: HTTP ${rpcRes.status} — rotate ALCHEMY_API_KEY.`
            : "Alchemy RPC upstream error:",
          rpcRes.status,
          logSafe(text.slice(0, 500)),
        );
        return rejected
          ? res.status(503).json({ error: "Upstream credentials rejected" })
          : res.status(502).json({ error: "Upstream service error" });
      }
      let data;
      try { data = JSON.parse(text); } catch {
        console.error("Alchemy RPC non-JSON:", logSafe(text.slice(0, 200)));
        return res.status(502).json({ error: "Upstream returned invalid response" });
      }
      // AUDIT R050 HIGH: method-specific edge-cache contract. Only the public
      // chain-tip method gets shared cache; everything else is private
      // (defence in depth — if a future RPC method becomes user-bound, it
      // doesn't auto-leak across users).
      if (method === "eth_blockNumber") {
        res.setHeader("Cache-Control", "s-maxage=12, stale-while-revalidate=12");
      } else {
        res.setHeader("Cache-Control", "private, no-store");
      }
      return res.status(200).json(data);
    } catch (err) {
      console.error("Alchemy RPC error:", logSafe(err));
      return res.status(500).json({ error: "RPC proxy fetch failed" });
    }
  }

  if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({ error: "Invalid or missing endpoint" });
  }

  // Validate contractAddress param against allowed contracts (prevent open-proxy abuse)
  if (CONTRACT_REQUIRED_ENDPOINTS.has(endpoint)) {
    if (!isValidAddress(params.contractAddress || "")) {
      return res.status(400).json({ error: "Invalid contract address format" });
    }
    const contractAddr = params.contractAddress.toLowerCase();
    if (!ALLOWED_CONTRACTS.has(contractAddr)) {
      return res.status(403).json({ error: "Contract not supported" });
    }
    // Normalize to lowercase for Alchemy
    params.contractAddress = contractAddr;
  }

  // Validate contractAddresses[] param for owner-scoped queries
  if (CONTRACT_ARRAY_ENDPOINTS.has(endpoint)) {
    const raw = params["contractAddresses[]"] || params["contractAddresses%5B%5D"] || "";
    // Normalize to array — query params may be a single string or an array of strings
    const addrs = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    // SECURITY 2026-07-19: this allowlist loop is a no-op when the caller simply
    // OMITS contractAddresses[] — `addrs` is empty, nothing is checked, and the
    // request becomes an unscoped getNFTsForOwner that enumerates a wallet's
    // ENTIRE NFT holdings on our paid Alchemy key. Default the scope to the
    // allowlist instead of trusting the caller to send it, so the endpoint can
    // only ever answer "which of OUR collections does this wallet hold".
    if (addrs.length === 0) {
      params["contractAddresses[]"] = [...ALLOWED_CONTRACTS];
      delete params["contractAddresses%5B%5D"];
    }
    for (const a of addrs) {
      if (!ALLOWED_CONTRACTS.has(a.toLowerCase())) {
        return res.status(403).json({ error: "Contract not supported" });
      }
    }
    // Validate owner param is a proper Ethereum address
    const owner = params.owner || "";
    if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
      return res.status(400).json({ error: "Invalid owner address" });
    }
  }

  // Validate tokenId for single-token endpoints
  if (endpoint === "getNFTMetadata") {
    if (params.tokenId && !isValidTokenId(params.tokenId)) {
      return res.status(400).json({ error: "Invalid tokenId — must be numeric (max 10 digits)" });
    }
  }

  // Clamp limit/offset query params to reasonable ranges
  if (params.limit) {
    params.limit = String(Math.min(Math.max(1, parseInt(params.limit, 10) || 50), 200));
  }
  if (params.offset) {
    params.offset = String(Math.min(Math.max(0, parseInt(params.offset, 10) || 0), 10000));
  }
  if (params.pageSize) {
    params.pageSize = String(Math.min(Math.max(1, parseInt(params.pageSize, 10) || 100), 200));
  }

  // Validate POST body for getNFTMetadataBatch — contract addresses are in the body, not query params
  if (endpoint === "getNFTMetadataBatch" && req.method === "POST") {
    const tokens = req.body?.tokens;
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ error: "Missing or empty tokens array" });
    }
    if (tokens.length > 100) {
      return res.status(400).json({ error: "Batch limit is 100 tokens" });
    }
    for (const t of tokens) {
      if (!isValidAddress(t.contractAddress || "")) {
        return res.status(400).json({ error: "Invalid contract address format in tokens array" });
      }
      const addr = t.contractAddress.toLowerCase();
      if (!ALLOWED_CONTRACTS.has(addr)) {
        return res.status(403).json({ error: "Contract not supported" });
      }
      if (t.tokenId != null && !isValidTokenId(String(t.tokenId))) {
        return res.status(400).json({ error: "Invalid tokenId in tokens array — must be numeric (max 10 digits)" });
      }
    }
  }

  try {
    const response = await fetchAlchemyWithFailover((key) => {
      const url = new URL(`${nftBaseFor(key)}/${endpoint}`);
      Object.entries(params).forEach(([k, v]) => {
        if (v != null && v !== "") url.searchParams.set(k, String(v));
      });

      let fetchOpts = { headers: authHeadersFor(key) };
      if (req.method === "POST") {
        fetchOpts.method = "POST";
        fetchOpts.headers = authHeadersFor(key, { "Content-Type": "application/json" });
        // Guard against undefined/null body — send empty object instead of "undefined"
        fetchOpts.body = JSON.stringify(req.body ?? {});
      }
      return { url: url.toString(), opts: fetchOpts };
    });

    // AUDIT R049 H-3: bounded body read protects against gzip-bombs / OOM.
    const { text, truncated } = await readBoundedText(response, MAX_RESPONSE_BYTES);
    if (truncated) {
      console.error("Alchemy upstream over-cap");
      return res.status(502).json({ error: "Upstream response too large" });
    }
    // INCIDENT 2026-09-04 (#385): the status check MUST come before the parse.
    // Alchemy answers a rejected key with HTTP 401, `content-type:
    // application/json`, and a body of `Must be authenticated!` — which is not
    // JSON. Parsing first meant a clean, unambiguous 401 was reported as
    // "Upstream returned invalid response", so a revoked key and a corrupt
    // payload were the same opaque 502. Diagnosing the live incident took a
    // source read and six probes; the status was there the whole time and was
    // simply never consulted.
    if (!response.ok) {
      // AUDIT API-M4 still holds: never leak upstream status or body to the
      // CLIENT. What changes is that the server log now always carries the
      // status, and that a credential rejection gets its own client-visible
      // code so ops can tell "our key is bad" from "upstream is broken"
      // without reading source. 503 says the fault is our configuration; it
      // discloses nothing about the key itself.
      const rejected = response.status === 401 || response.status === 403;
      console.error(
        rejected
          ? `Alchemy REJECTED OUR CREDENTIALS: HTTP ${response.status} — ALCHEMY_API_KEY is set but not accepted. Rotate it.`
          : "Alchemy upstream error:",
        response.status,
        logSafe(text.slice(0, 500)),
      );
      return rejected
        ? res.status(503).json({ error: "Upstream credentials rejected" })
        : res.status(502).json({ error: "Upstream service error" });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // AUDIT R048: don't log full URL — sanitizer scrubs key-shaped path
      // segments but logSafe is the canonical path. Reaching here now means a
      // 2xx that is genuinely malformed, which is the only thing this message
      // ever claimed to mean.
      console.error("Alchemy non-JSON response:", logSafe(text.slice(0, 200)));
      return res.status(502).json({ error: "Upstream returned invalid response" });
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(data);
  } catch (err) {
    console.error("Alchemy proxy error:", logSafe(err));
    return res.status(500).json({ error: "Proxy fetch failed" });
  }
}
