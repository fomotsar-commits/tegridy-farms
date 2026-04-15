import { Outlet, useLocation } from 'react-router-dom';
import { useAccount, useSwitchChain } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { TopNav } from './TopNav';
import { BottomNav } from './BottomNav';
import { Background } from './Background';
import { Footer } from './Footer';
import { Toaster } from 'sonner';
import { useState, useEffect, useRef } from 'react';

import { CHAIN_ID } from '../../lib/constants';
import { AppLoader } from '../loader';
import { PriceProvider } from '../../contexts/PriceContext';
import { ConfettiProvider } from '../Confetti';
import { TransactionReceiptProvider } from '../TransactionReceipt';
import { ParticleBackground } from '../ParticleBackground';
import { LiveActivity } from '../LiveActivity';
import { GlitchTransition, type GlitchConfig } from '../GlitchTransition';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { OnboardingModal } from '../ui/OnboardingModal';
import { SeasonalEventBanner } from '../SeasonalEvent';

const NAV_ORDER = [
  '/', '/dashboard', '/farm', '/swap', '/lending', '/gallery', '/tokenomics',
  '/lore', '/leaderboard', '/community', '/premium', '/history', '/admin',
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

/* useIsMobile — kept for future responsive hooks
function useIsMobile() {
  const [mobile, setMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 767px)').matches : false
  );
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)');
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return mobile;
}
*/

export function AppLayout() {
  const location = useLocation();
  const { chain, isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const wrongNetwork = isConnected && chain && chain.id !== CHAIN_ID;

  return (
    <AppLoader>
    <PriceProvider>
    <ConfettiProvider>
    <TransactionReceiptProvider>
      <Background />
      <ParticleBackground />
      <TopNav />
      <SeasonalEventBanner />
      <RouteGlitch />

      {/* #82 audit: wrong-network banner */}
      {wrongNetwork && (
        <div className="fixed top-14 left-0 right-0 z-50 bg-red-600/95 backdrop-blur-sm text-white text-center py-2 px-4 text-[12px] md:text-[13px] font-medium shadow-lg" style={{ paddingLeft: 'max(1rem, env(safe-area-inset-left))', paddingRight: 'max(1rem, env(safe-area-inset-right))' }}>
          You are connected to <strong>{chain.name ?? `chain ${chain.id}`}</strong>.
          Please switch to Ethereum Mainnet.
          {switchChain && (
            <button
              onClick={() => switchChain({ chainId: mainnet.id })}
              className="ml-3 underline underline-offset-2 hover:text-white transition-colors"
            >
              Switch now
            </button>
          )}
        </div>
      )}


      {/* pb-20 for bottom nav height + safe-area-inset-bottom for notched devices */}
      <div className="min-h-screen relative z-10 pt-14 pb-20 md:pb-0 safe-area-content-bottom">
        <main>
          <div key={location.pathname}>
            <ErrorBoundary resetKeys={[location.pathname]}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
        <Footer />
      </div>

      <BottomNav />
      <LiveActivity />
      <OnboardingModal />

      <Toaster
        position="top-right"
        theme="dark"
        toastOptions={{
          style: {
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-white)',
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
