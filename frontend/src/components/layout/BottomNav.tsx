import { NavLink, useLocation } from 'react-router-dom';
import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { MORE_NAV, MORE_NAV_SECTIONS } from '../../lib/navConfig';

/**
 * Bottom nav tabs — primary destinations mirrored from TopNav's PRIMARY_NAV
 * plus Tradermigos. The 6th slot is a "More" trigger that opens a bottom
 * sheet with the same secondary routes as TopNav's desktop "More" dropdown,
 * so mobile users don't depend on the top-bar hamburger that gets pushed
 * off-screen by long wallet display names on narrow viewports.
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

const MORE_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="19" cy="12" r="1.4" />
  </svg>
);

export const BottomNav = React.memo(function BottomNav() {
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();

  const isOnMoreRoute = MORE_NAV.some((n) => location.pathname.startsWith(n.to));

  // Close sheet on route change
  useEffect(() => { setMoreOpen(false); }, [location.pathname]);

  // Close on Escape + lock body scroll while open
  useEffect(() => {
    if (!moreOpen) {
      triggerRef.current?.focus();
      return;
    }
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMoreOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', handleKey);
    };
  }, [moreOpen]);

  return (
    <>
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
            ref={triggerRef}
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label="More navigation"
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            className={`flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 min-h-[48px] px-1 py-2 transition-colors ${
              moreOpen || isOnMoreRoute ? 'text-purple-400' : 'text-white/60'
            }`}
          >
            {MORE_ICON}
            <span className="text-[9.5px] font-medium leading-tight">More</span>
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {moreOpen && (
          <>
            <m.div
              className="fixed inset-0 z-[60] bg-black/55 md:hidden"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setMoreOpen(false)}
              aria-hidden="true"
            />
            <m.div
              ref={sheetRef}
              role="dialog"
              aria-modal="true"
              aria-label="More navigation"
              className="fixed left-0 right-0 bottom-0 z-[70] md:hidden rounded-t-2xl flex flex-col"
              style={{
                background: 'rgba(10,14,26,0.98)',
                borderTop: '1px solid var(--color-purple-75)',
                maxHeight: '80vh',
                backdropFilter: 'blur(24px)',
                WebkitBackdropFilter: 'blur(24px)',
              }}
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            >
              {/* Grabber */}
              <div className="flex justify-center pt-2 pb-1" aria-hidden="true">
                <div className="w-10 h-1 rounded-full bg-white/25" />
              </div>
              <div className="flex items-center justify-between px-5 pt-1 pb-2">
                <h2 className="text-white text-[13px] font-semibold uppercase tracking-wider">More</h2>
                <button
                  type="button"
                  onClick={() => setMoreOpen(false)}
                  aria-label="Close more navigation"
                  className="text-white/60 hover:text-white p-2 -mr-2 min-w-[40px] min-h-[40px] flex items-center justify-center"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
              <div
                className="overflow-y-auto px-4 pb-8"
                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}
              >
                {MORE_NAV_SECTIONS.map((section) => (
                  <div key={section.heading} className="mb-4">
                    <p className="px-2 pt-2 pb-1.5 text-[10px] uppercase tracking-wider font-semibold text-white/45">
                      {section.heading}
                    </p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {section.items.map((n) => (
                        <NavLink
                          key={n.to}
                          to={n.to}
                          onClick={() => setMoreOpen(false)}
                          className={({ isActive }) =>
                            `block px-3 py-2.5 rounded-lg text-[13.5px] transition-colors ${
                              isActive
                                ? 'bg-purple-500/20 text-purple-200 border border-purple-500/40'
                                : 'text-white/85 hover:text-white bg-white/5 border border-white/10 hover:bg-white/10'
                            }`
                          }
                        >
                          {n.label}
                        </NavLink>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </m.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
});
