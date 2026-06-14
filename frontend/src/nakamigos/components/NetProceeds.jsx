import { Eth } from "./Icons";
import { formatPrice } from "../lib/formatPrice";
import { computeNetProceeds } from "../lib/netProceeds";
import { OPENSEA_FEE_BPS, PLATFORM_FEE_BPS } from "../constants";

// Marketplace fee used for the ESTIMATE tier (when the order's exact ERC20
// consideration total isn't available): OpenSea fee + our platform fee. These
// are the same bps the app charges when it constructs an offer (api-offers.js).
const MARKETPLACE_FEE_BPS = OPENSEA_FEE_BPS + PLATFORM_FEE_BPS;

/**
 * F666 — Net-proceeds preview for accepting an offer.
 *
 * Read-only breakdown of what the seller NETs after fees, shown before they
 * accept. Does NOT change the accept/fulfillment transaction — purely surfaces
 * arithmetic the order already carries.
 *
 *  - When `feeWei` (the order's ERC20 consideration total) is known, the net is
 *    EXACT and already includes any royalty the collection encoded.
 *  - Otherwise it falls back to the known marketplace fee bps and discloses that
 *    royalty, if any, is set by the collection and not reflected here — never a
 *    fabricated royalty number.
 *
 * @param {number}  price  Gross offer in ETH/WETH.
 * @param {string=} feeWei Sum of the order's ERC20 consideration items in wei
 *                         (from normalizeOffer). Optional; enables the exact tier.
 * @param {boolean=} compact Tighter layout for the per-row OfferPanel list.
 */
export default function NetProceeds({ price, feeWei, compact = false }) {
  let feeEth;
  if (feeWei != null) {
    try {
      // wei -> ETH, matching api-offers' safePriceFromWei precision approach.
      const wei = BigInt(feeWei);
      if (wei >= 0n) feeEth = Number(wei / 1_000_000_000_000n) / 1_000_000;
    } catch {
      feeEth = undefined;
    }
  }

  const result = computeNetProceeds(price, { feeEth, feeBps: MARKETPLACE_FEE_BPS });
  if (!result) return null;

  const { net, fee, exact, royaltyIncluded } = result;

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
        borderRadius: 6,
        background: "rgba(74,222,128,0.03)",
        border: "1px solid rgba(74,222,128,0.1)",
        display: "flex",
        flexDirection: "column",
        gap: compact ? 2 : 3,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={labelStyle}>{exact ? "FEES (incl. royalty)" : `MARKETPLACE FEE (${MARKETPLACE_FEE_BPS / 100}%)`}</span>
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
          Est. after marketplace fee. Any royalty is set by the collection and deducted on top.
        </div>
      )}
    </div>
  );
}
