// Polyfill MUST load before any @solana/* import — same rule as SolanaProviders.
import '../lib/solanaPolyfill';
import { lazy, Suspense, useEffect } from 'react';
import { m } from 'framer-motion';
import { Link, useSearchParams } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { useVenueStatus } from '../hooks/useVenueStatus';
import { trackPageView } from '../lib/analytics';
import { ArtImg } from '../components/ArtImg';
import { ChainSwitch } from '../components/swap/ChainSwitch';
import { VenueStatusCard } from '../components/solana/VenueStatusCard';
import { VenueProgramCard } from '../components/solana/VenueProgramCard';
import type { VenueStatus } from '../lib/solana/cpswap/read';
import { lpWriteMode, type LpWriteMode } from '../lib/launcher/solana/lpWriteFlag';
import {
  CREATOR_FEE_SWITCH,
  chargedCreatorFeeRate,
  feeSplit,
  solOf,
  tradeCost,
} from '../lib/solana/cpswap/venue';
import { withMint } from '../lib/solana/lp/mintLink';
import { feeRateText } from '../lib/solana/lp/format';

// The LP finder, positions and fee tiers. Lazy: it brings the Solana wallet stack, which
// only a live venue needs.
const SolanaLpSection = lazy(() => import('../components/solana/lp/SolanaLpSection'));

/**
 * The venue's own Solana liquidity pools — what they charge, what an LP keeps,
 * and exactly what state the venue is in.
 *
 * Every fee and every capability claim here hangs off `readVenue`, never a constant:
 * a pending or failed read shows no fee at all. `readVenue` follows a closed program's
 * stub to its ProgramData, because `getAccountInfo` alone reports a spent id as deployed.
 */
export default function PoolsPage() {
  usePageTitle(
    'Solana liquidity pools',
    'Provide liquidity on the venue’s own Solana AMM: what it charges, what LPs keep, and its live deployment status.',
  );
  useEffect(() => { trackPageView('pools'); }, []);

  // The same live read as /solana-lp; "Try again" uses `retry`, the card's Refresh `refresh`.
  const { status, refresh, retry } = useVenueStatus();

  // Fees come only from a config the chain returned. With none, the sheet shows no number.
  const liveConfig = status?.kind === 'live' ? status.config : null;
  const split = liveConfig ? feeSplit(liveConfig) : null;
  // The sheet is about the pools that graduate onto this tier, and the launch program
  // opens every one with its creator fee switched on: a trade there pays the trade fee
  // AND the tier's creator fee, so that sum is what "trader pays" must say.
  const cost = liveConfig ? tradeCost(liveConfig, chargedCreatorFeeRate(liveConfig, CREATOR_FEE_SWITCH.launchPool)) : null;
  const charged = cost !== null && cost.creatorFeeRate > 0n;

  // Every capability claim on this page hangs off the live probe. A spent program
  // id must never be described in the present tense, and "still reading" is not a
  // licence to assert either, so the conditional copy is the default and the
  // present-tense copy is what the probe has to earn.
  const venueIsOpen = liveConfig !== null;
  // "Anyone can open a pool" is a claim about the tier the probe read: cp-swap refuses
  // every new pool on a tier whose `disable_create_pool` is set.
  const tierTakesPools = liveConfig !== null && !liveConfig.disableCreatePool;
  // Fixed for the life of a build: a production build reads only the committed constant.
  const lpMode = lpWriteMode();
  // The token being looked at (?mint=) follows the reader to the Solana LP tab.
  const [params] = useSearchParams();

  return (
    <div className="relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="swap" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.86)' }} />
      </div>

      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-8 pb-16">
        <ChainSwitch />

        <m.div className="mb-6" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <p className="text-white/70 text-[11px] uppercase tracking-[0.2em] mb-2">Venue AMM · Solana</p>
          <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">
            Liquidity pools.
          </h1>
          <p className="text-white/85 text-[15px] max-w-xl leading-relaxed">
            {liveConfig ? (
              <>
                Our own constant-product AMM on Solana.{' '}
                {tierTakesPools
                  ? 'Anyone can open a pool or provide liquidity on chain'
                  : `Anyone can provide liquidity on chain (opening new pools on fee tier ${liveConfig.index} is switched off right now)`}
                , and the trade fee is split between the LPs who funded it and the venue.{' '}
                {HERO_LP_LINE[lpMode]}
              </>
            ) : (
              <>
                Our own constant-product AMM on Solana. No pool can be opened here yet. This
                page shows a fee only after reading it from the chain, and the card below says
                what the latest read found.
              </>
            )}
          </p>
          <p className="text-[13px] mt-2">
            {/* A finger-sized press area on a 19.5px line: 14px of padding above and below (47.5px).
                The negative margin takes 6px of each back, so the line keeps the 8px it always had. */}
            <Link to={withMint('/solana-lp', params)} className="inline-block py-3.5 -my-1.5 underline underline-offset-2 text-white hover:text-white/80">
              {venueIsOpen ? SOLANA_LP_LINK[lpMode] : SOLANA_LP_LINK_NOT_OPEN}
            </Link>
          </p>
        </m.div>

        <VenueStatusCard status={status} onRefresh={refresh} lpMode={lpMode} />

        {venueIsOpen && (
          <Suspense fallback={<p className="text-white/60 text-[13px] mt-6">Loading the pool finder…</p>}>
            <SolanaLpSection />
          </Suspense>
        )}

        {/* ── The fee sheet ───────────────────────────────────────────────── */}
        <section className="rounded-2xl p-6 mt-6" style={CARD} aria-label="Fee sheet">
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
            <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>
              {liveConfig
                ? `Fees · tier ${liveConfig.index}, graduated launch pools · read from the chain`
                : 'Fees · not read'}
            </p>
          </div>
          <h2 className="heading-luxury text-xl text-white mb-4">
            {split && cost
              ? `${feeRateText(cost.totalRate)} a trade, ${split.lpKeepsPct.toFixed(2)}% of it to you`
              : feesNotRead(status).title}
          </h2>

          {liveConfig && split && cost && (
            <div className={`grid grid-cols-2 gap-3 mb-4 ${charged ? 'sm:grid-cols-3 md:grid-cols-5' : 'sm:grid-cols-4'}`}>
              <Stat
                label="Trader pays"
                value={feeRateText(cost.totalRate)}
                sub={charged ? `${feeRateText(cost.tradeFeeRate)} trade fee + ${feeRateText(cost.creatorFeeRate)} creator fee` : 'of each trade'}
              />
              <Stat label="LPs keep" value={`${split.lpKeepsPct.toFixed(2)}%`} sub="of volume" tone="good" />
              <Stat label="Venue takes" value={`${split.venueTakesPct.toFixed(2)}%`} sub={`${split.venueShareOfFeePct}% of the trade fee`} />
              {charged && <Stat label="Creator gets" value={feeRateText(cost.creatorFeeRate)} sub="on top, to the token’s creator" />}
              <Stat
                label="Open a pool"
                value={`${solOf(liveConfig.createPoolFee)} SOL`}
                sub={`fee on tier ${liveConfig.index}; account deposits extra`}
              />
            </div>
          )}

          <p className="text-white/70 text-[13px] leading-relaxed">
            {liveConfig ? (
              <>
                These are the live <code className="font-mono text-white/85">AmmConfig</code> rates
                of fee tier {liveConfig.index}, where launches graduate, read from the chain when
                this page loads, not copied into it. Retuning them on chain changes this card
                without a deploy.{' '}
                {charged && (
                  <>
                    A launch pool charges the creator fee on top of the trade fee and pays it to the
                    token&rsquo;s creator: the launch program opens every launch pool with it switched
                    on. A pool opened on this tier any other way charges only the trade fee.{' '}
                  </>
                )}
                Pools opened from this site use the public fee tier instead; the fee tiers in the
                pools section below are read live for both.
              </>
            ) : (
              feesNotRead(status).line
            )}
          </p>
          {status?.kind === 'unreadable' && (
            <button type="button" onClick={retry} className="btn-secondary px-4 py-2 text-[12px] mt-3">
              Try again
            </button>
          )}
        </section>

        {/* ── How LPs earn ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
          <section className="rounded-2xl p-6" style={CARD}>
            <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>For liquidity providers</p>
            <h2 className="heading-luxury text-lg text-white mb-3">
              {venueIsOpen ? 'Deposit a pair, hold the LP token' : 'How it works: deposit a pair, hold the LP token'}
            </h2>
            {!venueIsOpen && (
              <p className="text-white/60 text-[12px] leading-relaxed mb-3">
                Depositing from this page waits on a live read of the venue. The status card
                above says what the latest read found.
              </p>
            )}
            <ul className="text-white/80 text-[13px] leading-relaxed space-y-2 list-disc pl-4">
              <li>Deposit both sides of a pair and the pool mints you an <strong>LP token</strong> for your share.</li>
              <li>Every trade adds its fee to the reserves, so your share is worth more each time the pool trades. There is nothing to claim.</li>
              <li>Withdraw any time — burning the LP token returns your share of both sides. Pools have no lock.</li>
              <li className="text-white/60">
                Impermanent loss is real: a constant-product pool rebalances against you when
                the price moves, and fees are what compensate for it. This page will never
                quote you an APY it cannot read.
              </li>
            </ul>
          </section>

          <section className="rounded-2xl p-6" style={CARD}>
            <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>How the swap routes</p>
            <h2 className="heading-luxury text-lg text-white mb-3">Our pools, side by side with Jupiter</h2>
            <p className="text-white/80 text-[13px] leading-relaxed mb-3">
              Every quote on the Solana swap also asks our own pools, and prints which one
              pays the trader more and by how much. The trade itself still goes through
              Jupiter: sending it to our pool when ours pays more is not switched on yet.
            </p>
            <Link to="/solana" className="btn-secondary px-4 py-2 text-[12px] inline-block">
              Go to the Solana swap
            </Link>
          </section>
        </div>

        <VenueProgramCard />
      </div>
    </div>
  );
}

const CARD = { background: 'rgba(4,9,18,0.90)', border: '1px solid var(--color-purple-25)' } as const;

// What this site itself can do with the pools follows LP's own switch
// (lib/launcher/solana/lpWriteFlag.ts), so flipping that one line changes these too.
// Whether the public fee tier exists, or takes new pools, is never said here: only the
// create card's live read of the tier says that.
const HERO_LP_LINE: Record<LpWriteMode, string> = {
  off: 'This site reads pools and shares; adding and removing liquidity from here is not switched on yet.',
  on: 'This site reads pools and shares, and below you can add liquidity to a pool whose checks pass, take yours out, or open a new pool on the public fee tier (the pools section says whether that can be done right now).',
  'withdraw-only': 'This site reads pools and shares. Adding liquidity and opening pools from here are paused; taking yours out still works.',
};
// The hero's door to the Solana LP tab says what that tab can do, by the same switch,
// and only once the venue reads live: until then the door claims nothing.
const SOLANA_LP_LINK: Record<LpWriteMode, string> = {
  off: 'Find a pool on the Solana LP tab',
  on: 'Add or remove liquidity on the Solana LP tab',
  'withdraw-only': 'Take your liquidity out on the Solana LP tab',
};
const SOLANA_LP_LINK_NOT_OPEN = 'Go to the Solana LP tab';

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <p className="text-[10px] uppercase tracking-wider text-white/60">{label}</p>
      <p className="stat-value text-xl leading-tight" style={{ color: tone === 'good' ? '#4ade80' : '#ffffff' }}>{value}</p>
      {sub && <p className="text-[10px] text-white/50">{sub}</p>}
    </div>
  );
}

/** The fee sheet with no config read: still reading, a failed read, or nothing to read. */
function feesNotRead(status: VenueStatus | null): { title: string; line: string } {
  if (status === null) {
    return { title: 'Reading the fee tiers from the chain…', line: 'No fee is shown until the chain answers.' };
  }
  if (status.kind === 'unreadable') {
    return {
      title: 'The fee tiers could not be read just now',
      line: 'The chain did not answer, so this page shows no fee rather than a guess.',
    };
  }
  return {
    title: 'No fee tier was read',
    line: 'This page shows a fee only from a tier it read on chain. The card above says why there is none to read.',
  };
}
