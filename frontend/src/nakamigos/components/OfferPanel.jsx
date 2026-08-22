import { useState, useEffect, useCallback, useRef } from "react";
import { Eth } from "./Icons";
import { fetchTokenOfferBook, acceptOffer } from "../api-offers";
import { getFriendlyError } from "../lib/errorMessages";
import { useActiveCollection } from "../contexts/CollectionContext";
import NetProceeds from "./NetProceeds";

export default function OfferPanel({ tokenId, wallet, addToast, onMakeOffer, ownerAddress }) {
  const collection = useActiveCollection();
  const [offers, setOffers] = useState([]);
  const [bestOffer, setBestOffer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(null);
  // True when the last poll couldn't reach the offer book at all. Separate from
  // "the book is empty" — see the render branch below.
  const [unavailable, setUnavailable] = useState(false);
  // F646 (T5): only the FIRST load shows skeletons. The 30s interval refetch +
  // the post-accept refetch keep the previous offers on screen while refreshing
  // (no skeleton flash over real data). A finally guard always settles loading.
  const loadedOnceRef = useRef(false);

  // F646: hoisted so handleAccept can refetch immediately after a successful
  // accept (filled offer disappears without waiting for the 30s tick).
  const load = useCallback(() => {
    if (!tokenId) return;
    if (!loadedOnceRef.current) setLoading(true);
    fetchTokenOfferBook(tokenId, {
      contract: collection.contract,
      slug: collection.slug,
      openseaSlug: collection.openseaSlug,
    }).then(({ offers: allOffers, bestOffer: best, unavailable: down }) => {
      setUnavailable(down);
      // A failed leg yields empty — don't let it wipe offers already on screen.
      if (!down || allOffers.length) setOffers(allOffers);
      if (!down || best) setBestOffer(best);
    }).catch(() => { setUnavailable(true); })
      .finally(() => {
        loadedOnceRef.current = true;
        setLoading(false);
      });
  }, [tokenId, collection.contract, collection.slug, collection.openseaSlug]);

  useEffect(() => {
    if (!tokenId) return;
    // Reset the first-load flag when the token/collection changes so the new
    // token's offers show a skeleton rather than the previous token's list.
    loadedOnceRef.current = false;
    setOffers([]);
    setBestOffer(null);
    setUnavailable(false);
    load();
    // Matches every other poller in the app (F533/F726): a backgrounded tab with
    // a modal left open must not keep spending the venue's rate limit, which is
    // what makes the offer feed unreachable in the first place.
    const interval = setInterval(() => { if (!document.hidden) load(); }, 30000);
    return () => clearInterval(interval);
  }, [tokenId, load]);

  const handleAccept = useCallback(async (offer) => {
    if (!wallet) return;
    if (offer.expiry && (offer.expiry instanceof Date ? offer.expiry.getTime() : offer.expiry * 1000) < Date.now()) {
      addToast?.("This offer has expired", "warning");
      return;
    }
    setAccepting(offer.orderHash);
    try {
      addToast?.("Accepting offer...", "info");
      // Ensure tokenContract is set for NFT approval check in acceptOffer
      const offerWithContract = { ...offer, tokenContract: offer.tokenContract || collection.contract };
      const result = await acceptOffer(offerWithContract);
      if (result.success) {
        addToast?.("Offer accepted successfully!", "success");
        // F646 (T5): refetch so the filled offer disappears immediately rather
        // than lingering until the next 30s poll tick.
        load();
      } else if (result.error === "rejected") {
        addToast?.("Offer acceptance was declined in your wallet.", "info");
      } else {
        // F646: surface the precise reason acceptOffer returned (e.g. expired,
        // insufficient funds, approval failed) instead of a generic message.
        addToast?.(result.message ? getFriendlyError(result.message) : "Failed to accept offer. Please try again.", "error");
      }
    } catch (err) {
      addToast?.(getFriendlyError(err), "error");
    } finally {
      setAccepting(null);
    }
  }, [wallet, addToast, collection.contract, load]);

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
      {bestOffer && (() => {
        // F666: the seller (token owner) can accept this offer — show what they
        // NET after fees/royalty before they confirm. Display only; the accept
        // tx is unchanged.
        const isOwner = wallet && ownerAddress?.toLowerCase() === wallet?.toLowerCase() && bestOffer.maker?.toLowerCase() !== wallet?.toLowerCase();
        return (
        <div style={{
          background: "rgba(74,222,128,0.04)", border: "1px solid rgba(74,222,128,0.12)",
          borderRadius: 8, padding: "10px 14px", marginBottom: 10,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)", letterSpacing: "0.06em" }}>
                BEST OFFER
              </div>
              <div style={{ fontFamily: "var(--display)", fontSize: 18, fontWeight: 600, color: "var(--text)", marginTop: 2 }}>
                <Eth size={12} /> {Number.isFinite(bestOffer.price) ? bestOffer.price.toFixed(4) : "—"}
              </div>
            </div>
            {isOwner && (
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
          {isOwner && <NetProceeds price={bestOffer.price} feeWei={bestOffer.feeWei} />}
        </div>
        );
      })()}

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" }}>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 40, borderRadius: 8, animationDelay: `${i * 60}ms` }} />
          ))}
        </div>
      ) : offers.length === 0 && !bestOffer ? (
        // The offer feed is the venue's rate-limited proxy, so a 429/502 here is
        // routine. "No Offers Yet" is a claim about the book; only make it when
        // the book actually answered. Otherwise name the outage \u2014 a bidder who
        // reads an outage as an empty book bids against nothing.
        unavailable ? (
          <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
            <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\u26A0"}</div>
            <div className="empty-state-title" style={{ fontSize: 13 }}>Offers Unavailable</div>
            <div className="empty-state-text" style={{ fontSize: 10 }}>
              The offer feed didn&apos;t respond, so this is not a count of zero. Retrying every 30s.
            </div>
          </div>
        ) : (
          <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
            <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83E\uDD1D"}</div>
            <div className="empty-state-title" style={{ fontSize: 13 }}>No Offers Yet</div>
            <div className="empty-state-text" style={{ fontSize: 10 }}>Be the first to make an offer on this NFT.</div>
          </div>
        )
      ) : (
        <div style={{ maxHeight: 200, overflowY: "auto" }}>
          {/* Partial outage: one leg answered, so the list below is real but
              cannot be claimed complete. */}
          {unavailable && (
            <div style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)",
              padding: "4px 10px",
            }}>
              Partial data: the offer feed didn&apos;t fully respond.
            </div>
          )}
          {offers.filter(o => {
            // Drop cancelled/finalized (not just expired) so the owner's Accept button
            // never fires setApprovalForAll into a dead-order fulfillment_data error —
            // mirrors BidManager's received-offers guard.
            if (o.cancelled || o.finalized) return false;
            if (!o.expiry) return true;
            const ms = o.expiry instanceof Date ? o.expiry.getTime() : new Date(o.expiry).getTime();
            return !Number.isFinite(ms) || ms > Date.now();
          }).map((offer, i) => {
            // F666: gate the net-proceeds preview on the same owner check as the
            // Accept button — only the seller about to accept needs it.
            const canAccept = wallet && ownerAddress?.toLowerCase() === wallet?.toLowerCase() && offer.maker?.toLowerCase() !== wallet?.toLowerCase();
            return (
            <div
              key={offer.orderHash || i}
              style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)" }}>
                    <Eth size={10} /> {Number.isFinite(offer.price) ? offer.price.toFixed(4) : "—"}
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
                    {offer.maker ? `${offer.maker.slice(0, 6)}...${offer.maker.slice(-4)}` : ""}
                    {offer.expiry ? ` \u00b7 ${timeLeft(offer.expiry)}` : ""}
                  </div>
                </div>
                {canAccept && (
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
              {canAccept && <NetProceeds price={offer.price} feeWei={offer.feeWei} compact />}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
