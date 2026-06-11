import { COLLECTIONS } from "../constants";
import { Eth } from "./Icons";

// Shared by TradesPanel cards and DM trade cards.
const SHORT_NAME = Object.values(COLLECTIONS).reduce((m, c) => {
  m[c.contract.toLowerCase()] = c.name.split(" ")[0].toUpperCase().slice(0, 5);
  return m;
}, {});

export const fmtEthWei = (wei) => {
  try {
    const v = Number(BigInt(wei || "0") / 10n ** 12n) / 1e6;
    return v > 0 ? v.toFixed(4) : null;
  } catch { return null; }
};

export function ItemChips({ items, accent }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {(items || []).map((it, i) => (
        <span key={i} style={{
          fontFamily: "var(--mono)", fontSize: 9, padding: "3px 7px", borderRadius: 5,
          background: "rgba(0,0,0,0.3)", border: `1px solid ${accent}30`, color: accent,
          letterSpacing: "0.03em",
          ...(it.any ? { borderStyle: "dashed" } : {}),
        }}>
          {it.any
            ? `ANY ${SHORT_NAME[(it.contract || "").toLowerCase()] || "NFT"}`
            : `${SHORT_NAME[(it.contract || "").toLowerCase()] || "NFT"} #${it.tokenId}`}
        </span>
      ))}
    </div>
  );
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
  const ethTopup = fmtEthWei(trade.eth_topup_wei);
  const wethTopup = fmtEthWei(trade.weth_topup_wei);
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 130px" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 7, color: "var(--gold)", letterSpacing: "0.08em", marginBottom: 4 }}>YOU GIVE</div>
        <ItemChips items={youGive} accent="var(--gold)" />
        {isTarget && ethTopup && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--gold)", marginTop: 4 }}>+ <Eth size={8} /> {ethTopup} ETH</div>
        )}
        {!isTarget && wethTopup && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--gold)", marginTop: 4 }}>+ {wethTopup} WETH</div>
        )}
      </div>
      <div style={{ flex: "1 1 130px" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 7, color: "var(--green)", letterSpacing: "0.08em", marginBottom: 4 }}>YOU GET</div>
        <ItemChips items={youGet} accent="var(--green)" />
        {isTarget && wethTopup && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--green)", marginTop: 4 }}>+ {wethTopup} WETH</div>
        )}
        {!isTarget && ethTopup && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--green)", marginTop: 4 }}>+ <Eth size={8} /> {ethTopup} ETH</div>
        )}
      </div>
    </div>
  );
}
