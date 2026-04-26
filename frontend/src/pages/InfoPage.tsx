import { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';

type Tab = 'treasury' | 'contracts' | 'risks' | 'terms' | 'privacy';

const TAB_LABELS: Record<Tab, string> = {
  treasury: 'Treasury',
  contracts: 'Contracts',
  risks: 'Risks',
  terms: 'Terms',
  privacy: 'Privacy',
};

const TAB_PATHS: Record<Tab, string> = {
  treasury: '/treasury',
  contracts: '/contracts',
  risks: '/risks',
  terms: '/terms',
  privacy: '/privacy',
};

const TreasuryPage = lazy(() => import('./TreasuryPage'));
const ContractsPage = lazy(() => import('./ContractsPage'));
const RisksPage = lazy(() => import('./RisksPage'));
const TermsPage = lazy(() => import('./TermsPage'));
const PrivacyPage = lazy(() => import('./PrivacyPage'));

function tabFromPath(pathname: string): Tab {
  if (pathname.startsWith('/contracts')) return 'contracts';
  if (pathname.startsWith('/risks')) return 'risks';
  if (pathname.startsWith('/terms')) return 'terms';
  if (pathname.startsWith('/privacy')) return 'privacy';
  return 'treasury';
}

/// InfoPage — tabbed host for Treasury, Contracts, Risks, Terms, and Privacy.
/// URLs `/treasury`, `/contracts`, `/risks`, `/terms`, `/privacy` each land on
/// the matching tab so deep links keep working. Mirrors the LearnPage /
/// ActivityPage tab pattern.
export default function InfoPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // R007 Pattern A — derive `tab` directly from the URL.
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
            className="flex gap-1 md:gap-1.5 p-1 rounded-2xl"
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
                className="flex-1 px-2 md:px-4 py-2 min-h-[40px] rounded-xl text-[11.5px] md:text-[14px] font-medium text-white transition-all whitespace-nowrap"
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

      {/* Treasury and Contracts pages don't use the full-bleed -mt-14 pattern,
          so they need extra top padding to clear the sticky tab bar. */}
      <Suspense fallback={<PageSkeleton />}>
        {tab === 'treasury' && <div className="pt-14"><TreasuryPage /></div>}
        {tab === 'contracts' && <div className="pt-14"><ContractsPage /></div>}
        {tab === 'risks' && <RisksPage />}
        {tab === 'terms' && <TermsPage />}
        {tab === 'privacy' && <PrivacyPage />}
      </Suspense>
    </>
  );
}
