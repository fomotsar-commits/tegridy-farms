import { useState, useEffect, useMemo } from "react";
import { fetchTopHolders } from "../api";
import { useActiveCollection } from "../contexts/CollectionContext";

const DISTRIBUTION_BUCKETS = [
  { label: "1 NFT", min: 1, max: 1 },
  { label: "2-5", min: 2, max: 5 },
  { label: "6-10", min: 6, max: 10 },
  { label: "11-25", min: 11, max: 25 },
  { label: "26-50", min: 26, max: 50 },
  { label: "51-100", min: 51, max: 100 },
  { label: "100+", min: 101, max: Infinity },
];

function DistributionBar({ data, maxValue }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {data.map((item) => (
        <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 56, fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", textAlign: "right", flexShrink: 0 }}>
            {item.label}
          </div>
          <div style={{ flex: 1, height: 18, borderRadius: 4, background: "rgba(255,255,255,0.04)", overflow: "hidden", position: "relative" }}>
            <div style={{
              height: "100%",
              width: `${Math.max((item.value / maxValue) * 100, 1)}%`,
              borderRadius: 4,
              background: item.color || "#818cf8",
              transition: "width 0.5s ease",
            }} />
            <span style={{
              position: "absolute",
              right: 6,
              top: "50%",
              transform: "translateY(-50%)",
              fontFamily: "var(--mono)",
              fontSize: 9,
              color: "var(--text)",
              fontWeight: 600,
            }}>
              {item.value.toLocaleString()}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function HolderAnalytics({ supply: suppliedSupply } = {}) {
  const collection = useActiveCollection();
  const [holders, setHolders] = useState([]);
  const [totalOwners, setTotalOwners] = useState(0);
  const [totalHeldAll, setTotalHeldAll] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setHolders([]);
    setTotalOwners(0);
    setTotalHeldAll(0);
    fetchTopHolders({ contract: collection.contract, limit: 100 })
      .then((data) => {
        setHolders(data.holders || []);
        setTotalOwners(data.totalOwners || 0);
        setTotalHeldAll(data.totalHeld || 0);
      })
      .catch(() => {
        setHolders([]);
        setTotalOwners(0);
        setTotalHeldAll(0);
      })
      .finally(() => setLoading(false));
  }, [collection.contract]);

  const distribution = useMemo(() => {
    return DISTRIBUTION_BUCKETS.map((bucket, i) => ({
      label: bucket.label,
      value: holders.filter((h) => h.count >= bucket.min && h.count <= bucket.max).length,
      color: ["#4ade80", "#34d399", "#22d3ee", "#818cf8", "#a78bfa", "#f472b6", "#fbbf24"][i],
    }));
  }, [holders]);

  // Prefer explicit supply prop (stats.supply from API) > config > totalHeld from holders API
  const supply = suppliedSupply || collection.supply || totalHeldAll || 1;

  const stats = useMemo(() => {
    if (!holders.length) return null;
    const loadedTotal = holders.reduce((s, h) => s + h.count, 0);
    const top10Held = holders.slice(0, 10).reduce((s, h) => s + h.count, 0);
    return {
      loadedCount: holders.length,
      totalOwners,
      avgHeld: (loadedTotal / holders.length).toFixed(1),
      // Calculate top 10 ownership against actual total supply, not just loaded holders
      top10Pct: ((top10Held / supply) * 100).toFixed(1),
      whales: holders.filter((h) => h.count >= 50).length,
    };
  }, [holders, totalOwners, supply]);

  const maxDist = useMemo(() => Math.max(...distribution.map((d) => d.value), 1), [distribution]);

  return (
    <div className="analytics-panel" style={{ marginTop: 24 }}>
      <div className="analytics-panel-header">
        <h3>Top Holder Distribution</h3>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 18, borderRadius: 4, animationDelay: `${i * 50}ms` }} />
          ))}
        </div>
      ) : !holders.length ? (
        <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
          <div className="empty-state-icon">{"\uD83D\uDCCA"}</div>
          <div className="empty-state-title">No Holder Data</div>
          <div className="empty-state-text">
            Holder distribution for {collection.name} will populate once data is loaded.
          </div>
        </div>
      ) : (
        <>
          {stats && (
            <>
              <div className="holder-stats-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 12 }}>
                {[
                  { label: "TOTAL HOLDERS", value: stats.totalOwners ? stats.totalOwners.toLocaleString() : "\u2014", color: "var(--purple)" },
                  { label: "AVG HELD (TOP\u00A0100)", value: stats.avgHeld, color: "var(--green)" },
                  { label: "TOP 10 OWN", value: `${stats.top10Pct}%`, color: "var(--yellow)" },
                  { label: "WHALES (50+)", value: stats.whales, color: "var(--red)" },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ textAlign: "center" }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 4 }}>
                      {label}
                    </div>
                    <div style={{ fontFamily: "var(--display)", fontSize: 16, fontWeight: 700, color }}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{
                fontFamily: "var(--mono)",
                fontSize: 9,
                color: "var(--text-muted)",
                textAlign: "center",
                marginBottom: 16,
                opacity: 0.7,
              }}>
                Showing top {stats.loadedCount} holders of {stats.totalOwners ? stats.totalOwners.toLocaleString() : "?"} total
                {" \u00B7 "}Top 10 % is of total supply ({supply.toLocaleString()})
              </div>
            </>
          )}

          <DistributionBar data={distribution} maxValue={maxDist} />
        </>
      )}
    </div>
  );
}
