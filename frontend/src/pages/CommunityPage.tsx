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
import { COMMUNITY_GRANTS_ADDRESS, MEME_BOUNTY_BOARD_ADDRESS, VOTE_INCENTIVES_ADDRESS, GAUGE_CONTROLLER_ADDRESS, isDeployed } from '../lib/constants';
import { COMMUNITY_TAB_INTRO } from '../lib/copy';
import { useTabListKeys } from '../hooks/useTabListKeys';

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

        {/* Live now — lead with what actually works. The on-chain governance / bounty /
            vote-incentive tabs below are pre-relaunch, so instead of opening on a wall of
            "isn't live yet" this surfaces the community surfaces that ARE live. */}
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
              <div className="text-white/60 text-xs mt-1 leading-relaxed">Live chat, P2P trades, and whale intel over in Tradermigos.</div>
            </Link>
            <Link to="/gallery" className="group rounded-xl p-4 transition-colors hover:border-emerald-500/40" style={{ background: 'rgba(13,21,48,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}>
              <div className="text-white font-semibold text-sm group-hover:text-emerald-300 transition-colors">Gallery →</div>
              <div className="text-white/60 text-xs mt-1 leading-relaxed">Browse the full Tegridy art collection.</div>
            </Link>
          </div>
          <p className="text-center text-white/40 text-[11px] mt-7 font-mono uppercase tracking-[0.14em]">On-chain governance · coming with the relaunch</p>
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
            the honest pre-deploy "isn't live yet" status are no longer hidden
            behind a generic connect-wall. Each section's write buttons already
            guard on `address`/chain; for logged-out visitors we add a per-tab
            one-liner (what it is + what connecting unlocks) and a single inline
            Connect CTA below the panel. Logged-in behaviour is unchanged. */}
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
              {section === 'grants' && (isDeployed(COMMUNITY_GRANTS_ADDRESS)
                ? <GrantsSection />
                : <FeatureNotDeployed pageId="community" idx={1} title="Community governance isn't live yet" subtitle="On-chain grants and proposals open once the governance contract is deployed for the relaunch." />)}
              {section === 'bounties' && (isDeployed(MEME_BOUNTY_BOARD_ADDRESS)
                ? <BountiesSection />
                : <FeatureNotDeployed pageId="community" idx={2} title="The bounty board isn't live yet" subtitle="Meme bounties open once the bounty contract is deployed for the relaunch." />)}
              {section === 'bribes' && (isDeployed(VOTE_INCENTIVES_ADDRESS)
                ? <VoteIncentivesSection />
                : <FeatureNotDeployed pageId="community" idx={3} title="Vote incentives aren't live yet" subtitle="Cartman's Market opens once the vote-incentives contract is deployed for the relaunch." />)}
              {section === 'gauges' && (isDeployed(GAUGE_CONTROLLER_ADDRESS)
                ? <GaugeVoting />
                : <FeatureNotDeployed pageId="community" idx={4} title="Gauge voting isn't live yet" subtitle="Vote on gauge emissions once the gauge controller is deployed for the relaunch." />)}
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
