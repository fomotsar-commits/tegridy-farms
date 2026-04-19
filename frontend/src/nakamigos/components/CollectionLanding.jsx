import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { COLLECTIONS, COLLECTION_LORE } from "../constants";
import { fetchCollectionStats, fetchTokens } from "../api";

const COLLECTION_LIST = Object.values(COLLECTIONS);

/* ─── Shimmer placeholder for loading stats ─── */
function StatShimmer({ width = "60%" }) {
  return (
    <div style={{
      height: 14,
      width,
      borderRadius: 6,
      background: "linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)",
      backgroundSize: "200% 100%",
      animation: "shimmer 1.8s ease-in-out infinite",
    }} />
  );
}

/* ─── Single stat cell ─── */
function Stat({ label, value, loading, shimmerWidth }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontFamily: "var(--mono)",
        fontSize: 9,
        color: "var(--text-muted)",
        letterSpacing: "0.08em",
        marginBottom: 5,
        textTransform: "uppercase",
      }}>
        {label}
      </div>
      {loading ? <StatShimmer width={shimmerWidth} /> : (
        <div style={{
          fontFamily: "var(--mono)",
          fontSize: 13,
          color: "var(--text)",
          fontWeight: 600,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>
          {value}
        </div>
      )}
    </div>
  );
}

/* ─── Highlight badges (Commercial Rights, Generative Art, etc.) ─── */
function HighlightBadge({ label, color }) {
  return (
    <span style={{
      fontFamily: "var(--pixel)",
      fontSize: 7,
      color: color,
      background: `color-mix(in srgb, ${color} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
      borderRadius: 6,
      padding: "3px 8px",
      letterSpacing: "0.04em",
      lineHeight: 1,
      whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

/* ─── Cross-Collection Search ─── */
function CrossCollectionSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const wrapperRef = useRef(null);

  const results = useMemo(() => {
    if (!query || query.length < 2) return [];
    const q = query.toLowerCase();
    const out = [];

    for (const [slug, col] of Object.entries(COLLECTIONS)) {
      if (col.name.toLowerCase().includes(q) || col.slug.includes(q)) {
        out.push({ type: "collection", slug, name: col.name, image: col.image });
      }
      // Tag / keyword match
      if (col.tags?.some((t) => t.toLowerCase().includes(q))) {
        if (!out.find((r) => r.type === "collection" && r.slug === slug)) {
          out.push({ type: "collection", slug, name: col.name, image: col.image });
        }
      }
    }

    // Token ID search
    if (/^\d+$/.test(query)) {
      const id = parseInt(query, 10);
      for (const [slug, col] of Object.entries(COLLECTIONS)) {
        if (id > 0 && id <= col.supply) {
          out.push({ type: "token", slug, name: `${col.name} #${id}`, id, image: col.image });
        }
      }
    }

    return out;
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = (r) => {
    setQuery("");
    setFocused(false);
    navigate(`/nakamigos/${r.slug}/${r.type === "token" ? `nft/${r.id}` : "gallery"}`);
  };

  const showDropdown = focused && query.length >= 2 && results.length > 0;

  return (
    <div ref={wrapperRef} style={{ position: "relative", maxWidth: 480, margin: "0 auto 40px", zIndex: 20 }}>
      {/* Search input */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "var(--surface-glass)",
        border: `1px solid ${focused ? "rgba(111,168,220,0.35)" : "var(--border)"}`,
        borderRadius: 14,
        padding: "0 16px",
        backdropFilter: "var(--glass-blur)",
        transition: "border-color 0.3s ease, box-shadow 0.3s ease",
        boxShadow: focused ? "0 0 24px rgba(111,168,220,0.08)" : "none",
      }}>
        {/* Search icon */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.5 }}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          placeholder="Search collections or token ID..."
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--text)",
            fontFamily: "var(--mono)",
            fontSize: 11,
            padding: "12px 0",
            letterSpacing: "0.02em",
          }}
        />
        {query && (
          <button
            onClick={() => { setQuery(""); }}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-dim)",
              cursor: "pointer",
              padding: 4,
              fontSize: 14,
              lineHeight: 1,
              fontFamily: "var(--mono)",
            }}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* Dropdown results */}
      {showDropdown && (
        <div style={{
          position: "absolute",
          top: "calc(100% + 6px)",
          left: 0,
          right: 0,
          background: "rgba(16, 16, 20, 0.95)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(111,168,220,0.2)",
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 16px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(111,168,220,0.06)",
          maxHeight: 320,
          overflowY: "auto",
        }}>
          {results.map((r, i) => (
            <button
              key={`${r.slug}-${r.type}-${r.id ?? i}`}
              onClick={() => handleSelect(r)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "10px 16px",
                background: "transparent",
                border: "none",
                borderBottom: i < results.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                cursor: "pointer",
                color: "var(--text)",
                fontFamily: "var(--display)",
                fontSize: 11,
                textAlign: "left",
                transition: "background 0.15s ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(111,168,220,0.08)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <img
                src={r.image}
                alt=""
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  objectFit: "cover",
                  background: "rgba(255,255,255,0.03)",
                }}
                onError={(e) => { e.target.style.display = "none"; }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: "var(--display)",
                  fontSize: 11,
                  color: "var(--text)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}>
                  {r.name}
                </div>
                <div style={{
                  fontFamily: "var(--mono)",
                  fontSize: 8,
                  color: "var(--text-dim)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginTop: 2,
                }}>
                  {r.type === "token" ? "Token" : "Collection"}
                </div>
              </div>
              {/* Arrow icon */}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.4 }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          ))}
        </div>
      )}

      {/* No results message */}
      {focused && query.length >= 2 && results.length === 0 && (
        <div style={{
          position: "absolute",
          top: "calc(100% + 6px)",
          left: 0,
          right: 0,
          background: "rgba(16, 16, 20, 0.95)",
          backdropFilter: "blur(20px)",
          border: "1px solid rgba(111,168,220,0.2)",
          borderRadius: 14,
          padding: "16px 20px",
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}>
          <div style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--text-dim)",
            textAlign: "center",
            letterSpacing: "0.02em",
          }}>
            No results for "{query}"
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Collection Card ─── */
function CollectionCard({ collection, stats, statsLoading, statsError, previewImage, onClick, index }) {
  const displayImage = collection.image || previewImage;
  const [imgError, setImgError] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [visible, setVisible] = useState(false);
  const cardRef = useRef(null);

  useEffect(() => { setImgError(false); }, [displayImage]);

  // Staggered entrance animation via IntersectionObserver
  // Respects prefers-reduced-motion: skip stagger delay + show immediately
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) {
      setVisible(true);
      return;
    }
    let obs;
    const timer = setTimeout(() => {
      obs = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      }, { threshold: 0.08 });
      obs.observe(el);
    }, index * 150); // stagger
    return () => {
      clearTimeout(timer);
      if (obs) obs.disconnect();
    };
  }, [index]);

  const formatStat = (val, suffix = "") => {
    if (val == null) return "\u2014";
    if (typeof val === "number" && suffix === " ETH" && val < 1) return val.toFixed(4) + suffix;
    if (typeof val === "number" && suffix === " ETH") return val.toLocaleString(undefined, { maximumFractionDigits: 0 }) + suffix;
    if (typeof val === "number") return val.toLocaleString();
    return val;
  };

  const isLoading = statsLoading;
  const isError = statsError && !stats;
  const dash = "\u2014";

  return (
    <button
      ref={cardRef}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        background: hovered ? "rgba(20, 20, 24, 0.85)" : "var(--surface-glass)",
        border: `1px solid ${hovered ? "rgba(111,168,220,0.35)" : "var(--border)"}`,
        borderRadius: 20,
        overflow: "hidden",
        cursor: "pointer",
        transition: "all 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
        backdropFilter: "var(--glass-blur)",
        textAlign: "left",
        padding: 0,
        color: "inherit",
        fontFamily: "inherit",
        transform: visible
          ? (hovered ? "translateY(-8px) scale(1.015)" : "translateY(0)")
          : "translateY(32px)",
        opacity: visible ? 1 : 0,
        boxShadow: hovered
          ? "0 20px 60px rgba(111,168,220,0.14), 0 8px 24px rgba(0,0,0,0.3), 0 0 0 1px rgba(111,168,220,0.08), inset 0 1px 0 rgba(255,255,255,0.04)"
          : "0 2px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.02)",
        position: "relative",
        width: "100%",
      }}
    >
      {/* ── Hover glow line at top ── */}
      <div style={{
        position: "absolute",
        top: 0,
        left: "10%",
        right: "10%",
        height: 1,
        background: "linear-gradient(90deg, transparent, rgba(111,168,220,0.5), transparent)",
        opacity: hovered ? 1 : 0,
        transition: "opacity 0.4s ease",
        zIndex: 10,
      }} />

      {/* ── Image area ── */}
      <div style={{
        height: 240,
        background: "linear-gradient(145deg, var(--bg), var(--surface), var(--card))",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        position: "relative",
      }}>
        {/* Subtle corner glow on hover */}
        <div style={{
          position: "absolute",
          inset: 0,
          background: hovered
            ? "radial-gradient(ellipse at 30% 20%, rgba(111,168,220,0.08) 0%, transparent 60%)"
            : "none",
          transition: "background 0.5s ease",
          pointerEvents: "none",
          zIndex: 1,
        }} />

        {/* Bottom gradient fade for text readability */}
        <div style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 60,
          background: "linear-gradient(to top, rgba(16,16,18,0.9), transparent)",
          pointerEvents: "none",
          zIndex: 2,
        }} />

        {displayImage && !imgError ? (
          <img
            src={displayImage}
            alt={collection.name}
            loading="lazy"
            style={{
              maxWidth: "75%",
              maxHeight: "82%",
              objectFit: "contain",
              imageRendering: collection.pixelated ? "pixelated" : "auto",
              borderRadius: collection.pixelated ? 4 : 12,
              transition: "transform 0.55s cubic-bezier(0.16, 1, 0.3, 1), filter 0.4s ease",
              transform: hovered ? "scale(1.08)" : "scale(1)",
              filter: hovered ? "brightness(1.1) saturate(1.05)" : "brightness(1)",
              position: "relative",
              zIndex: 1,
            }}
            onError={() => setImgError(true)}
          />
        ) : (
          <div style={{
            width: 80,
            height: 80,
            borderRadius: 16,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid var(--border)",
            display: "grid",
            placeItems: "center",
            color: "var(--text-dim)",
            fontSize: 28,
          }}>
            ?
          </div>
        )}

        {/* Supply badge in top-right corner */}
        <div style={{
          position: "absolute",
          top: 12,
          right: 12,
          fontFamily: "var(--mono)",
          fontSize: 9,
          color: "var(--text-dim)",
          background: "rgba(0,0,0,0.5)",
          backdropFilter: "blur(8px)",
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.05)",
          letterSpacing: "0.04em",
          zIndex: 3,
        }}>
          {(stats?.supply ?? collection.supply)?.toLocaleString() ?? "?"} items
        </div>
      </div>

      {/* ── Content area ── */}
      <div style={{ padding: "18px 22px 22px", flex: 1, display: "flex", flexDirection: "column" }}>
        {/* Name + highlight badges row */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          flexWrap: "wrap",
        }}>
          <h3 style={{
            fontFamily: "var(--pixel)",
            fontSize: 14,
            color: "var(--naka-blue)",
            margin: 0,
            letterSpacing: "0.04em",
            lineHeight: 1.3,
          }}>
            {collection.name}
          </h3>
          {collection.highlights?.map((h) => (
            <HighlightBadge key={h.label} label={h.label} color={h.color} />
          ))}
        </div>

        {/* Tagline */}
        {COLLECTION_LORE[collection.slug]?.tagline && (
          <div style={{
            fontFamily: "var(--display)", fontSize: 10, color: "var(--gold)",
            fontStyle: "italic", margin: "0 0 8px", opacity: 0.85,
          }}>
            {COLLECTION_LORE[collection.slug].tagline}
          </div>
        )}

        {/* Description */}
        <p style={{
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--text-muted)",
          margin: "0 0 6px",
          lineHeight: 1.6,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          minHeight: 32,
        }}>
          {collection.description}
        </p>

        {/* Creator */}
        {COLLECTION_LORE[collection.slug]?.creator?.name && (
          <div style={{
            fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)",
            marginBottom: 8, letterSpacing: "0.04em",
          }}>
            by {COLLECTION_LORE[collection.slug].creator.name}
          </div>
        )}

        {/* Tags */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
          {collection.tags?.map((tag) => (
            <span
              key={tag}
              style={{
                fontFamily: "var(--mono)",
                fontSize: 8,
                color: "var(--text-dim)",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 4,
                padding: "3px 7px",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              {tag}
            </span>
          ))}
        </div>

        {/* Spacer to push stats to bottom */}
        <div style={{ flex: 1 }} />

        {/* Stats grid */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "10px 16px",
          borderTop: "1px solid rgba(255,255,255,0.05)",
          paddingTop: 14,
          transition: "opacity 0.3s ease",
        }}>
          <Stat
            label="Floor"
            loading={isLoading}
            shimmerWidth="55%"
            value={isError ? dash : stats ? formatStat(stats.floor, " ETH") : dash}
          />
          <Stat
            label="Volume"
            loading={isLoading}
            shimmerWidth="70%"
            value={isError ? dash : stats ? formatStat(stats.volume, " ETH") : dash}
          />
          <Stat
            label="Owners"
            loading={isLoading}
            shimmerWidth="50%"
            value={isError ? dash : stats ? formatStat(stats.owners) : dash}
          />
          <Stat
            label="Supply"
            loading={isLoading}
            shimmerWidth="45%"
            value={
              stats?.supply != null
                ? formatStat(stats.supply)
                : collection.supply
                  ? collection.supply.toLocaleString()
                  : dash
            }
          />
        </div>
      </div>
    </button>
  );
}

/* ─── Main Landing Page ─── */
export default function CollectionLanding() {
  const navigate = useNavigate();
  const [statsMap, setStatsMap] = useState({});
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsErrors, setStatsErrors] = useState({});
  const [previewImages, setPreviewImages] = useState({});

  useEffect(() => {
    let cancelled = false;
    const promises = COLLECTION_LIST.map((col) => {
      const statsPromise = fetchCollectionStats({ contract: col.contract, slug: col.slug, openseaSlug: col.openseaSlug })
        .then((s) => {
          if (!cancelled) setStatsMap((prev) => ({ ...prev, [col.slug]: s }));
        })
        .catch((err) => {
          console.warn(`Failed to load stats for ${col.slug}:`, err.message);
          if (!cancelled) setStatsErrors((prev) => ({ ...prev, [col.slug]: true }));
        });

      if (!col.image) {
        fetchTokens({ contract: col.contract, metadataBase: col.metadataBase, limit: 40 })
          .then((data) => {
            if (cancelled) return;
            const withImages = (data.tokens || []).filter(t => t.image);
            if (withImages.length > 0) {
              const pick = withImages[Math.floor(Math.random() * withImages.length)];
              setPreviewImages((prev) => ({ ...prev, [col.slug]: pick.image }));
            }
          })
          .catch((err) => {
            console.warn(`Failed to load preview for ${col.slug}:`, err.message);
          });
      }

      return statsPromise;
    });

    Promise.allSettled(promises).then(() => {
      if (!cancelled) setStatsLoading(false);
    });

    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "56px 20px 96px", position: "relative" }}>
      {/* ── Ambient background glow ── */}
      <div style={{
        position: "absolute",
        top: -60,
        left: "50%",
        transform: "translateX(-50%)",
        width: 500,
        height: 300,
        background: "radial-gradient(ellipse, rgba(111,168,220,0.06) 0%, transparent 70%)",
        pointerEvents: "none",
        zIndex: 0,
      }} />

      {/* ── Heading area ── */}
      <div style={{ textAlign: "center", marginBottom: 56, position: "relative", zIndex: 1 }}>
        {/* Decorative line */}
        <div style={{
          width: 48,
          height: 2,
          background: "linear-gradient(90deg, transparent, var(--naka-blue), transparent)",
          margin: "0 auto 20px",
          borderRadius: 2,
        }} />

        <h1 style={{
          fontFamily: "var(--pixel)",
          fontSize: 26,
          color: "var(--naka-blue)",
          letterSpacing: "0.1em",
          margin: "0 0 14px",
          lineHeight: 1.3,
          textShadow: "0 0 40px rgba(111,168,220,0.15)",
        }}>
          TRADERMIGOS
        </h1>

        <p style={{
          fontFamily: "var(--mono)",
          fontSize: 12,
          color: "var(--text-muted)",
          maxWidth: 440,
          margin: "0 auto 20px",
          lineHeight: 1.6,
          letterSpacing: "0.02em",
        }}>
          Browse, trade, and analyze NFT collections
        </p>

        {/* ── Unified collection count + chain badge ── */}
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "var(--mono)",
          fontSize: 10,
          color: "var(--text-muted)",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 20,
          padding: "6px 16px",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}>
          <span>{COLLECTION_LIST.length} Collection{COLLECTION_LIST.length !== 1 ? "s" : ""}</span>
          <span style={{
            width: 3,
            height: 3,
            borderRadius: "50%",
            background: "var(--text-dim)",
            display: "inline-block",
          }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            {/* Ethereum diamond icon */}
            <svg width="10" height="16" viewBox="0 0 256 417" fill="none" style={{ opacity: 0.5 }}>
              <path d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z" fill="rgba(255,255,255,0.6)" />
              <path d="M127.962 0L0 212.32l127.962 75.639V154.158z" fill="rgba(255,255,255,0.4)" />
              <path d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.601L256 236.587z" fill="rgba(255,255,255,0.6)" />
              <path d="M127.962 416.905v-104.72L0 236.585z" fill="rgba(255,255,255,0.4)" />
            </svg>
            Ethereum
          </span>
        </div>

        {/* Decorative line below */}
        <div style={{
          width: 48,
          height: 2,
          background: "linear-gradient(90deg, transparent, var(--naka-blue), transparent)",
          margin: "24px auto 0",
          borderRadius: 2,
          opacity: 0.4,
        }} />
      </div>

      {/* ── Cross-collection search ── */}
      <CrossCollectionSearch />

      {/* ── Cards grid ── */}
      <div className="collection-landing-grid">
        {COLLECTION_LIST.map((col, i) => (
          <CollectionCard
            key={col.slug}
            collection={col}
            stats={statsMap[col.slug]}
            statsLoading={statsLoading && !statsMap[col.slug] && !statsErrors[col.slug]}
            statsError={statsErrors[col.slug]}
            previewImage={previewImages[col.slug]}
            onClick={() => navigate(`/nakamigos/${col.slug}`)}
            index={i}
          />
        ))}
      </div>

      {/* ── Keyframes (injected once) ── */}
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .collection-landing-grid button:focus-visible {
          outline: 2px solid var(--naka-blue);
          outline-offset: 2px;
        }
      `}</style>
    </div>
  );
}
