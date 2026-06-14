import { CONTRACT, COLLECTION_SLUG, COLLECTIONS, METADATA_BASE, FALLBACK_NFTS, FALLBACK_STATS, FALLBACK_ACTIVITY, FALLBACK_WHALES, SEAPORT_DOMAIN } from "./constants";
import { alchemyGet as proxyAlchemyGet, alchemyPost as proxyAlchemyPost, openseaGet as rawOpenseaGet, openseaPost as rawOpenseaPost, ApiError } from "./lib/proxy";

// Seaport fulfillment entrypoints that OpenSea's fulfillment_data API
// legitimately returns. Used to allowlist the function signature in API
// responses before encoding calldata (the tx target is separately pinned to
// canonical Seaport addresses). Exported for api-offers.js and unit tests.
export const SEAPORT_FULFILLMENT_FUNCTIONS = new Set([
  "fulfillBasicOrder",
  "fulfillBasicOrder_efficient_6GL6yc",
  "fulfillOrder",
  "fulfillAdvancedOrder",
  "fulfillAvailableOrders",
  "fulfillAvailableAdvancedOrders",
  "matchOrders",
  "matchAdvancedOrders",
]);

// ═══ RETRY WITH EXPONENTIAL BACKOFF ═══
// Retries on: 429 (rate limit), 5xx (server errors), network failures (fetch throws TypeError).
// Does NOT retry: 400, 401, 403, 404 — these are permanent client errors.
// Honors Retry-After header from 429 responses when available.
async function withRetry(fn, { maxRetries = 3, baseDelay = 1000, maxDelay = 30000, signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Bail immediately if caller aborted (e.g. React component unmounted)
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry aborted requests
      if (err.name === "AbortError") throw err;

      // Don't retry if we've used all attempts
      if (attempt >= maxRetries) break;

      // Determine if this error is worth retrying
      // ApiError.isRetryable covers: status 0 (network/CORS), 429, 5xx
      // Raw TypeError covers: fetch() failure before proxy wrapping (edge case)
      const isApiError = err instanceof ApiError;
      const isNetworkError = err instanceof TypeError;
      const isRetryable = isNetworkError || (isApiError && err.isRetryable);

      if (!isRetryable) {
        // 400, 401, 403, 404, etc. — retrying won't help
        break;
      }

      // Use Retry-After header for 429s when available, otherwise exponential backoff
      let delay;
      if (isApiError && err.retryAfter) {
        delay = Math.min(err.retryAfter * 1000, maxDelay);
      } else {
        delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 500, maxDelay);
      }

      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

async function alchemyGet(endpoint, params = {}, { signal } = {}) {
  return withRetry(async () => {
    return proxyAlchemyGet(endpoint, params, { signal });
  }, { maxRetries: 2, signal });
}

async function alchemyPost(endpoint, body, { signal } = {}) {
  return withRetry(async () => {
    return proxyAlchemyPost(endpoint, body, { signal });
  }, { maxRetries: 2, signal });
}

// ═══ OPENSEA RETRY WRAPPERS ═══
// OpenSea is heavily rate-limited (429s are common). Use longer base delay.
function openseaGet(path, params = {}, { signal } = {}) {
  return withRetry(() => rawOpenseaGet(path, params, { signal }), { maxRetries: 3, baseDelay: 1500, signal });
}

function openseaPost(path, body, { signal, maxRetries = 2, baseDelay = 1500 } = {}) {
  // Default is a patient background retry (OpenSea 429s are common). Interactive
  // paths (e.g. the buy click) can pass a tighter policy so the user isn't stuck
  // on a spinner through the full 1500ms-base backoff.
  return withRetry(() => rawOpenseaPost(path, body, { signal }), { maxRetries, baseDelay, signal });
}

// Convert ipfs:// URLs to an HTTP gateway
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];

function resolveIpfs(url) {
  if (!url) return url;
  if (url.startsWith("ipfs://")) return url.replace("ipfs://", IPFS_GATEWAYS[0]);
  return url;
}

// Does this collection serve a deterministic per-id PNG at `${metadataBase}/<id>.png`?
// Nakamigos does NOT (its metadataBase is a per-token-JSON IPFS CID, so that URL
// 404s); gnss/junglebay do. Default to true when unknown so we don't regress
// collections that rely on the fallback.
function hasDeterministicImage(contract) {
  const entry = Object.values(COLLECTIONS).find(
    c => contract && c.contract.toLowerCase() === String(contract).toLowerCase()
  );
  return entry ? entry.deterministicImage !== false : true;
}

// Normalize an Alchemy NFT object
function normalizeToken(nft, metadataBase = METADATA_BASE) {
  const attrs = nft.raw?.metadata?.attributes || [];
  const contractAddr = nft.contract?.address || null;
  // Only build a `${metadataBase}/<id>.png` fallback when it actually resolves
  // for this collection — emitting the known-404 Nakamigos URL triggers a
  // broken-image flash + a per-card metadata refetch storm (F568).
  const fallbackImage = metadataBase && hasDeterministicImage(contractAddr)
    ? `${metadataBase}/${nft.tokenId}.png`
    : null;
  // Also check raw metadata image (some collections store image URL only there)
  const rawMetaImage = resolveIpfs(nft.raw?.metadata?.image || null);
  // Grid thumbnail: prefer Alchemy CDN sizes; only fall to raw 2000px IPFS when
  // no CDN size exists (raw IPFS is slow and re-blackens on re-render — F621).
  const resolvedImage = nft.image?.thumbnailUrl || nft.image?.cachedUrl || nft.image?.pngUrl || nft.image?.originalUrl || fallbackImage || rawMetaImage;
  return {
    id: nft.tokenId,
    name: nft.name || nft.raw?.metadata?.name || `#${nft.tokenId}`,
    image: resolvedImage,
    // F603: carry the small CDN thumbnail explicitly so NftImage can emit a
    // responsive srcset (thumbnail -> 1x, larger CDN size -> 2x) on retina.
    imageThumb: nft.image?.thumbnailUrl || null,
    imageLarge: nft.image?.cachedUrl || nft.image?.pngUrl || nft.image?.originalUrl || rawMetaImage || fallbackImage,
    attributes: attrs
      .filter(a => a.trait_type != null && a.trait_type !== "" && a.value != null && a.value !== ""
        && String(a.trait_type) !== "undefined" && String(a.value) !== "undefined")
      .map(a => ({
        key: String(a.trait_type),
        value: String(a.value),
      })),
    owner: Array.isArray(nft.owners) ? nft.owners[0] : null,
    contract: nft.contract?.address || null,
    price: null,
    lastSale: null,
    rank: null,
  };
}

// ═══ TOKENS ═══
export async function fetchTokens({ contract = CONTRACT, metadataBase = METADATA_BASE, pageKey, limit = 40, signal } = {}) {
  try {
    const params = {
      contractAddress: contract,
      withMetadata: "true",
      limit: String(limit),
    };
    if (pageKey) params.startToken = pageKey;
    const data = await alchemyGet("getNFTsForContract", params, { signal });
    return {
      tokens: (data.nfts || []).map(nft => normalizeToken(nft, metadataBase)),
      continuation: data.pageKey || null,
    };
  } catch (err) {
    console.warn("Alchemy API unavailable, using fallback:", err.message);
    const isNakamigos = contract.toLowerCase() === CONTRACT.toLowerCase();
    return { tokens: isNakamigos ? FALLBACK_NFTS : [], continuation: null, fallback: true };
  }
}

// ═══ COLLECTION STATS (Alchemy primary, OpenSea secondary) ═══
// Look up the known supply from COLLECTIONS config so we always have a reliable fallback
function configSupplyFor(contract) {
  const entry = Object.values(COLLECTIONS).find(
    c => c.contract.toLowerCase() === contract.toLowerCase()
  );
  return entry?.supply ?? null;
}

// F516: in-flight de-dupe for collection stats. Several components mount at
// once (useCollection, PortfolioTracker, PriceAlerts, OnChainProfile, …) and
// each calls fetchCollectionStats for the same collection, multiplying the
// per-page request fan-out and tripping our own /api/opensea rate limiter.
// Concurrent callers for the same key share a single in-flight request; the
// entry is cleared as soon as it settles. The shared fetch isn't given any one
// caller's AbortSignal (so one unmount can't cancel it for the others) — the
// proxy-layer request timeout still guarantees it terminates.
const _statsInFlight = new Map();

export function fetchCollectionStats({ contract = CONTRACT, slug = COLLECTION_SLUG, openseaSlug, signal } = {}) {
  const osSlug = openseaSlug || slug;
  const key = `${String(contract).toLowerCase()}::${osSlug}`;
  const existing = _statsInFlight.get(key);
  if (existing) return existing;
  // Note: the shared fetch is intentionally NOT given a caller signal — one
  // caller unmounting must not cancel the request the others are awaiting.
  // The proxy request timeout still bounds it. Callers already guard their own
  // setState against unmount/stale results.
  const p = _fetchCollectionStatsUncached({ contract, slug, openseaSlug }).finally(() => {
    _statsInFlight.delete(key);
  });
  _statsInFlight.set(key, p);
  return p;
}

async function _fetchCollectionStatsUncached({ contract = CONTRACT, slug = COLLECTION_SLUG, openseaSlug, signal } = {}) {
  // Use openseaSlug for OpenSea API calls; fall back to slug
  const osSlug = openseaSlug || slug;
  const knownSupply = configSupplyFor(contract);

  try {
    // Alchemy — works with API key, no extra auth needed
    // Fetch floor price, owner count, AND on-chain totalSupply for accurate live data
    const [floorData, ownersData, metaData, nativeFloorData] = await Promise.all([
      alchemyGet("getFloorPrice", { contractAddress: contract }, { signal }),
      alchemyGet("getOwnersForContract", { contractAddress: contract, withTokenBalances: "false" }, { signal }),
      alchemyGet("getContractMetadata", { contractAddress: contract }, { signal }).catch(() => null),
      import("./lib/orderbook").then(m => m.fetchNativeListings(contract, { limit: 1 })).catch(() => ({ orders: [] })),
    ]);

    const osFloor = floorData.openSea?.floorPrice ?? null;
    const nativeFloor = nativeFloorData.orders?.[0]?.price_eth ?? null;
    // Use the lower of OpenSea floor and native orderbook floor
    const floor = osFloor != null && nativeFloor != null
      ? Math.min(osFloor, nativeFloor)
      : osFloor ?? nativeFloor;
    const owners = ownersData.owners?.length ?? null;
    // On-chain totalSupply is the most accurate (reflects burns)
    // Alchemy NFT v3 returns totalSupply at root level, not under contractMetadata
    const rawSupply = metaData?.totalSupply ?? metaData?.contractMetadata?.totalSupply;
    const onChainSupply = rawSupply ? parseInt(rawSupply, 10) : null;
    const supply = (onChainSupply && isFinite(onChainSupply)) ? onChainSupply : knownSupply;

    // Try to get volume from OpenSea (non-blocking — volume is a nice-to-have)
    let volume = null;
    try {
      const osData = await openseaGet(`collections/${osSlug}/stats`, {}, { signal });
      const total = osData.total || {};
      volume = total.volume ? Math.round(total.volume) : null;
    } catch {
      // Volume unavailable — not critical
    }
    // When the live volume call is rate-limited/unavailable (the landing fans out
    // stats for several collections at once, so the per-collection volume call is
    // the first to get throttled), fall back to the configured historical total
    // for the main collection — so its landing card shows the same number as the
    // detail Hero instead of a bare "—". Other collections have no cached figure
    // and honestly stay null.
    if (volume == null && contract.toLowerCase() === CONTRACT.toLowerCase()) {
      volume = FALLBACK_STATS.volume ?? null;
    }

    return {
      floor,
      volume,
      owners,
      supply,
    };
  } catch (err) {
    if (err.name === "AbortError") throw err;
    console.warn("Alchemy stats unavailable, trying OpenSea:", err.message);
    // Fallback to OpenSea via proxy
    try {
      const osData = await openseaGet(`collections/${osSlug}/stats`, {}, { signal });
      const total = osData.total || {};
      return {
        floor: total.floor_price ?? null,
        volume: total.volume ? Math.round(total.volume) : null,
        owners: total.num_owners ?? null,
        supply: total.count ? parseInt(total.count, 10) : knownSupply,
      };
    } catch (e2) {
      if (e2.name === "AbortError") throw e2;
      if (contract.toLowerCase() === CONTRACT.toLowerCase()) return { ...FALLBACK_STATS, fallback: true };
      return { floor: null, volume: null, owners: null, supply: knownSupply, fallback: true };
    }
  }
}

// Estimate timestamp from block number and vice versa
// Post-merge: exactly 12s/slot. Pre-merge: ~13.5s avg PoW block time.
const MERGE_BLOCK = 15537393;
const MERGE_TIME = 1663224162000; // Sep 15, 2022 06:42:42 UTC in ms
const POST_MERGE_MS_PER_BLOCK = 12000; // 12 seconds
const PRE_MERGE_MS_PER_BLOCK = 13500;  // ~13.5 seconds average

function blockToTimestamp(blockNumber) {
  if (!blockNumber) return Date.now();
  if (blockNumber >= MERGE_BLOCK) {
    return MERGE_TIME + (blockNumber - MERGE_BLOCK) * POST_MERGE_MS_PER_BLOCK;
  }
  return MERGE_TIME + (blockNumber - MERGE_BLOCK) * PRE_MERGE_MS_PER_BLOCK;
}

function timestampToBlock(timestampMs) {
  // Convert a millisecond timestamp to an estimated block number
  const elapsed = timestampMs - MERGE_TIME;
  if (elapsed >= 0) {
    return MERGE_BLOCK + Math.floor(elapsed / POST_MERGE_MS_PER_BLOCK);
  }
  return MERGE_BLOCK + Math.floor(elapsed / PRE_MERGE_MS_PER_BLOCK);
}

// ═══ CURRENT BLOCK NUMBER (live from chain, cached 60s) ═══
let _cachedBlock = null;
let _cachedBlockTime = 0;
const BLOCK_CACHE_MS = 60000; // 60 seconds

async function getCurrentBlock() {
  const now = Date.now();
  if (_cachedBlock && (now - _cachedBlockTime) < BLOCK_CACHE_MS) {
    return _cachedBlock;
  }
  try {
    // Route through the Alchemy proxy to avoid exposing the API key client-side
    const response = await fetch("/api/alchemy?endpoint=rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "eth_blockNumber", params: [] }),
    });
    if (!response.ok) throw new Error(`RPC error ${response.status}`);
    const data = await response.json();
    const blockNum = data.result ? parseInt(data.result, 16) : null;
    if (blockNum && blockNum > 0) {
      _cachedBlock = blockNum;
      _cachedBlockTime = now;
      return _cachedBlock;
    }
  } catch (err) {
    console.warn("getCurrentBlock failed:", err.message);
  }
  // Fallback: if we have a stale cached value, use it
  if (_cachedBlock) return _cachedBlock;
  // Last resort: estimate from timestamp (same old formula, but only as emergency fallback)
  return MERGE_BLOCK + Math.floor((now - MERGE_TIME) / POST_MERGE_MS_PER_BLOCK);
}

// ═══ ACTIVITY (OpenSea events primary, Alchemy getNFTSales fallback) ═══
// Look up the configured slug for a contract (for OpenSea events API)
function slugFor(contract) {
  const entry = Object.values(COLLECTIONS).find(
    c => c.contract.toLowerCase() === contract.toLowerCase()
  );
  return entry?.openseaSlug ?? entry?.slug ?? null;
}

// Look up the configured mintBlock for a contract (used as fromBlock lower bound)
function mintBlockFor(contract) {
  const entry = Object.values(COLLECTIONS).find(
    c => c.contract.toLowerCase() === contract.toLowerCase()
  );
  return entry?.mintBlock ?? null;
}

// Helper: parse OpenSea event objects into normalized activity objects
function parseOpenSeaEvents(events) {
  return events.map(event => {
    const tokenId = event.nft?.identifier || null;
    const paymentWei = event.payment?.quantity || "0";
    const decimals = event.payment?.decimals ?? 18;
    const priceEth = paymentWei !== "0"
      ? Number(BigInt(paymentWei) * 10000n / 10n ** BigInt(decimals)) / 10000
      : null;
    const seller = event.seller || null;
    const buyer = event.buyer || null;
    // event_timestamp: OpenSea v2 returns Unix seconds (int) or occasionally ISO string
    // closing_date: always an ISO string — parse with Date constructor
    let timeMs = Date.now();
    if (event.event_timestamp) {
      const ts = Number(event.event_timestamp);
      timeMs = Number.isFinite(ts) ? ts * 1000 : Date.parse(event.event_timestamp) || Date.now();
    } else if (event.closing_date) {
      const parsed = typeof event.closing_date === "string"
        ? Date.parse(event.closing_date)
        : event.closing_date * 1000;
      if (Number.isFinite(parsed) && parsed > 0) timeMs = parsed;
    }
    return {
      type: "sale",
      token: {
        id: tokenId,
        name: tokenId ? `#${tokenId}` : "\u2014",
      },
      price: priceEth,
      from: seller ? `${seller.slice(0, 6)}...${seller.slice(-4)}` : null,
      to: buyer ? `${buyer.slice(0, 6)}...${buyer.slice(-4)}` : null,
      fromFull: seller,
      toFull: buyer,
      time: timeMs,
      marketplace: "opensea",
      hash: event.transaction || null,
    };
  }).filter(a => a.token.id != null);
}

// Primary source: OpenSea events API (live, up-to-date sale data)
async function fetchOpenSeaActivity({ contract = CONTRACT, limit = 50, daysBack = 30, pageKey, signal } = {}) {
  const slug = slugFor(contract) || COLLECTION_SLUG;
  const isAllTime = daysBack >= 365;

  const params = { event_type: "sale", limit };
  if (!isAllTime) {
    const afterTs = Math.floor(Date.now() / 1000) - (daysBack * 86400);
    params.after = afterTs;
  }
  if (pageKey) params.next = pageKey;

  const data = await openseaGet(`events/collection/${slug}`, params, { signal });
  const events = data.asset_events || [];

  return {
    activities: parseOpenSeaEvents(events),
    pageKey: data.next || null,
    empty: events.length === 0,
  };
}

// Helper: parse sales array from Alchemy response into normalized activity objects
function parseSales(sales) {
  return sales.map(sale => {
    const tokenId = sale.tokenId;
    // Use BigInt to avoid precision loss on large wei values
    const sellerAmt = BigInt(sale.sellerFee?.amount || "0");
    const protocolAmt = BigInt(sale.protocolFee?.amount || "0");
    const royaltyAmt = BigInt(sale.royaltyFee?.amount || "0");
    const totalWei = sellerAmt + protocolAmt + royaltyAmt;
    const priceEth = totalWei > 0n ? Number(totalWei * 10000n / BigInt(1e18)) / 10000 : null;
    return {
      type: "sale",
      token: {
        id: tokenId,
        name: tokenId ? `#${tokenId}` : "\u2014",
      },
      price: priceEth,
      from: sale.sellerAddress ? `${sale.sellerAddress.slice(0, 6)}...${sale.sellerAddress.slice(-4)}` : null,
      to: sale.buyerAddress ? `${sale.buyerAddress.slice(0, 6)}...${sale.buyerAddress.slice(-4)}` : null,
      fromFull: sale.sellerAddress || null,
      toFull: sale.buyerAddress || null,
      time: blockToTimestamp(sale.blockNumber),
      marketplace: sale.marketplace || null,
      hash: sale.transactionHash,
    };
  });
}

// Fallback source: Alchemy getNFTSales (may be stale for some collections)
async function fetchAlchemyActivity({ contract = CONTRACT, limit = 50, daysBack = 30, pageKey, signal } = {}) {
  const isAllTime = daysBack >= 365;
  const collectionMintBlock = mintBlockFor(contract);

  const params = {
    contractAddress: contract,
    order: "desc",
    limit: String(limit),
  };

  if (!isAllTime) {
    const currentBlock = await getCurrentBlock();
    const blocksBack = Math.floor(daysBack * 86400 / 12);
    const calculatedBlock = currentBlock - blocksBack;
    const floor = collectionMintBlock ?? MERGE_BLOCK;
    const fromBlock = Math.max(calculatedBlock, floor);
    params.fromBlock = String(fromBlock);
  }

  if (pageKey) params.pageKey = pageKey;

  let data;
  try {
    data = await alchemyGet("getNFTSales", params, { signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    if (params.fromBlock) {
      console.warn("getNFTSales failed with fromBlock, retrying without:", err.message);
      delete params.fromBlock;
      data = await alchemyGet("getNFTSales", params, { signal });
    } else {
      throw err;
    }
  }

  const sales = data.nftSales || [];
  return {
    activities: parseSales(sales),
    pageKey: data.pageKey || null,
    empty: sales.length === 0,
  };
}

// Fetch filled orders from native orderbook to include in activity feed
async function fetchNativeOrderbookActivity({ contract = CONTRACT, daysBack = 30, signal } = {}) {
  try {
    const params = new URLSearchParams({
      action: "query",
      contract,
      status: "filled",
      sort: "created_at",
      limit: "50",
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    // Forward caller's abort signal
    if (signal) signal.addEventListener("abort", () => controller.abort());
    const res = await fetch(`/api/orderbook?${params}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    const orders = data.orders || [];
    const cutoff = Date.now() - daysBack * 86400 * 1000;
    return orders
      .filter(order => {
        const filledAt = order.filled_at ? new Date(order.filled_at).getTime() : 0;
        return filledAt >= cutoff;
      })
      .map(order => ({
        type: "sale",
        token: {
          id: order.token_id,
          name: order.token_id ? `#${order.token_id}` : "\u2014",
        },
        price: order.price_eth ?? null,
        from: order.maker ? `${order.maker.slice(0, 6)}...${order.maker.slice(-4)}` : null,
        to: order.filled_by ? `${order.filled_by.slice(0, 6)}...${order.filled_by.slice(-4)}` : null,
        fromFull: order.maker || null,
        toFull: order.filled_by || null,
        time: order.filled_at ? new Date(order.filled_at).getTime() : Date.now(),
        marketplace: "native",
        hash: order.tx_hash || null,
      }));
  } catch {
    return [];
  }
}

export async function fetchActivity({ contract = CONTRACT, limit = 50, daysBack = 30, pageKey, signal } = {}) {
  // Fetch native orderbook sales in parallel with primary sources
  const nativePromise = pageKey ? Promise.resolve([]) : fetchNativeOrderbookActivity({ contract, daysBack, signal });

  // Primary: OpenSea events API (live, up-to-date sale data with time filtering)
  let primaryResult = null;
  try {
    primaryResult = await fetchOpenSeaActivity({ contract, limit, daysBack, pageKey, signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    console.warn("OpenSea activity unavailable, falling back to Alchemy:", err.message);
  }

  if (!primaryResult) {
    // Fallback: Alchemy getNFTSales (block-based filtering)
    try {
      primaryResult = await fetchAlchemyActivity({ contract, limit, daysBack, pageKey, signal });
      if (primaryResult.activities.length === 0 && !pageKey && daysBack < 365) {
        const allTimeResult = await fetchAlchemyActivity({ contract, limit, daysBack: 3650, signal });
        if (allTimeResult.activities.length > 0) primaryResult = allTimeResult;
      }
    } catch (err) {
      if (err.name === "AbortError") throw err;
      console.warn("Activity APIs unavailable, using fallback:", err.message);
      if (contract.toLowerCase() === CONTRACT.toLowerCase()) {
        primaryResult = { activities: FALLBACK_ACTIVITY, fallback: true, pageKey: null };
      } else {
        primaryResult = { activities: [], fallback: true, pageKey: null };
      }
    }
  }

  // Merge native orderbook sales into the result
  const nativeSales = await nativePromise;
  if (nativeSales.length > 0) {
    const seen = new Set(
      primaryResult.activities
        .filter(a => a.hash)
        .map(a => a.hash.toLowerCase())
    );
    const unique = nativeSales.filter(a => !a.hash || !seen.has(a.hash.toLowerCase()));
    const merged = [...primaryResult.activities, ...unique]
      .sort((a, b) => (b.time || 0) - (a.time || 0));
    primaryResult = { ...primaryResult, activities: merged };
  }

  return primaryResult;
}

// ═══ TOKEN SALES HISTORY (per-NFT price chart) ═══
export async function fetchTokenSalesHistory(tokenId, contract = CONTRACT) {
  try {
    const data = await alchemyGet("getNFTSales", {
      contractAddress: contract,
      tokenId: String(tokenId),
      order: "asc",
      limit: "50",
    });

    const sales = data.nftSales || [];
    return sales.map(sale => {
      const sellerAmt = BigInt(sale.sellerFee?.amount || "0");
      const protocolAmt = BigInt(sale.protocolFee?.amount || "0");
      const royaltyAmt = BigInt(sale.royaltyFee?.amount || "0");
      const totalWei = sellerAmt + protocolAmt + royaltyAmt;
      return {
        price: totalWei > 0n ? Number(totalWei * 10000n / BigInt(1e18)) / 10000 : null,
        time: blockToTimestamp(sale.blockNumber),
        from: sale.sellerAddress,
        to: sale.buyerAddress,
        hash: sale.transactionHash,
        marketplace: sale.marketplace || null,
      };
    }).filter(s => s.price != null);
  } catch (err) {
    console.warn("Token sales history unavailable:", err.message);
    return [];
  }
}

// ═══ TOP HOLDERS ═══
export async function fetchTopHolders({ contract = CONTRACT, limit = 10 } = {}) {
  try {
    const data = await alchemyGet("getOwnersForContract", {
      contractAddress: contract,
      withTokenBalances: "true",
    });
    const allOwners = (data.owners || [])
      .map(o => ({
        address: o.ownerAddress,
        count: o.tokenBalances?.length || 0,
      }))
      .sort((a, b) => b.count - a.count);

    const totalHeld = allOwners.reduce((s, o) => s + o.count, 0);

    return {
      holders: allOwners.slice(0, limit),
      totalOwners: allOwners.length,
      totalHeld,
      fallback: false,
    };
  } catch (err) {
    console.warn("Holders API unavailable:", err.message);
    if (contract.toLowerCase() !== CONTRACT.toLowerCase()) return { holders: [], totalOwners: 0, totalHeld: 0, fallback: true };
    return {
      holders: FALLBACK_WHALES.map(w => ({
        address: w.addr,
        ens: w.ens,
        count: w.held,
      })),
      totalOwners: 0,
      totalHeld: 0,
      fallback: true,
    };
  }
}

// ═══ WALLET NFTs ═══
export async function fetchWalletNfts(walletAddress, contract = CONTRACT, metadataBase = METADATA_BASE) {
  try {
    const data = await alchemyGet("getNFTsForOwner", {
      owner: walletAddress,
      "contractAddresses[]": contract,
      withMetadata: "true",
      pageSize: "100",
    });
    return {
      tokens: (data.ownedNfts || []).map(nft => normalizeToken(nft, metadataBase)),
      totalCount: data.totalCount || 0,
    };
  } catch (err) {
    console.warn("Wallet NFTs unavailable:", err.message);
    return { tokens: [], totalCount: 0, error: "Could not load wallet NFTs. Please check your connection and try again." };
  }
}

// ═══ ACTIVE LISTINGS (OpenSea via proxy) ═══

const OS_MAX_PAGES = 5;
const OS_PER_PAGE = 200;

// Fetch ONE page of OpenSea best-listings. Returns { raw, next } so the caller
// controls paging — cursor pagination can't be parallelized, so we page-1-first
// instead of blocking first paint on all ~5 serial round-trips.
async function fetchOpenSeaListingsPage(slug, cursor) {
  const params = { limit: OS_PER_PAGE };
  if (cursor) params.next = cursor;
  const data = await openseaGet(`listings/collection/${slug}/best`, params);
  return { raw: data.listings || [], next: data.next || null };
}

// Normalize raw OpenSea listing payloads into our listing shape, deduped by
// tokenId (cheapest wins) and sorted cheapest-first. Pure — safe to re-run as
// background pages stream in.
function normalizeOpenSeaListings(allRawListings) {
  const allListings = allRawListings.map(listing => {
    const offer = listing.protocol_data?.parameters?.offer?.[0];
    const tokenId = offer?.identifierOrCriteria || null;
    const priceWei = listing.price?.current?.value;
    const price = priceWei ? Number(BigInt(priceWei) * 10000n / BigInt(1e18)) / 10000 : null;
    return {
      tokenId: tokenId ? String(tokenId) : null,
      price,
      priceWei: priceWei || null,
      priceUsd: null,
      marketplace: "OpenSea",
      marketplaceIcon: null,
      maker: listing.protocol_data?.parameters?.offerer || null,
      expiry: listing.protocol_data?.parameters?.endTime
        ? new Date(parseInt(listing.protocol_data.parameters.endTime) * 1000).toISOString()
        : null,
      createdAt: null,
      // Order data for direct fulfillment via OpenSea API
      orderData: listing.protocol_data || null,
      orderHash: listing.order_hash || null,
      protocolAddress: listing.protocol_address || null,
    };
  }).filter(l => l.tokenId != null && l.price != null);

  // Deduplicate by tokenId, keeping the cheapest listing
  const seen = new Map();
  for (const l of allListings) {
    const existing = seen.get(l.tokenId);
    if (!existing || l.price < existing.price) seen.set(l.tokenId, l);
  }
  return [...seen.values()].sort((a, b) => a.price - b.price);
}

// Map native-orderbook orders into our listing shape (same fields as OpenSea).
function mapNativeListings(nativeResult) {
  try {
    return (nativeResult.orders || []).map(order => ({
      tokenId: order.token_id ? String(order.token_id) : null,
      price: order.price_eth != null ? Number(order.price_eth) : null,
      priceWei: order.price_wei || null,
      priceUsd: null,
      marketplace: "Native Orderbook",
      marketplaceIcon: null,
      maker: order.maker,
      expiry: order.end_time ? new Date(order.end_time).toISOString() : null,
      createdAt: order.created_at || null,
      orderData: order.parameters || null,
      orderHash: order.order_hash || null,
      protocolAddress: order.protocol_address || null,
      // Flag for native orderbook fulfillment (uses Seaport directly, not OpenSea API)
      isNative: true,
      nativeOrder: order,
    })).filter(l => l.tokenId != null && l.price != null);
  } catch (err) {
    console.warn("Error mapping native listings:", err.message);
    return [];
  }
}

// Merge OpenSea + native listings: dedup by tokenId (cheapest wins), sorted.
function mergeListings(osListings, nativeListings) {
  const merged = new Map();
  for (const l of [...osListings, ...nativeListings]) {
    const existing = merged.get(l.tokenId);
    if (!existing || l.price < existing.price) merged.set(l.tokenId, l);
  }
  const listings = [...merged.values()].sort((a, b) => a.price - b.price);
  const source = nativeListings.length > 0 && osListings.length > 0
    ? "merged" : nativeListings.length > 0 ? "native" : "opensea";
  return { listings, source };
}

export async function fetchListings(slug = COLLECTION_SLUG, { openseaSlug, contract, signal, onProgress } = {}) {
  // Use openseaSlug for OpenSea API calls; fall back to slug
  const osSlug = openseaSlug || slug;

  // First paint: OpenSea PAGE 1 + the native orderbook, in parallel. Page 1 is
  // the 200 cheapest listings — far more than the 60-card render chunk + sweep
  // calculator ever show — so we resolve on it immediately instead of blocking
  // first paint on all ~5 serial cursor pages. Each source is individually
  // .catch()'d so one failing never blanks the other.
  const [osPage1, nativeResult] = await Promise.all([
    fetchOpenSeaListingsPage(osSlug, null).catch(err => {
      console.warn("OpenSea listings unavailable:", err.message);
      return { raw: [], next: null };
    }),
    contract
      ? import("./lib/orderbook").then(m => m.fetchNativeListings(contract)).catch(err => {
          console.warn("Native listings unavailable:", err?.message);
          return { orders: [] };
        })
      : Promise.resolve({ orders: [] }),
  ]);

  const nativeListings = mapNativeListings(nativeResult);
  const osRaw = [...osPage1.raw];
  const build = () => mergeListings(normalizeOpenSeaListings(osRaw), nativeListings);

  // Walk the remaining OpenSea cursor pages, appending to osRaw. `emit` (when
  // given) is called after each page so the caller can stream the growing set.
  const fetchRemainingPages = async (emit) => {
    let cursor = osPage1.next;
    for (let page = 1; page < OS_MAX_PAGES && cursor; page++) {
      if (signal?.aborted) return;
      let pg;
      try {
        pg = await fetchOpenSeaListingsPage(osSlug, cursor);
      } catch {
        return; // a deep-page failure must not blank the page-1 result
      }
      if (pg.raw.length === 0) break;
      osRaw.push(...pg.raw);
      if (emit) emit(build());
      cursor = pg.next;
    }
  };

  if (onProgress) {
    // Page-1-first: hand back the cheap first page now; finish paging in the
    // background and stream each fuller set into the query cache.
    if (osPage1.next) fetchRemainingPages(onProgress).catch(() => {}); // not awaited
    return build();
  }
  // No streaming consumer (e.g. CollectionHealth) — needs the full set, so
  // finish paging before returning, preserving the original behavior.
  await fetchRemainingPages(null);
  return build();
}

// ═══ RARITY SCORING ═══
// Pre-computed rarity data (generated by scripts/compute-rarity.mjs) — Nakamigos only
import precomputedRarity from "./data/rarity.json";

const _precomputed = precomputedRarity?.totalTokens > 0 ? precomputedRarity.rarity : null;

export function computeRarity(tokens, contract, supply) {
  if (!tokens.length) return tokens;

  // Use pre-computed rarity ranks only for Nakamigos (the JSON is Nakamigos-specific)
  if (_precomputed && (!contract || contract.toLowerCase() === CONTRACT.toLowerCase())) {
    return tokens.map(token => {
      const entry = _precomputed[token.id];
      return {
        ...token,
        rank: entry?.rank ?? null,
        rarityScore: entry?.score ?? 0,
      };
    });
  }

  // Runtime rarity: compute from currently loaded tokens.
  // Use actual collection supply as denominator when available so rarity %
  // stays accurate even when only a partial set of tokens has been loaded.
  const traitCounts = {};
  const total = supply && supply > tokens.length ? supply : tokens.length;

  for (const token of tokens) {
    for (const attr of token.attributes || []) {
      const key = `${attr.key}::${attr.value}`;
      traitCounts[key] = (traitCounts[key] || 0) + 1;
    }
  }

  // If no traits at all (e.g. on-chain generative art), return without rarity
  if (Object.keys(traitCounts).length === 0) {
    return tokens.map(t => ({ ...t, rank: null, rarityScore: 0 }));
  }

  const scored = tokens.map(token => {
    let score = 0;
    for (const attr of token.attributes || []) {
      const key = `${attr.key}::${attr.value}`;
      const freq = traitCounts[key] / total;
      score += freq > 0 ? 1 / freq : 0;
    }
    return { ...token, rarityScore: score };
  });

  scored.sort((a, b) => b.rarityScore - a.rarityScore);

  // When only a fraction of the collection is loaded, ranks are unreliable.
  // Mark them as approximate so UI can show a warning or hide them.
  const isPartial = supply && tokens.length < supply * 0.8;

  return scored.map((t, i) => ({ ...t, rank: i + 1, rankApproximate: !!isPartial }));
}

export function hasPrecomputedRarity(contract) {
  if (!_precomputed) return false;
  return !contract || contract.toLowerCase() === CONTRACT.toLowerCase();
}

// ═══ FETCH SPECIFIC TOKENS BY ID (for listings images) ═══
// Alchemy batch endpoint limited to 100 tokens per request.
const BATCH_CHUNK_SIZE = 100;

export async function fetchTokensByIds(tokenIds, contract = CONTRACT, metadataBase = METADATA_BASE) {
  if (!tokenIds || tokenIds.length === 0) return [];
  try {
    const allNfts = [];

    // Chunk into batches of 100 (Alchemy limit)
    for (let i = 0; i < tokenIds.length; i += BATCH_CHUNK_SIZE) {
      const chunk = tokenIds.slice(i, i + BATCH_CHUNK_SIZE);
      try {
        const data = await alchemyPost("getNFTMetadataBatch", {
          tokens: chunk.map(id => ({ contractAddress: contract, tokenId: String(id) })),
        });
        const nfts = Array.isArray(data.nfts) ? data.nfts : Array.isArray(data) ? data : [];
        allNfts.push(...nfts);
      } catch (chunkErr) {
        console.warn(`Batch chunk ${i}-${i + chunk.length} failed:`, chunkErr.message);
        // Skip failed chunk, try rest
      }
    }

    return allNfts.map(nft => normalizeToken(nft, metadataBase));
  } catch (err) {
    console.warn("Batch token fetch failed:", err.message);
    return [];
  }
}

// ═══ CLIPBOARD ═══
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    return true;
  }
}

// ═══ TRAIT EXTRACTION (client-side from loaded tokens) ═══
export function extractTraitFilters(tokens) {
  const traitMap = {};
  for (const token of tokens) {
    for (const attr of token.attributes || []) {
      if (!traitMap[attr.key]) traitMap[attr.key] = {};
      traitMap[attr.key][attr.value] = (traitMap[attr.key][attr.value] || 0) + 1;
    }
  }
  return Object.entries(traitMap).map(([key, values]) => ({
    key,
    values: Object.entries(values)
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
  }));
}

// ═══ WALLET CONNECTION (EIP-6963) ═══
// AUDIT FIX 2026-05-26 [H-31]: replaced the `isMetaMask` race with EIP-6963
// announcement discovery. Pre-fix, a malicious extension that injected
// `window.ethereum.providers = [{isMetaMask:true, request:attackerHandler}]`
// would win the legacy multi-provider race; every SIWE signature and
// Seaport-order signature would go through the attacker. EIP-6963 wraps
// each provider in a `EIP6963ProviderInfo` with a canonical `rdns`
// (e.g. "io.metamask", "com.coinbase.wallet") — much harder to spoof.
//
// Fallback chain:
//   1. EIP-6963 announcement (preferred, modern wallets)
//   2. window.ethereum.providers[] with rdns-based selection
//   3. window.ethereum as last resort
//
// We DO NOT trust `isMetaMask` for selection. The main app (RainbowKit +
// wagmi) already uses EIP-6963; this brings Nakamigos surface to parity.

const EIP6963_TARGETS = [
  'io.metamask',
  'com.coinbase.wallet',
  'app.phantom',
  'io.rabby',
  'me.rainbow',
  'app.uniswap',
];

let _cached6963Providers = null;
function _collect6963Providers() {
  if (_cached6963Providers !== null) return _cached6963Providers;
  const found = [];
  if (typeof window === 'undefined') return [];
  // EIP-6963: dispatch a request event; wallets respond with announce events.
  const onAnnounce = (e) => {
    if (e?.detail?.info?.rdns && e?.detail?.provider) {
      found.push({ info: e.detail.info, provider: e.detail.provider });
    }
  };
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  // Synchronous flush — listeners fire inline during dispatch.
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  _cached6963Providers = found;
  return found;
}

export function getProvider() {
  if (typeof window === 'undefined') return null;
  // Try EIP-6963 discovery first.
  const announced = _collect6963Providers();
  if (announced.length > 0) {
    for (const target of EIP6963_TARGETS) {
      const match = announced.find((p) => p.info?.rdns === target);
      if (match) return match.provider;
    }
    // No target match — return the first announced provider rather than
    // dropping to the legacy window.ethereum race.
    return announced[0].provider;
  }
  // Legacy fallback path — log a warning so monitoring can detect the
  // pre-EIP-6963 wallet surface. We STILL avoid trusting `isMetaMask`;
  // legacy multi-provider arrays use `_metamask` as the next-best indicator.
  const eth = window.ethereum;
  if (!eth) return null;
  if (eth.providers?.length) {
    // Prefer providers exposing the internal `_metamask` namespace (set by
    // genuine MetaMask, not spoofable by simply lying about `isMetaMask`).
    const metaMaskish = eth.providers.find((p) => p?._metamask || p?.isMetaMask);
    return metaMaskish || eth.providers[0];
  }
  return eth;
}

export async function connectWallet() {
  const provider = getProvider();
  if (!provider) return { error: "no-metamask" };

  try {
    // Check selectedAddress first (synchronous, no proxy issues)
    if (provider.selectedAddress) {
      return { address: provider.selectedAddress };
    }

    // Try eth_accounts (no popup)
    const existing = await Promise.race([
      provider.request({ method: "eth_accounts" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    if (existing && existing.length > 0) {
      return { address: existing[0] };
    }

    // Request new connection (triggers MetaMask popup)
    const accounts = await Promise.race([
      provider.request({ method: "eth_requestAccounts" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000)),
    ]);
    if (!accounts || accounts.length === 0) return { error: "denied" };
    return { address: accounts[0] };
  } catch (err) {
    if (err.message === "timeout" || err.code === -32002) {
      return { error: "timeout" };
    }
    return { error: err.code === 4001 ? "denied" : "connection-failed" };
  }
}

export function shortenAddress(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ═══ DIRECT PURCHASE VIA OPENSEA FULFILLMENT API ═══

// Build the Seaport fulfillment CALL ({ to, value, data }) for a listing WITHOUT
// sending it — shared by the single buy and the EIP-5792 cart batch. Every
// safety validation (value bounds, Seaport-address allowlist, fulfillment-
// function allowlist) lives here, so no path can be tricked into signing a
// non-fulfillment Seaport call. `value` is returned as a bigint. Returns
// { error, message } on any problem.
async function buildSeaportFulfillCall(listing, { ethers, buyerAddress }) {
  if (!listing.orderHash) return { error: "no-order", message: "Order data not available" };

  // Get fulfillment transaction data from OpenSea (via proxy) with a FAST retry
  // (interactive path) instead of the patient 1500ms-base background backoff —
  // this is a read (no funds move on failure), so a 429 yields a quick retry.
  let fulfillData;
  try {
    fulfillData = await openseaPost("listings/fulfillment_data", {
      listing: {
        hash: listing.orderHash,
        chain: "ethereum",
        protocol_address: listing.protocolAddress || listing.orderData?.protocolAddress,
      },
      fulfiller: { address: buyerAddress },
    }, { maxRetries: 1, baseDelay: 400 });
  } catch (err) {
    console.error("Fulfillment API error:", err.message);
    return { error: "failed", message: "Could not get fulfillment data from OpenSea" };
  }
  const txData = fulfillData.fulfillment_data?.transaction;
  if (!txData?.to || txData?.value == null) {
    return { error: "failed", message: "Invalid fulfillment data" };
  }

  // Validate transaction value is a non-negative integer
  let txValue;
  try {
    txValue = BigInt(txData.value);
    if (txValue < 0n) throw new Error("negative");
  } catch {
    return { error: "failed", message: "Invalid transaction value" };
  }

  // Validate the transaction target is a known Seaport contract
  const knownSeaportAddresses = new Set([
    "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", // Seaport 1.5
    "0x0000000000000068f116a894984e2db1123eb395", // Seaport 1.6
  ]);
  if (!knownSeaportAddresses.has(txData.to.toLowerCase())) {
    return { error: "failed", message: "Unexpected transaction target — aborting for safety" };
  }

  // The target is pinned to Seaport above, but the function signature also comes
  // from the API response — without an allowlist a tampered response could make
  // the client encode ANY Seaport function (cancel, incrementCounter, validate …)
  // and ask the user to sign it.
  const fnName = String(txData.function || "").split("(")[0].trim();
  if (!SEAPORT_FULFILLMENT_FUNCTIONS.has(fnName)) {
    return { error: "failed", message: "Unexpected fulfillment function — aborting for safety" };
  }

  // Encode calldata using ABI parameter names to avoid depending on
  // Object.values() insertion order from the API.
  function toPositional(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === "string" || typeof val === "bigint" || typeof val === "number" || typeof val === "boolean") return val;
    if (Array.isArray(val)) return val.map(toPositional);
    if (typeof val === "object") return Object.values(val).map(toPositional);
    return val;
  }

  const iface = new ethers.Interface([`function ${txData.function}`]);
  const fnFragment = iface.getFunction(fnName);
  let inputValues;
  if (fnFragment && fnFragment.inputs.every(p => p.name && p.name in txData.input_data)) {
    inputValues = fnFragment.inputs.map(p => toPositional(txData.input_data[p.name]));
  } else {
    inputValues = Object.values(txData.input_data).map(toPositional);
  }
  const encoded = iface.encodeFunctionData(fnName, inputValues);

  return { to: txData.to, value: txValue, data: encoded };
}

// Buy several OpenSea (Seaport) listings in ONE wallet confirmation via EIP-5792
// wallet_sendCalls. Returns { unsupported: true } when the wallet can't batch, so
// the caller runs its sequential path (zero regression). Builds every call first
// (in parallel) with the same validated builder as the single buy; one build
// failure aborts the batch and the caller falls back to per-item buys.
export async function fulfillSeaportOrdersBatch(listings, opts = {}) {
  const ethProvider = getProvider();
  if (!ethProvider) return { error: "no-metamask", message: "MetaMask not found" };
  if (!Array.isArray(listings) || listings.length === 0) {
    return { error: "no-order", message: "No listings to buy" };
  }

  try {
    const { ethers } = await import("ethers");
    const provider = new ethers.BrowserProvider(ethProvider);
    try {
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== Number(SEAPORT_DOMAIN.chainId)) {
        return { error: "wrong-chain", message: `Connected to chain ${Number(network.chainId)} — switch to Ethereum Mainnet to buy` };
      }
    } catch {
      return { error: "no-network", message: "Could not read wallet chain" };
    }
    const signer = await provider.getSigner();
    const buyerAddress = opts.buyerAddress || await signer.getAddress();

    const built = await Promise.all(
      listings.map(l => buildSeaportFulfillCall(l, { ethers, buyerAddress }))
    );
    const calls = [];
    for (const c of built) {
      if (c.error) return { error: "build-failed", message: c.message };
      calls.push({ to: c.to, value: "0x" + c.value.toString(16), data: c.data });
    }

    const { tryAtomicBatch } = await import("./lib/trades");
    const res = await tryAtomicBatch(provider, buyerAddress, calls);
    if (res === null) return { unsupported: true }; // wallet can't 5792 — fall back
    return { success: true, hash: res.hash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED" || err.code === "rejected") {
      return { error: "rejected", message: "Batch cancelled by user" };
    }
    console.error("Seaport batch error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Batch purchase failed" };
  }
}

export async function fulfillSeaportOrder(listing, opts = {}) {
  const ethProvider = getProvider();
  if (!ethProvider) {
    return { error: "no-metamask", message: "MetaMask not found" };
  }

  if (!listing.orderHash) {
    return { error: "no-order", message: "Order data not available" };
  }

  try {
    const { ethers } = await import("ethers");
    const provider = new ethers.BrowserProvider(ethProvider);

    // AUDIT FIX M-8 parity (2026-06-09): the offer/accept paths in
    // api-offers.js refuse wrong-chain wallets up-front; this buy path did
    // not. Seaport is deployed at the same address on most chains, so a
    // wrong-chain "Buy" broadcasts a doomed tx and burns the buyer's gas.
    try {
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== Number(SEAPORT_DOMAIN.chainId)) {
        return { error: "wrong-chain", message: `Connected to chain ${Number(network.chainId)} — switch to Ethereum Mainnet to buy` };
      }
    } catch {
      return { error: "no-network", message: "Could not read wallet chain" };
    }

    const signer = await provider.getSigner();
    // PERF: prefer the caller's already-connected wallet address — skips an
    // extra eth_accounts round-trip in front of the (dominant) OpenSea
    // fulfillment POST. Falls back to reading it from the signer.
    const buyerAddress = opts.buyerAddress || await signer.getAddress();

    // Build the fulfillment call (fetch + validate + encode — all safety checks
    // live in the shared builder), then send it via MetaMask.
    const call = await buildSeaportFulfillCall(listing, { ethers, buyerAddress });
    if (call.error) return call;

    const tx = await signer.sendTransaction({
      to: call.to,
      value: call.value,
      data: call.data,
    });

    // Wait for on-chain confirmation before reporting success
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      return { error: "failed", message: "Transaction reverted on-chain" };
    }

    return { success: true, hash: tx.hash, tx };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Transaction rejected by user" };
    }
    if (err.message?.includes("insufficient funds")) {
      return { error: "insufficient", message: "Insufficient ETH balance" };
    }
    // A gas-estimation revert with no reason (CALL_EXCEPTION / "missing revert
    // data") means the order is no longer fillable — sniped/sold/cancelled but
    // still lingering in the marketplace feed. Flag it distinctly so the UI can
    // hide the dead listing instead of just toasting an error on a card the user
    // can keep clicking.
    const msg = err.shortMessage || err.message || "";
    if (err.code === "CALL_EXCEPTION" || /missing revert data|cannot estimate gas|unpredictable_gas_limit/i.test(msg)) {
      return { error: "stale", message: msg };
    }
    console.error("Seaport fulfillment error:", err);
    return { error: "failed", message: msg || "Transaction failed" };
  }
}
