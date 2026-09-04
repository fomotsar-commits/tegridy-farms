import { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';
import { RouteTabs } from '../components/layout/RouteTabs';
import { tabDomId } from '../components/layout/routeTabId';
import type { NavItem } from '../lib/navConfig';

// 🔻 2026-09-04 — TREASURY LEFT THIS HOST. It is a tab on StatsPage now, beside
// Tokenomics and Tax Reports, because the "More" menu's own Stats section already
// grouped those three and a route can only render one tab bar (StatsPage.tsx
// spells out why there was no version of that change which left this file alone).
// What remains here is the legal + reference shelf. /treasury is unchanged as a
// URL and still linked from the Footer.

/**
 * The tabs, as routes.
 *
 * Replaced a `Tab` union + TAB_LABELS + VISIBLE_TABS + TAB_PATHS. The comment on
 * VISIBLE_TABS ("Derived, not re-listed: the tab bar and the keyboard helper must
 * walk the same order, and a second literal is how those two drift") was pointing
 * at a real hazard, and this closes it at the source rather than deriving around
 * it: there is one literal now, and RouteTabs feeds the same array to the strip
 * and to `useTabListKeys` itself.
 */
const TABS: readonly NavItem[] = [
  { to: '/contracts', label: 'Contracts' },
  { to: '/risks', label: 'Risks' },
  { to: '/terms', label: 'Terms' },
  { to: '/privacy', label: 'Privacy' },
];

const ContractsPage = lazy(() => import('./ContractsPage'));
const RisksPage = lazy(() => import('./RisksPage'));
const TermsPage = lazy(() => import('./TermsPage'));
const PrivacyPage = lazy(() => import('./PrivacyPage'));

function tabFromPath(pathname: string): string {
  if (pathname.startsWith('/risks')) return '/risks';
  if (pathname.startsWith('/terms')) return '/terms';
  if (pathname.startsWith('/privacy')) return '/privacy';
  // Contracts is the landing tab.
  return '/contracts';
}

/// InfoPage — tabbed host for Contracts, Risks, Terms, and Privacy.
/// URLs `/contracts`, `/risks`, `/terms`, `/privacy` each land on the matching
/// tab so deep links keep working. The strip is the shared one
/// (components/layout/RouteTabs.tsx), as on every other tabbed host.
export default function InfoPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // R007 Pattern A — derive `tab` directly from the URL.
  const tab = tabFromPath(location.pathname);

  const handleTab = (to: string) => {
    if (to === tab) return;
    navigate(to, { replace: false });
  };

  // These looked like tabs, were built as `aria-pressed` toggle buttons, and
  // carried no role, no aria-controls, no tabpanel and no roving focus — so the
  // site's legal and treasury navigation reached assistive tech as five
  // unlabelled toggles. All five now come from RouteTabs, which is where that
  // markup ended up after ActivityPage's correct version of it was copied here
  // and then extracted; InfoPage.tablist.test.tsx pins every one of them.
  return (
    <>
      <RouteTabs
        idPrefix="info"
        ariaLabel="Info sections"
        items={TABS}
        active={tab}
        onSelect={handleTab}
      />

      {/* Contracts needs extra top padding to clear the sticky tab bar; the
          other three already carry their own. */}
      <div role="tabpanel" id="info-panel" aria-labelledby={tabDomId('info', tab)}>
        <Suspense fallback={<PageSkeleton />}>
          {tab === '/contracts' && <div className="pt-14"><ContractsPage /></div>}
          {tab === '/risks' && <RisksPage />}
          {tab === '/terms' && <TermsPage />}
          {tab === '/privacy' && <PrivacyPage />}
        </Suspense>
      </div>
    </>
  );
}
