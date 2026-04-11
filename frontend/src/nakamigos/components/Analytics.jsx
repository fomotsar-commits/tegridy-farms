import { useState, useMemo, lazy, Suspense } from "react";
import { Eth } from "./Icons";
import { exportCSV } from "../lib/csv";
import { useActiveCollection } from "../contexts/CollectionContext";
import { hasPrecomputedRarity } from "../api";
import ErrorBoundary from "./ErrorBoundary";

const HolderAnalytics = lazy(() => import("./HolderAnalytics"));
const CollectionHealth = lazy(() => import("./CollectionHealth"));
const RarityPriceScatter = lazy(() => import("./RarityPriceScatter"));

function BarChart({ data, maxValue, color = "var(--gold)" }) {
  return (
    <div className="bar-chart">
      {data.map((item) => (
        <div key={item.label} className="bar-row">
          <div className="bar-label">{item.label}</div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: `${Math.max((item.value / maxValue) * 100, 2)}%`,
                background: color,
              }}
            />
          </div>
          <div className="bar-value">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ segments, size = 160 }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  const radius = 60;
  const circumference = 2 * Math.PI * radius;

  const segmentData = useMemo(() => {
    if (total === 0) return [];
    let cumulative = 0;
    return segments.map((seg) => {
      const percent = seg.value / total;
      const offset = cumulative * circumference;
      const dashLength = percent * circumference;
      cumulative += percent;
      return { ...seg, offset, dashLength };
    });
  }, [segments, total, circumference]);

  return (
    <svg width={size} height={size} viewBox="0 0 160 160" style={{ transform: "rotate(-90deg)" }}>
      {segmentData.map((seg, i) => {
        return (
          <circle
            key={i}
            cx="80"
            cy="80"
            r={radius}
            fill="none"
            stroke={seg.color}
            strokeWidth="20"
            strokeDasharray={`${seg.dashLength} ${circumference - seg.dashLength}`}
            strokeDashoffset={-seg.offset}
            style={{ opacity: 0.8 }}
          />
        );
      })}
      <text
        x="80"
        y="80"
        textAnchor="middle"
        dominantBaseline="central"
        fill="var(--text)"
        fontSize="20"
        fontWeight="700"
        fontFamily="var(--display)"
        style={{ transform: "rotate(90deg)", transformOrigin: "80px 80px" }}
      >
        {total.toLocaleString()}
      </text>
    </svg>
  );
}

const TRAIT_COLORS = [
  "#c8a850", "#4ade80", "#818cf8", "#fbbf24", "#f472b6",
  "#22d3ee", "#fb923c", "#a78bfa", "#34d399", "#f87171",
  "#e879f9", "#94a3b8", "#2dd4bf", "#facc15", "#f97316",
  "#a3e635",
];

export default function Analytics({ tokens, stats, activities, listings, onPick }) {
  const collection = useActiveCollection();
  const [selectedTrait, setSelectedTrait] = useState(null);

  // Resolve supply: prefer live stats, fall back to collection config
  const resolvedSupply = stats.supply ?? collection.supply ?? null;

  // Determine rarity source for display
  const rarityIsPrecomputed = hasPrecomputedRarity(collection.contract);

  // Detect partial load: trait counts come from loaded tokens only,
  // so percentages against resolvedSupply are only accurate at full load.
  const isPartialLoad = resolvedSupply != null && tokens.length > 0 && tokens.length < resolvedSupply;

  // Compute trait distributions
  const traitDistributions = useMemo(() => {
    const traitMap = {};
    for (const token of tokens) {
      for (const attr of token.attributes || []) {
        if (!traitMap[attr.key]) traitMap[attr.key] = {};
        traitMap[attr.key][attr.value] = (traitMap[attr.key][attr.value] || 0) + 1;
      }
    }
    return Object.entries(traitMap)
      .map(([key, values]) => ({
        key,
        values: Object.entries(values)
          .map(([value, count]) => ({ label: value, value: count }))
          .sort((a, b) => b.value - a.value),
        total: Object.values(values).reduce((s, c) => s + c, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [tokens]);

  // Activity stats
  const activityStats = useMemo(() => {
    if (!activities.length) return null;
    const prices = activities.filter(a => a.price > 0).map(a => a.price);
    if (!prices.length) return null;
    return {
      avgPrice: (prices.reduce((s, p) => s + p, 0) / prices.length).toFixed(4),
      highestSale: Math.max(...prices).toFixed(4),
      lowestSale: Math.min(...prices).toFixed(4),
      totalSales: prices.length,
    };
  }, [activities]);

  // Price distribution buckets — dynamically computed from actual price range
  const priceDistribution = useMemo(() => {
    const prices = activities.filter(a => a.price > 0).map(a => a.price);
    if (!prices.length) return [];

    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const range = maxPrice - minPrice;

    // If all prices are the same (or nearly), return a single bucket
    if (range < 0.001) {
      return [{ label: `~${minPrice.toFixed(3)} ETH`, value: prices.length }];
    }

    // Create 5 evenly spaced buckets across the actual price range
    const step = range / 5;
    const buckets = [];
    for (let i = 0; i < 5; i++) {
      const lo = minPrice + step * i;
      const hi = i === 4 ? Infinity : minPrice + step * (i + 1);
      const label = i === 4
        ? `${lo.toFixed(3)}+ ETH`
        : `${lo.toFixed(3)} - ${(lo + step).toFixed(3)}`;
      buckets.push({ label, min: lo, max: hi });
    }

    return buckets.map(b => ({
      label: b.label,
      value: prices.filter(p => p >= b.min && p < b.max).length,
    }));
  }, [activities]);

  const activeTrait = selectedTrait
    ? traitDistributions.find(t => t.key === selectedTrait)
    : traitDistributions[0];

  // Memoize rarest traits computation (flatMap + sort is expensive for large collections)
  const rarestTraits = useMemo(() => {
    if (!traitDistributions.length) return [];
    return traitDistributions
      .flatMap(t => t.values.map(v => ({ type: t.key, value: v.label, count: v.value, total: t.total })))
      .sort((a, b) => a.count - b.count)
      .slice(0, 16);
  }, [traitDistributions]);

  const handleExportAnalytics = () => {
    const rows = [];
    // Overview stats
    rows.push({
      Section: "Overview",
      Metric: "Collection",
      Value: collection.name,
    });
    rows.push({
      Section: "Overview",
      Metric: "Floor Price",
      Value: stats.floor != null ? `${stats.floor.toFixed(4)} ETH` : "N/A",
    });
    rows.push({ Section: "Overview", Metric: "Owners", Value: stats.owners?.toLocaleString() || "N/A" });
    rows.push({ Section: "Overview", Metric: "Supply", Value: resolvedSupply != null ? String(resolvedSupply) : "N/A" });
    rows.push({ Section: "Overview", Metric: "Trait Types", Value: String(traitDistributions.length) });
    rows.push({ Section: "Overview", Metric: "Unique Trait Values", Value: String(traitDistributions.reduce((s, t) => s + t.values.length, 0)) });
    rows.push({ Section: "Overview", Metric: "Tokens Loaded", Value: String(tokens.length) });
    rows.push({ Section: "Overview", Metric: "Rarity Source", Value: rarityIsPrecomputed ? "Precomputed" : "Runtime" });
    if (isPartialLoad) {
      rows.push({ Section: "Overview", Metric: "Note", Value: `Trait percentages based on ${tokens.length} of ${resolvedSupply} tokens loaded` });
    }

    // Trait distributions — all types, all values
    for (const td of traitDistributions) {
      for (const v of td.values) {
        const base = resolvedSupply || tokens.length;
        const pct = base ? ((v.value / base) * 100).toFixed(2) : "N/A";
        rows.push({ Section: "Trait Distribution", Metric: `${td.key}: ${v.label}`, Value: String(v.value), Percent: `${pct}%` });
      }
    }

    // Activity / sales stats
    if (activityStats) {
      rows.push({ Section: "Sales", Metric: "Average Price", Value: `${activityStats.avgPrice} ETH` });
      rows.push({ Section: "Sales", Metric: "Highest", Value: `${activityStats.highestSale} ETH` });
      rows.push({ Section: "Sales", Metric: "Lowest", Value: `${activityStats.lowestSale} ETH` });
      rows.push({ Section: "Sales", Metric: "Total Sales", Value: String(activityStats.totalSales) });
    }

    // Price distribution buckets
    for (const bucket of priceDistribution) {
      rows.push({ Section: "Price Distribution", Metric: bucket.label, Value: String(bucket.value) });
    }

    // Rarest traits (top 20)
    const rarest = traitDistributions
      .flatMap(t => t.values.map(v => ({ type: t.key, value: v.label, count: v.value })))
      .sort((a, b) => a.count - b.count)
      .slice(0, 20);
    for (const trait of rarest) {
      const base = resolvedSupply || tokens.length;
      const pct = base ? ((trait.count / base) * 100).toFixed(2) : "N/A";
      rows.push({ Section: "Rarest Traits", Metric: `${trait.type}: ${trait.value}`, Value: String(trait.count), Percent: `${pct}%` });
    }

    exportCSV(rows, `${collection.slug || "collection"}-analytics`);
  };

  return (
    <section className="analytics-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 32, fontWeight: 600, color: "var(--text)" }}>
          Analytics
        </h2>
        {(tokens.length > 0 || activities.length > 0 || stats.floor != null) && (
          <button
            onClick={handleExportAnalytics}
            style={{
              fontFamily: "var(--mono)", fontSize: 10, padding: "8px 16px",
              borderRadius: 8, border: "1px solid var(--border)",
              background: "var(--surface-glass)", color: "var(--text-dim)",
              cursor: "pointer", letterSpacing: "0.04em",
            }}
          >
            Export CSV
          </button>
        )}
      </div>
      <div style={{ width: 60, height: 2, background: "linear-gradient(90deg, var(--gold), transparent)", marginBottom: 32 }} />

      {tokens.length === 0 && !activities.length && stats.floor == null && (
        <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)", marginBottom: 32 }}>
          <div className="empty-state-icon">{"\uD83D\uDCCA"}</div>
          <div className="empty-state-title">No analytics data available for {collection.name} yet</div>
          <div className="empty-state-text">Analytics will populate once token and sales data is loaded.</div>
        </div>
      )}

      {/* Overview Stats */}
      <div className="analytics-overview">
        {[
          { label: "FLOOR PRICE", value: stats.floor != null ? `${stats.floor.toFixed(4)} ETH` : "\u2014", color: "var(--gold)" },
          { label: "OWNERS", value: stats.owners != null ? stats.owners.toLocaleString() : "\u2014", color: "var(--green)" },
          { label: "SUPPLY", value: resolvedSupply != null ? resolvedSupply.toLocaleString() : "\u2014", color: "var(--text)" },
          { label: "UNIQUE TRAITS", value: traitDistributions.reduce((s, t) => s + t.values.length, 0), color: "var(--purple)" },
          { label: "TRAIT TYPES", value: traitDistributions.length, color: "var(--yellow)" },
          { label: "LOADED", value: tokens.length, color: "var(--naka-sky)" },
        ].map(({ label, value, color }) => (
          <div key={label} className="analytics-stat-card">
            <div className="analytics-stat-label">{label}</div>
            <div className="analytics-stat-value" style={{ color }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      <div className="analytics-grid">
        {/* Trait Distribution */}
        <div className="analytics-panel">
          <div className="analytics-panel-header">
            <h3>Trait Distribution</h3>
            {isPartialLoad && traitDistributions.length > 0 && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
                {tokens.length.toLocaleString()} of {resolvedSupply.toLocaleString()} loaded
              </span>
            )}
            {traitDistributions.length > 0 && (
              <select
                className="trait-select"
                value={activeTrait?.key || ""}
                onChange={(e) => setSelectedTrait(e.target.value)}
              >
                {traitDistributions.map(t => (
                  <option key={t.key} value={t.key}>{t.key} ({t.values.length})</option>
                ))}
              </select>
            )}
          </div>
          {activeTrait ? (
            <>
              <BarChart
                data={activeTrait.values.slice(0, 12)}
                maxValue={Math.max(...activeTrait.values.map(v => v.value))}
              />
              {activeTrait.values.length > 12 && (
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", marginTop: 8 }}>
                  + {activeTrait.values.length - 12} more values
                </div>
              )}
            </>
          ) : (
            <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
              No trait data loaded yet
            </div>
          )}
        </div>

        {/* Trait Type Overview */}
        <div className="analytics-panel">
          <div className="analytics-panel-header">
            <h3>Trait Types</h3>
          </div>
          {traitDistributions.length > 0 ? (
            <>
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
                <DonutChart
                  segments={traitDistributions.map((t, i) => ({
                    value: t.values.length,
                    color: TRAIT_COLORS[i % TRAIT_COLORS.length],
                  }))}
                />
              </div>
              <div className="donut-legend">
                {traitDistributions.map((t, i) => (
                  <div key={t.key} className="donut-legend-item">
                    <span className="donut-legend-dot" style={{ background: TRAIT_COLORS[i % TRAIT_COLORS.length] }} />
                    <span className="donut-legend-label">{t.key}</span>
                    <span className="donut-legend-count">{t.values.length}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
              No trait types available
            </div>
          )}
        </div>

        {/* Sales Analysis */}
        {activityStats && (
          <div className="analytics-panel">
            <div className="analytics-panel-header">
              <h3>Recent Sales</h3>
            </div>
            <div className="analytics-sales-grid">
              <div className="analytics-sale-stat">
                <div className="analytics-stat-label">AVG SALE</div>
                <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700, color: "var(--gold)" }}>
                  <Eth />{activityStats.avgPrice}
                </div>
              </div>
              <div className="analytics-sale-stat">
                <div className="analytics-stat-label">HIGHEST</div>
                <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700, color: "var(--green)" }}>
                  <Eth />{activityStats.highestSale}
                </div>
              </div>
              <div className="analytics-sale-stat">
                <div className="analytics-stat-label">LOWEST</div>
                <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700, color: "var(--red)" }}>
                  <Eth />{activityStats.lowestSale}
                </div>
              </div>
              <div className="analytics-sale-stat">
                <div className="analytics-stat-label">SALES COUNT</div>
                <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 700, color: "var(--text)" }}>
                  {activityStats.totalSales}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Price Distribution */}
        {priceDistribution.length > 0 && (
          <div className="analytics-panel">
            <div className="analytics-panel-header">
              <h3>Price Distribution</h3>
            </div>
            <BarChart
              data={priceDistribution}
              maxValue={Math.max(...priceDistribution.map(b => b.value), 1)}
              color="var(--purple)"
            />
          </div>
        )}
      </div>

      {/* Rarity vs Price Scatter Plot */}
      {listings && listings.length > 0 && tokens.length > 0 && (
        <ErrorBoundary title="Scatter plot error">
        <Suspense fallback={
          <div className="analytics-panel" style={{ marginTop: 24 }}>
            <div className="analytics-panel-header"><h3>Rarity vs Price</h3></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px 0" }}>
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="skeleton" style={{ height: 24, borderRadius: 4, animationDelay: `${i * 50}ms` }} />
              ))}
            </div>
          </div>
        }>
          <RarityPriceScatter
            tokens={tokens}
            listings={listings}
            activities={activities}
            onPick={onPick}
          />
        </Suspense>
        </ErrorBoundary>
      )}

      {/* Collection Health Dashboard */}
      <ErrorBoundary title="Collection health error">
      <Suspense fallback={
        <div className="analytics-panel" style={{ marginTop: 24 }}>
          <div className="analytics-panel-header"><h3>Collection Health</h3></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px 0" }}>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton" style={{ height: 24, borderRadius: 4, animationDelay: `${i * 50}ms` }} />
            ))}
          </div>
        </div>
      }>
        <CollectionHealth stats={stats} activities={activities} />
      </Suspense>
      </ErrorBoundary>

      {/* Holder Distribution */}
      <ErrorBoundary title="Holder analytics error">
      <Suspense fallback={
        <div className="analytics-panel" style={{ marginTop: 24 }}>
          <div className="analytics-panel-header"><h3>Holder Distribution</h3></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px 0" }}>
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="skeleton" style={{ height: 18, borderRadius: 4, animationDelay: `${i * 50}ms` }} />
            ))}
          </div>
        </div>
      }>
        <HolderAnalytics supply={resolvedSupply} />
      </Suspense>
      </ErrorBoundary>

      {/* Rarest Traits */}
      {traitDistributions.length > 0 && (
        <div className="analytics-panel" style={{ marginTop: 24 }}>
          <div className="analytics-panel-header">
            <h3>Rarest Traits</h3>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
              {rarityIsPrecomputed ? "Precomputed rarity" : `Computed at runtime from ${tokens.length.toLocaleString()} loaded`}
            </span>
          </div>
          <div className="rarest-grid">
            {rarestTraits.map((trait, i) => {
                const base = isPartialLoad ? tokens.length : (resolvedSupply || tokens.length);
                const pct = base ? ((trait.count / base) * 100).toFixed(1) : 0;
                return (
                  <div key={`${trait.type}-${trait.value}`} className="rarest-item card-reveal" style={{ animationDelay: `${i * 40}ms` }}>
                    <div className="rarest-rank">#{i + 1}</div>
                    <div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-dim)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                        {trait.type}
                      </div>
                      <div style={{ fontFamily: "var(--display)", fontSize: 12, color: "var(--text)", fontWeight: 500 }}>
                        {trait.value}
                      </div>
                    </div>
                    <div style={{ marginLeft: "auto", textAlign: "right" }}>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--gold)", fontWeight: 600 }}>
                        {trait.count}
                      </div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>
                        {pct}%{isPartialLoad ? " *" : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
          {isPartialLoad && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-dim)", marginTop: 8, letterSpacing: "0.04em" }}>
              * Percentages based on {tokens.length.toLocaleString()} loaded tokens
            </div>
          )}
        </div>
      )}
    </section>
  );
}
