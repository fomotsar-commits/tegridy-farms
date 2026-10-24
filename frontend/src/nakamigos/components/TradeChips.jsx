import { Eth } from "./Icons";
import { currentLegAmounts } from "../lib/trades";
import { VENUE_COLLECTIONS, venueCollectionByContract } from "../lib/venue";

const fmtWei = (wei) => {
  const v = Number(wei / 10n ** 12n) / 1e6;
  return v > 0 ? v.toFixed(4) : null;
};

// Shared by TradesPanel cards and DM trade cards. A chip is the only identity
// a taker sees before handing over NFTs, so each venue collection wears its own
// registry chip (never a derived prefix two collections could share).
export const SHORT_NAME = Object.freeze(VENUE_COLLECTIONS.reduce((m, c) => {
  m[c.contract.toLowerCase()] = c.chip;
  return m;
}, {}));

const VISUALLY_HIDDEN = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0,
};

export const fmtEthWei = (wei) => {
  try {
    const v = Number(BigInt(wei || "0") / 10n ** 12n) / 1e6;
    return v > 0 ? v.toFixed(4) : null;
  } catch { return null; }
};

export function ItemChips({ items, accent }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {(items || []).map((it, i) => {
        const fullName = venueCollectionByContract(it.contract)?.name || null;
        const short = SHORT_NAME[(it.contract || "").toLowerCase()] || "NFT";
        return (
          <span key={i} title={fullName || undefined} style={{
            position: "relative",
            fontFamily: "var(--mono)", fontSize: 9, padding: "3px 7px", borderRadius: 5,
            background: "rgba(0,0,0,0.3)", border: `1px solid ${accent}30`, color: accent,
            letterSpacing: "0.03em",
            ...(it.any ? { borderStyle: "dashed" } : {}),
          }}>
            {it.any ? `ANY ${short}` : `${short} #${it.tokenId}`}
            {fullName && <span style={VISUALLY_HIDDEN}> ({fullName})</span>}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Live cash legs of a trade, formatted for display. Dutch legs interpolate to
 * NOW via currentLegAmounts (with a direction arrow); static legs fall back to
 * the stored topup columns. Every surface that quotes a topup — summary chips,
 * inbox cards, confirm buttons — must come through here so the number shown is
 * the number the taker pays/receives at this moment, never the final-leg value.
 */
export function liveTopups(trade) {
  const legs = trade.parameters ? currentLegAmounts(trade.parameters) : null;
  return {
    ethTopup: legs ? fmtWei(legs.ethNowWei) : fmtEthWei(trade.eth_topup_wei),
    wethTopup: legs ? fmtWei(legs.wethNowWei) : fmtEthWei(trade.weth_topup_wei),
    ethArrow: legs?.ethDecaying ? " ↘" : "",
    wethArrow: legs?.wethRising ? " ↗" : "",
  };
}

/**
 * Compact two-column give/get summary of a trade, from `viewer`'s
 * perspective. Used inside DM threads; TradesPanel has its own fuller card.
 */
export function TradeSummary({ trade, viewer }) {
  // Open (board) trades have no target_owner — any viewer who isn't the
  // maker sees it from the acceptor's perspective.
  const isTarget = trade.is_open
    ? !!viewer && trade.offerer?.toLowerCase() !== viewer.toLowerCase()
    : !!viewer && trade.target_owner?.toLowerCase() === viewer.toLowerCase();
  const youGet = isTarget ? trade.offered : trade.requested;
  const youGive = isTarget ? trade.requested : trade.offered;
  // Dutch legs: show the LIVE interpolated amounts with a direction arrow
  // (the stored topup columns carry the max commitment, not the moment).
  const { ethTopup, wethTopup, ethArrow, wethArrow } = liveTopups(trade);
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 130px" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 7, color: "var(--gold)", letterSpacing: "0.08em", marginBottom: 4 }}>YOU GIVE</div>
        <ItemChips items={youGive} accent="var(--gold)" />
        {isTarget && ethTopup && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--gold)", marginTop: 4 }}>+ <Eth size={8} /> {ethTopup}{ethArrow} ETH</div>
        )}
        {!isTarget && wethTopup && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--gold)", marginTop: 4 }}>+ {wethTopup}{wethArrow} WETH</div>
        )}
      </div>
      <div style={{ flex: "1 1 130px" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 7, color: "var(--green)", letterSpacing: "0.08em", marginBottom: 4 }}>YOU GET</div>
        <ItemChips items={youGet} accent="var(--green)" />
        {isTarget && wethTopup && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--green)", marginTop: 4 }}>+ {wethTopup}{wethArrow} WETH</div>
        )}
        {!isTarget && ethTopup && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--green)", marginTop: 4 }}>+ <Eth size={8} /> {ethTopup}{ethArrow} ETH</div>
        )}
      </div>
    </div>
  );
}
