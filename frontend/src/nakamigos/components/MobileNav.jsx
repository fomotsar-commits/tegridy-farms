import { useState, useCallback, useMemo } from "react";
import { useTradingMode, LITE_HIDDEN_ALL, LITE_HIDDEN_PRIMARY } from "../contexts/TradingModeContext";

// One line-drawn icon per tab, all on the same 24px grid and stroke.
const ICON_PATHS = {
  gallery: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
  deals: <><path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L2 12V2h10l8.6 8.6a2 2 0 010 2.8z" /><line x1="7" y1="7" x2="7.01" y2="7" /></>,
  listings: <><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></>,
  activity: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
  favorites: <path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 00-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 000-7.8z" />,
  about: <><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  dot: <circle cx="12" cy="12" r="2" />,
};

function TabIcon({ name }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name] || ICON_PATHS.dot}
    </svg>
  );
}

export const PRIMARY_TABS = [
  { key: "gallery", label: "Gallery", icon: "gallery" },
  { key: "deals", label: "Deals", icon: "deals" },
  { key: "listings", label: "Floor", icon: "listings" },
  { key: "activity", label: "Activity", icon: "activity" },
  { key: "favorites", label: "Favs", icon: "favorites" },
];

export const MORE_TABS = [
  { key: "pro", label: "Pro" },
  { key: "trades", label: "Trade Offers" },
  { key: "sniper", label: "Sniper" },
  { key: "traits", label: "Traits" },
  { key: "analytics", label: "Analytics" },
  { key: "trade", label: "Compare" },
  { key: "watchlist", label: "Watchlist" },
  { key: "bids", label: "Bids" },
  { key: "alerts", label: "Alerts" },
  { key: "chat", label: "Chat" },
  { key: "collection", label: "My NFTs" },
  { key: "portfolio", label: "P&L" },
  { key: "history", label: "History" },
  { key: "whales", label: "Whales" },
  { key: "integrity", label: "Integrity" },
  { key: "my-listings", label: "My Listings" },
  { key: "about", label: "About" },
];

// `allowedTabs` (a Set) fixes the bar to a collection's own tabs: they show
// as primary tabs and the More menu is not offered.
export default function MobileNav({ tab, onTabChange, allowedTabs }) {
  const { isLite } = useTradingMode();
  const [moreOpen, setMoreOpen] = useState(false);

  const filteredPrimary = useMemo(() => {
    if (allowedTabs) {
      return [...PRIMARY_TABS, ...MORE_TABS]
        .filter((t) => allowedTabs.has(t.key))
        // A More tab promoted to the bar takes its own icon where one is drawn.
        .map((t) => ({ ...t, icon: t.icon || (ICON_PATHS[t.key] ? t.key : "dot") }));
    }
    return isLite ? PRIMARY_TABS.filter((t) => !LITE_HIDDEN_PRIMARY.has(t.key)) : PRIMARY_TABS;
  }, [isLite, allowedTabs]);
  const filteredMore = useMemo(() => {
    if (allowedTabs) return [];
    return isLite ? MORE_TABS.filter((t) => !LITE_HIDDEN_ALL.has(t.key)) : MORE_TABS;
  }, [isLite, allowedTabs]);

  const handleTab = useCallback((key) => {
    onTabChange(key);
    setMoreOpen(false);
  }, [onTabChange]);

  const isMoreActive = filteredMore.some((t) => t.key === tab);

  return (
    <>
      {/* Scrim behind the More sheet */}
      {moreOpen && <div className="mk-sheet-scrim" onClick={() => setMoreOpen(false)} />}

      {/* The More sheet */}
      {moreOpen && (
        <div className="mk-sheet">
          <div className="mk-sheet-grid">
            {filteredMore.map((t) => (
              <button
                key={t.key}
                className="mk-sheet-item"
                onClick={() => handleTab(t.key)}
                aria-current={tab === t.key ? "page" : undefined}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Bottom bar. Hidden here and shown by the stylesheet at phone width. */}
      <nav className="mobile-bottom-nav" style={{ display: "none" }} aria-label="Bottom navigation">
        <div className="mk-bottom-row">
          {filteredPrimary.map((t) => (
            <button
              key={t.key}
              className="mk-bottom-tab"
              onClick={() => handleTab(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              aria-label={t.label}
            >
              <TabIcon name={t.icon} />
              <span>{t.label}</span>
            </button>
          ))}

          {filteredMore.length > 0 && (
            <button
              className={`mk-bottom-tab${moreOpen || isMoreActive ? " on" : ""}`}
              onClick={() => setMoreOpen((v) => !v)}
              aria-label="More tabs"
              aria-expanded={moreOpen}
            >
              <TabIcon name="more" />
              <span>More</span>
            </button>
          )}
        </div>
      </nav>
    </>
  );
}
