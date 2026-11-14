import { useMemo } from "react";
import NftImage from "./NftImage";
import { useActiveCollection } from "../contexts/CollectionContext";
import { COLLECTION_LORE } from "../constants";
import { descriptionSourceTag } from "../lib/venue";
import Usd from "./Usd";
import { FinePrint } from "../../components/ui/FinePrint";

// The opening's picture: five of the collection's own pieces on one sheet, the
// first one large. Each opens its piece. Nothing rotates and nothing is
// downloaded beyond the pieces themselves.
function HeroMosaic({ tokens, onPick }) {
  const featured = useMemo(
    () => tokens.filter((n) => n.image && n.id != null).slice(0, 5),
    [tokens]
  );
  if (featured.length < 5) return null;

  return (
    <div className="mk-mosaic">
      {featured.map((n, idx) => (
        <button key={n.id} className="mk-mosaic-cell" onClick={() => onPick(n)} aria-label={`Open ${n.name}`}>
          <NftImage nft={n} large={idx === 0} priority={idx === 0} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          {idx === 0 && (
            <span className="mk-mosaic-cap">
              <span>{n.name}</span>
              {n.rank && !n.rankApproximate && <b>Rank #{n.rank}</b>}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function formatVolume(n) {
  if (n == null) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

function StatSkeleton({ label }) {
  return (
    <div className="stat-card">
      <div className="stat-skeleton-bar" style={{ width: 64, height: 18 }} />
      <div className="stat-label">{label}</div>
    </div>
  );
}

// Small "cached" marker shown on stat cards when the numbers are the hardcoded
// fallback rather than a live fetch (F582) — honest disclosure, no number change.
function CachedTag() {
  return (
    <span className="mk-tag-cached" style={{ marginLeft: 6 }} title="Cached estimate — live stats unavailable right now">
      cached
    </span>
  );
}

export default function Hero({ stats, tokens, onPick }) {
  const collection = useActiveCollection();
  // Use config supply as the ultimate fallback for display
  const supply = stats.supply ?? collection.supply ?? null;
  const isLoading = stats.floor == null && stats.owners == null && stats.volume == null;
  const isFallback = !!stats.fallback;
  const tagline = COLLECTION_LORE[collection.slug]?.tagline;

  return (
    <section className="hero mk-plane">
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
          {/* One line under the heading: the tagline. The description is the
              collection's own words and sits in the small print (owner
              2026-10-14: fewer words; explanations go in closed drop-downs). */}
          {tagline && <div className="hero-tagline">{tagline}</div>}
          {collection.description && (
            <FinePrint summary="About">
              <p className="hero-desc">
                {collection.description}
                {descriptionSourceTag(collection) && (
                  <span style={{ color: "var(--text-muted)" }}> ({descriptionSourceTag(collection)})</span>
                )}
              </p>
            </FinePrint>
          )}

          {/* The collection's numbers, on one ruled strip */}
          <div className="stats-row">
            {/* Supply -- usually from config; shimmer (not a bare em-dash) while
                the value is still resolving so it doesn't read as "no data". F620 */}
            {supply != null ? (
              <div className="stat-card">
                <div className="stat-value">
                  {supply.toLocaleString()}
                </div>
                <div className="stat-label">SUPPLY</div>
              </div>
            ) : (
              <StatSkeleton label="SUPPLY" />
            )}

            {/* Floor price: the one figure in the accent, because it is the price */}
            {stats.floor != null ? (
              <div className="stat-card">
                <div className="stat-value mk-money">
                  {Number(stats.floor).toFixed(4)}
                  <span className="stat-suffix"> ETH</span>
                </div>
                <Usd eth={Number(stats.floor)} size={12} style={{ display: "block", marginTop: 4, fontFamily: "var(--num)" }} />
                <div className="stat-label">FLOOR{isFallback && <CachedTag />}</div>
              </div>
            ) : isLoading ? (
              <StatSkeleton label="FLOOR" />
            ) : null}

            {/* Volume */}
            {stats.volume != null && (
              <div className="stat-card">
                <div className="stat-value">
                  {formatVolume(stats.volume)}
                  <span className="stat-suffix"> ETH</span>
                </div>
                {/* Volume alone can be the cached constant while floor/owners
                    are live, so it carries its own tag. */}
                <div className="stat-label">ALL-TIME VOL{(isFallback || stats.volumeFallback) && <CachedTag />}</div>
              </div>
            )}

            {/* Owners */}
            {stats.owners != null ? (
              <div className="stat-card">
                <div className="stat-value">
                  {stats.owners.toLocaleString()}
                </div>
                <div className="stat-label">OWNERS{isFallback && <CachedTag />}</div>
              </div>
            ) : isLoading ? (
              <StatSkeleton label="OWNERS" />
            ) : null}

            {/* Total sales (if available) */}
            {stats.totalSales != null && (
              <div className="stat-card">
                <div className="stat-value">
                  {formatVolume(stats.totalSales)}
                </div>
                <div className="stat-label">TOTAL SALES</div>
              </div>
            )}
          </div>

          {/* Collection highlights */}
          <div className="hero-highlights">
            <div className="hero-highlight-tag">
              <i style={{ background: "var(--green)" }} aria-hidden="true" />
              <span>Live on Ethereum</span>
            </div>
            {(collection.highlights || []).map((h, i) => (
              <div key={i} className="hero-highlight-tag">
                <i style={{ background: h.color || "var(--accent)" }} aria-hidden="true" />
                <span>{h.label}</span>
              </div>
            ))}
          </div>
        </div>
        <HeroMosaic tokens={tokens} onPick={onPick} />
      </div>
      <div className="hero-divider" />
    </section>
  );
}
