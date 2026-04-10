import { useMemo, useState, useEffect, useCallback } from "react";
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
import { recordTransaction } from "../lib/transactions";
import { fetchCollectionOffers } from "../api-offers";

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
      return sorted.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)).reverse();
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

export default function Listings({ tokens, stats, listings, listingsLoading, listingsError, listingsSource, activities, activitiesLoading, activitiesEmpty, onPick, wallet, onConnect, addToast, onAddToCart }) {
  const collection = useActiveCollection();
  const { isLite } = useTradingMode();
  const [extraTokens, setExtraTokens] = useState([]);
  const [sortBy, setSortBy] = useState("price-asc");
  const [saleSortBy, setSaleSortBy] = useState("time-desc");
  const [maxPrice, setMaxPrice] = useState("");

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
    fetchCollectionOffers(osSlug).then(setCollectionOffers).catch(() => {});
  }, [osSlug]);

  // Trait offer state
  const [traitOfferOpen, setTraitOfferOpen] = useState(false);
  const [traitCategory, setTraitCategory] = useState("");
  const [traitValue, setTraitValue] = useState("");
  const [showTraitOfferModal, setShowTraitOfferModal] = useState(null);

  // Fetch metadata for listed tokens AND recent sale tokens not in gallery data
  useEffect(() => {
    const knownIds = new Set(tokens.map(t => String(t.id)));

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

    fetchTokensByIds(uniqueMissing, collection.contract, collection.metadataBase).then(fetched => {
      if (fetched.length > 0) setExtraTokens(fetched);
    });
  }, [listings, activities, tokens, collection.contract, collection.metadataBase]);

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

    return listings.map(listing => {
      const token = allTokens.get(String(listing.tokenId));
      const fullResImg = collection.metadataBase
        ? `${collection.metadataBase}/${listing.tokenId}.png`
        : null;
      return {
        id: listing.tokenId,
        name: token?.name || `${collection.name} #${listing.tokenId}`,
        image: token?.image || null, // Let NftImage fetch thumbnail via metadata API
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
      };
    });
  }, [listings, allTokens, collection]);

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
        const fallbackImg = collection.metadataBase
          ? `${collection.metadataBase}/${a.token.id}.png`
          : null; // Let NftImage handle fallback via metadata API
        return {
          id: a.token.id,
          name: token?.name || `${collection.name} ${a.token.name || "#" + a.token.id}`,
          image: token?.image || fallbackImg,
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
    setBuying(nft.id);
    addToast?.(`Purchasing ${collection.name} #${nft.id} for ${nft.price?.toFixed(4) ?? "?"} ETH...`, "info");

    const result = await fulfillSeaportOrder(nft);

    if (result.success) {
      recordTransaction({ type: "buy", nft, price: nft.price, hash: result.hash, wallet, slug: collection.slug });
      addToast?.(`Successfully purchased ${collection.name} #${nft.id}!`, "success");
    } else if (result.error === "rejected") {
      addToast?.("Transaction cancelled", "info");
    } else if (result.error === "insufficient") {
      addToast?.("Insufficient ETH balance", "error");
    } else {
      const detail = result.message || "Unknown error";
      addToast?.(`Failed to buy #${nft.id}: ${detail}`, "error");
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
    const median = [...prices].sort((a, b) => a - b)[Math.floor(prices.length / 2)];
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
            <div className="listings-stat-label">AVG / MEDIAN</div>
            <div className="listings-stat-value" style={{ color: "var(--text)", fontSize: 18 }}>
              <Eth size={14} /> {priceStats.avg.toFixed(4)}
              <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 400, marginLeft: 4 }}>
                / {priceStats.median.toFixed(4)}
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

      {/* Two-column layout: listings left, orderbook/offers right */}
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>

      {/* RIGHT COLUMN — Order Book, Offers (collapsible) */}
      <div style={{ flex: "0 0 380px", maxWidth: 420, order: 2 }} className="listings-sidebar">

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
      <div style={{ flex: "1 1 0", minWidth: 0, order: 1 }}>

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
      <div style={{ display: "grid", gridTemplateColumns: hasRealListings ? "1fr 320px" : "1fr", gap: 24, alignItems: "start" }}>
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
            {(hasRealListings ? displayNfts : hasRecentSales ? displaySales : tokens.slice(0, 24)).map((nft, idx) => {
              const isSelected = selectedIds.has(nft.id);
              return (
              <div key={`${nft.id}-${idx}`} className="listing-card" onClick={() => onPick(nft)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(nft); } }} role="button" tabIndex={0} aria-label={`${nft.name}${nft.price ? `, ${nft.price} ETH` : ""}`} style={isSelected ? { border: "2px solid var(--naka-blue)" } : undefined}>
                <div className="listing-card-image">
                  <NftImage nft={nft} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
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
                      onClick={(e) => { e.stopPropagation(); toggleSelect(nft.id); }}
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
                      {isSelected ? "\u2713" : ""}
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
                  <div className="listing-card-actions">
                    {nft.orderHash && nft.price ? (
                      <button
                        className="listing-btn-buy"
                        disabled={buying === nft.id}
                        onClick={(e) => handleBuy(nft, e)}
                        style={{ cursor: buying === nft.id ? "wait" : "pointer" }}
                      >
                        {buying === nft.id ? "Buying..." : !wallet ? "Connect & Buy" : `Buy ${nft.price.toFixed(4)} ETH`}
                      </button>
                    ) : (
                      <a
                        href={OPENSEA_ITEM(nft.id, collection.contract)}
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
            })}
          </div>
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
        <div style={{
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
    </section>
  );
}
