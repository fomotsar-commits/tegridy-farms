// Vercel Serverless Function — proxies Alchemy requests to hide API key
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || "demo";
if (!process.env.ALCHEMY_API_KEY && process.env.NODE_ENV === "production") {
  console.warn("WARNING: ALCHEMY_API_KEY is not set — using demo key in production");
}
const BASE = `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}`;
const RPC_BASE = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

// ── Shared validation helpers ──
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const NUMERIC_ID_RE = /^\d{1,10}$/;
const MAX_BODY_SIZE = 10 * 1024; // 10 KB

function isValidAddress(addr) { return typeof addr === "string" && ETH_ADDRESS_RE.test(addr); }
function isValidTokenId(id) { return typeof id === "string" && NUMERIC_ID_RE.test(id); }

function setRateLimitHeaders(res, { limit = 60, remaining = 59, reset = 60 } = {}) {
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + reset));
}

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
    }

    try {
      const rpcRes = await fetch(RPC_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params: req.body.params || [], id: 1 }),
      });
      const data = await rpcRes.json();
      res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
      return res.status(200).json(data);
    } catch (err) {
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
    const url = new URL(`${BASE}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    });

    let fetchOpts = { headers: { Accept: "application/json" } };
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
      console.error("Alchemy non-JSON response:", text.slice(0, 200));
      return res.status(502).json({ error: "Upstream returned invalid response" });
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: "Alchemy API error", status: response.status });
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Proxy fetch failed" });
  }
}
