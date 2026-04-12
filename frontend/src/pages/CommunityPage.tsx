import { useState, lazy, Suspense } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ART } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';

const GrantsPage = lazy(() => import('./GrantsPage'));
const BountyPage = lazy(() => import('./BountyPage'));
const BribesPage = lazy(() => import('./BribesPage'));

type Section = 'grants' | 'bounties' | 'bribes';

export default function CommunityPage() {
  usePageTitle('Community');
  const { isConnected } = useAccount();
  const [section, setSection] = useState<Section>('grants');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.danceNight.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 10%', opacity: 0.15 }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.88) 40%, rgba(0,0,0,0.96) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[1100px] mx-auto px-4 md:px-6 pt-24 pb-16">
        <motion.div className="text-center mb-8" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl mb-3">Community</h1>
          <p className="text-white/60 max-w-lg mx-auto">Governance, bounties, and vote incentives — powered by the community.</p>
        </motion.div>

        {!isConnected ? (
          <div className="glass-card p-8 rounded-2xl text-center max-w-md mx-auto">
            <p className="text-white/60 mb-4">Connect your wallet to participate</p>
            <ConnectButton />
          </div>
        ) : (
          <>
            {/* Section Toggle */}
            <div className="flex justify-center gap-2 mb-8">
              {([
                { key: 'grants' as Section, label: 'Governance' },
                { key: 'bounties' as Section, label: 'Bounties' },
                { key: 'bribes' as Section, label: 'Vote Incentives' },
              ]).map(({ key, label }) => (
                <button
                  key={key}
                  className={`px-6 py-3 rounded-xl text-sm font-semibold transition-all ${
                    section === key
                      ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20'
                      : 'glass-card text-white/60 hover:text-white'
                  }`}
                  onClick={() => setSection(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Section Content */}
            <motion.div key={section} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
              <Suspense fallback={<div className="text-center py-20 text-white/40 animate-pulse">Loading...</div>}>
                {section === 'grants' && <GrantsPage embedded />}
                {section === 'bounties' && <BountyPage embedded />}
                {section === 'bribes' && <BribesPage embedded />}
              </Suspense>
            </motion.div>
          </>
        )}
      </div>
    </div>
  );
}
