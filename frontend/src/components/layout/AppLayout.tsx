import { Outlet, useLocation } from 'react-router-dom';
import { useAccount, useSwitchChain } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { TopNav } from './TopNav';
import { BottomNav } from './BottomNav';
import { Background } from './Background';
import { Footer } from './Footer';
import { Toaster } from 'sonner';
import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { CHAIN_ID } from '../../lib/constants';
import { AppLoader } from '../loader';
import { PriceProvider } from '../../contexts/PriceContext';
import { ConfettiProvider } from '../Confetti';
import { TransactionReceiptProvider } from '../TransactionReceipt';
import { ParticleBackground } from '../ParticleBackground';
import { LiveActivity } from '../LiveActivity';
import { GlitchTransition, type GlitchConfig } from '../GlitchTransition';

const NAV_ORDER = [
  '/', '/dashboard', '/farm', '/swap', '/gallery', '/tokenomics', '/lore',
  '/leaderboard', '/grants', '/bounties', '/restake', '/liquidity', '/premium', '/history',
];

function getGlitchConfig(from: string, to: string): GlitchConfig {
  const fromIdx = NAV_ORDER.indexOf(from);
  const toIdx = NAV_ORDER.indexOf(to);
  const direction: GlitchConfig['direction'] = toIdx > fromIdx ? 'forward' : 'backward';
  const mobile = typeof window !== 'undefined' && window.innerWidth < 768;
  if (from === '/' || to === '/') {
    return { intensity: 'heavy', direction, sliceCount: mobile ? 6 : 16, duration: 1000 };
  }
  if (Math.abs(fromIdx - toIdx) <= 1) {
    return { intensity: 'light', direction, sliceCount: mobile ? 4 : 12, duration: 1000 };
  }
  return { intensity: 'medium', direction, sliceCount: mobile ? 5 : 14, duration: 1000 };
}

function RouteGlitch() {
  const location = useLocation();
  const [glitchConfig, setGlitchConfig] = useState<GlitchConfig | null>(null);
  const prevPath = useRef(location.pathname);
  const isFirst = useRef(true);

  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; prevPath.current = location.pathname; return; }
    if (location.pathname !== prevPath.current) {
      const cfg = getGlitchConfig(prevPath.current, location.pathname);
      prevPath.current = location.pathname;
      setGlitchConfig(cfg);
      const t = setTimeout(() => setGlitchConfig(null), cfg.duration);
      return () => clearTimeout(t);
    }
  }, [location.pathname]);

  return glitchConfig ? <GlitchTransition config={glitchConfig} /> : null;
}

function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const check = () => setMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return mobile;
}

export function AppLayout() {
  const location = useLocation();
  const { chain, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const wrongNetwork = isConnected && chain && chain.id !== CHAIN_ID;
  const isMobile = useIsMobile();

  return (
    <AppLoader>
    <PriceProvider>
    <ConfettiProvider>
    <TransactionReceiptProvider>
      <ParticleBackground />
      <Background />
      <TopNav />
      <RouteGlitch />

      {/* #82 audit: wrong-network banner */}
      {wrongNetwork && (
        <div className="fixed top-14 left-0 right-0 z-50 bg-red-600/95 backdrop-blur-sm text-white text-center py-2 px-4 text-[12px] md:text-[13px] font-medium shadow-lg" style={{ paddingLeft: 'max(1rem, env(safe-area-inset-left))', paddingRight: 'max(1rem, env(safe-area-inset-right))' }}>
          You are connected to <strong>{chain.name ?? `chain ${chain.id}`}</strong>.
          Please switch to Ethereum Mainnet.
          {switchChain && (
            <button
              onClick={() => switchChain({ chainId: mainnet.id })}
              className="ml-3 underline underline-offset-2 hover:text-white/80 transition-colors"
            >
              Switch now
            </button>
          )}
        </div>
      )}

      {/* Migration Banner for v2 contract upgrade */}
      <div className="bg-yellow-900/80 border-b border-yellow-600 text-yellow-100 text-center py-2 px-4 text-[12px] md:text-sm fixed top-14 left-0 right-0 z-40" style={{ paddingLeft: 'max(1rem, env(safe-area-inset-left))', paddingRight: 'max(1rem, env(safe-area-inset-right))' }}>
        <strong>Security Upgrade:</strong> Contracts have been upgraded. If you had staked positions, please withdraw from the old contracts and re-stake.{' '}
        <a href="https://etherscan.io/address/0x65D8b87917c59a0B33009493fB236bCccF1Ea421" target="_blank" rel="noopener noreferrer" className="underline text-yellow-300">New Staking Contract</a>
      </div>

      {/* pb-20 for bottom nav height + safe-area-inset-bottom for notched devices */}
      <div className="min-h-screen relative z-10 pt-14 pb-20 md:pb-0 safe-area-content-bottom">
        <main>
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: isMobile ? 12 : 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: isMobile ? 0.3 : 0.6,
              delay: isMobile ? 0 : 0.7,
              ease: [0.25, 0.1, 0.25, 1],
            }}
          >
            <Outlet />
          </motion.div>
        </main>
        <Footer />
      </div>

      <BottomNav />
      <LiveActivity />

      <Toaster
        position="top-right"
        theme="dark"
        toastOptions={{
          style: {
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-primary)',
            fontFamily: "'Inter', sans-serif",
          },
        }}
      />
    </TransactionReceiptProvider>
    </ConfettiProvider>
    </PriceProvider>
    </AppLoader>
  );
}
