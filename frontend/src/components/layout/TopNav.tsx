import { NavLink, Link } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/farm', label: 'Farm' },
  { to: '/swap', label: 'Swap' },
  { to: '/restake', label: 'Restake' },
  { to: '/gallery', label: 'Gallery' },
  { to: '/grants', label: 'Governance' },
  { to: '/bounties', label: 'Bounties' },
  { to: '/tokenomics', label: 'Tokenomics' },
  { to: '/lore', label: 'Lore' },
];

export function TopNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <header
        className="fixed top-0 left-0 right-0 z-50 h-14"
        style={{
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderBottom: '1px solid rgba(139, 92, 246, 0.20)',
          boxShadow: '0 1px 12px rgba(139,92,246,0.06), 0 0 1px rgba(139,92,246,0.12)',
        }}
      >
        {/* Subtle gold accent line at very top */}
        <div className="absolute top-0 left-0 right-0 h-[1px]" style={{
          background: 'linear-gradient(90deg, transparent 0%, rgba(139,92,246,0.35) 30%, rgba(139,92,246,0.5) 50%, rgba(139,92,246,0.35) 70%, transparent 100%)',
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
              style={{ border: '1px solid rgba(139,92,246,0.25)' }}
              title="Replay splash screen"
            >
              <img src="/art/bobowelie.jpg" alt="" className="w-full h-full object-cover" />
            </button>
            <Link to="/" className="flex items-center gap-1">
              <span className="heading-luxury text-[16px] tracking-wide text-primary">TEGRIDY</span>
              <span className="text-[15px] font-semibold tracking-tight text-text-primary">FARMS</span>
            </Link>
          </div>

          <nav className="hidden md:flex items-center gap-0.5">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to}
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <NavLink to="/leaderboard" className={({ isActive }) => `nav-link text-[13px] hidden md:block ${isActive ? 'active' : ''}`}>
              Points
            </NavLink>
            <ConnectButton.Custom>
              {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
                const connected = mounted && account && chain;
                return (
                  <div {...(!mounted && { 'aria-hidden': true, style: { opacity: 0, pointerEvents: 'none', userSelect: 'none' } })}>
                    {!connected ? (
                      <button onClick={openConnectModal} className="btn-primary text-[13px] px-4 py-1.5">
                        Connect
                      </button>
                    ) : chain.unsupported ? (
                      <button onClick={openChainModal} className="btn-secondary text-[13px] px-3 py-1.5 text-danger border-danger/30">
                        Wrong Network
                      </button>
                    ) : (
                      <button onClick={openAccountModal}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] font-mono text-text-secondary"
                        style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.15)' }}>
                        <span className="w-1.5 h-1.5 rounded-full bg-success" />
                        {account.displayName}
                      </button>
                    )}
                  </div>
                );
              }}
            </ConnectButton.Custom>

            <button onClick={() => setOpen(true)} className="md:hidden p-2.5 -mr-2 text-text-muted min-w-[44px] min-h-[44px] flex items-center justify-center">
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
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
            <motion.div className="fixed inset-0 z-50 bg-black/50 md:hidden"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setOpen(false)} />
            <motion.div
              className="fixed right-0 top-0 bottom-0 z-50 w-56 md:hidden flex flex-col"
              style={{ background: 'var(--color-bg-surface)', borderLeft: '1px solid rgba(139,92,246,0.15)' }}
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}>
              <div className="p-4 flex justify-end">
                <button onClick={() => setOpen(false)} className="text-text-muted p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center">
                  <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M5 5l10 10M15 5l-10 10" />
                  </svg>
                </button>
              </div>
              <nav className="flex-1 px-3 space-y-0.5">
                {NAV.map((n) => (
                  <NavLink key={n.to} to={n.to} onClick={() => setOpen(false)}
                    className={({ isActive }) => `nav-link block py-2.5 ${isActive ? 'active' : ''}`}>
                    {n.label}
                  </NavLink>
                ))}
              </nav>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
