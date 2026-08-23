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
// Public token scanner (concentration/bundle/holder-quality read; self-gates when
// holder data is unavailable) + wallet exposure view (the scanner pointed inward).
const ScannerPage = lazy(() => import('./pages/ScannerPage'));
const WalletExposurePage = lazy(() => import('./pages/WalletExposurePage'));
// Deployer reputation graph — a deployer's past launches + what happened to each.
const DeployerPage = lazy(() => import('./pages/DeployerPage'));
// Thin hub that frames the three detection surfaces above as one anti-rug suite.
const TrustHubPage = lazy(() => import('./pages/TrustHubPage'));
// The same detection stack pointed at a discovery feed: pairs from the F1 indexer,
// each row carrying its safety read or an explicit statement that it has none.
const TerminalPage = lazy(() => import('./pages/TerminalPage'));
// Alert rules over the same subjects (token / wallet / deployer), pushed instead of
// pulled. NOT flag-gated: the rule store lives behind a migration an operator applies
// by hand, so until `016_alert_rules.sql` lands every alerts call answers 503
// `schema-missing` and the panels print that with the operator step attached. Routing it
// while it says so is the point — a flag here would hide the one honest state it has.
const AlertsPage = lazy(() => import('./pages/AlertsPage'));
// Referral links, the staking threshold that decides whether sharing one earns
// anything at all, and the on-chain claim. NOT flag-gated and not pilled: the
// splitter is deployed and the long-form `/?ref=0x…` link resolves in the browser
// with no server, so the surface is live. Only the optional short `/?r=code` form
// needs `019_referral_codes.sql`, and the share card prints that store's own answer
// rather than gating the page on it.
const ReferralsPage = lazy(() => import('./pages/ReferralsPage'));
// Docs for the keyed /api/v1 layer. Renders its tiers, routes and refusal codes
// from api/_lib/apiTiers.js and its deployment state from /api/v1?route=status,
// so neither the price list nor the signup can claim what is not configured.
const DeveloperPage = lazy(() => import('./pages/DeveloperPage'));
// Solana fee-capture surface (Surface A). Lazy so the @solana/* deps load only
// with this chunk — never the main bundle / EVM surface.
const SolanaSwapPage = lazy(() => import('./pages/SolanaSwapPage'));
// Solana launch sub-brand (Meteora DBC). Gated in-page (isSolanaLauncherEnabled)
// — renders the SOON placeholder until an operator enables it + a verified vault.
const SolanaLaunchPage = lazy(() => import('./pages/SolanaLaunchPage'));
// Our OWN Solana bonding curve (tegridy-launch), which graduates into our cp-swap
// fork — as opposed to the Meteora rail above. NOT gated by a flag: the page
// probes the chain for the program on mount and renders "not deployed" from that
// live read, so it needs no redeploy to start working once the program ships.
const CurveLaunchPage = lazy(() => import('./pages/CurveLaunchPage'));
const EthCurvePage = lazy(() => import('./pages/EthCurvePage'));
// Token launch rail (Doppler V4 integration). LIVE since 2026-07-22
// (LAUNCHER_ENABLED = true); renders the create wizard. Still in-page-gated by
// isLauncherEnabled() so it can be re-gated by flipping the flag + redeploying.
const LaunchPage = lazy(() => import('./pages/LaunchPage'));
// Permanent per-token record at /launch/:token — the page cohort rows link into.
// Read-only; never gated, because a launched token's disclosures must stay reachable
// even if the create wizard is re-gated.
const LaunchTokenPage = lazy(() => import('./pages/LaunchTokenPage'));
// Launch simulator — preview a token's distribution band + Fact-Sheet tier before
// launching. Pure client-side, always usable (deliberately live before the launch rail).
const LaunchSimulatorPage = lazy(() => import('./pages/LaunchSimulatorPage'));
// Merkle airdrop campaigns (#65). AirdropFactory is undeployed, so the funding and
// claim transactions are isDeployed()-gated in-page; the client-side tree builder is
// not, because a root computed from a CSV needs no chain.
const AirdropPage = lazy(() => import('./pages/AirdropPage'));
// Vesting streams + lock viewer (#28). Each tab gates on its own contract address, so
// a deployment that ships one rail before the other shows the live one and keeps
// reporting "no data" for the other.
const VestingPage = lazy(() => import('./pages/VestingPage'));
// Guided first-run flow (#43). Wallet-free and never gated itself — its step list is built
// from the same gates the destination pages read, so a re-gated surface disappears from it
// rather than being promised. Lives under components/onboarding/ with the on-ramp panel it
// mounts, not in pages/, because the flow and that panel are one feature.
const OnboardingFlow = lazy(() => import('./components/onboarding/OnboardingFlow'));
// Zap engine (#67). Client-orchestrated only — no zap contract exists or is planned, per
// docs/USER_VALUE_ROADMAP.md line 101. Never gated: with no wallet it renders the composer
// and its refusal states, and each venue reports its own availability from constants.ts.
// Lives under components/zap/ with the panel it mounts, as OnboardingFlow does.
const ZapPage = lazy(() => import('./components/zap/ZapPage'));
// LaunchpadPage lazy import removed — loaded inside LendingPage
// NFTAMMPage merged into LendingPage (NFT Finance)

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
  // Recover on client-side navigation: once a route crashes, a location change (resetKey)
  // clears the error so the user isn't stranded on the fallback until a full page reload.
  // We reset on nav rather than key={pathname} to avoid remounting AnimatedRoutes (which
  // would break its page transitions).
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
        <Route path="solana-launch" element={<Suspense fallback={<PageSkeleton />}><SolanaLaunchPage /></Suspense>} />
        <Route path="curve-launch" element={<Suspense fallback={<PageSkeleton />}><CurveLaunchPage /></Suspense>} />
        <Route path="eth-curve" element={<Suspense fallback={<PageSkeleton />}><EthCurvePage /></Suspense>} />
        <Route path="launch" element={<Suspense fallback={<PageSkeleton />}><LaunchPage /></Suspense>} />
        <Route path="launch/:token" element={<Suspense fallback={<PageSkeleton />}><LaunchTokenPage /></Suspense>} />
        <Route path="launch-simulator" element={<Suspense fallback={<PageSkeleton />}><LaunchSimulatorPage /></Suspense>} />
        <Route path="airdrop" element={<Suspense fallback={<PageSkeleton />}><AirdropPage /></Suspense>} />
        <Route path="vesting" element={<Suspense fallback={<PageSkeleton />}><VestingPage /></Suspense>} />
        <Route path="start" element={<Suspense fallback={<PageSkeleton />}><OnboardingFlow /></Suspense>} />
        <Route path="zap" element={<Suspense fallback={<SwapSkeleton />}><ZapPage /></Suspense>} />
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
        <Route path="exposure" element={<Suspense fallback={<PageSkeleton />}><WalletExposurePage /></Suspense>} />
        <Route path="scan" element={<Suspense fallback={<PageSkeleton />}><ScannerPage /></Suspense>} />
        <Route path="deployer" element={<Suspense fallback={<PageSkeleton />}><DeployerPage /></Suspense>} />
        <Route path="trust" element={<Suspense fallback={<PageSkeleton />}><TrustHubPage /></Suspense>} />
        <Route path="terminal" element={<Suspense fallback={<PageSkeleton />}><TerminalPage /></Suspense>} />
        <Route path="alerts" element={<Suspense fallback={<PageSkeleton />}><AlertsPage /></Suspense>} />
        <Route path="referrals" element={<Suspense fallback={<PageSkeleton />}><ReferralsPage /></Suspense>} />
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
