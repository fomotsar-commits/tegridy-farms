import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Eth } from "./Icons";
import { shortenAddress } from "../api";
import { useTradingMode, LITE_HIDDEN_PRIMARY, LITE_HIDDEN_MORE } from "../contexts/TradingModeContext";
import { useSiweAuth } from "../hooks/useSiweAuth";

function Ticker({ activities }) {
  const [idx, setIdx] = useState(0);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    if (!activities.length) return;
    const iv = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setIdx((p) => (p + 1) % activities.length);
        setFade(true);
      }, 250);
    }, 4000);
    return () => clearInterval(iv);
  }, [activities.length]);

  if (!activities.length) return null;
  const a = activities[idx % activities.length];

  const colors = { sale: "var(--green)", ask: "var(--yellow)", bid: "var(--purple)", transfer: "var(--text-dim)", mint: "var(--gold)" };
  const labels = { sale: "sold for", ask: "listed at", bid: "bid", transfer: "transferred", mint: "minted" };

  const text = a.price
    ? `${a.token?.name} ${labels[a.type] || a.type} ${a.price} ETH`
    : `${a.token?.name} ${labels[a.type] || a.type}`;

  return (
    <div className="ticker">
      <div className="live-dot" />
      <span
        className="ticker-text"
        style={{
          color: colors[a.type] || "#888",
          opacity: fade ? 1 : 0,
          transform: fade ? "translateY(0)" : "translateY(-4px)",
          transition: "opacity 0.25s ease, transform 0.25s ease",
        }}
      >
        {text}
      </span>
      <span
        style={{
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)",
          marginLeft: "auto", flexShrink: 0,
          opacity: fade ? 0.7 : 0,
          transition: "opacity 0.25s ease",
        }}
      >
        {formatTimeAgo(a.time)}
      </span>
    </div>
  );
}

function formatTimeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 0) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

// Stale data indicator — shows "Updated Xm ago" next to the API badge
function StaleIndicator({ lastRefresh }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 15000);
    return () => clearInterval(iv);
  }, []);

  if (!lastRefresh) return null;
  const ago = Math.floor((Date.now() - lastRefresh) / 1000);
  if (ago < 30) return null; // Don't show if very recent

  return (
    <span style={{
      fontFamily: "var(--mono)",
      fontSize: 8,
      color: ago > 180 ? "var(--yellow)" : "var(--text-muted)",
      letterSpacing: "0.02em",
    }}>
      {ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`}
    </span>
  );
}

/* SVG-based theme icons — render consistently across all platforms */
function ThemeIconSvg({ theme }) {
  if (theme === "midnight") {
    // Crescent moon
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
      </svg>
    );
  }
  if (theme === "sovereign") {
    // Crown
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <path d="M2 20h20v2H2zm1-3l3-10 5 4 4-8 4 8 5-4-3 10z" />
      </svg>
    );
  }
  // Default — diamond/gem
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 22 8.5 12 22 2 8.5" />
      <line x1="2" y1="8.5" x2="22" y2="8.5" />
      <line x1="12" y1="2" x2="7" y2="8.5" />
      <line x1="12" y1="2" x2="17" y2="8.5" />
    </svg>
  );
}

const PRIMARY_NAV = [
  ["listings", "Floor"],
  ["gallery", "Gallery"],
  ["deals", "Deals"],
  ["traits", "Traits"],
  ["activity", "Activity"],
  ["collection", "My NFTs"],
  ["portfolio", "P&L"],
];

const MORE_NAV = [
  ["sniper", "\u{1F3AF} Sniper"],
  ["trade", "Trade"],
  ["watchlist", "Watchlist"],
  ["favorites", "Favorites"],
  ["bids", "Bids"],
  ["my-listings", "My Listings"],
  ["alerts", "Alerts"],
  ["chat", "Chat"],
  ["history", "History"],
  ["whales", "Whales"],
  ["about", "About"],
];

const headerBtnStyle = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface-glass)",
  backdropFilter: "var(--glass-blur)",
  color: "var(--text)",
  cursor: "pointer",
  transition: "border-color 0.2s, background 0.2s",
};

const themeToggleStyle = {
  ...headerBtnStyle,
  width: 40,
  height: 40,
  fontSize: 18,
  padding: 0,
};

const cartBtnStyle = {
  ...headerBtnStyle,
  width: 44,
  height: 40,
  fontSize: 18,
  padding: "0 8px",
  gap: 3,
};

const cartBadgeStyle = {
  position: "absolute",
  top: -5,
  right: -5,
  minWidth: 16,
  height: 16,
  borderRadius: 8,
  background: "var(--naka-blue)",
  color: "#fff",
  fontFamily: "var(--mono)",
  fontSize: 9,
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 4px",
  lineHeight: 1,
  boxShadow: "0 0 6px var(--naka-blue)",
};

/* ── Lite / Pro segmented toggle ── */
const modeToggleWrapStyle = {
  display: "flex",
  alignItems: "center",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface-glass)",
  backdropFilter: "var(--glass-blur)",
  overflow: "hidden",
  height: 34,
  fontSize: 10,
  fontFamily: "var(--pixel)",
  letterSpacing: "0.04em",
  cursor: "pointer",
  flexShrink: 0,
};

function TradingModeToggle() {
  const { mode, setMode } = useTradingMode();
  return (
    <div
      style={modeToggleWrapStyle}
      title="Lite mode: simplified view. Pro mode: full trading tools."
      role="group"
      aria-label="Trading mode"
    >
      {[["lite", "Lite", "var(--naka-blue)"], ["pro", "Pro", "var(--gold)"]].map(([key, label, accent]) => (
        <button
          key={key}
          onClick={() => setMode(key)}
          aria-pressed={mode === key}
          style={{
            padding: "0 10px",
            height: "100%",
            border: "none",
            cursor: "pointer",
            fontFamily: "var(--pixel)",
            fontSize: 10,
            letterSpacing: "0.04em",
            transition: "background 0.2s, color 0.2s",
            background: mode === key ? accent : "transparent",
            color: mode === key ? "#000" : "var(--text-dim)",
            fontWeight: mode === key ? 700 : 400,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default memo(function Header({
  tab,
  setTab,
  wallet,
  setWallet,
  onConnect,
  activities,
  isLive,
  cartCount,
  onCartToggle,
  themeName,
  onCycleTheme,
  walletName,
  lastRefresh,
  collectionName,
  collectionImage,
  collectionSlug,
  collectionPixelated,
  isLanding,
  notificationCenter,
}) {
  const navigate = useNavigate();
  const { isLite } = useTradingMode();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtnRef = useRef(null);
  const [morePos, setMorePos] = useState({ top: 44, right: 16 });

  // Filter nav items based on trading mode
  const visiblePrimary = useMemo(
    () => isLite ? PRIMARY_NAV.filter(([k]) => !LITE_HIDDEN_PRIMARY.has(k)) : PRIMARY_NAV,
    [isLite],
  );
  const visibleMore = useMemo(
    () => isLite ? MORE_NAV.filter(([k]) => !LITE_HIDDEN_MORE.has(k)) : MORE_NAV,
    [isLite],
  );
  const visibleAll = useMemo(() => [...visiblePrimary, ...visibleMore], [visiblePrimary, visibleMore]);

  const siwe = useSiweAuth();

  const handleSignIn = useCallback(async () => {
    try {
      await siwe.signIn();
    } catch (err) {
      if (err.message !== "Sign-in cancelled") {
        console.warn("SIWE sign-in failed:", err.message);
      }
    }
  }, [siwe.signIn]);

  const toggleMore = useCallback(() => {
    setMoreOpen(prev => {
      if (!prev && moreBtnRef.current) {
        const r = moreBtnRef.current.getBoundingClientRect();
        setMorePos({ top: r.bottom + 4, right: window.innerWidth - r.right });
      }
      return !prev;
    });
  }, []);

  const handleConnect = () => {
    if (wallet) {
      // Disconnect
      setWallet();
      return;
    }
    onConnect();
  };

  const handleNav = (k) => {
    setTab(k);
    setMobileOpen(false);
  };

  return (
    <header className="header" role="banner">
      <div className="header-inner">
        <div className="header-logo" style={{ cursor: "pointer", gap: 14, display: "flex", alignItems: "center" }}>
          {/* Back to Tegridy Farms */}
          <a
            href="/"
            title="Back to Tegridy Farms"
            aria-label="Back to Tegridy Farms"
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "6px 12px", borderRadius: 8,
              background: "var(--color-purple-08)", border: "1px solid var(--color-purple-15)",
              color: "#a599c9", fontSize: 10, fontFamily: "var(--mono)",
              textDecoration: "none", whiteSpace: "nowrap",
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-purple-15)"; e.currentTarget.style.color = "#ede9fe"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-purple-08)"; e.currentTarget.style.color = "#a599c9"; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Tegridy
          </a>
          {!isLanding && (
            <button
              onClick={() => navigate("/nakamigos")}
              className="header-back-btn"
              title="Back to collections"
              aria-label="Back to collections"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          <div onClick={() => isLanding ? null : handleNav("gallery")} onKeyDown={(e) => { if (!isLanding && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); handleNav("gallery"); } }} role={isLanding ? undefined : "button"} tabIndex={isLanding ? undefined : 0} aria-label={isLanding ? undefined : "Go to gallery"} style={{ display: "flex", alignItems: "center", gap: 10, cursor: isLanding ? "default" : "pointer" }}>
            <img
              src={collectionImage || "/splash/skeleton.jpg"}
              alt={collectionName || "Tradermigos"}
              className="header-logo-icon"
              style={{ objectFit: "cover", imageRendering: collectionPixelated ? "pixelated" : "auto" }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontFamily: "var(--pixel)", fontSize: 11, color: "var(--naka-blue)", letterSpacing: "0.04em", lineHeight: 1 }}>
                {isLanding ? "TRADERMIGOS" : (collectionName || "COLLECTION").toUpperCase()}
              </span>
              <span className="header-badge">
                {isLanding ? "NFT COLLECTIONS" : "TRADERMIGOS"}
              </span>
            </div>
          </div>
        </div>

        {/* Desktop Nav */}
        <nav className="nav-tabs desktop-nav" aria-label="Main navigation">
          {visiblePrimary.map(([k, v]) => (
            <button key={k} onClick={() => handleNav(k)} className={`nav-tab ${tab === k ? "active" : ""}`}>
              {v}
            </button>
          ))}
          <div className="more-dropdown" style={{ position: "relative" }}>
            <button
              ref={moreBtnRef}
              className={`nav-tab${moreOpen ? " active" : ""}`}
              onClick={toggleMore}
              aria-expanded={moreOpen}
              aria-haspopup="true"
            >
              More
            </button>
            {moreOpen && createPortal(
              <>
              <div onClick={() => setMoreOpen(false)} style={{
                position: "fixed", inset: 0, zIndex: 9998,
              }} />
              <div style={{
                position: "fixed",
                top: morePos.top,
                right: morePos.right,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-lg, 12px)",
                padding: "8px 0",
                minWidth: 160,
                zIndex: 9999,
                boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
                backdropFilter: "blur(16px)",
              }}>
                {visibleMore.map(([key, label]) => (
                  <button
                    key={key}
                    className={`nav-tab${tab === key ? " active" : ""}`}
                    onClick={() => { setTab(key); setMoreOpen(false); }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 16px", border: "none", background: "none", cursor: "pointer", fontFamily: "var(--pixel)", fontSize: 9, color: tab === key ? "var(--gold)" : "var(--text-dim)" }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              </>,
              document.body
            )}
          </div>
        </nav>

        {/* Mobile hamburger */}
        <button className="hamburger" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Menu" aria-expanded={mobileOpen}>
          <span className={`hamburger-line ${mobileOpen ? "open" : ""}`} />
          <span className={`hamburger-line ${mobileOpen ? "open" : ""}`} />
          <span className={`hamburger-line ${mobileOpen ? "open" : ""}`} />
        </button>

        <div className="header-actions" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div className="header-status-group" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              className={`api-badge ${isLive ? "live" : "demo"}`}
              title={isLive ? "Connected to live APIs" : "Using demo/fallback data — some features may be limited"}
              role="status"
            >
              <span className="live-dot" style={{ width: 4, height: 4, background: isLive ? undefined : "var(--text-muted, #888)" }} />
              {isLive ? "LIVE" : "DEMO"}
            </span>
            <StaleIndicator lastRefresh={lastRefresh} />
          </div>
          <Ticker activities={activities} />

          {/* Lite / Pro Toggle */}
          <TradingModeToggle />

          {/* Theme Toggle */}
          <button
            onClick={onCycleTheme}
            title={`Theme: ${themeName || "default"}`}
            style={themeToggleStyle}
            aria-label={`Current theme: ${themeName || "default"}. Click to cycle.`}
          >
            <ThemeIconSvg theme={themeName} />
          </button>

          {/* Notification Center */}
          {notificationCenter}

          {/* Cart Button */}
          <button
            onClick={onCartToggle}
            style={cartBtnStyle}
            aria-label="Shopping cart"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <path d="M16 10a4 4 0 01-8 0" />
            </svg>
            {cartCount > 0 && (
              <span style={cartBadgeStyle}>
                {cartCount > 99 ? "99+" : cartCount}
              </span>
            )}
          </button>

          {/* SIWE Sign In button hidden — infrastructure (useSiweAuth + /api/auth/*)
              is intact and will be re-surfaced when a feature actually gates on
              siwe.isAuthenticated (chat / profile / on-chain voting). Until then
              the button promises capabilities that don't exist. */}
          <button
            onClick={handleConnect}
            className={`wallet-btn ${wallet ? "connected" : "disconnected"}`}
            title={wallet ? `${walletName || "Wallet"} \u00b7 Click to disconnect` : "Connect wallet"}
            aria-label={wallet ? `Disconnect ${walletName || "wallet"}` : "Connect wallet"}
          >
            {wallet ? (
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {siwe.isAuthenticated && (
                  <span style={{ color: "var(--green)", fontSize: 9 }} title="Signed in">{"\u2713"}</span>
                )}
                {walletName && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, opacity: 0.5, letterSpacing: "0.02em" }}>{walletName}</span>
                )}
                <span style={{ fontFamily: "var(--mono)", letterSpacing: "0.03em" }}>{shortenAddress(wallet)}</span>
              </span>
            ) : (
              "Connect Wallet"
            )}
          </button>
        </div>
      </div>

      {/* Mobile nav drawer */}
      {mobileOpen && (
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {visibleAll.map(([k, v]) => (
            <button key={k} onClick={() => handleNav(k)} className={`mobile-nav-item ${tab === k ? "active" : ""}`}>
              {v}
            </button>
          ))}
        </nav>
      )}
    </header>
  );
})
