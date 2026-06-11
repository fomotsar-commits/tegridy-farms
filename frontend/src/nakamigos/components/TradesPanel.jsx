import { useState, useEffect, useCallback, useRef } from "react";
import { Eth } from "./Icons";
import TradeWindow from "./TradeWindow";
import DirectMessages from "./DirectMessages";
import NftImage from "./NftImage";
import { ItemChips, TradeSummary, fmtEthWei as fmtEth } from "./TradeChips";
import { fetchTrades, acceptTrade, acceptOpenTrade, updateTradeStatus, cancelTradeOnChain } from "../lib/trades";
import { fetchWalletNfts } from "../api";
import { COLLECTIONS } from "../constants";

const COLLECTION_BY_CONTRACT = Object.values(COLLECTIONS).reduce((m, c) => {
  m[c.contract.toLowerCase()] = c;
  return m;
}, {});

/**
 * Accept flow for an OPEN (board) trade: pick which of YOUR tokens fill each
 * "Any <collection>" slot, then fulfill with criteria resolvers.
 */
function OpenTradeAccept({ trade, wallet, addToast, onClose, onAccepted }) {
  const [inventory, setInventory] = useState({}); // contract -> tokens[]
  const [loading, setLoading] = useState(true);
  const [selections, setSelections] = useState({}); // considerationIndex -> tokenId
  const [busy, setBusy] = useState(false);

  // Wildcard slots = criteria items in the SIGNED consideration (the ETH leg
  // sits after them, so indexes must come from parameters, not `requested`).
  const slots = (trade.parameters?.consideration || [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => Number(item.itemType) === 4)
    .map(({ item, index }) => ({ index, contract: item.token.toLowerCase() }));
  const ethTopup = fmtEth(trade.eth_topup_wei);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const contracts = [...new Set(slots.map(s => s.contract))];
      const out = {};
      await Promise.all(contracts.map(async (contract) => {
        const c = COLLECTION_BY_CONTRACT[contract];
        try {
          const res = await fetchWalletNfts(wallet, c?.contract || contract, c?.metadataBase);
          out[contract] = res?.tokens || [];
        } catch { out[contract] = []; }
      }));
      if (!cancelled) { setInventory(out); setLoading(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade.id, wallet]);

  const chosen = new Set(Object.entries(selections).map(([i, id]) => `${slots.find(s => s.index === Number(i))?.contract}:${id}`));
  const allPicked = slots.every(s => selections[s.index] != null);

  return (
    <div className="modal-bg" onClick={onClose} style={{ zIndex: 1100 }} role="dialog" aria-modal="true" aria-label="Accept open trade">
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "var(--bg, #0b0b14)", border: "1px solid var(--border)", borderRadius: 14,
        width: "min(680px, 94vw)", maxHeight: "88vh", overflowY: "auto", padding: "18px 20px", margin: "5vh auto",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontFamily: "var(--pixel)", fontSize: 11, color: "var(--green)", letterSpacing: "0.1em" }}>ACCEPT OPEN TRADE</span>
          <button aria-label="Close modal" onClick={onClose} className="btn-secondary" style={{ padding: "5px 11px", fontSize: 12 }}>{"✕"}</button>
        </div>
        <TradeSummary trade={trade} viewer={wallet} />
        <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", margin: "12px 0 6px", letterSpacing: "0.06em" }}>
          PICK THE TOKEN{slots.length !== 1 ? "S" : ""} YOU'LL GIVE
        </div>
        {loading ? (
          <div className="skeleton" style={{ height: 90, borderRadius: 10 }} />
        ) : slots.map((slot, slotPos) => {
          const c = COLLECTION_BY_CONTRACT[slot.contract];
          const tokens = inventory[slot.contract] || [];
          return (
            <div key={slot.index} style={{ marginBottom: 12 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--gold)", marginBottom: 6 }}>
                Slot {slotPos + 1}: any {c?.name || "NFT"}
              </div>
              {tokens.length === 0 ? (
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--red)", padding: "8px 0" }}>
                  You don't hold any {c?.name || "tokens from this collection"} — you can't fill this slot.
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))", gap: 6, maxHeight: 150, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                  {tokens.map((t) => {
                    const id = String(t.id);
                    const isMine = selections[slot.index] === id;
                    const usedElsewhere = !isMine && chosen.has(`${slot.contract}:${id}`);
                    return (
                      <div
                        key={id}
                        role="radio"
                        aria-checked={isMine}
                        tabIndex={0}
                        onClick={() => !usedElsewhere && setSelections((s) => ({ ...s, [slot.index]: id }))}
                        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !usedElsewhere) { e.preventDefault(); setSelections((s) => ({ ...s, [slot.index]: id })); } }}
                        style={{
                          position: "relative", cursor: usedElsewhere ? "not-allowed" : "pointer",
                          borderRadius: 8, overflow: "hidden", opacity: usedElsewhere ? 0.35 : 1,
                          border: isMine ? "2px solid var(--green)" : "2px solid transparent",
                        }}
                        title={`#${id}${usedElsewhere ? " (already used for another slot)" : ""}`}
                      >
                        <NftImage nft={t} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
                        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, fontFamily: "var(--mono)", fontSize: 8, padding: "1px 3px", background: "rgba(0,0,0,0.7)", color: isMine ? "var(--green)" : "var(--text-dim)" }}>
                          #{id}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        <button
          className="btn-primary"
          style={{ width: "100%", marginTop: 6, opacity: allPicked && !busy ? 1 : 0.5 }}
          disabled={!allPicked || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await acceptOpenTrade(trade, selections);
              if (result.success) {
                addToast?.("Trade executed!", "success");
                onAccepted?.();
                onClose();
              } else if (result.error !== "rejected") {
                addToast?.(result.message || "Trade failed", "error");
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Trading…" : ethTopup ? `Confirm — sign & pay ${ethTopup} ETH` : "Confirm — sign & execute"}
        </button>
      </div>
    </div>
  );
}

const timeLeft = (iso) => {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const h = Math.floor(diff / 3600000);
  if (h >= 24) return `${Math.floor(h / 24)}d left`;
  if (h > 0) return `${h}h left`;
  return `${Math.floor(diff / 60000)}m left`;
};

const short = (addr) => addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";

const STATUS_COLOR = {
  active: "var(--naka-blue)", accepted: "var(--green)", declined: "var(--red)",
  cancelled: "var(--text-muted)", expired: "var(--text-muted)", countered: "var(--gold)",
};

function TradeCard({ trade, direction, wallet, addToast, onChanged, onCounter, onPickProfile, onMessage }) {
  const [busy, setBusy] = useState(null); // "accept" | "decline" | "cancel" | "revoke"
  const [confirming, setConfirming] = useState(false);
  const isIncoming = direction === "incoming";
  const other = isIncoming ? trade.offerer : trade.target_owner;
  // From the VIEWER's perspective: incoming → "you get" what they offered.
  const youGet = isIncoming ? trade.offered : trade.requested;
  const youGive = isIncoming ? trade.requested : trade.offered;
  const ethTopup = fmtEth(trade.eth_topup_wei);   // taker pays
  const wethTopup = fmtEth(trade.weth_topup_wei); // maker adds
  const isActive = trade.status === "active";

  const run = async (kind, fn, successMsg) => {
    setBusy(kind);
    try {
      const result = await fn();
      if (result.success) {
        addToast?.(successMsg, "success");
        onChanged?.();
      } else if (result.error !== "rejected") {
        addToast?.(result.message || "Action failed", "error");
      }
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px",
      background: "var(--surface-glass)", marginBottom: 10,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>
          {isIncoming ? "FROM" : "TO"}{" "}
          <button
            onClick={() => onPickProfile?.(other)}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "var(--mono)", fontSize: 10, color: "var(--naka-blue)" }}
          >
            {short(other)}
          </button>
          {trade.counter_of && <span style={{ marginLeft: 8, color: "var(--gold)" }}>COUNTER</span>}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={() => onMessage?.(trade)}
            title="Message this wallet about the trade"
            style={{
              fontFamily: "var(--mono)", fontSize: 9, padding: "3px 10px", borderRadius: 6,
              background: "transparent", border: "1px solid var(--border)", color: "var(--text-dim)",
              cursor: "pointer", letterSpacing: "0.04em",
            }}
          >
            {"✉"} Message
          </button>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: STATUS_COLOR[trade.status] || "var(--text-dim)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
            {trade.status}
          </span>
          {isActive && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>{timeLeft(trade.expires_at)}</span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--gold)", letterSpacing: "0.08em", marginBottom: 5 }}>YOU GIVE</div>
          <ItemChips items={youGive} accent="var(--gold)" />
          {isIncoming && ethTopup && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--gold)", marginTop: 5 }}>+ <Eth size={9} /> {ethTopup} ETH</div>
          )}
          {!isIncoming && wethTopup && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--gold)", marginTop: 5 }}>+ {wethTopup} WETH</div>
          )}
        </div>
        <div style={{ flex: "1 1 220px" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--green)", letterSpacing: "0.08em", marginBottom: 5 }}>YOU GET</div>
          <ItemChips items={youGet} accent="var(--green)" />
          {isIncoming && wethTopup && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)", marginTop: 5 }}>+ {wethTopup} WETH</div>
          )}
          {!isIncoming && ethTopup && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)", marginTop: 5 }}>+ <Eth size={9} /> {ethTopup} ETH</div>
          )}
        </div>
      </div>

      {isActive && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {isIncoming ? (
            <>
              {confirming ? (
                <button
                  className="btn-primary"
                  style={{ fontSize: 10, padding: "8px 16px" }}
                  disabled={!!busy}
                  onClick={() => run("accept", () => acceptTrade(trade), "Trade executed!")}
                >
                  {busy === "accept" ? "Trading…" : `Confirm — sign & ${ethTopup ? `pay ${ethTopup} ETH` : "execute"}`}
                </button>
              ) : (
                <button className="btn-primary" style={{ fontSize: 10, padding: "8px 16px" }} onClick={() => setConfirming(true)}>
                  Accept trade
                </button>
              )}
              <button
                className="btn-secondary"
                style={{ fontSize: 10, padding: "8px 16px" }}
                disabled={!!busy}
                onClick={() => onCounter?.(trade)}
              >
                Counter
              </button>
              <button
                className="btn-secondary"
                style={{ fontSize: 10, padding: "8px 16px", color: "var(--red)" }}
                disabled={!!busy}
                onClick={() => run("decline", () => updateTradeStatus(trade, "trade-decline"), "Trade declined")}
              >
                {busy === "decline" ? "…" : "Decline"}
              </button>
            </>
          ) : (
            <>
              <button
                className="btn-secondary"
                style={{ fontSize: 10, padding: "8px 16px" }}
                disabled={!!busy}
                onClick={() => run("cancel", () => updateTradeStatus(trade, "trade-cancel"), "Trade cancelled")}
                title="Free — removes it from their inbox. The signature itself stays valid until expiry."
              >
                {busy === "cancel" ? "…" : "Cancel"}
              </button>
              <button
                className="btn-secondary"
                style={{ fontSize: 10, padding: "8px 16px", color: "var(--red)" }}
                disabled={!!busy}
                onClick={() => run("revoke", () => cancelTradeOnChain(trade), "Order revoked on-chain")}
                title="Gas transaction — hard-revokes the signed Seaport order immediately"
              >
                {busy === "revoke" ? "Revoking…" : "Revoke on-chain"}
              </button>
            </>
          )}
        </div>
      )}
      {trade.status === "accepted" && trade.accepted_tx && (
        <a
          href={`https://etherscan.io/tx/${trade.accepted_tx}`}
          target="_blank" rel="noopener noreferrer"
          style={{ display: "inline-block", marginTop: 10, fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)", textDecoration: "none" }}
        >
          View settlement on Etherscan {"↗"}
        </a>
      )}
    </div>
  );
}

/** Cancel / hard-revoke controls for the maker's own board posts. */
function BoardOwnerActions({ trade, addToast, onChanged }) {
  const [busy, setBusy] = useState(null);
  const run = async (kind, fn, msg) => {
    setBusy(kind);
    try {
      const result = await fn();
      if (result.success) { addToast?.(msg, "success"); onChanged?.(); }
      else if (result.error !== "rejected") addToast?.(result.message || "Action failed", "error");
    } finally { setBusy(null); }
  };
  return (
    <>
      <button
        className="btn-secondary"
        style={{ fontSize: 10, padding: "8px 16px" }}
        disabled={!!busy}
        onClick={() => run("cancel", () => updateTradeStatus(trade, "trade-cancel"), "Post removed")}
        title="Free — removes it from the board. The signature stays valid until expiry."
      >
        {busy === "cancel" ? "…" : "Remove post"}
      </button>
      <button
        className="btn-secondary"
        style={{ fontSize: 10, padding: "8px 16px", color: "var(--red)" }}
        disabled={!!busy}
        onClick={() => run("revoke", () => cancelTradeOnChain(trade), "Order revoked on-chain")}
        title="Gas transaction — hard-revokes the signed Seaport order immediately"
      >
        {busy === "revoke" ? "Revoking…" : "Revoke on-chain"}
      </button>
    </>
  );
}

/**
 * P2P trades inbox/outbox + the public trade board.
 */
export default function TradesPanel({ wallet, onConnect, addToast, onViewProfile }) {
  const [direction, setDirection] = useState("incoming");
  const [statusFilter, setStatusFilter] = useState("active");
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [boardBuilderOpen, setBoardBuilderOpen] = useState(false);
  const [acceptTarget, setAcceptTarget] = useState(null); // open trade being accepted
  const [counterTrade, setCounterTrade] = useState(null);
  const [dmContext, setDmContext] = useState(null); // { peer, tradeId }
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!wallet) return;
    setLoading(true);
    const { trades: rows } = await fetchTrades({ wallet, role: direction, status: statusFilter });
    if (mountedRef.current) {
      setTrades(rows || []);
      setLoading(false);
    }
  }, [wallet, direction, statusFilter]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    const interval = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => { mountedRef.current = false; clearInterval(interval); };
  }, [load]);

  // Counter flow: the viewer (current taker) becomes the maker of a new
  // trade with the sides swapped and the original linked via counterOf.
  const counterProps = counterTrade ? {
    counterparty: counterTrade.offerer,
    prefillGive: (counterTrade.requested || []).map(it => ({ contract: it.contract, id: it.tokenId, tokenId: it.tokenId, name: `#${it.tokenId}` })),
    initialRequested: (counterTrade.offered || []).map(it => ({ contract: it.contract, id: it.tokenId, tokenId: it.tokenId, name: `#${it.tokenId}` })),
    counterOf: counterTrade.id,
  } : null;

  if (!wallet) {
    return (
      <section style={{ padding: "28px 32px" }}>
        <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
          <div className="empty-state-icon">{"⇄"}</div>
          <div className="empty-state-title">P2P Trades</div>
          <div className="empty-state-text">Connect your wallet to send and receive NFT-for-NFT trade offers.</div>
          <button className="btn-primary" style={{ marginTop: 14, padding: "10px 24px" }} onClick={onConnect}>Connect Wallet</button>
        </div>
      </section>
    );
  }

  return (
    <section style={{ padding: "28px 32px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
        <div>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 13, color: "var(--naka-blue)", letterSpacing: "0.1em" }}>P2P TRADES</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 5 }}>
            NFT-for-NFT swaps, settled atomically on Seaport. No platform fee.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn-secondary" style={{ fontSize: 11, padding: "10px 20px" }} onClick={() => setBoardBuilderOpen(true)}>
            + Post to board
          </button>
          <button className="btn-primary" style={{ fontSize: 11, padding: "10px 20px" }} onClick={() => setBuilderOpen(true)}>
            + New trade offer
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {["board", "incoming", "outgoing"].map(d => (
          <button
            key={d}
            onClick={() => setDirection(d)}
            className={direction === d ? "btn-primary" : "btn-secondary"}
            style={{ fontSize: 10, padding: "7px 16px", textTransform: "capitalize" }}
          >
            {d}
          </button>
        ))}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter trades by status"
          style={{
            fontFamily: "var(--mono)", fontSize: 10, padding: "7px 10px", borderRadius: 8,
            border: "1px solid var(--border)", background: "var(--surface-glass)", color: "var(--text)",
          }}
        >
          {["active", "accepted", "declined", "cancelled", "countered", "all"].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {loading && trades.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 110, borderRadius: 10 }} />
          ))}
        </div>
      ) : trades.length === 0 ? (
        <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
          <div className="empty-state-icon">{"⇄"}</div>
          <div className="empty-state-title">No {statusFilter === "all" ? "" : statusFilter + " "}trades</div>
          <div className="empty-state-text">
            {direction === "incoming"
              ? "Trade offers sent to your wallet will appear here."
              : "Trades you send will appear here. Start one with “New trade offer”."}
          </div>
        </div>
      ) : direction === "board" ? (
        trades.map((t) => {
          const mine = t.offerer?.toLowerCase() === wallet.toLowerCase();
          const isActive = t.status === "active";
          return (
            <div key={t.id} style={{
              border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px",
              background: "var(--surface-glass)", marginBottom: 10,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>
                  {mine ? "YOUR POST" : <>BY <button onClick={() => onViewProfile?.(t.offerer)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "var(--mono)", fontSize: 10, color: "var(--naka-blue)" }}>{short(t.offerer)}</button></>}
                </span>
                <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: STATUS_COLOR[t.status] || "var(--text-dim)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{t.status}</span>
                  {isActive && <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>{timeLeft(t.expires_at)}</span>}
                </span>
              </div>
              <TradeSummary trade={t} viewer={wallet} />
              {isActive && (
                <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                  {mine ? (
                    <BoardOwnerActions trade={t} addToast={addToast} onChanged={load} />
                  ) : (
                    <button className="btn-primary" style={{ fontSize: 10, padding: "8px 16px" }} onClick={() => setAcceptTarget(t)}>
                      Accept this trade
                    </button>
                  )}
                </div>
              )}
              {t.status === "accepted" && t.accepted_tx && (
                <a href={`https://etherscan.io/tx/${t.accepted_tx}`} target="_blank" rel="noopener noreferrer"
                  style={{ display: "inline-block", marginTop: 10, fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)", textDecoration: "none" }}>
                  View settlement on Etherscan {"↗"}
                </a>
              )}
            </div>
          );
        })
      ) : (
        trades.map(t => (
          <TradeCard
            key={t.id}
            trade={t}
            direction={direction}
            wallet={wallet}
            addToast={addToast}
            onChanged={load}
            onCounter={(tr) => setCounterTrade(tr)}
            onPickProfile={onViewProfile}
            onMessage={(tr) => setDmContext({
              peer: direction === "incoming" ? tr.offerer : tr.target_owner,
              tradeId: tr.id,
            })}
          />
        ))
      )}

      {dmContext && (
        <div className="modal-bg" onClick={() => setDmContext(null)} style={{ zIndex: 1100 }} role="dialog" aria-modal="true" aria-label="Direct messages">
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg, #0b0b14)", border: "1px solid var(--border)", borderRadius: 14,
              width: "min(720px, 94vw)", maxHeight: "86vh", overflowY: "auto",
              padding: "18px 20px", margin: "6vh auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontFamily: "var(--pixel)", fontSize: 11, color: "var(--naka-blue)", letterSpacing: "0.1em" }}>MESSAGES</span>
              <button aria-label="Close modal" onClick={() => setDmContext(null)} className="btn-secondary" style={{ padding: "5px 11px", fontSize: 12 }}>{"✕"}</button>
            </div>
            <DirectMessages
              wallet={wallet}
              addToast={addToast}
              initialPeer={dmContext.peer}
              initialTradeId={dmContext.tradeId}
              embedded
            />
          </div>
        </div>
      )}

      {builderOpen && (
        <TradeWindow
          wallet={wallet}
          onClose={() => setBuilderOpen(false)}
          addToast={addToast}
          onCreated={() => { setDirection("outgoing"); load(); }}
        />
      )}
      {boardBuilderOpen && (
        <TradeWindow
          wallet={wallet}
          boardMode
          onClose={() => setBoardBuilderOpen(false)}
          addToast={addToast}
          onCreated={() => { setDirection("board"); load(); }}
        />
      )}
      {acceptTarget && (
        <OpenTradeAccept
          trade={acceptTarget}
          wallet={wallet}
          addToast={addToast}
          onClose={() => setAcceptTarget(null)}
          onAccepted={load}
        />
      )}
      {counterTrade && counterProps && (
        <TradeWindow
          wallet={wallet}
          {...counterProps}
          onClose={() => setCounterTrade(null)}
          addToast={addToast}
          onCreated={() => { setCounterTrade(null); load(); }}
        />
      )}
    </section>
  );
}
