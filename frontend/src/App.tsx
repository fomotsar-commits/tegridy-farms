import { lazy, Suspense, useEffect, Component, type ReactNode, type ErrorInfo } from 'react';
import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import '@rainbow-me/rainbowkit/styles.css';
import { config } from './lib/wagmi';
import { AppLayout } from './components/layout/AppLayout';
import { PageSkeleton } from './components/PageSkeleton';
import { SwapSkeleton, FarmSkeleton, DashboardSkeleton } from './components/PageSkeletons';
import { safeSetItem } from './lib/storage';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';

const HomePage = lazy(() => import('./pages/HomePage'));
const FarmPage = lazy(() => import('./pages/FarmPage'));
const TradePage = lazy(() => import('./pages/TradePage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const GalleryPage = lazy(() => import('./pages/GalleryPage'));
// HistoryPage, LeaderboardPage, PremiumPage, ChangelogPage merged into ActivityPage (tabs)
const ActivityPage = lazy(() => import('./pages/ActivityPage'));
const CommunityPage = lazy(() => import('./pages/CommunityPage'));
// Tokenomics + Lore + Security + FAQ merged into LearnPage (tabs)
const LearnPage = lazy(() => import('./pages/LearnPage'));
// RestakePage + LaunchpadPage merged into LendingPage (NFT Finance)
// LiquidityPage + SwapPage merged into TradePage
// BribesPage, GrantsPage, BountyPage merged into CommunityPage
const NakamigosApp = lazy(() => import('./nakamigos/App'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const LendingPage = lazy(() => import('./pages/LendingPage'));
const TermsPage = lazy(() => import('./pages/TermsPage'));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage'));
const RisksPage = lazy(() => import('./pages/RisksPage'));
const ContractsPage = lazy(() => import('./pages/ContractsPage'));
const TreasuryPage = lazy(() => import('./pages/TreasuryPage'));
// LaunchpadPage lazy import removed — loaded inside LendingPage
// NFTAMMPage merged into LendingPage (NFT Finance)

// Error boundary catches render errors in lazy-loaded pages and prevents white-screen crashes
class RouteErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Route render error:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center px-6">
          <div className="text-center max-w-sm">
            <h1 className="heading-luxury text-3xl text-white mb-3">Something went wrong</h1>
            <p className="text-white/70 text-[13px] mb-6">
              An unexpected error occurred while rendering this page.
            </p>
            <button
              onClick={() => { this.setState({ hasError: false }); window.location.reload(); }}
              className="btn-primary inline-block px-7 py-2.5 text-[14px]"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

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

// Scroll to top on route change (no built-in scroll restoration in React Router v7)
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

function AnimatedRoutes() {
  return (
    <>
    <ScrollToTop />
    <Routes>
      {/* Nakamigos marketplace — renders outside AppLayout (has its own header/footer/background) */}
      <Route path="nakamigos/*" element={<NakamigosApp />} />
      <Route element={<AppLayout />}>
        <Route index element={<Suspense fallback={<PageSkeleton />}><HomePage /></Suspense>} />
        <Route path="farm" element={<Suspense fallback={<FarmSkeleton />}><FarmPage /></Suspense>} />
        <Route path="swap" element={<Suspense fallback={<SwapSkeleton />}><TradePage /></Suspense>} />
        <Route path="liquidity" element={<Suspense fallback={<SwapSkeleton />}><TradePage /></Suspense>} />
        <Route path="dashboard" element={<Suspense fallback={<DashboardSkeleton />}><DashboardPage /></Suspense>} />
        <Route path="gallery" element={<Suspense fallback={<PageSkeleton />}><GalleryPage /></Suspense>} />
        <Route path="tokenomics" element={<Suspense fallback={<PageSkeleton />}><LearnPage /></Suspense>} />
        <Route path="history" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="lore" element={<Suspense fallback={<PageSkeleton />}><LearnPage /></Suspense>} />
        <Route path="learn" element={<Navigate to="/tokenomics" replace />} />
        <Route path="leaderboard" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="community" element={<Suspense fallback={<PageSkeleton />}><CommunityPage /></Suspense>} />
        <Route path="grants" element={<Navigate to="/community" replace />} />
        <Route path="bounties" element={<Navigate to="/community" replace />} />
        <Route path="restake" element={<Navigate to="/lending" replace />} />
        <Route path="premium" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="bribes" element={<Navigate to="/community" replace />} />
        <Route path="admin" element={<Suspense fallback={<PageSkeleton />}><AdminPage /></Suspense>} />
        <Route path="lending" element={<Suspense fallback={<PageSkeleton />}><LendingPage /></Suspense>} />
        <Route path="launchpad" element={<Navigate to="/lending" replace />} />
        <Route path="nft-amm" element={<Navigate to="/lending" replace />} />
        <Route path="governance" element={<Navigate to="/community" replace />} />
        <Route path="security" element={<Suspense fallback={<PageSkeleton />}><LearnPage /></Suspense>} />
        <Route path="terms" element={<Suspense fallback={<PageSkeleton />}><TermsPage /></Suspense>} />
        <Route path="privacy" element={<Suspense fallback={<PageSkeleton />}><PrivacyPage /></Suspense>} />
        <Route path="risks" element={<Suspense fallback={<PageSkeleton />}><RisksPage /></Suspense>} />
        <Route path="faq" element={<Suspense fallback={<PageSkeleton />}><LearnPage /></Suspense>} />
        <Route path="changelog" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="contracts" element={<Suspense fallback={<PageSkeleton />}><ContractsPage /></Suspense>} />
        <Route path="treasury" element={<Suspense fallback={<PageSkeleton />}><TreasuryPage /></Suspense>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
    </>
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
      <RouteErrorBoundary>
        <Suspense fallback={<PageSkeleton />}>
          <AnimatedRoutes />
        </Suspense>
      </RouteErrorBoundary>
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
          {/* AUDIT Batch 19: LazyMotion with domAnimation features. Every
              'motion.X' was refactored to 'm.X' in a scripted pass across 45
              files. LazyMotion defers the heavy motion engine until after
              first paint and only ships DOM-animation features (not SVG
              motion, not layout, not drag) — chosen because the app only
              uses basic opacity/y/scale/transition. strict mode on the
              wrapper throws loudly if a bare 'motion.X' slips through. */}
          <LazyMotion features={domAnimation} strict>
            <AppInner />
          </LazyMotion>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;
