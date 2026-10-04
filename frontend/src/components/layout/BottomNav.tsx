import { NavLink, useLocation } from 'react-router-dom';
import React from 'react';
import { useAccount } from 'wagmi';
import { CHECK_SECTION, EARN_SECTION, POOLS_SECTION, SWAP_SECTION, sectionIsActive, tradeRoute } from '../../lib/navConfig';
import { useActiveBungalowId } from '../../hooks/useActiveBungalowId';

/**
 * The phone bar: swap, pools, earn, check, plus Dashboard once connected. Five
 * tabs is the ceiling (a 44px target and a 10px label at 390px). Launch and
 * Island live in the drawer, which lists every section expanded (TopNav.tsx).
 * A literal list, because a NavItem carries no icon.
 */
// Swap's route follows the room (tradeRoute), so it is completed at render.
// `section`: a tab is lit on every page of its section, as the top bar's word is. Lit
// only on its own URL, "Pools" went dark on the Solana LP tab one press away.
const SWAP_TAB = { label: 'Swap', section: SWAP_SECTION, icon: (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M7 10l5-5 5 5M7 14l5 5 5-5" />
  </svg>
)};

const TABS = [
  { to: '/liquidity', label: 'Pools', section: POOLS_SECTION, icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3c3.5 4.2 5.5 7 5.5 9.5a5.5 5.5 0 0 1-11 0C6.5 10 8.5 7.2 12 3z" />
    </svg>
  )},
  { to: '/earn', label: 'Earn', section: EARN_SECTION, icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 22V8M12 8c-2-3-6-4-8-2M12 8c2-3 6-4 8-2M5 18h14" />
    </svg>
  )},
  { to: '/trust', label: 'Check', section: CHECK_SECTION, icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5.5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )},
];

const DASHBOARD_TAB = { to: '/dashboard', label: 'Dashboard', section: null, icon: (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
)};

export const BottomNav = React.memo(function BottomNav() {
  const { isConnected } = useAccount();
  useActiveBungalowId();
  const { pathname } = useLocation();
  const tabs = [{ ...SWAP_TAB, to: tradeRoute() }, ...TABS, ...(isConnected ? [DASHBOARD_TAB] : [])];
  return (
    // Hides at >=800px, where TopNav's bar appears; AppLayout's pb and index.css's
    // safe-area-content-bottom end at 799px to match. safe-area-inset-bottom keeps it
    // above the iOS home indicator.
    <nav aria-label="Main navigation" className="fixed bottom-0 left-0 right-0 z-50 min-[800px]:hidden"
      style={{
        background: 'rgba(6,12,26,0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--color-purple-75)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
      {/* No bottom inset on this row: the nav above already pads by it. Padding both
          took the inset out of this row's own 64px, so a large inset (an Android 15
          in-app browser, seen on a Galaxy S25) left the icons no room and they sat
          on the nav's top border, over the page. */}
      <div className="flex items-center justify-around h-16">
        {tabs.map(tab => (
          <NavLink key={tab.to} to={tab.to} aria-label={tab.label}
            data-lit={tab.section ? sectionIsActive(tab.section, pathname) : undefined}
            className={({ isActive }) =>
              // min-w-0 lets the label truncate; the 44px floor comes from flex-1 and min-h.
              `flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 min-h-[48px] px-1 py-2 transition-colors ${
                isActive || (tab.section && sectionIsActive(tab.section, pathname)) ? 'text-purple-400' : 'text-white/60'
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
