// ═══ DEVELOPER API v1 — NFT Data & Intelligence ═══
// Fills the Reservoir/SimpleHash gap. Battle-tested REST patterns
// from Alchemy, Nansen, and Reservoir's open API design.
//
// Endpoints:
//   GET /api/v1?route=collections&slug=nakamigos     → collection stats
//   GET /api/v1?route=listings&slug=nakamigos         → active listings
//   GET /api/v1?route=floor&contract=0x...            → floor price oracle
//   GET /api/v1?route=holders&contract=0x...          → top holders
//   GET /api/v1?route=activity&contract=0x...         → recent sales
//   GET /api/v1?route=token&contract=0x...&tokenId=1  → token metadata

const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || "demo";
const ALCHEMY_NFT = `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}`;

const ALLOWED_CONTRACTS = new Set([
  "0xd774557b647330c91bf44cfeab205095f7e6c367", // Nakamigos
  "0xa1de9f93c56c290c48849b1393b09eb616d55dbb", // GNSS Art
  "0xd37264c71e9af940e49795f0d3a8336afaafdda9", // Jungle Bay
]);

const SLUG_TO_CONTRACT = {
  nakamigos: "0xd774557b647330c91bf44cfeab205095f7e6c367",
  gnssart: "0xa1de9f93c56c290c48849b1393b09eb616d55dbb",
  junglebay: "0xd37264c71e9af940e49795f0d3a8336afaafdda9",
};

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://nakamigos.gallery";

// ── Shared validation helpers ──
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const NUMERIC_ID_RE = /^\d{1,10}$/;

function isValidAddress(addr) { return typeof addr === "string" && ETH_ADDRESS_RE.test(addr); }
function isValidTokenId(id) { return typeof id === "string" && NUMERIC_ID_RE.test(id); }

function setRateLimitHeaders(res, { limit = 60, remaining = 59, reset = 60 } = {}) {
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + reset));
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const prodOrigins = ["https://nakamigos.gallery", "https://www.nakamigos.gallery", "https://tegridyfarms.vercel.app"];
  const devOrigins = process.env.NODE_ENV !== "production"
    ? ["http://localhost:8742", "http://localhost:3000", "http://localhost:5173"]
    : [];
  const ALLOWED_ORIGINS = new Set([...prodOrigins, ...devOrigins]);
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.has(origin) ? origin : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.setHeader("Vary", "Origin");
}

async function alchemyFetch(endpoint, params = {}) {
  const url = new URL(`${ALCHEMY_NFT}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Alchemy ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  setCors(req, res);
  setRateLimitHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { route, slug, contract: rawContract, tokenId, limit } = req.query;

  // Validate contract address format if provided directly
  if (rawContract && !isValidAddress(rawContract)) {
    return res.status(400).json({ error: "Invalid contract address format" });
  }

  // Validate slug if provided
  if (slug && !SLUG_TO_CONTRACT[slug]) {
    return res.status(400).json({ error: "Unknown collection slug" });
  }

  // Validate tokenId format if provided
  if (tokenId && !isValidTokenId(tokenId)) {
    return res.status(400).json({ error: "Invalid tokenId — must be numeric (max 10 digits)" });
  }

  // Resolve contract from slug or direct param
  const contract = rawContract?.toLowerCase() || (slug && SLUG_TO_CONTRACT[slug]) || null;

  if (!route) return res.status(400).json({ error: "Missing route parameter" });
  if (contract && !ALLOWED_CONTRACTS.has(contract)) {
    return res.status(403).json({ error: "Contract not supported" });
  }

  try {
    switch (route) {
      // ── Collection Stats ──
      case "collections": {
        if (!contract) return res.status(400).json({ error: "Missing slug or contract" });
        const [floor, meta, owners] = await Promise.all([
          alchemyFetch("getFloorPrice", { contractAddress: contract }),
          alchemyFetch("getContractMetadata", { contractAddress: contract }),
          alchemyFetch("getOwnersForContract", { contractAddress: contract, withTokenBalances: false }),
        ]);
        res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
        return res.json({
          contract,
          slug: slug || null,
          floor: floor.openSea?.floorPrice ?? null,
          owners: owners.owners?.length ?? null,
          supply: parseInt(meta.contract?.totalSupply, 10) || null,
          name: meta.contract?.name || null,
          symbol: meta.contract?.symbol || null,
        });
      }

      // ── Floor Price Oracle ──
      case "floor": {
        if (!contract) return res.status(400).json({ error: "Missing contract" });
        const data = await alchemyFetch("getFloorPrice", { contractAddress: contract });
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
        return res.json({
          contract,
          floor: data.openSea?.floorPrice ?? null,
          marketplace: "opensea",
          timestamp: new Date().toISOString(),
        });
      }

      // ── Top Holders ──
      case "holders": {
        if (!contract) return res.status(400).json({ error: "Missing contract" });
        const data = await alchemyFetch("getOwnersForContract", {
          contractAddress: contract, withTokenBalances: true,
        });
        const holders = (data.owners || [])
          .map(o => ({ address: o.ownerAddress, count: o.tokenBalances?.length || 0 }))
          .sort((a, b) => b.count - a.count)
          .slice(0, Math.min(Math.max(1, parseInt(limit, 10) || 50), 200));
        res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
        return res.json({ contract, holders });
      }

      // ── Recent Activity ──
      case "activity": {
        if (!contract) return res.status(400).json({ error: "Missing contract" });
        const data = await alchemyFetch("getNFTSales", {
          contractAddress: contract, order: "desc", limit: String(Math.min(Math.max(1, parseInt(limit, 10) || 20), 100)),
        });
        const sales = (data.nftSales || []).map(s => ({
          tokenId: s.tokenId,
          price: s.sellerFee?.amount ? Number(BigInt(s.sellerFee.amount) * 10000n / BigInt(1e18)) / 10000 : null,
          from: s.sellerAddress,
          to: s.buyerAddress,
          marketplace: s.marketplace,
          blockNumber: s.blockNumber,
          txHash: s.transactionHash,
        }));
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
        return res.json({ contract, sales });
      }

      // ── Token Metadata ──
      case "token": {
        if (!contract || !tokenId) return res.status(400).json({ error: "Missing contract or tokenId" });
        // Validate tokenId is a reasonable numeric string (prevents injection/abuse)
        if (!/^\d{1,10}$/.test(tokenId)) return res.status(400).json({ error: "Invalid tokenId" });
        const data = await alchemyFetch("getNFTMetadata", {
          contractAddress: contract, tokenId,
        });
        res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
        return res.json({
          contract,
          tokenId: data.tokenId,
          name: data.name || `#${data.tokenId}`,
          image: data.image?.cachedUrl || data.image?.originalUrl || null,
          attributes: (data.raw?.metadata?.attributes || []).map(a => ({
            key: a.trait_type, value: a.value,
          })),
          owner: data.owners?.[0] || null,
        });
      }

      // ── Active Listings (proxy to OpenSea) ──
      case "listings": {
        const s = slug || Object.keys(SLUG_TO_CONTRACT).find(k => SLUG_TO_CONTRACT[k] === contract);
        if (!s) return res.status(400).json({ error: "Missing slug" });
        // Validate slug against known slugs to prevent path traversal attacks
        if (!SLUG_TO_CONTRACT[s]) return res.status(400).json({ error: "Unknown collection slug" });
        const osKey = process.env.OPENSEA_API_KEY || "";
        const headers = { Accept: "application/json" };
        if (osKey) headers["x-api-key"] = osKey;
        const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
        const osRes = await fetch(
          `https://api.opensea.io/api/v2/listings/collection/${s}/best?limit=${safeLimit}`,
          { headers },
        );
        if (!osRes.ok) throw new Error(`OpenSea ${osRes.status}`);
        let osData;
        try {
          osData = await osRes.json();
        } catch {
          throw new Error("OpenSea returned non-JSON response");
        }
        const listings = (osData.listings || []).map(l => {
          const offer = l.protocol_data?.parameters?.offer?.[0];
          const priceWei = l.price?.current?.value;
          return {
            tokenId: offer?.identifierOrCriteria || null,
            price: priceWei ? Number(BigInt(priceWei) * 10000n / BigInt(1e18)) / 10000 : null,
            maker: l.protocol_data?.parameters?.offerer || null,
            marketplace: "opensea",
            orderHash: l.order_hash || null,
          };
        }).filter(l => l.tokenId && l.price);
        res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
        return res.json({ slug: s, listings });
      }

      default:
        return res.status(400).json({ error: "Unknown route" });
    }
  } catch (err) {
    console.error("API v1 error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
}
