import { NavLink, Link, useLocation } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import React, { useState, useRef, useEffect } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { useTheme } from '../../contexts/ThemeContext';
import { PRIMARY_NAV, MORE_NAV, ALL_NAV, MORE_PATHS } from '../../lib/navConfig';

export const TopNav = React.memo(function TopNav() {
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const { isDark, toggleTheme } = useTheme();
  const isMoreActive = MORE_PATHS.some(p => location.pathname === p || location.pathname.startsWith(p + '/'));

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    if (moreOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [moreOpen]);

  // Close dropdown on route change
  useEffect(() => { setMoreOpen(false); }, [location.pathname]);

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
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    } else {
      // Return focus to the menu-open button on close (if it was the opener)
      menuButtonRef.current?.focus();
    }
  }, [open]);

  return (
    <>
      <header
        className="fixed top-0 left-0 right-0 z-50 h-14"
        style={{
          background: isDark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.80)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderBottom: '1px solid var(--color-purple-20)',
          boxShadow: isDark
            ? '0 1px 12px var(--color-purple-75), 0 0 1px var(--color-purple-75)'
            : '0 1px 12px rgba(124,58,237,0.10), 0 0 1px rgba(124,58,237,0.15)',
          transition: 'background-color 0.3s ease, box-shadow 0.3s ease',
        }}
      >
        {/* Subtle accent line at very top */}
        <div className="absolute top-0 left-0 right-0 h-[1px]" style={{
          background: 'linear-gradient(90deg, transparent 0%, var(--color-purple-75) 30%, var(--color-purple-50) 50%, var(--color-purple-75) 70%, transparent 100%)',
        }} />
        <div className="max-w-[1200px] mx-auto h-full px-4 md:px-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                sessionStorage.removeItem('tegridy_loaded');
                sessionStorage.removeItem('tf_loaded');
                window.location.href = '/';
              }}
              className="w-7 h-7 rounded-md overflow-hidden flex-shrink-0 cursor-pointer hover:scale-110 transition-transform"
              style={{ border: '1px solid var(--color-purple-25)' }}
              title="Replay splash screen (full reload)"
              aria-label="Replay splash screen (full reload)"
            >
              <img src="/art/bobowelie.jpg" alt="" className="w-full h-full object-cover" />
            </button>
            <Link to="/" className="flex items-center gap-1" title="Go to home page">
              <span className="heading-luxury text-[16px] tracking-wide text-white">TEGRIDY</span>
              <span className="text-[15px] font-semibold tracking-tight text-text-white">FARMS</span>
            </Link>
          </div>

          <nav aria-label="Main navigation" className="hidden md:flex items-center gap-0.5">
            {PRIMARY_NAV.map((n) => (
              <NavLink key={n.to} to={n.to}
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                {n.label}
              </NavLink>
            ))}

            {/* Community */}
            <NavLink to="/community"
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              Community
            </NavLink>

            {/* More dropdown */}
            <div className="relative" ref={moreRef}>
              <button
                onClick={() => setMoreOpen(!moreOpen)}
                aria-expanded={moreOpen}
                aria-haspopup="true"
                className={`nav-link flex items-center gap-1 ${isMoreActive ? 'active' : ''}`}
              >
                More
                <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" className={`transition-transform ${moreOpen ? 'rotate-180' : ''}`}>
                  <path d="M2 4l3 3 3-3" />
                </svg>
              </button>
              <AnimatePresence>
                {moreOpen && (
                  <m.div
                    className="absolute top-full right-0 mt-1 py-1 rounded-lg min-w-[160px]"
                    style={{
                      background: isDark ? 'rgba(10,10,20,0.95)' : 'rgba(255,255,255,0.97)',
                      border: '1px solid var(--color-purple-20)',
                      backdropFilter: 'blur(20px)',
                      boxShadow: isDark ? '0 8px 30px rgba(0,0,0,0.5)' : '0 8px 30px rgba(0,0,0,0.12)',
                    }}
                    initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.15 }}
                  >
                    {MORE_NAV.map((n) => (
                      <NavLink key={n.to} to={n.to}
                        className={({ isActive }) => `nav-link block px-4 py-2 text-[13px] transition-colors ${isActive ? 'active' : ''}`}>
                        {n.label}
                      </NavLink>
                    ))}
                  </m.div>
                )}
              </AnimatePresence>
            </div>
          </nav>

          <div className="flex items-center gap-2">
            <NavLink to="/leaderboard" className={({ isActive }) => `nav-link text-[13px] hidden md:block ${isActive ? 'active' : ''}`}>
              Points
            </NavLink>
            <button
              onClick={toggleTheme}
              aria-label={isDark ? 'Toggle light mode' : 'Toggle dark mode'}
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-text-secondary hover:text-primary transition-colors"
              style={{ background: 'var(--color-purple-10)', border: '1px solid var(--color-purple-15)' }}
            >
              {isDark ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
            <ConnectButton.Custom>
              {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
                const connected = mounted && account && chain;
                return (
                  <div {...(!mounted && { 'aria-hidden': true, style: { opacity: 0, pointerEvents: 'none', userSelect: 'none' } })}>
                    {!connected ? (
                      <button onClick={openConnectModal} aria-label="Connect wallet" className="btn-primary text-[13px] px-4 py-1.5">
                        Connect
                      </button>
                    ) : chain.unsupported ? (
                      <button onClick={openChainModal} aria-label="Switch to correct network" className="btn-secondary text-[13px] px-3 py-1.5 text-danger border-danger/30">
                        Wrong Network
                      </button>
                    ) : (
                      <button onClick={openAccountModal} aria-label="Account details"
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] font-mono text-text-secondary"
                        style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                        <span className="w-1.5 h-1.5 rounded-full bg-success" />
                        {account.displayName}
                      </button>
                    )}
                  </div>
                );
              }}
            </ConnectButton.Custom>

            <button ref={menuButtonRef} onClick={() => setOpen(true)} aria-label="Open navigation menu" aria-expanded={open} className="md:hidden p-2.5 -mr-2 text-text-muted min-w-[48px] min-h-[48px] flex items-center justify-center">
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
            <m.div className="fixed inset-0 z-50 bg-black/50 md:hidden"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setOpen(false)} />
            <m.div
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Navigation menu"
              className="fixed right-0 top-0 bottom-0 z-50 w-56 md:hidden flex flex-col"
              style={{ background: 'var(--color-bg-surface)', borderLeft: '1px solid var(--color-purple-75)' }}
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}>
              <div className="p-4 flex justify-end">
                <button onClick={() => setOpen(false)} aria-label="Close navigation menu" className="text-text-muted p-2.5 min-w-[48px] min-h-[48px] flex items-center justify-center">
                  <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <path d="M5 5l10 10M15 5l-10 10" />
                  </svg>
                </button>
              </div>
              <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
                {ALL_NAV.map((n) => (
                  <NavLink key={n.to} to={n.to} onClick={() => setOpen(false)}
                    className={({ isActive }) => `nav-link block py-2.5 ${isActive ? 'active' : ''}`}
                    style={n.to === '/premium' ? { color: '#d4a017' } : undefined}>
                    {n.label}
                  </NavLink>
                ))}
              </nav>
            </m.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
});
