import { useMemo, useState, useEffect, useCallback, memo } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import SweepCalculator from "./SweepCalculator";
import CollectionOffersPanel from "./CollectionOffersPanel";
import OrderBookPanel from "./OrderBookPanel";
import DepthChart from "./DepthChart";
import MakeOfferModal from "./MakeOfferModal";
import { OPENSEA_ITEM } from "../constants";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useTradingMode } from "../contexts/TradingModeContext";
import { fetchTokensByIds, fulfillSeaportOrder } from "../api";
import { fulfillNativeOrder } from "../lib/orderbook";
import { recordTransaction } from "../lib/transactions";
import { getFriendlyError } from "../lib/errorMessages";
import { fetchCollectionOffers, fetchBestOffer } from "../api-offers";

/* ── Sort helpers ── */
const SORT_OPTIONS = [
  { id: "price-asc", label: "Price: Low → High" },
  { id: "price-desc", label: "Price: High → Low" },
  { id: "rank-asc", label: "Rank: Best First" },
  { id: "rank-desc", label: "Rank: Highest #" },
  { id: "id-asc", label: "Token ID: Low" },
  { id: "id-desc", label: "Token ID: High" },
];

const SALE_SORT_OPTIONS = [
  { id: "time-desc", label: "Most Recent" },
  { id: "time-asc", label: "Oldest First" },
  { id: "price-asc", label: "Price: Low → High" },
  { id: "price-desc", label: "Price: High → Low" },
  { id: "id-asc", label: "Token ID: Low" },
  { id: "id-desc", label: "Token ID: High" },
];

function sortNfts(nfts, sortId) {
  const sorted = [...nfts];
  switch (sortId) {
    case "price-asc":
      return sorted.sort((a, b) => (a.price || 0) - (b.price || 0));
    case "price-desc":
      return sorted.sort((a, b) => (b.price || 0) - (a.price || 0));
    case "rank-asc":
      return sorted.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    case "rank-desc":
      return sorted.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity));
    case "id-asc":
      return sorted.sort((a, b) => Number(a.id) - Number(b.id));
    case "id-desc":
      return sorted.sort((a, b) => Number(b.id) - Number(a.id));
    default:
      return sorted;
  }
}

function sortSales(sales, sortId) {
  const sorted = [...sales];
  switch (sortId) {
    case "time-desc":
      return sorted.sort((a, b) => (b.time || 0) - (a.time || 0));
    case "time-asc":
      return sorted.sort((a, b) => (a.time || 0) - (b.time || 0));
    case "price-asc":
      return sorted.sort((a, b) => (a.salePrice || 0) - (b.salePrice || 0));
    case "price-desc":
      return sorted.sort((a, b) => (b.salePrice || 0) - (a.salePrice || 0));
    case "id-asc":
      return sorted.sort((a, b) => Number(a.id) - Number(b.id));
    case "id-desc":
      return sorted.sort((a, b) => Number(b.id) - Number(a.id));
    default:
      return sorted;
  }
}

/* ── Time ago formatter ── */
function formatTimeAgo(ts) {
  if (!ts) return "";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Memoized listing card. Extracted from the inline grid map so a per-card async
// state change (best-offer arriving, a checkbox toggle, the buying spinner) only
// re-renders the ONE affected card instead of cascading through the whole grid.
// Every value the card reads is a prop, and the handlers are stable useCallbacks
// — so React.memo can actually skip the untouched cards. Pairs with the
// content-visibility:auto on .listing-card, which skips off-screen paint.
const ListingCard = memo(function ListingCard({
  nft, isSelected, isBuying, bestOffer, hasRealListings, floor, wallet, collectionContract,
  onPick, onToggleSelect, onBuy, onAddToCart,
}) {
  const handleClick = useCallback(() => onPick(nft), [onPick, nft]);
  const handleKeyDown = useCallback((e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(nft); }
  }, [onPick, nft]);
  const handleSelect = useCallback((e) => { e.stopPropagation(); onToggleSelect(nft.id); }, [onToggleSelect, nft.id]);
  const handleBuyClick = useCallback((e) => onBuy(nft, e), [onBuy, nft]);
  const handleAddToCart = useCallback((e) => { e.stopPropagation(); onAddToCart?.(nft); }, [onAddToCart, nft]);

  const isOwnListing = wallet && nft.maker && nft.maker.toLowerCase() === wallet.toLowerCase();

  return (
    <div className="listing-card" onClick={handleClick} onKeyDown={handleKeyDown} role="button" tabIndex={0} aria-label={`${nft.name}${nft.price ? `, ${nft.price} ETH` : ""}`} style={isSelected ? { border: "2px solid var(--naka-blue)" } : undefined}>
      <div className="listing-card-image">
        <NftImage nft={nft} noSelfFetch={nft.imagePending} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        {nft.rank && <div className="listing-card-rank">#{nft.rank}</div>}
        {nft.marketplace && (
          <div style={{
            position: "absolute", top: 6, left: 6, padding: "2px 6px",
            borderRadius: 4, fontSize: 9, fontFamily: "var(--mono)",
            background: "rgba(0,0,0,0.7)", color: "#fff", letterSpacing: "0.04em",
          }}>
            {nft.marketplace}
          </div>
        )}
        {/* Batch select checkbox */}
        {hasRealListings && nft.price && (
          <div
            onClick={handleSelect}
            style={{
              position: "absolute", top: 6, right: 6,
              width: 20, height: 20, borderRadius: 4,
              background: isSelected ? "var(--naka-blue)" : "rgba(0,0,0,0.5)",
              border: isSelected ? "none" : "1px solid rgba(255,255,255,0.2)",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", fontSize: 12, color: "#fff", fontWeight: 700,
              transition: "background 0.15s",
            }}
          >
            {isSelected ? "✓" : ""}
          </div>
        )}
      </div>
      <div className="listing-card-body">
        <div className="listing-card-name">{nft.name}</div>
        {nft.price ? (
          <div className="listing-card-price">
            <Eth size={12} /> {nft.price.toFixed(4)}
            {nft.priceUsd && (
              <span className="listing-card-usd" style={{ marginLeft: 6 }}>
                ${nft.priceUsd.toFixed(0)}
              </span>
            )}
          </div>
        ) : nft.salePrice ? (
          <div className="listing-card-price" style={{ color: "var(--text-dim)" }}>
            <Eth size={12} /> {nft.salePrice.toFixed(4)}
            <span style={{ fontSize: 9, color: "var(--text-dim)", marginLeft: 4 }}>sold</span>
            {nft.time && (
              <span style={{ fontSize: 9, color: "var(--text-muted)", marginLeft: 4 }}>
                {formatTimeAgo(nft.time)}
              </span>
            )}
          </div>
        ) : (
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
            {floor != null ? `Floor: ${floor.toFixed(4)} ETH` : "View on marketplace"}
          </div>
        )}
        {bestOffer && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--naka-blue)", marginTop: 2 }}>
            Best offer: <Eth size={8} /> {bestOffer.toFixed(4)}
          </div>
        )}
        <div className="listing-card-actions">
          {nft.orderHash && nft.price ? (
            isOwnListing ? (
              <span className="listing-btn-buy" style={{ opacity: 0.5, cursor: "default", pointerEvents: "none" }}>
                Your Listing
              </span>
            ) : (
            <div style={{ display: "flex", gap: 4 }}>
              {onAddToCart && (
                <button
                  className="listing-btn-buy"
                  onClick={handleAddToCart}
                  aria-label="Add to cart"
                  title="Add to cart"
                  style={{ flex: "0 0 auto", width: 30, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <path d="M16 10a4 4 0 01-8 0" />
                  </svg>
                </button>
              )}
              <button
                className="listing-btn-buy"
                disabled={isBuying}
                onClick={handleBuyClick}
                style={{ flex: 1, cursor: isBuying ? "wait" : "pointer" }}
              >
                {isBuying ? "Buying..." : !wallet ? "Connect & Buy" : "Buy Now"}
              </button>
            </div>
            )
          ) : (
            <a
              href={OPENSEA_ITEM(nft.id, collectionContract)}
              target="_blank"
              rel="noopener noreferrer"
              className="listing-btn-buy"
              onClick={(e) => e.stopPropagation()}
            >
              {nft.price ? "Buy on OpenSea" : "OpenSea"}
            </a>
          )}
        </div>
      </div>
    </div>
  );
});

export default function Listings({ tokens, stats, listings, listingsLoading, listingsError, listingsSource, activities, activitiesLoading, activitiesEmpty, onPick, wallet, onConnect, addToast, onAddToCart }) {
  const collection = useActiveCollection();
  const { isLite } = useTradingMode();
  const [extraTokens, setExtraTokens] = useState([]);
  const [sortBy, setSortBy] = useState("price-asc");
  const [saleSortBy, setSaleSortBy] = useState("time-desc");
  const [maxPrice, setMaxPrice] = useState("");
  const [purchasedIds, setPurchasedIds] = useState(new Set());

  // Batch selection state
  const [selectedIds, setSelectedIds] = useState(new Set());
  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Order book: fetch collection offers for bid side
  const osSlug = collection.openseaSlug || collection.slug;
  const [collectionOffers, setCollectionOffers] = useState([]);
  useEffect(() => {
    setCollectionOffers([]);
    fetchCollectionOffers(osSlug)
      .then(setCollectionOffers)
      .catch((err) => console.warn('[Listings] fetchCollectionOffers failed:', err?.message ?? err));
  }, [osSlug]);

  // Trait offer state
  const [traitOfferOpen, setTraitOfferOpen] = useState(false);
  const [traitCategory, setTraitCategory] = useState("");
  const [traitValue, setTraitValue] = useState("");
  const [showTraitOfferModal, setShowTraitOfferModal] = useState(null);

  // Fetch metadata for listed tokens AND recent sale tokens not in gallery data
  useEffect(() => {
    // Already-fetched extras count as "known" too — otherwise every activities
    // poll (new array each 60s) and every gallery page re-requests all listed +
    // sale ids even though nothing is actually missing (F569).
    const knownIds = new Set([
      ...tokens.map(t => String(t.id)),
      ...extraTokens.map(t => String(t.id)),
    ]);

    // Collect token IDs from listings
    const listingIds = (listings || []).map(l => String(l.tokenId));

    // Collect token IDs from recent sales (activities)
    const saleIds = (activities || [])
      .filter(a => a.type === "sale" && a.token?.id)
      .map(a => String(a.token.id));

    const allNeededIds = [...listingIds, ...saleIds];
    const missingIds = allNeededIds.filter(id => !knownIds.has(id));
    const uniqueMissing = [...new Set(missingIds)];
    if (uniqueMissing.length === 0) return;

    let cancelled = false;
    fetchTokensByIds(uniqueMissing, collection.contract, collection.metadataBase).then(fetched => {
      // Merge with existing extras so prior fetches aren't dropped.
      if (!cancelled && fetched.length > 0) {
        setExtraTokens(prev => {
          const map = new Map(prev.map(t => [String(t.id), t]));
          for (const t of fetched) map.set(String(t.id), t);
          return [...map.values()];
        });
      }
    });
    return () => { cancelled = true; };
  }, [listings, activities, tokens, extraTokens, collection.contract, collection.metadataBase]);

  // Combined token lookup: gallery tokens + fetched extras
  const allTokens = useMemo(() => {
    const map = new Map();
    for (const t of tokens) map.set(String(t.id), t);
    for (const t of extraTokens) map.set(String(t.id), t);
    return map;
  }, [tokens, extraTokens]);

  // Merge listing data with token metadata where possible
  const listedNfts = useMemo(() => {
    if (!listings || listings.length === 0) return [];

    // Only build a `${metadataBase}/<id>.png` URL when this collection actually
    // serves one (Nakamigos's 404s — see api.js hasDeterministicImage / F568).
    const deterministicImg = collection.deterministicImage !== false;
    return listings.filter(listing => !purchasedIds.has(String(listing.tokenId))).map(listing => {
      const token = allTokens.get(String(listing.tokenId));
      const fullResImg = collection.metadataBase && deterministicImg
        ? `${collection.metadataBase}/${listing.tokenId}.png`
        : null;
      return {
        id: listing.tokenId,
        name: token?.name || `${collection.name} #${listing.tokenId}`,
        // No deterministic image URL exists (Nakamigos metadata points at
        // per-token IPFS CIDs; the old CDN contract/tokenId format 403s now).
        // Leave null and let the batched fetchTokensByIds enrichment fill it —
        // imagePending suppresses NftImage's per-card metadata fetch, whose
        // 60-call mount storm tripped the proxy rate limit and froze the buy
        // grid as letter placeholders for minutes (prod 2026-06-11).
        image: token?.image || null,
        imagePending: !token,
        imageLarge: token?.imageLarge || fullResImg,
        attributes: token?.attributes || [],
        rank: token?.rank || null,
        price: listing.price,
        priceWei: listing.priceWei,
        priceUsd: listing.priceUsd,
        marketplace: listing.marketplace,
        marketplaceIcon: listing.marketplaceIcon,
        maker: listing.maker,
        owner: token?.owner || listing.maker,
        orderData: listing.orderData,
        orderHash: listing.orderHash,
        protocolAddress: listing.protocolAddress,
        isNative: listing.isNative || false,
        nativeOrder: listing.nativeOrder || null,
      };
    });
  }, [listings, allTokens, collection, purchasedIds]);

  // Best offers per token (batch-fetch for first 20 listed NFTs)
  const [bestOffers, setBestOffers] = useState(new Map());
  useEffect(() => {
    if (!listedNfts || listedNfts.length === 0) return;
    let cancelled = false;
    const idsToFetch = listedNfts
      .slice(0, 20)
      .map(nft => String(nft.id))
      .filter(id => !bestOffers.has(id));
    if (idsToFetch.length === 0) return;

    (async () => {
      const results = new Map();
      // PERF: was a strict serial loop — up to 20 OpenSea round-trips SUMMED,
      // trickling in after paint and competing for the proxy rate-limit. Run them
      // with bounded concurrency (6 at a time) so total wall-time is ~the slowest
      // few rather than the sum, while staying well under the proxy's per-IP cap.
      const CONCURRENCY = 6;
      for (let i = 0; i < idsToFetch.length && !cancelled; i += CONCURRENCY) {
        const batch = idsToFetch.slice(i, i + CONCURRENCY);
        const settled = await Promise.all(batch.map(async (id) => {
          try {
            const offer = await fetchBestOffer(id, collection.slug, { openseaSlug: osSlug });
            return offer && offer.price > 0 ? [id, offer.price] : null;
          } catch { return null; }
        }));
        for (const r of settled) if (r) results.set(r[0], r[1]);
      }
      if (!cancelled && results.size > 0) {
        setBestOffers(prev => {
          const next = new Map(prev);
          for (const [k, v] of results) next.set(k, v);
          return next;
        });
      }
    })();
    return () => { cancelled = true; };
  }, [listedNfts.length, osSlug, collection.slug]);

  // Recent sales for fallback display (deduplicated by token ID, most recent sale per token)
  const recentSales = useMemo(() => {
    if (!activities || activities.length === 0) return [];
    const seen = new Set();
    return activities
      .filter(a => {
        if (a.type !== "sale" || !a.token?.id || !a.price) return false;
        if (seen.has(a.token.id)) return false;
        seen.add(a.token.id);
        return true;
      })
      .slice(0, 24)
      .map(a => {
        const token = allTokens.get(String(a.token.id));
        // Match the listings path: don't emit the known-404 Nakamigos png — leave
        // image null + flag imagePending so NftImage shows a loading placeholder
        // instead of firing a per-card metadata fetch on the 404 (F568).
        const fallbackImg = collection.metadataBase && collection.deterministicImage !== false
          ? `${collection.metadataBase}/${a.token.id}.png`
          : null;
        return {
          id: a.token.id,
          name: token?.name || `${collection.name} ${a.token.name || "#" + a.token.id}`,
          image: token?.image || fallbackImg,
          imagePending: !token && !fallbackImg,
          imageLarge: token?.imageLarge || token?.image || fallbackImg,
          attributes: token?.attributes || [],
          rank: token?.rank || null,
          salePrice: a.price,
          from: a.from,
          to: a.to,
          time: a.time,
          marketplace: a.marketplace,
        };
      });
  }, [activities, allTokens, collection]);

  // Sorted recent sales
  const displaySales = useMemo(() => {
    if (!recentSales || recentSales.length === 0) return [];
    return sortSales(recentSales, saleSortBy);
  }, [recentSales, saleSortBy]);

  // Sorted + filtered listings
  const displayNfts = useMemo(() => {
    let items = listedNfts;
    if (maxPrice) {
      const cap = parseFloat(maxPrice);
      if (!isNaN(cap) && cap > 0) {
        items = items.filter(n => n.price != null && n.price <= cap);
      }
    }
    return sortNfts(items, sortBy);
  }, [listedNfts, sortBy, maxPrice]);

  const [buying, setBuying] = useState(null); // tokenId being purchased

  // Render cap: a liquid collection can have many hundreds of live listings
  // (Nakamigos had 787 at launch verification) — mapping them all mounts
  // ~800 cards + images in one pass and janks the page. Reveal in chunks;
  // sweep/sort/filter logic stays data-level on the full arrays.
  const LISTINGS_RENDER_CHUNK = 60;
  const [visibleCount, setVisibleCount] = useState(LISTINGS_RENDER_CHUNK);

  // Reset local state when collection changes to prevent stale data bleed
  useEffect(() => {
    setExtraTokens([]);
    setSortBy("price-asc");
    setSaleSortBy("time-desc");
    setMaxPrice("");
    setSelectedIds(new Set());
    setTraitOfferOpen(false);
    setTraitCategory("");
    setTraitValue("");
    setShowTraitOfferModal(null);
    setBuying(null);
    setVisibleCount(LISTINGS_RENDER_CHUNK);
  }, [collection.slug]);

  const handleBuy = useCallback(async (nft, e) => {
    e.stopPropagation();
    if (!wallet) {
      onConnect?.();
      return;
    }
    if (!nft.orderHash) {
      window.open(OPENSEA_ITEM(nft.id, collection.contract), "_blank", "noopener,noreferrer");
      return;
    }
    // Prevent buying your own listing (Seaport would revert, wasting gas)
    if (nft.maker && nft.maker.toLowerCase() === wallet.toLowerCase()) {
      addToast?.("You cannot buy your own listing", "error");
      return;
    }
    setBuying(nft.id);
    addToast?.(`Purchasing ${collection.name} #${nft.id} for ${nft.price?.toFixed(4) ?? "?"} ETH...`, "info");

    // Use native orderbook fulfillment for native listings, OpenSea for others
    const result = nft.isNative && nft.nativeOrder
      ? await fulfillNativeOrder(nft.nativeOrder)
      : await fulfillSeaportOrder(nft, { buyerAddress: wallet });

    if (result.success) {
      recordTransaction({ type: "buy", nft, price: nft.price, hash: result.hash, wallet, slug: collection.slug });
      addToast?.(`Successfully purchased ${collection.name} #${nft.id}!`, "success");
      // Remove purchased NFT from display immediately to prevent stale listing
      setPurchasedIds(prev => new Set([...prev, String(nft.id)]));
    } else if (result.error === "rejected") {
      addToast?.("Transaction cancelled", "info");
    } else if (result.error === "insufficient") {
      addToast?.("Insufficient ETH balance", "error");
    } else if (result.error === "stale") {
      // Confirmed dead (gas estimation reverted): hide it from the grid so the
      // user can't keep clicking a listing that was just sniped/sold/cancelled.
      // The next listings poll/refetch removes it from the feed for good.
      addToast?.(`#${nft.id} is no longer available — it was just sold or cancelled`, "warning");
      setPurchasedIds(prev => new Set([...prev, String(nft.id)]));
    } else {
      // Plain-language mapping (mirrors the cart) for any other failure.
      addToast?.(`#${nft.id}: ${getFriendlyError(result.message || "Unknown error")}`, "error");
    }
    setBuying(null);
  }, [wallet, onConnect, addToast, collection]);

  const hasRealListings = listedNfts.length > 0;
  const hasRecentSales = recentSales.length > 0;
  const floor = stats?.floor || null;

  // Price stats computed from listings
  const priceStats = useMemo(() => {
    if (!hasRealListings) return null;
    const prices = listedNfts.map(l => l.price).filter(Boolean);
    if (prices.length === 0) return null;
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
    const sorted = [...prices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    return { avg, median, min: Math.min(...prices), max: Math.max(...prices) };
  }, [listedNfts, hasRealListings]);

  // Compute available trait categories + values from all tokens
  const traitCategories = useMemo(() => {
    const catMap = {};
    for (const t of tokens) {
      if (!t.attributes) continue;
      for (const attr of t.attributes) {
        const traitKey = attr.key || attr.trait_type;
        if (!traitKey || attr.value == null || attr.value === "") continue;
        if (!catMap[traitKey]) catMap[traitKey] = new Set();
        catMap[traitKey].add(attr.value);
      }
    }
    return Object.entries(catMap).map(([key, vals]) => ({
      key,
      values: [...vals].sort(),
    }));
  }, [tokens]);

  // Compute total price for selected items
  const selectionTotal = useMemo(() => {
    let total = 0;
    for (const nft of displayNfts) {
      if (selectedIds.has(nft.id) && nft.price) total += nft.price;
    }
    return total;
  }, [displayNfts, selectedIds]);

  const sourceLabel = listingsSource === "opensea"
    ? "OpenSea"
    : listingsSource
      ? listingsSource
      : null;

  const listedPct = stats?.supply ? ((listedNfts.length / stats.supply) * 100).toFixed(1) : null;

  // Grid source (full, for counts) and the capped slice that actually mounts
  const gridItems = hasRealListings ? displayNfts : hasRecentSales ? displaySales : tokens.slice(0, 24);
  const visibleGridItems = gridItems.length > visibleCount ? gridItems.slice(0, visibleCount) : gridItems;

  return (
    <section className="listings-section">
      <div className="listings-title">FLOOR & LISTINGS</div>
      <div className="listings-subtitle">
        {hasRealListings
          ? `${listedNfts.length} ${collection.name} currently listed for sale across marketplaces.`
          : `Live floor price and recent market activity for ${collection.name}.`}
      </div>

      {/* Stats Row — stays on top, full width */}
      <div className="listings-stats">
        <div className="listings-stat-card">
          <div className="listings-stat-label">FLOOR PRICE</div>
          <div className="listings-stat-value" style={{ color: "var(--gold)" }}>
            {floor != null ? <><Eth size={16} /> {floor.toFixed(4)}</> : "\u2014"}
          </div>
        </div>
        <div className="listings-stat-card">
          <div className="listings-stat-label">LISTED</div>
          <div className="listings-stat-value" style={{ color: "var(--naka-blue)" }}>
            {hasRealListings ? listedNfts.length : "\u2014"}
            {listedPct && hasRealListings && (
              <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 400, marginLeft: 6 }}>
                ({listedPct}%)
              </span>
            )}
          </div>
        </div>
        {priceStats && (
          <div className="listings-stat-card">
            {/* Median leads: one whale listing drags the mean far above what
                anyone actually pays (6.9 avg vs 0.45 median in prod). */}
            <div className="listings-stat-label">MEDIAN / AVG</div>
            <div className="listings-stat-value" style={{ color: "var(--text)", fontSize: 18 }}>
              <Eth size={14} /> {priceStats.median.toFixed(4)}
              <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 400, marginLeft: 4 }}>
                / {priceStats.avg.toFixed(4)}
              </span>
            </div>
          </div>
        )}
        <div className="listings-stat-card">
          <div className="listings-stat-label">OWNERS</div>
          <div className="listings-stat-value" style={{ color: "var(--green)" }}>
            {stats?.owners?.toLocaleString() || "\u2014"}
          </div>
        </div>
        <div className="listings-stat-card">
          <div className="listings-stat-label">SUPPLY</div>
          <div className="listings-stat-value" style={{ color: "var(--text)" }}>
            {stats?.supply?.toLocaleString() || "\u2014"}
          </div>
        </div>
        {hasRecentSales && !hasRealListings && (
          <div className="listings-stat-card">
            <div className="listings-stat-label">RECENT SALES</div>
            <div className="listings-stat-value" style={{ color: "var(--naka-blue)" }}>
              {recentSales.length}
            </div>
          </div>
        )}
      </div>

      {/* Two-column layout: listings left, orderbook/offers right.
          BUGFIX 2026-05-27: switched from `display:flex` + `order:1/2` to CSS
          Grid `grid-template-areas`. iOS Safari has known bugs reflowing
          flex-wrap children with `order` properties when flex-basis is a
          percentage — listings would visually disappear or overlap on iPhone.
          Grid `grid-template-areas` handles desktop AND mobile row order
          deterministically across all browsers. Pattern: OpenSea / Blur use
          the same `display:grid; grid-template-areas` layout on their
          listings pages. CSS defined in App.css `.listings-wrapper`. */}
      <div className="listings-wrapper">

      {/* RIGHT COLUMN — Order Book, Offers (collapsible) */}
      <div className="listings-sidebar">

      <details style={{ marginBottom: 0 }}>
        <summary style={{
          cursor: "pointer", userSelect: "none", listStyle: "none",
          display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
          background: "rgba(111,168,220,0.04)", border: "1px solid rgba(111,168,220,0.08)",
          borderRadius: 10, marginBottom: 12,
          fontFamily: "var(--pixel)", fontSize: 10, color: "var(--naka-blue)",
          letterSpacing: "0.1em",
        }}>
          <span style={{ transition: "transform 0.2s", display: "inline-block" }} className="details-arrow">&#9654;</span>
          ORDER BOOK &amp; OFFERS
        </summary>

      {/* Order Book Depth */}
      <OrderBookPanel listings={listings} collectionOffers={collectionOffers} floorPrice={stats?.floor} wallet={wallet} onConnect={onConnect} addToast={addToast} />

      {/* Depth Chart Visualization — hidden in Lite mode */}
      {!isLite && <DepthChart listings={listings} offers={collectionOffers} floorPrice={stats?.floor} collection={collection} />}

      {/* Collection & Trait Offers */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 0 }}>
        <div style={{ flex: 1 }}>
          <CollectionOffersPanel wallet={wallet} onConnect={onConnect} addToast={addToast} />
        </div>
        {/* Trait Offer button + dropdown */}
        <div style={{ position: "relative", flexShrink: 0, marginTop: 20 }}>
          <button
            onClick={() => setTraitOfferOpen(prev => !prev)}
            className="btn-primary"
            style={{ fontSize: 10, padding: "8px 14px", whiteSpace: "nowrap" }}
          >
            Trait Offer
          </button>
          {traitOfferOpen && (
            <div style={{
              position: "absolute", top: "100%", right: 0, marginTop: 6,
              background: "var(--card)", border: "1px solid var(--border)",
              borderRadius: 10, padding: 14, minWidth: 220, zIndex: 50,
              boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            }}>
              <div style={{
                fontFamily: "var(--pixel)", fontSize: 9, color: "var(--text-dim)",
                letterSpacing: "0.08em", marginBottom: 8,
              }}>
                PICK A TRAIT
              </div>
              <select
                value={traitCategory}
                onChange={(e) => { setTraitCategory(e.target.value); setTraitValue(""); }}
                style={{
                  width: "100%", fontFamily: "var(--mono)", fontSize: 11,
                  background: "var(--surface)", color: "var(--text)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  padding: "6px 8px", marginBottom: 8, cursor: "pointer", outline: "none",
                }}
              >
                <option value="">Category...</option>
                {traitCategories.map(cat => (
                  <option key={cat.key} value={cat.key}>{cat.key}</option>
                ))}
              </select>
              {traitCategory && (
                <select
                  value={traitValue}
                  onChange={(e) => setTraitValue(e.target.value)}
                  style={{
                    width: "100%", fontFamily: "var(--mono)", fontSize: 11,
                    background: "var(--surface)", color: "var(--text)",
                    border: "1px solid var(--border)", borderRadius: 6,
                    padding: "6px 8px", marginBottom: 10, cursor: "pointer", outline: "none",
                  }}
                >
                  <option value="">Value...</option>
                  {(traitCategories.find(c => c.key === traitCategory)?.values || []).map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              )}
              <button
                disabled={!traitCategory || !traitValue}
                onClick={() => {
                  setShowTraitOfferModal({ key: traitCategory, value: traitValue });
                  setTraitOfferOpen(false);
                }}
                className="btn-primary"
                style={{
                  width: "100%", fontSize: 10, padding: "7px 0", textAlign: "center",
                  opacity: (!traitCategory || !traitValue) ? 0.4 : 1,
                }}
              >
                Make Trait Offer
              </button>
            </div>
          )}
        </div>
      </div>

      </details>

      </div>{/* end sidebar */}

      {/* LEFT COLUMN — Listings grid */}
      <div className="listings-content" style={{ minWidth: 0 }}>

      {/* Loading state with skeleton cards — show while listings load,
          or while activities load when listings are empty (so we don't flash
          the empty state before recent sales have a chance to appear) */}
      {!hasRealListings && !hasRecentSales && (listingsLoading || activitiesLoading) && (
        <>
          <div style={{
            padding: "12px 18px", borderRadius: 10, marginBottom: 20,
            background: "rgba(111, 168, 220, 0.04)", border: "1px solid rgba(111, 168, 220, 0.08)",
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--naka-blue)",
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span className="pulse-dot" /> {listingsLoading ? "Fetching live listings from marketplaces..." : "Loading recent market activity..."}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="skeleton-card card-reveal" style={{ animationDelay: `${i * 50}ms` }}>
                <div className="skeleton skeleton-image" />
                <div className="skeleton-info">
                  <div className="skeleton skeleton-line" style={{ width: "75%" }} />
                  <div className="skeleton skeleton-line short" />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Data source indicator — live listings */}
      {hasRealListings && (
        <div style={{
          padding: "8px 14px", borderRadius: 8, marginBottom: 16,
          background: "rgba(74, 222, 128, 0.04)", border: "1px solid rgba(74, 222, 128, 0.1)",
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--green)",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", display: "inline-block" }} />
          LIVE — Real active listings via {sourceLabel}
        </div>
      )}

      {/* Fallback state — no active listings or API error (wait for activities too) */}
      {!listingsLoading && !activitiesLoading && !hasRealListings && (
        <div style={{
          padding: "12px 18px", borderRadius: 10, marginBottom: 20,
          background: listingsSource === "opensea"
            ? "rgba(74, 222, 128, 0.04)"
            : "rgba(111, 168, 220, 0.04)",
          border: listingsSource === "opensea"
            ? "1px solid rgba(74, 222, 128, 0.1)"
            : "1px solid rgba(111, 168, 220, 0.08)",
          fontFamily: "var(--mono)", fontSize: 11,
          color: listingsSource === "opensea" ? "var(--text-dim)" : "var(--naka-blue)",
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 14 }}>{listingsSource === "opensea" ? "\uD83D\uDCC9" : "\u2139"}</span>
          <span>
            {listingsSource === "opensea"
              ? `No active listings for ${collection.name} right now.${hasRecentSales ? " Showing recent sales below." : ""}`
              : listingsError
                ? `Listing data for ${collection.name} temporarily unavailable.${hasRecentSales ? " Showing recent sales below." : ""}`
                : hasRecentSales
                  ? `Showing recent ${collection.name} sales from the blockchain below.`
                  : `Listing data for ${collection.name} temporarily unavailable.`
            }
          </span>
          <span style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
            <a href={`https://opensea.io/collection/${osSlug}`} target="_blank" rel="noopener noreferrer"
              style={{ color: "var(--naka-blue)", textDecoration: "underline", fontSize: 11 }}>
              Browse on OpenSea
            </a>
          </span>
        </div>
      )}

      {/* Sort & filter controls */}
      {hasRealListings && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap",
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <label style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)",
              letterSpacing: "0.08em",
            }}>
              SORT
            </label>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
              style={{
                fontFamily: "var(--mono)", fontSize: 11,
                background: "var(--surface)", color: "var(--text)",
                border: "1px solid var(--border)", borderRadius: 8,
                padding: "6px 10px", cursor: "pointer",
                outline: "none",
              }}
            >
              {SORT_OPTIONS.map(o => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <label style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)",
              letterSpacing: "0.08em",
            }}>
              MAX PRICE
            </label>
            <input
              type="text"
              placeholder="No limit"
              value={maxPrice}
              onChange={e => setMaxPrice(e.target.value)}
              style={{
                fontFamily: "var(--mono)", fontSize: 11, width: 90,
                background: "var(--surface)", color: "var(--text)",
                border: "1px solid var(--border)", borderRadius: 8,
                padding: "6px 10px", outline: "none",
              }}
            />
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>ETH</span>
          </div>
          {maxPrice && displayNfts.length !== listedNfts.length && (
            <span style={{
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
            }}>
              Showing {displayNfts.length} of {listedNfts.length}
            </span>
          )}
        </div>
      )}

      {/* Main content: grid + sweep calculator sidebar */}
      <div className="listings-main-grid" style={{ display: "grid", gridTemplateColumns: (!isLite && hasRealListings) ? "1fr 320px" : "1fr", gap: 24, alignItems: "start" }}>
        <div>
          {/* Section label + sort controls when showing recent sales */}
          {!hasRealListings && hasRecentSales && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 12, paddingLeft: 2, flexWrap: "wrap", gap: 8,
            }}>
              <div style={{
                fontFamily: "var(--pixel)", fontSize: 9, color: "var(--text-dim)",
                letterSpacing: "0.08em",
              }}>
                RECENT SALES ({displaySales.length})
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <label style={{
                  fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)",
                  letterSpacing: "0.08em",
                }}>
                  SORT
                </label>
                <select
                  value={saleSortBy}
                  onChange={e => setSaleSortBy(e.target.value)}
                  style={{
                    fontFamily: "var(--mono)", fontSize: 11,
                    background: "var(--surface)", color: "var(--text)",
                    border: "1px solid var(--border)", borderRadius: 8,
                    padding: "6px 10px", cursor: "pointer", outline: "none",
                  }}
                >
                  {SALE_SORT_OPTIONS.map(o => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Empty state — no listings and no recent sales (wait for both to finish) */}
          {!listingsLoading && !activitiesLoading && !hasRealListings && !hasRecentSales && (
            <div className="empty-state" style={{ borderRadius: 16, background: "var(--surface-glass)", border: "1px solid var(--border)", backdropFilter: "var(--glass-blur)" }}>
              <div className="empty-state-icon">{"\uD83D\uDCC9"}</div>
              <div className="empty-state-title">
                {activitiesEmpty ? "No Recent Sales" : "No Listings Available"}
              </div>
              <div className="empty-state-text">
                {activitiesEmpty
                  ? `No recorded sales found for ${collection.name}. This collection may have low trading volume or trades may occur on unlisted marketplaces.`
                  : `There are currently no active listings for ${collection.name}. Check back soon or browse on OpenSea.`
                }
              </div>
              <a
                href={`https://opensea.io/collection/${osSlug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary"
                style={{ display: "inline-block", fontSize: 11, padding: "10px 24px", textDecoration: "none", marginTop: 20 }}
              >
                View on OpenSea
              </a>
            </div>
          )}

          {/* Listings Grid */}
          <div className="listings-grid" style={(!hasRealListings && !hasRecentSales) ? { display: "none" } : undefined}>
            {visibleGridItems.map((nft) => (
              <ListingCard
                key={nft.id}
                nft={nft}
                isSelected={selectedIds.has(nft.id)}
                isBuying={buying === nft.id}
                bestOffer={bestOffers.get(String(nft.id)) || null}
                hasRealListings={hasRealListings}
                floor={floor}
                wallet={wallet}
                collectionContract={collection.contract}
                onPick={onPick}
                onToggleSelect={toggleSelect}
                onBuy={handleBuy}
                onAddToCart={onAddToCart}
              />
            ))}
          </div>

          {/* Reveal the next chunk of the already-fetched list */}
          {gridItems.length > visibleCount && (
            <div style={{ display: "flex", justifyContent: "center", padding: "16px 0 4px" }}>
              <button
                className="btn-secondary"
                onClick={() => setVisibleCount((c) => c + LISTINGS_RENDER_CHUNK)}
                style={{ fontSize: 11, padding: "10px 24px" }}
              >
                Show {Math.min(LISTINGS_RENDER_CHUNK, gridItems.length - visibleCount)} more ({visibleCount} of {gridItems.length})
              </button>
            </div>
          )}
        </div>

        {/* Sweep Calculator Sidebar — only shown when there are active listings; hidden in Lite mode */}
        {!isLite && hasRealListings && (
          <div>
            <SweepCalculator stats={stats} listings={listedNfts} wallet={wallet} onConnect={onConnect} addToast={addToast} />
          </div>
        )}
      </div>
      {/* Sticky batch selection bar */}
      {selectedIds.size > 0 && (
        <div className="batch-selection-bar" style={{
          position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100,
          background: "var(--surface-glass)", backdropFilter: "var(--glass-blur)",
          borderTop: "1px solid var(--border)",
          padding: "12px 24px",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 16,
        }}>
          <span style={{
            fontFamily: "var(--pixel)", fontSize: 11, color: "var(--text)",
            letterSpacing: "0.04em",
          }}>
            {selectedIds.size} selected
          </span>
          <span style={{
            fontFamily: "var(--mono)", fontSize: 12, color: "var(--gold)",
          }}>
            <Eth size={12} /> {selectionTotal.toFixed(4)} total
          </span>
          <button
            onClick={() => {
              for (const nft of displayNfts) {
                if (selectedIds.has(nft.id) && nft.price) {
                  onAddToCart?.(nft);
                }
              }
              clearSelection();
            }}
            style={{
              background: "var(--naka-blue)", color: "#fff", border: "none",
              borderRadius: 8, padding: "8px 18px", cursor: "pointer",
              fontFamily: "var(--pixel)", fontSize: 10, letterSpacing: "0.04em",
            }}
          >
            Add All to Cart
          </button>
          <button
            onClick={clearSelection}
            style={{
              background: "transparent", color: "var(--text-dim)", border: "1px solid var(--border)",
              borderRadius: 8, padding: "8px 14px", cursor: "pointer",
              fontFamily: "var(--pixel)", fontSize: 10,
            }}
          >
            Clear
          </button>
        </div>
      )}

      </div>{/* end left column */}
      </div>{/* end flex container */}

      {/* Trait Offer Modal */}
      {showTraitOfferModal && (
        <MakeOfferModal
          trait={showTraitOfferModal}
          onClose={() => setShowTraitOfferModal(null)}
          wallet={wallet}
          onConnect={onConnect}
          addToast={addToast}
        />
      )}

      {/* On phones the fixed bottom nav (z-index 9999) sits over the selection
          bar; lift the bar above it so both action buttons stay tappable (F571). */}
      <style>{`
        @media (max-width: 767px) {
          .batch-selection-bar {
            bottom: calc(56px + env(safe-area-inset-bottom)) !important;
          }
        }
      `}</style>
    </section>
  );
}
