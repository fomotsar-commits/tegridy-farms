import { useMemo, useState, useEffect, useCallback } from "react";
import { Eth } from "./Icons";
import { useActiveCollection } from "../contexts/CollectionContext";
import { fetchNativeListings, fulfillNativeOrder } from "../lib/orderbook";
import { PLATFORM_FEE_BPS } from "../constants";

// ═══ ORDER BOOK PANEL ═══
// Two sections:
//   1. Native Listings Table — browse & buy from our 1% fee orderbook
//   2. Depth Chart — bid/ask spread visualization (existing)

// OpenSea total fee = OS fee + creator royalty. We compare platform fee only.
const OPENSEA_FEE_PCT = 1.5; // OS 1% + ~0.5% avg creator royalty
const NATIVE_FEE_PCT = PLATFORM_FEE_BPS / 100; // 1%

function formatAddress(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = Date.now();
  const diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

// ── Native Listings Table ──
function NativeListingsTable({ wallet, onConnect, addToast }) {
  const collection = useActiveCollection();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [buying, setBuying] = useState(null); // order_hash being purchased

  const fetchOrders = useCallback(() => {
    if (!collection?.contract) return;
    setLoading(true);
    setError(null);
    fetchNativeListings(collection.contract).then(result => {
      if (result.error) {
        setError(result.error);
        setOrders([]);
      } else {
        setOrders(result.orders || []);
      }
      setLoading(false);
    });
  }, [collection?.contract]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    const t = setInterval(fetchOrders, 60000);
    return () => clearInterval(t);
  }, [fetchOrders]);

  const handleBuy = useCallback(async (order) => {
    if (!wallet) {
      onConnect?.();
      return;
    }
    setBuying(order.order_hash);
    addToast?.(`Purchasing #${order.token_id} for ${order.price_eth} ETH via native orderbook...`, "info");

    const result = await fulfillNativeOrder(order);

    if (result.success) {
      addToast?.(`Purchased #${order.token_id} for ${order.price_eth} ETH! Tx: ${result.hash.slice(0, 10)}...`, "success");
      // Refresh listings after successful purchase
      fetchOrders();
    } else if (result.error === "rejected") {
      addToast?.("Transaction cancelled", "info");
    } else if (result.error === "insufficient") {
      addToast?.("Insufficient ETH balance", "error");
    } else {
      addToast?.(`Failed: ${result.message || "Unknown error"}`, "error");
    }
    setBuying(null);
  }, [wallet, onConnect, addToast, fetchOrders]);

  // Fee savings calculation
  const savingsPerEth = OPENSEA_FEE_PCT - NATIVE_FEE_PCT;

  return (
    <div style={{
      background: "rgba(111,168,220,0.02)",
      border: "1px solid rgba(111,168,220,0.08)",
      borderRadius: 12,
      padding: 20,
      marginBottom: 24,
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 10, color: "var(--naka-blue)", letterSpacing: "0.1em" }}>
            NATIVE LISTINGS
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            Direct Seaport orders &middot; {NATIVE_FEE_PCT}% fee
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Fee savings badge */}
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10,
            background: "rgba(76,175,80,0.1)", border: "1px solid rgba(76,175,80,0.2)",
            borderRadius: 8, padding: "5px 10px",
            color: "var(--green)",
          }}>
            Save {savingsPerEth}% vs OpenSea
          </div>
          <button
            onClick={fetchOrders}
            style={{
              background: "transparent", border: "1px solid var(--border)",
              borderRadius: 6, padding: "5px 10px", cursor: "pointer",
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Fee comparison bar */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16,
        fontFamily: "var(--mono)", fontSize: 10,
      }}>
        <div style={{
          background: "rgba(76,175,80,0.06)", border: "1px solid rgba(76,175,80,0.15)",
          borderRadius: 8, padding: "8px 12px", textAlign: "center",
        }}>
          <div style={{ color: "var(--green)", fontWeight: 600 }}>Native: {NATIVE_FEE_PCT}%</div>
          <div style={{ color: "var(--text-muted)", fontSize: 9, marginTop: 2 }}>Platform fee only</div>
        </div>
        <div style={{
          background: "rgba(244,67,54,0.06)", border: "1px solid rgba(244,67,54,0.15)",
          borderRadius: 8, padding: "8px 12px", textAlign: "center",
        }}>
          <div style={{ color: "var(--red)" }}>OpenSea: ~{OPENSEA_FEE_PCT}%</div>
          <div style={{ color: "var(--text-muted)", fontSize: 9, marginTop: 2 }}>Marketplace + royalty</div>
        </div>
      </div>

      {/* Loading / Error / Empty states */}
      {loading && (
        <div style={{ textAlign: "center", padding: "20px 0", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
          <span className="pulse-dot" style={{ marginRight: 8 }} />
          Fetching native listings...
        </div>
      )}
      {!loading && error && (
        <div style={{
          textAlign: "center", padding: "16px 0",
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)",
        }}>
          {error === "Orderbook database not configured"
            ? "Native orderbook not yet configured for this deployment."
            : `Could not load native listings: ${error}`}
        </div>
      )}
      {!loading && !error && orders.length === 0 && (
        <div style={{
          textAlign: "center", padding: "20px 0",
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)",
        }}>
          No native listings for {collection.name} right now. Create one from the token detail panel.
        </div>
      )}

      {/* Listings table */}
      {!loading && !error && orders.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{
            width: "100%", borderCollapse: "collapse",
            fontFamily: "var(--mono)", fontSize: 11,
          }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={thStyle}>Token</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Price</th>
                <th style={thStyle}>Maker</th>
                <th style={thStyle}>Listed</th>
                <th style={thStyle}>Status</th>
                <th style={{ ...thStyle, textAlign: "center" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(order => {
                const isBuying = buying === order.order_hash;
                const isMine = wallet && order.maker?.toLowerCase() === wallet.toLowerCase();
                return (
                  <tr key={order.order_hash} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                    <td style={tdStyle}>
                      <span style={{ color: "var(--naka-blue)", fontWeight: 600 }}>
                        #{order.token_id || "?"}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--gold)" }}>
                        <Eth size={10} />
                        {Number(order.price_eth).toFixed(4)}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ color: "var(--text-dim)" }}>
                        {isMine ? "You" : formatAddress(order.maker)}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ color: "var(--text-muted)" }}>
                        {formatDate(order.created_at)}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{
                        display: "inline-block", padding: "2px 6px", borderRadius: 4,
                        fontSize: 9, letterSpacing: "0.04em",
                        background: order.status === "active" ? "rgba(76,175,80,0.1)" : "rgba(255,255,255,0.05)",
                        color: order.status === "active" ? "var(--green)" : "var(--text-muted)",
                      }}>
                        {order.status?.toUpperCase() || "ACTIVE"}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "center" }}>
                      {isMine ? (
                        <span style={{ fontSize: 9, color: "var(--text-muted)" }}>Your listing</span>
                      ) : (
                        <button
                          onClick={() => handleBuy(order)}
                          disabled={isBuying || order.status !== "active"}
                          style={{
                            background: isBuying ? "var(--surface)" : "var(--naka-blue)",
                            color: "#fff",
                            border: "none",
                            borderRadius: 6,
                            padding: "5px 14px",
                            cursor: isBuying ? "wait" : "pointer",
                            fontFamily: "var(--pixel)",
                            fontSize: 9,
                            letterSpacing: "0.04em",
                            opacity: isBuying ? 0.6 : 1,
                            transition: "opacity 0.15s",
                          }}
                        >
                          {isBuying ? "Buying..." : !wallet ? "Connect" : "Buy"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const thStyle = {
  textAlign: "left",
  padding: "8px 10px",
  fontFamily: "var(--mono)",
  fontSize: 9,
  color: "var(--text-muted)",
  letterSpacing: "0.06em",
  fontWeight: 400,
};

const tdStyle = {
  padding: "8px 10px",
};

// ── Depth Chart (existing visualization) ──

function bucketize(values, bucketCount = 10) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return [{ price: min, count: values.length, cumulative: values.length }];
  const step = (max - min) / bucketCount;
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    const lo = min + i * step;
    const hi = lo + step;
    const count = values.filter(v => v >= lo && (i === bucketCount - 1 ? v <= hi : v < hi)).length;
    buckets.push({ price: lo + step / 2, lo, hi, count });
  }
  return buckets;
}

function DepthChart({ listings = [], collectionOffers = [] }) {
  const { bidBuckets, askBuckets, spread, spreadPct, maxCumulative } = useMemo(() => {
    const askPrices = listings.map(l => l.price).filter(p => p != null && p > 0).sort((a, b) => a - b);
    const bidPrices = collectionOffers.map(o => o.price).filter(p => p != null && p > 0).sort((a, b) => b - a);

    const askBuckets = bucketize(askPrices, 8);
    const bidBuckets = bucketize(bidPrices, 8).reverse();

    let cumAsk = 0;
    for (const b of askBuckets) { cumAsk += b.count; b.cumulative = cumAsk; }
    let cumBid = 0;
    for (const b of bidBuckets) { cumBid += b.count; b.cumulative = cumBid; }

    const bestBid = bidPrices[0] || 0;
    const bestAsk = askPrices[0] || 0;
    const spread = bestAsk && bestBid ? bestAsk - bestBid : 0;
    const spreadPct = bestAsk && bestBid ? ((spread / bestAsk) * 100).toFixed(1) : null;
    const maxCumulative = Math.max(...askBuckets.map(b => b.cumulative), ...bidBuckets.map(b => b.cumulative), 1);

    return { bidBuckets, askBuckets, spread, spreadPct, maxCumulative };
  }, [listings, collectionOffers]);

  const hasBids = bidBuckets.some(b => b.count > 0);
  const hasAsks = askBuckets.some(b => b.count > 0);

  if (!hasBids && !hasAsks) return null;

  const bidPricesValid = collectionOffers.map(o => o.price).filter(p => p != null && p > 0);
  const askPricesValid = listings.map(l => l.price).filter(p => p != null && p > 0);
  const bestBid = bidPricesValid.length > 0 ? Math.max(...bidPricesValid) : null;
  const bestAsk = askPricesValid.length > 0 ? Math.min(...askPricesValid) : null;

  return (
    <div style={{
      background: "rgba(111,168,220,0.02)",
      border: "1px solid rgba(111,168,220,0.08)",
      borderRadius: 12,
      padding: "20px",
      marginBottom: 24,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 10, color: "var(--naka-blue)", letterSpacing: "0.1em" }}>
            ORDER BOOK
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            Bid/ask depth &middot; {listings.length} asks &middot; {collectionOffers.length} bids
          </div>
        </div>
        {spreadPct && (
          <div style={{
            fontFamily: "var(--mono)", fontSize: 11,
            background: "rgba(111,168,220,0.08)", borderRadius: 8, padding: "6px 12px",
          }}>
            <span style={{ color: "var(--text-muted)" }}>Spread </span>
            <span style={{ color: "var(--gold)" }}>{spread.toFixed(4)}</span>
            <span style={{ color: "var(--text-muted)" }}> ({spreadPct}%)</span>
          </div>
        )}
      </div>

      {/* Best Bid / Best Ask */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div style={{
          background: "rgba(76,175,80,0.06)", border: "1px solid rgba(76,175,80,0.15)",
          borderRadius: 8, padding: "10px 14px", textAlign: "center",
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)", letterSpacing: "0.1em", marginBottom: 4 }}>BEST BID</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--green)", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
            <Eth size={12} />{bestBid ? bestBid.toFixed(4) : "\u2014"}
          </div>
        </div>
        <div style={{
          background: "rgba(244,67,54,0.06)", border: "1px solid rgba(244,67,54,0.15)",
          borderRadius: 8, padding: "10px 14px", textAlign: "center",
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--red)", letterSpacing: "0.1em", marginBottom: 4 }}>BEST ASK</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--red)", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
            <Eth size={12} />{bestAsk ? bestAsk.toFixed(4) : "\u2014"}
          </div>
        </div>
      </div>

      {/* Depth bars */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginBottom: 8, letterSpacing: "0.05em" }}>BIDS (BUYERS)</div>
          {bidBuckets.map((b, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, height: 22 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", width: 52, textAlign: "right", flexShrink: 0 }}>{b.price.toFixed(4)}</span>
              <div style={{ flex: 1, position: "relative", height: 16, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${(b.cumulative / maxCumulative) * 100}%`, background: "rgba(76,175,80,0.15)", borderRadius: 3, transition: "width 0.3s ease" }} />
                <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${(b.count / maxCumulative) * 100}%`, background: "rgba(76,175,80,0.35)", borderRadius: 3, transition: "width 0.3s ease" }} />
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--green)", width: 28, textAlign: "right", flexShrink: 0 }}>{b.count || ""}</span>
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginBottom: 8, letterSpacing: "0.05em" }}>ASKS (SELLERS)</div>
          {askBuckets.map((b, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, height: 22 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--red)", width: 28, flexShrink: 0 }}>{b.count || ""}</span>
              <div style={{ flex: 1, position: "relative", height: 16, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(b.cumulative / maxCumulative) * 100}%`, background: "rgba(244,67,54,0.15)", borderRadius: 3, transition: "width 0.3s ease" }} />
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(b.count / maxCumulative) * 100}%`, background: "rgba(244,67,54,0.35)", borderRadius: 3, transition: "width 0.3s ease" }} />
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", width: 52, flexShrink: 0 }}>{b.price.toFixed(4)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══ MAIN EXPORT ═══

export default function OrderBookPanel({ listings = [], collectionOffers = [], floorPrice, wallet, onConnect, addToast }) {
  return (
    <>
      <NativeListingsTable wallet={wallet} onConnect={onConnect} addToast={addToast} />
      <DepthChart listings={listings} collectionOffers={collectionOffers} />
    </>
  );
}
