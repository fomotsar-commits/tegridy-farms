import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import NftImage from "./NftImage";
import { useActiveCollection } from "../contexts/CollectionContext";
import { COLLECTION_LORE } from "../constants";

function HeroShowcase({ tokens, onPick }) {
  const featured = useMemo(
    () => tokens.filter((n) => n.image && n.id != null).slice(0, 6),
    [tokens]
  );
  const [active, setActive] = useState(0);
  const pausedRef = useRef(false);

  useEffect(() => {
    setActive((prev) => (prev >= featured.length ? 0 : prev));
  }, [featured.length]);

  useEffect(() => {
    if (!featured.length) return;
    const iv = setInterval(() => {
      if (!pausedRef.current) setActive((p) => (p + 1) % featured.length);
    }, 4000);
    return () => clearInterval(iv);
  }, [featured.length]);

  const handlePause = useCallback(() => { pausedRef.current = true; }, []);
  const handleResume = useCallback(() => { pausedRef.current = false; }, []);

  if (!featured.length) return null;
  const cur = featured[active % featured.length];

  return (
    <div
      style={{ display: "flex", gap: 32, alignItems: "center", padding: "20px 0", flexWrap: "wrap" }}
      onMouseEnter={handlePause}
      onMouseLeave={handleResume}
      onFocus={handlePause}
      onBlur={handleResume}
    >
      <div onClick={() => onPick(cur)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(cur); } }} role="button" tabIndex={0} aria-label={`Featured: ${cur.name}`} className="hero-feature">
        <NftImage nft={cur} large priority style={{ width: "100%", height: "100%", objectFit: "cover", transition: "opacity 0.6s, transform 0.6s" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(transparent 40%, rgba(9,9,11,0.85))" }} />
        {cur.rank && !cur.rankApproximate && (
          <div className="hero-rank-pill">
            <span style={{ fontFamily: "var(--pixel)", fontSize: 7 }}>RANK</span> #{cur.rank}
          </div>
        )}
        <div style={{ position: "absolute", bottom: 16, left: 16, right: 16 }}>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 10, fontWeight: 400, color: "var(--text)", letterSpacing: "0.02em" }}>{cur.name}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--gold)", marginTop: 6 }}>
            {cur.attributes?.length > 0 && (
              <span style={{ color: "var(--text-dim)" }}>{cur.attributes.map(a => a.value).join(" \u00b7 ")}</span>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {featured.map((n, idx) => (
          <div
            key={n.id}
            onClick={() => setActive(idx)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActive(idx); } }}
            role="button"
            tabIndex={0}
            aria-label={`Select ${n.name}`}
            className={`hero-side-item ${idx === active ? "active" : ""}`}
          >
            <NftImage nft={n} style={{ width: 44, height: 44, borderRadius: 4, objectFit: "cover" }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: "var(--display)", fontSize: 12, fontWeight: 600, color: idx === active ? "var(--text)" : "var(--text-dim)" }}>{n.name}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: idx === active ? "var(--gold)" : "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {n.attributes?.[0] && `${n.attributes[0].key}: ${n.attributes[0].value}`}
              </div>
            </div>
            {n.rank && !n.rankApproximate && (
              <span className="hero-side-rank">#{n.rank}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatVolume(n) {
  if (n == null) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

function StatSkeleton({ label }) {
  return (
    <div className="stat-card">
      <div className="stat-skeleton-bar" style={{ width: 64, height: 16, marginBottom: 6 }} />
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function Hero({ stats, tokens, onPick }) {
  const collection = useActiveCollection();
  // Use config supply as the ultimate fallback for display
  const supply = stats.supply ?? collection.supply ?? null;
  const isLoading = stats.floor == null && stats.owners == null && stats.volume == null;

  return (
    <section className="hero">
      {/* Pixel art decorative corners */}
      <div className="hero-pixel-deco top-right" />
      <div className="hero-pixel-deco bottom-left" />

      <div className="hero-wrap">
        <div className="hero-info">
          <div className="hero-badge-row">
            {(collection.tags || ["ERC-721", "ETHEREUM"]).map(tag => (
              <span key={tag} className="pixel-badge blue">{tag}</span>
            ))}
          </div>
          <h1 className="hero-title">
            <span className="hero-title-accent">{supply?.toLocaleString() || ""}</span>{" "}
            {collection.name}
          </h1>
          {collection.description && (
            <p className="hero-desc">{collection.description}</p>
          )}
          {COLLECTION_LORE[collection.slug]?.tagline && (
            <div style={{
              fontFamily: "var(--display)", fontSize: 12, color: "var(--gold)",
              fontStyle: "italic", marginTop: -4, marginBottom: 8, opacity: 0.8,
            }}>
              {COLLECTION_LORE[collection.slug].tagline}
            </div>
          )}

          {/* Premium stat cards */}
          <div className="stats-row">
            {/* Supply -- always visible from config */}
            <div className="stat-card">
              <div className="stat-value" style={{ color: "var(--text)" }}>
                {supply?.toLocaleString() || "\u2014"}
              </div>
              <div className="stat-label">SUPPLY</div>
            </div>

            {/* Floor price */}
            {stats.floor != null ? (
              <div className="stat-card">
                <div className="stat-value" style={{ color: "var(--gold)" }}>
                  {Number(stats.floor).toFixed(4)}
                  <span className="stat-suffix"> ETH</span>
                </div>
                <div className="stat-label">FLOOR</div>
              </div>
            ) : isLoading ? (
              <StatSkeleton label="FLOOR" />
            ) : null}

            {/* Volume */}
            {stats.volume != null && (
              <div className="stat-card">
                <div className="stat-value" style={{ color: "var(--naka-blue)" }}>
                  {formatVolume(stats.volume)}
                  <span className="stat-suffix"> ETH</span>
                </div>
                <div className="stat-label">ALL-TIME VOL</div>
              </div>
            )}

            {/* Owners */}
            {stats.owners != null ? (
              <div className="stat-card">
                <div className="stat-value" style={{ color: "var(--green)" }}>
                  {stats.owners.toLocaleString()}
                </div>
                <div className="stat-label">OWNERS</div>
              </div>
            ) : isLoading ? (
              <StatSkeleton label="OWNERS" />
            ) : null}

            {/* Total sales (if available) */}
            {stats.totalSales != null && (
              <div className="stat-card">
                <div className="stat-value" style={{ color: "var(--purple)" }}>
                  {formatVolume(stats.totalSales)}
                </div>
                <div className="stat-label">TOTAL SALES</div>
              </div>
            )}
          </div>

          {/* Collection highlights */}
          <div style={{ display: "flex", gap: 16, marginTop: 20, flexWrap: "wrap" }}>
            <div className="hero-highlight-tag">
              <span style={{ color: "var(--green)", fontSize: 10 }}>{"\u25CF"}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>Live on Ethereum</span>
            </div>
            {(collection.highlights || []).map((h, i) => (
              <div key={i} className="hero-highlight-tag">
                <span style={{ color: h.color || "var(--gold)", fontSize: 10 }}>{"\u25CF"}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>{h.label}</span>
              </div>
            ))}
          </div>
        </div>
        <HeroShowcase tokens={tokens} onPick={onPick} />
      </div>
      <div className="hero-divider" />
    </section>
  );
}
