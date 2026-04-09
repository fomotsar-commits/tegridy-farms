import { useState, useMemo, useCallback } from "react";
import { CHARACTER_TYPES, TRAIT_LORE } from "../constants";

/* ── Tier helpers ── */
const ULTRA_RARE = new Set(["Ghost", "Balloon"]);
const NON_HUMAN = new Set(["Frog", "Bot", "Crocodile", "Snowman", "Balloon", "Ghost"]);

function tierColor(name) {
  if (ULTRA_RARE.has(name)) return "var(--gold)";
  if (NON_HUMAN.has(name)) return "var(--naka-blue)";
  return "var(--border)";
}

function tierBg(name) {
  if (ULTRA_RARE.has(name)) return "rgba(255,215,0,0.06)";
  if (NON_HUMAN.has(name)) return "rgba(111,168,220,0.06)";
  return "transparent";
}

function tierGlow(name) {
  if (ULTRA_RARE.has(name)) return "0 0 12px rgba(255,215,0,0.25)";
  return "none";
}

/* ── Ninja subtypes from TRAIT_LORE ── */
const NINJA_SUBTYPES = [
  { name: "Midnight Ninja", count: 319, color: "#1a1a2e" },
  { name: "Snow Ninja", count: 90, color: "#e8e8e8" },
  { name: "Crimson Ninja", count: 16, color: "#dc143c" },
];

/* ── Rare combos from TRAIT_LORE ── */
const RARE_COMBOS = [
  { name: "Gold Mouth + Gold Medallion", count: 4 },
  { name: "Gold Mouth + Gold Chain", count: 43 },
];

/* ── Styles ── */
const S = {
  wrapper: {
    marginBottom: 48,
  },
  sectionTitle: {
    fontFamily: "var(--pixel)",
    fontSize: 22,
    letterSpacing: 2,
    color: "var(--gold)",
    marginBottom: 4,
    textAlign: "center",
  },
  sectionSubtitle: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--text-dim)",
    textAlign: "center",
    marginBottom: 24,
  },

  /* Type grid */
  typeGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: 16,
    marginBottom: 40,
  },
  typeCard: (name) => ({
    background: tierBg(name),
    border: `2px solid ${tierColor(name)}`,
    borderRadius: 14,
    padding: "18px 20px",
    cursor: "pointer",
    transition: "transform .15s, box-shadow .15s",
    boxShadow: tierGlow(name),
    position: "relative",
    overflow: "hidden",
  }),
  typeName: {
    fontFamily: "var(--display)",
    fontSize: 18,
    fontWeight: 700,
    color: "var(--text)",
    marginBottom: 4,
  },
  badge: (isHuman) => ({
    display: "inline-block",
    fontFamily: "var(--mono)",
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    padding: "2px 8px",
    borderRadius: 4,
    marginBottom: 8,
    background: isHuman ? "rgba(111,168,220,0.15)" : "rgba(255,215,0,0.15)",
    color: isHuman ? "var(--naka-blue)" : "var(--gold)",
    border: `1px solid ${isHuman ? "rgba(111,168,220,0.3)" : "rgba(255,215,0,0.3)"}`,
  }),
  typeStats: {
    display: "flex",
    gap: 16,
    marginBottom: 8,
  },
  typeStat: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--text-muted)",
  },
  typeStatNum: {
    fontWeight: 700,
    color: "var(--text)",
  },
  typeDesc: {
    fontFamily: "var(--mono)",
    fontSize: 11,
    color: "var(--text-dim)",
    lineHeight: 1.5,
  },
  floorTag: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--green)",
    marginTop: 6,
  },

  /* Ninja subtypes */
  subSection: {
    marginBottom: 36,
  },
  subTitle: {
    fontFamily: "var(--display)",
    fontSize: 16,
    fontWeight: 700,
    color: "var(--text)",
    marginBottom: 12,
    letterSpacing: 0.5,
  },
  ninjaRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 8,
  },
  ninjaCard: (color) => ({
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "12px 18px",
    flex: "1 1 200px",
    minWidth: 200,
  }),
  ninjaDot: (color) => ({
    width: 16,
    height: 16,
    borderRadius: "50%",
    background: color,
    border: "2px solid var(--border)",
    flexShrink: 0,
  }),
  ninjaName: {
    fontFamily: "var(--display)",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text)",
  },
  ninjaCount: {
    fontFamily: "var(--mono)",
    fontSize: 11,
    color: "var(--text-muted)",
  },
  viewBtn: {
    padding: "4px 10px",
    border: "1px solid var(--naka-blue)",
    borderRadius: 6,
    background: "transparent",
    color: "var(--naka-blue)",
    fontFamily: "var(--mono)",
    fontSize: 10,
    cursor: "pointer",
    transition: "background .15s, color .15s",
    marginLeft: "auto",
    whiteSpace: "nowrap",
  },

  /* Rare combos */
  comboRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 8,
  },
  comboCard: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: "rgba(255,215,0,0.04)",
    border: "1px solid rgba(255,215,0,0.2)",
    borderRadius: 12,
    padding: "14px 20px",
    flex: "1 1 260px",
  },
  comboIcon: {
    fontSize: 20,
    flexShrink: 0,
  },
  comboName: {
    fontFamily: "var(--display)",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--gold)",
  },
  comboCount: {
    fontFamily: "var(--mono)",
    fontSize: 11,
    color: "var(--text-muted)",
  },

  /* Distribution chart */
  chartWrap: {
    marginBottom: 40,
  },
  barRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 6,
  },
  barLabel: {
    fontFamily: "var(--mono)",
    fontSize: 11,
    color: "var(--text)",
    width: 110,
    textAlign: "right",
    flexShrink: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  barTrack: {
    flex: 1,
    height: 18,
    borderRadius: 4,
    background: "rgba(255,255,255,0.04)",
    overflow: "hidden",
    position: "relative",
  },
  barFill: (pct, name) => ({
    height: "100%",
    width: `${Math.max(pct, 0.5)}%`,
    borderRadius: 4,
    background: ULTRA_RARE.has(name)
      ? "linear-gradient(90deg, var(--gold), #ffd700aa)"
      : NON_HUMAN.has(name)
        ? "linear-gradient(90deg, var(--naka-blue), #6fa8dcaa)"
        : "linear-gradient(90deg, var(--text-muted), rgba(180,180,180,0.5))",
    transition: "width .4s ease",
    boxShadow: ULTRA_RARE.has(name) ? "0 0 8px var(--gold)" : "none",
  }),
  barPct: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text-dim)",
    width: 50,
    textAlign: "right",
    flexShrink: 0,
  },
};

/* ══════════════════════════════════════════════
   CharacterTypeExplorer — Nakamigos type breakdown
   ══════════════════════════════════════════════ */
export default function CharacterTypeExplorer({ tokens, listings, onFilterGallery }) {
  const [hovered, setHovered] = useState(null);

  /* ── Floor prices per character type ── */
  const typeFloors = useMemo(() => {
    if (!listings || !tokens || listings.length === 0) return {};

    // Build tokenId -> price map
    const priceMap = {};
    for (const l of listings) {
      if (l.tokenId && l.price != null) {
        priceMap[String(l.tokenId)] = l.price;
      }
    }

    // Build type -> floor map
    const floors = {};
    for (const token of tokens) {
      const price = priceMap[String(token.id)];
      if (price == null) continue;
      const typeAttr = token.attributes?.find(
        (a) => a.key === "Type" || a.key === "type" || a.key === "Character Type"
      );
      if (!typeAttr) continue;
      const typeName = typeAttr.value;
      if (floors[typeName] == null || price < floors[typeName]) {
        floors[typeName] = price;
      }
    }
    return floors;
  }, [tokens, listings]);

  /* ── Handle type card click ── */
  const handleTypeClick = useCallback(
    (typeName) => {
      if (onFilterGallery) {
        // Try common attribute key names for character type
        onFilterGallery("Type", typeName);
      }
    },
    [onFilterGallery]
  );

  /* ── Handle ninja view click ── */
  const handleNinjaView = useCallback(
    (ninjaName) => {
      if (onFilterGallery) {
        // Ninja subtypes are typically a "Hat/Helmet" or "Type" trait value
        // Map name to trait value
        const valueMap = {
          "Midnight Ninja": "Ninja Midnight",
          "Snow Ninja": "Ninja Snow",
          "Crimson Ninja": "Ninja Crimson",
        };
        onFilterGallery("Hat/Helmet", valueMap[ninjaName] || ninjaName);
      }
    },
    [onFilterGallery]
  );

  /* ── Sorted types for chart (descending) ── */
  const sortedTypes = useMemo(
    () => [...CHARACTER_TYPES].sort((a, b) => b.count - a.count),
    []
  );

  const maxCount = sortedTypes[0]?.count || 1;

  return (
    <div style={S.wrapper}>
      {/* ── Section Header ── */}
      <div style={{ marginBottom: 28 }}>
        <div style={S.sectionTitle}>CHARACTER TYPES</div>
        <div style={S.sectionSubtitle}>
          12 distinct character types across 20,000 Nakamigos. Click to filter the gallery.
        </div>
      </div>

      {/* ── 1. Type Grid ── */}
      <div style={S.typeGrid}>
        {CHARACTER_TYPES.map((type) => {
          const isHov = hovered === type.name;
          const floor = typeFloors[type.name];
          return (
            <div
              key={type.name}
              style={{
                ...S.typeCard(type.name),
                transform: isHov ? "translateY(-3px)" : "none",
                boxShadow: isHov
                  ? `${tierGlow(type.name)}, 0 8px 24px rgba(0,0,0,.3)`
                  : tierGlow(type.name),
              }}
              onClick={() => handleTypeClick(type.name)}
              onMouseEnter={() => setHovered(type.name)}
              onMouseLeave={() => setHovered(null)}
            >
              <div style={S.typeName}>{type.name}</div>
              <span style={S.badge(type.isHuman)}>
                {type.isHuman ? "HUMAN" : "NON-HUMAN"}
              </span>
              <div style={S.typeStats}>
                <span style={S.typeStat}>
                  <span style={S.typeStatNum}>{type.count.toLocaleString()}</span> supply
                </span>
                <span style={S.typeStat}>
                  <span style={S.typeStatNum}>{type.percentage}%</span> of total
                </span>
              </div>
              <div style={S.typeDesc}>{type.description}</div>
              {floor != null && (
                <div style={S.floorTag}>
                  Floor: {floor < 0.01 ? "<0.01" : floor.toFixed(floor < 1 ? 3 : 2)} ETH
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── 2. Ninja Subtypes ── */}
      <div style={S.subSection}>
        <div style={S.subTitle}>Ninja Subtypes</div>
        <div style={{ ...S.sectionSubtitle, textAlign: "left", marginBottom: 12 }}>
          Community-discovered variants of the Ninja Hat/Helmet trait.
        </div>
        <div style={S.ninjaRow}>
          {NINJA_SUBTYPES.map((ninja) => (
            <div key={ninja.name} style={S.ninjaCard(ninja.color)}>
              <div style={S.ninjaDot(ninja.color)} />
              <div>
                <div style={S.ninjaName}>{ninja.name}</div>
                <div style={S.ninjaCount}>{ninja.count} exist</div>
              </div>
              <button
                style={S.viewBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  handleNinjaView(ninja.name);
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--naka-blue)";
                  e.currentTarget.style.color = "#fff";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--naka-blue)";
                }}
              >
                View in Gallery
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── 3. Rare Combos ── */}
      <div style={S.subSection}>
        <div style={S.subTitle}>Ultra-Rare Trait Combinations</div>
        <div style={S.comboRow}>
          {RARE_COMBOS.map((combo) => (
            <div key={combo.name} style={S.comboCard}>
              <div style={S.comboIcon}>{"\u2728"}</div>
              <div>
                <div style={S.comboName}>{combo.name}</div>
                <div style={S.comboCount}>
                  Only {combo.count} exist across the entire collection
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 4. Distribution Chart ── */}
      <div style={S.chartWrap}>
        <div style={S.subTitle}>Population Distribution</div>
        <div style={{ ...S.sectionSubtitle, textAlign: "left", marginBottom: 16 }}>
          Horizontal bar chart of all 12 character types by supply.
        </div>
        {sortedTypes.map((type) => {
          const pct = (type.count / maxCount) * 100;
          return (
            <div key={type.name} style={S.barRow}>
              <div style={S.barLabel} title={type.name}>
                {type.name}
              </div>
              <div style={S.barTrack}>
                <div style={S.barFill(pct, type.name)} />
              </div>
              <div style={S.barPct}>
                {type.count.toLocaleString()} ({type.percentage}%)
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
