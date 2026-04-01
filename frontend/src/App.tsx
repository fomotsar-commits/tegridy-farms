import { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@rainbow-me/rainbowkit/styles.css';
import { config } from './lib/wagmi';
import { AppLayout } from './components/layout/AppLayout';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { TransactionReceiptProvider } from './components/TransactionReceipt';
import { ParticleBackground } from './components/ParticleBackground';
import { ConfettiProvider } from './components/Confetti';
// PageTransition moved to AppLayout (wraps <Outlet />)
import { LiveActivity } from './components/LiveActivity';
import { AppLoader } from './components/loader';
import { GlitchTransition, type GlitchConfig } from './components/GlitchTransition';
import { PageSkeleton } from './components/PageSkeleton';
import { PriceProvider } from './contexts/PriceContext';
import { safeSetItem } from './lib/storage';

const HomePage = lazy(() => import('./pages/HomePage'));
const FarmPage = lazy(() => import('./pages/FarmPage'));
const SwapPage = lazy(() => import('./pages/SwapPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const GalleryPage = lazy(() => import('./pages/GalleryPage'));
const TokenomicsPage = lazy(() => import('./pages/TokenomicsPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const LorePage = lazy(() => import('./pages/LorePage'));
const LeaderboardPage = lazy(() => import('./pages/LeaderboardPage'));
const GrantsPage = lazy(() => import('./pages/GrantsPage'));
const BountyPage = lazy(() => import('./pages/BountyPage'));
const RestakePage = lazy(() => import('./pages/RestakePage'));
const LiquidityPage = lazy(() => import('./pages/LiquidityPage'));
const PremiumPage = lazy(() => import('./pages/PremiumPage'));
const BribesPage = lazy(() => import('./pages/BribesPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
      gcTime: 300_000,
    },
  },
});

const NAV_ORDER = [
  '/',
  '/dashboard',
  '/farm',
  '/swap',
  '/gallery',
  '/tokenomics',
  '/lore',
  '/leaderboard',
  '/grants',
  '/bounties',
  '/restake',
  '/liquidity',
  '/premium',
  '/history',
];

function getGlitchConfig(from: string, to: string): GlitchConfig {
  const fromIdx = NAV_ORDER.indexOf(from);
  const toIdx = NAV_ORDER.indexOf(to);
  const direction: GlitchConfig['direction'] =
    toIdx > fromIdx ? 'forward' : 'backward';
  const mobile = typeof window !== 'undefined' && window.innerWidth < 768;

  // #88 audit: shorter transition durations (max 400ms desktop, snappier mobile)
  // Homepage transitions are heavy
  if (from === '/' || to === '/') {
    return { intensity: 'heavy', direction, sliceCount: mobile ? 6 : 12, duration: mobile ? 350 : 400 };
  }
  // Adjacent pages are light
  if (Math.abs(fromIdx - toIdx) <= 1) {
    return { intensity: 'light', direction, sliceCount: mobile ? 4 : 8, duration: mobile ? 250 : 300 };
  }
  // Everything else is medium
  return { intensity: 'medium', direction, sliceCount: mobile ? 5 : 10, duration: mobile ? 300 : 350 };
}

function RouteGlitch() {
  const location = useLocation();
  const [glitchConfig, setGlitchConfig] = useState<GlitchConfig | null>(null);
  const prevPath = useRef(location.pathname);
  const isFirst = useRef(true);

  useEffect(() => {
    // Skip glitch on initial mount
    if (isFirst.current) {
      isFirst.current = false;
      prevPath.current = location.pathname;
      return;
    }
    // Only trigger if path actually changed
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

function AnimatedRoutes() {
  // Let React Router manage location internally — no location prop needed.
  // Page enter animations are handled in AppLayout via a keyed motion.div
  // around <Outlet />. GlitchTransition overlay handles the visual bridge.
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<ErrorBoundary><HomePage /></ErrorBoundary>} />
        <Route path="farm" element={<ErrorBoundary><FarmPage /></ErrorBoundary>} />
        <Route path="swap" element={<ErrorBoundary><SwapPage /></ErrorBoundary>} />
        <Route path="dashboard" element={<ErrorBoundary><DashboardPage /></ErrorBoundary>} />
        <Route path="gallery" element={<ErrorBoundary><GalleryPage /></ErrorBoundary>} />
        <Route path="tokenomics" element={<ErrorBoundary><TokenomicsPage /></ErrorBoundary>} />
        <Route path="history" element={<ErrorBoundary><HistoryPage /></ErrorBoundary>} />
        <Route path="lore" element={<ErrorBoundary><LorePage /></ErrorBoundary>} />
        <Route path="leaderboard" element={<ErrorBoundary><LeaderboardPage /></ErrorBoundary>} />
        <Route path="grants" element={<ErrorBoundary><GrantsPage /></ErrorBoundary>} />
        <Route path="bounties" element={<ErrorBoundary><BountyPage /></ErrorBoundary>} />
        <Route path="restake" element={<ErrorBoundary><RestakePage /></ErrorBoundary>} />
        <Route path="liquidity" element={<ErrorBoundary><LiquidityPage /></ErrorBoundary>} />
        <Route path="premium" element={<ErrorBoundary><PremiumPage /></ErrorBoundary>} />
        <Route path="bribes" element={<ErrorBoundary><BribesPage /></ErrorBoundary>} />
        <Route path="governance" element={<Navigate to="/grants" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function App() {
  // Track first-ever visit for loyalty score
  useEffect(() => {
    if (!localStorage.getItem('tegridy_first_visit')) {
      safeSetItem('tegridy_first_visit', Date.now().toString());
    }
  }, []);

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: '#2D8B4E',
            accentColorForeground: 'white',
            borderRadius: 'large',
            overlayBlur: 'small',
          })}
        >
          <AppLoader>
          <PriceProvider>
          <ConfettiProvider>
          <TransactionReceiptProvider>
          <ParticleBackground />
          <RouteGlitch />
          <Suspense fallback={<PageSkeleton />}>
            <AnimatedRoutes />
          </Suspense>
          <LiveActivity />
          </TransactionReceiptProvider>
          </ConfettiProvider>
          </PriceProvider>
          </AppLoader>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;
