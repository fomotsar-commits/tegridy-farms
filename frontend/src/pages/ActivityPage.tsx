import { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';
import { PREMIUM_LIVE, type NavItem } from '../lib/navConfig';
import { RouteTabs } from '../components/layout/RouteTabs';
import { tabDomId } from '../components/layout/routeTabId';

/**
 * The tabs, as routes. Replaced a `Tab` union + TAB_LABELS + TAB_PATHS.
 *
 * Gold Card is listed here unconditionally and filtered below — the gate is one
 * expression in one place, next to the reasoning for it, rather than a second
 * literal that has to stay in step with this one.
 */
const ALL_TABS: readonly NavItem[] = [
  { to: '/leaderboard', label: 'Points' },
  { to: '/premium', label: 'Gold Card' },
  { to: '/history', label: 'History' },
  { to: '/changelog', label: 'Changelog' },
];

const LeaderboardPage = lazy(() => import('./LeaderboardPage'));
const PremiumPage = lazy(() => import('./PremiumPage'));
const HistoryPage = lazy(() => import('./HistoryPage'));
const ChangelogPage = lazy(() => import('./ChangelogPage'));

function tabFromPath(pathname: string): string {
  if (pathname.startsWith('/premium')) return '/premium';
  if (pathname.startsWith('/history')) return '/history';
  if (pathname.startsWith('/changelog')) return '/changelog';
  return '/leaderboard';
}

/// ActivityPage — tabbed host for Points (Leaderboard), Gold Card (Premium),
/// History, and Changelog. URLs `/leaderboard`, `/premium`, `/history`, and
/// `/changelog` all route here with the correct tab pre-selected, preserving
/// deep-link compatibility. The strip is the shared one
/// (components/layout/RouteTabs.tsx).
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
  //
  // This is the one host whose active tab is not simply its URL, which is why
  // RouteTabs takes `active` as a prop instead of reading the location itself.
  const effectiveTab = tab === '/premium' && !PREMIUM_LIVE ? '/leaderboard' : tab;

  // F9: don't promote the Gold Card tab while PREMIUM_ACCESS is zeroed — it would
  // dead-end in the not-deployed placeholder. The tab returns automatically the
  // moment the address lands in constants.ts (mirrors Footer/navConfig gating).
  const visibleTabs = ALL_TABS.filter((t) => t.to !== '/premium' || PREMIUM_LIVE);

  // Compared against effectiveTab, not tab: while !PREMIUM_LIVE the URL can be
  // /premium with Points selected, and clicking Points there must stay a no-op
  // rather than navigate to the tab the user is already looking at.
  const handleTab = (to: string) => {
    if (to === effectiveTab) return;
    navigate(to, { replace: false });
  };

  return (
    <>
      <RouteTabs
        idPrefix="activity"
        ariaLabel="Activity sections"
        items={visibleTabs}
        active={effectiveTab}
        onSelect={handleTab}
      />

      <div role="tabpanel" id="activity-panel" aria-labelledby={tabDomId('activity', effectiveTab)}>
        <Suspense fallback={<PageSkeleton />}>
          {effectiveTab === '/leaderboard' && <LeaderboardPage />}
          {effectiveTab === '/premium' && <PremiumPage />}
          {effectiveTab === '/history' && <HistoryPage />}
          {effectiveTab === '/changelog' && <ChangelogPage />}
        </Suspense>
      </div>
    </>
  );
}
