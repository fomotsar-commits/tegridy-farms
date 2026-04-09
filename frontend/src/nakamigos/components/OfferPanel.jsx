import { useState, useEffect, useCallback } from "react";
import { Eth } from "./Icons";
import { fetchTokenOffers, fetchBestOffer, acceptOffer } from "../api-offers";
import { useActiveCollection } from "../contexts/CollectionContext";

export default function OfferPanel({ tokenId, wallet, addToast, onMakeOffer, ownerAddress }) {
  const collection = useActiveCollection();
  const [offers, setOffers] = useState([]);
  const [bestOffer, setBestOffer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(null);

  useEffect(() => {
    if (!tokenId) return;
    setLoading(true);
    Promise.all([
      fetchTokenOffers(tokenId, collection.contract),
      fetchBestOffer(tokenId, collection.openseaSlug || collection.slug),
    ]).then(([allOffers, best]) => {
      setOffers(allOffers);
      setBestOffer(best);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [tokenId, collection.contract, collection.slug, collection.openseaSlug]);

  const handleAccept = useCallback(async (offer) => {
    if (!wallet) return;
    setAccepting(offer.orderHash);
    try {
      addToast?.("Accepting offer...", "info");
      const result = await acceptOffer(offer);
      if (result.success) {
        addToast?.("Offer accepted successfully!", "success");
      } else if (result.error === "rejected") {
        addToast?.("Offer acceptance was declined in your wallet.", "info");
      } else {
        addToast?.("Failed to accept offer. Please try again.", "error");
      }
    } catch {
      addToast?.("Failed to accept offer — please try again", "error");
    } finally {
      setAccepting(null);
    }
  }, [wallet, addToast]);

  const timeLeft = (expiry) => {
    if (!expiry) return "";
    const ms = expiry instanceof Date ? expiry.getTime() : new Date(expiry).getTime();
    if (!Number.isFinite(ms)) return "";
    const diff = ms - Date.now();
    if (diff <= 0) return "Expired";
    const hours = Math.floor(diff / 3600000);
    if (hours >= 24) return `${Math.floor(hours / 24)}d left`;
    if (hours > 0) return `${hours}h left`;
    return `${Math.floor(diff / 60000)}m left`;
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 10,
      }}>
        <div style={{
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
          letterSpacing: "0.08em",
        }}>
          OFFERS
        </div>
        <button
          onClick={onMakeOffer}
          style={{
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--naka-blue)",
            background: "rgba(111,168,220,0.08)", border: "1px solid rgba(111,168,220,0.15)",
            borderRadius: 6, padding: "4px 10px", cursor: "pointer",
          }}
        >
          + Make Offer
        </button>
      </div>

      {/* Best offer highlight */}
      {bestOffer && (
        <div style={{
          background: "rgba(74,222,128,0.04)", border: "1px solid rgba(74,222,128,0.12)",
          borderRadius: 8, padding: "10px 14px", marginBottom: 10,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)", letterSpacing: "0.06em" }}>
              BEST OFFER
            </div>
            <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 600, color: "var(--text)", marginTop: 2 }}>
              <Eth size={12} /> {Number.isFinite(bestOffer.price) ? bestOffer.price.toFixed(4) : "—"}
            </div>
          </div>
          {wallet && ownerAddress?.toLowerCase() === wallet?.toLowerCase() && bestOffer.maker?.toLowerCase() !== wallet?.toLowerCase() && (
            <button
              className="btn-primary"
              style={{ fontSize: 10, padding: "6px 14px" }}
              disabled={accepting === bestOffer.orderHash}
              onClick={() => handleAccept(bestOffer)}
            >
              {accepting === bestOffer.orderHash ? "Accepting..." : "Accept"}
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" }}>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 40, borderRadius: 8, animationDelay: `${i * 60}ms` }} />
          ))}
        </div>
      ) : offers.length === 0 && !bestOffer ? (
        <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
          <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83E\uDD1D"}</div>
          <div className="empty-state-title" style={{ fontSize: 13 }}>No Offers Yet</div>
          <div className="empty-state-text" style={{ fontSize: 10 }}>Be the first to make an offer on this NFT.</div>
        </div>
      ) : (
        <div style={{ maxHeight: 200, overflowY: "auto" }}>
          {offers.filter(o => {
            if (!o.expiry) return true;
            const ms = o.expiry instanceof Date ? o.expiry.getTime() : new Date(o.expiry).getTime();
            return !Number.isFinite(ms) || ms > Date.now();
          }).map((offer, i) => (
            <div
              key={offer.orderHash || i}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "8px 10px", borderBottom: "1px solid var(--border)",
              }}
            >
              <div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)" }}>
                  <Eth size={10} /> {Number.isFinite(offer.price) ? offer.price.toFixed(4) : "—"}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
                  {offer.maker ? `${offer.maker.slice(0, 6)}...${offer.maker.slice(-4)}` : ""}
                  {offer.expiry ? ` \u00b7 ${timeLeft(offer.expiry)}` : ""}
                </div>
              </div>
              {wallet && ownerAddress?.toLowerCase() === wallet?.toLowerCase() && offer.maker?.toLowerCase() !== wallet?.toLowerCase() && (
                <button
                  style={{
                    fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)",
                    background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.12)",
                    borderRadius: 4, padding: "3px 8px", cursor: "pointer",
                  }}
                  disabled={accepting === offer.orderHash}
                  onClick={() => handleAccept(offer)}
                >
                  {accepting === offer.orderHash ? "..." : "Accept"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
