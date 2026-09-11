import { NavLink, Link, useLocation } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import React, { useState, useRef, useEffect } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { useTheme } from '../../contexts/ThemeContext';
import { NAV_SECTIONS, DASHBOARD_NAV } from '../../lib/navConfig';
import type { NavSection } from '../../lib/navConfig';
import { safeGetItem } from '../../lib/storage';
import { pageArt } from '../../lib/artConfig';
import { getActiveBungalow, OPEN_BUNGALOWS_EVENT } from '../../lib/bungalows';
import { ArtImg } from '../ArtImg';
import { VENUE } from '../../lib/arrival';
import { artImgProps } from '../../lib/artSrcSet';

/**
 * Is any of this section's destinations the page we are on?
 *
 * A section's word links to its hub only, so a plain `<NavLink to={hub}>` would
 * go dim the moment the visitor moved to a sibling tab — standing on /scan, the
 * "Check" word they got there through would read as inactive. The word
 * represents the whole section, so it is lit by the whole section.
 *
 * Segment-boundary matching, not `startsWith`: `/launch-simulator` starts with
 * `/launch` and is a different destination.
 */
function sectionIsActive(section: NavSection, pathname: string): boolean {
  return section.items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
}

/* NavPills (the amber SOON / green LIVE badges) was deleted 2026-09-05 with the
   drawer's expanded item list, its only caller. The pills are not lost: they
   belong to ITEMS, and items are now rendered by each host's RouteTabs, which
   draws the same two badges from the same NavItem. Both navs show one row per
   section, so neither has an item to pin a pill to. */

export const TopNav = React.memo(function TopNav() {
  const [open, setOpen] = useState(false);
  const [kebabOpen, setKebabOpen] = useState(false);
  const kebabRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const { isDark } = useTheme();
  // Dashboard joins the bar only once there is an account for it to describe.
  // `useAccount` is already provided app-wide by WagmiProvider (App.tsx), and
  // this component is inside it — the same hook StakingCard and the rest use.
  const { isConnected } = useAccount();

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

  // ⌫ The "More" dropdown's outside-click and Escape handlers lived here. Both
  // went with the dropdown on 2026-09-05: there is no popup in the desktop bar
  // any more, only six links and a conditional seventh.

  // Close the kebab on route change.
  // R007 Pattern A — store the previous pathname and compare during render
  // (React docs "store info from previous renders"). No effect runs, no
  // cascading render trigger.
  const [lastPathname, setLastPathname] = useState(location.pathname);
  if (lastPathname !== location.pathname) {
    setLastPathname(location.pathname);
    if (kebabOpen) setKebabOpen(false);
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
        {/* px-2 below 400px, px-3 to 480, then px-4. The narrowest phones need
            every pixel of this back; each step is restored the moment there is
            room for it. See the gap comment below for what this is paying for. */}
        <div className="max-w-[1200px] mx-auto h-14 px-2 min-[400px]:px-3 min-[480px]:px-4 md:px-6 flex items-center justify-between">
          {/* 🔴 THE 360px ROW. e2e/header-reachability.spec.ts measured
              scrollWidth 362 against clientWidth 360 in CI — the header
              overflowing its own viewport on the narrowest supported phone.
              CAUSE: the display face moved from Playfair Display to Archivo
              (03552f3c) and the wordmark got wider; the identity comment below
              had already sized the TYPE down for exactly this reason in August,
              and the new face ate the margin that bought. CI rasterises Archivo
              a shade wider than a local run, so 360px passes here and fails
              there — do not trust a local green on this one.

              WHY IT WAS INVISIBLE UNTIL NOW: the spec measured `locator('header')`,
              which matched a second <header> inside YieldCalculator, so it threw
              a strict-mode violation BEFORE it ever reached this measurement.
              The overflow is older than the fix that revealed it.

              FIXED IN THE GAPS AND THE PADDING, NOT THE TYPE, on purpose: the
              2026-08-31 owner rule is that the mark stays whole and
              un-abbreviated at every width, so shrinking it again is the one
              lever that is not available. Three levers, all below 400px, all
              measured at 360: row padding px-3→px-2 buys 8px of content box
              (336→344), these two gaps 4px→2px take the left group 222→218, and
              the right group's gap-1.5→gap-1 takes it 121.3→119.3 — note that
              group is `flex-shrink-0`, so its width is a hard floor and the
              wordmark is what silently absorbs any shortfall. 14px bought
              against a 2px overrun: margin for the next face, not a fix that is
              exactly big enough.

              VERIFIED BY SWEEP, not by the arithmetic above: with these three
              levers the row's intrinsic width is 350px, so it still fits at a
              352px viewport and only overflows at 348. That is 10px of headroom
              at 360 against CI's 2px overrun. Before them the row measured
              exactly 360 at 360 — zero slack, which is why a rasteriser a shade
              wider than local was enough to tip it. If you change anything in
              this row, re-run the sweep rather than a local 360px check: 360
              passed locally on the broken version too. */}
          <div className="flex items-center gap-0.5 min-[400px]:gap-1 min-[480px]:gap-2">
            {/* WAVE SEVEN, element A: the F314 replay easter egg is RETIRED, on the
                island's ruling — "one door for the film". The arrival now has exactly
                one way to watch it deliberately: "Watch the arrival" in the Island
                lobby, which plays the whole four-piece film with its hold, crack and
                shatter. Two doors to the same room is the thing this wave removes.

                THE LOGO WAS INSIDE THAT BUTTON, and it does not leave with it. The
                mark is re-homed here, into the way-back Link, before the button was
                cut — deleting the button as written would have taken the venue's
                identity off the bar, which is an art removal and never allowed
                without a home to move to. */}
            {/* THE WAY BACK (owner, 2026-08-31), now handled at the destination
                (2026-09-04). This used to carry a hand-rolled onClick that
                persisted the 'venue' sentinel and hard-assigned '/', because a
                plain <Link to="/"> landed back inside the stored bungalow.

                That was true, and it was true of EVERY link to "/" — the 404
                page's "Back to Home" and the footer among them — so the
                wordmark being the only one that worked was the actual bug. The
                index route is now the venue's own <BungalowDoor id="venue">
                (App.tsx), which clears the skin on arrival with the same
                verified-persist and one-shot-reload guards every other door
                uses.

                So this is a plain Link again, deliberately: one mechanism for
                the rule instead of two that can drift apart. */}
            <Link
              to="/"
              className="flex items-center gap-1.5 min-[480px]:gap-2"
              title="Back to memetics.finance"
            >
              {/* The nav logo is a 512x512 PNG rendered at 28px (desktop) / 44px
                  (mobile), so it is the single clearest case for a small
                  candidate. `sizes` is spelled out because this image is EAGER
                  by design -- it is above the fold on every route -- and
                  `sizes="auto"` is only valid on a lazy image. Omit it and the
                  browser falls back to the 100vw default, picks the full-size
                  original, and the srcset saves nothing at all.

                  This was lost once already: a nav refactor replaced this
                  element with a bare <img> and nothing failed, because a missing
                  optimisation is invisible. TopNav.navLogo.test.tsx pins it, and
                  now pins it here rather than inside the retired replay button. */}
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
              {/* ARRIVAL IDENTITY 2026-08-27: the wordmark follows the arrival
                  voice. The venue speaks as itself by default; the classic
                  TEGRIDY FARMS mark lives inside the TOWELI bungalow. */}
              {/* RETIRED 2026-08-31 (owner): the wordmark no longer forks by voice.
                  The venue's name is the only one the app speaks, in every room
                  including the TOWELI bungalow. Towelie keeps his farm and his
                  voice; the brand word is gone. */}
              {/* SIZED DOWN BELOW 480px, not truncated. Re-tightened 2026-09-04
                  when the display face changed: Archivo at 900 sets wider than
                  Playfair did, which pushed this row back over its own budget at
                  375px (379 > 375). The e2e overflow guard caught it before merge,
                  which is the whole reason that guard exists. The mark stays whole —
                  both halves always render, so the venue's name is never
                  abbreviated or forked (the 2026-08-31 identity rule). This only
                  buys back width on the narrowest phones, where the row was
                  overflowing its viewport by ~50px and pushing the hamburger —
                  the ONLY nav control at that width — partly off-screen.
                  Caught by e2e/header-reachability.spec.ts, which asserts the
                  row never overflows; the fix for the 640-790px band left this
                  narrower case standing. */}
              <span className="heading-luxury text-[12px] min-[480px]:text-[16px] tracking-wide text-white">{VENUE.markMain}</span>
              <span className="text-[11px] min-[480px]:text-[15px] font-semibold tracking-tight" style={{ color: 'var(--color-kyle)' }}>{VENUE.markSub}</span>
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
              primary nav.
              🔴 CORRECTED 2026-09-03 — R038's `sm:` (640px) overshot by 160px and
              opened a DEAD BAND. This row needs 790px of content (left group 264
              + this nav 427 + the wallet cluster 102 + padding). At 640px `sm:`
              turned this nav ON while `sm:hidden` turned the hamburger AND the
              BottomNav OFF, so the row overflowed to 809px and pushed the Connect
              button to x=707..809 — off-canvas. The header is `fixed`, so the
              overflow never extended the document (scrollWidth === viewport at
              every width in the band): there was no scrolling to it either. From
              640px to 790px the app had NO reachable wallet control and no nav
              fallback. Measured with Playwright, not inferred.
              The window for this breakpoint is narrow and both edges are real:
              content needs >=791, and the iPad-gen-7 e2e project is 810px wide and
              must keep the nav. 800px sits between them.
              R038's actual requirement — iPad portrait keeps the primary nav — is
              still met (810 and 820 are both >= 800).
              SEVEN SITES MOVE TOGETHER. Splitting them re-opens the band:
                this nav, the hamburger, the drawer overlay, the drawer itself,
                BottomNav.tsx, AppLayout.tsx's content pb, and the two
                max-width:799px blocks in index.css.
              e2e/header-reachability.spec.ts pins the invariant (no overflow,
              Connect on-canvas) rather than the literal. NOTE: there is no
              TopNav.responsive.test.ts, despite what this comment said until
              2026-09-05 — the guard is the e2e spec, and it sweeps real widths. */}
          <nav aria-label="Main navigation" className="hidden min-[800px]:flex items-center gap-0.5">
            {/* THE SIX WORDS + DASHBOARD, 2026-09-05.
                PRIMARY_NAV is derived from NAV_SECTIONS (navConfig.ts), so this
                row cannot disagree with the tab strips underneath it. Each word
                is lit by its WHOLE section, not just by its own href: standing
                on /scan, "Check" must not go dim because the visitor moved off
                /trust — the word represents the section it opens. That is the
                same sectionIsActive() the collapsed dropdown rows used to use,
                which is why it survived the dropdown's deletion. */}
            {NAV_SECTIONS.map((section) => (
              <NavLink
                key={section.heading}
                to={section.primaryTo ?? section.hub}
                className={`nav-link ${sectionIsActive(section, location.pathname) ? 'active' : ''}`}
              >
                {section.heading}
              </NavLink>
            ))}

            {/* Dashboard, LAST and only once connected — see DASHBOARD_NAV.
                It is the one destination that is empty for a stranger, and it
                used to be the first word in this bar. */}
            {isConnected && (
              <NavLink
                to={DASHBOARD_NAV.to}
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              >
                {DASHBOARD_NAV.label}
              </NavLink>
            )}
          </nav>

          {/* ── the deleted "More" dropdown ──────────────────────────────────
              Removed 2026-09-05. It held five sections behind one word that,
              in the operator's reading, "means we couldn't decide" — and it made
              the site three levels deep (More → section → page) for a nav that
              now fits in six words. Every destination it listed is either a
              top-bar word or a tab on the page one of those words opens; nothing
              became unreachable, which navConfig.test.ts asserts against the
              route table rather than trusting this comment.

              The state it needed (moreOpen, moreRef, moreTriggerRef, the
              outside-click and Escape handlers, FIRST_HUB_INDEX) went with it.
              The mobile drawer keeps its own list — BottomNav shows five tabs,
              so the drawer is still the only way to the rest below 800px. */}

          {/* flex-shrink-0: the wallet cluster is this row's critical action, so
              it must never be the part that gets compressed. (Width is kept in
              budget by the chip-label rule above.) */}
          <div className="flex items-center gap-1 min-[400px]:gap-1.5 md:gap-2 min-w-0 flex-shrink-0">
            {/* ⌫ The right-aligned "Marketplace" link stood here until
                2026-09-05. It is a destination inside the Island section now, so
                keeping it in this cluster would be the same link twice — and it
                was the extra word that pushed this row toward the Connect button
                at iPad-portrait widths in the first place (the AUDIT 2026-05-30
                note it carried was about exactly that collision). Deleting it
                buys back the width the sixth nav word costs. */}

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
                      /* AE1(c)+(d), 2026-09-03.
                         (c) This was `.btn-primary` — byte-identical to the hero's
                         "Pick a bungalow" gradient, so two unrelated actions wore the
                         same paint in the same viewport and neither read as primary.
                         Outlined in the same kyle green: still unmistakably the wallet
                         control, no longer competing with the page's own CTA.
                         (d) A field review reported this button as `text-[12px] px-3
                         py-1` — "the most important control is the smallest". Those
                         Tailwind utilities never applied: index.css's unlayered
                         `.btn-primary` outranks Tailwind's layered ones, so the button
                         measured 14px / 43px on desktop and 44px on mobile, already
                         meeting the review's ask. The classes were dead, not small.
                         They are gone rather than "fixed", and the sizing is explicit
                         here instead of arriving from a class this element no longer
                         wants. min-h keeps the 44px tap target index.css was giving it.
                         (e) OFF GREEN, 2026-09-05. (c) stopped this competing on WEIGHT
                         but left it competing on HUE: outlined kyle-green here, and a
                         filled kyle-green "Stake X" in the hero directly below it, so
                         one colour carried two unrelated jobs in a single viewport. It
                         now wears the brand purple — the hue this bar is already built
                         from (--color-purple-75 borders here, text-purple-400 for the
                         active tab in BottomNav), so the wallet control reads as part
                         of the chrome it lives in rather than as a page action. Green
                         goes back to meaning exactly one thing: stake. */
                      <button
                        onClick={openConnectModal}
                        aria-label="Connect wallet"
                        className="text-[13px] md:text-[14px] font-semibold rounded-lg px-2.5 md:px-4 py-1.5 min-h-[44px] md:min-h-[36px] transition-all hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6]"
                        style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(139,92,246,0.60)', color: 'var(--color-primary)' }}
                      >
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

            <button ref={menuButtonRef} onClick={() => setOpen(true)} aria-label="Open navigation menu" aria-expanded={open} className="min-[800px]:hidden p-2 -mr-1 flex-shrink-0 text-text-muted min-w-[44px] min-h-[44px] flex items-center justify-center">
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
            <m.div className="fixed inset-0 z-50 bg-black/50 min-[800px]:hidden"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setOpen(false)} />
            <m.div
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation menu"
              className="fixed right-0 top-0 bottom-0 z-50 w-56 min-[800px]:hidden flex flex-col overflow-hidden"
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
                {/* THE DRAWER IS THE WHOLE NAV BELOW 800px, and it shows ONE
                    ROW PER SECTION — the section's own page, not its tabs.

                    Reverted 2026-09-05 on owner report: expanded, six sections
                    became roughly thirty rows and the drawer outgrew the screen
                    on both phone and iPad, which is the complaint that started
                    the whole condensation. The earlier rationale — that a
                    collapsed row means "tap, wait for a page to load, then read
                    the tabs" — is true and is the price; a menu you have to
                    scroll to the end of to find anything costs more.

                    NOTHING IS UNREACHABLE. Every section has a `hub`, every hub
                    routes to a tabbed host (TradeHostPage, PoolsHostPage,
                    IslandPage, LaunchHubPage, EarnPage, TrustPage), and each host
                    renders that same section's items as its tab strip — so the
                    row opens the page whose tabs are the rows this no longer
                    prints. That is checked by TopNav.drawerCollapse.test.tsx,
                    not assumed.

                    Still one source of truth: NAV_SECTIONS, the same array the
                    desktop row and every SectionHost read. */}
                {NAV_SECTIONS.map((section) => (
                  <div key={section.heading} className="mb-3">
                    <NavLink
                      to={section.primaryTo ?? section.hub}
                      onClick={() => setOpen(false)}
                      className={`nav-link block px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold rounded-md ${sectionIsActive(section, location.pathname) ? 'active' : 'opacity-60'}`}
                    >
                      {section.heading}
                    </NavLink>
                  </div>
                ))}
                {/* Dashboard, last and only once connected — the same rule the
                    desktop bar follows, from the same export. */}
                {isConnected && (
                  <NavLink to={DASHBOARD_NAV.to} onClick={() => setOpen(false)}
                    className={({ isActive }) => `nav-link block px-2 py-2 rounded-md mb-3 ${isActive ? 'active' : ''}`}>
                    {DASHBOARD_NAV.label}
                  </NavLink>
                )}
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
