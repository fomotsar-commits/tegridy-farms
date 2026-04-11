import { useState, useEffect, useMemo, useCallback, memo } from "react";

/* ── Rarity color helper (matches TraitExplorer) ── */
function rarityColor(pct) {
  if (pct < 5)  return "var(--gold)";
  if (pct < 15) return "var(--naka-blue)";
  return "var(--text-muted)";
}

/* ── Styles ── */
const S = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 8999,
    background: "rgba(0,0,0,0.5)",
  },
  sidebar: {
    width: 260,
    height: "100%",
    overflowY: "auto",
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    borderRight: "1px solid var(--border)",
    padding: "16px 0",
    boxSizing: "border-box",
    flexShrink: 0,
  },
  sidebarMobile: {
    position: "fixed",
    top: 0,
    left: 0,
    zIndex: 9000,
    width: "min(280px, 85vw)",
    height: "100vh",
    overflowY: "auto",
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    borderRight: "1px solid var(--border)",
    padding: "16px 0",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px 12px",
    borderBottom: "1px solid var(--border)",
    marginBottom: 12,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  headerLabel: {
    fontFamily: "var(--pixel)",
    fontSize: 13,
    letterSpacing: 2,
    color: "var(--text)",
    textTransform: "uppercase",
  },
  badge: {
    background: "var(--naka-blue)",
    color: "#fff",
    fontFamily: "var(--mono)",
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 10,
    padding: "2px 7px",
    lineHeight: "14px",
  },
  clearBtn: {
    background: "none",
    border: "none",
    color: "var(--naka-blue)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 6,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    fontSize: 18,
    cursor: "pointer",
    padding: "4px 8px",
    lineHeight: 1,
  },
  section: {
    padding: "0 16px",
    marginBottom: 8,
  },
  sectionLabel: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    color: "var(--text-muted)",
    marginBottom: 8,
  },
  toggleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 0",
  },
  toggleLabel: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--text)",
  },
  toggle: (active) => ({
    width: 36,
    height: 20,
    borderRadius: 10,
    background: active ? "var(--naka-blue)" : "rgba(255,255,255,0.1)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    position: "relative",
    transition: "background .2s",
    flexShrink: 0,
  }),
  toggleKnob: (active) => ({
    position: "absolute",
    top: 2,
    left: active ? 18 : 2,
    width: 14,
    height: 14,
    borderRadius: "50%",
    background: "#fff",
    transition: "left .2s",
  }),
  priceRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  priceInput: {
    flex: 1,
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: 12,
    outline: "none",
    boxSizing: "border-box",
    width: "100%",
  },
  divider: {
    height: 1,
    background: "var(--border)",
    margin: "8px 16px",
  },
  accordionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 16px",
    cursor: "pointer",
    userSelect: "none",
    borderRadius: 0,
    transition: "background .15s",
  },
  accordionLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  accordionName: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--text)",
    textTransform: "capitalize",
  },
  accordionBadge: {
    background: "var(--naka-blue)",
    color: "#fff",
    fontFamily: "var(--mono)",
    fontSize: 9,
    fontWeight: 700,
    borderRadius: 8,
    padding: "1px 6px",
    lineHeight: "13px",
  },
  arrow: (expanded) => ({
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text-muted)",
    transition: "transform .2s",
    transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
  }),
  accordionBody: {
    padding: "0 16px 8px",
  },
  traitSearch: {
    width: "100%",
    boxSizing: "border-box",
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    outline: "none",
    marginBottom: 6,
  },
  valueList: {
    maxHeight: 200,
    overflowY: "auto",
  },
  valueRow: (hovered) => ({
    display: "grid",
    gridTemplateColumns: "20px 1fr auto auto",
    gap: 6,
    alignItems: "center",
    padding: "5px 4px",
    borderRadius: 6,
    cursor: "pointer",
    background: hovered ? "rgba(255,255,255,0.04)" : "transparent",
    transition: "background .15s",
  }),
  checkbox: (checked) => ({
    width: 16,
    height: 16,
    borderRadius: 3,
    border: checked ? "none" : "1.5px solid var(--border)",
    background: checked ? "var(--naka-blue)" : "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 10,
    color: "#fff",
    fontWeight: 700,
    flexShrink: 0,
    transition: "background .15s, border .15s",
  }),
  valueName: {
    fontFamily: "var(--mono)",
    fontSize: 11,
    color: "var(--text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  valueCount: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text-muted)",
    textAlign: "right",
  },
  valuePct: (color) => ({
    fontFamily: "var(--mono)",
    fontSize: 10,
    color,
    textAlign: "right",
    minWidth: 32,
  }),
  barOuter: {
    gridColumn: "1 / -1",
    height: 3,
    borderRadius: 2,
    background: "rgba(255,255,255,0.05)",
    overflow: "hidden",
    marginTop: 1,
  },
  barInner: (pct, color) => ({
    height: "100%",
    width: `${Math.max(pct, 1)}%`,
    borderRadius: 2,
    background: color,
    transition: "width .3s ease",
  }),
  /* ── Filter pills (rendered outside sidebar) ── */
  pillsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 12,
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "4px 10px",
    fontFamily: "var(--mono)",
    fontSize: 11,
    color: "var(--text)",
    cursor: "default",
  },
  pillX: {
    cursor: "pointer",
    color: "var(--text-muted)",
    fontWeight: 700,
    fontSize: 12,
    lineHeight: 1,
    marginLeft: 2,
  },
  mobileBtn: {
    display: "none",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: 12,
    cursor: "pointer",
  },
};

/* ── Filter Pills (exported for use outside sidebar) ── */
export function FilterPills({ activeFilters, onFilterChange, listedOnly, onToggleListedOnly, priceRange, onClearPrice }) {
  const entries = [];
  for (const [key, values] of Object.entries(activeFilters)) {
    for (const val of values) {
      entries.push({ key, val });
    }
  }

  const removePill = (key, val) => {
    const next = { ...activeFilters };
    next[key] = next[key].filter((v) => v !== val);
    if (next[key].length === 0) delete next[key];
    onFilterChange(next);
  };

  const hasPrice = priceRange && (priceRange.min || priceRange.max);
  if (entries.length === 0 && !listedOnly && !hasPrice) return null;

  return (
    <div style={S.pillsRow}>
      {listedOnly && (
        <span style={S.pill}>
          Listed Only
          <span style={S.pillX} onClick={onToggleListedOnly} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleListedOnly(); } }} role="button" tabIndex={0} aria-label="Remove listed only filter">&times;</span>
        </span>
      )}
      {hasPrice && (
        <span style={S.pill}>
          Price: {priceRange.min || "0"} - {priceRange.max || "\u221E"} ETH
          <span style={S.pillX} onClick={onClearPrice} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClearPrice(); } }} role="button" tabIndex={0} aria-label="Remove price filter">&times;</span>
        </span>
      )}
      {entries.map(({ key, val }) => (
        <span key={`${key}:${val}`} style={S.pill}>
          {key}: {val}
          <span style={S.pillX} onClick={() => removePill(key, val)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); removePill(key, val); } }} role="button" tabIndex={0} aria-label={`Remove ${key}: ${val} filter`}>&times;</span>
        </span>
      ))}
    </div>
  );
}

/* ── Mobile Filters Button (exported) ── */
export function MobileFilterButton({ activeCount, onClick }) {
  return (
    <button
      onClick={onClick}
      style={S.mobileBtn}
      className="mobile-filter-btn"
      aria-label="Toggle filters"
    >
      <span style={{ fontSize: 14 }}>{"\u2630"}</span>
      Filters
      {activeCount > 0 && <span style={S.badge}>{activeCount}</span>}
    </button>
  );
}

/* ── Main Sidebar ── */
export default memo(function FilterSidebar({
  traitFilters,
  activeFilters,
  onFilterChange,
  listings,
  totalTokens,
  onClose,
  isOpen,
  isMobileOverlay,
  listedOnly,
  onToggleListedOnly,
  priceRange,
  onPriceChange,
}) {
  const [expanded, setExpanded] = useState(new Set());
  const [traitSearch, setTraitSearch] = useState({});
  const [hoveredRow, setHoveredRow] = useState(null);
  const [isMobile, setIsMobile] = useState(false);

  // Reset accordion/search state when trait filters change (i.e., new collection loaded)
  useEffect(() => {
    setExpanded(new Set());
    setTraitSearch({});
    setHoveredRow(null);
  }, [traitFilters]);

  // Check mobile on mount + resize
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const activeCount = useMemo(() => {
    let c = 0;
    for (const vals of Object.values(activeFilters)) c += vals.length;
    if (listedOnly) c++;
    if (priceRange?.min || priceRange?.max) c++;
    return c;
  }, [activeFilters, listedOnly, priceRange]);

  const toggleExpand = useCallback((key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleValue = useCallback((traitKey, value) => {
    const next = { ...activeFilters };
    const arr = next[traitKey] ? [...next[traitKey]] : [];
    const idx = arr.indexOf(value);
    if (idx >= 0) {
      arr.splice(idx, 1);
    } else {
      arr.push(value);
    }
    if (arr.length === 0) {
      delete next[traitKey];
    } else {
      next[traitKey] = arr;
    }
    onFilterChange(next);
  }, [activeFilters, onFilterChange]);

  const clearAll = useCallback(() => {
    onFilterChange({});
    if (listedOnly) onToggleListedOnly();
    if (priceRange?.min || priceRange?.max) onPriceChange({ min: "", max: "" });
  }, [onFilterChange, listedOnly, onToggleListedOnly, priceRange, onPriceChange]);

  // isMobileOverlay is explicitly set by Gallery.jsx for the mobile overlay instance
  // Desktop sidebar instances never render as mobile overlay
  const renderAsMobile = !!isMobileOverlay;

  if (!isOpen && renderAsMobile) return null;

  const sidebarStyle = renderAsMobile ? S.sidebarMobile : S.sidebar;

  const content = (
    <div style={sidebarStyle}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerLeft}>
          <span style={S.headerLabel}>Filters</span>
          {activeCount > 0 && <span style={S.badge}>{activeCount}</span>}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {activeCount > 0 && (
            <button style={S.clearBtn} onClick={clearAll}>Clear All</button>
          )}
          <button style={S.closeBtn} onClick={onClose} aria-label="Close filters">&times;</button>
        </div>
      </div>

      {/* Listed Only Toggle */}
      <div style={S.section}>
        <div style={S.toggleRow}>
          <span style={S.toggleLabel}>Listed Only</span>
          <div
            style={S.toggle(listedOnly)}
            onClick={onToggleListedOnly}
            role="switch"
            aria-checked={listedOnly}
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onToggleListedOnly(); }}
          >
            <div style={S.toggleKnob(listedOnly)} />
          </div>
        </div>
      </div>

      <div style={S.divider} />

      {/* Price Range */}
      <div style={S.section}>
        <div style={S.sectionLabel}>Price Range</div>
        <div style={S.priceRow}>
          <input
            type="number"
            placeholder="Min ETH"
            style={S.priceInput}
            value={priceRange?.min || ""}
            onChange={(e) => onPriceChange({ ...priceRange, min: e.target.value })}
            min="0"
            step="0.01"
          />
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11 }}>-</span>
          <input
            type="number"
            placeholder="Max ETH"
            style={S.priceInput}
            value={priceRange?.max || ""}
            onChange={(e) => onPriceChange({ ...priceRange, max: e.target.value })}
            min="0"
            step="0.01"
          />
        </div>
      </div>

      <div style={S.divider} />

      {/* Trait Accordion Sections */}
      {traitFilters.map((attr) => {
        const isExpanded = expanded.has(attr.key);
        const selectedCount = activeFilters[attr.key]?.length || 0;
        const searchVal = traitSearch[attr.key] || "";

        const filteredValues = searchVal
          ? attr.values.filter((v) => String(v.value).toLowerCase().includes(searchVal.toLowerCase()))
          : attr.values;

        return (
          <div key={attr.key}>
            <div
              style={S.accordionHeader}
              onClick={() => toggleExpand(attr.key)}
              role="button"
              aria-expanded={isExpanded}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleExpand(attr.key); }}
            >
              <div style={S.accordionLeft}>
                <span style={S.arrow(isExpanded)}>{"\u25B6"}</span>
                <span style={S.accordionName}>{attr.key}</span>
                {selectedCount > 0 && <span style={S.accordionBadge}>{selectedCount}</span>}
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)" }}>
                {attr.values.length}
              </span>
            </div>

            {isExpanded && (
              <div style={S.accordionBody}>
                {attr.values.length > 8 && (
                  <input
                    type="text"
                    placeholder={`Search ${attr.key}...`}
                    style={S.traitSearch}
                    value={searchVal}
                    onChange={(e) => setTraitSearch((prev) => ({ ...prev, [attr.key]: e.target.value }))}
                  />
                )}
                <div style={S.valueList}>
                  {filteredValues.map((v) => {
                    const pct = totalTokens > 0 ? parseFloat((v.count / totalTokens * 100).toFixed(1)) : 0;
                    const color = rarityColor(pct);
                    const isChecked = activeFilters[attr.key]?.includes(v.value) || false;
                    const rowKey = `${attr.key}::${v.value}`;
                    const isHovered = hoveredRow === rowKey;

                    return (
                      <div key={v.value}>
                        <div
                          style={S.valueRow(isHovered)}
                          onClick={() => toggleValue(attr.key, v.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleValue(attr.key, v.value); } }}
                          onMouseEnter={() => setHoveredRow(rowKey)}
                          onMouseLeave={() => setHoveredRow(null)}
                          role="checkbox"
                          aria-checked={isChecked}
                          aria-label={`${attr.key}: ${v.value}, ${pct}%`}
                          tabIndex={0}
                          title={`${v.value}: ${v.count} NFTs (${pct}%)`}
                        >
                          <div style={S.checkbox(isChecked)}>
                            {isChecked && "\u2713"}
                          </div>
                          <span style={S.valueName}>{v.value}</span>
                          <span style={S.valuePct(color)}>{pct}%</span>
                          <span style={S.valueCount}>{v.count}</span>
                        </div>
                        <div style={S.barOuter}>
                          <div style={S.barInner(pct, color)} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // On mobile overlay, wrap content with backdrop overlay
  if (renderAsMobile) {
    return (
      <>
        <div style={S.overlay} onClick={onClose} />
        {content}
      </>
    );
  }

  return content;
})
