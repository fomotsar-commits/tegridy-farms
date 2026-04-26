import { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';

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

  const handleTab = (t: Tab) => {
    if (t === tab) return;
    navigate(TAB_PATHS[t], { replace: false });
  };

  return (
    <>
      <div
        className="fixed left-0 right-0 z-30 px-4 md:px-6 pointer-events-none"
        style={{ top: 56 }}
      >
        <div className="max-w-[900px] mx-auto pt-3 pointer-events-auto">
          <div
            className="flex gap-1.5 p-1 rounded-2xl"
            style={{
              background: 'rgba(13,21,48,0.72)',
              border: '1px solid rgba(255,255,255,0.22)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
            }}
          >
            {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => handleTab(t)}
                aria-pressed={tab === t}
                className="flex-1 px-3 md:px-4 py-2 min-h-[40px] rounded-xl text-[13px] md:text-[14px] font-medium text-white transition-all whitespace-nowrap"
                style={
                  tab === t
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

      <Suspense fallback={<PageSkeleton />}>
        {tab === 'points' && <LeaderboardPage />}
        {tab === 'gold' && <PremiumPage />}
        {tab === 'history' && <HistoryPage />}
        {tab === 'changelog' && <ChangelogPage />}
      </Suspense>
    </>
  );
}
