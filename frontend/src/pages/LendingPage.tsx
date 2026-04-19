import { useState } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useAccount } from 'wagmi';
import { pageArt } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';
import { LendingSection } from '../components/nftfinance/LendingSection';
import { AMMSection } from '../components/nftfinance/AMMSection';
import { NFTLendingSection } from '../components/nftfinance/NFTLendingSection';
import { LaunchpadSection } from '../components/nftfinance/LaunchpadSection';
import { ConnectPrompt } from '../components/ui/ConnectPrompt';

type Section = 'lending' | 'nftlending' | 'amm' | 'launchpad';

const SECTIONS: { key: Section; label: string; subtitle?: string }[] = [
  { key: 'lending', label: 'Token Lending', subtitle: 'Staking + Restake' },
  { key: 'nftlending', label: 'NFT Lending', subtitle: 'Generic NFTs' },
  { key: 'amm', label: 'NFT AMM', subtitle: 'Bonding curves' },
  { key: 'launchpad', label: 'Launchpad' },
];

const INTRO_CARDS = [
  {
    key: 'lending' as Section,
    title: 'Token Lending',
    desc: 'Lend ETH against staking positions, borrow using your staked NFTs, and restake for bonus rewards.',
    icon: 'M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z',
    art: pageArt('nft-finance', 1).src,
  },
  {
    key: 'nftlending' as Section,
    title: 'NFT Lending',
    desc: 'Borrow ETH using your NFTs (JBAC, Nakamigos, GNSS) as collateral. No oracles needed.',
    icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    art: pageArt('nft-finance', 2).src,
  },
  {
    key: 'amm' as Section,
    title: 'NFT AMM',
    desc: 'Trade NFTs instantly via bonding curve pools. Provide liquidity and earn fees.',
    icon: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z',
    art: pageArt('nft-finance', 3).src,
  },
];

const INTRO_DISMISSED_KEY = 'tegridy-nft-finance-intro-dismissed';

export default function LendingPage() {
  usePageTitle('NFT Finance', 'NFT-backed lending, fractional AMM, and launchpad.');
  const { isConnected, address } = useAccount();
  const [section, setSection] = useState<Section>('lending');
  const [introDismissed, setIntroDismissed] = useState(() => {
    try { return localStorage.getItem(INTRO_DISMISSED_KEY) === '1'; } catch { return false; }
  });

  const dismissIntro = () => {
    setIntroDismissed(true);
    try { localStorage.setItem(INTRO_DISMISSED_KEY, '1'); } catch { /* noop */ }
  };

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={pageArt('nft-finance', 0).src} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-24 pb-16">
        {/* Header */}
        <m.div
          className="text-center mb-6"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl mb-2 tracking-tight">NFT Finance</h1>
          <p className="text-white max-w-md mx-auto text-[14px]">
            Lend, borrow, and trade NFTs — institutional-grade tools, all in one place.
          </p>
        </m.div>

        {/* Intro Overview Cards — dismissible */}
        <AnimatePresence>
          {!introDismissed && (
            <m.div
              className="mb-6"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-2">
                {INTRO_CARDS.map((card, i) => (
                  <m.button
                    key={card.key}
                    onClick={() => setSection(card.key)}
                    className={`relative text-left rounded-xl transition-all duration-300 group overflow-hidden ${
                      section === card.key ? 'ring-1 ring-emerald-500/40' : ''
                    }`}
                    style={{
                      border: `1px solid ${section === card.key ? 'rgba(16, 185, 129, 0.2)' : 'var(--color-purple-12)'}`,
                    }}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05, duration: 0.3 }}
                  >
                    <div className="absolute inset-0">
                      <img src={card.art} alt="" loading="lazy" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                    </div>
                    <div className="relative z-10 p-4" style={{ background: 'rgba(6, 12, 26, 0.7)' }}>
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-lg bg-purple-500/15 border border-purple-500/20 flex items-center justify-center flex-shrink-0">
                        <svg className="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d={card.icon} />
                        </svg>
                      </div>
                      <div>
                        <h3 className="text-[13px] font-semibold text-white mb-1">{card.title}</h3>
                        <p className="text-[11px] text-white/70 leading-relaxed">{card.desc}</p>
                      </div>
                    </div>
                    </div>
                  </m.button>
                ))}
              </div>
              <div className="flex justify-center">
                <button
                  onClick={dismissIntro}
                  className="text-[10px] text-white/30 hover:text-white/70 transition-colors"
                >
                  Dismiss overview
                </button>
              </div>
            </m.div>
          )}
        </AnimatePresence>

        {/* Section Toggle — horizontal scroll on mobile */}
        <m.div
          className="flex overflow-x-auto gap-1.5 mb-10 p-1 rounded-2xl mx-auto w-full md:w-fit no-scrollbar snap-x snap-mandatory"
          style={{ background: 'rgba(13,21,48,0.4)', border: '1px solid rgba(255,255,255,0.20)' }}
          role="tablist"
          aria-label="NFT Finance sections"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          {SECTIONS.map(({ key, label }) => (
            <button
              key={key}
              role="tab"
              aria-selected={section === key}
              aria-controls={`nft-finance-panel-${key}`}
              className={`relative px-3 py-2 md:px-5 md:py-2.5 rounded-xl text-xs md:text-sm font-medium transition-all duration-300 whitespace-nowrap snap-start flex-shrink-0 ${
                section === key
                  ? 'text-white'
                  : 'text-white hover:text-white'
              }`}
              onClick={() => setSection(key)}
            >
              {section === key && (
                <m.div
                  layoutId="nft-finance-tab"
                  className="absolute inset-0 rounded-xl bg-emerald-600 shadow-lg shadow-emerald-600/20"
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                />
              )}
              <span className="relative z-10">{label}</span>
            </button>
          ))}
        </m.div>

        {!isConnected ? (
          <ConnectPrompt surface="lending" />
        ) : (
          <m.div
            key={section}
            role="tabpanel"
            id={`nft-finance-panel-${section}`}
            aria-label={`${SECTIONS.find(s => s.key === section)?.label} panel`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            {section === 'lending' && <LendingSection address={address} />}
            {section === 'nftlending' && <NFTLendingSection />}
            {section === 'amm' && <AMMSection />}
            {section === 'launchpad' && <LaunchpadSection />}
          </m.div>
        )}
      </div>
    </div>
  );
}

