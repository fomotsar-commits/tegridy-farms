import { NavLink } from 'react-router-dom';
import React from 'react';
import { useTheme } from '../../contexts/ThemeContext';

/**
 * Bottom nav tabs — primary destinations mirrored from TopNav's PRIMARY_NAV,
 * plus Tradermigos and a theme toggle. The theme toggle lives here (not in
 * TopNav on mobile) because the top bar is too narrow for wallet + theme +
 * hamburger on iPhone-class widths. Secondary routes reach the user via
 * TopNav's hamburger → drawer.
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
  { to: '/nakamigos', label: 'Tradermigos', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect x="7" y="8" width="3" height="3" />
      <rect x="14" y="8" width="3" height="3" />
      <path d="M8 15c1.5 1.5 6.5 1.5 8 0" />
    </svg>
  )},
];

export const BottomNav = React.memo(function BottomNav() {
  const { isDark, toggleTheme } = useTheme();

  return (
    <nav aria-label="Main navigation" className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
      style={{
        background: 'rgba(6,12,26,0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--color-purple-75)',
      }}>
      <div className="flex items-stretch justify-around h-16 safe-area-bottom">
        {TABS.map(tab => (
          <NavLink key={tab.to} to={tab.to} aria-label={tab.label}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 min-h-[48px] px-1 py-2 transition-colors ${
                isActive ? 'text-purple-400' : 'text-white/60'
              }`
            }>
            {tab.icon}
            <span className="text-[9.5px] font-medium leading-tight truncate max-w-full">{tab.label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 min-h-[48px] px-1 py-2 text-white/60 hover:text-white transition-colors"
        >
          {isDark ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
          <span className="text-[9.5px] font-medium leading-tight">{isDark ? 'Light' : 'Dark'}</span>
        </button>
      </div>
    </nav>
  );
});
