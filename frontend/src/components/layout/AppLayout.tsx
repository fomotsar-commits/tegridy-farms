import { Outlet, useLocation } from 'react-router-dom';
import { useAccount, useSwitchChain } from 'wagmi';
import { trackWalletConnect } from '../../lib/analytics';
import { mainnet } from 'wagmi/chains';
import { TopNav } from './TopNav';
import { BottomNav } from './BottomNav';
import { Background } from './Background';
import { Footer } from './Footer';
import { Toaster } from 'sonner';
import { useState, useEffect, useRef, Suspense, lazy } from 'react';
import { useTheme } from '../../contexts/ThemeContext';

import { CHAIN_ID } from '../../lib/constants';
import { AppLoader } from '../loader';
import { PriceProvider } from '../../contexts/PriceContext';
import { ConfettiProvider } from '../Confetti';
import { TransactionReceiptProvider } from '../TransactionReceipt';
// AUDIT Batch 15: ParticleBackground + GlitchTransition + LiveActivity are
// decorative — they don't need to block first paint. Lazy-load so the main
// App chunk ships without the framer-motion-heavy animation code, which
// previously added significant bytes to the critical path.
const ParticleBackground = lazy(() =>
  import('../ParticleBackground').then(m => ({ default: m.ParticleBackground })),
);
const GlitchTransition = lazy(() =>
  import('../GlitchTransition').then(m => ({ default: m.GlitchTransition })),
);
import type { GlitchConfig } from '../GlitchTransition';
import { LiveActivity } from '../LiveActivity';
import { TowelieAssistant } from '../TowelieAssistant';
import { TowelieProvider } from '../../hooks/useTowelie';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { OnboardingModal } from '../ui/OnboardingModal';
import { ConsentBanner } from '../ui/ConsentBanner';
import { SeasonalEventBanner } from '../SeasonalEvent';

const NAV_ORDER = [
  '/', '/dashboard', '/farm', '/swap', '/nft-finance', '/gallery', '/tokenomics',
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

  return glitchConfig ? (
    <Suspense fallback={null}>
      <GlitchTransition config={glitchConfig} />
    </Suspense>
  ) : null;
}

export function AppLayout() {
  const location = useLocation();
  const { chain, isConnected, connector } = useAccount();
  const { switchChain } = useSwitchChain();
  const { isDark } = useTheme();
  const wrongNetwork = isConnected && chain && chain.id !== CHAIN_ID;

  useEffect(() => {
    if (isConnected && connector?.name) trackWalletConnect(connector.name);
  }, [isConnected, connector?.name]);

  return (
    <AppLoader>
    <PriceProvider>
    <ConfettiProvider>
    <TransactionReceiptProvider>
    <TowelieProvider>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <Background />
      <Suspense fallback={null}>
        <ParticleBackground />
      </Suspense>
      <TopNav />
      <SeasonalEventBanner />
      <RouteGlitch />

      {/* #82 audit + R039: wrong-network banner. `top` clears the 56px header
          AND respects safe-area-inset-top so notched iPhones don't render the
          banner under the notch. */}
      {wrongNetwork && (
        <div
          className="fixed left-0 right-0 z-50 bg-red-600/95 backdrop-blur-sm text-white text-center py-2 px-4 text-[12px] md:text-[13px] font-medium shadow-lg"
          style={{
            top: 'calc(56px + env(safe-area-inset-top, 0px))',
            paddingLeft: 'max(1rem, env(safe-area-inset-left))',
            paddingRight: 'max(1rem, env(safe-area-inset-right))',
          }}
        >
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
        <main id="main-content">
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
      <TowelieAssistant />
      <OnboardingModal />
      {/* R046 / H-1: GDPR/ePrivacy consent gate. Renders only on first visit
          (consent === 'pending'); analytics + error reporting are blocked
          until the user clicks Accept or Decline. */}
      <ConsentBanner />

      <Toaster
        position="top-right"
        theme={isDark ? 'dark' : 'light'}
        toastOptions={{
          style: {
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-white)',
            fontFamily: "'Inter', sans-serif",
          },
        }}
      />
    </TowelieProvider>
    </TransactionReceiptProvider>
    </ConfettiProvider>
    </PriceProvider>
    </AppLoader>
  );
}
