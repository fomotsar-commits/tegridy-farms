import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { m } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { usePageTitle } from '../hooks/usePageTitle';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';
import { WrongChainBanner } from '../components/ui/WrongChainGuard';

import { GaugeVoting } from '../components/GaugeVoting';
import { GrantsSection } from '../components/community/GrantsSection';
import { BountiesSection } from '../components/community/BountiesSection';
import { VoteIncentivesSection } from '../components/community/VoteIncentivesSection';
import { ArtImg } from '../components/ArtImg';

type Section = 'grants' | 'bounties' | 'bribes' | 'gauges';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'grants', label: 'Governance' },
  { key: 'bounties', label: 'Bounties' },
  { key: 'bribes', label: 'Vote Incentives' },
  { key: 'gauges', label: 'Gauge Voting' },
];

const VALID_SECTIONS: Section[] = ['grants', 'bounties', 'bribes', 'gauges'];

// Mirror LendingPage's ?section= pattern so cross-page deep-links
// (Dashboard → /community?section=bribes, etc.) land on the right tab.
function sectionFromQuery(v: string | null): Section | null {
  if (!v) return null;
  return (VALID_SECTIONS as string[]).includes(v) ? (v as Section) : null;
}

export default function CommunityPage() {
  usePageTitle('Community', 'Governance, grants, bounties, and community initiatives.');
  const { isConnected } = useAccount();
  const [searchParams, setSearchParams] = useSearchParams();
  const [section, setSection] = useState<Section>(
    () => sectionFromQuery(searchParams.get('section')) ?? 'grants',
  );

  // Keep state in sync with ?section= so Back/Forward and deep-links behave.
  useEffect(() => {
    const fromQuery = sectionFromQuery(searchParams.get('section'));
    if (fromQuery && fromQuery !== section) setSection(fromQuery);
  }, [searchParams, section]);

  const handleSectionChange = (next: Section) => {
    setSection(next);
    const params = new URLSearchParams(searchParams);
    // Default section uses the bare URL; others set ?section= so it's shareable.
    if (next === 'grants') params.delete('section');
    else params.set('section', next);
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="community" idx={0} fallbackPosition="center 10%" alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-24 pb-16">
        {/* Header */}
        <m.div
          className="text-center mb-10"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl mb-2 tracking-tight">Community</h1>
          <p className="text-white max-w-md mx-auto text-[14px]">
            Governance, bounties, and vote incentives — powered by the community.
          </p>
        </m.div>

        {/* AUDIT BRIBES-UX: wrong-chain banner via the shared primitive.
            Replaces ~30 lines of inlined JSX + 3 hook imports. */}
        <WrongChainBanner
          className="mb-6"
          message="Community contracts (voting, bribing, claiming) live on the canonical chain. Your wallet is on a different network — writes will revert until you switch."
        />

        {/* Section Toggle — always visible so users can see what's available */}
        <m.div
          className="grid grid-cols-3 md:flex justify-center gap-1.5 mb-10 p-1 rounded-2xl mx-auto w-full md:w-fit"
          style={{ background: 'rgba(13,21,48,0.4)', border: '1px solid rgba(255,255,255,0.20)' }}
          role="tablist"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          {SECTIONS.map(({ key, label }) => (
            <button
              key={key}
              role="tab"
              aria-selected={section === key}
              className={`relative px-3 py-2 md:px-5 md:py-2.5 rounded-xl text-xs md:text-sm font-medium transition-all duration-300 ${
                section === key ? 'text-white' : 'text-white hover:text-white'
              }`}
              onClick={() => handleSectionChange(key)}
            >
              {section === key && (
                <m.div
                  layoutId="community-tab"
                  className="absolute inset-0 rounded-xl bg-emerald-600 shadow-lg shadow-emerald-600/20"
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                />
              )}
              <span className="relative z-10">{label}</span>
            </button>
          ))}
        </m.div>

        {!isConnected ? (
          <m.div
            className="max-w-md mx-auto rounded-2xl p-8 text-center relative overflow-hidden"
            style={{ border: '1px solid rgba(16,185,129,0.08)' }}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <div className="absolute inset-0">
              <ArtImg pageId="community" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(6,12,26,0.10) 0%, rgba(6,12,26,0.35) 100%)' }} />
            </div>
            <div className="relative z-10">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/30 border border-emerald-500/40 flex items-center justify-center mx-auto mb-4">
                <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-black" aria-hidden="true">
                  <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                </svg>
              </div>
              <p className="text-white mb-5 text-[14px]">Connect your wallet to participate</p>
              <ConnectButton />
            </div>
          </m.div>
        ) : (
          <m.div
            key={section}
            role="tabpanel"
            aria-label={`${SECTIONS.find(s => s.key === section)?.label} panel`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            <ErrorBoundary>
              <Suspense fallback={
                <div className="space-y-4 animate-pulse">
                  <div className="rounded-xl p-6" style={{ background: 'rgba(13,21,48,0.4)', border: '1px solid rgba(255,255,255,0.20)' }}>
                    <div className="h-5 rounded w-40 mb-4" style={{ background: 'rgba(255,255,255,0.08)' }} />
                    <div className="h-20 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }} />
                  </div>
                </div>
              }>
                {section === 'grants' && <GrantsSection />}
                {section === 'bounties' && <BountiesSection />}
                {section === 'bribes' && <VoteIncentivesSection />}
                {section === 'gauges' && <GaugeVoting />}
              </Suspense>
            </ErrorBoundary>
          </m.div>
        )}
      </div>
    </div>
  );
}
