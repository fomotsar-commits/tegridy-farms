import { useState } from "react";
import { Link } from "react-router-dom";
import { COLLECTIONS, COLLECTION_LORE, JB_LEGENDARIES, TRAIT_LORE } from "../constants";
import { canTradeOnVenue, chainLabel, standardLabel, supplyLabel } from "../lib/venue";

// ═══ CATEGORY LABELS FOR LEGENDARIES ═══
const LEGENDARY_CATEGORIES = {
  "The One Ape": "Leadership",
  "Cake Ape": "Whimsy",
  "Kumo Ape": "Mythology",
  "Skull Ape": "Gothic",
  "Slime Ape": "Creature",
  "Medusa Ape": "Mythology",
  "Thanos Ape": "Pop Culture",
  "Wolverine Ape": "Pop Culture",
  "Sketch Ape": "Art",
  "Groot Ape": "Pop Culture",
  "Saiyan Ape": "Anime",
  "Pepe Ape": "Crypto Culture",
  "Dr. Apehattan": "Pop Culture",
  "Super Ape": "Pop Culture",
  "Tiger Ape": "Animal",
  "Mummy Ape": "Mythology",
  "Alien Ape": "Sci-Fi",
  "Joker Ape": "Pop Culture",
  "Ghost Ape": "Supernatural",
  "Devil Ape": "Mythology",
};

// ═══ THE FAMILY COLLECTIONS ═══
// The island's six family collections, drawn from the registry (name, chain,
// standard, supply, where it trades), in the order the lore lists them. No
// description is written for them here: nothing read supports one.
const FAMILY = (COLLECTION_LORE.junglebay.ecosystem || [])
  .map((e) => (e.slug ? COLLECTIONS[e.slug] : null))
  .filter(Boolean);

// A family contract's creation date, as a timeline entry. Only what the
// contract proves: the day it was deployed, on which chain.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDeployDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
const FAMILY_EVENTS = FAMILY
  .filter((c) => c.deploy?.date)
  .sort((a, b) => a.deploy.date.localeCompare(b.deploy.date))
  .map((c) => ({
    date: formatDeployDate(c.deploy.date),
    title: `${c.name} contract deployed`,
    description: `Contract created on ${chainLabel(c)} on ${c.deploy.date}, at block ${c.deploy.block.toLocaleString("en-US")}.`,
    color: "var(--purple)",
    icon: "\u{1F4DC}",
  }));

// ═══ TIMELINE EVENTS ═══
// The apes' own history, in the order it was written. Several entries are
// known only to the month or the year, so the family contract deployments,
// which carry full dates, are their own group rather than merged in.
const TIMELINE_EVENTS = [
  { date: "Nov 2021", title: "Rug Pull Exposed", description: "Roh (0xRoh) forensically exposes LBAC rug pull -- identical IPFS hashes, ~100 ETH stolen.", color: "var(--gold)", icon: "\u26A0" },
  { date: "Nov 16, 2021", title: "@JungleBayAC Created", description: "Community creates new identity the same day the scandal breaks. Refuses to scatter.", color: "var(--naka-blue)", icon: "\u2764" },
  { date: "Nov 2021", title: "Sandbox Land Secured", description: "Jungle Bay Island established at coordinates (14, -69) in The Sandbox.", color: "var(--green)", icon: "\u{1F3DD}" },
  { date: "Jan 6, 2022", title: "New Collection Minted", description: "5,555 hand-drawn apes launched in just 7-8 weeks. Original LBAC holders get free 1:1 exchange.", color: "var(--green)", icon: "\u2728" },
  { date: "Apr 2022", title: "Staking Launched", description: "Community staking system goes live, rewarding diamond hands.", color: "var(--purple)", icon: "\u2B50" },
  { date: "May 2022", title: "Otherside Land Acquired", description: "Community treasury purchases land in Yuga Labs' Otherside metaverse.", color: "var(--naka-blue)", icon: "\u{1F30D}" },
  { date: "2023", title: "Rebranded to Artists Collective", description: "Evolution from Ape Club to Artists Collective.", color: "var(--gold)", icon: "\u{1F3A8}" },
  { date: "Present", title: "Memetic Finance Era", description: "DM+T = Dank Memes + Time. $JBM token on Base.", color: "var(--gold)", icon: "\u{1F451}" },
];

// ═══ SKIN TIER DATA ═══
const SKIN_TIERS = [
  { tier: "Ultra-Rare", skins: [{ name: "Diamond", count: 21 }, { name: "Gold", count: 24 }], color: "var(--gold)", bg: "linear-gradient(135deg, rgba(200,168,80,0.18), rgba(200,168,80,0.06))" },
  { tier: "Rare", skins: [{ name: "Deep Space" }, { name: "Trippy" }, { name: "Noise" }], color: "var(--naka-blue)", bg: "linear-gradient(135deg, rgba(111,168,220,0.12), rgba(111,168,220,0.04))" },
  { tier: "Uncommon", skins: [{ name: "Giraffe" }, { name: "Zebra" }, { name: "Leopard" }, { name: "Cheetah" }], color: "var(--green)", bg: "linear-gradient(135deg, rgba(74,222,128,0.08), rgba(74,222,128,0.03))" },
  { tier: "Common", skins: [{ name: "Solid Colors" }], color: "var(--text-dim)", bg: "var(--surface)" },
];

// ═══ ECOSYSTEM DATA ═══
// A family entry carries its registry collection; its line says only the
// registry's facts and where it trades.
const familyItems = (chain) => FAMILY.filter((c) => chainLabel(c) === chain).map((c) => ({ name: c.name, collection: c }));
const ECOSYSTEM_CHAINS = [
  {
    chain: "Ethereum",
    color: "var(--naka-blue)",
    bg: "rgba(100,160,255,0.1)",
    items: [
      { name: "Jungle Bay Ape Club", supply: 5555, description: "Main collection -- 5,555 hand-drawn apes" },
      ...familyItems("Ethereum"),
    ],
  },
  {
    chain: "Base",
    color: "#0052ff",
    bg: "rgba(0,82,255,0.1)",
    items: [
      ...familyItems("Base"),
      { name: "$JBM Token", supply: null, description: "Community token" },
    ],
  },
  {
    chain: "Solana",
    color: "#9945ff",
    bg: "rgba(153,69,255,0.1)",
    items: familyItems("Solana"),
  },
  {
    chain: "Metaverse",
    color: "var(--gold)",
    bg: "rgba(200,168,80,0.1)",
    items: [
      { name: "Sandbox Land", supply: 1, description: "Jungle Bay Island at (14, -69)" },
      { name: "Otherside Land", supply: 1, description: "Yuga Labs metaverse land" },
    ],
  },
];

// ═══ SHARED STYLES ═══
const sectionHeadingStyle = {
  fontFamily: "var(--pixel)", fontSize: 11, color: "var(--naka-blue)",
  letterSpacing: "0.06em", marginBottom: 24,
};

const cardBase = {
  borderRadius: 10, padding: "16px 14px",
  border: "1px solid rgba(255,255,255,0.04)",
  background: "var(--surface)",
};

const goldCardBase = {
  ...cardBase,
  background: "linear-gradient(135deg, rgba(200,168,80,0.12), rgba(200,168,80,0.04))",
  border: "1px solid rgba(200,168,80,0.25)",
};

const actionBtnStyle = {
  fontFamily: "var(--mono)", fontSize: 8, padding: "4px 8px",
  borderRadius: 4, border: "1px solid rgba(200,168,80,0.25)",
  background: "rgba(200,168,80,0.08)", color: "var(--gold)",
  cursor: "pointer", letterSpacing: "0.04em",
  transition: "background 0.15s",
};

// ═══ SECTION: LEGENDARY 1/1 GALLERY ═══
function LegendaryGallery({ onFindInGallery }) {
  return (
    <div style={{ marginTop: 40 }}>
      <h3 style={sectionHeadingStyle}>{"\u{1F451}"} 20 LEGENDARY 1/1 APES</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {JB_LEGENDARIES.map(({ name, description }) => {
          const category = LEGENDARY_CATEGORIES[name] || "Legendary";
          return (
            <div key={name} style={{
              ...goldCardBase,
              display: "flex", flexDirection: "column", gap: 8,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ fontFamily: "var(--display)", fontSize: 12, fontWeight: 600, color: "var(--gold)" }}>
                  {"\u{1F451}"} {name}
                </div>
              </div>
              <span style={{
                fontFamily: "var(--mono)", fontSize: 7, padding: "2px 6px",
                borderRadius: 4, background: "rgba(200,168,80,0.1)",
                color: "var(--gold)", letterSpacing: "0.04em",
                alignSelf: "flex-start",
              }}>
                {category.toUpperCase()}
              </span>
              <div style={{ fontFamily: "var(--display)", fontSize: 10, color: "var(--text-dim)", lineHeight: 1.6, flex: 1 }}>
                {description}
              </div>
              <button
                onClick={() => onFindInGallery(name)}
                style={actionBtnStyle}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(200,168,80,0.18)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(200,168,80,0.08)"; }}
              >
                FIND IN GALLERY
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══ SECTION: RAREST TRAITS TABLE ═══
function RarestTraitsTable({ onViewInGallery }) {
  const traits = TRAIT_LORE.junglebay.rarestTraits;

  const getTierLabel = (count) => {
    if (count <= 6) return { label: "GOLD", color: "var(--gold)", bg: "rgba(200,168,80,0.15)" };
    if (count <= 18) return { label: "SILVER", color: "#c0c0c0", bg: "rgba(192,192,192,0.1)" };
    return { label: "BRONZE", color: "#cd7f32", bg: "rgba(205,127,50,0.1)" };
  };

  return (
    <div style={{ marginTop: 40 }}>
      <h3 style={sectionHeadingStyle}>{"\u{1F48E}"} RAREST STANDARD TRAITS</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
        {traits.map(({ trait, category, count, percentage }) => {
          const tier = getTierLabel(count);
          return (
            <div key={trait} style={{
              ...(count <= 6 ? goldCardBase : cardBase),
              display: "flex", flexDirection: "column", gap: 6,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontFamily: "var(--display)", fontSize: 13, fontWeight: 600, color: tier.color }}>
                  {trait}
                </div>
                <span style={{
                  fontFamily: "var(--mono)", fontSize: 7, padding: "2px 6px",
                  borderRadius: 4, background: tier.bg, color: tier.color,
                  letterSpacing: "0.06em",
                }}>
                  {tier.label}
                </span>
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
                {category.toUpperCase()}
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: tier.color, letterSpacing: "0.04em" }}>
                {count} exist ({percentage}%)
              </div>
              <button
                onClick={() => onViewInGallery(category, trait)}
                style={actionBtnStyle}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(200,168,80,0.18)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(200,168,80,0.08)"; }}
              >
                VIEW IN GALLERY
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══ SECTION: SKIN TIER PYRAMID ═══
function SkinTierPyramid() {
  return (
    <div style={{ marginTop: 40 }}>
      <h3 style={sectionHeadingStyle}>{"\u{1F3C6}"} SKIN TIER PYRAMID</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 600, margin: "0 auto" }}>
        {SKIN_TIERS.map(({ tier, skins, color, bg }, idx) => {
          // Pyramid widths: top narrow, bottom wide
          const widths = ["50%", "70%", "85%", "100%"];
          return (
            <div key={tier} style={{
              width: widths[idx], margin: "0 auto",
              background: bg,
              border: idx === 0 ? "1px solid rgba(200,168,80,0.25)" : "1px solid rgba(255,255,255,0.04)",
              borderRadius: 10, padding: "14px 18px",
              textAlign: "center",
            }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 8, color, letterSpacing: "0.08em", marginBottom: 8 }}>
                {tier.toUpperCase()}
              </div>
              <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
                {skins.map(s => (
                  <span key={s.name} style={{
                    fontFamily: "var(--display)", fontSize: 11, color,
                    padding: "3px 10px", borderRadius: 6,
                    background: `${color}12`,
                  }}>
                    {s.name}{s.count != null ? ` (${s.count})` : ""}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══ SECTION: RUG-TO-RICHES TIMELINE ═══
// One list of dated entries; `group` keeps the open entry unique across lists.
function TimelineGroup({ label, events, group, expanded, setExpanded }) {
  return (
    <div role="group" aria-label={label} style={{ position: "relative", paddingLeft: 32, maxWidth: 700 }}>
      {/* Vertical line */}
      <div style={{
        position: "absolute", left: 11, top: 0, bottom: 0, width: 2,
        background: "linear-gradient(180deg, var(--gold), var(--naka-blue), var(--green), var(--purple))",
        borderRadius: 2, opacity: 0.4,
      }} />

      {events.map((evt, idx) => {
        const id = `${group}-${idx}`;
        const open = expanded === id;
        return (
          <div
            key={id}
            style={{
              position: "relative", marginBottom: 20, cursor: "pointer",
              transition: "transform 0.15s",
            }}
            onClick={() => setExpanded(open ? null : id)}
            role="button"
            tabIndex={0}
            aria-expanded={open}
            aria-label={`${evt.date}: ${evt.title}`}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(open ? null : id); } }}
          >
            {/* Dot */}
            <div style={{
              position: "absolute", left: -27, top: 4, width: 14, height: 14,
              borderRadius: "50%", background: evt.color, opacity: 0.8,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 8, lineHeight: 1,
              boxShadow: open ? `0 0 8px ${evt.color}` : "none",
              transition: "box-shadow 0.2s",
            }}>
              {evt.icon}
            </div>

            {/* Content */}
            <div style={{
              background: open
                ? "linear-gradient(135deg, rgba(200,168,80,0.1), rgba(200,168,80,0.03))"
                : "var(--surface)",
              border: open ? "1px solid rgba(200,168,80,0.2)" : "1px solid rgba(255,255,255,0.04)",
              borderRadius: 10, padding: "14px 16px",
              transition: "all 0.2s",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: evt.color, letterSpacing: "0.06em" }}>
                  {evt.date}
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
                  {open ? "COLLAPSE" : "EXPAND"}
                </span>
              </div>
              <div style={{ fontFamily: "var(--display)", fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                {evt.title}
              </div>
              {open && (
                <div style={{
                  fontFamily: "var(--display)", fontSize: 11, color: "var(--text-dim)",
                  lineHeight: 1.7, marginTop: 8,
                  opacity: 1,
                  transition: "opacity 0.2s ease",
                }}>
                  {evt.description}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RugToRichesTimeline() {
  const [expanded, setExpanded] = useState(null);

  return (
    <div style={{ marginTop: 40 }}>
      <h3 style={sectionHeadingStyle}>{"\u{1F4C5}"} RUG-TO-RICHES TIMELINE</h3>
      <TimelineGroup label="Rug-to-riches timeline" events={TIMELINE_EVENTS} group="apes" expanded={expanded} setExpanded={setExpanded} />
      {FAMILY_EVENTS.length > 0 && (
        <>
          <h4 style={{ ...sectionHeadingStyle, fontSize: 9, marginTop: 28, marginBottom: 16 }}>FAMILY CONTRACTS, BY DEPLOY DATE</h4>
          <TimelineGroup label="Family contracts, by deploy date" events={FAMILY_EVENTS} group="family" expanded={expanded} setExpanded={setExpanded} />
        </>
      )}
    </div>
  );
}

// A family collection: its page here, its chain, standard and supply as the
// registry read them, and where it trades.
function FamilyEntry({ collection }) {
  const supply = supplyLabel(collection);
  const trades = canTradeOnVenue(collection) ? "Trades here" : `Trades on ${collection.market?.name}`;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <Link
          to={`/nakamigos/${collection.slug}`}
          style={{ fontFamily: "var(--display)", fontSize: 12, fontWeight: 600, color: "var(--text)", textDecoration: "underline", textUnderlineOffset: 3, overflowWrap: "anywhere" }}
        >
          {collection.name}
        </Link>
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", lineHeight: 1.6, marginTop: 2 }}>
        {[chainLabel(collection), standardLabel(collection), supply, trades].filter(Boolean).join(" \u00b7 ")}
      </div>
    </div>
  );
}

// ═══ SECTION: ECOSYSTEM MAP ═══
function EcosystemMap() {
  return (
    <div style={{ marginTop: 40 }}>
      <h3 style={sectionHeadingStyle}>{"\u{1F30D}"} ECOSYSTEM MAP</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
        {ECOSYSTEM_CHAINS.map(({ chain, color, bg, items }) => (
          <div key={chain} style={{
            ...cardBase,
            border: chain === "Ethereum" ? "1px solid rgba(200,168,80,0.2)" : cardBase.border,
          }}>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 9, padding: "3px 8px",
              borderRadius: 4, background: bg, color, display: "inline-block",
              letterSpacing: "0.06em", marginBottom: 12,
            }}>
              {chain.toUpperCase()}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {items.map(item => item.collection ? (
                <FamilyEntry key={item.name} collection={item.collection} />
              ) : (
                <div key={item.name}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontFamily: "var(--display)", fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                      {item.name}
                    </div>
                    {item.supply != null && (
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>
                        {item.supply.toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: "var(--display)", fontSize: 10, color: "var(--text-dim)", lineHeight: 1.6, marginTop: 2 }}>
                    {item.description}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══ MAIN EXPORT ═══
export default function JungleBayShowcase({ onNavigateGallery, onFilterGallery }) {
  // "Find in Gallery" for legendaries: navigate to gallery tab with search
  const handleFindLegendary = (name) => {
    if (onNavigateGallery) onNavigateGallery(name);
  };

  // "View in Gallery" for traits: navigate with trait filter
  const handleViewTrait = (category, trait) => {
    if (onFilterGallery) onFilterGallery(category, trait);
  };

  return (
    <div className="junglebay-showcase">
      <LegendaryGallery onFindInGallery={handleFindLegendary} />
      <RarestTraitsTable onViewInGallery={handleViewTrait} />
      <SkinTierPyramid />
      <RugToRichesTimeline />
      <EcosystemMap />
    </div>
  );
}
