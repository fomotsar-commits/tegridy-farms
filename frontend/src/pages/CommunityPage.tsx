import { Suspense, lazy } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { usePageTitle } from '../hooks/usePageTitle';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';
import { WrongChainBanner } from '../components/ui/WrongChainGuard';

// F337 (T11): lazy-load the section components so the <Suspense> fallback below
// is live code (it was dead before — static imports never suspend) and each
// section is code-split. Named exports are mapped to default for React.lazy.
const GaugeVoting = lazy(() => import('../components/GaugeVoting').then((m) => ({ default: m.GaugeVoting })));
const GrantsSection = lazy(() => import('../components/community/GrantsSection').then((m) => ({ default: m.GrantsSection })));
const BountiesSection = lazy(() => import('../components/community/BountiesSection').then((m) => ({ default: m.BountiesSection })));
const VoteIncentivesSection = lazy(() => import('../components/community/VoteIncentivesSection').then((m) => ({ default: m.VoteIncentivesSection })));
import { ArtImg } from '../components/ArtImg';
import { FeatureNotDeployed } from '../components/ui/FeatureNotDeployed';
import { COMMUNITY_GRANTS_ADDRESS, MEME_BOUNTY_BOARD_ADDRESS, VOTE_INCENTIVES_ADDRESS, GAUGE_CONTROLLER_ADDRESS, isDeployed, CHAIN_ID } from '../lib/constants';
import { getAddressUrl } from '../lib/explorer';
import { COMMUNITY_TAB_INTRO } from '../lib/copy';
import { useTabListKeys } from '../hooks/useTabListKeys';

/**
 * 🔄 2026-08-12 — CLAIM CORRECTION.
 *
 * This page used to tell every visitor that governance, bounties, vote
 * incentives and gauge voting "aren't live yet" and were "coming with the
 * relaunch". That was false. All four contracts are DEPLOYED, UNPAUSED and
 * carrying non-empty bytecode on Ethereum mainnet — verified by live
 * `eth_getCode` / `paused()` reads on 2026-08-12. What is actually missing is
 * the FRONTEND WIRING: their entries in `constants.ts` are still
 * `0x0000…0000`, and `isDeployed()` reads that zero as "no contract". The zero
 * is a UI gate, not a deployment fact.
 *
 * So the honest statement is "deployed on mainnet, not yet enabled here", and
 * that is what the placeholders below now say. The addresses live here rather
 * than in constants.ts on purpose: constants.ts is the switch that turns the
 * real sections on, and putting a real address there would light up write UI
 * that has not been QA'd against these deployments yet. This block is only
 * ever read while the corresponding constants.ts entry is still zero — the
 * moment it is wired, `isDeployed()` flips and the live section renders
 * instead of the note.
 *
 * NEVER record a truncated address here. Full 20-byte checksummed values only.
 */
const DEPLOYED_NOT_WIRED: Record<Section, { label: string; address: string }> = {
  grants:   { label: 'CommunityGrants', address: '0xeBC3aaf48297b8ccFa8272D9E68c1545eb9CD471' },
  bounties: { label: 'MemeBountyBoard', address: '0x6D2C6EC29D97fe8b6D1471091DEEE36baf69d890' },
  bribes:   { label: 'VoteIncentives',  address: '0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF' },
  gauges:   { label: 'GaugeController', address: '0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054' },
};

type Section = 'grants' | 'bounties' | 'bribes' | 'gauges';

/**
 * The receipt under each placeholder: the contract this tab talks to, its real
 * mainnet address, and a link so the claim "it is deployed" can be checked in
 * one click rather than taken on faith. `extra` carries any per-tab caveat that
 * is ALSO true and would otherwise be glossed over by "it's deployed".
 */
function DeployedOnChainNote({ section, extra }: { section: Section; extra?: string }) {
  const { label, address } = DEPLOYED_NOT_WIRED[section];
  return (
    <p className="text-white/55 text-[11px] leading-relaxed mt-3 text-center max-w-md mx-auto">
      <span className="text-white/70">{label}</span> is deployed and unpaused on Ethereum mainnet at{' '}
      <a
        href={getAddressUrl(CHAIN_ID, address)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-white/80 underline underline-offset-2 hover:text-white break-all"
      >
        {address}
      </a>
      {' '}↗ — this app just hasn&apos;t been pointed at it yet.
      {extra ? <> {extra}</> : null}
    </p>
  );
}

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
  // R007 Pattern A — derive `section` directly from ?section=. The URL is
  // the source of truth, so deep-links and Back/Forward stay correct without
  // a sync effect.
  const section: Section = sectionFromQuery(searchParams.get('section')) ?? 'grants';

  const handleSectionChange = (next: Section) => {
    const params = new URLSearchParams(searchParams);
    // Default section uses the bare URL; others set ?section= so it's shareable.
    if (next === 'grants') params.delete('section');
    else params.set('section', next);
    setSearchParams(params, { replace: true });
  };

  // T10 (F332): WAI-ARIA tabs roving-focus + arrow-key navigation.
  const tabKeys = useTabListKeys(VALID_SECTIONS, section, handleSectionChange);

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

        {/* Live now — lead with what actually works in THIS APP. The four on-chain
            governance / bounty / vote-incentive tabs below are all deployed on mainnet
            (see DEPLOYED_NOT_WIRED above) but not yet wired into the frontend, so this
            strip surfaces the community surfaces you can use right now without making
            the deployed-but-unwired ones sound non-existent. */}
        <m.div
          className="mb-8"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.4 }}
        >
          <div className="flex items-center justify-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 8px rgba(52,211,153,0.85)' }} />
            <span className="text-white/80 text-[11px] font-mono uppercase tracking-[0.14em]">Live now</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-3xl mx-auto">
            <Link to="/leaderboard" className="group rounded-xl p-4 transition-colors hover:border-emerald-500/40" style={{ background: 'rgba(13,21,48,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}>
              <div className="text-white font-semibold text-sm group-hover:text-emerald-300 transition-colors">Tegridy Score →</div>
              <div className="text-white/60 text-xs mt-1 leading-relaxed">On-chain reputation from your real activity — staking, LP, lock duration.</div>
            </Link>
            <Link to="/nakamigos" className="group rounded-xl p-4 transition-colors hover:border-emerald-500/40" style={{ background: 'rgba(13,21,48,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}>
              <div className="text-white font-semibold text-sm group-hover:text-emerald-300 transition-colors">Community chat →</div>
              <div className="text-white/60 text-xs mt-1 leading-relaxed">Live chat, P2P trades, and whale intel over in the Marketplace.</div>
            </Link>
            <Link to="/gallery" className="group rounded-xl p-4 transition-colors hover:border-emerald-500/40" style={{ background: 'rgba(13,21,48,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}>
              <div className="text-white font-semibold text-sm group-hover:text-emerald-300 transition-colors">Gallery →</div>
              <div className="text-white/60 text-xs mt-1 leading-relaxed">Browse the full art collection.</div>
            </Link>
          </div>
          {/* 🔄 2026-08-12: was "On-chain governance · coming with the relaunch",
              which read as "the contracts don't exist". They do — all four are
              deployed and unpaused on mainnet. What is pending is this app's
              wiring to them. */}
          <p className="text-center text-white/40 text-[11px] mt-7 font-mono uppercase tracking-[0.14em]">On-chain governance · deployed on mainnet · not yet enabled here</p>
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
          onKeyDown={tabKeys.onKeyDown}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          {SECTIONS.map(({ key, label }) => (
            <button
              key={key}
              role="tab"
              id={`community-tab-${key}`}
              aria-selected={section === key}
              aria-controls={`community-panel-${key}`}
              tabIndex={tabKeys.tabIndex(key)}
              ref={tabKeys.ref(key)}
              className={`relative px-3 py-2 md:px-5 md:py-2.5 rounded-xl text-xs md:text-sm font-medium transition-all duration-300 ${
                section === key ? 'text-white' : 'text-white/60 hover:text-white'
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

        {/* F322 / F356 / F357 (T7): the tabpanel always renders — public contract
            reads (proposals, bounty list, gauge weights, bribe leaderboard) and
            the deployment status are no longer hidden behind a generic
            connect-wall. Each section's write buttons already guard on
            `address`/chain; for logged-out visitors we add a per-tab one-liner
            and a single inline Connect CTA below the panel. Logged-in behaviour
            is unchanged.
            ⚠ 2026-08-12: this comment used to call the status an "honest
            pre-deploy 'isn't live yet'" state. It was neither pre-deploy nor
            honest — all four contracts have been live and unpaused on mainnet
            since 2026-07-16. The copy below now says deployed-but-not-wired, and
            the per-tab one-liners in copy.ts no longer promise that connecting
            is the missing step. */}
        {!isConnected && (
          <m.div
            className="max-w-2xl mx-auto mb-6 text-center"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
          >
            <p className="text-white/75 text-[13px] leading-relaxed">{COMMUNITY_TAB_INTRO[section]}</p>
          </m.div>
        )}

        <m.div
          key={section}
          role="tabpanel"
          id={`community-panel-${section}`}
          aria-labelledby={`community-tab-${section}`}
          tabIndex={0}
          className="outline-none"
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
              {/* 🔄 2026-08-12 — the four placeholders below used to read
                  "isn't live yet … once the contract is deployed for the
                  relaunch". Every one of those contracts was already deployed
                  and unpaused on mainnet. Corrected to the true claim: the
                  contracts exist, this app is not wired to them yet. The
                  sections themselves are untouched — only the claim changed. */}
              {section === 'grants' && (isDeployed(COMMUNITY_GRANTS_ADDRESS)
                ? <GrantsSection />
                : <>
                    <FeatureNotDeployed pageId="community" idx={1} title="Community governance is deployed — not yet enabled here" subtitle="The CommunityGrants contract is live on Ethereum mainnet, with no proposals submitted so far. On-chain grants and proposals open in this app once its address is wired into the frontend." />
                    <DeployedOnChainNote section="grants" />
                  </>)}
              {section === 'bounties' && (isDeployed(MEME_BOUNTY_BOARD_ADDRESS)
                ? <BountiesSection />
                : <>
                    <FeatureNotDeployed pageId="community" idx={2} title="The bounty board is deployed — not yet enabled here" subtitle="The MemeBountyBoard contract is live on Ethereum mainnet with zero bounties posted so far. Meme bounties open in this app once its address is wired into the frontend." />
                    <DeployedOnChainNote section="bounties" />
                  </>)}
              {section === 'bribes' && (isDeployed(VOTE_INCENTIVES_ADDRESS)
                ? <VoteIncentivesSection />
                : <>
                    <FeatureNotDeployed pageId="community" idx={3} title="Vote incentives are deployed — not yet enabled here" subtitle="The VoteIncentives contract is live on Ethereum mainnet. Cartman's Market opens in this app once its address is wired into the frontend." />
                    {/* The gaugeController() caveat is real and load-bearing: bribes are
                        paid against gauge weights, and VoteIncentives has not been told
                        which GaugeController to read. Verified on-chain 2026-08-12. */}
                    <DeployedOnChainNote section="bribes" extra="It is also not yet pointed at a gauge controller on-chain, so bribe accounting has nothing to settle against until an operator calls setGaugeController — a one-shot call." />
                  </>)}
              {section === 'gauges' && (isDeployed(GAUGE_CONTROLLER_ADDRESS)
                ? <GaugeVoting />
                : <>
                    <FeatureNotDeployed pageId="community" idx={4} title="Gauge voting is deployed — not yet enabled here" subtitle="The GaugeController contract is live on Ethereum mainnet with no gauges registered so far. Voting on gauge emissions opens in this app once its address is wired into the frontend." />
                    <DeployedOnChainNote section="gauges" />
                  </>)}
            </Suspense>
          </ErrorBoundary>
        </m.div>

        {!isConnected && (
          <m.div
            className="max-w-md mx-auto mt-8 rounded-2xl p-6 text-center relative overflow-hidden"
            style={{ border: '1px solid rgba(16,185,129,0.08)' }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
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
        )}
      </div>
    </div>
  );
}
