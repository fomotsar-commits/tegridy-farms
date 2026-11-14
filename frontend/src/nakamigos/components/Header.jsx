import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { shortenAddress } from "../api";
import { useTradingMode, LITE_HIDDEN_PRIMARY, LITE_HIDDEN_MORE } from "../contexts/TradingModeContext";
import { useSiweAuth } from "../hooks/useSiweAuth";

function formatTimeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 0) return "now";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

const TICKER_COLORS = { sale: "var(--green)", ask: "var(--yellow)", bid: "var(--purple)", transfer: "var(--text-dim)", mint: "var(--text)" };
const TICKER_LABELS = { sale: "sold for", ask: "listed at", bid: "bid", transfer: "transferred", mint: "minted" };

// The last few things that happened in this collection, one line at a time.
function Ticker({ activities }) {
  const [idx, setIdx] = useState(0);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    if (!activities.length) return;
    const iv = setInterval(() => {
      // Skip the rotation while the tab is hidden — no point animating an
      // off-screen ticker (F547). Consistent with useDmUnread's visibility gate.
      if (document.hidden) return;
      setShown(false);
      setTimeout(() => {
        setIdx((p) => (p + 1) % activities.length);
        setShown(true);
      }, 250);
    }, 4000);
    return () => clearInterval(iv);
  }, [activities.length]);

  if (!activities.length) return null;
  const a = activities[idx % activities.length];
  const text = a.price
    ? `${a.token?.name} ${TICKER_LABELS[a.type] || a.type} ${a.price} ETH`
    : `${a.token?.name} ${TICKER_LABELS[a.type] || a.type}`;

  return (
    <div className="ticker">
      <div className="live-dot" />
      <span className="ticker-text" style={{ color: TICKER_COLORS[a.type] || "var(--text-dim)", opacity: shown ? 1 : 0 }}>
        {text}
      </span>
      <span className="ticker-time" style={{ opacity: shown ? 1 : 0 }}>{formatTimeAgo(a.time)}</span>
    </div>
  );
}

// Stale data indicator — shows "Xm ago" next to the LIVE badge
function StaleIndicator({ lastRefresh }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    // Don't re-tick the "updated Xm ago" label while the tab is hidden (F547).
    const iv = setInterval(() => { if (!document.hidden) setTick((t) => t + 1); }, 15000);
    return () => clearInterval(iv);
  }, []);

  if (!lastRefresh) return null;
  const ago = Math.floor((Date.now() - lastRefresh) / 1000);
  if (ago < 30) return null; // Don't show if very recent

  return (
    <span className={`mk-stale${ago > 180 ? " old" : ""}`}>
      {ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`}
    </span>
  );
}

export const PRIMARY_NAV = [
  ["listings", "Floor"],
  ["gallery", "Gallery"],
  ["deals", "Deals"],
  ["traits", "Traits"],
  ["activity", "Activity"],
  ["collection", "My NFTs"],
  ["portfolio", "P&L"],
];

export const MORE_NAV = [
  ["pro", "Pro"],
  ["trades", "P2P Trades"],
  ["sniper", "Sniper"],
  ["trade", "Compare"],
  ["watchlist", "Watchlist"],
  ["favorites", "Favorites"],
  ["bids", "Bids"],
  ["my-listings", "My Listings"],
  ["alerts", "Alerts"],
  ["chat", "Chat"],
  ["history", "History"],
  ["whales", "Whales"],
  ["integrity", "Integrity"],
  ["about", "About"],
];

/* Count pill beside a nav label (incoming P2P trade offers, F677). */
function NavCountBadge({ count }) {
  if (!count || count <= 0) return null;
  return <span className="mk-count inline" aria-hidden="true">{count > 99 ? "99+" : count}</span>;
}

/* ── Lite / Pro ── */
function TradingModeToggle() {
  const { mode, setMode } = useTradingMode();
  return (
    <div
      className="mk-seg mk-hide-phone"
      title="Lite mode: simplified view. Pro mode: full trading tools."
      role="group"
      aria-label="Trading mode"
    >
      {[["lite", "Lite"], ["pro", "Pro"]].map(([key, label]) => (
        <button key={key} onClick={() => setMode(key)} aria-pressed={mode === key}>
          {label}
        </button>
      ))}
    </div>
  );
}

const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

/* A menu that opens under its button. It is drawn at the end of <body> so the
   scrolling tab row cannot clip it; .nakamigos-portal gives it the app's tokens. */
function Popover({ open, pos, onClose, label, children }) {
  if (!open) return null;
  return createPortal(
    <div className="nakamigos-portal">
      <div className="mk-scrim" onClick={onClose} />
      <div className="mk-menu" role="menu" aria-label={label} style={{ top: pos.top, right: pos.right }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/* Where a menu sits: under its button, right edges together. Re-measured on
   resize and scroll while open, and closed by Escape (F541). */
function useAnchoredMenu() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const [pos, setPos] = useState({ top: 56, right: 16 });

  const place = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") { setOpen(false); btnRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const toggle = useCallback(() => {
    setOpen((prev) => { if (!prev) place(); return !prev; });
  }, [place]);

  return { open, setOpen, btnRef, pos, toggle };
}

export default memo(function Header({
  tab,
  setTab,
  onPrefetch,
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
  collectionPixelated,
  isLanding,
  notificationCenter,
  dmUnread = 0,
  incomingTrades = 0,
  onOpenDms,
  // A Set of the only tabs this collection has. Given, the nav shows exactly
  // those as primary tabs, with no More menu and no Lite/Pro toggle.
  allowedTabs,
  // False hides the LIVE/DEMO badge, for a view whose reads are labelled at
  // the point they are shown.
  showStatus = true,
}) {
  const navigate = useNavigate();
  const { isLite } = useTradingMode();
  const more = useAnchoredMenu();
  const account = useAnchoredMenu();
  const [copied, setCopied] = useState(false);

  // Filter nav items based on trading mode, or on the collection's own tabs.
  const visiblePrimary = useMemo(() => {
    if (allowedTabs) return [...PRIMARY_NAV, ...MORE_NAV].filter(([k]) => allowedTabs.has(k));
    return isLite ? PRIMARY_NAV.filter(([k]) => !LITE_HIDDEN_PRIMARY.has(k)) : PRIMARY_NAV;
  }, [isLite, allowedTabs]);
  const visibleMore = useMemo(() => {
    if (allowedTabs) return [];
    return isLite ? MORE_NAV.filter(([k]) => !LITE_HIDDEN_MORE.has(k)) : MORE_NAV;
  }, [isLite, allowedTabs]);
  const moreIsCurrent = visibleMore.some(([k]) => k === tab);

  const siwe = useSiweAuth();

  const handleWallet = () => {
    if (wallet) {
      // An account menu, not a disconnect: a misclick on your own address used
      // to disconnect at once (F542).
      setCopied(false);
      account.toggle();
      return;
    }
    onConnect();
  };

  const copyAddress = useCallback(async () => {
    if (!wallet) return;
    try {
      await navigator.clipboard?.writeText(wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — no-op */ }
  }, [wallet]);

  return (
    <header className="header" role="banner">
      <div className="header-inner">
        <div className="header-logo">
          {/* Back to the venue. The marketplace renders outside the site's own
              frame, so this link is its only exit. */}
          <a className="header-exit" href="/" title="Back to memetics.finance" aria-label="Back to memetics.finance">
            <Chevron />
            <span>memetics</span>
          </a>

          {isLanding ? (
            <span className="header-wordmark solo" aria-current="page">
              <span className="header-mark" aria-hidden="true" />
              <span className="mk-wordmark-text">Tradermigos</span>
            </span>
          ) : (
            <>
              <button
                className="header-wordmark header-back-btn"
                onClick={() => navigate("/nakamigos")}
                title="Back to collections"
                aria-label="Back to collections"
              >
                <span className="header-mark" aria-hidden="true" />
                <span className="mk-wordmark-text">Tradermigos</span>
              </button>
              <span className="header-slash" aria-hidden="true">/</span>
              <div
                className="header-crumb"
                onClick={() => setTab("gallery")}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTab("gallery"); } }}
                role="button"
                tabIndex={0}
                aria-label="Go to gallery"
              >
                {collectionImage && (
                  <img
                    src={collectionImage}
                    alt=""
                    className="header-logo-icon"
                    style={{ imageRendering: collectionPixelated ? "pixelated" : "auto" }}
                  />
                )}
                {/* A long name ellipsises (the whole name stays in the title)
                    rather than pushing the bar's controls off the edge. */}
                <span
                  className="header-collection-name"
                  title={collectionName || undefined}
                  style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}
                >
                  {collectionName || "Collection"}
                </span>
              </div>
            </>
          )}
        </div>

        <div className="header-actions">
          {showStatus && !isLanding && (
            <div className="header-status-group">
              <span
                className={`api-badge ${isLive ? "live" : "demo"}`}
                title={isLive ? "Connected to live APIs" : "Using demo/fallback data — some features may be limited"}
                role="status"
              >
                <span className="live-dot" />
                {isLive ? "LIVE" : "DEMO"}
              </span>
              <StaleIndicator lastRefresh={lastRefresh} />
            </div>
          )}
          <Ticker activities={activities} />

          {/* Lite / Pro only filters the tabs, so it shows only where the tabs do. */}
          {!allowedTabs && !isLanding && <TradingModeToggle />}

          <button
            className="mk-icon-btn mk-hide-phone"
            onClick={onCycleTheme}
            title={`Theme: ${themeName || "default"}`}
            aria-label={`Current theme: ${themeName || "default"}. Click to cycle.`}
          >
            <span aria-hidden="true" style={{ width: 14, height: 14, background: "var(--accent)", borderRadius: 2 }} />
          </button>

          {notificationCenter}

          {wallet && onOpenDms && (
            <button
              className="mk-icon-btn"
              onClick={onOpenDms}
              aria-label={dmUnread > 0 ? `Direct messages, ${dmUnread} unread` : "Direct messages"}
              title="Direct messages"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
              {dmUnread > 0 && <span className="mk-count">{dmUnread > 99 ? "99+" : dmUnread}</span>}
            </button>
          )}

          {/* Cart: only where there is a cart to toggle */}
          {typeof onCartToggle === "function" && (
            <button className="mk-icon-btn" onClick={onCartToggle} aria-label="Shopping cart" data-tour="cart">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <path d="M16 10a4 4 0 01-8 0" />
              </svg>
              {cartCount > 0 && <span className="mk-count">{cartCount > 99 ? "99+" : cartCount}</span>}
            </button>
          )}

          {/* SIWE Sign In button hidden — infrastructure (useSiweAuth + /api/auth/*)
              is intact and will be re-surfaced when a feature actually gates on
              siwe.isAuthenticated (chat / profile / on-chain voting). Until then
              the button promises capabilities that don't exist. */}
          <button
            ref={account.btnRef}
            onClick={handleWallet}
            className={`wallet-btn ${wallet ? "connected" : "disconnected"}`}
            title={wallet ? `${walletName || "Wallet"} · Account menu` : "Connect wallet"}
            aria-label={wallet ? `Account menu for ${walletName || "wallet"}` : "Connect wallet"}
            aria-haspopup={wallet ? "menu" : undefined}
            aria-expanded={wallet ? account.open : undefined}
          >
            {wallet ? (
              <>
                {siwe.isAuthenticated && <span style={{ color: "var(--green)" }} title="Signed in">{"✓"}</span>}
                {walletName && <span className="mk-wallet-name">{walletName}</span>}
                <span>{shortenAddress(wallet)}</span>
              </>
            ) : (
              // "Connect", not "Connect Wallet": the long label overflowed the
              // bar at 390px (audit 2026-05-30).
              "Connect"
            )}
          </button>

          {/* Account menu — copy / explorer / disconnect (F542). */}
          <Popover open={!!wallet && account.open} pos={account.pos} onClose={() => account.setOpen(false)} label="Account">
            <div className="mk-menu-head">
              <div className="mk-menu-title">{wallet ? shortenAddress(wallet) : ""}</div>
              {walletName && <div className="mk-menu-sub">{walletName}</div>}
            </div>
            <button role="menuitem" className="mk-menu-item" onClick={copyAddress}>
              {copied ? "Copied!" : "Copy address"}
            </button>
            <a
              role="menuitem"
              className="mk-menu-item"
              href={`https://etherscan.io/address/${wallet}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => account.setOpen(false)}
            >
              View on Etherscan
            </a>
            <button role="menuitem" className="mk-menu-item danger" onClick={() => { account.setOpen(false); setWallet(); }}>
              Disconnect
            </button>
          </Popover>
        </div>
      </div>

      {/* The collection's tabs. Not on the landing page, where there is no
          collection for them to belong to. */}
      {!isLanding && (
        <div className="header-tabs">
          <nav className="nav-tabs desktop-nav" aria-label="Main navigation">
            {visiblePrimary.map(([k, v]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                onMouseEnter={() => onPrefetch?.(k)}
                onFocus={() => onPrefetch?.(k)}
                className={`nav-tab ${tab === k ? "active" : ""}`}
                aria-current={tab === k ? "page" : undefined}
                data-tour={k === "listings" ? "floor" : k === "gallery" ? "gallery" : undefined}
              >
                {v}
              </button>
            ))}
            {visibleMore.length > 0 && (
              <div className="more-dropdown">
                <button
                  ref={more.btnRef}
                  className={`nav-tab${more.open || moreIsCurrent ? " active" : ""}`}
                  onClick={more.toggle}
                  aria-expanded={more.open}
                  aria-haspopup="true"
                  title={incomingTrades > 0 ? `${incomingTrades} incoming trade offer${incomingTrades === 1 ? "" : "s"} waiting in P2P Trades` : undefined}
                >
                  More
                  {/* The incoming-trade count shows on the closed More button
                      too, since the Trades item is inside it (F677). */}
                  <NavCountBadge count={incomingTrades} />
                  {incomingTrades > 0 && (
                    <span className="sr-only">{incomingTrades} incoming trade offer{incomingTrades === 1 ? "" : "s"}</span>
                  )}
                  <svg className="mk-caret" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M1 1l4 4 4-4" /></svg>
                </button>
                <Popover open={more.open} pos={more.pos} onClose={() => more.setOpen(false)} label="More navigation">
                  {visibleMore.map(([key, label]) => (
                    <button
                      key={key}
                      role="menuitem"
                      aria-current={tab === key ? "page" : undefined}
                      className={`mk-menu-item${tab === key ? " active" : ""}`}
                      onMouseEnter={() => onPrefetch?.(key)}
                      onFocus={() => onPrefetch?.(key)}
                      onClick={() => { setTab(key); more.setOpen(false); }}
                    >
                      {label}
                      {key === "trades" && <NavCountBadge count={incomingTrades} />}
                    </button>
                  ))}
                </Popover>
              </div>
            )}
          </nav>
        </div>
      )}
    </header>
  );
})
