import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, Link } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@rainbow-me/rainbowkit/styles.css';
import { config } from './lib/wagmi';
import { AppLayout } from './components/layout/AppLayout';
import { PageSkeleton } from './components/PageSkeleton';
import { safeSetItem } from './lib/storage';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';

const HomePage = lazy(() => import('./pages/HomePage'));
const FarmPage = lazy(() => import('./pages/FarmPage'));
const TradePage = lazy(() => import('./pages/TradePage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const GalleryPage = lazy(() => import('./pages/GalleryPage'));
const TokenomicsPage = lazy(() => import('./pages/TokenomicsPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const LorePage = lazy(() => import('./pages/LorePage'));
const LeaderboardPage = lazy(() => import('./pages/LeaderboardPage'));
const CommunityPage = lazy(() => import('./pages/CommunityPage'));
// RestakePage + LaunchpadPage merged into LendingPage (NFT Finance)
// LiquidityPage + SwapPage merged into TradePage
const PremiumPage = lazy(() => import('./pages/PremiumPage'));
// BribesPage, GrantsPage, BountyPage merged into CommunityPage
const NakamigosApp = lazy(() => import('./nakamigos/App'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const LendingPage = lazy(() => import('./pages/LendingPage'));
const SecurityPage = lazy(() => import('./pages/SecurityPage'));
const TermsPage = lazy(() => import('./pages/TermsPage'));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage'));
const RisksPage = lazy(() => import('./pages/RisksPage'));
const FAQPage = lazy(() => import('./pages/FAQPage'));
const ChangelogPage = lazy(() => import('./pages/ChangelogPage'));
// LaunchpadPage lazy import removed — loaded inside LendingPage
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

function NotFoundPage() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6">
      <div className="text-center max-w-sm">
        <h1 className="heading-luxury text-5xl text-white mb-3">404</h1>
        <h2 className="heading-luxury text-xl text-white mb-2">Page Not Found</h2>
        <p className="text-white/70 text-[13px] mb-6">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          to="/"
          className="btn-primary inline-block px-7 py-2.5 text-[14px]"
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
}

function AnimatedRoutes() {
  return (
    <Routes>
      {/* Nakamigos marketplace — renders outside AppLayout (has its own header/footer/background) */}
      <Route path="nakamigos/*" element={<NakamigosApp />} />
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="farm" element={<FarmPage />} />
        <Route path="swap" element={<TradePage />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="gallery" element={<GalleryPage />} />
        <Route path="tokenomics" element={<TokenomicsPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="lore" element={<LorePage />} />
        <Route path="leaderboard" element={<LeaderboardPage />} />
        <Route path="community" element={<CommunityPage />} />
        <Route path="grants" element={<Navigate to="/community" replace />} />
        <Route path="bounties" element={<Navigate to="/community" replace />} />
        <Route path="restake" element={<Navigate to="/lending" replace />} />
        <Route path="liquidity" element={<Navigate to="/swap" replace />} />
        <Route path="premium" element={<PremiumPage />} />
        <Route path="bribes" element={<Navigate to="/community" replace />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="lending" element={<LendingPage />} />
        <Route path="launchpad" element={<Navigate to="/lending" replace />} />
        <Route path="nft-amm" element={<Navigate to="/lending" replace />} />
        <Route path="governance" element={<Navigate to="/community" replace />} />
        <Route path="security" element={<SecurityPage />} />
        <Route path="terms" element={<TermsPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="risks" element={<RisksPage />} />
        <Route path="faq" element={<FAQPage />} />
        <Route path="changelog" element={<ChangelogPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

const rainbowDark = darkTheme({
  accentColor: '#2D8B4E',
  accentColorForeground: 'white',
  borderRadius: 'large',
  overlayBlur: 'small',
});

const rainbowLight = lightTheme({
  accentColor: '#2D8B4E',
  accentColorForeground: 'white',
  borderRadius: 'large',
  overlayBlur: 'small',
});

function AppInner() {
  const { isDark } = useTheme();

  return (
    <RainbowKitProvider theme={isDark ? rainbowDark : rainbowLight}>
      <Suspense fallback={<PageSkeleton />}>
        <AnimatedRoutes />
      </Suspense>
    </RainbowKitProvider>
  );
}

function App() {
  useEffect(() => {
    if (!localStorage.getItem('tegridy_first_visit')) {
      safeSetItem('tegridy_first_visit', Date.now().toString());
    }
  }, []);

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AppInner />
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;
