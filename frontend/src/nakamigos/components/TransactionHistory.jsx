import { useState, useEffect, useMemo } from "react";
import { Eth } from "./Icons";
import { formatPrice } from "../lib/formatPrice";
import { useActiveCollection } from "../contexts/CollectionContext";

// Re-export from lib so existing lazy-import consumers still work
export { recordTransaction } from "../lib/transactions";

function loadHistory(slug = "nakamigos") {
  try {
    return JSON.parse(localStorage.getItem(`${slug}_tx_history`) || "[]");
  } catch {
    return [];
  }
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
            Connect your wallet to view your {collectionName} transaction history.
          </p>
          {onConnect && (
            <button className="btn-primary wallet-connect-btn" onClick={onConnect}>
              Connect Wallet
            </button>
          )}
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
          No {collectionName} transactions yet
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)", maxWidth: 280, margin: "0 auto", lineHeight: 1.5 }}>
          Purchases, offers, and bids you make for this collection will appear here.
        </div>
      </div>
    );
  }

  return (
    <section style={{ maxWidth: 800, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{
        fontFamily: "var(--display)", fontSize: 18, fontWeight: 700,
        color: "var(--text)", letterSpacing: "-0.01em", marginBottom: 4,
      }}>
        Transaction History
      </h2>
      <p style={{
        fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)",
        marginBottom: 20,
      }}>
        {collectionName} &middot; {walletHistory.length} transaction{walletHistory.length !== 1 ? "s" : ""}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {walletHistory.map(tx => (
          <div key={tx.id} style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "12px 16px", borderRadius: 10,
            background: "var(--border)", border: "1px solid var(--border)",
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
