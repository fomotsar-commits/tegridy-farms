import { useMemo, memo } from "react";
import AnimatedCard from "./AnimatedCard";
import { Eth } from "./Icons";
import { formatPrice } from "../lib/formatPrice";
import { useActiveCollection } from "../contexts/CollectionContext";
import EmptyState from "./EmptyState";

export default memo(function Favorites({ tokens, favorites, onPick, onToggleFavorite }) {
  const collection = useActiveCollection();
  const safeFavorites = favorites || [];

  const favoriteNfts = useMemo(() => {
    if (safeFavorites.length === 0) return [];
    return tokens.filter((t) => safeFavorites.includes(t.id));
  }, [tokens, safeFavorites]);

  const totalValue = useMemo(() => {
    return favoriteNfts.reduce((sum, nft) => sum + (nft.price || 0), 0);
  }, [favoriteNfts]);

  if (safeFavorites.length === 0) {
    return (
      <section className="favorites-section">
        <EmptyState type="favorites" collectionName={collection?.name} />
      </section>
    );
  }

  return (
    <section className="favorites-section">
      <div className="favorites-header">
        <div>
          <div className="favorites-title">MY FAVORITES</div>
          <div className="favorites-subtitle">
            Your curated collection of {favoriteNfts.length} {collection.name}
          </div>
        </div>
        <div className="favorites-stats">
          <div className="favorites-stat">
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", letterSpacing: "0.06em" }}>SAVED</div>
            <div style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700, color: "var(--red)" }}>
              {safeFavorites.length}
            </div>
          </div>
          {totalValue > 0 && (
            <div className="favorites-stat">
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", letterSpacing: "0.06em" }}>EST. VALUE</div>
              <div style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700, color: "var(--gold)" }}>
                <Eth size={14} /> {formatPrice(totalValue)}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="gallery-grid gallery">
        {favoriteNfts.map((nft, i) => (
          <AnimatedCard
            key={nft.id}
            nft={nft}
            index={i}
            onPick={onPick}
            view="gallery"
            isFavorite={true}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
      </div>

      {favoriteNfts.length < safeFavorites.length && (
        <div style={{ textAlign: "center", padding: 24, fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
          {safeFavorites.length - favoriteNfts.length} favorited NFTs not yet loaded. Scroll the gallery to load more.
        </div>
      )}
    </section>
  );
})
