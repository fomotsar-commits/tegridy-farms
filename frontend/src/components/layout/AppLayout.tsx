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
import { PageTransition } from '../motion';
import { OnboardingModal } from '../ui/OnboardingModal';
import { BungalowPicker } from '../BungalowPicker';
import { BungalowOnboarding } from '../bungalow/BungalowOnboarding';
import { MuseBubble } from '../bungalow/MuseBubble';
import { hasChosenBungalow, getBungalowIdentity, OPEN_BUNGALOWS_EVENT } from '../../lib/bungalows';
import { ConsentBanner } from '../ui/ConsentBanner';
import { WalletConnectWatchdog } from '../ui/WalletConnectWatchdog';
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

  // F7: gate the first-visit OnboardingModal on splash completion. Otherwise the
  // modal mounts open UNDER the splash, its document-level Escape handler fires
  // on the same ESC the user presses to skip the splash (silently marking
  // onboarding "seen"), and its focus trap steals focus while the splash still
  // covers it. AppLoader calls onComplete exactly once — whether the splash
  // plays or is skipped (repeat visit / reduced-motion) — so this flips true the
  // moment the splash is gone.
  const [splashDone, setSplashDone] = useState(false);

  // Jungle Bay bungalow picker — the screen after the intro. `freshSplash`
  // captures whether this document load actually played (or would have
  // played) the splash: the state initializer runs before AppLoader mounts
  // and sets `tf_loaded`, so a pre-seeded session (returning tab, e2e
  // fixtures) reads true here and never auto-opens the picker. It auto-opens
  // exactly once — first splash with no persisted choice — and any dismissal
  // persists a choice (see BungalowPicker), so it never nags.
  const [freshSplash] = useState(() => {
    try { return !sessionStorage.getItem('tf_loaded'); } catch { return false; }
  });
  const [bungalowChosenAtMount] = useState(() => hasChosenBungalow());
  const [pickerDismissed, setPickerDismissed] = useState(false);
  // Footer's "Bungalows" button (and anything else) can reopen it any time.
  const [pickerRequested, setPickerRequested] = useState(false);
  useEffect(() => {
    const openPicker = () => setPickerRequested(true);
    window.addEventListener(OPEN_BUNGALOWS_EVENT, openPicker);
    return () => window.removeEventListener(OPEN_BUNGALOWS_EVENT, openPicker);
  }, []);
  // Derived, not set in an effect (react-hooks/set-state-in-effect): auto-open
  // exactly once — first real splash, no persisted choice, not yet dismissed.
  const pickerOpen = pickerRequested
    || (splashDone && freshSplash && !bungalowChosenAtMount && !pickerDismissed);
  const closePicker = () => { setPickerDismissed(true); setPickerRequested(false); };
  // Token-first bungalow (Bayla): mute the Towelie personality surfaces —
  // the assistant bubble and the TOWELI-scripted onboarding are the wrong
  // voice there. Both return untouched in the Toweli default. Stable per
  // document (bungalow switches reload).
  const bungalowIdentity = getBungalowIdentity();

  // F44: announce route changes to screen readers. SPA navigations are otherwise
  // silent — title changes aren't reliably announced on route change. We read
  // document.title (set by usePageTitle) one tick after navigation so the new
  // page's title is in place, then push it into a polite live region.
  const [routeAnnouncement, setRouteAnnouncement] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setRouteAnnouncement(document.title), 120);
    return () => window.clearTimeout(id);
  }, [location.pathname]);

  return (
    <AppLoader onComplete={() => setSplashDone(true)}>
    <PriceProvider>
    <ConfettiProvider>
    <TransactionReceiptProvider>
    <TowelieProvider>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      {/* F44: visually-hidden polite live region announcing the current page. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">{routeAnnouncement}</div>
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


      {/* pb-20 for bottom nav height + safe-area-inset-bottom for notched devices.
          F13: drop the reserved band at `sm:` (640px) to match BottomNav's
          `sm:hidden` — `md:pb-0` left dead padding at 640-767px where the nav
          is already hidden.
          F8: the content top-offset matches the header's safe-area-aware height
          (calc(3.5rem + env(safe-area-inset-top))) so nothing tucks under the
          fixed header on a notched standalone launch. */}
      <div
        className="min-h-screen relative z-10 pb-20 sm:pb-0 safe-area-content-bottom"
        style={{ paddingTop: 'calc(3.5rem + env(safe-area-inset-top, 0px))' }}
      >
        {/* F29: tabIndex={-1} so the skip-link target reliably receives focus —
            without it some browsers scroll but leave focus in the nav, sending
            the next Tab back to the header instead of into the content. */}
        <main id="main-content" tabIndex={-1}>
          <PageTransition pathname={location.pathname}>
            <ErrorBoundary resetKeys={[location.pathname]}>
              <Outlet />
            </ErrorBoundary>
          </PageTransition>
        </main>
        <Footer />
      </div>

      <BottomNav />
      {/* LiveActivity's ticker is TOWELI-denominated (price pill, protocol
          feed) — muted alongside the assistant in a token-first bungalow,
          where the muse's quiet line takes the corner instead. */}
      {!bungalowIdentity && <LiveActivity />}
      {bungalowIdentity ? <MuseBubble /> : <TowelieAssistant />}
      <BungalowPicker open={pickerOpen} onClose={closePicker} />
      {/* F7: only after the splash finishes (see splashDone above), and held
          back while the bungalow picker is up so a first visit sees intro →
          bungalow choice → onboarding, not all three stacked. In a
          token-first bungalow the TOWELI-scripted tour is replaced by the
          bungalow's own three-step welcome. */}
      {splashDone && !pickerOpen && (
        bungalowIdentity
          ? <BungalowOnboarding bungalow={bungalowIdentity} />
          : <OnboardingModal />
      )}
      {/* R046 / H-1: GDPR/ePrivacy consent gate. Renders only on first visit
          (consent === 'pending'); analytics + error reporting are blocked
          until the user clicks Accept or Decline. */}
      <ConsentBanner />
      {/* WALLET-02: advisory notice when a wallet connection stalls. Not a
          <Toaster> toast on purpose — RainbowKit pins its modal at
          z-index 2147483646, so anything lower renders behind the very
          spinner it is trying to explain. */}
      <WalletConnectWatchdog />

      {/* F28: clear the fixed 56px header (+ notch inset) so top-right toasts
          don't render behind/flush with the header on small screens. */}
      <Toaster
        position="top-right"
        theme={isDark ? 'dark' : 'light'}
        offset="calc(4.5rem + env(safe-area-inset-top, 0px))"
        toastOptions={{
          style: {
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-primary)',
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
