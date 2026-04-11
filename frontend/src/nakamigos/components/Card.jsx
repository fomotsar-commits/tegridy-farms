import { memo, useCallback } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { formatPrice } from "../lib/formatPrice";
import { OPENSEA_ITEM } from "../constants";
import { useActiveCollection } from "../contexts/CollectionContext";

export default memo(function Card({ nft, idx, onPick, view, isFavorite, onToggleFavorite, skipReveal }) {
  const collection = useActiveCollection();
  const isGallery = view === "gallery";

  const handleBuy = useCallback((e) => {
    e.stopPropagation();
    window.open(OPENSEA_ITEM(nft.id, collection.contract), "_blank", "noopener,noreferrer");
  }, [nft.id, collection.contract]);

  const handleFav = useCallback((e) => {
    e.stopPropagation();
    onToggleFavorite?.(nft.id);
  }, [onToggleFavorite, nft.id]);

  const handleClick = useCallback(() => onPick(nft), [onPick, nft]);
  const handleKeyDown = useCallback((e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(nft); }
  }, [onPick, nft]);

  return (
    <div
      className={skipReveal ? undefined : "card-reveal"}
      style={skipReveal ? undefined : { animationDelay: `${Math.min(idx * 35, 350)}ms` }}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      data-token-id={nft.id}
      onKeyDown={handleKeyDown}
      aria-label={`${nft.name}${nft.rank ? `, rank ${nft.rank}` : ""}${nft.price != null ? `, ${formatPrice(nft.price)} ETH` : ""}`}
    >
      <div className={`nft-card ${view}`}>
        <div className="card-image-wrap">
          <NftImage nft={nft} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          <div className="card-overlay" />

          {/* Rank badge — show rank relative to collection supply; highlight top 25% */}
          {nft.rank && (
            <div
              className={`card-rank-badge${collection.supply && nft.rank <= collection.supply * 0.25 ? " card-rank-top" : ""}`}
              title={`Rank ${nft.rank}${collection.supply ? ` of ${collection.supply.toLocaleString()}` : ""}`}
            >
              #{nft.rank}
              {collection.supply != null && (
                <span className="card-rank-supply">/{collection.supply.toLocaleString()}</span>
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
            >
              {isFavorite ? "\u2665" : "\u2661"}
            </button>
          )}

          <div className="card-buy-wrap">
            <button className="btn-buy-quick" onClick={handleBuy} aria-label={`View ${nft.name} on OpenSea`}>
              VIEW ON OPENSEA
            </button>
          </div>
        </div>
        <div className="card-footer">
          <div className="card-info">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="card-name" style={{ fontSize: isGallery ? 16 : 14 }}>{nft.name}</div>
              <div className="card-trait">
                {nft.attributes?.[0]
                  ? `${nft.attributes[0].key}: ${nft.attributes[0].value}`
                  : `Token #${nft.id}`
                }
              </div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              {nft.price != null ? (
                <>
                  <div className="card-price" style={{ fontSize: isGallery ? 14 : 12 }}>
                    <Eth />{formatPrice(nft.price)}
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
    </div>
  );
}, (prev, next) => {
  return prev.nft.id === next.nft.id
    && prev.view === next.view
    && prev.isFavorite === next.isFavorite
    && prev.skipReveal === next.skipReveal
    && prev.nft.price === next.nft.price
    && prev.nft.rank === next.nft.rank
    && prev.nft.name === next.nft.name
    && prev.nft.lastSale === next.nft.lastSale
    && prev.nft.image === next.nft.image
    && prev.onPick === next.onPick
    && prev.onToggleFavorite === next.onToggleFavorite;
})
