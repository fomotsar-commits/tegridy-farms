import { NavLink } from 'react-router-dom';
import React from 'react';

/**
 * Bottom nav tabs — identical set and order to TopNav's PRIMARY_NAV so
 * desktop and mobile IA stay symmetric. Everything else is demoted to
 * the Footer, reachable by scrolling down on mobile.
 */
const TABS = [
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
  { to: '/community', label: 'Governance', icon: (
    // Inline SVG — ballot box with check, matches existing 1.8 stroke-width convention
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16v13H4z" />
      <path d="M9 3h6v4H9z" />
      <path d="M9 13l2 2 4-4" />
    </svg>
  )},
];


export const BottomNav = React.memo(function BottomNav() {
  return (
    <nav aria-label="Main navigation" className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
      style={{
        background: 'rgba(6,12,26,0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--color-purple-75)',
      }}>
      <div className="flex items-center justify-around h-16 safe-area-bottom">
        {TABS.map(tab => (
          <NavLink key={tab.to} to={tab.to} aria-label={tab.label}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 min-w-[52px] min-h-[48px] px-2 py-2 transition-colors ${
                isActive ? 'text-purple-400' : 'text-white/60'
              }`
            }>
            {tab.icon}
            <span className="text-[10px] font-medium">{tab.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
});
