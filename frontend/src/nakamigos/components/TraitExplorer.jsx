import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useActiveCollection } from "../contexts/CollectionContext";
import { TRAIT_LORE } from "../constants";
import NftImage from "./NftImage";
import TraitBidPanel from "./TraitBidPanel";
import MakeOfferModal from "./MakeOfferModal";
import CharacterTypeExplorer from "./CharacterTypeExplorer";

/* ── Debounce hook ── */
function useDebounce(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/* ── Sort options ── */
const SORT_OPTIONS = [
  { value: "most-values", label: "Most Values" },
  { value: "rarest",      label: "Rarest First" },
  { value: "floor-asc",   label: "Floor: Low\u2192High" },
  { value: "az",           label: "A\u2192Z" },
];

/* ── Styles ── */
const S = {
  page: {
    position: "relative",
    zIndex: 1,
    maxWidth: 1440,
    margin: "0 auto",
    padding: "0 16px 80px",
  },
  header: {
    textAlign: "center",
    marginBottom: 32,
  },
  title: {
    fontFamily: "var(--pixel)",
    fontSize: 28,
    letterSpacing: 3,
    color: "var(--gold)",
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--text-dim)",
  },

  /* ── Summary stats ── */
  statsPanel: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    justifyContent: "center",
    marginBottom: 28,
  },
  statCard: {
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "14px 22px",
    textAlign: "center",
    minWidth: 140,
  },
  statLabel: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    color: "var(--text-muted)",
    marginBottom: 4,
  },
  statValue: {
    fontFamily: "var(--display)",
    fontSize: 20,
    fontWeight: 700,
    color: "var(--text)",
  },
  statGold: {
    fontFamily: "var(--display)",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--gold)",
    marginTop: 2,
  },

  /* ── Toolbar ── */
  toolbar: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "center",
    marginBottom: 24,
  },
  searchWrap: {
    position: "relative",
    flex: "1 1 220px",
    maxWidth: 360,
  },
  searchIcon: {
    position: "absolute",
    left: 12,
    top: "50%",
    transform: "translateY(-50%)",
    color: "var(--text-muted)",
    fontSize: 14,
    pointerEvents: "none",
  },
  searchInput: {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px 10px 34px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: 13,
    outline: "none",
  },
  sortSelect: {
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: 12,
    cursor: "pointer",
    outline: "none",
  },

  /* ── Category grid ── */
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
    gap: 20,
  },

  /* ── Category card ── */
  card: {
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    overflow: "hidden",
    transition: "transform .15s, box-shadow .15s",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 20px 12px",
    borderBottom: "1px solid var(--border)",
  },
  categoryName: {
    fontFamily: "var(--display)",
    fontSize: 15,
    fontWeight: 700,
    color: "var(--text)",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  categoryBadge: {
    fontFamily: "var(--mono)",
    fontSize: 11,
    color: "var(--text-dim)",
    background: "var(--surface)",
    borderRadius: 8,
    padding: "3px 10px",
  },
  cardBody: {
    padding: "6px 0",
  },

  /* ── Trait row ── */
  row: {
    display: "grid",
    gridTemplateColumns: "1fr auto auto auto",
    gap: 8,
    alignItems: "center",
    padding: "8px 20px",
    cursor: "pointer",
    transition: "background .12s",
  },
  rowHover: {
    background: "rgba(255,255,255,0.04)",
  },
  valueName: {
    fontFamily: "var(--mono)",
    fontSize: 13,
    color: "var(--text)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  rarityBadge: {
    fontFamily: "var(--mono)",
    fontSize: 11,
    fontWeight: 600,
    minWidth: 48,
    textAlign: "right",
  },
  countText: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text-muted)",
    textAlign: "right",
    minWidth: 40,
  },
  floorText: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text-dim)",
    textAlign: "right",
    minWidth: 70,
  },

  /* ── Progress bar ── */
  barOuter: {
    gridColumn: "1 / -1",
    height: 4,
    borderRadius: 2,
    background: "rgba(255,255,255,0.05)",
    overflow: "hidden",
    marginTop: 2,
  },
  barInner: (pct, color) => ({
    height: "100%",
    width: `${Math.max(pct, 1)}%`,
    borderRadius: 2,
    background: color,
    transition: "width .3s ease",
    boxShadow: color === "var(--gold)" ? "0 0 8px var(--gold)" : "none",
  }),

  /* ── Show all / Offer button ── */
  showAllBtn: {
    display: "block",
    width: "100%",
    padding: "10px 20px",
    border: "none",
    borderTop: "1px solid var(--border)",
    background: "transparent",
    color: "var(--naka-blue)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    cursor: "pointer",
    textAlign: "center",
    letterSpacing: 0.5,
    transition: "background .12s",
  },
  offerBtn: {
    padding: "4px 10px",
    border: "1px solid var(--gold)",
    borderRadius: 6,
    background: "transparent",
    color: "var(--gold)",
    fontFamily: "var(--mono)",
    fontSize: 10,
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "background .15s, color .15s",
  },
  filterGalleryBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 16px",
    borderRadius: 10,
    border: "1px solid var(--naka-blue)",
    background: "rgba(111,168,220,0.1)",
    color: "var(--naka-blue)",
    fontFamily: "var(--mono)",
    fontSize: 12,
    cursor: "pointer",
    transition: "background .15s, color .15s",
    whiteSpace: "nowrap",
  },

  /* ── Detail view ── */
  backBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 16px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: 12,
    cursor: "pointer",
    marginBottom: 16,
    transition: "background .12s",
  },
  selectedHeader: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 20,
    flexWrap: "wrap",
  },
  selectedBadge: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    color: "var(--naka-blue)",
    background: "rgba(111,168,220,0.12)",
    padding: "4px 12px",
    borderRadius: 8,
  },
  selectedValue: {
    fontFamily: "var(--display)",
    fontSize: 18,
    fontWeight: 600,
    color: "var(--text)",
  },
  selectedCount: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--text-dim)",
  },
  nftGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
    gap: 10,
    marginTop: 12,
  },
  nftItem: {
    borderRadius: 10,
    overflow: "hidden",
    border: "1px solid var(--border)",
    background: "var(--surface-glass)",
    cursor: "pointer",
    transition: "transform .12s, box-shadow .12s",
  },
  nftName: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text-dim)",
    padding: "6px 8px",
    textAlign: "center",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
};

/* ── Rarity color helper ── */
function rarityColor(pct) {
  if (pct < 5)  return "var(--gold)";
  if (pct < 15) return "var(--naka-blue)";
  return "var(--text-muted)";
}

/* ══════════════════════════════════════════════
   TraitExplorer — premium OpenSea-inspired view
   ══════════════════════════════════════════════ */
export default function TraitExplorer({ tokens, onPick, wallet, onConnect, addToast, listings, stats, loadAll, hasMore, onFilterGallery }) {
  const collection = useActiveCollection();
  const [selected, setSelected]   = useState(null);
  const [offerTrait, setOfferTrait] = useState(null);
  const [search, setSearch]       = useState("");
  const [sortBy, setSortBy]       = useState("most-values");
  const [expandedCategories, setExpandedCategories] = useState(new Set());
  const [hoveredRow, setHoveredRow] = useState(null);

  const debouncedSearch = useDebounce(search, 250);

  // Trigger loading all tokens when traits page is visited
  useEffect(() => {
    if (loadAll && hasMore) loadAll();
  }, [loadAll, hasMore]);

  // Reset all local state when collection changes to prevent stale data
  useEffect(() => {
    setSelected(null);
    setOfferTrait(null);
    setSearch("");
    setSortBy("most-values");
    setExpandedCategories(new Set());
    setHoveredRow(null);
  }, [collection.slug]);

  // Prefer live on-chain supply from API (most accurate, reflects burns).
  // Fall back to collection config, then loaded token count.
  const totalSupply = stats?.supply || collection.supply || tokens.length || 1;

  /* ── Build trait map with rarity % ── */
  const traitMap = useMemo(() => {
    const map = {};
    for (const token of tokens) {
      for (const attr of token.attributes || []) {
        if (!map[attr.key]) map[attr.key] = {};
        map[attr.key][attr.value] = (map[attr.key][attr.value] || 0) + 1;
      }
    }
    return Object.entries(map).map(([key, values]) => ({
      key,
      values: Object.entries(values)
        .map(([value, count]) => ({
          value,
          count,
          pct: parseFloat((count / totalSupply * 100).toFixed(1)),
        }))
        .sort((a, b) => a.count - b.count),
      totalValues: Object.keys(values).length,
    }));
  }, [tokens, totalSupply]);

  /* ── Trait floor prices from listings ── */
  const traitFloors = useMemo(() => {
    if (!listings || listings.length === 0) return {};
    // Build tokenId → price lookup
    const priceMap = {};
    for (const l of listings) {
      if (l.tokenId && l.price != null) {
        priceMap[String(l.tokenId)] = l.price;
      }
    }
    // Build trait → floor lookup
    const floors = {};
    for (const token of tokens) {
      const price = priceMap[String(token.id)];
      if (price == null) continue;
      for (const attr of token.attributes || []) {
        const k = `${attr.key}::${attr.value}`;
        if (floors[k] == null || price < floors[k]) {
          floors[k] = price;
        }
      }
    }
    return floors;
  }, [tokens, listings]);

  /* ── Summary stats ── */
  const summaryStats = useMemo(() => {
    const totalCategories = traitMap.length;
    const totalUniqueValues = traitMap.reduce((s, c) => s + c.totalValues, 0);
    let rarest = null;
    let mostCommon = null;
    for (const cat of traitMap) {
      for (const v of cat.values) {
        if (!rarest || v.pct < rarest.pct)         rarest = { ...v, category: cat.key };
        if (!mostCommon || v.pct > mostCommon.pct) mostCommon = { ...v, category: cat.key };
      }
    }
    return { totalCategories, totalUniqueValues, rarest, mostCommon };
  }, [traitMap]);

  /* ── Filter + sort categories ── */
  const displayedCategories = useMemo(() => {
    let cats = traitMap;

    // Search filter
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      cats = cats
        .map((cat) => {
          const catMatch = cat.key.toLowerCase().includes(q);
          const filteredValues = cat.values.filter((v) =>
            v.value.toString().toLowerCase().includes(q)
          );
          if (catMatch) return cat; // show full category
          if (filteredValues.length > 0) return { ...cat, values: filteredValues, totalValues: cat.totalValues };
          return null;
        })
        .filter(Boolean);
    }

    // Sort
    switch (sortBy) {
      case "most-values":
        return [...cats].sort((a, b) => b.totalValues - a.totalValues);
      case "rarest": {
        return [...cats].sort((a, b) => {
          const aMin = a.values[0]?.pct ?? 100;
          const bMin = b.values[0]?.pct ?? 100;
          return aMin - bMin;
        });
      }
      case "floor-asc": {
        return [...cats].sort((a, b) => {
          const aFloor = Math.min(...a.values.map((v) => traitFloors[`${a.key}::${v.value}`] ?? Infinity));
          const bFloor = Math.min(...b.values.map((v) => traitFloors[`${b.key}::${v.value}`] ?? Infinity));
          return aFloor - bFloor;
        });
      }
      case "az":
        return [...cats].sort((a, b) => a.key.localeCompare(b.key));
      default:
        return cats;
    }
  }, [traitMap, debouncedSearch, sortBy, traitFloors]);

  /* ── Toggle expanded ── */
  const toggleExpanded = useCallback((key) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /* ── Select a trait value ── */
  const handleSelect = useCallback((key, value) => {
    setSelected({ key, value });
  }, []);

  /* ── Open offer modal ── */
  const handleOffer = useCallback((e, key, value) => {
    e.stopPropagation();
    setOfferTrait({ key, value });
  }, []);

  /* ── Matching NFTs for detail view ── */
  const matchingNfts = useMemo(() => {
    if (!selected) return [];
    return tokens.filter((t) =>
      t.attributes?.some((a) => a.key === selected.key && a.value === selected.value)
    );
  }, [tokens, selected]);

  /* ════════════════════════════════════════════
     DETAIL VIEW — selected trait value
     ════════════════════════════════════════════ */
  if (selected) {
    return (
      <section style={S.page}>
        <button style={S.backBtn} onClick={() => setSelected(null)}>
          {"\u2190"} Back to Traits
        </button>
        <div style={S.selectedHeader}>
          <span style={S.selectedBadge}>{selected.key}</span>
          <span style={S.selectedValue}>{selected.value}</span>
          <span style={S.selectedCount}>{matchingNfts.length} NFTs</span>
          {onFilterGallery && (
            <button
              style={S.filterGalleryBtn}
              onClick={() => onFilterGallery(selected.key, selected.value)}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--naka-blue)"; e.currentTarget.style.color = "#fff"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(111,168,220,0.1)"; e.currentTarget.style.color = "var(--naka-blue)"; }}
            >
              {"\u2192"} Filter Gallery
            </button>
          )}
        </div>
        <TraitBidPanel
          traitKey={selected.key}
          traitValue={selected.value}
          matchCount={matchingNfts.length}
          wallet={wallet}
          onConnect={onConnect}
          addToast={addToast}
          onMakeOffer={(trait) => setOfferTrait(trait)}
        />
        <div style={S.nftGrid}>
          {matchingNfts.slice(0, 60).map((nft) => (
            <div
              key={nft.id}
              style={S.nftItem}
              onClick={() => onPick(nft)}
              onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-3px)"; e.currentTarget.style.boxShadow = "0 6px 20px rgba(0,0,0,.3)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}
            >
              <NftImage nft={nft} style={{ width: "100%", aspectRatio: "1", objectFit: "cover" }} />
              <div style={S.nftName}>{nft.name}</div>
            </div>
          ))}
        </div>

        {offerTrait && (
          <MakeOfferModal
            trait={offerTrait}
            onClose={() => setOfferTrait(null)}
            wallet={wallet}
            onConnect={onConnect}
            addToast={addToast}
          />
        )}
      </section>
    );
  }

  /* ════════════════════════════════════════════
     LOADING / EMPTY STATES
     ════════════════════════════════════════════ */
  if (tokens.length === 0) {
    return (
      <section style={S.page}>
        <div style={S.header}>
          <div style={S.title}>{collection.name} TRAITS</div>
        </div>
        <div style={{
          textAlign: "center",
          padding: "80px 20px",
          fontFamily: "var(--mono)",
          fontSize: 13,
          color: "var(--text-muted)",
        }}>
          <div className="spinner" style={{ margin: "0 auto 16px" }} />
          Loading trait data for {collection.name}...
        </div>
      </section>
    );
  }

  if (traitMap.length === 0) {
    return (
      <section style={S.page}>
        <div style={S.header}>
          <div style={S.title}>{collection.name} TRAITS</div>
        </div>
        <div style={{
          textAlign: "center",
          padding: "80px 20px",
          fontFamily: "var(--mono)",
          fontSize: 13,
          color: "var(--text-muted)",
        }}>
          <div style={{ fontSize: 32, marginBottom: 16, opacity: 0.5 }}>{"\uD83D\uDDC2"}</div>
          No trait data available for this collection.
        </div>
      </section>
    );
  }

  /* ════════════════════════════════════════════
     MAIN VIEW — category cards with trait rows
     ════════════════════════════════════════════ */
  return (
    <section style={S.page}>
      {/* ── Title ── */}
      <div style={S.header}>
        <div style={S.title}>{collection.name} TRAITS</div>
        <div style={S.subtitle}>
          Discover rarity across every trait. Click any value to browse matching NFTs.
        </div>
      </div>

      {/* ── Summary Stats Panel ── */}
      <div style={S.statsPanel}>
        <div style={S.statCard}>
          <div style={S.statLabel}>Categories</div>
          <div style={S.statValue}>{summaryStats.totalCategories}</div>
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Unique Values</div>
          <div style={S.statValue}>{summaryStats.totalUniqueValues}</div>
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Tokens Loaded</div>
          <div style={S.statValue}>{tokens.length.toLocaleString()}</div>
          {stats?.supply && tokens.length < stats.supply && (
            <div style={{ ...S.statLabel, marginTop: 2, color: "var(--naka-blue)" }}>
              of {stats.supply.toLocaleString()} supply
            </div>
          )}
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Rarest Trait</div>
          {summaryStats.rarest && (
            <>
              <div style={S.statGold}>{summaryStats.rarest.value}</div>
              <div style={{ ...S.statLabel, marginTop: 2, color: "var(--gold)" }}>
                {summaryStats.rarest.pct}% &middot; {summaryStats.rarest.category}
              </div>
            </>
          )}
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Most Common</div>
          {summaryStats.mostCommon && (
            <>
              <div style={{ ...S.statValue, fontSize: 14 }}>{summaryStats.mostCommon.value}</div>
              <div style={{ ...S.statLabel, marginTop: 2 }}>
                {summaryStats.mostCommon.pct}% &middot; {summaryStats.mostCommon.category}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Character Type Explorer (Nakamigos only) ── */}
      {collection.slug === "nakamigos" && (
        <CharacterTypeExplorer
          tokens={tokens}
          listings={listings}
          onFilterGallery={onFilterGallery}
        />
      )}

      {/* ── Search + Sort Toolbar ── */}
      <div style={S.toolbar}>
        <div style={S.searchWrap}>
          <span style={S.searchIcon}>{"\u2315"}</span>
          <input
            style={S.searchInput}
            placeholder="Search traits or values\u2026"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search trait categories and values"
          />
        </div>
        <select
          style={S.sortSelect}
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          aria-label="Sort trait categories"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)" }}>
          {displayedCategories.length} categories
        </div>
      </div>

      {/* ── Category Cards Grid ── */}
      <div style={S.grid}>
        {displayedCategories.map((category) => {
          const isExpanded = expandedCategories.has(category.key);
          const visibleValues = isExpanded ? category.values : category.values.slice(0, 8);
          const hasMore = category.values.length > 8;

          return (
            <div
              key={category.key}
              style={S.card}
              onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 8px 32px rgba(0,0,0,.25)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}
            >
              {/* Card Header */}
              <div style={S.cardHeader}>
                <div>
                  <span style={S.categoryName}>{category.key}</span>
                  {(() => {
                    const slug = collection.slug;
                    const desc = TRAIT_LORE[slug]?.categories?.[category.key]
                      || TRAIT_LORE[slug]?.traitParams?.[category.key];
                    return desc ? (
                      <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4, maxWidth: 220 }}>
                        {desc}
                      </div>
                    ) : null;
                  })()}
                </div>
                <span style={S.categoryBadge}>{category.totalValues} values</span>
              </div>

              {/* Trait Rows */}
              <div style={S.cardBody}>
                {visibleValues.map((v) => {
                  const floorPrice = traitFloors[`${category.key}::${v.value}`];
                  const color = rarityColor(v.pct);
                  const rowKey = `${category.key}::${v.value}`;
                  const isHovered = hoveredRow === rowKey;

                  return (
                    <div
                      key={v.value}
                      style={{ ...S.row, ...(isHovered ? S.rowHover : {}) }}
                      onClick={() => handleSelect(category.key, v.value)}
                      onMouseEnter={() => setHoveredRow(rowKey)}
                      onMouseLeave={() => setHoveredRow(null)}
                      title={`${v.value}: ${v.count} NFTs (${v.pct}%)`}
                    >
                      {/* Value Name */}
                      <span style={S.valueName}>{v.value}</span>

                      {/* Rarity % */}
                      <span style={{ ...S.rarityBadge, color }}>{v.pct}%</span>

                      {/* Count */}
                      <span style={S.countText}>{v.count}</span>

                      {/* Floor price or offer button */}
                      {floorPrice != null ? (
                        <span style={{ ...S.floorText, color: "var(--green)" }}>
                          {floorPrice < 0.01 ? "<0.01" : floorPrice.toFixed(floorPrice < 1 ? 3 : 2)} ETH
                        </span>
                      ) : (
                        <button
                          style={S.offerBtn}
                          onClick={(e) => handleOffer(e, category.key, v.value)}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gold)"; e.currentTarget.style.color = "#000"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--gold)"; }}
                        >
                          Offer
                        </button>
                      )}

                      {/* Progress bar */}
                      <div style={S.barOuter}>
                        <div style={S.barInner(v.pct, color)} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Show All / Show Less */}
              {hasMore && (
                <button
                  style={S.showAllBtn}
                  onClick={() => toggleExpanded(category.key)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  {isExpanded
                    ? "Show less \u25B2"
                    : `Show all ${category.values.length} \u25BC`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Empty search state */}
      {displayedCategories.length === 0 && debouncedSearch && (
        <div style={{
          textAlign: "center",
          padding: "60px 20px",
          fontFamily: "var(--mono)",
          fontSize: 13,
          color: "var(--text-muted)",
        }}>
          No traits matching &ldquo;{debouncedSearch}&rdquo;
        </div>
      )}

      {/* ── Offer Modal ── */}
      {offerTrait && (
        <MakeOfferModal
          trait={offerTrait}
          onClose={() => setOfferTrait(null)}
          wallet={wallet}
          onConnect={onConnect}
          addToast={addToast}
        />
      )}
    </section>
  );
}
