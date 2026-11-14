import { useRef, useState, useCallback, useEffect, useMemo, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import NftImage from "./NftImage";
import { Eth } from "./Icons";
import { formatPrice, formatListingPrice } from "../lib/formatPrice";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useTradingMode } from "../contexts/TradingModeContext";

const MIN_COL_GALLERY = 240;
const MIN_COL_COMPACT = 180;
// A card is its picture, drawn square, over a footer of fixed height, so a
// row is as tall as its column is wide plus that footer, and no picture is cropped.
const FOOTER_GALLERY = 62;
const FOOTER_COMPACT = 56;
const GAP = 12;
const OVERSCAN = 5;
const LOAD_MORE_THRESHOLD = 5; // rows from bottom

// Coarse pointer (touch) devices have no hover — the add-to-cart button must be
// always visible there, otherwise it's unreachable on phones/tablets (F588).
const coarsePointer =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(hover: none)").matches;

// `mounted` flips true once the real scroll container (the only node carrying
// ref={parentRef}) is rendered. The first paint is the skeleton/empty branch,
// which has no parentRef — so the observer must (re)attach when the container
// finally appears, otherwise columns stay frozen at the default 4 (F563).
function useColumns(containerRef, viewMode, mounted) {
  const [layout, setLayout] = useState({ columns: 4, colWidth: MIN_COL_GALLERY });

  const recalc = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const width = el.clientWidth;
    const minCol = viewMode === "compact" ? MIN_COL_COMPACT : MIN_COL_GALLERY;
    const cols = Math.max(1, Math.floor((width + GAP) / (minCol + GAP)));
    const colWidth = Math.max(1, Math.floor((width - GAP * (cols - 1)) / cols));
    setLayout((prev) => (prev.columns === cols && prev.colWidth === colWidth ? prev : { columns: cols, colWidth }));
  }, [containerRef, viewMode]);

  useEffect(() => {
    recalc();
    if (!containerRef.current) return;
    const ro = new ResizeObserver(recalc);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [recalc, containerRef, mounted]);

  return layout;
}

function SkeletonGrid({ columns, rowHeight }) {
  const count = columns * 3;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: GAP,
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="skeleton-card card-reveal"
          style={{
            animationDelay: `${i * 50}ms`,
            height: rowHeight,
          }}
        >
          <div className="skeleton skeleton-image" style={{ height: "70%" }} />
          <div className="skeleton-info" style={{ padding: 12 }}>
            <div className="skeleton skeleton-line" style={{ width: "75%" }} />
            <div className="skeleton skeleton-line short" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default memo(function VirtualGalleryGrid({
  tokens,
  loading,
  onPick,
  viewMode = "gallery",
  favorites = [],
  onToggleFavorite,
  hasMore,
  onLoadMore,
  cart = [],
  onAddToCart,
  resetKey,
}) {
  const parentRef = useRef(null);
  const prevKeyRef = useRef("");
  const loadMoreCalledRef = useRef(false);
  // The scroll container (ref={parentRef}) only mounts once tokens exist; pass
  // that so useColumns re-attaches its ResizeObserver when the node appears.
  const containerMounted = tokens.length > 0;
  const { columns, colWidth } = useColumns(parentRef, viewMode, containerMounted);
  const collection = useActiveCollection();
  const { isLite } = useTradingMode();

  const isGallery = viewMode === "gallery";
  const rowHeight = colWidth + (isGallery ? FOOTER_GALLERY : FOOTER_COMPACT);

  const favSet = useMemo(() => new Set(favorites), [favorites]);
  const cartSet = useMemo(
    () => new Set(cart.map((c) => c.id ?? c.tokenId ?? c)),
    [cart]
  );

  const rowCount = columns > 0 ? Math.ceil(tokens.length / columns) : 0;

  // Reset scroll to top only on a genuine filter/sort/search change (resetKey),
  // NOT on a loadMore append — appending pages used to change the old
  // tokens.length-based key and yank the viewport to the top every page (F562).
  // Fall back to the token signature when no resetKey is provided.
  const scrollKey = resetKey ?? (tokens.length + "-" + (tokens[0]?.id ?? ""));
  useEffect(() => {
    if (prevKeyRef.current && prevKeyRef.current !== scrollKey) {
      if (parentRef.current) parentRef.current.scrollTop = 0;
    }
    prevKeyRef.current = scrollKey;
  }, [scrollKey]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight + GAP,
    overscan: OVERSCAN,
  });

  // Row sizes are cached; a new width means a new height for every row.
  useEffect(() => { virtualizer.measure?.(); }, [rowHeight, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();

  // Reset load-more guard when new data arrives (rowCount changes) or loading finishes
  useEffect(() => {
    loadMoreCalledRef.current = false;
  }, [rowCount, loading]);

  // Infinite scroll — trigger onLoadMore near the bottom (with guard to prevent repeated calls)
  useEffect(() => {
    if (!hasMore || !onLoadMore || rowCount === 0) return;
    if (loadMoreCalledRef.current) return;
    const lastRow = virtualRows[virtualRows.length - 1];
    if (!lastRow) return;
    if (lastRow.index >= rowCount - LOAD_MORE_THRESHOLD) {
      loadMoreCalledRef.current = true;
      onLoadMore();
    }
  }, [virtualRows, rowCount, hasMore, onLoadMore]);

  if (loading && tokens.length === 0) {
    return (
      <div
        style={{
          height: "calc(100vh - 200px)",
          overflowY: "auto",
        }}
      >
        <SkeletonGrid columns={columns} rowHeight={rowHeight} />
      </div>
    );
  }

  if (!tokens.length) {
    return (
      <div
        style={{
          height: "calc(100vh - 200px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
          fontSize: 15,
        }}
      >
        No items found
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      style={{
        height: "calc(100vh - 200px)",
        overflowY: "auto",
        contain: "strict",
      }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualRows.map((virtualRow) => {
          const rowIndex = virtualRow.index;
          const startIdx = rowIndex * columns;
          const rowTokens = tokens.slice(startIdx, startIdx + columns);

          return (
            <div
              key={virtualRow.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: virtualRow.size - GAP,
                transform: `translateY(${virtualRow.start}px)`,
                display: "grid",
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
                gap: GAP,
              }}
            >
              {rowTokens.map((nft) => (
                <VirtualCard
                  key={nft.id}
                  nft={nft}
                  isGallery={isGallery}
                  isFavorite={favSet.has(nft.id)}
                  inCart={cartSet.has(nft.id)}
                  onPick={onPick}
                  onToggleFavorite={onToggleFavorite}
                  onAddToCart={onAddToCart}
                  collectionSupply={collection?.supply}
                  isLiteMode={isLite}
                />
              ))}
            </div>
          );
        })}
      </div>

      {/* Loading-more indicator while the next page streams in (F589) */}
      {loading && tokens.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            padding: "16px 0 24px",
            fontFamily: "var(--mono)",
            fontSize: 13,
            color: "var(--text-muted)",
          }}
        >
          <div className="spinner" style={{ width: 16, height: 16 }} />
          Loading more{"…"}
        </div>
      )}
    </div>
  );
})

const VirtualCard = memo(function VirtualCard({
  nft,
  isGallery,
  isFavorite,
  inCart,
  onPick,
  onToggleFavorite,
  onAddToCart,
  collectionSupply,
  isLiteMode,
}) {
  const [hovered, setHovered] = useState(false);

  const handleClick = useCallback(() => onPick?.(nft), [onPick, nft]);
  const handleKeyDown = useCallback((e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick?.(nft); }
  }, [onPick, nft]);

  const handleFav = useCallback(
    (e) => {
      e.stopPropagation();
      onToggleFavorite?.(nft.id);
    },
    [onToggleFavorite, nft.id]
  );

  const handleAddToCart = useCallback(
    (e) => {
      e.stopPropagation();
      onAddToCart?.(nft);
    },
    [onAddToCart, nft]
  );

  return (
    <div
      className={`nft-card ${isGallery ? "gallery" : "compact"}`}
      data-token-id={nft.id}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`${nft.name || `#${nft.id}`}${nft.rank ? `, rank ${nft.rank}` : ""}${nft.price != null ? `, ${formatListingPrice(nft)} ETH` : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Picture: takes the room the footer leaves, which the grid sizes square */}
      <div className="card-image-wrap" style={{ flex: "1 1 auto", minHeight: 0, aspectRatio: "auto" }}>
        <NftImage
          nft={nft}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />

        {/* Rank — relative to collection supply; hidden in Lite mode and when approximate (partial data) */}
        {!isLiteMode && nft.rank && !nft.rankApproximate && (
          <div
            className={`card-rank-badge${collectionSupply && nft.rank <= collectionSupply * 0.25 ? " card-rank-top" : ""}`}
            title={`Rank ${nft.rank}${collectionSupply ? ` of ${collectionSupply.toLocaleString()}` : ""}`}
          >
            #{nft.rank}
            {collectionSupply != null && (
              <span className="card-rank-supply">/{collectionSupply.toLocaleString()}</span>
            )}
          </div>
        )}

        {/* Favorite */}
        {onToggleFavorite && (
          <button
            className={`card-fav-btn ${isFavorite ? "active" : ""}`}
            onClick={handleFav}
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={isFavorite}
          >
            {isFavorite ? "♥" : "♡"}
          </button>
        )}

        {/* Add to cart — on hover (desktop) or always on touch (F588), and only
            on a card with a live listing: an unpriced token has no order to buy. */}
        {onAddToCart && !inCart && nft.price != null && (hovered || coarsePointer) && (
          <button className="mk-card-action" onClick={handleAddToCart} aria-label="Add to cart" title="Add to cart">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M16 10a4 4 0 01-8 0" />
            </svg>
          </button>
        )}

        {/* In-cart indicator */}
        {inCart && <div className="mk-card-action done">IN CART</div>}
      </div>

      <div className="card-footer">
        <div className="card-info">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="card-name">{nft.name}</div>
            <div className="card-trait">
              {nft.attributes?.[0]
                ? `${nft.attributes[0].key}: ${nft.attributes[0].value}`
                : `Token #${nft.id}`}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            {nft.price != null ? (
              <>
                <div className="card-price">
                  <Eth />
                  {formatListingPrice(nft)}
                </div>
                {nft.lastSale != null && (
                  <div className="card-last">Last: {formatPrice(nft.lastSale)}</div>
                )}
              </>
            ) : (
              <div className="card-id">#{nft.id}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
