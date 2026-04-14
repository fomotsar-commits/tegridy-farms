import { useState, lazy, Suspense } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ART } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';
import { LendingSection } from '../components/nftfinance/LendingSection';
import { AMMSection } from '../components/nftfinance/AMMSection';
import { NFTLendingSection } from '../components/nftfinance/NFTLendingSection';

const LaunchpadPage = lazy(() => import('./LaunchpadPage'));
const RestakePage = lazy(() => import('./RestakePage'));

type Section = 'lending' | 'nftlending' | 'amm' | 'launchpad' | 'restake';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'lending', label: 'P2P Lending' },
  { key: 'nftlending', label: 'NFT Lending' },
  { key: 'amm', label: 'NFT AMM' },
  { key: 'launchpad', label: 'Launchpad' },
  { key: 'restake', label: 'Restake' },
];

export default function LendingPage() {
  usePageTitle('NFT Finance');
  const { isConnected, address } = useAccount();
  const [section, setSection] = useState<Section>('lending');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.forestScene.src} alt="" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-24 pb-16">
        {/* Header */}
        <motion.div
          className="text-center mb-10"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl mb-2 tracking-tight">NFT Finance</h1>
          <p className="text-white max-w-md mx-auto text-[14px]">
            Lend, borrow, and trade NFTs — institutional-grade tools, all in one place.
          </p>
        </motion.div>

        {/* Section Toggle — always visible so users can see what's available */}
        <motion.div
          className="grid grid-cols-3 sm:grid-cols-5 md:flex justify-center gap-1.5 mb-10 p-1 rounded-2xl mx-auto w-full md:w-fit"
          style={{ background: 'rgba(13,21,48,0.4)', border: '1px solid rgba(255,255,255,0.20)' }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          {SECTIONS.map(({ key, label }) => (
            <button
              key={key}
              className={`relative px-3 py-2 md:px-5 md:py-2.5 rounded-xl text-xs md:text-sm font-medium transition-all duration-300 ${
                section === key
                  ? 'text-white'
                  : 'text-white hover:text-white'
              }`}
              onClick={() => setSection(key)}
            >
              {section === key && (
                <motion.div
                  layoutId="nft-finance-tab"
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
            className="max-w-md mx-auto rounded-2xl p-8 text-center"
            style={{
              border: '1px solid rgba(16,185,129,0.08)',
              backdropFilter: 'blur(20px)',
            }}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <div className="w-12 h-12 rounded-xl bg-emerald-500/30 border border-emerald-500/40 flex items-center justify-center mx-auto mb-4">
              <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-black">
                <path d="M12 2v10l4.5 2.6M12 12L7.5 14.6M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-white mb-5 text-[14px]">Connect your wallet to access NFT Finance</p>
            <ConnectButton />
          </motion.div>
        ) : (
          <motion.div
            key={section}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            {section === 'lending' && <LendingSection address={address} />}
            {section === 'nftlending' && <NFTLendingSection />}
            {section === 'amm' && <AMMSection />}
            {section === 'launchpad' && (
              <Suspense fallback={<SectionLoader />}>
                <LaunchpadPage embedded />
              </Suspense>
            )}
            {section === 'restake' && (
              <Suspense fallback={<SectionLoader />}>
                <RestakePage embedded />
              </Suspense>
            )}
          </motion.div>
        )}
      </div>
    </div>
  );
}

function SectionLoader() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map(i => (
          <div key={i} className="rounded-xl p-5" style={{ background: 'rgba(13,21,48,0.4)', border: '1px solid rgba(255,255,255,0.20)' }}>
            <div className="h-3 rounded w-16 mx-auto mb-2" style={{ background: 'rgba(255,255,255,0.25)' }} />
            <div className="h-7 rounded w-14 mx-auto" style={{ background: 'rgba(255,255,255,0.08)' }} />
          </div>
        ))}
      </div>
      <div className="rounded-2xl p-6" style={{ background: 'rgba(13,21,48,0.4)', border: '1px solid rgba(255,255,255,0.20)' }}>
        <div className="h-5 rounded w-40 mb-6" style={{ background: 'rgba(255,255,255,0.08)' }} />
        <div className="space-y-4">
          <div className="h-12 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }} />
          <div className="grid grid-cols-2 gap-4">
            <div className="h-12 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }} />
            <div className="h-12 rounded-lg" style={{ background: 'rgba(255,255,255,0.04)' }} />
          </div>
          <div className="h-14 rounded-xl" style={{ background: 'rgba(255,255,255,0.04)' }} />
        </div>
      </div>
    </div>
  );
}
