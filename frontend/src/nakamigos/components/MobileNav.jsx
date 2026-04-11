import { useState, useCallback, useMemo } from "react";
import { useTradingMode, LITE_HIDDEN_ALL, LITE_HIDDEN_PRIMARY } from "../contexts/TradingModeContext";

const PRIMARY_TABS = [
  { key: "gallery", label: "Gallery", icon: "\u229E" },
  { key: "deals", label: "Deals", icon: "\uD83D\uDD25" },
  { key: "listings", label: "Floor", icon: "\uD83D\uDCB0" },
  { key: "activity", label: "Activity", icon: "\u26A1" },
  { key: "favorites", label: "Favs", icon: "\u2665" },
];

const MORE_TABS = [
  { key: "sniper", label: "Sniper" },
  { key: "traits", label: "Traits" },
  { key: "analytics", label: "Analytics" },
  { key: "trade", label: "Trade" },
  { key: "watchlist", label: "Watchlist" },
  { key: "bids", label: "Bids" },
  { key: "alerts", label: "Alerts" },
  { key: "chat", label: "Chat" },
  { key: "collection", label: "My NFTs" },
  { key: "portfolio", label: "P&L" },
  { key: "history", label: "History" },
  { key: "whales", label: "Whales" },
  { key: "my-listings", label: "My Listings" },
  { key: "about", label: "About" },
];

export default function MobileNav({ tab, onTabChange }) {
  const { isLite } = useTradingMode();
  const [moreOpen, setMoreOpen] = useState(false);

  const filteredPrimary = useMemo(
    () => isLite ? PRIMARY_TABS.filter((t) => !LITE_HIDDEN_PRIMARY.has(t.key)) : PRIMARY_TABS,
    [isLite],
  );
  const filteredMore = useMemo(
    () => isLite ? MORE_TABS.filter((t) => !LITE_HIDDEN_ALL.has(t.key)) : MORE_TABS,
    [isLite],
  );

  const handleTab = useCallback((key) => {
    onTabChange(key);
    setMoreOpen(false);
  }, [onTabChange]);

  const isMoreActive = filteredMore.some((t) => t.key === tab);

  return (
    <>
      {/* More menu overlay */}
      {moreOpen && (
        <div
          style={{
            position: "fixed",
            bottom: 60,
            left: 0,
            right: 0,
            zIndex: 9998,
            background: "var(--surface)",
            borderTop: "1px solid var(--border)",
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            padding: "16px 12px",
            maxHeight: "50vh",
            overflowY: "auto",
            boxShadow: "0 -8px 32px rgba(0,0,0,0.5)",
            opacity: 1,
            transition: "opacity 0.2s ease, transform 0.2s ease",
          }}
        >
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 6,
          }}>
            {filteredMore.map((t) => (
              <button
                key={t.key}
                onClick={() => handleTab(t.key)}
                style={{
                  padding: "12px 8px",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: tab === t.key ? "rgba(111,168,220,0.12)" : "var(--surface-glass)",
                  color: tab === t.key ? "var(--naka-blue)" : "var(--text-dim)",
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  cursor: "pointer",
                  transition: "background 0.15s, color 0.15s",
                  textAlign: "center",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scrim behind more menu */}
      {moreOpen && (
        <div
          onClick={() => setMoreOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9997,
            background: "rgba(0,0,0,0.4)",
          }}
        />
      )}

      {/* Bottom nav bar */}
      <nav
        className="mobile-bottom-nav"
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          display: "none", // shown via CSS media query
          background: "var(--surface)",
          borderTop: "1px solid var(--border)",
          backdropFilter: "var(--glass-blur)",
          padding: "6px 0 max(6px, env(safe-area-inset-bottom))",
        }}
        aria-label="Bottom navigation"
      >
        <div style={{
          display: "flex",
          justifyContent: "space-around",
          alignItems: "center",
          maxWidth: 480,
          margin: "0 auto",
        }}>
          {filteredPrimary.map((t) => (
            <button
              key={t.key}
              onClick={() => handleTab(t.key)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "4px 8px",
                color: tab === t.key ? "var(--naka-blue)" : "var(--text-dim)",
                transition: "color 0.15s",
                minWidth: 48,
              }}
              aria-label={t.label}
            >
              <span style={{ fontSize: 18 }}>{t.icon}</span>
              <span style={{
                fontFamily: "var(--mono)",
                fontSize: 8,
                fontWeight: tab === t.key ? 700 : 400,
                letterSpacing: "0.02em",
              }}>
                {t.label}
              </span>
            </button>
          ))}

          {/* More button */}
          <button
            onClick={() => setMoreOpen((v) => !v)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "4px 8px",
              color: moreOpen || isMoreActive ? "var(--naka-blue)" : "var(--text-dim)",
              transition: "color 0.15s",
              minWidth: 48,
            }}
            aria-label="More tabs"
            aria-expanded={moreOpen}
          >
            <span style={{ fontSize: 18 }}>{"\u2026"}</span>
            <span style={{
              fontFamily: "var(--mono)",
              fontSize: 8,
              fontWeight: moreOpen || isMoreActive ? 700 : 400,
              letterSpacing: "0.02em",
            }}>
              More
            </span>
          </button>
        </div>
      </nav>
    </>
  );
}
