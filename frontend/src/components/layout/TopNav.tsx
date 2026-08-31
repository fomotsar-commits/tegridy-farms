import { NavLink, Link, useLocation } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import React, { useState, useRef, useEffect } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { useTheme } from '../../contexts/ThemeContext';
import { PRIMARY_NAV, MORE_NAV, MORE_NAV_SECTIONS } from '../../lib/navConfig';
import { safeGetItem } from '../../lib/storage';
import { pageArt } from '../../lib/artConfig';
import { getActiveBungalow, OPEN_BUNGALOWS_EVENT } from '../../lib/bungalows';
import { ArtImg } from '../ArtImg';

export const TopNav = React.memo(function TopNav() {
  const [open, setOpen] = useState(false);
  const [kebabOpen, setKebabOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const kebabRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const { isDark } = useTheme();

  // Admin link visibility — only show if flag set in localStorage. Keeps the
  // kebab menu empty (and hidden) for ordinary users.
  // F23: read through safeGetItem — touching `window.localStorage` directly
  // throws SecurityError when site data is blocked, and `?.` doesn't guard that.
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

  // Close "More" dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    if (moreOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [moreOpen]);

  // Close both menus on route change.
  // R007 Pattern A — store the previous pathname and compare during render
  // (React docs "store info from previous renders"). No effect runs, no
  // cascading render trigger.
  const [lastPathname, setLastPathname] = useState(location.pathname);
  if (lastPathname !== location.pathname) {
    setLastPathname(location.pathname);
    if (kebabOpen) setKebabOpen(false);
    if (moreOpen) setMoreOpen(false);
  }

  // Audit H-F10: close on Escape + trap focus inside the drawer while open.
  // Without the trap, keyboard Tab escapes to the page content behind the overlay.
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

  // Audit H-F10: body scroll lock while drawer open so the page behind the overlay
  // doesn't scroll when the user drags. Also restore focus to the menu button on close.
  // F12: only restore focus on an actual open→closed transition. The else-branch
  // used to run on first mount (open=false), so on <640px viewports page load
  // programmatically focused the hamburger (SR announced "Open navigation menu").
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
      {/* F8: the app opts into iOS standalone (apple-mobile-web-app-capable +
          viewport-fit=cover), so on a notched home-screen launch the status bar
          would overlay this fixed header. Reserve env(safe-area-inset-top) above
          the 3.5rem bar (the inner row keeps h-14 so it stays below the notch).
          AppLayout's content offset matches with the same calc(). */}
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
        <div className="max-w-[1200px] mx-auto h-14 px-4 md:px-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* F314: the replay easter egg is a distinct 28px button sitting to
                the LEFT of the home logo link (separate targets, gap-2 apart, so
                an off-logo click can't trigger a ~15s replay). A hover play-icon
                overlay makes its purpose legible without altering the art. */}
            <button
              onClick={() => {
                sessionStorage.removeItem('tegridy_loaded');
                sessionStorage.removeItem('tf_loaded');
                window.location.href = '/';
              }}
              className="group relative w-11 h-11 md:w-7 md:h-7 rounded-md overflow-hidden flex-shrink-0 cursor-pointer hover:scale-110 transition-transform"
              style={{ border: '1px solid var(--color-purple-25)' }}
              title="Replay splash screen (full reload)"
              aria-label="Replay splash screen (full reload)"
            >
              <img src={pageArt('nav-logo', 0).src} alt="" className="w-full h-full object-cover" />
              <span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
                style={{ background: 'rgba(0,0,0,0.45)' }}
              >
                <span className="text-white text-[11px] leading-none">&#9658;</span>
              </span>
            </button>
            <Link to="/" className="flex items-center gap-1" title="Go to home page">
              <span className="heading-luxury text-[16px] tracking-wide text-white">TEGRIDY</span>
              <span className="text-[15px] font-semibold tracking-tight text-white">FARMS</span>
            </Link>
            {/* Jungle Bay: the always-visible way back to the bungalow chooser
                (the footer link alone was undiscoverable). Shows where you are;
                opens the picker from any page (AppLayout listens for the
                event). Icon-only below sm to spare the crowded mobile bar. */}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event(OPEN_BUNGALOWS_EVENT))}
              title="Choose your bungalow"
              aria-label="Choose your bungalow"
              className="flex items-center gap-1 px-2 h-11 md:h-7 min-w-[44px] md:min-w-0 justify-center rounded-full text-[11px] flex-shrink-0 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4CAF50]"
              style={{ border: '1px solid var(--color-purple-25)', color: 'var(--color-kyle, #7fd89d)' }}
            >
              <span aria-hidden="true">🏝️</span>
              {/* AUDIT 2026-08-29 (tablet re-pass): the label was `sm:inline`, so
                  between 640-1023px the chip carried a bungalow name AND the full
                  primary nav was showing (R038) AND the wallet button — 21px more
                  than 768px fits, which cut "Connect" off at the right edge. The
                  emoji keeps the control discoverable; the name returns at lg.
                  Bungalow names vary in length ("Brainlet" > "Bayla"), so hiding
                  the label removes that variability from the row entirely. */}
              <span className="hidden lg:inline">{getActiveBungalow()?.name ?? 'Bungalows'}</span>
            </button>
          </div>

          {/* R038: was hidden below md (768px) so iPad portrait (820px) lost the
              primary nav. sm: switches in at 640px so portrait tablets see
              the full top-nav row. */}
          <nav aria-label="Main navigation" className="hidden sm:flex items-center gap-0.5">
            {PRIMARY_NAV.map((n) => (
              <NavLink key={n.to} to={n.to}
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                {n.label}
              </NavLink>
            ))}

            {/* "More" dropdown — secondary destinations (Marketplace, Gallery, etc.)
                that don't fit in the primary nav but still deserve a top-bar slot. */}
            <div className="relative" ref={moreRef}>
              <button
                onClick={() => setMoreOpen(!moreOpen)}
                aria-expanded={moreOpen}
                aria-haspopup="true"
                aria-label="More navigation"
                className={`nav-link flex items-center gap-1 ${MORE_NAV.some(n => location.pathname.startsWith(n.to)) ? 'active' : ''}`}
              >
                More
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                  style={{ transform: moreOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <AnimatePresence>
                {moreOpen && (
                  <m.div
                    className="absolute top-full left-0 mt-1 py-2 rounded-lg w-[240px] flex flex-col gap-y-1 z-50"
                    style={{
                      background: isDark ? 'rgba(10,10,20,0.96)' : 'rgba(255,255,255,0.97)',
                      border: '1px solid var(--color-purple-20)',
                      backdropFilter: 'blur(20px)',
                      WebkitBackdropFilter: 'blur(20px)',
                      boxShadow: isDark ? '0 8px 30px rgba(0,0,0,0.5)' : '0 8px 30px rgba(0,0,0,0.12)',
                    }}
                    initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.15 }}
                    role="menu"
                  >
                    {MORE_NAV_SECTIONS.map((section) => (
                      <div key={section.heading} className="px-2">
                        <p
                          className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-wider font-semibold opacity-60"
                          style={{ color: isDark ? '#fff' : '#1a1a1a' }}
                        >
                          {section.heading}
                        </p>
                        {section.items.map((n) => (
                          <NavLink
                            key={n.to}
                            to={n.to}
                            role="menuitem"
                            className={({ isActive }) => `nav-link flex items-center justify-between gap-2 px-2 py-1.5 text-[12.5px] rounded-md transition-colors ${isActive ? 'active' : ''}`}
                          >
                            <span>{n.label}</span>
                            {n.soon && (
                              <span className="rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px] font-semibold leading-none px-1.5 py-0.5 uppercase tracking-wide">
                                Soon
                              </span>
                            )}
                            {n.live && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[9px] font-semibold leading-none px-1.5 py-0.5 uppercase tracking-wide">
                                <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                                Live
                              </span>
                            )}
                          </NavLink>
                        ))}
                      </div>
                    ))}
                  </m.div>
                )}
              </AnimatePresence>
            </div>
          </nav>

          {/* flex-shrink-0: the wallet cluster is this row's critical action, so
              it must never be the part that gets compressed. (Width is kept in
              budget by the chip-label rule above; the nav itself is deliberately
              NOT given min-w-0/overflow-hidden, because that would clip the
              "More" dropdown, which is absolutely positioned inside it.) */}
          <div className="flex items-center gap-1.5 md:gap-2 min-w-0 flex-shrink-0">
            {/* AUDIT 2026-05-30 (mobile+iPad re-pass): was `hidden md:block` which (a) failed
                to actually hide at 390 in the wild and (b) collided with the Connect button
                at the 768 iPad-portrait breakpoint (50px allocated slot vs 85px text width).
                Bumped to `lg:` (≥1024) so this top-nav link only appears at true desktop —
                mobile + iPad users still reach Tradermigos via the BottomNav tab. `!` prefix
                forces the rules through any selector-specificity override. */}
            <NavLink to="/nakamigos" className={({ isActive }) => `nav-link text-[13px] !hidden lg:!flex ${isActive ? 'active' : ''}`}>
              Tradermigos
            </NavLink>

            {/* Wallet — placed before the theme toggle so the hamburger has a
                clear slot at the far right on narrow viewports. Padding, font
                size, and displayName width all shrink on mobile so long ENS
                names don't push the menu button off-screen. */}
            <ConnectButton.Custom>
              {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
                const connected = mounted && account && chain;
                return (
                  <div className="min-w-0" {...(!mounted && { 'aria-hidden': true, style: { opacity: 0, pointerEvents: 'none', userSelect: 'none' } })}>
                    {!connected ? (
                      <button onClick={openConnectModal} aria-label="Connect wallet" className="btn-primary text-[12px] md:text-[13px] px-3 md:px-4 py-1 md:py-1.5">
                        Connect
                      </button>
                    ) : chain.unsupported ? (
                      <button onClick={openChainModal} aria-label="Switch to correct network" className="btn-secondary text-[11.5px] md:text-[13px] px-2.5 md:px-3 py-1 md:py-1.5 text-danger border-danger/30">
                        Wrong Network
                      </button>
                    ) : (
                      <button onClick={openAccountModal} aria-label="Account details"
                        className="flex items-center gap-1.5 md:gap-2 px-2 md:px-3 py-1 md:py-1.5 min-h-[44px] md:min-h-0 rounded-lg text-[11.5px] md:text-[13px] font-mono text-text-secondary max-w-[140px] md:max-w-none"
                        style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                        <span className="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0" />
                        <span className="truncate">{account.displayName}</span>
                      </button>
                    )}
                  </div>
                );
              }}
            </ConnectButton.Custom>

            {/* The theme toggle lived here until 2026-08-23. Light mode was removed
                (operator decision — it carried an app-wide ~1.5:1 contrast defect), so a
                toggle would have switched between dark and an unstyled page. The app is
                dark-only; see src/contexts/ThemeContext.tsx. */}

            {/* Admin kebab — only rendered if tegridy_admin flag is set */}
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

            <button ref={menuButtonRef} onClick={() => setOpen(true)} aria-label="Open navigation menu" aria-expanded={open} className="sm:hidden p-2 -mr-1 flex-shrink-0 text-text-muted min-w-[44px] min-h-[44px] flex items-center justify-center">
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M3 5h14M3 10h14M3 15h14" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile drawer */}
      <AnimatePresence>
        {open && (
          <>
            <m.div className="fixed inset-0 z-50 bg-black/50 sm:hidden"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setOpen(false)} />
            <m.div
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation menu"
              className="fixed right-0 top-0 bottom-0 z-50 w-56 sm:hidden flex flex-col overflow-hidden"
              style={{ background: 'var(--color-bg-surface)', borderLeft: '1px solid var(--color-purple-75)' }}
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}>
              {/* Art behind the drawer, under a heavy scrim so nav labels keep
                  their contrast. Pickable as `nav-drawer:0` in /art-studio. */}
              <div className="absolute inset-0" aria-hidden="true">
                <ArtImg pageId="nav-drawer" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
              </div>
              <div className="absolute inset-0" aria-hidden="true" style={{ background: 'rgba(6,12,26,0.82)' }} />
              <div className="relative z-10 p-4 flex justify-end">
                <button onClick={() => setOpen(false)} aria-label="Close navigation menu" className="text-text-muted p-2.5 min-w-[48px] min-h-[48px] flex items-center justify-center">
                  <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <path d="M5 5l10 10M15 5l-10 10" />
                  </svg>
                </button>
              </div>
              <nav className="relative z-10 flex-1 px-3 overflow-y-auto pb-6">
                {/* Mirror the desktop "More" dropdown — single source of
                    truth in navConfig. Primary tabs already live in the
                    BottomNav, so the drawer is just the secondary overflow. */}
                {MORE_NAV_SECTIONS.map((section) => (
                  <div key={section.heading} className="mb-3">
                    <p className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold opacity-60 text-text-muted">
                      {section.heading}
                    </p>
                    <div className="space-y-0.5">
                      {section.items.map((n) => (
                        <NavLink key={n.to} to={n.to} onClick={() => setOpen(false)}
                          className={({ isActive }) => `nav-link flex items-center justify-between gap-2 px-2 py-2 rounded-md ${isActive ? 'active' : ''}`}>
                          <span>{n.label}</span>
                          {n.soon && (
                            <span className="rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px] font-semibold leading-none px-1.5 py-0.5 uppercase tracking-wide">
                              Soon
                            </span>
                          )}
                          {n.live && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[9px] font-semibold leading-none px-1.5 py-0.5 uppercase tracking-wide">
                              <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                              Live
                            </span>
                          )}
                        </NavLink>
                      ))}
                    </div>
                  </div>
                ))}
                {showAdmin && (
                  <NavLink to="/admin" onClick={() => setOpen(false)}
                    className={({ isActive }) => `nav-link block px-2 py-2 rounded-md ${isActive ? 'active' : ''}`}>
                    Admin
                  </NavLink>
                )}
              </nav>
            </m.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
});
