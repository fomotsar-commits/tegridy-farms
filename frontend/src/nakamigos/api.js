import { CONTRACT, COLLECTION_SLUG, COLLECTIONS, METADATA_BASE, FALLBACK_NFTS, FALLBACK_STATS, FALLBACK_ACTIVITY, FALLBACK_WHALES } from "./constants";
import { alchemyGet as proxyAlchemyGet, alchemyPost as proxyAlchemyPost, openseaGet as rawOpenseaGet, openseaPost as rawOpenseaPost, ApiError } from "./lib/proxy";

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

function openseaPost(path, body, { signal } = {}) {
  return withRetry(() => rawOpenseaPost(path, body, { signal }), { maxRetries: 2, baseDelay: 1500, signal });
}

// Normalize an Alchemy NFT object
function normalizeToken(nft, metadataBase = METADATA_BASE) {
  const attrs = nft.raw?.metadata?.attributes || [];
  // Only build a fallback IPFS image URL when metadataBase is set (Nakamigos only)
  const fallbackImage = metadataBase ? `${metadataBase}/${nft.tokenId}.png` : null;
  // Also check raw metadata image (some collections store image URL only there)
  const rawMetaImage = nft.raw?.metadata?.image || null;
  const resolvedImage = nft.image?.cachedUrl || nft.image?.pngUrl || nft.image?.originalUrl || nft.image?.thumbnailUrl || rawMetaImage || fallbackImage;
  return {
    id: nft.tokenId,
    name: nft.name || nft.raw?.metadata?.name || `#${nft.tokenId}`,
    image: resolvedImage,
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

export async function fetchCollectionStats({ contract = CONTRACT, slug = COLLECTION_SLUG, openseaSlug, signal } = {}) {
  // Use openseaSlug for OpenSea API calls; fall back to slug
  const osSlug = openseaSlug || slug;
  const knownSupply = configSupplyFor(contract);

  try {
    // Alchemy — works with API key, no extra auth needed
    // Fetch floor price, owner count, AND on-chain totalSupply for accurate live data
    const [floorData, ownersData, metaData] = await Promise.all([
      alchemyGet("getFloorPrice", { contractAddress: contract }, { signal }),
      alchemyGet("getOwnersForContract", { contractAddress: contract, withTokenBalances: "false" }, { signal }),
      alchemyGet("getContractMetadata", { contractAddress: contract }, { signal }).catch(() => null),
    ]);

    const floor = floorData.openSea?.floorPrice ?? null;
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

export async function fetchActivity({ contract = CONTRACT, limit = 50, daysBack = 30, pageKey, signal } = {}) {
  // Primary: OpenSea events API (live, up-to-date sale data with time filtering)
  try {
    const result = await fetchOpenSeaActivity({ contract, limit, daysBack, pageKey, signal });
    // Return even if empty — an empty result for a narrow time window is valid data
    return result;
  } catch (err) {
    if (err.name === "AbortError") throw err;
    console.warn("OpenSea activity unavailable, falling back to Alchemy:", err.message);
  }

  // Fallback: Alchemy getNFTSales (block-based filtering)
  try {
    const result = await fetchAlchemyActivity({ contract, limit, daysBack, pageKey, signal });
    if (result.activities.length > 0) return result;

    // If Alchemy returned nothing for a bounded window, widen to all-time
    if (!pageKey && daysBack < 365) {
      const allTimeResult = await fetchAlchemyActivity({ contract, limit, daysBack: 3650, signal });
      if (allTimeResult.activities.length > 0) return allTimeResult;
    }

    return result;
  } catch (err) {
    if (err.name === "AbortError") throw err;
    console.warn("Activity APIs unavailable, using fallback:", err.message);
    if (contract.toLowerCase() === CONTRACT.toLowerCase()) {
      return { activities: FALLBACK_ACTIVITY, fallback: true, pageKey: null };
    }
    return { activities: [], fallback: true, pageKey: null };
  }
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

async function fetchOpenSeaListings(slug = COLLECTION_SLUG) {
  const MAX_PAGES = 5;
  const PER_PAGE = 200;
  const allRawListings = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = { limit: PER_PAGE };
    if (cursor) params.next = cursor;

    const data = await openseaGet(`listings/collection/${slug}/best`, params);

    const pageListings = data.listings || [];
    allRawListings.push(...pageListings);

    // Stop if no next cursor or empty page
    if (!data.next || pageListings.length === 0) break;
    cursor = data.next;
  }

  if (allRawListings.length === 0) return { listings: [], source: "opensea" };

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

  return {
    listings: [...seen.values()].sort((a, b) => a.price - b.price),
    source: "opensea",
  };
}

export async function fetchListings(slug = COLLECTION_SLUG, { openseaSlug } = {}) {
  // Use openseaSlug for OpenSea API calls; fall back to slug
  const osSlug = openseaSlug || slug;
  // OpenSea is the primary listing source (Reservoir shut down Oct 2025)
  try {
    const result = await fetchOpenSeaListings(osSlug);
    // Return whatever OpenSea gave us — even if empty (0 active listings is valid, not an error)
    return result;
  } catch (err) {
    console.warn("OpenSea listings unavailable:", err.message);
  }

  return { listings: [], source: null, error: "Listing data temporarily unavailable" };
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

// ═══ WALLET CONNECTION (MetaMask) ═══
// Get the real MetaMask provider, bypassing any multi-wallet proxy
export function getProvider() {
  const eth = window.ethereum;
  if (!eth) return null;
  if (eth.providers?.length) {
    return eth.providers.find(p => p.isMetaMask) || eth.providers[0];
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
export async function fulfillSeaportOrder(listing) {
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
    const signer = await provider.getSigner();
    const buyerAddress = await signer.getAddress();

    // Step 1: Get fulfillment transaction data from OpenSea (via proxy)
    let fulfillData;
    try {
      fulfillData = await openseaPost("listings/fulfillment_data", {
        listing: {
          hash: listing.orderHash,
          chain: "ethereum",
          protocol_address: listing.protocolAddress || listing.orderData?.protocolAddress,
        },
        fulfiller: { address: buyerAddress },
      });
    } catch (err) {
      console.error("Fulfillment API error:", err.message);
      return { error: "failed", message: "Could not get fulfillment data from OpenSea" };
    }
    const txData = fulfillData.fulfillment_data?.transaction;

    if (!txData?.to || !txData?.value) {
      return { error: "failed", message: "Invalid fulfillment data" };
    }

    // Validate the transaction target is a known Seaport contract
    const knownSeaportAddresses = new Set([
      "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", // Seaport 1.5
      "0x0000000000000068f116a894984e2db1123eb395", // Seaport 1.6
    ]);
    if (!knownSeaportAddresses.has(txData.to.toLowerCase())) {
      return { error: "failed", message: "Unexpected transaction target — aborting for safety" };
    }

    // Step 2: Encode calldata using ABI parameter names to avoid
    // depending on Object.values() insertion order from the API.
    function toPositional(val) {
      if (val === null || val === undefined) return val;
      if (typeof val === "string" || typeof val === "bigint" || typeof val === "number" || typeof val === "boolean") return val;
      if (Array.isArray(val)) return val.map(toPositional);
      if (typeof val === "object") return Object.values(val).map(toPositional);
      return val;
    }

    const iface = new ethers.Interface([`function ${txData.function}`]);
    const fnName = txData.function.split("(")[0];
    const fnFragment = iface.getFunction(fnName);

    // Map by ABI parameter name when available, fall back to positional order
    let inputValues;
    if (fnFragment && fnFragment.inputs.every(p => p.name && p.name in txData.input_data)) {
      inputValues = fnFragment.inputs.map(p => toPositional(txData.input_data[p.name]));
    } else {
      inputValues = Object.values(txData.input_data).map(toPositional);
    }
    const encoded = iface.encodeFunctionData(fnName, inputValues);

    // Step 3: Send the transaction via MetaMask
    const tx = await signer.sendTransaction({
      to: txData.to,
      value: BigInt(txData.value),
      data: encoded,
    });

    return { success: true, hash: tx.hash, tx };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Transaction rejected by user" };
    }
    if (err.message?.includes("insufficient funds")) {
      return { error: "insufficient", message: "Insufficient ETH balance" };
    }
    console.error("Seaport fulfillment error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Transaction failed" };
  }
}
