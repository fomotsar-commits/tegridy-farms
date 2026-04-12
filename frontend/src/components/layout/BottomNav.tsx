import { NavLink, useLocation } from 'react-router-dom';
import React, { useState, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const TABS = [
  { to: '/swap', label: 'Swap', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 10l5-5 5 5M7 14l5 5 5-5" />
    </svg>
  )},
  { to: '/farm', label: 'Farm', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 22V8M12 8c-2-3-6-4-8-2M12 8c2-3 6-4 8-2M5 18h14" />
    </svg>
  )},
  { to: '/dashboard', label: 'Dashboard', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )},
  { to: '/lending', label: 'Lending', icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 2v10l4.5 2.6M12 12L7.5 14.6M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )},
];

const MORE_PAGES = [
  { to: '/liquidity', label: 'Liquidity' },
  { to: '/restake', label: 'Restake' },
  { to: '/premium', label: 'Gold Card' },
  { to: '/launchpad', label: 'Launchpad' },
  { to: '/nft-amm', label: 'NFT AMM' },
  { to: '/leaderboard', label: 'Points' },
  { to: '/gallery', label: 'Gallery' },
  { to: '/nakamigos', label: 'Marketplace' },
  { to: '/grants', label: 'Governance' },
  { to: '/bounties', label: 'Bounties' },
  { to: '/bribes', label: 'Bribes' },
  { to: '/tokenomics', label: 'Tokenomics' },
  { to: '/lore', label: 'Lore' },
  { to: '/history', label: 'History' },
];

const MORE_PATHS = MORE_PAGES.map(p => p.to);

export const BottomNav = React.memo(function BottomNav() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const isMoreActive = MORE_PATHS.some(p => location.pathname === p || location.pathname.startsWith(p + '/'));

  // Close on route change
  useEffect(() => { setOpen(false); }, [location.pathname]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <nav aria-label="Main navigation" className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
      style={{
        background: 'rgba(6,12,26,0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid rgba(139,92,246,0.15)',
      }}>

      {/* More menu popup */}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            className="absolute bottom-full left-0 right-0 px-3 pb-2"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.15 }}
          >
            <div className="rounded-xl overflow-hidden py-1"
              style={{
                background: 'rgba(10,16,32,0.97)',
                border: '1px solid rgba(139,92,246,0.2)',
                backdropFilter: 'blur(20px)',
                boxShadow: '0 -8px 30px rgba(0,0,0,0.5)',
              }}>
              <div className="grid grid-cols-3 gap-0.5 p-2">
                {MORE_PAGES.map(page => (
                  <NavLink
                    key={page.to}
                    to={page.to}
                    className={({ isActive }) =>
                      `flex items-center justify-center py-2.5 px-2 rounded-lg text-[12px] font-medium transition-colors ${
                        isActive ? 'text-primary bg-primary/10' : 'text-white/50 hover:text-white hover:bg-white/5'
                      }`
                    }
                  >
                    {page.label}
                  </NavLink>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center justify-around h-16 safe-area-bottom">
        {TABS.map(tab => (
          <NavLink key={tab.to} to={tab.to} aria-label={tab.label}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 min-w-[52px] min-h-[48px] px-2 py-2 transition-colors ${
                isActive ? (tab.gold ? 'text-[#d4a017]' : 'text-primary') : (tab.gold ? 'text-[#d4a017]/50' : 'text-white/40')
              }`
            }>
            {tab.icon}
            <span className={`text-[10px] font-medium ${tab.gold ? '' : ''}`}>{tab.label}</span>
          </NavLink>
        ))}

        {/* More button */}
        <button
          onClick={() => setOpen(!open)}
          aria-label="More pages"
          aria-expanded={open}
          className={`flex flex-col items-center justify-center gap-0.5 min-w-[52px] min-h-[48px] px-2 py-2 transition-colors cursor-pointer ${
            isMoreActive || open ? 'text-primary' : 'text-white/40'
          }`}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="5" cy="12" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="19" cy="12" r="1.5" />
          </svg>
          <span className="text-[10px] font-medium">More</span>
        </button>
      </div>
    </nav>
  );
});
