import { useState, useEffect, useCallback, useRef } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { fetchCollectionStats } from "../api";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useWallet } from "../contexts/WalletContext";

const CHECK_INTERVAL = 30000;

function loadAlerts(slug = "nakamigos", wallet = "") {
  try {
    const key = wallet ? `${slug}_${wallet}_price_alerts` : `${slug}_price_alerts`;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAlerts(alerts, slug = "nakamigos", wallet = "") {
  try {
    const key = wallet ? `${slug}_${wallet}_price_alerts` : `${slug}_price_alerts`;
    localStorage.setItem(key, JSON.stringify(alerts));
  } catch { /* quota exceeded — alerts won't persist but app continues */ }
}

// Price alerts monitor the collection floor price.
// Individual token prices aren't available from the NFT metadata API,
// so alerts trigger based on floor price changes fetched from Alchemy.
export function usePriceAlerts(tokens = [], addToast) {
  const collection = useActiveCollection();
  const { address: wallet } = useWallet();
  const [alerts, setAlerts] = useState(() => loadAlerts(collection.slug, wallet));
  const [floorPrice, setFloorPrice] = useState(null);
  const [notificationPermission, setNotificationPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;

  // Reload alerts + reset floor when the active collection or wallet changes
  const prevSlugRef = useRef(collection.slug);
  const prevWalletRef = useRef(wallet);
  useEffect(() => {
    if (prevSlugRef.current !== collection.slug || prevWalletRef.current !== wallet) {
      prevSlugRef.current = collection.slug;
      prevWalletRef.current = wallet;
      setAlerts(loadAlerts(collection.slug, wallet));
      setFloorPrice(null);
    }
  }, [collection.slug, wallet]);

  useEffect(() => {
    saveAlerts(alerts, collection.slug, wallet);
  }, [alerts, collection.slug, wallet]);

  // Fetch floor price periodically for alert checking
  useEffect(() => {
    let cancelled = false;
    async function fetchFloor() {
      try {
        const stats = await fetchCollectionStats({ contract: collection.contract, slug: collection.slug, openseaSlug: collection.openseaSlug });
        if (!cancelled && stats.floor != null) setFloorPrice(stats.floor);
      } catch {
        // Silently fail — alerts will just not trigger this cycle
      }
    }
    fetchFloor();
    const interval = setInterval(fetchFloor, CHECK_INTERVAL);
    return () => { cancelled = true; clearInterval(interval); };
  }, [collection.contract, collection.slug, collection.openseaSlug]);

  const requestNotificationPermission = useCallback(async () => {
    try {
      if (typeof Notification === "undefined") return "denied";
      const perm = await Notification.requestPermission();
      setNotificationPermission(perm);
      return perm;
    } catch { return "denied"; }
  }, []);

  const addAlert = useCallback(
    ({ tokenId, tokenName, targetPrice, direction }) => {
      const newAlert = {
        id: crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2),
        tokenId,
        tokenName,
        targetPrice: parseFloat(targetPrice),
        direction: direction || "below",
        createdAt: new Date().toISOString(),
        triggered: false,
        notified: false,
      };
      setAlerts((prev) => [...prev, newAlert]);
      return newAlert;
    },
    []
  );

  const removeAlert = useCallback((id) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const updateAlert = useCallback((id, updates) => {
    setAlerts((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...updates } : a))
    );
  }, []);

  const getAlerts = useCallback(() => alertsRef.current, []);

  // Check alerts against the collection floor price
  const checkAlerts = useCallback(() => {
    if (floorPrice == null) return;

    setAlerts((prev) => {
      let changed = false;
      const next = prev.map((alert) => {
        // Use floor price as the price reference
        const price = floorPrice;

        const shouldTrigger =
          (alert.direction === "below" && price <= alert.targetPrice) ||
          (alert.direction === "above" && price >= alert.targetPrice);

        // Only reset triggered state when price has moved significantly away
        // from the threshold to prevent re-notification on small price
        // oscillations around the alert boundary.
        if (!shouldTrigger && alert.triggered) {
          const pctAway = Math.abs(price - alert.targetPrice) / (alert.targetPrice || 1);
          // Require price to move at least 5% away from target before re-arming
          if (pctAway >= 0.05) {
            changed = true;
            return { ...alert, triggered: false, notified: false };
          }
        }

        if (shouldTrigger && !alert.triggered) {
          changed = true;
          const dirLabel = alert.direction === "below" ? "dropped below" : "risen above";
          const body = `Floor price has ${dirLabel} ${alert.targetPrice} ETH (now ${price} ETH) — Alert: ${alert.tokenName}`;

          if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            try {
              new Notification(`${collection.name} Price Alert`, { body });
            } catch {
              // Notification constructor can throw in some contexts
            }
          }

          if (addToast) {
            addToast(body, "success");
          }

          return { ...alert, triggered: true, notified: true };
        }
        return alert;
      });
      return changed ? next : prev;
    });
  }, [floorPrice, addToast, collection.name]);

  useEffect(() => {
    checkAlerts();
  }, [checkAlerts]);

  return {
    alerts,
    floorPrice,
    addAlert,
    removeAlert,
    updateAlert,
    getAlerts,
    checkAlerts,
    requestNotificationPermission,
    notificationPermission,
  };
}

/* ─── Styles ─── */

const styles = {
  panel: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 20,
    fontFamily: "var(--mono)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  title: {
    fontFamily: "var(--display)",
    fontSize: 18,
    color: "var(--gold)",
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: 0,
    whiteSpace: "nowrap",
  },
  bellIcon: {
    fontSize: 20,
    lineHeight: 1,
  },
  permissionBtn: {
    background: "var(--naka-blue)",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontFamily: "var(--pixel)",
    fontSize: 12,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  form: {
    display: "flex",
    gap: 8,
    marginBottom: 16,
    flexWrap: "wrap",
    alignItems: "center",
  },
  input: {
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "6px 10px",
    color: "inherit",
    fontFamily: "var(--mono)",
    fontSize: 13,
    outline: "none",
    minWidth: 0,
  },
  searchInput: {
    flex: "1 1 140px",
  },
  priceInput: {
    width: 90,
  },
  toggleGroup: {
    display: "flex",
    borderRadius: 6,
    overflow: "hidden",
    border: "1px solid var(--border)",
  },
  toggleBtn: (active) => ({
    background: active ? "var(--gold)" : "var(--card)",
    color: active ? "#000" : "inherit",
    border: "none",
    padding: "6px 10px",
    fontFamily: "var(--pixel)",
    fontSize: 11,
    cursor: "pointer",
    transition: "background 0.2s",
  }),
  addBtn: {
    background: "var(--green)",
    color: "var(--bg)",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontFamily: "var(--pixel)",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 700,
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  alertItem: (triggered) => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    background: "var(--card)",
    border: triggered ? "1px solid var(--green)" : "1px solid var(--border)",
    borderRadius: 8,
    boxShadow: triggered ? "0 0 12px rgba(0,255,120,0.25)" : "none",
    animation: triggered ? "pulseGlow 2s ease-in-out infinite" : "none",
    transition: "box-shadow 0.3s, border-color 0.3s",
  }),
  alertImage: {
    width: 36,
    height: 36,
    borderRadius: 6,
    objectFit: "cover",
    flexShrink: 0,
  },
  alertInfo: {
    flex: 1,
    minWidth: 0,
  },
  alertName: {
    fontFamily: "var(--display)",
    fontSize: 14,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  alertMeta: {
    fontSize: 12,
    opacity: 0.7,
    display: "flex",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  directionBadge: (direction) => ({
    fontSize: 10,
    fontFamily: "var(--pixel)",
    padding: "1px 6px",
    borderRadius: 4,
    background: direction === "above" ? "var(--green)" : "var(--red)",
    color: "var(--bg)",
    fontWeight: 700,
    textTransform: "uppercase",
  }),
  triggeredBadge: {
    fontSize: 10,
    fontFamily: "var(--pixel)",
    padding: "1px 6px",
    borderRadius: 4,
    background: "var(--green)",
    color: "var(--bg)",
    fontWeight: 700,
    marginLeft: 4,
  },
  removeBtn: {
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--red)",
    cursor: "pointer",
    padding: "4px 8px",
    fontSize: 14,
    lineHeight: 1,
    flexShrink: 0,
    fontFamily: "var(--mono)",
  },
  empty: {
    textAlign: "center",
    fontFamily: "var(--pixel)",
    fontSize: 12,
    padding: "28px 16px",
    background: "var(--card)",
    border: "1px dashed var(--border)",
    borderRadius: 8,
  },
  dropdown: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    maxHeight: 180,
    overflowY: "auto",
    zIndex: 20,
    marginTop: 2,
  },
  dropdownItem: {
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: "var(--mono)",
    display: "flex",
    alignItems: "center",
    gap: 8,
    borderBottom: "1px solid var(--border)",
  },
};

const keyframesInjected = { current: false };

function injectKeyframes() {
  if (keyframesInjected.current) return;
  keyframesInjected.current = true;
  const sheet = document.createElement("style");
  sheet.textContent = `
    @keyframes pulseGlow {
      0%, 100% { box-shadow: 0 0 8px rgba(0,255,120,0.2); }
      50% { box-shadow: 0 0 20px rgba(0,255,120,0.45); }
    }
  `;
  document.head.appendChild(sheet);
}

/* ─── Component ─── */

export default function PriceAlertPanel({ tokens = [], addToast }) {
  const collection = useActiveCollection();
  const {
    alerts,
    floorPrice,
    addAlert,
    removeAlert,
    requestNotificationPermission,
    notificationPermission,
  } = usePriceAlerts(tokens, addToast);

  const [search, setSearch] = useState("");
  const [price, setPrice] = useState("");
  const [direction, setDirection] = useState("below");
  const [selectedToken, setSelectedToken] = useState(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchRef = useRef(null);

  // Reset form state when collection changes
  const prevSlugRef = useRef(collection.slug);
  useEffect(() => {
    if (prevSlugRef.current !== collection.slug) {
      prevSlugRef.current = collection.slug;
      setSearch("");
      setPrice("");
      setDirection("below");
      setSelectedToken(null);
      setShowDropdown(false);
    }
  }, [collection.slug]);

  useEffect(() => {
    injectKeyframes();
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = search.length >= 1
    ? tokens
        .filter(
          (t) =>
            (t.name || `#${t.id ?? t.tokenId}`)
              .toLowerCase()
              .includes(search.toLowerCase())
        )
        .slice(0, 8)
    : [];

  const handleSelect = (token) => {
    setSelectedToken(token);
    setSearch(token.name || `#${token.id ?? token.tokenId}`);
    setShowDropdown(false);
  };

  const handleAdd = () => {
    const parsedPrice = parseFloat(price);
    if (!selectedToken || !price || isNaN(parsedPrice) || parsedPrice <= 0) {
      if (addToast) addToast("Please select a token and enter a valid price greater than 0.", "error");
      return;
    }
    addAlert({
      tokenId: selectedToken.id ?? selectedToken.tokenId,
      tokenName: selectedToken.name || `#${selectedToken.id ?? selectedToken.tokenId}`,
      targetPrice: price,
      direction,
    });
    setSearch("");
    setPrice("");
    setSelectedToken(null);
    if (addToast) addToast("Price alert created!", "success");
  };

  const permissionGranted = notificationPermission === "granted";

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <h3 style={styles.title}>
          <span style={styles.bellIcon}>
            {permissionGranted ? "\uD83D\uDD14" : "\uD83D\uDD15"}
          </span>
          Floor Price Alerts
        </h3>
        {!permissionGranted && (
          <button
            style={styles.permissionBtn}
            onClick={async () => {
              const result = await requestNotificationPermission();
              if (result === "granted" && addToast) {
                addToast("Notifications enabled!", "success");
              } else if (result === "denied" && addToast) {
                addToast("Notification permission was denied. You can enable it in your browser settings.", "error");
              }
            }}
          >
            <span style={styles.bellIcon}>{"\uD83D\uDD14"}</span>
            Enable Notifications
          </button>
        )}
      </div>

      {/* Current Floor */}
      <div style={{
        fontFamily: "var(--mono)",
        fontSize: 12,
        color: "var(--text-dim)",
        marginBottom: 12,
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
      }}>
        {floorPrice != null ? (
          <>
            {collection.name} floor: <Eth size={10} /> <span style={{ color: "var(--gold)", fontWeight: 700 }}>{floorPrice.toFixed(4)}</span>
            <span style={{ fontSize: 10, opacity: 0.5 }}>(alerts trigger based on floor price)</span>
          </>
        ) : (
          <span style={{ opacity: 0.5 }}>Loading {collection.name} floor price...</span>
        )}
      </div>

      {/* Add Alert Form */}
      <div style={styles.form}>
        <div
          ref={searchRef}
          style={{ position: "relative", flex: "1 1 140px" }}
        >
          <input
            type="text"
            aria-label="Search token name"
            placeholder="Label (e.g. token name)..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelectedToken(null);
              setShowDropdown(true);
            }}
            onFocus={() => search.length >= 1 && setShowDropdown(true)}
            style={{ ...styles.input, ...styles.searchInput, width: "100%" }}
          />
          {showDropdown && filtered.length > 0 && (
            <div style={styles.dropdown}>
              {filtered.map((t) => {
                const tid = t.id ?? t.tokenId;
                return (
                  <div
                    key={tid}
                    style={styles.dropdownItem}
                    onMouseDown={() => handleSelect(t)}
                  >
                    <NftImage
                      nft={t}
                      style={styles.alertImage}
                    />
                    <span>{t.name || `#${tid}`}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <input
          type="number"
          inputMode="decimal"
          aria-label="Alert target price in ETH"
          placeholder="Price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          style={{ ...styles.input, ...styles.priceInput }}
          step="0.01"
          min="0"
        />

        <div style={styles.toggleGroup}>
          <button
            style={styles.toggleBtn(direction === "below")}
            onClick={() => setDirection("below")}
          >
            Below
          </button>
          <button
            style={styles.toggleBtn(direction === "above")}
            onClick={() => setDirection("above")}
          >
            Above
          </button>
        </div>

        <button type="button" style={styles.addBtn} onClick={handleAdd}>
          + Add
        </button>
      </div>

      {/* Alerts List */}
      {alerts.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">{"\uD83D\uDD14"}</div>
          <div className="empty-state-title">No floor price alerts for {collection.name}</div>
          <div className="empty-state-text">
            Set a target floor price above to get notified when the collection floor moves. Alerts monitor the collection floor price, not individual token prices.
          </div>
        </div>
      ) : (
        <ul style={styles.list}>
          {alerts.map((alert) => {
            const token = tokens.find(
              (t) => (t.id ?? t.tokenId) === alert.tokenId
            );
            return (
              <li key={alert.id} style={styles.alertItem(alert.triggered)}>
                {token && (
                  <NftImage
                    nft={token}
                    style={styles.alertImage}
                  />
                )}
                <div style={styles.alertInfo}>
                  <div style={styles.alertName}>{alert.tokenName}</div>
                  <div style={styles.alertMeta}>
                    <span style={styles.directionBadge(alert.direction)}>
                      {alert.direction}
                    </span>
                    <Eth size={10} />
                    <span>{alert.targetPrice}</span>
                    {alert.triggered && (
                      <span style={styles.triggeredBadge}>TRIGGERED</span>
                    )}
                  </div>
                </div>
                <button
                  style={styles.removeBtn}
                  onClick={() => removeAlert(alert.id)}
                  title="Remove alert"
                  aria-label={`Remove alert for ${alert.tokenName}`}
                >
                  &times;
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
