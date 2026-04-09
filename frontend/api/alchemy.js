// Vercel Serverless Function — proxies Alchemy requests to hide API key
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || "demo";
const BASE = `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}`;
const RPC_BASE = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

// Whitelist allowed JSON-RPC methods (for raw RPC calls via endpoint=rpc)
const ALLOWED_RPC_METHODS = new Set(["eth_blockNumber"]);

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
  if (req.method === "OPTIONS") return res.status(200).end();

  const { endpoint, ...params } = req.query;

  // Handle raw JSON-RPC calls (e.g., eth_blockNumber) via endpoint=rpc
  if (endpoint === "rpc" && req.method === "POST") {
    const method = req.body?.method;
    if (!method || !ALLOWED_RPC_METHODS.has(method)) {
      return res.status(400).json({ error: "RPC method not allowed" });
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
    const contractAddr = (params.contractAddress || "").toLowerCase();
    if (!contractAddr || !ALLOWED_CONTRACTS.has(contractAddr)) {
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
      const addr = (t.contractAddress || "").toLowerCase();
      if (!addr || !ALLOWED_CONTRACTS.has(addr)) {
        return res.status(403).json({ error: "Contract not supported" });
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

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Proxy fetch failed" });
  }
}
