import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { COLLECTIONS, COLLECTION_LORE, DEFAULT_COLLECTION } from "../constants";
import { fetchCollectionStats, fetchTokens } from "../api";
import { formatPrice } from "../lib/formatPrice";
import { IpfsImg } from "../../components/IpfsImg";
import { formatMarketAmount } from "../lib/marketAmount";
import { canTradeOnVenue, VENUE_COLLECTIONS, chainLabel, descriptionSourceTag, supplyLabel } from "../lib/venue";
import { fetchExternalStats } from "../lib/externalMarket";
import { FinePrint } from "../../components/ui/FinePrint";

const COLLECTION_LIST = Object.values(COLLECTIONS);

// What a visitor came to press, on the first screen (owner 2026-10-14). Each
// opens the flagship collection's tab where that action lives: Floor lists
// what is for sale and hosts the offer panels; My NFTs is where a holder lists.
const START_ACTIONS = [
  ["Browse", "gallery", "btn-primary"],
  ["Buy", "listings", "btn-primary"],
  ["Sell / List", "collection", "btn-secondary"],
  ["Make offer", "listings", "btn-secondary"],
];

// The chains the registry spans, in registry order ("Ethereum · Base · Solana").
const CHAIN_LIST = [...new Set(COLLECTION_LIST.map(chainLabel).filter(Boolean))];

/* ─── Single stat cell: a small label over a figure ─── */
function Stat({ label, value, loading, shimmerWidth = "60%", cached, wrap = false, note = null }) {
  return (
    <div className="mk-stat">
      <div className="mk-stat-label">
        {label}
        {/* Marks a tile whose number is a stored constant rather than a
            measurement, so it is never read as this minute's figure. */}
        {cached && (
          <span className="mk-tag-cached" title="Cached estimate — live stats unavailable right now">cached</span>
        )}
      </div>
      {loading
        ? <div className="skeleton" style={{ height: 14, width: shimmerWidth, marginTop: 8 }} />
        : <div className={`mk-stat-value${wrap ? " wrap" : ""}`}>{value}</div>}
      {!loading && note && <div className="mk-stat-note">{note}</div>}
    </div>
  );
}

/* ─── Highlight chips (Commercial Rights, Generative Art, …): the colour is the
       collection's own, so it rides on a dot and the words stay readable ─── */
function HighlightBadge({ label, color }) {
  return (
    <span className="mk-chip">
      <i style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

/* ─── Where a view-only collection trades. A span, not a link: the card is
       itself a <button>, and a control nested in it would be invalid. ─── */
function MarketBadge({ market }) {
  return <span className="mk-chip market">Trades on {market}</span>;
}

/* ─── Cross-Collection Search ─── */
function CrossCollectionSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
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

    // Token ID search. The supply count is only a heuristic bound: ids can run
    // above supply (gnss token ids go past 9000 on a 9696 supply) and below it
    // can be burned (junglebay). Allow #0 and a generous upper bound, and flag
    // out-of-range hits as best-effort rather than excluding them (F578).
    // Only collections that trade here open a token page, so only they are
    // offered for a token id; a collection's known first id bounds it below.
    if (/^\d+$/.test(query)) {
      const id = parseInt(query, 10);
      for (const col of VENUE_COLLECTIONS) {
        const slug = col.slug;
        const first = Number.isFinite(col.tokenIds?.first) ? col.tokenIds.first : 0;
        const upper = Math.max(col.supply, Math.round(col.supply * 1.5));
        if (id >= first && id <= upper) {
          const tentative = id > first + col.supply - 1;
          out.push({ type: "token", slug, name: `${col.name} #${id}`, id, image: col.image, tentative });
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
    setActiveIndex(-1);
    navigate(`/nakamigos/${r.slug}/${r.type === "token" ? `nft/${r.id}` : "gallery"}`);
  };

  // Reset the keyboard highlight whenever the result set changes.
  useEffect(() => { setActiveIndex(-1); }, [query]);

  const showDropdown = focused && query.length >= 2 && results.length > 0;

  const handleKeyDown = (e) => {
    if (!showDropdown) {
      if (e.key === "Escape") { setFocused(false); }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < results.length) {
        e.preventDefault();
        handleSelect(results[activeIndex]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setFocused(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div ref={wrapperRef} className="mk-search">
      <div className={`mk-search-field${focused ? " focused" : ""}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search collections or token ID..."
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="landing-search-listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `landing-search-opt-${activeIndex}` : undefined}
          aria-label="Search collections or token ID"
        />
        {query && (
          <button className="mk-search-clear" onClick={() => { setQuery(""); }} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      {showDropdown && (
        <div id="landing-search-listbox" role="listbox" aria-label="Search results" className="mk-search-pop">
          {results.map((r, i) => (
            <button
              key={`${r.slug}-${r.type}-${r.id ?? i}`}
              id={`landing-search-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className="mk-search-opt"
              onClick={() => handleSelect(r)}
              onMouseMove={() => setActiveIndex(i)}
            >
              <IpfsImg src={r.image} alt="" onExhausted={(img) => { img.style.display = "none"; }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mk-search-opt-name">{r.name}</div>
                <div className="mk-search-opt-kind">
                  {r.type === "token" ? (r.tentative ? "Token · may not exist" : "Token") : "Collection"}
                </div>
              </div>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          ))}
        </div>
      )}

      {focused && query.length >= 2 && results.length === 0 && (
        <div className="mk-search-pop">
          <div className="mk-search-none">No results for "{query}"</div>
        </div>
      )}
    </div>
  );
}

/* ─── A view-only card's numbers, read from its home market ───
   Each in its own unit (ETH on Base), a floor read as none listed says so,
   and a figure the read does not produce is the unread dash. A collection
   with no market read (Junglets) says that, never a zero. */
function ViewOnlyStats({ collection, stats, loading, error }) {
  const dash = "—";
  const unread = !!error || !stats;
  const floorRead = unread ? null
    : stats.floor != null ? formatMarketAmount(stats.floor, stats.floorSymbol, collection)
      : stats.noneListed ? "None listed" : null;
  const unavailableLine = error === "no-market-read"
    ? `Stats unavailable: this venue reads no market for ${collection.name}`
    : `Stats unavailable: ${collection.market?.name} could not be read`;
  return (
    <>
      <div className="mk-stats">
        <Stat label="Floor" loading={loading} shimmerWidth="55%" wrap value={floorRead ?? dash}
          note={!unread && floorRead == null ? "not read" : null} />
        <Stat label="Volume" loading={loading} shimmerWidth="70%" wrap
          value={unread ? dash : (formatMarketAmount(stats.volume, "ETH", collection) ?? dash)} />
        <Stat label="Owners" loading={loading} shimmerWidth="50%" wrap
          value={unread || stats.owners == null ? dash : stats.owners.toLocaleString("en-US")} />
        <Stat label="Supply" loading={false} wrap value={supplyLabel(collection) ?? dash} />
      </div>
      {!loading && (
        <div className="mk-stats-source">
          {unread ? unavailableLine : `Stats from ${stats.source}`}
        </div>
      )}
    </>
  );
}

/* ─── Collection plate ─── */
function CollectionCard({ collection, stats, statsLoading, statsError, previewImage, onClick, index }) {
  const displayImage = collection.image || previewImage;
  // A collection that trades on its own market states its numbers in that
  // market's units and says where it trades.
  const viewOnly = !canTradeOnVenue(collection);
  // A view-only card's Supply stat carries its label, and the long ERC-1155
  // labels would crowd the strip, so only a venue card gets the count there.
  const venueSupply = stats?.supply ?? collection.supply;
  const supplyBadge = !viewOnly && venueSupply != null ? `${venueSupply.toLocaleString()} items` : null;
  const [imgError, setImgError] = useState(false);

  useEffect(() => { setImgError(false); }, [displayImage]);

  const formatStat = (val, suffix = "") => {
    if (val == null) return "—";
    if (typeof val === "number" && suffix === " ETH" && val < 1) return val.toFixed(4) + suffix;
    if (typeof val === "number" && suffix === " ETH") return val.toLocaleString(undefined, { maximumFractionDigits: 0 }) + suffix;
    if (typeof val === "number") return val.toLocaleString();
    return val;
  };

  const isLoading = statsLoading;
  // The error's reason ("no-market-read") or true; false once stats are read.
  const isError = !stats && statsError ? statsError : false;
  const dash = "—";

  // The card's own words (description, its source, the creator) live in the
  // small print under the card. A <details> cannot sit inside a <button>, so
  // the box is a div: the picture, name and numbers are the button, and the
  // small print follows it inside the same box.
  const lore = COLLECTION_LORE[collection.slug];
  const sourceTag = collection.description && descriptionSourceTag(collection);
  const hasSmallPrint = !!(collection.description || lore?.creator?.name);

  return (
    <div className="mk-coll">
      <button className="mk-coll-main" onClick={onClick}>
        {/* The plate's strip: its number in the index, and how many pieces. */}
        <div className="mk-coll-strip">
          <b aria-hidden="true">{String(index + 1).padStart(2, "0")}</b>
          {supplyBadge && <span>{supplyBadge}</span>}
        </div>

        <div className="mk-coll-media">
          {displayImage && !imgError ? (
            <IpfsImg
              src={displayImage}
              alt={collection.name}
              loading="lazy"
              style={{ imageRendering: collection.pixelated ? "pixelated" : "auto" }}
              onExhausted={() => setImgError(true)}
            />
          ) : (
            <div className="mk-coll-missing" aria-hidden="true">?</div>
          )}
        </div>

        <div className="mk-coll-body">
          {/* div (not h3): headings are not valid content inside a <button> */}
          <div role="heading" aria-level={3} className="mk-coll-name">
            {collection.name}
          </div>

          {/* Tagline: the card's one line of prose. */}
          {lore?.tagline && <div className="mk-coll-tagline">{lore.tagline}</div>}

          <div className="mk-chips">
            {collection.highlights?.map((h) => (
              <HighlightBadge key={h.label} label={h.label} color={h.color} />
            ))}
            {viewOnly && collection.market?.name && <MarketBadge market={collection.market.name} />}
            {collection.tags?.map((tag) => (
              <span key={tag} className="mk-chip">{tag}</span>
            ))}
          </div>

          {/* Pushes the numbers to the foot of the plate, so a row of plates lines up. */}
          <div className="mk-coll-grow" />

          {viewOnly ? (
            <ViewOnlyStats collection={collection} stats={stats} loading={isLoading} error={isError} />
          ) : (
            <div className="mk-stats">
              <Stat
                label="Floor"
                loading={isLoading}
                shimmerWidth="55%"
                value={isError ? dash : stats && stats.floor != null ? `${formatPrice(stats.floor)} ETH` : dash}
              />
              <Stat
                label="Volume"
                loading={isLoading}
                shimmerWidth="70%"
                cached={!isError && !!stats?.volumeFallback}
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
          )}
        </div>
      </button>

      {/* The small print: the collection's own words, their source, the creator. */}
      {hasSmallPrint && (
        <div className="mk-coll-fine">
          <FinePrint summary="About">
            {collection.description && <p>{collection.description}</p>}
            {/* A collection's own words name their source, so they never read as the venue's. */}
            {sourceTag && <p>{sourceTag.charAt(0).toUpperCase() + sourceTag.slice(1)}</p>}
            {lore?.creator?.name && <p>by {lore.creator.name}</p>}
          </FinePrint>
        </div>
      )}
    </div>
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
      // View-only collections read OpenSea; never the venue's Ethereum
      // readers, which would answer for the wrong chain or standard. The
      // error keeps its reason, so "no market read" is not called a failure.
      if (!canTradeOnVenue(col)) {
        return fetchExternalStats(col).then((s) => {
          if (cancelled) return;
          if (!s || s.unavailable) setStatsErrors((prev) => ({ ...prev, [col.slug]: s?.reason || true }));
          else setStatsMap((prev) => ({ ...prev, [col.slug]: s }));
        });
      }

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
    <div className="mk-landing">
      {/* ── The opening: the name, the one line, and what to press ── */}
      <div className="mk-masthead mk-plane">
        <div>
          <div className="mk-eyebrow">NFT marketplace</div>
          <h1 className="mk-display">TRADERMIGOS</h1>
          <p className="mk-lede">Browse. Buy. Sell. Make offers.</p>
        </div>

        {/* Start panel: what to press, then the numbers, then the money line.
            The explanations sit closed underneath. */}
        <section aria-label="Start here" className="mk-start">
          <div className="mk-start-actions">
            {START_ACTIONS.map(([label, tab, cls]) => (
              <button
                key={label}
                className={cls}
                onClick={() => navigate(`/nakamigos/${DEFAULT_COLLECTION}/${tab}`)}
              >
                {label}
                {/* Drawn, not typed: a typed arrow would count as a word on the page. */}
                <svg className="mk-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="13 6 19 12 13 18" />
                </svg>
              </button>
            ))}
          </div>

          <div className="mk-start-body">
            {/* The numbers: collection count, chains, how many trade here */}
            <div className="mk-facts">
              <span>{COLLECTION_LIST.length} Collection{COLLECTION_LIST.length !== 1 ? "s" : ""}</span>
              <i className="sep" aria-hidden="true" />
              <span>{CHAIN_LIST.join(" · ")}</span>
              <i className="sep" aria-hidden="true" />
              <span>{VENUE_COLLECTIONS.length} trade here</span>
            </div>

            {/* The money line stays visible: what the venue takes (flat 0.5% to the
                protocol treasury, on-chain Seaport settlement). The full sentence
                it used to be sits in the small print below, word for word. */}
            <div className="mk-fee">
              {`Flat 0.5% fee on the ${VENUE_COLLECTIONS.length} collections that trade here. It funds the treasury.`}
            </div>

            <FinePrint summary="Details">
              <p style={{ margin: 0 }}>
                {`Browse, Buy, Sell / List and Make offer open the ${COLLECTIONS[DEFAULT_COLLECTION].name} collection. For another collection, open its card below.`}
              </p>
              <p style={{ margin: 0 }}>
                {`Native listings: one flat 0.5% fee on the ${VENUE_COLLECTIONS.length} collections that trade here, every fee funds the treasury`}
              </p>
              <p style={{ margin: 0 }}>
                A collection that trades elsewhere shows that market's numbers here and opens there.
              </p>
            </FinePrint>
          </div>
        </section>
      </div>

      {/* ── Cross-collection search ── */}
      <CrossCollectionSearch />

      {/* ── The index of collections ── */}
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
    </div>
  );
}
