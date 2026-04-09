import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import Skeleton from "./Skeleton";
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

export default memo(function Gallery({ tokens, loading, error, hasMore, onLoadMore, onFilter, onPick, traitFilters, activeFilters, sortBy, onSort, favorites, onToggleFavorite, cart, onAddToCart, listings, allTokens, totalSupply }) {
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

  // Client-side search + listed-only + price range filtering on loaded tokens (debounced)
  const displayed = useMemo(() => {
    let result = tokens;

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter((n) =>
        (n.name || "").toLowerCase().includes(q) || String(n.id).includes(q)
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
        const p = n.price || 0;
        return p >= min && p <= max;
      });
    }

    return result;
  }, [tokens, debouncedSearch, listedOnly, listings, priceRange]);

  const hasActiveFilters = Object.keys(activeFilters).length > 0 || listedOnly || priceRange.min || priceRange.max || !!debouncedSearch;

  // Use actual collection supply for accurate rarity %; fall back to loaded count
  const totalTokens = totalSupply || allTokens?.length || tokens.length;

  return (
    <section style={{ position: "relative", zIndex: 1, maxWidth: 1440, margin: "0 auto" }}>
      {/* Toolbar */}
      <div className="toolbar">
        <MobileFilterButton
          activeCount={Object.values(activeFilters).reduce((c, v) => c + v.length, 0) + (listedOnly ? 1 : 0)}
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
              ? `${displayed.length.toLocaleString()} result${displayed.length !== 1 ? "s" : ""}${totalSupply ? ` of ${totalSupply.toLocaleString()} items` : ""}`
              : hasMore && totalSupply
                ? `${displayed.length.toLocaleString()} of ${totalSupply.toLocaleString()} items`
                : hasMore
                  ? `${displayed.length.toLocaleString()}+`
                  : `${displayed.length.toLocaleString()} items`}
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
              <button onClick={onLoadMore}>Retry</button>
            </div>
          )}

          {/* Virtualized Grid */}
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
          />

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
