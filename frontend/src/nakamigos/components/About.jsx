import { useActiveCollection } from "../contexts/CollectionContext";
import {
  CONTRACT, COLLECTIONS, COLLECTION_LORE, CHARACTER_TYPES,
  GNSS_SPECIES, JB_LEGENDARIES, TRAIT_LORE, FUN_FACTS,
} from "../constants";
import SpeciesEncyclopedia from "./SpeciesEncyclopedia";
import JungleBayShowcase from "./JungleBayShowcase";

function formatVol(n) {
  if (n == null) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatNumber(n) {
  if (n == null) return null;
  return Number(n).toLocaleString();
}

const GNSS_CONTRACT = COLLECTIONS.gnssart.contract;
const JUNGLEBAY_CONTRACT = COLLECTIONS.junglebay.contract;

// ═══ LINKS ═══
const NAKAMIGOS_EXTRA_LINKS = [
  ["nakamigos.io", "https://nakamigos.io"],
  ["@Nakamigos", "https://x.com/Nakamigos"],
  ["HiFo Labs", "https://www.hifolabs.com"],
  ["Discord", "https://discord.gg/nakamigos"],
  ["Blur", "https://blur.io/eth/collection/nakamigos"],
];

const GNSS_EXTRA_LINKS = [
  ["MGXS on X", "https://x.com/mgxs_co"],
  ["@mgxs_gnss", "https://x.com/mgxs_gnss"],
  ["MGXS Website", "https://mgxs.co"],
  ["Tree of MEM", "https://tree.mgxs.co"],
  ["SuperRare", "https://superrare.com/mgxs"],
];

const JUNGLEBAY_EXTRA_LINKS = [
  ["@JungleBayAC", "https://x.com/JungleBayAC"],
  ["Jungle Bay Island", "https://junglebayisland.com"],
  ["DAO Governance", "https://collective.xyz/junglebayapeclub"],
  ["Discord", "https://discord.gg/junglebay"],
];

// ═══ SECTION HEADING ═══
function SectionHeading({ children }) {
  return (
    <h3 style={{
      fontFamily: "var(--pixel)", fontSize: 11, color: "var(--naka-blue)",
      letterSpacing: "0.06em", marginBottom: 24,
    }}>
      {children}
    </h3>
  );
}

export default function About({ stats, onNavigateGallery, onFilterGallery }) {
  const collection = useActiveCollection();
  const slug = collection.slug;
  const isNakamigos = collection.contract.toLowerCase() === CONTRACT.toLowerCase();
  const isGnssArt = collection.contract.toLowerCase() === GNSS_CONTRACT.toLowerCase();
  const isJungleBay = collection.contract.toLowerCase() === JUNGLEBAY_CONTRACT.toLowerCase();
  const lore = COLLECTION_LORE[slug];
  const facts = FUN_FACTS[slug];

  const displaySupply = stats?.supply ?? collection.supply ?? null;
  const statCards = [
    { label: "Floor Price", value: stats?.floor != null ? Number(stats.floor).toFixed(4) : null, suffix: " ETH", color: "var(--gold)" },
    { label: "Total Volume", value: stats?.volume != null ? formatVol(stats.volume) : null, suffix: " ETH", color: "var(--naka-blue)" },
    { label: "Owners", value: stats?.owners != null ? formatNumber(stats.owners) : null, suffix: "", color: "var(--green)" },
    { label: "Supply", value: displaySupply != null ? formatNumber(displaySupply) : null, suffix: "", color: "var(--purple)" },
  ];

  const contractMeta = [
    ["Contract", `${collection.contract.slice(0, 6)}...${collection.contract.slice(-4)}`],
    ["Standard", collection.tags?.find(t => t.startsWith("ERC-")) || "ERC-721"],
    ["Chain", "Ethereum"],
  ];
  if (lore?.creator?.name) contractMeta.push(["Creator", lore.creator.name]);
  contractMeta.push(["Supply", formatNumber(displaySupply ?? collection.supply)]);
  if (lore?.creator?.artist && lore.creator.artist !== lore.creator.name) {
    contractMeta.push(["Artist", lore.creator.artist]);
  }

  const links = [
    ["OpenSea", `https://opensea.io/collection/${collection.openseaSlug || collection.slug}`],
    ["Etherscan", `https://etherscan.io/address/${collection.contract}`],
  ];
  if (isGnssArt) links.unshift(...GNSS_EXTRA_LINKS);
  if (isNakamigos) links.unshift(...NAKAMIGOS_EXTRA_LINKS);
  if (isJungleBay) links.unshift(...JUNGLEBAY_EXTRA_LINKS);
  const seenLabels = new Set();
  const dedupedLinks = links.filter(([label]) => {
    if (seenLabels.has(label)) return false;
    seenLabels.add(label);
    return true;
  }).filter(([, url]) => url);

  return (
    <section className="about-section">
      {/* Hero */}
      <div className="about-hero">
        <div className="pixel-badge" style={{ marginBottom: 16 }}>ABOUT</div>

        {!isNakamigos && collection.image && (
          <div style={{
            width: 80, height: 80, borderRadius: 16, overflow: "hidden",
            marginBottom: 20, border: "2px solid rgba(200,168,80,0.15)",
            background: "var(--bg)",
          }}>
            <img src={collection.image} alt={collection.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
        )}

        <h2 style={{
          fontFamily: "var(--pixel)", fontSize: 18, color: "var(--naka-blue)",
          marginBottom: 8, letterSpacing: "0.04em",
        }}>
          {collection.name.toUpperCase()}
        </h2>

        {lore?.tagline && (
          <div style={{
            fontFamily: "var(--display)", fontSize: 13, color: "var(--gold)",
            fontStyle: "italic", marginBottom: 16, opacity: 0.85,
          }}>
            {lore.tagline}
          </div>
        )}

        <div style={{
          width: 60, height: 3,
          background: "linear-gradient(90deg, var(--naka-blue), transparent)",
          marginBottom: 28, borderRadius: 2,
        }} />

        {/* Origin Story */}
        <div style={{
          fontFamily: "var(--display)", fontSize: 15, color: "var(--text-dim)",
          lineHeight: 1.9, display: "flex", flexDirection: "column", gap: 20, maxWidth: 700,
        }}>
          {isNakamigos && (
            <>
              <p>On October 31, 2022 -- the anniversary of Satoshi Nakamoto's Bitcoin whitepaper -- HiFo Labs deployed a smart contract to Ethereum. Five months later, the first Nakamigos were claimed for free by holders of the End of Sartoshi pass. Within four days, Nakamigos surpassed Bored Ape Yacht Club in lifetime trades -- 52,000 sales totaling 7,562 ETH ($13M).</p>
              <p>The artist is Michael Mills (@MillsxArt), one of the first 20 artists on SuperRare. The smart contract was built by WestCoastNFT, the same developer behind Doodles and mfers. When pressed about their origins, HiFo Labs offered only: "Not Larva. Not Yuga. Nakamigos."</p>
              <p>The 24x24 pixel art style is a deliberate tribute to CryptoPunks. Every Nakamigo sits against a uniform cornflower blue (#7AA4FA) background, and the coffee-themed skin tones -- Latte, Boba, Mocha, Pumpkin Spice, Coffee -- give the collection a playful warmth beneath its punk aesthetic. Holders receive full commercial rights, the same model Yuga Labs established for CryptoPunks.</p>
            </>
          )}
          {isGnssArt && (
            <>
              <p>GNSS -- Generative Nature Synthetic Species -- is the vision of Fernando Magalhaes, a Brazilian-born, Lisbon-based digital artist who works under the name MGXS. In a distant future, humanity has failed to save Earth. What remains is the capacity to generate new life from nothing -- beings conjured from mathematics, sculpted by algorithms in SideFX Houdini.</p>
              <p>MGXS generated 20,000 beings, then spent six months manually curating them down to 13,333, eliminating three entire species (J, L, T) that failed his standards. Holders chose their favorite from up to 10 options each, yielding a final population of ~9,697. This inverse rarity dynamic means more-chosen species became less rare.</p>
              <p>Seeds sold out in five minutes at 0.33 ETH on March 11, 2022. The reveal window ran for over two months, during which the Discord maintained 24/7 voice chat. MGXS also created the first physical Nike sneaker for RTFKT -- a 1-of-1 Air Force 1 that changed design with each bid, selling for 22 ETH.</p>
            </>
          )}
          {isJungleBay && (
            <>
              <p>Jungle Bay is the greatest comeback story in NFT history. In November 2021, Lil Baby Ape Club (LBAC) was rug-pulled -- a copycat stole the art via identical IPFS hashes, sold 5,000 tokens, and walked away with ~100 ETH. A 25-year-old Canadian named Roh (0xRoh) exposed the fraud through forensic blockchain analysis.</p>
              <p>On the same day the scandal broke, @JungleBayAC was created. The community refused to scatter -- they formed a DAO, funded a treasury from their own pockets, commissioned new hand-drawn art, and launched 5,555 apes in just 7-8 weeks. Original LBAC holders received free 1:1 exchange tokens. They call themselves "the OG Lord of the Flies web3 origin story."</p>
              <p>The community rebranded to Jungle Bay Artists Collective, embracing "memetic finance" (DM+T = Dank Memes + Time). With only 0.98% of supply listed and 20 legendary 1/1 hand-drawn apes, this is one of the tightest-held collections on Ethereum.</p>
            </>
          )}
          {!isNakamigos && !isGnssArt && !isJungleBay && <p>{collection.description}</p>}

          {collection.tags?.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {collection.tags.map(tag => (
                <span key={tag} style={{
                  fontFamily: "var(--mono)", fontSize: 10, padding: "4px 10px",
                  borderRadius: 6, background: "rgba(200,168,80,0.08)",
                  border: "1px solid rgba(200,168,80,0.15)", color: "var(--gold)",
                  letterSpacing: "0.04em",
                }}>
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Live Stats */}
      {statCards.length > 0 && (
        <div style={{
          marginTop: 36,
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(statCards.length, 4)}, 1fr)`,
          gap: 12,
        }}>
          {statCards.map(({ label, value, suffix, color }) => (
            <div key={label} className="about-stat-card">
              <div style={{
                fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)",
                letterSpacing: "0.08em", marginBottom: 6,
              }}>
                {label.toUpperCase()}
              </div>
              <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 600, color: value != null ? color : "var(--text-muted)" }}>
                {value != null ? `${value}${suffix}` : "\u2014"}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ═══ NAKAMIGOS: Character Types ═══ */}
      {isNakamigos && (
        <div style={{ marginTop: 40 }}>
          <SectionHeading>CHARACTER TYPES (12)</SectionHeading>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
            {CHARACTER_TYPES.map(({ name, count, percentage, description, isHuman }) => {
              const isUltra = count <= 36;
              const isRare = count <= 868 && !isUltra;
              const tierColor = isUltra ? "var(--gold)" : isRare ? "var(--naka-blue)" : "var(--text-dim)";
              return (
                <div key={name} style={{
                  background: isUltra
                    ? "linear-gradient(135deg, rgba(200,168,80,0.12), rgba(200,168,80,0.04))"
                    : "var(--surface)",
                  border: isUltra ? "1px solid rgba(200,168,80,0.25)" : "1px solid rgba(255,255,255,0.04)",
                  borderRadius: 10, padding: "16px 14px",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <div style={{ fontFamily: "var(--display)", fontSize: 13, fontWeight: 600, color: tierColor }}>
                      {name}
                    </div>
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 8, padding: "2px 6px",
                      borderRadius: 4, background: isHuman ? "rgba(100,160,255,0.1)" : "rgba(74,222,128,0.1)",
                      color: isHuman ? "var(--naka-blue)" : "var(--green)",
                    }}>
                      {isHuman ? "HUMAN" : "NON-HUMAN"}
                    </span>
                  </div>
                  <div style={{ fontFamily: "var(--display)", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginBottom: 6 }}>
                    {description}
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: tierColor, letterSpacing: "0.04em" }}>
                    {count.toLocaleString()} ({percentage}%)
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ GNSS: Species Encyclopedia ═══ */}
      {isGnssArt && <SpeciesEncyclopedia />}

      {/* ═══ JUNGLE BAY: Full Showcase ═══ */}
      {isJungleBay && (
        <JungleBayShowcase
          onNavigateGallery={onNavigateGallery}
          onFilterGallery={onFilterGallery}
        />
      )}

      {/* ═══ ECOSYSTEM ═══ */}
      {!isJungleBay && lore?.ecosystem?.length > 0 && (
        <div style={{ marginTop: 36 }}>
          <SectionHeading>ECOSYSTEM</SectionHeading>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
            {lore.ecosystem.map(({ name, supply, chain, description }) => (
              <div key={name} style={{
                background: "var(--surface)", padding: "18px 16px", borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.04)",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontFamily: "var(--display)", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                    {name}
                  </div>
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 8, padding: "2px 6px",
                    borderRadius: 4, background: chain === "Bitcoin" ? "rgba(247,147,26,0.1)" : chain === "Solana" ? "rgba(153,69,255,0.1)" : chain === "Base" ? "rgba(0,82,255,0.1)" : "rgba(100,160,255,0.1)",
                    color: chain === "Bitcoin" ? "#f7931a" : chain === "Solana" ? "#9945ff" : chain === "Base" ? "#0052ff" : "var(--naka-blue)",
                  }}>
                    {chain}
                  </span>
                </div>
                <div style={{ fontFamily: "var(--display)", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                  {description}
                </div>
                {supply && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 6, letterSpacing: "0.04em" }}>
                    {supply.toLocaleString()} items
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ FUN FACTS ═══ */}
      {facts?.length > 0 && (
        <div style={{ marginTop: 36 }}>
          <SectionHeading>DID YOU KNOW?</SectionHeading>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>
            {facts.slice(0, 8).map((fact, i) => (
              <div key={i} style={{
                background: "var(--surface)", padding: "14px 16px", borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.04)",
                fontFamily: "var(--display)", fontSize: 12, color: "var(--text-dim)", lineHeight: 1.7,
              }}>
                {fact}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Contract Info */}
      <div className="about-meta-grid">
        {contractMeta.map(([k, v]) => (
          <div key={k} style={{ background: "var(--surface)", padding: "20px 22px" }}>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)",
              letterSpacing: "0.1em", marginBottom: 6,
            }}>
              {k.toUpperCase()}
            </div>
            <div style={{
              fontFamily: "var(--display)", fontSize: 14, color: "var(--text-dim)", fontWeight: 500,
            }}>
              {v}
            </div>
          </div>
        ))}
      </div>

      {/* Links */}
      <div className="about-links">
        {dedupedLinks.map(([label, url]) => (
          <a key={label} href={url} target="_blank" rel="noopener noreferrer" className="about-link">
            {label} {"\u2197"}
          </a>
        ))}
      </div>

      {/* Keyboard shortcuts */}
      <div className="about-shortcuts">
        <SectionHeading>KEYBOARD SHORTCUTS</SectionHeading>
        <div className="shortcuts-grid">
          {[
            ["1-7", "Switch tabs"],
            ["Esc", "Close modal"],
            ["S", "Focus search"],
            ["/", "Focus search"],
            ["G", "Go to Gallery"],
            ["F", "Go to Floor"],
            ["T", "Go to Traits"],
          ].map(([key, desc]) => (
            <div key={key} className="shortcut-item">
              <kbd className="shortcut-key">{key}</kbd>
              <span className="shortcut-desc">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
