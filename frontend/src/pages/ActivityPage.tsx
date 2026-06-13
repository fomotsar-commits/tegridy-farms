import { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';
import { PREMIUM_LIVE } from '../lib/navConfig';
import { useTabListKeys } from '../hooks/useTabListKeys';

type Tab = 'points' | 'gold' | 'history' | 'changelog';

const TAB_LABELS: Record<Tab, string> = {
  points: 'Points',
  gold: 'Gold Card',
  history: 'History',
  changelog: 'Changelog',
};

const TAB_PATHS: Record<Tab, string> = {
  points: '/leaderboard',
  gold: '/premium',
  history: '/history',
  changelog: '/changelog',
};

const LeaderboardPage = lazy(() => import('./LeaderboardPage'));
const PremiumPage = lazy(() => import('./PremiumPage'));
const HistoryPage = lazy(() => import('./HistoryPage'));
const ChangelogPage = lazy(() => import('./ChangelogPage'));

function tabFromPath(pathname: string): Tab {
  if (pathname.startsWith('/premium')) return 'gold';
  if (pathname.startsWith('/history')) return 'history';
  if (pathname.startsWith('/changelog')) return 'changelog';
  return 'points';
}

/// ActivityPage — tabbed host for Points (Leaderboard), Gold Card (Premium),
/// History, and Changelog. URLs `/leaderboard`, `/premium`, `/history`, and
/// `/changelog` all route here with the correct tab pre-selected, preserving
/// deep-link compatibility. Mirrors the LearnPage pattern used for
/// Tokenomics/Lore/Security/FAQ.
export default function ActivityPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // R007 Pattern A — derive `tab` directly from the URL on every render.
  // No effect, no state, no cascading set. The URL is the source of truth.
  const tab = tabFromPath(location.pathname);

  // F523: /premium maps to the Gold Card tab, but its content is a SOON
  // placeholder until the PremiumAccess contract deploys. Landing first-time
  // visitors on an empty feature is a poor impression, so while !PREMIUM_LIVE
  // the Gold Card tab self-heals to the live Points content. The bar highlights
  // Points to stay coherent, and the moment PREMIUM_LIVE flips true (address
  // wired in constants.ts) /premium shows the real Gold Card with no code change.
  const effectiveTab: Tab = tab === 'gold' && !PREMIUM_LIVE ? 'points' : tab;

  // F9: don't promote the Gold Card tab while PREMIUM_ACCESS is zeroed — it would
  // dead-end in the not-deployed placeholder. The tab returns automatically the
  // moment the address lands in constants.ts (mirrors Footer/navConfig gating).
  const visibleTabs = (Object.keys(TAB_LABELS) as Tab[]).filter(
    (t) => t !== 'gold' || PREMIUM_LIVE,
  );

  const handleTab = (t: Tab) => {
    if (t === effectiveTab) return;
    navigate(TAB_PATHS[t], { replace: false });
  };

  // T10 (F22): WAI-ARIA tabs roving-focus + arrow-key navigation. These tabs
  // navigate routes (each sub-page is lazy-loaded into the tabpanel below), so
  // "activate" = navigate; the pattern still applies for keyboard users.
  const tabKeys = useTabListKeys(visibleTabs, effectiveTab, handleTab);

  return (
    <>
      <div
        className="fixed left-0 right-0 z-30 px-4 md:px-6 pointer-events-none"
        style={{ top: 56 }}
      >
        <div className="max-w-[900px] mx-auto pt-3 pointer-events-auto">
          <div
            role="tablist"
            aria-label="Activity sections"
            onKeyDown={tabKeys.onKeyDown}
            className="flex gap-1.5 p-1 rounded-2xl"
            style={{
              // F509: opacity bump 0.72 -> 0.92 (sibling of InfoPage) so text
              // underneath stops ghosting through the sticky pill bar.
              background: 'rgba(13,21,48,0.92)',
              border: '1px solid rgba(255,255,255,0.22)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
            }}
          >
            {visibleTabs.map((t) => (
              <button
                key={t}
                role="tab"
                id={`activity-tab-${t}`}
                aria-selected={effectiveTab === t}
                aria-controls="activity-panel"
                tabIndex={tabKeys.tabIndex(t)}
                ref={tabKeys.ref(t)}
                onClick={() => handleTab(t)}
                className="flex-1 px-3 md:px-4 py-2 min-h-[40px] rounded-xl text-[13px] md:text-[14px] font-medium text-white transition-all whitespace-nowrap"
                style={
                  effectiveTab === t
                    ? { background: 'var(--color-stan)', boxShadow: '0 4px 12px var(--color-stan-40)' }
                    : undefined
                }
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div role="tabpanel" id="activity-panel" aria-labelledby={`activity-tab-${effectiveTab}`}>
        <Suspense fallback={<PageSkeleton />}>
          {effectiveTab === 'points' && <LeaderboardPage />}
          {effectiveTab === 'gold' && <PremiumPage />}
          {effectiveTab === 'history' && <HistoryPage />}
          {effectiveTab === 'changelog' && <ChangelogPage />}
        </Suspense>
      </div>
    </>
  );
}
