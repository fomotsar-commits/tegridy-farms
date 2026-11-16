import { Eth } from "./Icons";
import { formatPrice } from "../lib/formatPrice";
import { computeNetProceeds } from "../lib/netProceeds";
import { OPENSEA_FEE_BPS, openseaRequiredBidFees } from "../constants";
import { bookCollectionByContract } from "../lib/venue";

// The ESTIMATE when a bid's own lines are unknown: the fees OpenSea requires on a
// bid for this collection (constants.js OPENSEA_REQUIRED_BID_FEES, OpenSea's 1% for
// every collection here). It used to be a fixed 1.5% (OpenSea + the venue's 0.5%),
// but no bid carries the venue's line while BID_VENUE_FEE_ENABLED is off, so that
// figure understated what a seller receives.
function estimateFeeBps(contract) {
  const lines = openseaRequiredBidFees(bookCollectionByContract(contract));
  return lines ? lines.reduce((sum, l) => sum + l.bps, 0) : OPENSEA_FEE_BPS;
}

// 100 -> "1", 150 -> "1.5", 99.99 -> "1": a share, to two decimals of a percent.
const percent = (bps) => String(Number((Number(bps) / 100).toFixed(2)));

/**
 * F666 — Net-proceeds preview for accepting an offer.
 *
 * Read-only breakdown of what the seller NETs after fees, shown before they
 * accept. Does NOT change the accept/fulfillment transaction — purely surfaces
 * arithmetic the order already carries.
 *
 *  - When `feeBps` (the bid's own fee lines as bps of its offer, from
 *    offerNormalize.feeBpsOf) is known, the net is EXACT: every line not paid to
 *    the bidder comes off, a royalty included.
 *  - Otherwise it shows the collection's required OpenSea fee and says the
 *    figure is estimated; a royalty, if any, is never invented.
 *
 * @param {number}  price    Gross offer in ETH/WETH, per item.
 * @param {number=} feeBps   The bid's fee lines in bps of its offer. Optional.
 * @param {string=} contract The NFT contract, for the estimate's required fee.
 * @param {boolean=} compact Tighter layout for the per-row OfferPanel list.
 */
export default function NetProceeds({ price, feeBps, contract, compact = false }) {
  const estimateBps = estimateFeeBps(contract);
  const result = computeNetProceeds(price, { orderFeeBps: feeBps, feeBps: estimateBps });
  if (!result) return null;

  // `royaltyIncluded` is intentionally not destructured: it is exactly equal to
  // `exact` (see computeNetProceeds), and both the fee label and the estimate
  // disclosure below already branch on `exact`.
  const { net, fee, exact } = result;

  const labelStyle = {
    fontFamily: "var(--mono)",
    fontSize: compact ? 8 : 9,
    color: "var(--text-dim)",
    letterSpacing: "0.04em",
  };
  const valueStyle = {
    fontFamily: "var(--mono)",
    fontSize: compact ? 9 : 10,
    color: "var(--text-muted)",
  };

  return (
    <div
      style={{
        marginTop: compact ? 4 : 8,
        padding: compact ? "6px 8px" : "8px 10px",
        borderRadius: 4,
        background: "rgba(47,217,139,0.03)",
        border: "1px solid rgba(47,217,139,0.1)",
        display: "flex",
        flexDirection: "column",
        gap: compact ? 2 : 3,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={labelStyle}>{exact ? `FEES (${percent(feeBps)}%)` : `OPENSEA FEE (${percent(estimateBps)}%)`}</span>
        <span style={valueStyle}>
          {"−"}<Eth size={compact ? 8 : 9} /> {formatPrice(fee)}
        </span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ ...labelStyle, color: "var(--green)", fontWeight: 600 }}>YOU RECEIVE</span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: compact ? 11 : 13,
            color: "var(--green)",
            fontWeight: 600,
          }}
        >
          <Eth size={compact ? 9 : 11} /> {formatPrice(net)}
        </span>
      </div>
      {!exact && (
        <div style={{ ...labelStyle, fontSize: compact ? 7 : 8, color: "var(--text-muted)", lineHeight: 1.4 }}>
          Estimated. Any royalty is set by the collection and deducted on top.
        </div>
      )}
    </div>
  );
}
