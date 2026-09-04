import { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';
import { useTabListKeys } from '../hooks/useTabListKeys';

// 🔻 2026-09-04 — TOKENOMICS LEFT THIS HOST. It is a tab on StatsPage now, beside
// Treasury and Tax Reports, because the "More" menu's own Stats section already
// grouped those three and a route can only render one tab bar (StatsPage.tsx
// spells out why there was no version of that change which left this file alone).
// What remains here is the narrative: the story, the security posture, the
// questions. /tokenomics is unchanged as a URL and still linked from the Footer.
type Tab = 'lore' | 'security' | 'faq';

const TAB_LABELS: Record<Tab, string> = {
  lore: 'Lore',
  security: 'Security',
  faq: 'FAQ',
};

const TAB_PATHS: Record<Tab, string> = {
  lore: '/lore',
  security: '/security',
  faq: '/faq',
};

const LorePage = lazy(() => import('./LorePage'));
const SecurityPage = lazy(() => import('./SecurityPage'));
const FAQPage = lazy(() => import('./FAQPage'));

function tabFromPath(pathname: string): Tab {
  if (pathname.startsWith('/security')) return 'security';
  if (pathname.startsWith('/faq')) return 'faq';
  // Lore is the landing tab, and the one /learn now aliases to.
  return 'lore';
}

export default function LearnPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // R007 Pattern A — derive `tab` directly from the URL.
  const tab = tabFromPath(location.pathname);

  const handleTab = (t: Tab) => {
    if (t === tab) return;
    navigate(TAB_PATHS[t], { replace: false });
  };

  // T10 (F22): WAI-ARIA tabs roving-focus + arrow-key navigation. Route-nav
  // tabs — "activate" navigates to the sub-page rendered in the tabpanel below.
  const TABS = Object.keys(TAB_LABELS) as Tab[];
  const tabKeys = useTabListKeys(TABS, tab, handleTab);

  return (
    <>
      {/* Sticky tab bar below TopNav. Sits above page hero content but below modals. */}
      <div
        className="fixed left-0 right-0 z-30 px-4 md:px-6 pointer-events-none"
        style={{ top: 56 }}
      >
        <div className="max-w-[900px] mx-auto pt-3 pointer-events-auto">
          <div
            role="tablist"
            aria-label="Learn sections"
            onKeyDown={tabKeys.onKeyDown}
            className="flex gap-1.5 p-1 rounded-2xl"
            style={{
              // F509: opacity bump 0.72 -> 0.92 (sibling of InfoPage) so page
              // H1s / footer links stop ghosting through the sticky pill bar.
              background: 'rgba(13,21,48,0.92)',
              border: '1px solid rgba(255,255,255,0.22)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
            }}
          >
            {TABS.map((t) => (
              <button
                key={t}
                role="tab"
                id={`learn-tab-${t}`}
                aria-selected={tab === t}
                aria-controls="learn-panel"
                tabIndex={tabKeys.tabIndex(t)}
                ref={tabKeys.ref(t)}
                onClick={() => handleTab(t)}
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

      <div role="tabpanel" id="learn-panel" aria-labelledby={`learn-tab-${tab}`}>
        <Suspense fallback={<PageSkeleton />}>
          {tab === 'lore' && <LorePage />}
          {tab === 'security' && <SecurityPage />}
          {tab === 'faq' && <FAQPage />}
        </Suspense>
      </div>
    </>
  );
}
