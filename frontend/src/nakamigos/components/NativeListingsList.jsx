import { Eth } from "./Icons";

// Moved verbatim from OrderBookPanel — used only by the native-listings list.
function formatAddress(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

// A single listing shows its token (#123); a bundle shows "Bundle · N NFTs" with the
// first few ids. token_ids is [{ contract, token_id }, ...] (migration 012).
function tokenLabel(order) {
  if (order.is_bundle) {
    const ids = Array.isArray(order.token_ids) ? order.token_ids : [];
    const shown = ids.slice(0, 3).map((t) => `#${t.token_id}`).join(", ");
    const more = ids.length > 3 ? ` +${ids.length - 3}` : "";
    return `Bundle · ${ids.length} NFTs${shown ? ` (${shown}${more})` : ""}`;
  }
  return `#${order.token_id || "?"}`;
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

// Order-validity + floor-relative context for a row. Both values come from data
// the row already carries — `end_time` (native_orders.end_time, NOT NULL per
// migration 002; the same field OrderBookPanel uses to drop expired rows) and
// the collection floor already passed into OrderBookPanel as `floorPrice`.
// Each helper returns null when its source is missing, so a row never shows a
// number we don't actually have.
function expiryLabel(endTime) {
  if (!endTime) return null;
  const ms = new Date(endTime).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "Expired";
  // Only warn when the window is actually closing — a 7-day-TTL listing with 5
  // days left is not news.
  if (ms > 24 * 3600 * 1000) return null;
  const hours = Math.floor(ms / 3600000);
  return hours >= 1 ? `Expires in ${hours}h` : `Expires in ${Math.max(1, Math.round(ms / 60000))}m`;
}

function floorDelta(priceEth, floorPrice) {
  const price = Number(priceEth);
  const floor = Number(floorPrice);
  if (!Number.isFinite(price) || !Number.isFinite(floor) || floor <= 0 || price <= 0) return null;
  const pct = ((price - floor) / floor) * 100;
  if (Math.abs(pct) < 1) return { label: "At floor", below: false };
  return { label: `${Math.abs(pct).toFixed(0)}% ${pct < 0 ? "below" : "above"} floor`, below: pct < 0 };
}

// Renders 0-2 chips. `floorPrice` is intentionally omitted for bundle rows by
// the caller: a bundle's price is a package total for N NFTs, so a floor-
// relative % would be nonsense. Expiry still applies to bundles.
function RowContext({ order, floorPrice }) {
  const expiry = expiryLabel(order.end_time);
  const delta = floorDelta(order.price_eth, floorPrice);
  if (!expiry && !delta) return null;
  const chip = {
    display: "inline-block", padding: "1px 5px", borderRadius: 4,
    fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.03em",
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6, flexWrap: "wrap" }}>
      {delta && (
        <span style={{
          ...chip,
          background: delta.below ? "rgba(76,175,80,0.10)" : "rgba(255,255,255,0.05)",
          color: delta.below ? "var(--green)" : "var(--text-muted)",
        }}>
          {delta.label}
        </span>
      )}
      {expiry && (
        <span
          style={{ ...chip, background: "rgba(255,178,55,0.10)", color: "var(--gold)" }}
          title={`Listing valid until ${new Date(order.end_time).toLocaleString()}`}
        >
          {expiry}
        </span>
      )}
    </span>
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

function StatusBadge({ status }) {
  const active = status === "active" || !status;
  return (
    <span style={{
      display: "inline-block", padding: "2px 6px", borderRadius: 4,
      fontSize: 9, letterSpacing: "0.04em",
      background: active ? "rgba(76,175,80,0.1)" : "rgba(255,255,255,0.05)",
      color: active ? "var(--green)" : "var(--text-muted)",
    }}>
      {status?.toUpperCase() || "ACTIVE"}
    </span>
  );
}

// Buy (or Cancel, if the viewer owns the listing). `full` stretches it to the
// card width on the mobile layout; the table keeps it inline.
function ActionButton({ order, wallet, isMine, buying, cancelling, onBuy, onCancel, full }) {
  const width = full ? { width: "100%" } : {};
  if (isMine) {
    return (
      <button
        onClick={() => onCancel(order)}
        disabled={cancelling === order.order_hash}
        style={{
          background: "rgba(248,113,113,0.06)",
          color: "var(--red)",
          border: "1px solid rgba(248,113,113,0.15)",
          borderRadius: 6,
          padding: full ? "9px 12px" : "5px 12px",
          cursor: cancelling === order.order_hash ? "wait" : "pointer",
          fontFamily: "var(--mono)",
          fontSize: 9,
          letterSpacing: "0.04em",
          opacity: cancelling === order.order_hash ? 0.6 : 1,
          ...width,
        }}
      >
        {cancelling === order.order_hash ? "..." : "Cancel"}
      </button>
    );
  }
  const isBuying = buying === order.order_hash;
  return (
    <button
      onClick={() => onBuy(order)}
      disabled={isBuying || order.status !== "active"}
      style={{
        background: isBuying ? "var(--surface)" : "var(--naka-blue)",
        color: "#fff",
        border: "none",
        borderRadius: 6,
        padding: full ? "9px 14px" : "5px 14px",
        cursor: isBuying ? "wait" : "pointer",
        fontFamily: "var(--pixel)",
        fontSize: 9,
        letterSpacing: "0.04em",
        opacity: isBuying ? 0.6 : 1,
        transition: "opacity 0.15s",
        ...width,
      }}
    >
      {isBuying ? "Buying..." : !wallet ? "Connect" : "Buy"}
    </button>
  );
}

/**
 * Pure presentational native-listings list. Renders the 6-column table on wide
 * viewports and stacked cards on narrow ones (<=640px), so the order book stops
 * horizontally scrolling on phones (the least-native pattern in the app). All
 * data and handlers come in as props — see OrderBookPanel for the source.
 */
export default function NativeListingsList({ orders, wallet, isNarrow, buying, cancelling, onBuy, onCancel, floorPrice }) {
  if (isNarrow) {
    return (
      <div data-testid="orderbook-cards" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {orders.map((order) => {
          const isMine = wallet && order.maker?.toLowerCase() === wallet.toLowerCase();
          return (
            <div key={order.order_hash} style={{
              border: "1px solid var(--border)", borderRadius: 8, padding: "11px 13px",
              background: "rgba(255,255,255,0.02)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--naka-blue)", fontWeight: 600 }}>
                  {tokenLabel(order)}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontFamily: "var(--mono)", fontSize: 13, color: "var(--gold)" }}>
                  <Eth size={11} /> {Number(order.price_eth).toFixed(4)}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 7, fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>
                <span>{isMine ? "You" : formatAddress(order.maker)} &middot; {formatDate(order.created_at)}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <RowContext order={order} floorPrice={floorPrice} />
                  <StatusBadge status={order.status} />
                </span>
              </div>
              <div style={{ marginTop: 10 }}>
                <ActionButton order={order} wallet={wallet} isMine={isMine} buying={buying} cancelling={cancelling} onBuy={onBuy} onCancel={onCancel} full />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 11 }}>
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
          {orders.map((order) => {
            const isMine = wallet && order.maker?.toLowerCase() === wallet.toLowerCase();
            return (
              <tr key={order.order_hash} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                <td style={tdStyle}>
                  <span style={{ color: "var(--naka-blue)", fontWeight: 600 }}>{tokenLabel(order)}</span>
                  <RowContext order={order} floorPrice={floorPrice} />
                </td>
                <td style={{ ...tdStyle, textAlign: "right" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--gold)" }}>
                    <Eth size={10} /> {Number(order.price_eth).toFixed(4)}
                  </span>
                </td>
                <td style={tdStyle}>
                  <span style={{ color: "var(--text-dim)" }}>{isMine ? "You" : formatAddress(order.maker)}</span>
                </td>
                <td style={tdStyle}>
                  <span style={{ color: "var(--text-muted)" }}>{formatDate(order.created_at)}</span>
                </td>
                <td style={tdStyle}>
                  <StatusBadge status={order.status} />
                </td>
                <td style={{ ...tdStyle, textAlign: "center" }}>
                  <ActionButton order={order} wallet={wallet} isMine={isMine} buying={buying} cancelling={cancelling} onBuy={onBuy} onCancel={onCancel} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
