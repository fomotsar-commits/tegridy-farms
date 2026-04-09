import { Eth } from "./Icons";
import { useTraitOffers } from "../hooks/useOffers";
import EmptyState from "./EmptyState";

export default function TraitBidPanel({ traitKey, traitValue, matchCount, wallet, onConnect, addToast, onMakeOffer }) {
  const { data: traitOffers = {}, isLoading: loading } = useTraitOffers();

  const offerData = traitOffers?.[traitKey]?.[traitValue];
  let bestPrice = null;
  try {
    if (offerData?.price?.value) {
      const raw = Number(BigInt(offerData.price.value) * 10000n / BigInt(1e18)) / 10000;
      bestPrice = Number.isFinite(raw) ? raw : null;
    }
  } catch { bestPrice = null; }
  const offerCount = offerData?.count || 0;

  return (
    <div style={{
      background: "rgba(111,168,220,0.03)", border: "1px solid rgba(111,168,220,0.08)",
      borderRadius: 10, padding: "14px 16px", marginBottom: 16,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 10,
      }}>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--naka-blue)", letterSpacing: "0.08em" }}>
            TRAIT OFFERS
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
            {matchCount != null ? `${matchCount} NFTs have this trait` : "Trait offers"}
          </div>
        </div>
        <button
          onClick={() => onMakeOffer({ key: traitKey, value: traitValue })}
          className="btn-primary"
          style={{ fontSize: 10, padding: "6px 14px" }}
        >
          {wallet ? "Bid on Trait" : "Connect & Bid"}
        </button>
      </div>

      {loading ? (
        <div style={{ padding: "8px 0" }}>
          <div className="skeleton" style={{ height: 36, borderRadius: 8 }} />
        </div>
      ) : bestPrice ? (
        <div style={{
          display: "flex", gap: 16, alignItems: "center",
        }}>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>BEST OFFER</div>
            <div style={{ fontFamily: "var(--display)", fontSize: 16, fontWeight: 600, color: "var(--gold)", marginTop: 2 }}>
              <Eth size={11} /> {Number.isFinite(bestPrice) ? bestPrice.toFixed(4) : "—"}
            </div>
          </div>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>TOTAL OFFERS</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--text)", marginTop: 2 }}>
              {offerCount}
            </div>
          </div>
        </div>
      ) : (
        <EmptyState type="traitOffers" compact />
      )}
    </div>
  );
}
