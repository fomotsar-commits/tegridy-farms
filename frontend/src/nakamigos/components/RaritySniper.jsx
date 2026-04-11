import { useState, useMemo, useEffect, useRef } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { useActiveCollection } from "../contexts/CollectionContext";

// Supply is resolved dynamically per-collection in the component (effectiveSupply)

// Score = rarity percentile / price percentile. High rarity + low price = high score.
// Uses percentile (0-1) to be independent of array position after re-sorting.
function computeSnipeScore(rank, pricePercentile, supply) {
  const rarityScore = Math.max(0, (supply - rank) / supply);
  const priceScore = Math.max(0.01, pricePercentile); // floor at 1% to avoid division by near-zero
  return Math.min((rarityScore / priceScore) * 10, 999);
}

function rankColor(rank, supply) {
  if (rank <= supply * 0.01) return "var(--gold)";
  if (rank <= supply * 0.05) return "var(--naka-blue)";
  if (rank <= supply * 0.1) return "var(--green)";
  return "var(--text)";
}

function scoreGradient(score) {
  if (score >= 5) return "linear-gradient(90deg, var(--gold), #ff6b00)";
  if (score >= 2) return "linear-gradient(90deg, var(--naka-blue), var(--gold))";
  if (score >= 1) return "linear-gradient(90deg, var(--green), var(--naka-blue))";
  return "linear-gradient(90deg, var(--border), var(--green))";
}

const keyframesInjected = { current: false };

function injectKeyframes() {
  if (keyframesInjected.current) return;
  keyframesInjected.current = true;
  const sheet = document.createElement("style");
  sheet.textContent = `
    @keyframes snipeGlow {
      0%, 100% { box-shadow: 0 0 8px rgba(255,215,0,0.2); }
      50% { box-shadow: 0 0 22px rgba(255,215,0,0.5); }
    }
    @keyframes snipeSpin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(sheet);
}

/* ─── Styles ─── */

const s = {
  panel: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 20,
    fontFamily: "var(--mono)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  title: {
    fontFamily: "var(--pixel)",
    fontSize: 16,
    color: "var(--gold)",
    margin: 0,
    letterSpacing: 1,
  },
  summary: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--text-dim)",
    marginBottom: 14,
    lineHeight: 1.6,
  },
  filterBar: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "flex-end",
    marginBottom: 16,
    padding: "12px 14px",
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: 8,
  },
  filterGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    flex: "1 1 120px",
    minWidth: 100,
  },
  filterLabel: {
    fontFamily: "var(--pixel)",
    fontSize: 10,
    color: "var(--text-dim)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "6px 10px",
    color: "inherit",
    fontFamily: "var(--mono)",
    fontSize: 13,
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  },
  table: {
    width: "100%",
    borderCollapse: "separate",
    borderSpacing: "0 6px",
  },
  th: {
    fontFamily: "var(--pixel)",
    fontSize: 10,
    color: "var(--text-dim)",
    textTransform: "uppercase",
    textAlign: "left",
    padding: "4px 8px",
    letterSpacing: 0.5,
    borderBottom: "1px solid var(--border)",
  },
  row: (isTop) => ({
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    cursor: "pointer",
    transition: "box-shadow 0.3s, border-color 0.3s",
    animation: isTop ? "snipeGlow 2s ease-in-out infinite" : "none",
    borderColor: isTop ? "var(--gold)" : "var(--border)",
  }),
  td: {
    padding: "8px 8px",
    verticalAlign: "middle",
    fontFamily: "var(--mono)",
    fontSize: 13,
  },
  thumb: {
    width: 36,
    height: 36,
    borderRadius: 6,
    objectFit: "cover",
  },
  scoreBar: {
    height: 6,
    borderRadius: 3,
    minWidth: 40,
    maxWidth: 80,
  },
  cartBtn: {
    background: "var(--naka-blue)",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "5px 10px",
    fontFamily: "var(--pixel)",
    fontSize: 10,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  refreshBtn: {
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "4px 10px",
    fontFamily: "var(--pixel)",
    fontSize: 10,
    color: "var(--text-dim)",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    transition: "border-color 0.2s, color 0.2s",
  },
  empty: {
    textAlign: "center",
    fontFamily: "var(--pixel)",
    fontSize: 12,
    padding: "48px 20px",
    color: "var(--text-dim)",
  },
  emptyIcon: {
    fontSize: 36,
    marginBottom: 12,
    opacity: 0.35,
    display: "block",
  },
  emptyTitle: {
    fontFamily: "var(--pixel)",
    fontSize: 14,
    color: "var(--text)",
    marginBottom: 6,
  },
  emptyHint: {
    fontFamily: "var(--mono)",
    fontSize: 11,
    color: "var(--text-dim)",
    lineHeight: 1.5,
  },
};

/* ─── Component ─── */

export default function RaritySniper({
  tokens = [],
  listings = [],
  supply,
  onPick,
  addToast,
  onAddToCart,
  onRefresh,
  wallet,
  onConnect,
}) {
  const collection = useActiveCollection();
  const [maxPrice, setMaxPrice] = useState("");
  const [maxRank, setMaxRank] = useState("");
  const [minScore, setMinScore] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const prevListingsRef = useRef(listings);

  // Resolve effective supply: explicit prop > collection context > infer from tokens > fallback
  const effectiveSupply = supply
    || collection?.supply
    || (tokens.length > 0 ? Math.max(tokens.length, Math.max(...tokens.map(t => t.rank || t.rarityRank || t.rarity_rank || 0))) : null)
    || 20000;

  useEffect(() => { injectKeyframes(); }, []);

  // Reset filters when collection changes so stale filter state doesn't persist
  useEffect(() => {
    setMaxPrice("");
    setMaxRank("");
    setMinScore("");
  }, [collection.slug]);

  // Auto-refresh notification when listings change
  useEffect(() => {
    if (prevListingsRef.current !== listings && prevListingsRef.current.length > 0) {
      addToast?.("Listings updated — snipe scores refreshed", "info");
    }
    prevListingsRef.current = listings;
  }, [listings, addToast]);

  // Build token lookup by id
  const tokenMap = useMemo(() => {
    const map = new Map();
    tokens.forEach((t) => map.set(String(t.id ?? t.tokenId), t));
    return map;
  }, [tokens]);

  // Detect whether any loaded tokens have rarity data
  const hasRarity = useMemo(() => {
    return tokens.some(t => (t.rarityRank ?? t.rarity_rank ?? t.rank) > 0);
  }, [tokens]);

  // Detect whether rarity ranks are approximate (partial data loaded for large collections)
  const isApproximate = useMemo(() => {
    return hasRarity && tokens.some(t => t.rankApproximate);
  }, [tokens, hasRarity]);

  // Compute scored opportunities
  const opportunities = useMemo(() => {
    if (!listings.length) return [];

    // Listings are assumed sorted by price ascending; build price index
    const sorted = [...listings].sort((a, b) => (a.price || 0) - (b.price || 0));
    const totalListings = sorted.length;

    return sorted
      .map((listing, priceIndex) => {
        const tid = String(listing.tokenId);
        const token = tokenMap.get(tid);

        const rank = token ? (token.rarityRank ?? token.rarity_rank ?? token.rank) : null;
        const hasRank = rank != null && rank > 0;

        // When rarity data exists for the collection, require it per-token
        if (hasRarity && !hasRank) return null;

        // Price percentile: 0 = cheapest, 1 = most expensive (stable across re-sorts)
        const pricePercentile = totalListings > 1 ? priceIndex / (totalListings - 1) : 0.5;

        // With rarity: full snipe score. Without: invert price percentile so cheapest = best.
        const score = hasRank
          ? computeSnipeScore(rank, pricePercentile, effectiveSupply)
          : Math.min((1 - pricePercentile + 0.01) * 10, 999);

        return {
          listing,
          token: token || { id: tid, name: `#${tid}`, image: null },
          tokenId: tid,
          rank: hasRank ? rank : null,
          price: listing.price || 0,
          score,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
  }, [listings, tokenMap, effectiveSupply, hasRarity]);

  // Apply filters
  const filtered = useMemo(() => {
    let result = opportunities;
    const mp = parseFloat(maxPrice);
    const mr = parseInt(maxRank, 10);
    const ms = parseFloat(minScore);

    if (!isNaN(mp) && mp > 0) result = result.filter((o) => o.price <= mp);
    if (!isNaN(mr) && mr > 0) result = result.filter((o) => o.rank != null && o.rank <= mr);
    if (!isNaN(ms) && ms > 0) result = result.filter((o) => o.score >= ms);

    return result;
  }, [opportunities, maxPrice, maxRank, minScore]);

  const best = filtered[0] || null;
  // Guard: ensure maxScoreInList is never 0 or NaN to prevent division issues in bar width
  const maxScoreInList = (filtered.length > 0 && filtered[0].score > 0) ? filtered[0].score : 1;

  const handleAddToCart = (e, item) => {
    e.stopPropagation();
    if (!wallet) {
      onConnect?.();
      return;
    }
    onAddToCart?.(item.listing);
    addToast?.(`#${item.tokenId} added to cart`, "success");
  };

  const handleRefresh = async () => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      // Small delay so the spinner is visible even on fast refreshes
      setTimeout(() => setRefreshing(false), 400);
    }
  };

  const collectionName = collection?.name || "Collection";

  return (
    <div style={s.panel}>
      <div className="pixel-border-top" />

      {/* Header */}
      <div style={s.header}>
        <h3 style={s.title}>RARITY SNIPER</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
            {filtered.length} / {opportunities.length} opportunities
          </span>
          {onRefresh && (
            <button
              style={s.refreshBtn}
              onClick={handleRefresh}
              disabled={refreshing}
              title="Refresh listings"
            >
              <span
                style={{
                  display: "inline-block",
                  animation: refreshing ? "snipeSpin 0.8s linear infinite" : "none",
                }}
              >
                {"\u21BB"}
              </span>
              {refreshing ? "..." : "Refresh"}
            </button>
          )}
        </div>
      </div>

      {/* Summary Stats */}
      <div style={s.summary}>
        <span style={{ color: "var(--naka-blue)", fontWeight: 700 }}>
          {filtered.length} sniping {filtered.length === 1 ? "opportunity" : "opportunities"} found
        </span>
        {!hasRarity && filtered.length > 0 && (
          <span style={{ color: "var(--text-dim)", marginLeft: 8, fontSize: 11 }}>
            (no trait data for {collectionName} — ranked by price)
          </span>
        )}
        {isApproximate && (
          <span style={{ color: "var(--gold)", marginLeft: 8, fontSize: 11 }}>
            (ranks approximate — loading more {collectionName} data)
          </span>
        )}
        {best && (
          <>
            {" | "}
            Best deal:{" "}
            <span
              style={{ color: "var(--gold)", cursor: "pointer", textDecoration: "underline" }}
              onClick={() => onPick?.(best.token)}
            >
              #{best.tokenId}
            </span>
            {" "}
            ({best.rank != null ? `Rank ${isApproximate ? "~" : "#"}${best.rank} at ` : ""}<Eth size={10} /> {best.price.toFixed(4)})
          </>
        )}
      </div>

      {/* Filters */}
      <div style={s.filterBar}>
        <div style={s.filterGroup}>
          <label style={s.filterLabel}>Max Price (ETH)</label>
          <input
            type="number"
            placeholder="e.g. 0.5"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            style={s.input}
            step="0.01"
            min="0"
          />
        </div>
        {hasRarity && (
          <div style={s.filterGroup}>
            <label style={s.filterLabel}>Max Rank</label>
            <input
              type="number"
              placeholder={`e.g. ${Math.round(effectiveSupply * 0.025)}`}
              value={maxRank}
              onChange={(e) => setMaxRank(e.target.value)}
              style={s.input}
              step="1"
              min="1"
            />
          </div>
        )}
        <div style={s.filterGroup}>
          <label style={s.filterLabel}>Min Snipe Score</label>
          <input
            type="number"
            placeholder="e.g. 1.5"
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
            style={s.input}
            step="0.1"
            min="0"
          />
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">{opportunities.length === 0 ? "\u{1F50D}" : "\u{1F50E}"}</div>
          <div className="empty-state-title">
            {opportunities.length === 0
              ? `No ${collectionName} listings available`
              : "No matches for current filters"}
          </div>
          <div className="empty-state-text">
            {opportunities.length === 0
              ? `Waiting for ${collectionName} listings to appear.${onRefresh ? " Hit Refresh or they will show automatically as the market updates." : ""}`
              : `Try increasing the max price${hasRarity ? ", raising the max rank," : ""} or lowering the minimum snipe score.`}
          </div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th} />
                <th style={s.th}>ID</th>
                {hasRarity && <th style={s.th}>{isApproximate ? "Rank ~" : "Rank"}</th>}
                <th style={s.th}>Price</th>
                <th style={s.th}>{hasRarity ? "Snipe Score" : "Value Score"}</th>
                <th style={s.th} />
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 50).map((item, idx) => {
                const isTop = idx < 3;
                const barWidth = maxScoreInList > 0 ? Math.min((item.score / maxScoreInList) * 100, 100) : 0;
                return (
                  <tr
                    key={item.tokenId}
                    style={s.row(isTop)}
                    onClick={() => onPick?.(item.token)}
                  >
                    <td style={s.td}>
                      <NftImage nft={item.token} style={s.thumb} />
                    </td>
                    <td style={{ ...s.td, fontWeight: 700 }}>#{item.tokenId}</td>
                    {hasRarity && (
                      <td style={{ ...s.td, color: item.rank != null ? rankColor(item.rank, effectiveSupply) : "var(--text-dim)", fontWeight: 700 }}>
                        {item.rank != null ? `${isApproximate ? "~" : "#"}${item.rank}` : "\u2014"}
                      </td>
                    )}
                    <td style={s.td}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                        <Eth size={11} /> {item.price.toFixed(4)}
                      </span>
                    </td>
                    <td style={s.td}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontWeight: 700, minWidth: 36 }}>
                          {item.score.toFixed(1)}
                        </span>
                        <div
                          style={{
                            ...s.scoreBar,
                            width: `${barWidth}%`,
                            background: scoreGradient(item.score),
                          }}
                        />
                      </div>
                    </td>
                    <td style={s.td}>
                      <button style={s.cartBtn} onClick={(e) => handleAddToCart(e, item)}>
                        + Cart
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
