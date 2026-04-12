import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@rainbow-me/rainbowkit/styles.css';
import { config } from './lib/wagmi';
import { AppLayout } from './components/layout/AppLayout';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { PageSkeleton } from './components/PageSkeleton';
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
const CommunityPage = lazy(() => import('./pages/CommunityPage'));
const RestakePage = lazy(() => import('./pages/RestakePage'));
const LiquidityPage = lazy(() => import('./pages/LiquidityPage'));
const PremiumPage = lazy(() => import('./pages/PremiumPage'));
// BribesPage, GrantsPage, BountyPage merged into CommunityPage
const NakamigosApp = lazy(() => import('./nakamigos/App'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const LendingPage = lazy(() => import('./pages/LendingPage'));
const LaunchpadPage = lazy(() => import('./pages/LaunchpadPage'));
// NFTAMMPage merged into LendingPage (NFT Finance)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
      gcTime: 300_000,
    },
  },
});

function AnimatedRoutes() {
  return (
    <Routes>
      {/* Nakamigos marketplace — renders outside AppLayout (has its own header/footer/background) */}
      <Route path="nakamigos/*" element={<ErrorBoundary><NakamigosApp /></ErrorBoundary>} />
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
        <Route path="community" element={<ErrorBoundary><CommunityPage /></ErrorBoundary>} />
        <Route path="grants" element={<Navigate to="/community" replace />} />
        <Route path="bounties" element={<Navigate to="/community" replace />} />
        <Route path="restake" element={<ErrorBoundary><RestakePage /></ErrorBoundary>} />
        <Route path="liquidity" element={<ErrorBoundary><LiquidityPage /></ErrorBoundary>} />
        <Route path="premium" element={<ErrorBoundary><PremiumPage /></ErrorBoundary>} />
        <Route path="bribes" element={<Navigate to="/community" replace />} />
        <Route path="admin" element={<ErrorBoundary><AdminPage /></ErrorBoundary>} />
        <Route path="lending" element={<ErrorBoundary><LendingPage /></ErrorBoundary>} />
        <Route path="launchpad" element={<ErrorBoundary><LaunchpadPage /></ErrorBoundary>} />
        <Route path="nft-amm" element={<Navigate to="/lending" replace />} />
        <Route path="governance" element={<Navigate to="/community" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function App() {
  useEffect(() => {
    if (!localStorage.getItem('tegridy_first_visit')) {
      safeSetItem('tegridy_first_visit', Date.now().toString());
    }
  }, []);

  return (
    <ErrorBoundary>
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
            <Suspense fallback={<PageSkeleton />}>
              <AnimatedRoutes />
            </Suspense>
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ErrorBoundary>
  );
}

export default App;
