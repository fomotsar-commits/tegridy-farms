import { useState, useEffect, useMemo } from "react";
import { Eth } from "./Icons";
import { fetchActivity } from "../api";
import { useActiveCollection } from "../contexts/CollectionContext";

// Shows recent sales of tokens with similar traits to the selected NFT
export default function ComparableSales({ nft, allTokens }) {
  const collection = useActiveCollection();
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);

  // Find tokens with similar traits
  const similarTokenIds = useMemo(() => {
    if (!nft?.attributes?.length || !allTokens?.length) return [];
    const nftTraits = new Set(nft.attributes.map((a) => `${a.key}::${a.value}`));
    return allTokens
      .filter((t) => t.id !== nft.id)
      .map((t) => {
        const overlap = (t.attributes || []).filter((a) => nftTraits.has(`${a.key}::${a.value}`)).length;
        return { id: t.id, name: t.name, rank: t.rank, overlap };
      })
      .filter((t) => t.overlap >= 2)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 20);
  }, [nft, allTokens]);

  useEffect(() => {
    if (!similarTokenIds.length) { setLoading(false); return; }
    setLoading(true);
    fetchActivity({ contract: collection.contract, limit: 50, daysBack: 90 })
      .then((data) => {
        const idSet = new Set(similarTokenIds.map((t) => t.id));
        const matching = (data.activities || []).filter(
          (a) => a.type === "sale" && a.price && idSet.has(a.token?.id)
        );
        setSales(matching.slice(0, 8));
      })
      .catch(() => setSales([]))
      .finally(() => setLoading(false));
  }, [similarTokenIds, collection.contract]);

  if (loading && similarTokenIds.length > 0) {
    return (
      <div style={{ marginTop: 16 }}>
        <div style={{
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
          letterSpacing: "0.08em", marginBottom: 8,
        }}>
          COMPARABLE SALES
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 32, borderRadius: 8, animationDelay: `${i * 60}ms` }} />
          ))}
        </div>
      </div>
    );
  }
  if (loading || sales.length === 0) return null;

  const validSales = sales.filter((a) => typeof a.price === "number" && Number.isFinite(a.price));
  const avgPrice = validSales.length > 0 ? validSales.reduce((s, a) => s + a.price, 0) / validSales.length : 0;

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{
        fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
        letterSpacing: "0.08em", marginBottom: 8,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span>COMPARABLE SALES ({sales.length})</span>
        <span style={{ color: "var(--gold)" }}>
          Avg: <Eth size={9} />{avgPrice.toFixed(4)}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {sales.map((sale, i) => (
          <div
            key={sale.hash ? `${sale.hash}-${i}` : `${sale.token?.id}-${i}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              borderRadius: 8,
              background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.03)",
            }}
          >
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)", flex: 1 }}>
              {sale.token?.name || `#${sale.token?.id}`}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--green)", fontWeight: 600 }}>
              <Eth size={10} /> {sale.price?.toFixed(4) ?? "\u2014"}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>
              {formatTimeAgo(sale.time)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTimeAgo(ts) {
  if (!ts) return "\u2014";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (!Number.isFinite(diff)) return "\u2014";
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
