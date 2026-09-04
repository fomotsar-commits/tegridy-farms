import { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';
import { RouteTabs } from '../components/layout/RouteTabs';
import { tabDomId } from '../components/layout/routeTabId';
import type { NavItem } from '../lib/navConfig';

// 🔻 2026-09-04 — TOKENOMICS LEFT THIS HOST. It is a tab on StatsPage now, beside
// Treasury and Tax Reports, because the "More" menu's own Stats section already
// grouped those three and a route can only render one tab bar (StatsPage.tsx
// spells out why there was no version of that change which left this file alone).
// What remains here is the narrative: the story, the security posture, the
// questions. /tokenomics is unchanged as a URL and still linked from the Footer.

/**
 * The tabs, as routes.
 *
 * This replaced a `Tab` string union plus a TAB_LABELS map plus a TAB_PATHS map
 * — three declarations that had to be edited together, and the reason the strip
 * could not be shared with the four SectionHost pages, which key by route. One
 * list now carries the order, the labels and the destinations.
 *
 * Typed as NavItem because that is what RouteTabs takes, and it is the same
 * shape the "More" menu rows use. These three are NOT in navConfig's sections
 * (the menu lists this host once, as Lore, rather than listing every tab), so
 * unlike a SectionHost page the list is written here rather than derived.
 */
const TABS: readonly NavItem[] = [
  { to: '/lore', label: 'Lore' },
  { to: '/security', label: 'Security' },
  { to: '/faq', label: 'FAQ' },
];

const LorePage = lazy(() => import('./LorePage'));
const SecurityPage = lazy(() => import('./SecurityPage'));
const FAQPage = lazy(() => import('./FAQPage'));

function tabFromPath(pathname: string): string {
  if (pathname.startsWith('/security')) return '/security';
  if (pathname.startsWith('/faq')) return '/faq';
  // Lore is the landing tab, and the one /learn now aliases to.
  return '/lore';
}

export default function LearnPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // R007 Pattern A — derive `tab` directly from the URL.
  const tab = tabFromPath(location.pathname);

  const handleTab = (to: string) => {
    if (to === tab) return;
    navigate(to, { replace: false });
  };

  return (
    <>
      {/* Sticky tab bar below TopNav — components/layout/RouteTabs.tsx, the one
          the whole app shares. It carries the WAI-ARIA roving-focus wiring (T10 /
          F22) this file used to call `useTabListKeys` for directly, and the 44px
          phone touch floor (A11Y-R07) the hand-copied version here never had. */}
      <RouteTabs
        idPrefix="learn"
        ariaLabel="Learn sections"
        items={TABS}
        active={tab}
        onSelect={handleTab}
      />

      <div role="tabpanel" id="learn-panel" aria-labelledby={tabDomId('learn', tab)}>
        <Suspense fallback={<PageSkeleton />}>
          {tab === '/lore' && <LorePage />}
          {tab === '/security' && <SecurityPage />}
          {tab === '/faq' && <FAQPage />}
        </Suspense>
      </div>
    </>
  );
}
