import { useRef, useState, useCallback, useEffect, useMemo, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "framer-motion";
import NftImage from "./NftImage";
import { Eth } from "./Icons";
import { formatPrice } from "../lib/formatPrice";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useTradingMode } from "../contexts/TradingModeContext";

const MIN_COL_GALLERY = 240;
const MIN_COL_COMPACT = 180;
const ROW_HEIGHT_GALLERY = 340;
const ROW_HEIGHT_COMPACT = 260;
const GAP = 12;
const OVERSCAN = 5;
const LOAD_MORE_THRESHOLD = 5; // rows from bottom

// Hoist framer-motion hover/tap configs outside component to avoid
// re-creating objects every render (defeats React.memo).
const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const CARD_HOVER = prefersReducedMotion
  ? {}
  : { scale: 1.02, y: -4, boxShadow: "0 8px 30px rgba(0,0,0,0.4)" };
const CARD_TAP = prefersReducedMotion ? {} : { scale: 0.98 };

function useColumns(containerRef, viewMode) {
  const [columns, setColumns] = useState(4);

  const recalc = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const width = el.clientWidth;
    const minCol = viewMode === "compact" ? MIN_COL_COMPACT : MIN_COL_GALLERY;
    const cols = Math.max(1, Math.floor((width + GAP) / (minCol + GAP)));
    setColumns(cols);
  }, [containerRef, viewMode]);

  useEffect(() => {
    recalc();
    const ro = new ResizeObserver(recalc);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [recalc, containerRef]);

  return columns;
}

function SkeletonGrid({ columns, rowHeight }) {
  const count = columns * 3;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: GAP,
        padding: "0 4px",
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="skeleton-card card-reveal"
          style={{
            animationDelay: `${i * 50}ms`,
            height: rowHeight,
            borderRadius: 12,
            overflow: "hidden",
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

export default function VirtualGalleryGrid({
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
}) {
  const parentRef = useRef(null);
  const prevKeyRef = useRef("");
  const loadMoreCalledRef = useRef(false);
  const columns = useColumns(parentRef, viewMode);
  const collection = useActiveCollection();
  const { isLite } = useTradingMode();

  const isGallery = viewMode === "gallery";
  const rowHeight = isGallery ? ROW_HEIGHT_GALLERY : ROW_HEIGHT_COMPACT;

  const favSet = useMemo(() => new Set(favorites), [favorites]);
  const cartSet = useMemo(
    () => new Set(cart.map((c) => c.id ?? c.tokenId ?? c)),
    [cart]
  );

  const rowCount = Math.ceil(tokens.length / columns);

  // Restore scroll position when tokens change (filter/sort)
  const tokensKey = tokens.length + "-" + (tokens[0]?.id ?? "");
  useEffect(() => {
    if (prevKeyRef.current && prevKeyRef.current !== tokensKey) {
      // tokens changed — restore to top
      if (parentRef.current) parentRef.current.scrollTop = 0;
    }
    prevKeyRef.current = tokensKey;
  }, [tokensKey]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight + GAP,
    overscan: OVERSCAN,
  });

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
          padding: "16px 8px",
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
          color: "rgba(255,255,255,0.5)",
          fontSize: 18,
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
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
                display: "grid",
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
                gap: GAP,
                padding: "0 4px",
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
    </div>
  );
}

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
    <motion.div
      className={`nft-card ${isGallery ? "gallery" : "compact"}`}
      data-token-id={nft.id}
      whileHover={CARD_HOVER}
      whileTap={CARD_TAP}
      style={{
        cursor: "pointer",
        borderRadius: 12,
        overflow: "hidden",
        background: "var(--border)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`${nft.name || `#${nft.id}`}${nft.rank ? `, rank ${nft.rank}` : ""}${nft.price != null ? `, ${nft.price} ETH` : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Image area */}
      <div
        className="card-image-wrap"
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <NftImage
          nft={nft}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        <div className="card-overlay" />

        {/* Rank badge — show rank relative to collection supply; hide in Lite mode and when approximate (partial data) */}
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

        {/* Favorite button */}
        {onToggleFavorite && (
          <button
            className={`card-fav-btn ${isFavorite ? "active" : ""}`}
            onClick={handleFav}
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={isFavorite}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              background: "rgba(0,0,0,0.5)",
              border: "none",
              borderRadius: "50%",
              width: 32,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontSize: 16,
              color: isFavorite ? "var(--red)" : "rgba(255,255,255,0.7)",
              zIndex: 2,
            }}
          >
            {isFavorite ? "\u2665" : "\u2661"}
          </button>
        )}

        {/* Add to Cart button — visible on hover */}
        {onAddToCart && !inCart && hovered && (
          <button
            onClick={handleAddToCart}
            aria-label="Add to cart"
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              background: "rgba(99,102,241,0.85)",
              border: "none",
              borderRadius: 8,
              width: 36,
              height: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "#fff",
              fontSize: 18,
              zIndex: 2,
              backdropFilter: "blur(4px)",
              transition: "background 0.15s",
            }}
            title="Add to cart"
          >
            {/* Shopping bag icon */}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M16 10a4 4 0 01-8 0" />
            </svg>
          </button>
        )}

        {/* In-cart indicator */}
        {inCart && (
          <div
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              background: "rgba(16,185,129,0.9)",
              borderRadius: 8,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 600,
              color: "#fff",
              zIndex: 2,
              letterSpacing: 0.5,
            }}
          >
            IN CART
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        className="card-footer"
        style={{
          padding: isGallery ? "10px 12px" : "8px 10px",
          flexShrink: 0,
        }}
      >
        <div
          className="card-info"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              className="card-name"
              style={{
                fontSize: isGallery ? 14 : 12,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {nft.name}
            </div>
            <div
              className="card-trait"
              style={{
                fontSize: 11,
                opacity: 0.6,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {nft.attributes?.[0]
                ? `${nft.attributes[0].key}: ${nft.attributes[0].value}`
                : `Token #${nft.id}`}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            {nft.price != null ? (
              <>
                <div
                  className="card-price"
                  style={{ fontSize: isGallery ? 14 : 12 }}
                >
                  <Eth />
                  {formatPrice(nft.price)}
                </div>
                {nft.lastSale != null && (
                  <div
                    className="card-last"
                    style={{ fontSize: 10, opacity: 0.5 }}
                  >
                    Last: {formatPrice(nft.lastSale)}
                  </div>
                )}
              </>
            ) : (
              <div className="card-id" style={{ fontSize: 12, opacity: 0.5 }}>
                #{nft.id}
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
});
