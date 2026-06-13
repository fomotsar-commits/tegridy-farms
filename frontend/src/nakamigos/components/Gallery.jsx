import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import VirtualGalleryGrid from "./VirtualGalleryGrid";
import FilterSidebar, { FilterPills, MobileFilterButton } from "./FilterSidebar";
import { SORT_OPTIONS } from "../constants";
import { useActiveCollection } from "../contexts/CollectionContext";

// Debounce hook
function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default memo(function Gallery({ tokens, loading, error, hasMore, onLoadMore, onRetry, onFilter, onPick, traitFilters, activeFilters, sortBy, onSort, favorites, onToggleFavorite, cart, onAddToCart, listings, allTokens, totalSupply }) {
  const collection = useActiveCollection();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState("gallery");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [listedOnly, setListedOnly] = useState(false);
  const [priceRange, setPriceRange] = useState({ min: "", max: "" });
  const debouncedSearch = useDebounce(search, 250);

  // Reset local filter/search state when collection changes
  useEffect(() => {
    setSearch("");
    setListedOnly(false);
    setPriceRange({ min: "", max: "" });
    setMobileSidebarOpen(false);
  }, [collection.slug]);

  // Listing price lookup — normalizeToken hard-sets price:null, so the only
  // source of a gallery card's price is the listings feed. Join it on by tokenId.
  const priceById = useMemo(() => {
    const m = new Map();
    for (const l of listings || []) {
      const id = String(l.tokenId ?? l.id);
      if (id && l.price != null) m.set(id, l.price);
    }
    return m;
  }, [listings]);

  // Client-side search + listed-only + price range filtering on loaded tokens (debounced).
  // Merge listing prices onto tokens first so the price-range filter, the price
  // sort, and the card price badge all operate on real prices instead of null.
  const displayed = useMemo(() => {
    let result = priceById.size
      ? tokens.map((n) => {
          const p = priceById.get(String(n.id));
          return p != null && p !== n.price ? { ...n, price: p } : n;
        })
      : tokens;

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter((n) =>
        (n.name || "").toLowerCase().includes(q) || String(n.id).toLowerCase().includes(q)
        || (n.attributes || []).some((a) => String(a.value).toLowerCase().includes(q))
      );
    }

    if (listedOnly && listings) {
      const listedIds = new Set(listings.map((l) => String(l.tokenId || l.id)));
      result = result.filter((n) => listedIds.has(String(n.id)));
    }

    if (priceRange.min || priceRange.max) {
      const min = priceRange.min ? parseFloat(priceRange.min) : 0;
      const max = priceRange.max ? parseFloat(priceRange.max) : Infinity;
      result = result.filter((n) => {
        const p = n.price;
        if (p === 0 || p === null || p === undefined) return false;
        return p >= min && p <= max;
      });
    }

    // The upstream sort in useNfts ran before prices were joined on, so a
    // price sort there was a no-op (all-null). Re-apply it here on merged prices.
    if (sortBy === "price" || sortBy === "price-asc") {
      const withPrice = [];
      const withoutPrice = [];
      for (const n of result) (n.price != null ? withPrice : withoutPrice).push(n);
      withPrice.sort((a, b) =>
        sortBy === "price-asc" ? a.price - b.price : b.price - a.price
      );
      // Keep priceless tokens after priced ones, preserving their existing order.
      result = [...withPrice, ...withoutPrice];
    }

    return result;
  }, [tokens, priceById, debouncedSearch, listedOnly, listings, priceRange, sortBy]);

  // Scroll-reset key: changes only on a genuine filter/sort/search change, never
  // on a loadMore append — so infinite scroll keeps the viewport in place (F562).
  const resetKey = useMemo(
    () => JSON.stringify({ activeFilters, sortBy, debouncedSearch, listedOnly, priceRange, viewMode }),
    [activeFilters, sortBy, debouncedSearch, listedOnly, priceRange, viewMode]
  );

  const hasActiveFilters = Object.keys(activeFilters).length > 0 || listedOnly || priceRange.min || priceRange.max || !!debouncedSearch;

  // Rarity sort needs ranks; for partially-loaded collections ranks may not be
  // present yet. Surface that instead of silently falling back to id order.
  const rankPending = useMemo(
    () => (sortBy === "rarity") && displayed.length > 0 && !displayed.some((n) => n.rank != null),
    [sortBy, displayed]
  );

  // Use actual collection supply for the absolute count column; fall back to loaded count
  const totalTokens = totalSupply || allTokens?.length || tokens.length;
  // Loaded-sample size for trait rarity % (traitFilters are extracted from the
  // loaded tokens, so % must divide by this, not full supply — see FilterSidebar).
  const loadedCount = allTokens?.length || tokens.length;

  return (
    <section style={{ position: "relative", zIndex: 1, maxWidth: 1440, margin: "0 auto" }}>
      {/* Toolbar */}
      <div className="toolbar">
        <MobileFilterButton
          activeCount={Object.values(activeFilters).reduce((c, v) => c + v.length, 0) + (listedOnly ? 1 : 0) + ((priceRange.min || priceRange.max) ? 1 : 0)}
          onClick={() => setMobileSidebarOpen(true)}
        />

        <div className="search-wrap">
          <span className="search-icon">{"\u2315"}</span>
          <input
            className="search-input"
            placeholder="Search by name or token ID"
            aria-label="Search NFTs by name or token ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select
          className="sort-select"
          value={sortBy || "tokenId"}
          onChange={(e) => onSort(e.target.value)}
          aria-label="Sort NFTs"
        >
          {SORT_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        <button
          className="sidebar-toggle-btn"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label={sidebarOpen ? "Hide filters sidebar" : "Show filters sidebar"}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? "Hide filters" : "Show filters"}
        >
          {sidebarOpen ? "\u00AB" : "\u00BB"}
        </button>

        <div className="view-toggle" role="group" aria-label="View mode">
          {[["gallery", "\u229E"], ["compact", "\u229F"]].map(([k, icon]) => (
            <button key={k} onClick={() => setViewMode(k)} className={`view-btn ${viewMode === k ? "active" : ""}`} aria-label={`${k} view`} aria-pressed={viewMode === k}>
              {icon}
            </button>
          ))}
        </div>

        <div className="item-count">
          {loading && tokens.length === 0
            ? "Loading\u2026"
            : hasActiveFilters
              // When the whole collection isn't loaded yet, filters only see the
              // loaded sample \u2014 say so rather than implying a full-supply search.
              ? `${displayed.length.toLocaleString()} result${displayed.length !== 1 ? "s" : ""}${
                  hasMore
                    ? ` of ${loadedCount.toLocaleString()} loaded`
                    : totalSupply ? ` of ${totalSupply.toLocaleString()} items` : ""
                }`
              : hasMore && totalSupply
                ? `${displayed.length.toLocaleString()} of ${totalSupply.toLocaleString()} items`
                : hasMore
                  ? `${displayed.length.toLocaleString()}+`
                  : `${displayed.length.toLocaleString()} items`}
          {rankPending && (
            <span style={{ marginLeft: 8, opacity: 0.7, fontStyle: "italic" }}>
              {"\u00b7"} rank data loading{"\u2026"}
            </span>
          )}
        </div>
      </div>

      {/* Mobile sidebar overlay (renders independently of desktop sidebar state) */}
      {mobileSidebarOpen && (
        <FilterSidebar
          traitFilters={traitFilters}
          activeFilters={activeFilters}
          onFilterChange={onFilter}
          listings={listings}
          totalTokens={totalTokens}
          loadedCount={loadedCount}
          onClose={() => setMobileSidebarOpen(false)}
          isOpen={mobileSidebarOpen}
          isMobileOverlay
          listedOnly={listedOnly}
          onToggleListedOnly={() => setListedOnly((v) => !v)}
          priceRange={priceRange}
          onPriceChange={setPriceRange}
        />
      )}

      {/* Main layout: sidebar + content */}
      <div style={{
        display: "grid",
        gridTemplateColumns: sidebarOpen ? "260px 1fr" : "1fr",
        gap: 0,
        minHeight: 400,
      }} className="gallery-layout">
        {/* Desktop FilterSidebar */}
        {sidebarOpen && (
          <div className="desktop-sidebar">
            <FilterSidebar
              traitFilters={traitFilters}
              activeFilters={activeFilters}
              onFilterChange={onFilter}
              listings={listings}
              totalTokens={totalTokens}
              loadedCount={loadedCount}
              onClose={() => setSidebarOpen(false)}
              isOpen={sidebarOpen}
              listedOnly={listedOnly}
              onToggleListedOnly={() => setListedOnly((v) => !v)}
              priceRange={priceRange}
              onPriceChange={setPriceRange}
            />
          </div>
        )}

        {/* Content area */}
        <div style={{ minWidth: 0 }}>
          {/* Filter pills */}
          <FilterPills
            activeFilters={activeFilters}
            onFilterChange={onFilter}
            listedOnly={listedOnly}
            onToggleListedOnly={() => setListedOnly((v) => !v)}
            priceRange={priceRange}
            onClearPrice={() => setPriceRange({ min: "", max: "" })}
          />

          {/* Error Banner */}
          {error && (
            <div className="error-banner">
              <span>{error}</span>
              <button onClick={onRetry || onLoadMore}>Retry</button>
            </div>
          )}

          {/* Virtualized Grid — skip entirely when there's nothing to show so the
              grid's own full-height "No items found" doesn't stack above the
              styled empty-state below (F579). */}
          {(loading || displayed.length > 0) && (
            <VirtualGalleryGrid
              tokens={displayed}
              loading={loading}
              onPick={onPick}
              viewMode={viewMode}
              favorites={favorites}
              onToggleFavorite={onToggleFavorite}
              hasMore={hasMore && !search}
              onLoadMore={onLoadMore}
              cart={cart}
              onAddToCart={onAddToCart}
              resetKey={resetKey}
            />
          )}

          {/* Empty State */}
          {!loading && displayed.length === 0 && (
            <div className="empty-state">
              <div className="empty-state-icon">
                {search ? "\uD83D\uDD0D" : hasActiveFilters ? "\uD83D\uDD27" : "\uD83D\uDDBC"}
              </div>
              <div className="empty-state-title">
                {search
                  ? "No Results Found"
                  : hasActiveFilters
                    ? `No ${collection.name} Match These Filters`
                    : `No ${collection.name} Available`}
              </div>
              <div className="empty-state-text">
                {search
                  ? "Try a different search term or clear your filters."
                  : hasActiveFilters
                    ? "Try removing some filters or adjusting the price range."
                    : "There are no tokens to display right now. Check back soon."}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Responsive CSS for mobile filter button, sidebar toggle, and sidebar grid */}
      <style>{`
        .mobile-filter-btn { display: none !important; }
        .sidebar-toggle-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--surface-glass);
          backdrop-filter: var(--glass-blur);
          color: var(--text);
          font-family: var(--mono);
          font-size: 14px;
          cursor: pointer;
          flex-shrink: 0;
        }
        .sidebar-toggle-btn:hover { background: var(--surface); }
        @media (max-width: 767px) {
          .mobile-filter-btn { display: inline-flex !important; }
          .sidebar-toggle-btn { display: none !important; }
          .gallery-layout { grid-template-columns: 1fr !important; }
          .gallery-layout > .desktop-sidebar { display: none !important; }
        }
      `}</style>
    </section>
  );
})
