import { lazy, Suspense, useEffect, Component, type ReactNode, type ErrorInfo } from 'react';
import { Routes, Route, Navigate, Link, useLocation, useNavigationType, useParams, useSearchParams } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation, MotionConfig } from 'framer-motion';
import '@rainbow-me/rainbowkit/styles.css';
import { config } from './lib/wagmi';
import { AppLayout } from './components/layout/AppLayout';
import { PageSkeleton } from './components/PageSkeleton';
import { FirstFrame } from './components/FirstFrame';
import { DoorFrame } from './components/DoorFrame';
import { SwapSkeleton, FarmSkeleton, DashboardSkeleton } from './components/PageSkeletons';
import { safeSetItem, safeGetItem } from './lib/storage';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { usePageTitle } from './hooks/usePageTitle';
import { PwaRuntime } from './components/pwa/PwaRuntime';
import { BUNGALOWS, getActiveBungalow } from './lib/bungalows';
import { BungalowDoor, VENUE_ID } from './components/bungalow/BungalowDoor';
import { EARN_PATH, isEarnPoolId, legacyFarmTarget } from './lib/earnRoutes';

const HomePage = lazy(() => import('./pages/HomePage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const GalleryPage = lazy(() => import('./pages/GalleryPage'));
const ActivityPage = lazy(() => import('./pages/ActivityPage'));
const CommunityPage = lazy(() => import('./pages/CommunityPage'));
const LearnPage = lazy(() => import('./pages/LearnPage'));
const NakamigosApp = lazy(() => import('./nakamigos/App'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
// R002: the classic art studio is dev-only. The DEV gate lets Rollup drop the chunk
// from production; the route below redirects there.
const ArtStudioPage = import.meta.env.DEV
  ? lazy(() => import('./pages/ArtStudioPage'))
  : null;
// The bungalow and door studios ship to prod unlisted and export-only: the save
// middleware is dev-only, so Save becomes a download. Their own chunks.
const BungalowArtStudioPage = lazy(() => import('./pages/BungalowArtStudioPage'));
const DoorArtStudioPage = lazy(() => import('./pages/DoorArtStudioPage'));
const InfoPage = lazy(() => import('./pages/InfoPage'));
// Tabbed section hosts: each lazy-imports the pages it hosts. A host is what a route
// renders, never where it points, so every URL below still lands.
const TrustPage = lazy(() => import('./pages/TrustPage'));
const EarnPage = lazy(() => import('./pages/EarnPage'));
const StatsPage = lazy(() => import('./pages/StatsPage'));
const LaunchHubPage = lazy(() => import('./pages/LaunchHubPage'));
const TradeHostPage = lazy(() => import('./pages/TradeHostPage'));
// Liquidity, the venue's Solana AMM, and Zap — the Pools section (2026-09-05).
const PoolsHostPage = lazy(() => import('./pages/PoolsHostPage'));
// The Island lobby: cards, not tabs. See IslandPage.tsx for why.
const IslandPage = lazy(() => import('./pages/IslandPage'));
// Docs for the keyed /api/v1 layer, rendered from api/_lib/apiTiers.js and
// /api/v1?route=status, so it cannot claim what is not configured.
const DeveloperPage = lazy(() => import('./pages/DeveloperPage'));
// The trade pages load inside TradeHostPage: @solana/* must never reach the main
// bundle (scripts/check-dist-graph.mjs pins it).
const CurveTokenPage = lazy(() => import('./pages/CurveTokenPage'));
// Never gated: a launched token's disclosures stay reachable if the wizard is re-gated.
const LaunchTokenPage = lazy(() => import('./pages/LaunchTokenPage'));
// AirdropFactory is undeployed: its transactions are isDeployed()-gated in-page.
const AirdropPage = lazy(() => import('./pages/AirdropPage'));
// Each vesting tab gates on its own contract address.
const VestingPage = lazy(() => import('./pages/VestingPage'));
// Wallet-free first-run flow; its steps come from the same gates the pages read.
const OnboardingFlow = lazy(() => import('./components/onboarding/OnboardingFlow'));

// Error boundary catches render errors in lazy-loaded pages and prevents white-screen crashes
class RouteErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { hasError: boolean }> {
  constructor(props: { children: ReactNode; resetKey?: string }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Route render error:', error, info.componentStack);
  }
  // A location change (resetKey) clears the error; not key={pathname}, which would
  // remount AnimatedRoutes and break its page transitions.
  componentDidUpdate(prevProps: { resetKey?: string }) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
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
  // No canonical (a soft-404 served 200) and noindex. A colon, not an em dash: AppLayout
  // reads document.title aloud through an aria-live region on every navigation.
  usePageTitle('404: Page Not Found', undefined, { noCanonical: true, noIndex: true });
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
              { to: '/earn', label: 'Earn' },
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

// Scroll to top on PUSH/REPLACE; on POP (Back/Forward) the browser restores the position.
function ScrollToTop() {
  const { pathname, hash } = useLocation();
  const navType = useNavigationType();
  useEffect(() => {
    if (navType === 'POP') return;
    // A #section deep link: the native hash-scroll fires before the target mounts, so
    // it is re-run on the next frame and once more shortly after.
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

/**
 * `/read/<address>`, the shared read link. Unfurl bots are answered at the edge by
 * middleware.js; a human lands here and is redirected to `?heat=`, the one hydration
 * path. The instrument validates the address, so a bad one shows its invalid state.
 */
function ReadRedirect() {
  const { address = '' } = useParams();
  const a = address.trim();
  return <Navigate to={a ? `/?heat=${encodeURIComponent(a)}` : '/'} replace />;
}

/** The studio's :bungalowId must be a registry id; anything else lands home. */
function BungalowStudioDoor() {
  const { bungalowId = '' } = useParams();
  if (!BUNGALOWS.some((b) => b.id === bungalowId)) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={<PageSkeleton />}>
      {BungalowArtStudioPage ? <BungalowArtStudioPage bungalowId={bungalowId} /> : null}
    </Suspense>
  );
}

/**
 * `/earn/<id>`: one pool, inside its own room. The id is a live registry id
 * ('toweli' included); anything else goes back to the list. The pool's room is
 * entered the way its front door enters it (BungalowDoor), so the art, the nav
 * and the pool all agree — and a link opened in a wallet's own browser, which
 * shares none of this browser's storage, still lands on the same pool.
 */
function EarnPoolRoute() {
  const { poolId = '' } = useParams();
  if (!isEarnPoolId(poolId)) return <Navigate to={EARN_PATH} replace />;
  return (
    <BungalowDoor key={poolId} id={poolId}>
      <Suspense fallback={<FarmSkeleton />}><EarnPage /></Suspense>
    </BungalowDoor>
  );
}

/** `/farm`, Earn's address until 2026-09-30: an old link keeps its meaning (legacyFarmTarget). */
function LegacyFarmRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={legacyFarmTarget(search, hash, getActiveBungalow())} replace />;
}

/**
 * `/swap`, with an old `?tab=liquidity` link sent to /liquidity before the swap page
 * loads: TradePage would read the unknown tab as 'swap', and redirecting from inside
 * it cost four serial chunk loads. The URL is known on the first render.
 */
function SwapRoute() {
  const [searchParams] = useSearchParams();
  if (searchParams.get('tab') === 'liquidity') return <Navigate to="/liquidity" replace />;
  return <Suspense fallback={<SwapSkeleton />}><TradeHostPage /></Suspense>;
}

function AnimatedRoutes() {
  return (
    <>
    <ScrollToTop />
    <Routes>
      {/* Nakamigos marketplace — renders outside AppLayout (has its own header/footer/background) */}
      <Route path="nakamigos/*" element={<NakamigosApp />} />
      {/* Art studio: dev tool, standalone. In prod ArtStudioPage is null, so the
          route redirects home. */}
      <Route
        path="art-studio"
        element={
          import.meta.env.DEV && ArtStudioPage
            ? <Suspense fallback={<PageSkeleton />}><ArtStudioPage /></Suspense>
            : <Navigate to="/" replace />
        }
      />
      {/* Studios are unlisted in prod, and none of these paths is an island slug,
          so door routing is untouched. */}
      <Route
        path="bayla-studio"
        element={<Suspense fallback={<PageSkeleton />}><BungalowArtStudioPage bungalowId="bayla" /></Suspense>}
      />
      <Route
        path="bungalow-studio/:bungalowId"
        element={<BungalowStudioDoor />}
      />
      <Route
        path="door-studio"
        element={<Suspense fallback={<PageSkeleton />}><DoorArtStudioPage /></Suspense>}
      />
      <Route element={<AppLayout />}>
        {/* `/` is the venue's own door: arriving clears a stored skin the way
            walking into /bayla sets one. The stored skin still dresses /swap
            and the rest; /earn/<id> enters its own pool's room. */}
        <Route
          index
          element={
            <BungalowDoor id={VENUE_ID}>
              {/* The venue's first frame, never "Loading...", while the home page's
                  chunk arrives (FirstFrame.tsx). */}
              <Suspense fallback={<FirstFrame />}><HomePage /></Suspense>
            </BungalowDoor>
          }
        />
        {/* One door per island slug, plus 'towelie' for toweli: home under that
            bungalow's skin (BungalowDoor). While the home page's chunk arrives, a
            door with a hero of its own keeps its heading on screen (DoorFrame). */}
        {[...BUNGALOWS.map((b) => ({ path: b.id, id: b.id })), { path: 'towelie', id: 'toweli' }].map(({ path, id }) => (
          <Route
            key={path}
            path={path}
            element={
              <BungalowDoor id={id}>
                <Suspense fallback={<DoorFrame id={id} />}><HomePage /></Suspense>
              </BungalowDoor>
            }
          />
        ))}
        {/* Earn is a tabbed host: /earn, the list of every pool, is its landing
            tab, and /earn/<id> is one pool under the same tab. */}
        <Route path="earn" element={<Suspense fallback={<FarmSkeleton />}><EarnPage /></Suspense>} />
        <Route path="earn/:poolId" element={<EarnPoolRoute />} />
        <Route path="farm" element={<LegacyFarmRedirect />} />
        {/* Swap is a tabbed host: Ethereum / Solana. */}
        <Route path="swap" element={<SwapRoute />} />
        <Route path="solana" element={<Suspense fallback={<SwapSkeleton />}><TradeHostPage /></Suspense>} />
        {/* Pools is its own section: /liquidity, /pools and /zap. */}
        <Route path="liquidity" element={<Suspense fallback={<SwapSkeleton />}><PoolsHostPage /></Suspense>} />
        <Route path="pools" element={<Suspense fallback={<SwapSkeleton />}><PoolsHostPage /></Suspense>} />
        {/* No /solana-launch and no redirect for it: it 404s, because the rail it
            would point at cannot launch either. */}
        <Route path="curve-launch" element={<Suspense fallback={<PageSkeleton />}><LaunchHubPage /></Suspense>} />
        <Route path="eth-curve" element={<Suspense fallback={<PageSkeleton />}><LaunchHubPage /></Suspense>} />
        <Route path="eth-curve/:token" element={<Suspense fallback={<PageSkeleton />}><CurveTokenPage /></Suspense>} />
        <Route path="launch" element={<Suspense fallback={<PageSkeleton />}><LaunchHubPage /></Suspense>} />
        <Route path="launch/:token" element={<Suspense fallback={<PageSkeleton />}><LaunchTokenPage /></Suspense>} />
        <Route path="launch-simulator" element={<Suspense fallback={<PageSkeleton />}><LaunchHubPage /></Suspense>} />
        <Route path="airdrop" element={<Suspense fallback={<PageSkeleton />}><AirdropPage /></Suspense>} />
        <Route path="vesting" element={<Suspense fallback={<PageSkeleton />}><VestingPage /></Suspense>} />
        <Route path="start" element={<Suspense fallback={<PageSkeleton />}><OnboardingFlow /></Suspense>} />
        <Route path="zap" element={<Suspense fallback={<SwapSkeleton />}><PoolsHostPage /></Suspense>} />
        <Route path="yield" element={<Suspense fallback={<PageSkeleton />}><EarnPage /></Suspense>} />
        {/* The nav labels this "Trade" — make the natural /trade URL resolve instead of 404. */}
        <Route path="copy-trading" element={<Suspense fallback={<PageSkeleton />}><EarnPage /></Suspense>} />
        <Route path="competitions" element={<Suspense fallback={<PageSkeleton />}><EarnPage /></Suspense>} />
        <Route path="trade" element={<Navigate to="/swap" replace />} />
        <Route path="dashboard" element={<Suspense fallback={<DashboardSkeleton />}><DashboardPage /></Suspense>} />
        {/* The Island lobby is cards, not tabs (IslandPage.tsx). */}
        <Route path="island" element={<Suspense fallback={<PageSkeleton />}><IslandPage /></Suspense>} />
        <Route path="gallery" element={<Suspense fallback={<PageSkeleton />}><GalleryPage /></Suspense>} />
        <Route path="tokenomics" element={<Suspense fallback={<PageSkeleton />}><StatsPage /></Suspense>} />
        <Route path="history" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="lore" element={<Suspense fallback={<PageSkeleton />}><LearnPage /></Suspense>} />
        {/* /learn is a legacy alias for the first tab LearnPage owns. */}
        <Route path="learn" element={<Navigate to="/lore" replace />} />
        <Route path="leaderboard" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="community" element={<Suspense fallback={<PageSkeleton />}><CommunityPage /></Suspense>} />
        <Route path="grants" element={<Navigate to="/community" replace />} />
        <Route path="bounties" element={<Navigate to="/community?section=bounties" replace />} />
        <Route path="restake" element={<Navigate to="/earn/toweli" replace />} />
        <Route path="premium" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="bribes" element={<Navigate to="/community?section=bribes" replace />} />
        <Route path="admin" element={<Suspense fallback={<PageSkeleton />}><AdminPage /></Suspense>} />
        {/* An Earn tab, so the section's strip stays above it. */}
        <Route path="nft-finance" element={<Suspense fallback={<PageSkeleton />}><EarnPage /></Suspense>} />
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
        <Route path="treasury" element={<Suspense fallback={<PageSkeleton />}><StatsPage /></Suspense>} />
        <Route path="exposure" element={<Suspense fallback={<PageSkeleton />}><TrustPage /></Suspense>} />
        {/* The shared read link. Bots are answered at the edge by middleware.js;
            these two routes are the human path. See ReadRedirect. */}
        <Route path="read/:address" element={<ReadRedirect />} />
        <Route path="read" element={<Navigate to="/" replace />} />
        <Route path="scan" element={<Suspense fallback={<PageSkeleton />}><TrustPage /></Suspense>} />
        <Route path="deployer" element={<Suspense fallback={<PageSkeleton />}><TrustPage /></Suspense>} />
        <Route path="trust" element={<Suspense fallback={<PageSkeleton />}><TrustPage /></Suspense>} />
        <Route path="terminal" element={<Suspense fallback={<PageSkeleton />}><TrustPage /></Suspense>} />
        <Route path="chart" element={<Suspense fallback={<PageSkeleton />}><TrustPage /></Suspense>} />
        <Route path="alerts" element={<Suspense fallback={<PageSkeleton />}><TrustPage /></Suspense>} />
        <Route path="referrals" element={<Suspense fallback={<PageSkeleton />}><EarnPage /></Suspense>} />
        <Route path="checkout" element={<Suspense fallback={<PageSkeleton />}><EarnPage /></Suspense>} />
        <Route path="tax" element={<Suspense fallback={<PageSkeleton />}><StatsPage /></Suspense>} />
        <Route path="developers" element={<Suspense fallback={<PageSkeleton />}><DeveloperPage /></Suspense>} />
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
  const { pathname } = useLocation();

  return (
    <RainbowKitProvider theme={isDark ? rainbowDark : rainbowLight}>
      <RouteErrorBoundary resetKey={pathname}>
        <Suspense fallback={<PageSkeleton />}>
          <AnimatedRoutes />
        </Suspense>
      </RouteErrorBoundary>
      {/* The install offer and the worker's registration, here rather than in
          AppLayout because /nakamigos is routed outside it. Renders nothing unless
          the browser offers an install; never claims the app works offline. */}
      <PwaRuntime />
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
          {/* LazyMotion ships only DOM-animation features; strict throws on a bare
              motion.X. reducedMotion="user" honours the OS setting app-wide. */}
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
