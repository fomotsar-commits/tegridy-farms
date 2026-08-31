import { NavLink } from 'react-router-dom';
import React from 'react';
import { NFT_FINANCE_LIVE } from '../../lib/navConfig';

/**
 * Bottom nav tabs — primary destinations mirrored from TopNav's PRIMARY_NAV
 * plus Tradermigos. Secondary routes live in the TopNav hamburger drawer.
 * Theme toggle is desktop-only (TopNav) — mobile has limited bottom real
 * estate and theme is a low-frequency action.
 *
 * CREDIBILITY GATING (2026-06-09): this list hardcodes its tabs for the
 * icon pairing, so it must apply the same isDeployed gating as PRIMARY_NAV —
 * the NFT Finance tab hides while all its contracts are zeroed and returns
 * automatically on redeploy (see navConfig.NFT_FINANCE_LIVE).
 */
const ALL_TABS = [
  { to: '/dashboard', label: 'Dashboard', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )},
  { to: '/farm', label: 'Farm', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 22V8M12 8c-2-3-6-4-8-2M12 8c2-3 6-4 8-2M5 18h14" />
    </svg>
  )},
  { to: '/swap', label: 'Trade', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 10l5-5 5 5M7 14l5 5 5-5" />
    </svg>
  )},
  { to: '/nft-finance', label: 'NFT Finance', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M7 15h3" />
    </svg>
  )},
  { to: '/nakamigos', label: 'Marketplace', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect x="7" y="8" width="3" height="3" />
      <rect x="14" y="8" width="3" height="3" />
      <path d="M8 15c1.5 1.5 6.5 1.5 8 0" />
    </svg>
  )},
];

const TABS = ALL_TABS.filter((t) => t.to !== '/nft-finance' || NFT_FINANCE_LIVE);

export const BottomNav = React.memo(function BottomNav() {
  return (
    // R038 / F13: `sm:hidden` hides the bar at ≥640px, where the TopNav primary
    // nav switches in (TopNav uses `sm:flex`). The content padding band
    // (index.css safe-area-content-bottom, AppLayout pb) ends at 639px to match,
    // so 640-767px reserves no dead space for a nav that isn't rendered.
    // safe-area-inset-bottom keeps the bar above the home indicator on
    // notched iOS devices. 44px tap target floor is enforced via min-h.
    <nav aria-label="Main navigation" className="fixed bottom-0 left-0 right-0 z-50 sm:hidden"
      style={{
        background: 'rgba(6,12,26,0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--color-purple-75)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
      <div className="flex items-center justify-around h-16 safe-area-bottom">
        {TABS.map(tab => (
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
