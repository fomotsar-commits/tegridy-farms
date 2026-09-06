import { NavLink } from 'react-router-dom';
import React from 'react';
import { useAccount } from 'wagmi';
import { TRADE_ROUTE } from '../../lib/navConfig';

/**
 * Bottom nav tabs — the venue's execution words, on a phone.
 *
 * ⚠️ FIVE IS THE CEILING, and it is a physical one, not a preference: each tab
 * gets `flex-1` of a 390px viewport, and five is where a 44px tap target and a
 * legible 10px label still both fit. The desktop bar carries SIX words plus a
 * conditional Dashboard; this bar therefore cannot be a straight mirror of it,
 * and does not try to be.
 *
 * WHAT IT DROPS AND WHY THAT IS SAFE. Launch and Island are not here. Both are
 * one tap away in the hamburger drawer, which after 2026-09-05 lists every
 * section EXPANDED (TopNav.tsx) rather than one row per section — so the drawer
 * is a complete nav on a phone, not an overflow bucket. What stays is what a
 * visitor does repeatedly: swap, provide liquidity, earn, check a token.
 *
 * Dashboard is the fifth tab and appears ONLY when connected, matching the
 * desktop rule (navConfig.DASHBOARD_NAV) — which is also what keeps this bar at
 * four tabs for a stranger, its most comfortable width.
 *
 * The icons are why this list is a literal rather than a map over NAV_SECTIONS:
 * there is no icon on a NavItem, and inventing a name→icon registry to avoid
 * five hardcoded routes would be more indirection than it removes. The routes
 * ARE section hubs, and navConfig.test.ts asserts every one of them is.
 */
const TABS = [
  { to: TRADE_ROUTE, label: 'Swap', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 10l5-5 5 5M7 14l5 5 5-5" />
    </svg>
  )},
  { to: '/liquidity', label: 'Pools', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3c3.5 4.2 5.5 7 5.5 9.5a5.5 5.5 0 0 1-11 0C6.5 10 8.5 7.2 12 3z" />
    </svg>
  )},
  { to: '/farm', label: 'Earn', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 22V8M12 8c-2-3-6-4-8-2M12 8c2-3 6-4 8-2M5 18h14" />
    </svg>
  )},
  { to: '/trust', label: 'Check', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5.5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )},
];

const DASHBOARD_TAB = { to: '/dashboard', label: 'Dashboard', icon: (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
)};

export const BottomNav = React.memo(function BottomNav() {
  const { isConnected } = useAccount();
  const tabs = isConnected ? [...TABS, DASHBOARD_TAB] : TABS;
  return (
    // R038 / F13, CORRECTED 2026-09-03: this bar hides at >=800px, where the
    // TopNav primary nav switches in (TopNav uses `min-[800px]:flex`). It used to
    // hide at 640px, which is where the TopNav row starts overflowing — so
    // 640-790px lost this bar AND the hamburger AND the off-canvas Connect
    // button at once, leaving no way to navigate or connect. See the long note
    // at TopNav.tsx's <nav>. The content padding band (index.css
    // safe-area-content-bottom, AppLayout pb) ends at 799px to match, so no dead
    // space is reserved for a bar that isn't rendered.
    // safe-area-inset-bottom keeps the bar above the home indicator on
    // notched iOS devices. 44px tap target floor is enforced via min-h.
    <nav aria-label="Main navigation" className="fixed bottom-0 left-0 right-0 z-50 min-[800px]:hidden"
      style={{
        background: 'rgba(6,12,26,0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--color-purple-75)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
      <div className="flex items-center justify-around h-16 safe-area-bottom">
        {tabs.map(tab => (
          <NavLink key={tab.to} to={tab.to} aria-label={tab.label}
            className={({ isActive }) =>
              // F27: `min-w-0` (lets the label truncate) and `min-w-[44px]`
              // contradicted each other — winner was order-dependent. Keep
              // `min-w-0`; the 44px tap floor comes from `flex-1` (each of ≤5
              // tabs gets ≥44px on a phone) + `min-h-[48px]` + padding.
              `flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 min-h-[48px] px-1 py-2 transition-colors ${
                isActive ? 'text-purple-400' : 'text-white/60'
              }`
            }>
            {tab.icon}
            <span className="text-[10px] font-medium leading-tight truncate max-w-full">{tab.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
});
