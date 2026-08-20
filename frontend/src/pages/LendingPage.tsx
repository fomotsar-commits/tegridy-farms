import { useState, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { useAccount } from 'wagmi';
import { pageArt, artStyle } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';
// Each NFT-Finance section is a large (50–120KB source) tab-gated surface and only ONE
// mounts at a time (see the tabpanel below). Lazy-loading them splits what was a single
// ~1.27MB page chunk into per-tab chunks: opening /nft-finance now pulls only the active
// tab (default: Token Lending); AMM / NFT-lending / Launchpad load on first tab-switch.
// The named exports are remapped to `default` so React.lazy can consume them.
const LendingSection = lazy(() =>
  import('../components/nftfinance/LendingSection').then((mod) => ({ default: mod.LendingSection })),
);
const AMMSection = lazy(() =>
  import('../components/nftfinance/AMMSection').then((mod) => ({ default: mod.AMMSection })),
);
const NFTLendingSection = lazy(() =>
  import('../components/nftfinance/NFTLendingSection').then((mod) => ({ default: mod.NFTLendingSection })),
);
const LaunchpadSection = lazy(() =>
  import('../components/nftfinance/LaunchpadSection').then((mod) => ({ default: mod.LaunchpadSection })),
);
// #61 / #62. Lazy for the same reason as the four above — these two surfaces
// are gated off (no contract is deployed) and must not cost the default tab a
// byte to say so.
const PooledLendingSection = lazy(() =>
  import('../components/nftfinance/PooledLendingSection').then((mod) => ({ default: mod.PooledLendingSection })),
);
const BnplSection = lazy(() =>
  import('../components/nftfinance/BnplSection').then((mod) => ({ default: mod.BnplSection })),
);
import { ArtImg } from '../components/ArtImg';
import { FeatureNotDeployed } from '../components/ui/FeatureNotDeployed';
import { PageSkeleton } from '../components/PageSkeleton';
import { ShieldPanel } from '../components/shield/ShieldPanel';
import {
  TEGRIDY_LENDING_ADDRESS,
  TEGRIDY_NFT_LENDING_ADDRESS,
  TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
  TEGRIDY_LAUNCHPAD_V2_ADDRESS,
  isDeployed,
} from '../lib/constants';
import { useTabListKeys } from '../hooks/useTabListKeys';
import { isPooledLendingLive, isBnplLive } from '../hooks/usePooledLendingConfig';

type Section = 'lending' | 'nftlending' | 'pooled' | 'bnpl' | 'amm' | 'launchpad';

const SECTIONS: { key: Section; label: string; subtitle?: string }[] = [
  { key: 'lending', label: 'Token Lending', subtitle: 'ETH loans + restake' },
  { key: 'nftlending', label: 'NFT Lending', subtitle: 'Generic NFTs' },
  { key: 'pooled', label: 'Pooled Lending', subtitle: 'Per-collection pools' },
  { key: 'bnpl', label: 'Pay in Instalments', subtitle: 'Deposit + 3 payments' },
  { key: 'amm', label: 'NFT AMM', subtitle: 'Bonding curves' },
  { key: 'launchpad', label: 'Launchpad' },
];

// Per-section wallet-gate copy. Without this, every disconnected tab rendered
// the identical generic ConnectPrompt, so switching tabs looked broken (the
// body never changed). Each section now reflects what that surface does.
const SECTION_PROMPTS: Record<Section, { title: string; description: string }> = {
  lending: {
    title: 'Connect to lend ETH against staking positions',
    description:
      'Lend ETH against staked-TOWELI position NFTs, borrow against your own staking NFT, or restake for bonus rewards. 1-hour grace period, no liquidation auctions — peer-to-peer.',
  },
  nftlending: {
    title: 'Connect to borrow against your NFTs',
    description:
      'Use JBAC, Nakamigos, or GNSS NFTs as collateral to borrow ETH. No oracles, peer-to-peer terms you set yourself.',
  },
  amm: {
    title: 'Connect to trade NFTs on bonding curves',
    description:
      'Buy and sell NFTs instantly against AMM pools, or provide liquidity to a collection and earn trading fees.',
  },
  pooled: {
    title: 'Pooled lending against one collection at a time',
    description:
      'Deposit WETH into a single collection’s pool and borrowers draw against it instantly. Isolated per collection, so a loss on one reaches only the depositors who chose it. No pool is deployed yet.',
  },
  bnpl: {
    title: 'Buy an NFT in instalments',
    description:
      'A deposit now, three payments after, and the token in escrow until the plan clears. Missing a payment costs you the token. The desk is not deployed yet.',
  },
  launchpad: {
    title: 'Connect to the NFT launchpad',
    description:
      'Launch ERC-721 collections with allowlists, dutch auctions, reveals and royalties — then seed a bonding-curve pool from the NFT AMM tab.',
  },
};

const INTRO_CARDS = [
  {
    key: 'lending' as Section,
    title: 'Token Lending',
    desc: 'Lend ETH against staking positions, borrow using your staked NFTs, and restake for bonus rewards.',
    icon: 'M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z',
    art: pageArt('nft-finance', 1),
  },
  {
    key: 'nftlending' as Section,
    title: 'NFT Lending',
    desc: 'Borrow ETH using your NFTs (JBAC, Nakamigos, GNSS) as collateral. No oracles needed.',
    icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    art: pageArt('nft-finance', 2),
  },
  {
    key: 'amm' as Section,
    title: 'NFT AMM',
    desc: 'Trade NFTs instantly via bonding curve pools. Provide liquidity and earn fees.',
    icon: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z',
    art: pageArt('nft-finance', 3),
  },
  {
    key: 'launchpad' as Section,
    title: 'Launchpad',
    desc: 'Launch ERC-721 collections with allowlists, dutch auctions, reveals and royalties — then seed a bonding-curve pool from the NFT AMM tab.',
    icon: 'M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z',
    art: pageArt('nft-finance', 4),
  },
];

const INTRO_DISMISSED_KEY = 'tegridy-nft-finance-intro-dismissed';

const VALID_SECTIONS: Section[] = ['lending', 'nftlending', 'pooled', 'bnpl', 'amm', 'launchpad'];

/**
 * The tab a bare /nft-finance lands on.
 *
 * NOT 'lending': Token Lending has no deployed contract (it renders a "will be
 * deployed soon" wall gated on a TWAP oracle that reverts). /nft-finance is a
 * primary nav destination, so defaulting to it meant the headline NFT-finance
 * surface opened on something you cannot use, while NFT Lending, NFT AMM and
 * Launchpad — all live — sat one click away. Pooled Lending and Pay in
 * Instalments are also undeployed and are also not candidates for the default
 * for the same reason.
 *
 * `handleSectionChange` clears ?section= for this value, so the two MUST agree;
 * changing one alone makes the tab for the other unreachable.
 */
const DEFAULT_SECTION: Section = 'nftlending';

// Per-section contract-deploy state, derived from constants.ts — never asserted.
//
// ⚠ This comment used to say "Every NFT-Finance contract is currently the zero
// address (ZEROED 2026-05-31)". That has been false since 2026-07-21: the NFT pool
// factory, NFT lending and LaunchpadV2 all carry real addresses and are un-gated.
// Three entries are 0x0 today and each is genuinely undeployed: Token Lending
// (TEGRIDY_LENDING_ADDRESS) waits on the TWAP oracle, whose reserve floor the
// drained native pool does not clear; Pooled Lending and Pay in Instalments
// (#61/#62) have had no deploy ceremony at all.
//
// This map drives the amber "Soon" chips on the tab row
// + intro cards so visitors can see which surfaces are gated before clicking in;
// each chip flips off automatically when a real address lands in constants.ts.
const SECTION_DEPLOYED: Record<Section, boolean> = {
  lending: isDeployed(TEGRIDY_LENDING_ADDRESS),
  nftlending: isDeployed(TEGRIDY_NFT_LENDING_ADDRESS),
  amm: isDeployed(TEGRIDY_NFT_POOL_FACTORY_ADDRESS),
  launchpad: isDeployed(TEGRIDY_LAUNCHPAD_V2_ADDRESS),
  // Both read from hooks/usePooledLendingConfig.ts, where every address is
  // still zero. The chip flips on its own when one stops being zero.
  pooled: isPooledLendingLive(),
  bnpl: isBnplLive(),
};

function sectionFromQuery(v: string | null): Section | null {
  if (!v) return null;
  return (VALID_SECTIONS as string[]).includes(v) ? (v as Section) : null;
}

export default function LendingPage() {
  usePageTitle('NFT Finance', 'NFT-backed lending, fractional AMM, and launchpad.');
  const { isConnected, address } = useAccount();
  const [searchParams, setSearchParams] = useSearchParams();
  // R007 Pattern A — derive `section` directly from ?section=. URL is the
  // source of truth, so deep-links resolve to the right tab without an effect.
  const section: Section = sectionFromQuery(searchParams.get('section')) ?? DEFAULT_SECTION;

  const handleSectionChange = (next: Section) => {
    const params = new URLSearchParams(searchParams);
    if (next === DEFAULT_SECTION) params.delete('section');
    else params.set('section', next);
    // F278: tab clicks use `replace` (not push), so Back/Forward step over tab
    // changes rather than walking through them — deep links still resolve, but
    // the tab history is intentionally replace-not-push.
    setSearchParams(params, { replace: true });
  };
  // T10 (F303): WAI-ARIA tabs roving-focus + arrow-key navigation.
  const tabKeys = useTabListKeys(VALID_SECTIONS, section, handleSectionChange);
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
        <ArtImg pageId="nft-finance" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-24 pb-16">
        {/* Header */}
        <m.div
          className="text-center mb-6"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* F306: the backdrop gallery art is dark in BOTH themes, but light-mode
              .heading-luxury turns the title dark navy (#1e1b4b) and it sinks into
              the painting. Force white + a dark scrim inline so it stays legible. */}
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl mb-2 tracking-tight" style={{ color: '#ffffff', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>NFT Finance</h1>
          <p className="text-white max-w-md mx-auto text-[14px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            Peer-to-peer NFT lending, an NFT AMM, and a launchpad — no oracles, terms you set yourself.
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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-2">
                {INTRO_CARDS.map((card, i) => (
                  <m.button
                    key={card.key}
                    onClick={() => handleSectionChange(card.key)}
                    aria-label={`Open ${card.title}`}
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
                      <img src={card.art.src} alt="" loading="lazy" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" style={artStyle(card.art)} />
                    </div>
                    <div className="relative z-10 p-4" style={{ background: 'rgba(6, 12, 26, 0.7)' }}>
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-lg bg-purple-500/15 border border-purple-500/20 flex items-center justify-center flex-shrink-0">
                        <svg className="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d={card.icon} />
                        </svg>
                      </div>
                      <div>
                        <h3 className="text-[13px] font-semibold text-white mb-1 flex items-center gap-1.5">
                          {card.title}
                          {SECTION_DEPLOYED[card.key] ? (
                            <span className="rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[8px] font-semibold leading-none px-1.5 py-0.5 uppercase tracking-wide">
                              Live
                            </span>
                          ) : (
                            <span className="rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[8px] font-semibold leading-none px-1.5 py-0.5 uppercase tracking-wide">
                              Soon
                            </span>
                          )}
                        </h3>
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
                  className="text-[12px] text-white/60 hover:text-white transition-colors px-3 py-1 rounded-full bg-black/40 border border-white/10"
                >
                  Dismiss overview
                </button>
              </div>
            </m.div>
          )}
        </AnimatePresence>

        {/* Section Toggle — horizontal scroll on mobile.
            F510: the chip row scrolls horizontally but `no-scrollbar` hides the
            scrollbar, so the 4th chip ("Launchpad") clipped mid-word with zero
            affordance at 390-414px. A right-edge fade mask (mobile only — the
            row is `md:w-fit` and never scrolls on desktop) signals there's more
            to scroll. Additive CSS, pointer-events untouched. */}
        <m.div
          className="flex overflow-x-auto gap-1.5 mb-10 p-1 rounded-2xl mx-auto w-full md:w-fit no-scrollbar snap-x snap-mandatory [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] md:[mask-image:none]"
          style={{ background: 'rgba(13,21,48,0.85)', border: '1px solid rgba(255,255,255,0.20)' }}
          role="tablist"
          aria-label="NFT Finance sections"
          onKeyDown={tabKeys.onKeyDown}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          {SECTIONS.map(({ key, label, subtitle }) => (
            <button
              key={key}
              role="tab"
              id={`nft-finance-tab-${key}`}
              aria-selected={section === key}
              aria-controls={`nft-finance-panel-${key}`}
              tabIndex={tabKeys.tabIndex(key)}
              ref={tabKeys.ref(key)}
              className={`relative px-3 py-2 md:px-5 md:py-2.5 rounded-xl text-xs md:text-sm font-medium transition-all duration-300 whitespace-nowrap snap-start flex-shrink-0 ${
                section === key
                  ? 'text-white'
                  : 'text-white/70 hover:text-white hover:bg-white/5'
              }`}
              onClick={() => handleSectionChange(key)}
            >
              {section === key && (
                <m.div
                  layoutId="nft-finance-tab"
                  className="absolute inset-0 rounded-xl bg-emerald-600 shadow-lg shadow-emerald-600/20"
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                />
              )}
              {/* F309: surface the section subtitle on desktop — "Staking + Restake"
                  under Token Lending is the only hint restaking lives here. */}
              <span className="relative z-10 flex flex-col items-center leading-tight">
                <span className="inline-flex items-center gap-1.5">
                  {label}
                  {SECTION_DEPLOYED[key] ? (
                    <span className="rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[9px] font-semibold leading-none px-1.5 py-0.5 uppercase tracking-wide">
                      Live
                    </span>
                  ) : (
                    <span className="rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px] font-semibold leading-none px-1.5 py-0.5 uppercase tracking-wide">
                      Soon
                    </span>
                  )}
                </span>
                {subtitle && (
                  <span className={`hidden md:block text-[10px] font-normal ${section === key ? 'text-white/80' : 'text-white/50'}`}>
                    {subtitle}
                  </span>
                )}
              </span>
            </button>
          ))}
        </m.div>

        {/* F299 / F300 / F313 (T7): the tabpanel always renders. Every section
            already shows its honest pre-deploy "being audited / not deployed"
            banner + StatsBar + HowItWorks + offer/pool/collection explorer using
            reads gated on `deployed` (no eth_call against zero addresses), and
            every write action (Lend/Borrow/Accept/Repay/Deploy) handles
            `!address` internally with its own connect affordance. So the honest
            status + read-only browsing is no longer hidden behind a generic
            connect-wall. For disconnected visitors we add a slim per-section
            intro banner above the panel; logged-in behaviour is unchanged. */}
        {!isConnected && (
          <m.div
            className="max-w-2xl mx-auto mb-6 rounded-xl px-4 py-3 text-center"
            style={{ background: 'rgba(6,12,26,0.72)', border: '1px solid rgba(245,228,184,0.12)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
          >
            <p className="text-white text-[13px] font-semibold mb-0.5">{SECTION_PROMPTS[section].title}</p>
            <p className="text-white/70 text-[12px] leading-relaxed">{SECTION_PROMPTS[section].description}</p>
          </m.div>
        )}

        <m.div
          key={section}
          role="tabpanel"
          id={`nft-finance-panel-${section}`}
          aria-labelledby={`nft-finance-tab-${section}`}
          tabIndex={0}
          className="outline-none"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Lazy sections resolve behind a Suspense fallback. React.lazy caches the
              resolved module, so only the FIRST visit to a tab shows the spinner —
              revisits render synchronously. */}
          <Suspense fallback={<PageSkeleton />}>
            {section === 'lending' && <LendingSection address={address} />}
            {section === 'nftlending' && (isDeployed(TEGRIDY_NFT_LENDING_ADDRESS)
              ? (
                <div className="space-y-6">
                  <NFTLendingSection />
                  {/* Above the fold of "My Loans" would be better; it sits here because
                      the shield reads the same loans and must not fork the read. */}
                  <ShieldPanel />
                </div>
              )
              : <FeatureNotDeployed pageId="nft-finance" idx={2} title="NFT lending isn't live yet" subtitle="Borrow against JBAC, Nakamigos, and GNSS once the NFT-lending contract is deployed for the relaunch." />)}
            {section === 'pooled' && <PooledLendingSection />}
            {section === 'bnpl' && <BnplSection />}
            {section === 'amm' && <AMMSection />}
            {section === 'launchpad' && <LaunchpadSection />}
          </Suspense>
        </m.div>
      </div>
    </div>
  );
}

