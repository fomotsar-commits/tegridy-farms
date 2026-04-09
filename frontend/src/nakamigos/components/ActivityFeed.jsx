import { useState, useEffect, useMemo, useCallback, memo } from "react";
import { Eth } from "./Icons";
import { formatPrice } from "../lib/formatPrice";
import { EnsName } from "../hooks/useEns.jsx";
import { fetchActivity } from "../api";
import { useActiveCollection } from "../contexts/CollectionContext";

const EVENT_COLORS = {
  sale: "var(--green)",
  ask: "var(--yellow)",
  bid: "var(--purple)",
  transfer: "var(--text-dim)",
  mint: "var(--gold)",
};
const EVENT_LABELS = {
  sale: "Sale",
  ask: "Listed",
  bid: "Bid",
  transfer: "Transfer",
  mint: "Mint",
};

const DATE_RANGE_OPTIONS = [
  { label: "24h", value: 1 },
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "All Time", value: 3650 },
];

function formatTimeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 31536000) return `${Math.floor(diff / 86400)}d ago`;
  // For events older than ~1 year, show the actual date
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default memo(function ActivityFeed({ activities: propActivities, isLive, isWebSocketConnected, addToast }) {
  const collection = useActiveCollection();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [daysBack, setDaysBack] = useState(30);
  const [fetchedActivities, setFetchedActivities] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingFresh, setLoadingFresh] = useState(false);
  const [nextPageKey, setNextPageKey] = useState(null);
  // Track whether the API responded successfully but had zero sales
  // (vs network error / fallback). Helps show a more informative empty state.
  const [apiEmpty, setApiEmpty] = useState(false);
  const [apiFallback, setApiFallback] = useState(false);

  // Clear state and re-fetch when the active collection changes
  useEffect(() => {
    setFetchedActivities([]);
    setNextPageKey(null);
    setFilter("all");
    setSearch("");
    setApiEmpty(false);
    setApiFallback(false);
  }, [collection.contract]);

  // Fetch activities with selected date range
  const loadActivities = useCallback(async (days, pageKey = null) => {
    if (pageKey) {
      setLoadingMore(true);
    } else {
      setLoadingFresh(true);
    }
    try {
      const data = await fetchActivity({ contract: collection.contract, limit: 50, daysBack: days, pageKey });
      if (pageKey) {
        setFetchedActivities(prev => {
          const existing = new Set(prev.map(a => a.hash ? `${a.hash}-${a.token?.id}` : null).filter(Boolean));
          const newOnes = (data.activities || []).filter(a => {
            if (!a.hash) return true;
            return !existing.has(`${a.hash}-${a.token?.id}`);
          });
          return [...prev, ...newOnes];
        });
      } else {
        setFetchedActivities(data.activities || []);
        setApiEmpty(!!data.empty);
        setApiFallback(!!data.fallback);
      }
      setNextPageKey(data.pageKey || null);
    } catch (err) {
      console.warn("ActivityFeed: fetchActivity error:", err.message);
      addToast?.("Failed to load activity", "error");
    } finally {
      setLoadingMore(false);
      setLoadingFresh(false);
    }
  }, [addToast, collection.contract]);

  // Re-fetch when daysBack or collection changes
  useEffect(() => {
    loadActivities(daysBack);
  }, [daysBack, loadActivities]);

  // Merge: WebSocket/prop activities overlay on top of fetched data
  const activities = useMemo(() => {
    if (!propActivities?.length) return fetchedActivities;
    if (!fetchedActivities.length) return propActivities;
    // Deduplicate by hash+tokenId so bundle sales (multiple NFTs in one tx) are preserved
    const seen = new Set();
    const merged = [];
    for (const a of propActivities) {
      const key = a.hash ? `${a.hash}-${a.token?.id}` : null;
      if (key) seen.add(key);
      merged.push(a);
    }
    for (const a of fetchedActivities) {
      const key = a.hash ? `${a.hash}-${a.token?.id}` : null;
      if (key && seen.has(key)) continue;
      merged.push(a);
    }
    return merged;
  }, [propActivities, fetchedActivities]);

  // Only show filter types that exist in the data
  const availableTypes = useMemo(() => {
    const types = new Set((activities || []).map((a) => a.type));
    return ["all", ...Array.from(types)];
  }, [activities]);

  const filtered = useMemo(() => {
    let list = activities || [];
    if (filter !== "all") {
      list = list.filter((a) => a.type === filter);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (a) =>
          a.token?.name?.toLowerCase().includes(q) ||
          a.token?.id?.includes(q) ||
          a.from?.toLowerCase().includes(q) ||
          a.to?.toLowerCase().includes(q) ||
          a.marketplace?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [activities, filter, search]);

  // Stats are computed from fetchedActivities (the user's chosen time range)
  // rather than the merged list, so they accurately reflect the selected period
  const totalVolume = useMemo(() => {
    return (fetchedActivities || [])
      .filter((a) => a.type === "sale" && a.price)
      .reduce((sum, a) => sum + a.price, 0);
  }, [fetchedActivities]);

  const salesCount = useMemo(() => {
    return (fetchedActivities || []).filter((a) => a.type === "sale").length;
  }, [fetchedActivities]);

  return (
    <section className="activity-section">
      <div className="activity-header">
        <div>
          <div className="activity-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            ACTIVITY FEED
            {isWebSocketConnected && (
              <span role="status" aria-label="Live WebSocket connection active" style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 9,
                fontFamily: "var(--mono)",
                fontWeight: 700,
                color: "var(--green)",
                background: "rgba(74, 222, 128, 0.08)",
                border: "1px solid rgba(74, 222, 128, 0.2)",
                borderRadius: 4,
                padding: "2px 6px",
                letterSpacing: "0.05em",
              }}>
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--green)",
                  display: "inline-block",
                  animation: "pulse 2s ease-in-out infinite",
                }} />
                LIVE
              </span>
            )}
          </div>
          <div className="activity-subtitle">
            {isWebSocketConnected
              ? "Real-time transfers via WebSocket"
              : "Recent trades and transfers"}
          </div>
        </div>
        <div className="activity-stats-mini">
          <div className="activity-stat-mini">
            <span style={{ color: "var(--green)", fontFamily: "var(--mono)", fontSize: 16, fontWeight: 700 }}>
              {salesCount}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>SALES</span>
          </div>
          <div className="activity-stat-mini">
            <span style={{ color: "var(--gold)", fontFamily: "var(--mono)", fontSize: 16, fontWeight: 700 }}>
              <Eth size={12} /> {formatPrice(totalVolume)}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>VOLUME</span>
          </div>
        </div>
      </div>

      {/* Fallback data banner */}
      {isLive === false && activities?.length > 0 && (
        <div style={{
          padding: "10px 16px", borderRadius: 8, marginBottom: 16,
          background: "rgba(251, 191, 36, 0.04)", border: "1px solid rgba(251, 191, 36, 0.1)",
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--yellow)",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          {"\u26A0"} Showing cached example data — live API unavailable
        </div>
      )}

      {/* Date range filter + type filters */}
      <div className="activity-filters">
        <div style={{
          display: "inline-flex",
          gap: 0,
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid var(--border)",
          marginRight: 12,
          flexShrink: 0,
        }}>
          {DATE_RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDaysBack(opt.value)}
              style={{
                padding: "5px 10px",
                fontFamily: "var(--pixel)",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.04em",
                border: "none",
                cursor: "pointer",
                background: daysBack === opt.value ? "rgba(200,168,80,0.15)" : "transparent",
                color: daysBack === opt.value ? "var(--gold)" : "var(--text-dim)",
                borderRight: "1px solid var(--border)",
                transition: "background 0.15s, color 0.15s",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {availableTypes.map((f) => (
          <button
            key={f}
            className={`activity-filter-btn ${filter === f ? "active" : ""}`}
            onClick={() => setFilter(f)}
            style={filter === f && f !== "all" ? { borderColor: EVENT_COLORS[f], color: EVENT_COLORS[f] } : undefined}
          >
            {f === "all" ? "All" : EVENT_LABELS[f] || f}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <input
          className="activity-search"
          placeholder="Search activity..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Activity List */}
      <div className="activity-list">
        {loadingFresh && filtered.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="skeleton" style={{ height: 52, borderRadius: 10, animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        )}
        {!loadingFresh && filtered.length === 0 && (
          <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
            <div className="empty-state-icon">{"\uD83D\uDCCA"}</div>
            <div className="empty-state-title">
              {activities.length > 0
                ? "No activity matches your filters"
                : apiEmpty
                  ? `No indexed sales for ${collection.name}`
                  : apiFallback
                    ? `Activity data unavailable for ${collection.name}`
                    : `No recent activity for ${collection.name}`}
            </div>
            <div className="empty-state-text">
              {activities.length > 0
                ? "Try adjusting your filter or date range."
                : apiEmpty
                  ? "The sales indexer does not have trade history for this contract. Sales may still be happening on OpenSea, Blur, or other marketplaces."
                  : apiFallback
                    ? "The activity API returned an error. Try refreshing the page or check back later."
                    : "Sales and transfers will appear here once available."}
            </div>
            {activities.length === 0 && apiEmpty && collection.openseaSlug && (
              <a
                href={`https://opensea.io/collection/${collection.openseaSlug}/activity`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  marginTop: 12,
                  fontFamily: "var(--pixel)",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--naka-blue)",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                View activity on OpenSea {"\u2197"}
              </a>
            )}
          </div>
        )}
        {filtered.map((a, i) => (
          <div key={a.hash ? `${a.hash}-${i}` : i} className="activity-row" style={{ animationDelay: `${Math.min(i * 30, 300)}ms` }}>
            <div
              className="activity-type-badge"
              style={{ background: `${EVENT_COLORS[a.type] || "#666"}15`, color: EVENT_COLORS[a.type] || "#666", borderColor: `${EVENT_COLORS[a.type] || "#666"}30` }}
            >
              {EVENT_LABELS[a.type] || a.type}
            </div>
            <div className="activity-token-name">
              {a.token?.name || "Unknown"}
            </div>
            <div className="activity-parties">
              {(a.fromFull || a.from) && (
                <span className="activity-addr">
                  {a.fromFull ? <EnsName address={a.fromFull} /> : a.from}
                </span>
              )}
              {a.from && a.to && (
                <span style={{ color: "var(--text-muted)", margin: "0 4px" }}>{"\u2192"}</span>
              )}
              {(a.toFull || a.to) && (
                <span className="activity-addr">
                  {a.toFull ? <EnsName address={a.toFull} /> : a.to}
                </span>
              )}
            </div>
            <div className="activity-price">
              {a.price != null ? (
                <><Eth size={11} /> {formatPrice(a.price)}</>
              ) : (
                <span style={{ color: "var(--text-muted)" }}>{"\u2014"}</span>
              )}
            </div>
            <div className="activity-marketplace">
              {a.marketplace || ""}
            </div>
            <div className="activity-time">
              {formatTimeAgo(a.time)}
            </div>
            {a.hash && /^0x[a-fA-F0-9]{64}$/.test(a.hash) && (
              <a
                href={`https://etherscan.io/tx/${a.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="activity-tx-link"
                title="View on Etherscan"
              >
                {"\u2197"}
              </a>
            )}
          </div>
        ))}
      </div>

      {/* Load More button */}
      {nextPageKey && (
        <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
          <button
            onClick={() => loadActivities(daysBack, nextPageKey)}
            disabled={loadingMore}
            style={{
              fontFamily: "var(--pixel)",
              fontSize: 11,
              fontWeight: 600,
              padding: "8px 24px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--surface-glass)",
              color: loadingMore ? "var(--text-muted)" : "var(--gold)",
              cursor: loadingMore ? "default" : "pointer",
              letterSpacing: "0.06em",
              transition: "background 0.15s, color 0.15s",
            }}
          >
            {loadingMore ? "Loading more activity..." : "Load More"}
          </button>
        </div>
      )}
    </section>
  );
})
