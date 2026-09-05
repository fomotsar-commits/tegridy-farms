import { lazy, Suspense, useEffect, Component, type ReactNode, type ErrorInfo } from 'react';
import { Routes, Route, Navigate, Link, useLocation, useNavigationType, useParams } from 'react-router-dom';
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
import { PwaRuntime } from './components/pwa/PwaRuntime';
import { BUNGALOWS } from './lib/bungalows';
import { BungalowDoor, VENUE_ID } from './components/bungalow/BungalowDoor';

const HomePage = lazy(() => import('./pages/HomePage'));
// ⌫ FarmPage's lazy import lived here. /farm renders EarnPage now (that section's
//   landing tab), and EarnPage lazy-loads FarmPage itself, so a second handle here
//   would be a duplicate chunk boundary for a page this file no longer mounts.
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
// ISLAND ORDER 2026-08-31: the bungalow skin studio SHIPS TO PROD as an
// unlisted, export-only room (reached by URL only; no nav entry links it).
// R002's reasoning still holds for the classic /art-studio above — that one
// stays dev-only — but the island's curator needs to place door art by eye
// in a real browser. In prod the page has no write path at all: the
// dev-only `/__bungalow-studio/save` middleware does not exist there, so
// Save becomes "Export placements", a client-side download of the same
// module the middleware would have written. Its own lazy chunk, so a
// visitor who never opens the studio pays nothing for it.
const BungalowArtStudioPage = lazy(() => import('./pages/BungalowArtStudioPage'));
// ⌫ LendingPage's lazy import lived here. /nft-finance renders EarnPage now
//   (it is a tab of that section), and EarnPage lazy-loads LendingPage itself.
// Terms, Privacy, Risks, Contracts, Treasury merged into InfoPage (tabs)
const InfoPage = lazy(() => import('./pages/InfoPage'));
// ── FOUR TABBED SECTION HOSTS (2026-09-04) ───────────────────────────────────
// Seventeen lazy page imports used to sit here. They did not disappear: the
// "More" dropdown's Launch / Earn / Stats / Trust & Safety sections each
// collapsed into ONE menu row plus a tabbed page, so each host now lazy-imports
// the pages it hosts — and carries the comment that used to be on that import.
// Read them there: TrustPage.tsx, EarnPage.tsx, StatsPage.tsx, LaunchHubPage.tsx.
//
// Every route below is unchanged. A host is what a route RENDERS, never where
// it points, so /scan, /tax, /eth-curve and the other fourteen are the same URLs
// they always were — deep links, footer links and e2e routes all still land.
const TrustPage = lazy(() => import('./pages/TrustPage'));
const EarnPage = lazy(() => import('./pages/EarnPage'));
const StatsPage = lazy(() => import('./pages/StatsPage'));
const LaunchHubPage = lazy(() => import('./pages/LaunchHubPage'));
const TradeHostPage = lazy(() => import('./pages/TradeHostPage'));
// Liquidity, the venue's Solana AMM, and Zap — the Pools section (2026-09-05).
const PoolsHostPage = lazy(() => import('./pages/PoolsHostPage'));
// The Island lobby: cards, not tabs. See IslandPage.tsx for why.
const IslandPage = lazy(() => import('./pages/IslandPage'));
// Docs for the keyed /api/v1 layer. Renders its tiers, routes and refusal codes
// from api/_lib/apiTiers.js and its deployment state from /api/v1?route=status,
// so neither the price list nor the signup can claim what is not configured.
const DeveloperPage = lazy(() => import('./pages/DeveloperPage'));
// TradePage, SolanaSwapPage and PoolsPage are now lazy-imported by
// TradeHostPage, which owns all four trade routes. They stay lazy for the same
// reason they always were: @solana/* must load with those chunks and never with
// the main bundle or the EVM surface. The dist-graph gate pins that.
// Permanent per-token record at /eth-curve/:token — the shareable page a curve
// creator hands out and the launches grid links into.
const CurveTokenPage = lazy(() => import('./pages/CurveTokenPage'));
// Permanent per-token record at /launch/:token — the page cohort rows link into.
// Read-only; never gated, because a launched token's disclosures must stay reachable
// even if the create wizard is re-gated.
const LaunchTokenPage = lazy(() => import('./pages/LaunchTokenPage'));
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
// ⌫ ZapPage's lazy import likewise: /zap is a tab on PoolsHostPage now, which
//   loads it. It was previously routed here and linked from NOWHERE in the app.
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

/**
 * Param leg of the dev studio: validates :bungalowId against the registry so
 * a typo'd or hostile slug renders the public site, never a broken tool.
 */
function BungalowStudioDoor() {
  const { bungalowId = '' } = useParams();
  if (!BUNGALOWS.some((b) => b.id === bungalowId)) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={<PageSkeleton />}>
      {BungalowArtStudioPage ? <BungalowArtStudioPage bungalowId={bungalowId} /> : null}
    </Suspense>
  );
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
      {/* Bayla studio — the same tool aimed at the Bayla bungalow's own art
          pool. UNLISTED IN PROD (ISLAND ORDER 2026-08-31): reachable by URL
          only, export-only, no write path off the dev middleware.
          NOTE: this path must stay OUTSIDE the bungalow-door slugs (a door is
          /bayla); '/bayla-studio' is not an island slug, so no collision. */}
      <Route
        path="bayla-studio"
        element={<Suspense fallback={<PageSkeleton />}><BungalowArtStudioPage bungalowId="bayla" /></Suspense>}
      />
      {/* Generic per-resident studio (WO-1): /bungalow-studio/<id> aims the
          SAME tool at any registry bungalow — the page and the override store
          were parametric all along, only this route pinned 'bayla'. Unlisted in
          prod alongside /bayla-studio; an unknown id lands home. '/bungalow-studio' is not an island slug,
          so door routing is untouched. */}
      <Route
        path="bungalow-studio/:bungalowId"
        element={<BungalowStudioDoor />}
      />
      <Route element={<AppLayout />}>
        {/* THE VENUE'S OWN DOOR (2026-09-04). `/` is wrapped in the same
            component as every bungalow door, with id="venue", so arriving at
            the index clears a stored skin exactly the way walking into /bayla
            sets one.

            Before this, HomePage read its identity from ambient storage rather
            than from the route, so `/` rendered whatever bungalow was stored:
            same hero, same lore, same title, and NO door grid (it is gated on
            `!bungalowIdentity`). Two URLs, one page. The nav wordmark had a
            hand-rolled version of this fix in its onClick and was the only way
            back — the 404 page's "Back to Home" and every other plain
            <Link to="/"> walked straight into the bungalow.

            Putting it at the destination fixes every link at once, and is why
            no other route needed to change: the stored skin still dresses
            /farm, /swap and the rest. */}
        <Route
          index
          element={
            <BungalowDoor id={VENUE_ID}>
              <Suspense fallback={<PageSkeleton />}><HomePage /></Suspense>
            </BungalowDoor>
          }
        />
        {/* Jungle Bay bungalow doors — the memetics.finance/<bungalow> URL
            format. One route per island slug (all 13, so every door exists
            from day one) plus the 'towelie' spelling as an alias for the
            toweli slug. A door renders home under its bungalow's skin; see
            BungalowDoor for the enter-on-visit semantics. None of these
            slugs collides with an app route — the registry test would catch
            a future clash via the canon id list. */}
        {[...BUNGALOWS.map((b) => ({ path: b.id, id: b.id })), { path: 'towelie', id: 'toweli' }].map(({ path, id }) => (
          <Route
            key={path}
            path={path}
            element={
              <BungalowDoor id={id}>
                <Suspense fallback={<PageSkeleton />}><HomePage /></Suspense>
              </BungalowDoor>
            }
          />
        ))}
        {/* EARN IS A TABBED HOST 2026-09-05. /farm was a top-bar destination
            called "Farm"; it is the landing tab of the Earn section now, beside
            /nft-finance which came off the bar for the same reason. Both still
            render standalone from a deep link, with the strip above them. */}
        <Route path="farm" element={<Suspense fallback={<FarmSkeleton />}><EarnPage /></Suspense>} />
        {/* SWAP IS A TABBED HOST. Two routes, one strip: Ethereum / Solana.
            Every path still renders its own page standalone from a deep link. */}
        <Route path="swap" element={<Suspense fallback={<SwapSkeleton />}><TradeHostPage /></Suspense>} />
        <Route path="solana" element={<Suspense fallback={<SwapSkeleton />}><TradeHostPage /></Suspense>} />
        {/* POOLS IS ITS OWN SECTION 2026-09-05, and /liquidity is a real page
            rather than a path alias.
            Before this, /liquidity rendered TradeHostPage — which had no
            /liquidity tab — so SectionHost fell through to items[0] and landed
            the visitor on the Ethereum SWAP surface, where TradePage then opened
            its own inner `?tab=liquidity`. Providing liquidity was the second of
            six tabs on the trading page. It is a destination now, and /pools
            (the venue's Solana AMM) and /zap are its siblings. */}
        <Route path="liquidity" element={<Suspense fallback={<SwapSkeleton />}><PoolsHostPage /></Suspense>} />
        <Route path="pools" element={<Suspense fallback={<SwapSkeleton />}><PoolsHostPage /></Suspense>} />
        {/* /solana-launch (Meteora DBC) was REMOVED 2026-08-23 — it graduated into a
            pool this protocol does not own. /curve-launch below is the surviving Solana
            launch rail. No redirect is added on purpose: the route is gone, so the SPA
            404s, and a redirect to a rail that ALSO cannot launch (both program ids are
            spent) would move a dead end rather than close one. */}
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
        {/* The Island lobby — the one section that is cards rather than a tab
            strip, because three of its doors already own a strip of their own.
            See IslandPage.tsx. */}
        <Route path="island" element={<Suspense fallback={<PageSkeleton />}><IslandPage /></Suspense>} />
        <Route path="gallery" element={<Suspense fallback={<PageSkeleton />}><GalleryPage /></Suspense>} />
        <Route path="tokenomics" element={<Suspense fallback={<PageSkeleton />}><StatsPage /></Suspense>} />
        <Route path="history" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="lore" element={<Suspense fallback={<PageSkeleton />}><LearnPage /></Suspense>} />
        {/* /learn is a legacy alias. It pointed at /tokenomics until 2026-09-04, when
            Tokenomics moved to the Stats host — it now lands on the first tab LearnPage
            still owns, rather than bouncing out of the host it names. */}
        <Route path="learn" element={<Navigate to="/lore" replace />} />
        <Route path="leaderboard" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="community" element={<Suspense fallback={<PageSkeleton />}><CommunityPage /></Suspense>} />
        <Route path="grants" element={<Navigate to="/community" replace />} />
        <Route path="bounties" element={<Navigate to="/community?section=bounties" replace />} />
        <Route path="restake" element={<Navigate to="/farm" replace />} />
        <Route path="premium" element={<Suspense fallback={<PageSkeleton />}><ActivityPage /></Suspense>} />
        <Route path="bribes" element={<Navigate to="/community?section=bribes" replace />} />
        <Route path="admin" element={<Suspense fallback={<PageSkeleton />}><AdminPage /></Suspense>} />
        {/* An Earn tab like the rest of that section. It was left rendering
            LendingPage directly in the first cut of the 2026-09-05 rewrite,
            which made it the ONE Earn destination where the strip vanished —
            and made `panels['/nft-finance']` in EarnPage.tsx unreachable. */}
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
      {/* #46 — the install offer and the app-shell worker's registration. Mounted
          here rather than inside AppLayout because /nakamigos is routed OUTSIDE that
          layout and the worker's scope covers it either way; the banner suppresses
          itself on that route so the sub-app's own banner is the only one shown.
          Both halves render nothing at all unless the browser actually offers an
          install, and neither ever claims the app works offline. */}
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
