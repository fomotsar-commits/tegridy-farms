import { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import '@rainbow-me/rainbowkit/styles.css';
import { config } from './lib/wagmi';
import { AppLayout } from './components/layout/AppLayout';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { TransactionReceiptProvider } from './components/TransactionReceipt';
import { ParticleBackground } from './components/ParticleBackground';
import { ConfettiProvider } from './components/Confetti';
import { PageTransition } from './components/PageTransition';
import { LiveActivity } from './components/LiveActivity';
import { AppLoader } from './components/loader';
import { GlitchTransition, type GlitchConfig } from './components/GlitchTransition';

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

const queryClient = new QueryClient();

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
  '/history',
];

function getGlitchConfig(from: string, to: string): GlitchConfig {
  const fromIdx = NAV_ORDER.indexOf(from);
  const toIdx = NAV_ORDER.indexOf(to);
  const direction: GlitchConfig['direction'] =
    toIdx > fromIdx ? 'forward' : 'backward';

  // Homepage transitions are heavy
  if (from === '/' || to === '/') {
    return { intensity: 'heavy', direction, sliceCount: 16, duration: 2000 };
  }
  // Adjacent pages are light
  if (Math.abs(fromIdx - toIdx) <= 1) {
    return { intensity: 'light', direction, sliceCount: 8, duration: 1200 };
  }
  // Everything else is medium
  return { intensity: 'medium', direction, sliceCount: 12, duration: 1600 };
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
  const location = useLocation();

  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route element={<AppLayout />}>
          <Route index element={<PageTransition><ErrorBoundary><HomePage /></ErrorBoundary></PageTransition>} />
          <Route path="farm" element={<PageTransition><ErrorBoundary><FarmPage /></ErrorBoundary></PageTransition>} />
          <Route path="swap" element={<PageTransition><ErrorBoundary><SwapPage /></ErrorBoundary></PageTransition>} />
          <Route path="dashboard" element={<PageTransition><ErrorBoundary><DashboardPage /></ErrorBoundary></PageTransition>} />
          <Route path="gallery" element={<PageTransition><ErrorBoundary><GalleryPage /></ErrorBoundary></PageTransition>} />
          <Route path="tokenomics" element={<PageTransition><ErrorBoundary><TokenomicsPage /></ErrorBoundary></PageTransition>} />
          <Route path="history" element={<PageTransition><ErrorBoundary><HistoryPage /></ErrorBoundary></PageTransition>} />
          <Route path="lore" element={<PageTransition><ErrorBoundary><LorePage /></ErrorBoundary></PageTransition>} />
          <Route path="leaderboard" element={<PageTransition><ErrorBoundary><LeaderboardPage /></ErrorBoundary></PageTransition>} />
          <Route path="grants" element={<PageTransition><ErrorBoundary><GrantsPage /></ErrorBoundary></PageTransition>} />
          <Route path="bounties" element={<PageTransition><ErrorBoundary><BountyPage /></ErrorBoundary></PageTransition>} />
          <Route path="restake" element={<PageTransition><ErrorBoundary><RestakePage /></ErrorBoundary></PageTransition>} />
          <Route path="governance" element={<Navigate to="/grants" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AnimatePresence>
  );
}

function App() {
  // Track first-ever visit for loyalty score
  useEffect(() => {
    if (!localStorage.getItem('tegridy_first_visit')) {
      localStorage.setItem('tegridy_first_visit', Date.now().toString());
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
          <ConfettiProvider>
          <TransactionReceiptProvider>
          <ParticleBackground />
          <RouteGlitch />
          <Suspense fallback={null}>
            <AnimatedRoutes />
          </Suspense>
          <LiveActivity />
          </TransactionReceiptProvider>
          </ConfettiProvider>
          </AppLoader>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;
