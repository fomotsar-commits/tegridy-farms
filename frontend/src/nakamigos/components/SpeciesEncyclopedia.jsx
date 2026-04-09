import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { GNSS_SPECIES, TRAIT_LORE } from "../constants";

/* ── Tier config ── */
const TIERS = [
  { key: "legendary", label: "LEGENDARY", color: "var(--gold)",      bg: "rgba(200,168,80,0.10)", border: "rgba(200,168,80,0.25)" },
  { key: "rare",      label: "RARE",      color: "var(--naka-blue)", bg: "rgba(111,168,220,0.08)", border: "rgba(111,168,220,0.20)" },
  { key: "uncommon",  label: "UNCOMMON",   color: "var(--green)",     bg: "rgba(74,222,128,0.06)",  border: "rgba(74,222,128,0.18)" },
  { key: "common",    label: "COMMON",     color: "var(--text-dim)",  bg: "rgba(255,255,255,0.02)", border: "rgba(255,255,255,0.06)" },
];

const TIER_MAP = Object.fromEntries(TIERS.map(t => [t.key, t]));

/* ── Alignment color data ── */
const ALIGNMENT_DISPLAY = {
  XEN:    { hex: "#a855f7", confirmed: true },
  RADI:   { hex: "#f97316", confirmed: false },
  LIT:    { hex: "#facc15", confirmed: false },
  SILI:   { hex: "#6ee7b7", confirmed: false },
  MAGN:   { hex: "#60a5fa", confirmed: false },
  NIO:    { hex: "#f472b6", confirmed: false },
  CHROM:  { hex: "#c084fc", confirmed: false },
  PROTAC: { hex: "#94a3b8", confirmed: false },
};

/* ── Subspecies naming convention ── */
const SUBSPECIES_NAMES = ["AX", "Bess", "Caos", "Duum", "Edo", "Fuuz"];

/* ── Styles ── */
const S = {
  wrapper: {
    marginTop: 48,
  },
  sectionTitle: {
    fontFamily: "var(--pixel)",
    fontSize: 11,
    color: "var(--naka-blue)",
    letterSpacing: "0.06em",
    marginBottom: 24,
  },
  sectionSubtitle: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text-muted)",
    marginBottom: 20,
    marginTop: -16,
  },

  /* Tier group */
  tierGroup: {
    marginBottom: 28,
  },
  tierLabel: (color, bg) => ({
    display: "inline-block",
    fontFamily: "var(--mono)",
    fontSize: 9,
    letterSpacing: "0.1em",
    padding: "3px 10px",
    borderRadius: 4,
    color,
    background: bg,
    marginBottom: 10,
  }),
  speciesGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: 10,
  },

  /* Species card */
  card: (tier) => ({
    background: tier === "legendary"
      ? "linear-gradient(135deg, rgba(200,168,80,0.12), rgba(200,168,80,0.04))"
      : "var(--surface)",
    border: `1px solid ${TIER_MAP[tier]?.border || "rgba(255,255,255,0.04)"}`,
    borderRadius: 10,
    padding: "16px 14px",
    cursor: "pointer",
    transition: "transform .15s, box-shadow .15s",
  }),
  cardHover: {
    transform: "translateY(-2px)",
    boxShadow: "0 6px 24px rgba(0,0,0,.3)",
  },
  cardHeaderRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  speciesName: (color) => ({
    fontFamily: "var(--display)",
    fontSize: 14,
    fontWeight: 700,
    color,
  }),
  letterBadge: (color) => ({
    fontFamily: "var(--mono)",
    fontSize: 10,
    padding: "2px 8px",
    borderRadius: 4,
    background: `${color}15`,
    color,
    fontWeight: 600,
  }),
  tierBadge: (color) => ({
    fontFamily: "var(--mono)",
    fontSize: 8,
    padding: "2px 6px",
    borderRadius: 4,
    background: `${color}15`,
    color,
    textTransform: "uppercase",
  }),
  visualDesc: {
    fontFamily: "var(--display)",
    fontSize: 11,
    color: "var(--text-dim)",
    lineHeight: 1.6,
    marginBottom: 6,
  },
  supplyLine: (color) => ({
    fontFamily: "var(--mono)",
    fontSize: 9,
    color,
    letterSpacing: "0.04em",
  }),

  /* Expanded detail */
  detail: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: "1px solid rgba(255,255,255,0.06)",
  },
  detailLabel: {
    fontFamily: "var(--mono)",
    fontSize: 9,
    color: "var(--text-muted)",
    letterSpacing: "0.06em",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  subspeciesList: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    marginBottom: 8,
  },
  subspecieTag: {
    fontFamily: "var(--mono)",
    fontSize: 9,
    padding: "2px 8px",
    borderRadius: 4,
    background: "rgba(200,168,80,0.06)",
    border: "1px solid rgba(200,168,80,0.12)",
    color: "var(--gold)",
  },
  galleryBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 12px",
    borderRadius: 6,
    border: "1px solid var(--naka-blue)",
    background: "rgba(111,168,220,0.08)",
    color: "var(--naka-blue)",
    fontFamily: "var(--mono)",
    fontSize: 10,
    cursor: "pointer",
    transition: "background .15s, color .15s",
    marginTop: 6,
  },

  /* Alignment color guide */
  alignmentGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 10,
  },
  alignmentCard: {
    background: "var(--surface)",
    border: "1px solid rgba(255,255,255,0.04)",
    borderRadius: 10,
    padding: "14px 14px",
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
  },
  colorSwatch: (hex) => ({
    width: 28,
    height: 28,
    borderRadius: 6,
    background: hex,
    flexShrink: 0,
    boxShadow: `0 0 12px ${hex}40`,
  }),
  alignName: {
    fontFamily: "var(--display)",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text)",
    marginBottom: 2,
  },
  alignStatus: (confirmed) => ({
    fontFamily: "var(--mono)",
    fontSize: 8,
    color: confirmed ? "var(--green)" : "var(--text-muted)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    marginBottom: 4,
  }),
  alignDesc: {
    fontFamily: "var(--display)",
    fontSize: 10,
    color: "var(--text-dim)",
    lineHeight: 1.5,
  },

  /* Trait parameter cards */
  paramGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: 10,
  },
  paramCard: {
    background: "var(--surface)",
    padding: "14px 16px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.04)",
  },
  paramName: {
    fontFamily: "var(--display)",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text)",
    marginBottom: 4,
  },
  paramDesc: {
    fontFamily: "var(--display)",
    fontSize: 10,
    color: "var(--text-dim)",
    lineHeight: 1.6,
  },

  /* Population chart */
  chartWrapper: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  chartRow: {
    display: "grid",
    gridTemplateColumns: "80px 1fr 50px",
    gap: 10,
    alignItems: "center",
  },
  chartLabel: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text)",
    textAlign: "right",
  },
  chartBarOuter: {
    height: 16,
    borderRadius: 4,
    background: "rgba(255,255,255,0.03)",
    overflow: "hidden",
  },
  chartBarInner: (pct, color) => ({
    height: "100%",
    width: `${Math.max(pct, 0.5)}%`,
    borderRadius: 4,
    background: color,
    transition: "width .4s ease",
    boxShadow: color === "var(--gold)" ? "0 0 8px var(--gold)" : "none",
  }),
  chartCount: (color) => ({
    fontFamily: "var(--mono)",
    fontSize: 9,
    color,
    textAlign: "left",
  }),
};

/* ═══════════════════════════════════════════════════════
   SpeciesEncyclopedia — GNSS Art Species deep-dive
   ═══════════════════════════════════════════════════════ */
export default function SpeciesEncyclopedia() {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(null);
  const [hoveredCard, setHoveredCard] = useState(null);

  const toggleExpand = useCallback((letter) => {
    setExpanded(prev => prev === letter ? null : letter);
  }, []);

  /* Species grouped by tier */
  const tierGroups = useMemo(() => {
    return TIERS.map(tier => ({
      ...tier,
      species: GNSS_SPECIES.filter(s => s.rarityTier === tier.key),
    }));
  }, []);

  /* Population chart data: only species with known supply, sorted descending */
  const chartData = useMemo(() => {
    const withSupply = GNSS_SPECIES.filter(s => s.supply != null);
    const sorted = [...withSupply].sort((a, b) => b.supply - a.supply);
    const max = sorted[0]?.supply || 1;
    return sorted.map(s => ({
      ...s,
      pct: (s.supply / max) * 100,
      tierColor: TIER_MAP[s.rarityTier]?.color || "var(--text-dim)",
    }));
  }, []);

  /* Alignment data */
  const alignments = TRAIT_LORE.gnssart?.alignmentColors || {};

  /* Trait params */
  const traitParams = TRAIT_LORE.gnssart?.traitParams || {};

  /* Atomic numbers */
  const atomicNumbers = TRAIT_LORE.gnssart?.atomicNumbers || {};

  const handleViewInGallery = useCallback((speciesName) => {
    navigate(`/nakamigos/gnssart/gallery?species=${encodeURIComponent(speciesName)}`);
  }, [navigate]);

  return (
    <div style={S.wrapper}>

      {/* ═══ 1. SPECIES TAXONOMY TREE ═══ */}
      <h3 style={S.sectionTitle}>SPECIES ENCYCLOPEDIA</h3>
      <div style={S.sectionSubtitle}>
        23 species across 4 rarity tiers. Click any species for details.
      </div>

      {tierGroups.map(tier => (
        <div key={tier.key} style={S.tierGroup}>
          <div style={S.tierLabel(tier.color, tier.bg)}>
            {tier.label} ({tier.species.length})
          </div>
          <div style={S.speciesGrid}>
            {tier.species.map(sp => {
              const tierConf = TIER_MAP[sp.rarityTier];
              const color = tierConf?.color || "var(--text-dim)";
              const isExpanded = expanded === sp.letter;
              const isHovered = hoveredCard === sp.letter;

              return (
                <div
                  key={sp.letter}
                  style={{
                    ...S.card(sp.rarityTier),
                    ...(isHovered ? S.cardHover : {}),
                  }}
                  onClick={() => toggleExpand(sp.letter)}
                  onMouseEnter={() => setHoveredCard(sp.letter)}
                  onMouseLeave={() => setHoveredCard(null)}
                >
                  {/* Header: Name + Letter badge */}
                  <div style={S.cardHeaderRow}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={S.speciesName(color)}>{sp.name}</span>
                      <span style={S.letterBadge(color)}>{sp.letter}</span>
                    </div>
                    <span style={S.tierBadge(color)}>{sp.rarityTier}</span>
                  </div>

                  {/* Visual description */}
                  <div style={S.visualDesc}>{sp.visualDescription}</div>

                  {/* Supply line */}
                  <div style={S.supplyLine(color)}>
                    {sp.supply ? `${sp.supply.toLocaleString()} beings` : "Supply TBD"}
                    {sp.subspecies.length > 0 && ` \u00b7 ${sp.subspecies.length} subspecies`}
                  </div>

                  {/* ── Expanded detail ── */}
                  {isExpanded && (
                    <div style={S.detail}>
                      {/* Subspecies */}
                      {sp.subspecies.length > 0 && (
                        <>
                          <div style={S.detailLabel}>Subspecies</div>
                          <div style={S.subspeciesList}>
                            {sp.subspecies.map(sub => (
                              <span key={sub} style={S.subspecieTag}>
                                {sub}
                                {SUBSPECIES_NAMES.includes(sub) && (
                                  <span style={{ opacity: 0.5, marginLeft: 4 }}>
                                    ({SUBSPECIES_NAMES.indexOf(sub) + 1}/{SUBSPECIES_NAMES.length})
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", marginBottom: 8 }}>
                            Naming convention: {SUBSPECIES_NAMES.join(" \u2192 ")}
                          </div>
                        </>
                      )}

                      {sp.subspecies.length === 0 && (
                        <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginBottom: 8 }}>
                          Pure form only -- no subspecies variations.
                        </div>
                      )}

                      {/* View in Gallery */}
                      <button
                        style={S.galleryBtn}
                        onClick={(e) => { e.stopPropagation(); handleViewInGallery(sp.name); }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--naka-blue)"; e.currentTarget.style.color = "#fff"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(111,168,220,0.08)"; e.currentTarget.style.color = "var(--naka-blue)"; }}
                      >
                        View in Gallery {"\u2192"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* ═══ 2. ALIGNMENT COLOR GUIDE ═══ */}
      <div style={{ marginTop: 40 }}>
        <h3 style={S.sectionTitle}>ALIGNMENT LIGHT COLORS (8)</h3>
        <div style={S.sectionSubtitle}>
          Each being carries one of 8 alignment lights. Only XEN (purple) is confirmed by the artist.
        </div>
        <div style={S.alignmentGrid}>
          {Object.entries(alignments).map(([name, data]) => {
            const display = ALIGNMENT_DISPLAY[name] || { hex: "#666", confirmed: false };
            return (
              <div key={name} style={S.alignmentCard}>
                <div style={S.colorSwatch(display.hex)} />
                <div>
                  <div style={S.alignName}>{name}</div>
                  <div style={S.alignStatus(display.confirmed)}>
                    {display.confirmed ? "CONFIRMED" : "UNCONFIRMED"}
                    {data.color !== "Unknown" && ` \u00b7 ${data.color}`}
                  </div>
                  <div style={S.alignDesc}>{data.description}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══ 3. ATOMIC NUMBERS ═══ */}
      {Object.keys(atomicNumbers).length > 0 && (
        <div style={{ marginTop: 36 }}>
          <h3 style={S.sectionTitle}>ATOMIC NUMBERS</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 10 }}>
            {Object.entries(atomicNumbers).map(([num, data]) => (
              <div key={num} style={S.paramCard}>
                <div style={S.paramName}>
                  #{num} -- {data.element}
                </div>
                <div style={S.paramDesc}>{data.description}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ 4. TRAIT PARAMETER REFERENCE ═══ */}
      <div style={{ marginTop: 36 }}>
        <h3 style={S.sectionTitle}>ON-CHAIN TRAIT PARAMETERS ({Object.keys(traitParams).length})</h3>
        <div style={S.sectionSubtitle}>
          Each GNSS being is defined by on-chain parameters that control its generative form.
        </div>
        <div style={S.paramGrid}>
          {Object.entries(traitParams).map(([param, desc]) => (
            <div key={param} style={S.paramCard}>
              <div style={S.paramName}>{param}</div>
              <div style={S.paramDesc}>{desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ═══ 5. SPECIES POPULATION CHART ═══ */}
      {chartData.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <h3 style={S.sectionTitle}>SPECIES POPULATION</h3>
          <div style={S.sectionSubtitle}>
            Horizontal bars showing known population counts, colored by rarity tier.
          </div>
          <div style={S.chartWrapper}>
            {chartData.map(sp => (
              <div key={sp.letter} style={S.chartRow}>
                <div style={S.chartLabel}>{sp.name}</div>
                <div style={S.chartBarOuter}>
                  <div style={S.chartBarInner(sp.pct, sp.tierColor)} />
                </div>
                <div style={S.chartCount(sp.tierColor)}>
                  {sp.supply.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
