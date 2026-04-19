import { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PageSkeleton } from '../components/PageSkeleton';

type Tab = 'tokenomics' | 'lore' | 'security' | 'faq';

const TAB_LABELS: Record<Tab, string> = {
  tokenomics: 'Tokenomics',
  lore: 'Lore',
  security: 'Security',
  faq: 'FAQ',
};

const TAB_PATHS: Record<Tab, string> = {
  tokenomics: '/tokenomics',
  lore: '/lore',
  security: '/security',
  faq: '/faq',
};

const TokenomicsPage = lazy(() => import('./TokenomicsPage'));
const LorePage = lazy(() => import('./LorePage'));
const SecurityPage = lazy(() => import('./SecurityPage'));
const FAQPage = lazy(() => import('./FAQPage'));

function tabFromPath(pathname: string): Tab {
  if (pathname.startsWith('/lore')) return 'lore';
  if (pathname.startsWith('/security')) return 'security';
  if (pathname.startsWith('/faq')) return 'faq';
  return 'tokenomics';
}

export default function LearnPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(() => tabFromPath(location.pathname));

  useEffect(() => {
    const next = tabFromPath(location.pathname);
    setTab(next);
  }, [location.pathname]);

  const handleTab = (t: Tab) => {
    if (t === tab) return;
    setTab(t);
    navigate(TAB_PATHS[t], { replace: false });
  };

  return (
    <>
      {/* Sticky tab bar below TopNav. Sits above page hero content but below modals. */}
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
        {tab === 'tokenomics' && <TokenomicsPage />}
        {tab === 'lore' && <LorePage />}
        {tab === 'security' && <SecurityPage />}
        {tab === 'faq' && <FAQPage />}
      </Suspense>
    </>
  );
}
