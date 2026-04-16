import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ART } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';

import { GaugeVoting } from '../components/GaugeVoting';

// Placeholder for consolidated pages (originals deleted in audit cleanup)
function SectionPlaceholder({ title }: { title: string }) {
  return (
    <div className="glass-card rounded-xl p-8 text-center">
      <h3 className="heading-luxury text-white text-lg mb-2">{title}</h3>
      <p className="text-white/60 text-[13px]">This section is being rebuilt as part of the V2 consolidation. Use Gauge Voting for active governance.</p>
    </div>
  );
}

type Section = 'grants' | 'bounties' | 'bribes' | 'gauges';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'grants', label: 'Governance' },
  { key: 'bounties', label: 'Bounties' },
  { key: 'bribes', label: 'Vote Incentives' },
  { key: 'gauges', label: 'Gauge Voting' },
];

export default function CommunityPage() {
  usePageTitle('Community', 'Governance, grants, bounties, and community initiatives.');
  const { isConnected } = useAccount();
  const [section, setSection] = useState<Section>('grants');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.danceNight.src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 10%' }} />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-24 pb-16">
        {/* Header */}
        <motion.div
          className="text-center mb-10"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl mb-2 tracking-tight">Community</h1>
          <p className="text-white max-w-md mx-auto text-[14px]">
            Governance, bounties, and vote incentives — powered by the community.
          </p>
        </motion.div>

        {/* Section Toggle — always visible so users can see what's available */}
        <motion.div
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
              onClick={() => setSection(key)}
            >
              {section === key && (
                <motion.div
                  layoutId="community-tab"
                  className="absolute inset-0 rounded-xl bg-emerald-600 shadow-lg shadow-emerald-600/20"
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                />
              )}
              <span className="relative z-10">{label}</span>
            </button>
          ))}
        </motion.div>

        {!isConnected ? (
          <motion.div
            className="max-w-md mx-auto rounded-2xl p-8 text-center relative overflow-hidden"
            style={{ border: '1px solid rgba(16,185,129,0.08)' }}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <div className="absolute inset-0">
              <img src={ART.busCrew.src} alt="" loading="lazy" className="w-full h-full object-cover" />
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
          </motion.div>
        ) : (
          <motion.div
            key={section}
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
                {section === 'grants' && <SectionPlaceholder title="Governance Grants" />}
                {section === 'bounties' && <SectionPlaceholder title="Meme Bounties" />}
                {section === 'bribes' && <SectionPlaceholder title="Vote Incentives" />}
                {section === 'gauges' && <GaugeVoting />}
            </ErrorBoundary>
          </motion.div>
        )}
      </div>
    </div>
  );
}
