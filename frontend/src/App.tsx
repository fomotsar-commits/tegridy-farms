import { lazy, Suspense, useEffect, Component, type ReactNode, type ErrorInfo } from 'react';
import { Routes, Route, Navigate, Link, useLocation, useNavigationType } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation, MotionConfig } from 'framer-motion';
import '@rainbow-me/rainbowkit/styles.css';
import { config } from './lib/wagmi';
import { AppLayout } from './components/layout/AppLayout';
import { PageSkeleton } from './components/PageSkeleton';
import { SwapSkeleton, FarmSkeleton, DashboardSkeleton } from './components/PageSkeletons';
import { safeSetItem, safeGetItem } from './lib/storage';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { usePageTitle } from './hooks/usePageTitle';

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
// R002: art-studio is a dev-only internal tool. Gate the lazy import behind
// `import.meta.env.DEV` so Rollup statically tree-shakes the entire chunk out
// of production builds — prod ships zero studio code, the route below
// redirects, and the `/__art-studio/save` middleware is dev-only too.
const ArtStudioPage = import.meta.env.DEV
  ? lazy(() => import('./pages/ArtStudioPage'))
  : null;
const LendingPage = lazy(() => import('./pages/LendingPage'));
// Terms, Privacy, Risks, Contracts, Treasury merged into InfoPage (tabs)
const InfoPage = lazy(() => import('./pages/InfoPage'));
// Solana fee-capture surface (Surface A). Lazy so the @solana/* deps load only
// with this chunk — never the main bundle / EVM surface.
const SolanaSwapPage = lazy(() => import('./pages/SolanaSwapPage'));
// Token launch rail (Doppler V4 integration). Gated in-page (isLauncherEnabled)
// until go-live -> re-homing -> TOWELI-liveness; renders the SOON placeholder meanwhile.
const LaunchPage = lazy(() => import('./pages/LaunchPage'));
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
  // F24: don't canonicalize the bogus path (would create a soft-404 served 200)
  // and mark it noindex so crawlers drop it.
  usePageTitle('404 — Page Not Found', undefined, { noCanonical: true, noIndex: true });
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
        {/* F62: quick links so a mistyped URL still routes users somewhere useful. */}
        <div className="mt-6">
          <p className="text-white/40 text-[11px] uppercase tracking-wider mb-2">Or jump to</p>
          <div className="flex items-center justify-center gap-2 flex-wrap">
            {[
              { to: '/farm', label: 'Farm' },
              { to: '/swap', label: 'Trade' },
              { to: '/dashboard', label: 'Dashboard' },
            ].map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="btn-secondary px-4 py-2 text-[13px]"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Scroll to top on route change (no built-in scroll restoration in React Router v7).
// F18: skip the reset on POP (Back/Forward) so the browser's native scroll
// restoration can return the user to their previous reading position; PUSH/REPLACE
// navigations still scroll to top.
function ScrollToTop() {
  const { pathname, hash } = useLocation();
  const navType = useNavigationType();
  useEffect(() => {
    if (navType === 'POP') return;
    // F397: honor #section deep-links instead of always jumping to the top.
    // The native browser hash-scroll fires before Suspense + entrance
    // animations mount the target, so it no-ops; re-run it on the next frame
    // (and a short follow-up) once the content has had a chance to settle.
    if (hash) {
      const id = decodeURIComponent(hash.slice(1));
      let raf2 = 0;
      const scrollToTarget = () => document.getElementById(id)?.scrollIntoView({ behavior: 'auto', block: 'start' });
      const raf1 = requestAnimationFrame(() => {
        scrollToTarget();
        // Second pass after lazy/animated content has likely mounted.
        raf2 = window.setTimeout(scrollToTarget, 120) as unknown as number;
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2) clearTimeout(raf2);
      };
    }
    window.scrollTo(0, 0);
  }, [pathname, hash, navType]);
  return null;
}

function AnimatedRoutes() {
  return (
    <>
    <ScrollToTop />
    <Routes>
      {/* Nakamigos marketplace — renders outside AppLayout (has its own header/footer/background) */}
      <Route path="nakamigos/*" element={<NakamigosApp />} />
      {/* Art studio — internal dev tool, renders standalone (no app chrome/background).
          R002: gated to DEV. In prod, `ArtStudioPage` is `null` (tree-shaken)
          and we redirect to home so anyone browsing /art-studio on prod lands
          on the public site rather than seeing an empty Suspense crash. */}
      <Route
        path="art-studio"
        element={
          import.meta.env.DEV && ArtStudioPage
            ? <Suspense fallback={<PageSkeleton />}><ArtStudioPage /></Suspense>
            : <Navigate to="/" replace />
        }
      />
      <Route element={<AppLayout />}>
        <Route index element={<Suspense fallback={<PageSkeleton />}><HomePage /></Suspense>} />
        <Route path="farm" element={<Suspense fallback={<FarmSkeleton />}><FarmPage /></Suspense>} />
        <Route path="swap" element={<Suspense fallback={<SwapSkeleton />}><TradePage /></Suspense>} />
        <Route path="liquidity" element={<Suspense fallback={<SwapSkeleton />}><TradePage /></Suspense>} />
        <Route path="solana" element={<Suspense fallback={<SwapSkeleton />}><SolanaSwapPage /></Suspense>} />
        <Route path="launch" element={<Suspense fallback={<PageSkeleton />}><LaunchPage /></Suspense>} />
        {/* The nav labels this "Trade" — make the natural /trade URL resolve instead of 404. */}
        <Route path="trade" element={<Navigate to="/swap" replace />} />
        <Route path="dashboard" element={<Suspense fallback={<DashboardSkeleton />}><DashboardPage /></Suspense>} />
        <Route path="gallery" element={<Suspense fallback={<PageSkeleton />}><GalleryPage /></Suspense>} />
        <Route path="tokenomics" element={<Suspense fallback={<PageSkeleton />}><LearnPage /></Suspense>} />
        <Route path="history" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="lore" element={<Suspense fallback={<PageSkeleton />}><LearnPage /></Suspense>} />
        <Route path="learn" element={<Navigate to="/tokenomics" replace />} />
        <Route path="leaderboard" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="community" element={<Suspense fallback={<PageSkeleton />}><CommunityPage /></Suspense>} />
        <Route path="grants" element={<Navigate to="/community" replace />} />
        <Route path="bounties" element={<Navigate to="/community?section=bounties" replace />} />
        <Route path="restake" element={<Navigate to="/farm" replace />} />
        <Route path="premium" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="bribes" element={<Navigate to="/community?section=bribes" replace />} />
        <Route path="admin" element={<Suspense fallback={<PageSkeleton />}><AdminPage /></Suspense>} />
        <Route path="nft-finance" element={<Suspense fallback={<PageSkeleton />}><LendingPage /></Suspense>} />
        <Route path="lending" element={<Navigate to="/nft-finance" replace />} />
        <Route path="launchpad" element={<Navigate to="/nft-finance" replace />} />
        <Route path="nft-amm" element={<Navigate to="/nft-finance" replace />} />
        <Route path="governance" element={<Navigate to="/community" replace />} />
        <Route path="security" element={<Suspense fallback={<PageSkeleton />}><LearnPage /></Suspense>} />
        <Route path="terms" element={<Suspense fallback={<PageSkeleton />}><InfoPage /></Suspense>} />
        <Route path="privacy" element={<Suspense fallback={<PageSkeleton />}><InfoPage /></Suspense>} />
        <Route path="risks" element={<Suspense fallback={<PageSkeleton />}><InfoPage /></Suspense>} />
        <Route path="faq" element={<Suspense fallback={<PageSkeleton />}><LearnPage /></Suspense>} />
        <Route path="changelog" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="contracts" element={<Suspense fallback={<PageSkeleton />}><InfoPage /></Suspense>} />
        <Route path="treasury" element={<Suspense fallback={<PageSkeleton />}><InfoPage /></Suspense>} />
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
    // F23: safeGetItem guards the SecurityError thrown by raw localStorage
    // access when the browser blocks site data.
    if (!safeGetItem('tegridy_first_visit')) {
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
          {/* reducedMotion="user" makes every m.* animation honor the OS
              prefers-reduced-motion setting app-wide (transforms/opacity snap
              instead of animating) without per-component handling. */}
          <LazyMotion features={domAnimation} strict>
            <MotionConfig reducedMotion="user">
              <AppInner />
            </MotionConfig>
          </LazyMotion>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;
