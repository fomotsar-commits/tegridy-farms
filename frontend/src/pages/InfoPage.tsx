import { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';
import { useTabListKeys } from '../hooks/useTabListKeys';

// 🔻 2026-09-04 — TREASURY LEFT THIS HOST. It is a tab on StatsPage now, beside
// Tokenomics and Tax Reports, because the "More" menu's own Stats section already
// grouped those three and a route can only render one tab bar (StatsPage.tsx
// spells out why there was no version of that change which left this file alone).
// What remains here is the legal + reference shelf. /treasury is unchanged as a
// URL and still linked from the Footer.
type Tab = 'contracts' | 'risks' | 'terms' | 'privacy';

const TAB_LABELS: Record<Tab, string> = {
  contracts: 'Contracts',
  risks: 'Risks',
  terms: 'Terms',
  privacy: 'Privacy',
};

// Derived, not re-listed: the tab bar and the keyboard helper must walk the same
// order, and a second literal is how those two drift.
const VISIBLE_TABS = Object.keys(TAB_LABELS) as Tab[];

const TAB_PATHS: Record<Tab, string> = {
  contracts: '/contracts',
  risks: '/risks',
  terms: '/terms',
  privacy: '/privacy',
};

const ContractsPage = lazy(() => import('./ContractsPage'));
const RisksPage = lazy(() => import('./RisksPage'));
const TermsPage = lazy(() => import('./TermsPage'));
const PrivacyPage = lazy(() => import('./PrivacyPage'));

function tabFromPath(pathname: string): Tab {
  if (pathname.startsWith('/risks')) return 'risks';
  if (pathname.startsWith('/terms')) return 'terms';
  if (pathname.startsWith('/privacy')) return 'privacy';
  // Contracts is the landing tab.
  return 'contracts';
}

/// InfoPage — tabbed host for Contracts, Risks, Terms, and Privacy.
/// URLs `/contracts`, `/risks`, `/terms`, `/privacy` each land on the matching
/// tab so deep links keep working. Mirrors the LearnPage / ActivityPage tab
/// pattern.
export default function InfoPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // R007 Pattern A — derive `tab` directly from the URL.
  const tab = tabFromPath(location.pathname);

  const handleTab = (t: Tab) => {
    if (t === tab) return;
    navigate(TAB_PATHS[t], { replace: false });
  };

  // These looked like tabs, were built as `aria-pressed` toggle buttons, and
  // carried no role, no aria-controls, no tabpanel and no roving focus — so the
  // site's legal and treasury navigation reached assistive tech as five
  // unlabelled toggles. ActivityPage next door already does all five correctly
  // for the same route-navigating tab pattern; this is that markup, verbatim.
  const tabKeys = useTabListKeys(VISIBLE_TABS, tab, handleTab);

  return (
    <>
      <div
        className="fixed left-0 right-0 z-30 px-4 md:px-6 pointer-events-none"
        style={{ top: 56 }}
      >
        <div className="max-w-[900px] mx-auto pt-3 pointer-events-auto">
          <div
            role="tablist"
            aria-label="Info sections"
            onKeyDown={tabKeys.onKeyDown}
            className="flex gap-1 md:gap-1.5 p-1 rounded-2xl overflow-x-auto no-scrollbar"
            style={{
              // F509: bumped 0.72 -> 0.92 so underlying H1s / footer links no
              // longer ghost through the translucent pill bar (matches BottomNav's
              // ~0.95). Blur retained for the frosted look.
              background: 'rgba(13,21,48,0.92)',
              border: '1px solid rgba(255,255,255,0.22)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
            }}
          >
            {VISIBLE_TABS.map((t) => (
              <button
                key={t}
                role="tab"
                id={`info-tab-${t}`}
                aria-selected={tab === t}
                aria-controls="info-panel"
                tabIndex={tabKeys.tabIndex(t)}
                ref={tabKeys.ref(t)}
                onClick={() => handleTab(t)}
                /* F402: min-w + overflow-x-auto on the row lets the 5 labels
                   scroll horizontally on very narrow phones (<380px) instead of
                   clipping, while flex-1 keeps the equal-width look on wider
                   screens. */
                className="flex-1 min-w-[64px] px-2 md:px-4 py-2 min-h-[40px] rounded-xl text-[11.5px] md:text-[14px] font-medium text-white transition-all whitespace-nowrap"
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

      {/* Contracts needs extra top padding to clear the sticky tab bar; the
          other three already carry their own. */}
      <div role="tabpanel" id="info-panel" aria-labelledby={`info-tab-${tab}`}>
        <Suspense fallback={<PageSkeleton />}>
          {tab === 'contracts' && <div className="pt-14"><ContractsPage /></div>}
          {tab === 'risks' && <RisksPage />}
          {tab === 'terms' && <TermsPage />}
          {tab === 'privacy' && <PrivacyPage />}
        </Suspense>
      </div>
    </>
  );
}
