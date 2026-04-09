import { useState, useCallback } from "react";
import { Eth } from "./Icons";
import MakeOfferModal from "./MakeOfferModal";
import { useCollectionOffers, useTraitOffers } from "../hooks/useOffers";
import EmptyState from "./EmptyState";

export default function CollectionOffersPanel({ wallet, onConnect, addToast }) {
  const { data: collectionOffers = [], isLoading: coLoading, refetch: refetchCO } = useCollectionOffers();
  const { data: traitOffers = {}, isLoading: toLoading, refetch: refetchTO } = useTraitOffers();
  const loading = coLoading || toLoading;
  const [showOfferModal, setShowOfferModal] = useState(null); // null | "collection" | { key, value }

  const refreshOffers = useCallback(() => {
    refetchCO();
    refetchTO();
  }, [refetchCO, refetchTO]);

  // Flatten trait offers into a displayable list
  const traitOfferList = [];
  for (const [traitType, values] of Object.entries(traitOffers)) {
    for (const [traitValue, data] of Object.entries(values)) {
      let price = null;
      try {
        if (data?.price?.value) price = Number(BigInt(data.price.value) * 10000n / BigInt(1e18)) / 10000;
      } catch { /* malformed price data */ }
      if (price) {
        traitOfferList.push({
          traitType,
          traitValue,
          price,
          count: data.count || 0,
        });
      }
    }
  }
  traitOfferList.sort((a, b) => b.price - a.price);

  const bestCollectionOffer = collectionOffers.length > 0
    ? collectionOffers.reduce((best, o) => (!best || (o.price && o.price > best.price)) ? o : best, null)
    : null;

  return (
    <div style={{
      background: "rgba(111,168,220,0.02)", border: "1px solid rgba(111,168,220,0.08)",
      borderRadius: 12, padding: "20px", marginBottom: 24,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 16,
      }}>
        <div>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 10, color: "var(--naka-blue)", letterSpacing: "0.1em" }}>
            OFFERS & BIDS
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            Active collection and trait offers from buyers
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowOfferModal("collection")}
            className="btn-primary"
            style={{ fontSize: 10, padding: "8px 14px" }}
          >
            {wallet ? "Collection Offer" : "Connect & Offer"}
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 0" }}>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 44, borderRadius: 10, animationDelay: `${i * 60}ms` }} />
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {/* Collection Offers */}
          <div>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)",
              letterSpacing: "0.08em", marginBottom: 10, paddingLeft: 2,
            }}>
              COLLECTION OFFERS ({collectionOffers.length})
            </div>

            {bestCollectionOffer && (
              <div style={{
                background: "rgba(74,222,128,0.04)", border: "1px solid rgba(74,222,128,0.1)",
                borderRadius: 8, padding: "10px 14px", marginBottom: 8,
              }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)", letterSpacing: "0.06em" }}>
                  BEST COLLECTION OFFER
                </div>
                <div style={{ fontFamily: "var(--display)", fontSize: 20, fontWeight: 600, color: "var(--text)", marginTop: 4 }}>
                  <Eth size={13} /> {bestCollectionOffer.price != null && Number.isFinite(bestCollectionOffer.price) ? bestCollectionOffer.price.toFixed(4) : "—"}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
                  {bestCollectionOffer.maker ? `by ${bestCollectionOffer.maker.slice(0, 6)}...${bestCollectionOffer.maker.slice(-4)}` : ""}
                </div>
              </div>
            )}

            <div style={{ maxHeight: 200, overflowY: "auto" }}>
              {collectionOffers.length === 0 ? (
                <EmptyState type="collectionOffers" compact />
              ) : (
                collectionOffers.slice(0, 10).map((offer, i) => (
                  <div key={offer.orderHash || i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "6px 8px", borderBottom: "1px solid var(--border)",
                  }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" }}>
                      <Eth size={10} /> {offer.price?.toFixed(4) || "—"}
                    </div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>
                      {offer.maker ? `${offer.maker.slice(0, 6)}...${offer.maker.slice(-4)}` : ""}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Trait Offers */}
          <div>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)",
              letterSpacing: "0.08em", marginBottom: 10, paddingLeft: 2,
            }}>
              TRAIT OFFERS ({traitOfferList.length})
            </div>

            <div style={{ maxHeight: 260, overflowY: "auto" }}>
              {traitOfferList.length === 0 ? (
                <EmptyState type="traitOffers" compact />
              ) : (
                traitOfferList.slice(0, 15).map((to, i) => (
                  <div
                    key={`${to.traitType}-${to.traitValue}-${i}`}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "6px 8px", borderBottom: "1px solid var(--border)",
                      cursor: "pointer",
                    }}
                    onClick={() => setShowOfferModal({ key: to.traitType, value: to.traitValue })}
                  >
                    <div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text)" }}>
                        {to.traitType}: {to.traitValue}
                      </div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>
                        {to.count} offer{to.count !== 1 ? "s" : ""}
                      </div>
                    </div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--gold)" }}>
                      <Eth size={10} /> {to.price?.toFixed(4) ?? "\u2014"}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showOfferModal && (
        <MakeOfferModal
          collection={showOfferModal === "collection" ? true : undefined}
          trait={typeof showOfferModal === "object" ? showOfferModal : undefined}
          onClose={() => setShowOfferModal(null)}
          wallet={wallet}
          onConnect={onConnect}
          addToast={addToast}
          onSuccess={refreshOffers}
        />
      )}
    </div>
  );
}
