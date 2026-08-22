import { useState, useEffect, useMemo } from "react";
import { Eth } from "./Icons";
import { formatPrice } from "../lib/formatPrice";
import { useActiveCollection } from "../contexts/CollectionContext";

// Re-export from lib so existing lazy-import consumers still work
export { recordTransaction } from "../lib/transactions";

// ─── WHAT THIS SURFACE ACTUALLY IS ───
// The only store behind this page is `localStorage[<slug>_tx_history]`, written
// by lib/transactions.recordTransaction() as the user trades IN THIS BROWSER.
// There is no server read anywhere in this file. That means:
//   · a second device, a second browser, or a private window shows NOTHING;
//   · clearing site data erases it permanently;
//   · anything transacted outside this app never appears at all;
//   · the ring buffer is capped at 50 entries per collection (transactions.js:32).
// Presented as "your transaction history" that reads as data loss or as proof a
// trade never happened. Backing it with the real record needs an indexer/DB the
// front end does not own, so until that exists the page states its own scope
// instead of implying one it cannot honour. Every honesty string below is
// exercised by localHistoryHonesty.test.jsx — keep them and the source in sync.

function loadHistory(slug = "nakamigos") {
  try {
    return JSON.parse(localStorage.getItem(`${slug}_tx_history`) || "[]");
  } catch {
    return [];
  }
}

/** Shared scope disclosure. Rendered on every state of this page — an empty list
 *  is exactly the state a user most needs it on, because that is when a
 *  device-local log is indistinguishable from "you never traded". */
function DeviceLocalNote({ wallet, compact = false }) {
  return (
    <div
      data-testid="history-scope-note"
      style={{
        fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.6,
        color: "var(--text-muted)", textAlign: compact ? "center" : "left",
        maxWidth: compact ? 340 : "none", margin: compact ? "14px auto 0" : "0 0 18px",
        padding: "10px 14px", borderRadius: 8,
        background: "rgba(111,168,220,0.04)",
        border: "1px solid rgba(111,168,220,0.12)",
      }}
    >
      <strong style={{ color: "var(--text-dim)", fontWeight: 700 }}>
        Saved on this device only.
      </strong>{" "}
      This log is written by your browser as you trade here — it is not synced to an
      account. It will look empty on another device or browser, clearing your site
      data erases it, and trades made outside this app never appear.
      {wallet && /^0x[a-fA-F0-9]{40}$/.test(wallet) && (
        <>
          {" "}For the complete, authoritative record,{" "}
          <a
            href={`https://etherscan.io/address/${wallet}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--naka-blue)", textDecoration: "underline" }}
          >
            view this wallet on Etherscan
          </a>.
        </>
      )}
    </div>
  );
}

function formatTime(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  // Older than 7 days: show a concrete date
  const d = new Date(ts);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const year = d.getFullYear();
  const now = new Date();
  return year === now.getFullYear() ? `${month} ${day}` : `${month} ${day}, ${year}`;
}

const TYPE_COLORS = {
  buy: "#4ade80", sale: "#4ade80", offer: "#818cf8",
  bid: "#fbbf24", list: "#38bdf8", cancel: "#f87171",
  transfer: "#a78bfa",
};
const TYPE_LABELS = {
  buy: "Purchase", sale: "Sale", offer: "Offer",
  bid: "Bid", list: "Listed", cancel: "Cancelled",
  transfer: "Transfer",
};

export default function TransactionHistory({ wallet, onConnect }) {
  const { slug, name: collectionName } = useActiveCollection();
  const [history, setHistory] = useState(() => loadHistory(slug));

  // Reload history when collection changes
  useEffect(() => {
    setHistory(loadHistory(slug));
  }, [slug]);

  // Refresh when tab gets focus (catches updates from other components)
  useEffect(() => {
    const onFocus = () => setHistory(loadHistory(slug));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [slug]);

  const walletHistory = useMemo(() => {
    if (!wallet) return [];
    return history.filter(tx => tx.wallet?.toLowerCase() === wallet.toLowerCase());
  }, [history, wallet]);

  if (!wallet) {
    return (
      <section style={{ maxWidth: 800, margin: "0 auto", padding: "40px 16px" }}>
        <div className="wallet-connect-prompt">
          <div className="wallet-connect-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z" />
              <path d="M8 7h8M8 11h8M8 15h4" />
            </svg>
          </div>
          <h3 className="wallet-connect-title">Connect Your Wallet</h3>
          <p className="wallet-connect-desc">
            Connect your wallet to view the {collectionName} activity this browser has
            recorded for it.
          </p>
          {onConnect && (
            <button className="btn-primary wallet-connect-btn" onClick={onConnect}>
              Connect Wallet
            </button>
          )}
          <DeviceLocalNote compact />
        </div>
      </section>
    );
  }

  if (walletHistory.length === 0) {
    return (
      <div style={{ padding: "80px 20px", textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.4 }}>
          {/* receipt icon */}
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)" }}>
            <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z" />
            <path d="M8 7h8M8 11h8M8 15h4" />
          </svg>
        </div>
        <div style={{ fontFamily: "var(--display)", fontSize: 14, fontWeight: 600, color: "var(--text-dim)", marginBottom: 6 }}>
          Nothing recorded on this device yet
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)", maxWidth: 280, margin: "0 auto", lineHeight: 1.5 }}>
          Purchases, offers, and bids you make for this collection{" "}
          <em style={{ fontStyle: "normal", color: "var(--text-dim)" }}>in this browser</em> will
          appear here.
        </div>
        <DeviceLocalNote wallet={wallet} compact />
      </div>
    );
  }

  return (
    <section style={{ maxWidth: 800, margin: "0 auto", padding: "20px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <h2 style={{
          fontFamily: "var(--display)", fontSize: 18, fontWeight: 700,
          color: "var(--text)", letterSpacing: "-0.01em", margin: 0,
        }}>
          Transaction History
        </h2>
        {/* The qualifier sits IN the heading line, not buried below it: the title
            alone is the claim a user acts on when a second device looks empty. */}
        <span
          data-testid="history-scope-pill"
          title="Recorded by this browser only — not synced to your account"
          style={{
            fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.06em",
            padding: "3px 9px", borderRadius: 999,
            color: "var(--text-dim)", border: "1px solid var(--border)",
            background: "rgba(255,255,255,0.03)", whiteSpace: "nowrap",
          }}
        >
          THIS DEVICE ONLY
        </span>
      </div>
      <p style={{
        fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)",
        marginBottom: 14,
      }}>
        {collectionName} &middot; {walletHistory.length} transaction{walletHistory.length !== 1 ? "s" : ""} recorded here
      </p>
      <DeviceLocalNote wallet={wallet} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {walletHistory.map(tx => (
          <div key={tx.id} style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "12px 16px", borderRadius: 10,
            background: "var(--surface-glass)", border: "1px solid var(--border)",
          }}>
            <div style={{ width: 44, height: 44, borderRadius: 8, overflow: "hidden", flexShrink: 0, border: "1px solid var(--border)" }}>
              {tx.image ? (
                <img src={tx.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" />
              ) : (
                <div style={{ width: "100%", height: "100%", background: "var(--surface)", display: "grid", placeItems: "center", fontFamily: "var(--pixel)", fontSize: 8, color: "var(--text-dim)" }}>?</div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--display)", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                {tx.name}
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", marginTop: 2, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: TYPE_COLORS[tx.type] || "var(--text-dim)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {TYPE_LABELS[tx.type] || tx.type}
                </span>
                <span>{formatTime(tx.timestamp)}</span>
              </div>
            </div>
            {tx.price != null && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700, color: "var(--gold, #d4a843)", display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
                <Eth />{formatPrice(tx.price)}
              </div>
            )}
            {tx.hash && /^0x[a-fA-F0-9]{64}$/.test(tx.hash) && (
              <a
                href={`https://etherscan.io/tx/${tx.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--naka-blue)", textDecoration: "none", flexShrink: 0 }}
                title="View on Etherscan"
              >
                TX &#8599;
              </a>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
