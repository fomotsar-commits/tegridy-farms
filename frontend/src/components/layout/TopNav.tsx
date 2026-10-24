import { NavLink, Link, useLocation } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { AnimatePresence, m } from 'framer-motion';
import { useTheme } from '../../contexts/ThemeContext';
import { BAR_NAV } from '../../lib/navConfig';
import { safeGetItem } from '../../lib/storage';
import { pageArt } from '../../lib/artConfig';
import { getActiveBungalow, getBungalowIdentity, OPEN_BUNGALOWS_EVENT } from '../../lib/bungalows';
import { useActiveBungalowId } from '../../hooks/useActiveBungalowId';
import { hasMixedSolanaSection, isSolanaPage, isToweliRoomPage } from '../../lib/routeVoice';
import {
  cancelSolanaOpenRequest,
  requestSolanaOpen,
  shortSolanaAddress,
  useSolanaSurface,
  type SolanaSurface,
} from '../../lib/solanaSurface';
import { VENUE } from '../../lib/arrival';
import { artImgProps } from '../../lib/artSrcSet';
import { WalletSheet } from './WalletSheet';
import { TopBarSolana } from './TopBarSolana';
import { NavDrawer } from './NavDrawer';

// The wallet button's two looks, shared by the Ethereum (RainbowKit) and Solana
// slots so they are the same width: the 360px row has no room to spare.
const CONNECT_BUTTON_CLASS =
  'text-[13px] md:text-[14px] font-semibold rounded-lg px-2.5 md:px-4 py-1.5 min-h-[44px] md:min-h-[36px] transition-all hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6]';
const CONNECT_BUTTON_STYLE = { background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(139,92,246,0.60)', color: 'var(--color-primary)' };
// The chip is drawn in the device's own monospace font, so its width varies by OS (nine
// characters: 56.9px Consolas to 64px SF Mono). e2e/topbar-solana-connect.spec.ts sweeps a
// connected header in the widest: below 375px the chip keeps 4px of side padding, the green
// dot starts at 400px, and the wider padding waits for 1024px.
const ACCOUNT_CHIP_CLASS =
  'flex items-center gap-1.5 md:gap-2 px-1 min-[375px]:px-2 lg:px-3 py-1 md:py-1.5 min-h-[44px] md:min-h-0 rounded-lg text-[11.5px] md:text-[13px] font-mono text-text-secondary max-w-[140px] md:max-w-none';
const ACCOUNT_CHIP_STYLE = { background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' };
const ACCOUNT_DOT_CLASS = 'hidden min-[400px]:block w-1.5 h-1.5 rounded-full bg-success flex-shrink-0';

/** How long a top-bar tap waits for a Solana page's wallet section to load. */
const SOLANA_OPEN_WAIT_MS = 10_000;

/**
 * The wallet slot on a Solana page (lib/solanaSurface.ts): it opens that page's own Solana
 * list and shows the Solana address once connected (RainbowKit proposes Ethereum chains only).
 * Never hidden: a tap before the page's Solana section loads is kept and used once it loads
 * (`pending`). The label stays "Connect" in every state; "Connecting…" would not fit at 360px.
 */
function SolanaWalletSlot({ surface, pending }: { surface: SolanaSurface | null; pending: boolean }) {
  const address = surface?.address ?? null;
  if (address) {
    const short = shortSolanaAddress(address);
    return (
      <div className="min-w-0">
        <button type="button" onClick={requestSolanaOpen} aria-label={`Solana wallet ${short}, switch or disconnect`} title="Solana wallet" className={ACCOUNT_CHIP_CLASS} style={ACCOUNT_CHIP_STYLE}>
          <span className={ACCOUNT_DOT_CLASS} />
          <span className="truncate">{short}</span>
        </button>
      </div>
    );
  }
  const connecting = Boolean(surface?.connecting);
  const busy = pending || connecting;
  return (
    <div className="min-w-0">
      {/* Never refused: while a connect waits (a locked wallet waits for ever), a tap goes to
          the page's own connect click, which opens the wallet list (useSolanaConnect). */}
      <button
        type="button"
        onClick={requestSolanaOpen}
        aria-label="Connect a Solana wallet"
        aria-busy={busy || undefined}
        title={connecting ? 'Waiting for your Solana wallet. Tap for the wallet list.' : pending ? 'Opening the Solana wallet list…' : undefined}
        className={`${CONNECT_BUTTON_CLASS}${busy ? ' opacity-60' : ''}`}
        style={CONNECT_BUTTON_STYLE}
      >
        Connect
      </button>
    </div>
  );
}

export const TopNav = React.memo(function TopNav() {
  const [open, setOpen] = useState(false);
  const [kebabOpen, setKebabOpen] = useState(false);
  const kebabRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  // The menu opens as a circle from the centre of its button.
  const [menuFrom, setMenuFrom] = useState<{ x: number; y: number } | null>(null);
  // Opened from the keyboard, the cursor starts in the menu's "Jump to" (NavDrawer.tsx).
  const [focusSearch, setFocusSearch] = useState(false);
  const openMenu = useCallback((search = false) => {
    const r = menuButtonRef.current?.getBoundingClientRect();
    setMenuFrom(r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null);
    setFocusSearch(search);
    setOpen(true);
  }, []);
  // Ctrl+K / ⌘K opens the index from any page, and closes it again.
  useEffect(() => {
    function handleShortcut(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      if (open) setOpen(false);
      else openMenu(true);
    }
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [open, openMenu]);
  const location = useLocation();
  // The chip names the room and Swap follows it; both re-read on a skin switch.
  useActiveBungalowId();
  const { isDark } = useTheme();
  // Dashboard is a drawer row only once there is an account for it to describe.
  const { isConnected } = useAccount();
  // On a page with a Solana section the wallet slot connects Solana, through that section's
  // own connection: the path answers while it loads, its provider after (lib/solanaSurface.ts).
  const { surface: solana, openPending: solanaOpenPending, page: solanaHere, mixed: solanaMixed } = useSolanaSurface();
  // A section on a page that connects Ethereum too (the home's cards) keeps the sheet below.
  const solanaPage = (solanaHere && !solanaMixed) || isSolanaPage(location.pathname, getBungalowIdentity());
  // Everywhere else the slot opens the wallet sheet: Solana, or Ethereum (WalletSheet.tsx).
  const [walletSheetOpen, setWalletSheetOpen] = useState(false);
  const openWalletSheet = useCallback(() => setWalletSheetOpen(true), []);
  const closeWalletSheet = useCallback(() => setWalletSheetOpen(false), []);
  // A tap waiting for this page's Solana section belongs to this page, and does not wait for
  // ever: a section that never loads must not leave the button dimmed or open a list a minute
  // later. It says so, because a button that dims and does nothing reads as broken.
  useEffect(() => () => cancelSolanaOpenRequest(), [location.pathname]);
  useEffect(() => {
    if (!solanaOpenPending) return;
    const timer = setTimeout(() => {
      cancelSolanaOpenRequest();
      toast('The Solana wallet list did not load on this page. Reload the page and try again.');
    }, SOLANA_OPEN_WAIT_MS);
    return () => clearTimeout(timer);
  }, [solanaOpenPending]);

  // The admin kebab shows only with the localStorage flag. safeGetItem, because touching
  // `window.localStorage` throws SecurityError when site data is blocked.
  const showAdmin = !!safeGetItem('tegridy_admin');

  // Close kebab on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) {
        setKebabOpen(false);
      }
    }
    if (kebabOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [kebabOpen]);

  // Close the kebab and the wallet sheet on a route change: the previous pathname is compared
  // during render (React's "store info from previous renders"), so no effect cascades.
  const [lastPathname, setLastPathname] = useState(location.pathname);
  if (lastPathname !== location.pathname) {
    setLastPathname(location.pathname);
    if (kebabOpen) setKebabOpen(false);
    if (walletSheetOpen) setWalletSheetOpen(false);
  }

  // Escape closes the drawer, and Tab stays inside it while open (else it reaches the page behind).
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const focusables = drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !drawerRef.current.contains(active)) {
          last.focus();
          e.preventDefault();
        }
      } else {
        if (active === last || !drawerRef.current.contains(active)) {
          first.focus();
          e.preventDefault();
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  // The page behind the open drawer does not scroll. Focus returns to the menu button only on
  // a real open-to-closed change: on first mount it would announce "Open navigation menu".
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    } else if (wasOpenRef.current) {
      // Return focus to the menu-open button only after a real close.
      wasOpenRef.current = false;
      menuButtonRef.current?.focus();
    }
  }, [open]);

  return (
    <>
      {/* iOS standalone with viewport-fit=cover puts the status bar over this fixed header, so
          env(safe-area-inset-top) is reserved above the 3.5rem row. AppLayout's offset matches. */}
      <header
        className="fixed top-0 left-0 right-0 z-50"
        style={{
          height: 'calc(3.5rem + env(safe-area-inset-top, 0px))',
          paddingTop: 'env(safe-area-inset-top, 0px)',
          background: isDark
            ? 'linear-gradient(180deg, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.86) 100%)'
            : 'linear-gradient(180deg, rgba(255,140,26,0.92) 0%, rgba(255,111,0,0.86) 100%)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderBottom: isDark
            ? '1px solid rgba(255,255,255,0.10)'
            : '1px solid rgba(255,111,0,0.45)',
          boxShadow: isDark
            ? '0 1px 12px rgba(0,0,0,0.55), 0 0 1px rgba(0,0,0,0.70)'
            : '0 1px 12px rgba(255,111,0,0.25), 0 0 1px rgba(255,111,0,0.30)',
          transition: 'background-color 0.3s ease, box-shadow 0.3s ease',
        }}
      >
        {/* Subtle accent line at very top */}
        <div className="absolute top-0 left-0 right-0 h-[1px]" style={{
          background: 'linear-gradient(90deg, transparent 0%, var(--color-purple-75) 30%, var(--color-purple-50) 50%, var(--color-purple-75) 70%, transparent 100%)',
        }} />
        {/* px-2 below 400px, px-3 to 480, then px-4: the narrowest phones need every pixel. */}
        <div className="page-column mx-auto h-14 px-2 min-[400px]:px-3 min-[480px]:px-4 md:px-6 flex items-center justify-between">
          {/* THE 360px ROW. The wordmark stays whole at every width (owner, 2026-08-31), so the
              row fits on its gaps and padding: its intrinsic width is 350px. CI rasterises
              Archivo a shade wider than a local run, so re-run e2e/header-reachability.spec.ts
              (it sweeps real widths) after any change here, never a local 360px look. */}
          <div className="flex items-center gap-0.5 min-[400px]:gap-1 min-[480px]:gap-2">
            {/* The way back: a plain Link to "/", the venue's own door (App.tsx), which clears
                the skin in place. The mark is the venue's identity and never leaves the bar. */}
            <Link
              to="/"
              className="flex items-center gap-1.5 min-[480px]:gap-2"
              title="Back to memetics.finance"
            >
              {/* A 512px PNG drawn at 28px or 44px, eager because it is above the fold on every
                  route, so `sizes` is spelled out: without it the browser takes the full-size
                  original. TopNav.navLogo.test.tsx pins it. */}
              <span
                className="block w-11 h-11 md:w-7 md:h-7 rounded-md overflow-hidden flex-shrink-0"
                style={{ border: '1px solid var(--color-purple-25)' }}
              >
                <img
                  src={pageArt('nav-logo', 0).src}
                  {...artImgProps(pageArt('nav-logo', 0).src, 'eager', '(min-width: 768px) 28px, 44px')}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </span>
              {/* The venue's name is the only one the app speaks, in every room, and it is never
                  abbreviated: below 480px it is sized down instead, so the row fits at 375px. */}
              <span className="heading-luxury text-[12px] min-[480px]:text-[16px] tracking-wide text-white">{VENUE.markMain}</span>
              <span className="text-[11px] min-[480px]:text-[15px] font-semibold tracking-tight" style={{ color: 'var(--color-kyle)' }}>{VENUE.markSub}</span>
            </Link>
            {/* The bungalow chooser, from any page (AppLayout listens for the event). It names
                where you are; icon-only below lg to spare the crowded bar. */}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event(OPEN_BUNGALOWS_EVENT))}
              title="Choose your bungalow"
              aria-label="Choose your bungalow"
              className="flex items-center gap-1 px-2 h-11 md:h-7 min-w-[44px] md:min-w-0 justify-center rounded-full text-[11px] flex-shrink-0 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4CAF50]"
              style={{ border: '1px solid var(--color-purple-25)', color: 'var(--color-kyle, #7fd89d)' }}
            >
              <span aria-hidden="true">🏝️</span>
              {/* The name returns at lg: room names vary in length, and at 768px a name beside
                  the bar's words cut "Connect" off the right edge. */}
              <span className="hidden lg:inline">
                {/* In a TOWELI room the chip does not name the last resident walked through. */}
                {isToweliRoomPage(location.pathname) ? 'Bungalows' : (getActiveBungalow()?.name ?? 'Bungalows')}
              </span>
            </button>
          </div>

          {/* The words show from 800px; below it BottomNav carries them. The row needs about 790px
              and the iPad's 810px must keep the words, so 800 sits between. These move together:
              this nav, BottomNav.tsx, AppLayout.tsx's content pb and index.css's two max-width:799px
              blocks; a split opens a band with no bar. e2e/header-reachability.spec.ts sweeps it. */}
          <nav aria-label="Main navigation" className="hidden min-[800px]:flex items-center gap-0.5">
            {/* Four words (navConfig BAR_NAV), each lit on every page it owns, never by its own
                URL alone: Island owns the home, each room's door and the island's pages. */}
            {BAR_NAV.map((word) => {
              const lit = word.lit(location.pathname, location.hash);
              return (
                <Link key={word.label} to={word.to} aria-current={lit ? 'page' : undefined}
                  className={`nav-link ${lit ? 'active' : ''}`}>
                  {word.label}
                </Link>
              );
            })}
          </nav>

          {/* flex-shrink-0: the wallet cluster is this row's critical action and never compresses. */}
          <div className="flex items-center gap-1 min-[400px]:gap-1.5 md:gap-2 min-w-0 flex-shrink-0">

            {/* The wallet, then the menu button at the far right. Padding, font size and the name's
                width shrink on a phone so a long ENS name never pushes the menu button off-screen. */}
            {solanaPage ? (
              <SolanaWalletSlot surface={solana} pending={solanaOpenPending} />
            ) : (
            <ConnectButton.Custom>
              {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
                const connected = mounted && account && chain;
                const wrongNetwork = Boolean(connected && chain.unsupported);
                // The top bar's own Solana connection (TopBarSolana.tsx), or the
                // connection of a section on a mixed page (the home's cards).
                const solanaAddress = solana?.address ?? null;
                return (
                  <div className="min-w-0" {...(!mounted && { 'aria-hidden': true, style: { opacity: 0, pointerEvents: 'none', userSelect: 'none' } })}>
                    {wrongNetwork ? (
                      <button onClick={openChainModal} aria-label="Switch to correct network" className="btn-secondary text-[11.5px] md:text-[13px] px-2.5 md:px-3 py-1 md:py-1.5 text-danger border-danger/30">
                        Wrong Network
                      </button>
                    ) : connected || solanaAddress ? (
                      /* One chip, opening the sheet that lists both networks, so an Ethereum
                         wallet is never a dead end for Solana. It names the Ethereum account
                         where there is one (the wallet these pages use), else the Solana one. */
                      <button onClick={openWalletSheet} aria-label="Your wallets"
                        className={ACCOUNT_CHIP_CLASS}
                        style={ACCOUNT_CHIP_STYLE}>
                        <span className={ACCOUNT_DOT_CLASS} />
                        <span className="truncate">{connected ? account.displayName : shortSolanaAddress(solanaAddress!)}</span>
                      </button>
                    ) : (
                      /* Outlined in the bar's purple, not the hero's filled green: green means one
                         thing here, stake. Sized explicitly with a 44px floor on touch. */
                      <button
                        onClick={openWalletSheet}
                        aria-label="Connect wallet"
                        className={CONNECT_BUTTON_CLASS}
                        style={CONNECT_BUTTON_STYLE}
                      >
                        Connect
                      </button>
                    )}
                    {/* In <body>: the header's backdrop-filter would lay a fixed dialog out in its 64px. */}
                    {typeof document !== 'undefined' && createPortal(
                      <WalletSheet
                        open={walletSheetOpen}
                        onClose={closeWalletSheet}
                        evm={{
                          label: connected ? (account.displayName ?? null) : null,
                          connect: openConnectModal,
                          account: openAccountModal,
                        }}
                      />,
                      document.body,
                    )}
                  </div>
                );
              }}
            </ConnectButton.Custom>
            )}
            <TopBarSolana solanaPage={solanaPage || hasMixedSolanaSection(location.pathname)} />

            {/* The admin kebab, only with the tegridy_admin flag. */}
            {showAdmin && (
              <div className="relative hidden md:block flex-shrink-0" ref={kebabRef}>
                <button
                  onClick={() => setKebabOpen(!kebabOpen)}
                  aria-expanded={kebabOpen}
                  aria-haspopup="menu"
                  aria-label="Admin menu"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-text-secondary hover:text-primary transition-colors"
                  style={{ background: 'var(--color-purple-10)', border: '1px solid var(--color-purple-15)' }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <circle cx="12" cy="5" r="1.5" />
                    <circle cx="12" cy="12" r="1.5" />
                    <circle cx="12" cy="19" r="1.5" />
                  </svg>
                </button>
                <AnimatePresence>
                  {kebabOpen && (
                    <m.div
                      role="menu"
                      aria-label="Admin actions"
                      className="absolute top-full right-0 mt-1 py-1 rounded-lg min-w-[140px]"
                      style={{
                        background: isDark ? 'rgba(10,10,20,0.95)' : 'rgba(255,255,255,0.97)',
                        border: '1px solid var(--color-purple-20)',
                        backdropFilter: 'blur(20px)',
                        boxShadow: isDark ? '0 8px 30px rgba(0,0,0,0.5)' : '0 8px 30px rgba(0,0,0,0.12)',
                      }}
                      initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}
                      transition={{ duration: 0.15 }}
                    >
                      <NavLink
                        to="/admin"
                        role="menuitem"
                        className={({ isActive }) => `nav-link block px-4 py-2 text-[13px] transition-colors ${isActive ? 'active' : ''}`}
                      >
                        Admin
                      </NavLink>
                    </m.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {/* The index behind one button, at every width. From 1100px the button says so: a bare
                icon after the wallet read, on a desktop, as a phone's leftover (owner, 2026-10-19).
                The row needs about 790px at 800px, so the word waits for room. */}
            <button ref={menuButtonRef} onClick={() => openMenu()} aria-label="Open navigation menu" aria-expanded={open}
              className="p-2 -mr-1 flex-shrink-0 text-text-muted min-w-[44px] min-h-[44px] flex items-center justify-center gap-2 transition-colors hover:text-white">
              <span aria-hidden="true" className="hidden min-[1100px]:inline font-mono text-[11px] tracking-[0.14em] uppercase">Menu</span>
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M3 5h14M3 10h14M3 15h14" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* The menu, full screen at every width (NavDrawer.tsx). z-[70]: over the phone's bottom bar
          (z-50) and Towelie (z-[60]), which hid its last rows when it shared their z. */}
      <NavDrawer ref={drawerRef} open={open} onClose={() => setOpen(false)} from={menuFrom}
        pathname={location.pathname} isConnected={isConnected} showAdmin={showAdmin} focusSearch={focusSearch} />
    </>
  );
});
