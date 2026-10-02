import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import type { Bungalow } from '../../lib/bungalows';
import { bungalowExplorerUrl, bungalowScanRoute, bungalowTradeRoute, stakePoolMembersOnly } from '../../lib/bungalows';
import { isSolanaSwapLive, isSolanaFeeConfigured } from '../../lib/solana';
import { HeatCard } from './HeatCard';
import { usePageTitle } from '../../hooks/usePageTitle';

// The live pool section carries the @solana wallet stack + the Streamflow
// SDK — lazy so those bytes load ONLY when a pool address is configured.
const LighthousePoolLive = lazy(() =>
  import('./LighthousePoolLive').then((m) => ({ default: m.LighthousePoolLive })),
);
// The EVM leg (vendored Synthetix StakingRewards; provenance D8). Split the
// same way — wagmi write plumbing has no business in a Solana bungalow's chunk.
const EvmLighthousePoolLive = lazy(() =>
  import('./EvmLighthousePoolLive').then((m) => ({ default: m.EvmLighthousePoolLive })),
);
// The LOCKED build (LighthouseLadder). Which card renders is decided by the
// registry's poolKind, i.e. by what the deployed contract actually IS.
const EvmLadderPoolLive = lazy(() =>
  import('./EvmLadderPoolLive').then((m) => ({ default: m.EvmLadderPoolLive })),
);
// The venue's OWN Solana staking program (bayla-ladder), which is a different rail
// from Streamflow rather than a different shape of it. Lazy for the same reason as
// its siblings: check-dist-graph.mjs fails the build if the @solana chunk becomes
// statically reachable from the entry, and it has caught that regression twice.
const SolanaLadderPoolLive = lazy(() =>
  import('./SolanaLadderPoolLive').then((m) => ({ default: m.SolanaLadderPoolLive })),
);
// The ladder with a members-only Streamflow pool's claim strip under it, one wallet context.
const SolanaPoolStack = lazy(() =>
  import('./SolanaPoolStack').then((m) => ({ default: m.SolanaPoolStack })),
);
import { BackToEarn } from '../farm/BackToEarn';
import { CopyButton } from '../ui/CopyButton';
import { shortenAddress } from '../../lib/formatting';
import { ArtImg } from '../ArtImg';

/**
 * The Farm while a room with its own token is active. The room's pool cards lead, picked
 * from the registry (stakePool, ladderPool, poolKind); then how the pool gets funded, the
 * live surfaces and the heat card. With no pool yet it says so and asks for nothing.
 */
export function BungalowFarmPanel({ bungalow }: { bungalow: Bungalow }) {
  // Copy branches on the same registry facts as the pool slot below, so the hero never
  // says "being built" beside a live pool. A members-only Streamflow pool is shown only
  // to its stakers (owner, 2026-09-21), so the page names the ladder instead, as it does
  // when the ladder is the only pool.
  const poolIsLive = Boolean(bungalow.stakePool || bungalow.ladderPool);
  const membersOnly = stakePoolMembersOnly(bungalow);
  const namesLadder = membersOnly || (bungalow.chain === 'solana' && !bungalow.stakePool && Boolean(bungalow.ladderPool));
  const liveName = namesLadder ? 'The lock ladder' : 'The lighthouse pool';
  usePageTitle(
    `Farm: ${bungalow.symbol}`,
    poolIsLive
      ? `Stake ${bungalow.symbol} on ${bungalow.chain === 'solana' ? 'Solana' : bungalow.chain}. ${liveName} is live at Jungle Bay Island.`
      : `Stake ${bungalow.symbol} on ${bungalow.chain === 'solana' ? 'Solana' : bungalow.chain} — arriving at Jungle Bay Island.`,
  );
  const explorer = bungalowExplorerUrl(bungalow);
  const chainLabel = bungalow.chain === 'solana' ? 'Solana' : bungalow.chain === 'base' ? 'Base' : 'Ethereum';
  // Each chain's own swap fee. Solana: the fee account. Ethereum: SwapFeeRouter charges only
  // on a fill in the venue's own pools, and pays stakers, POL and treasury. Base: the swap
  // stack does not trade there (chains/registry.ts `ammSwap: false`).
  const swapFeeLine =
    bungalow.chain === 'solana'
      ? isSolanaFeeConfigured()
        ? 'the Solana swap surface captures a platform fee, and a share of it can route here.'
        : 'the Solana swap surface is live here, but it takes no platform fee today, so there is nothing to share until one is switched on.'
      : bungalow.chain === 'ethereum'
        ? `the ${chainLabel} swap surface takes a platform fee only when a trade fills in the venue's own pools, and no share of it routes here today.`
        : `the venue runs no swap on ${chainLabel}, so there is no swap fee to share.`;
  // Row 2 holds the lighthouse pool and the funding card side by side. With a ladder and
  // no lighthouse card (none, or members-only in the ladder's row), funding spans it.
  const fundingAlone = bungalow.chain === 'solana' && Boolean(bungalow.ladderPool) && (!bungalow.stakePool || membersOnly);

  return (
    <div className="relative min-h-screen">
      {/* Art-first: fullscreen bungalow art behind the panel, same pattern as
          every established page (fixed, scrimmed, content above). */}
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="bungalow-farm" idx={2} alt="" loading="lazy" className="w-full h-full object-cover" />
        {/* A light scrim (0.38), so the resident's art reads through. */}
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.38)' }} />
      </div>
      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-8 pb-16">
      <BackToEarn />
      {/* Header */}
      <div className="mb-8">
        <p className="text-white/70 text-[11px] uppercase tracking-[0.2em] mb-2">
          Jungle Bay Island · {bungalow.status}
        </p>
        <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">
          Stake {bungalow.symbol}.
        </h1>
        <p className="text-white/85 text-[15px] max-w-lg leading-relaxed">
          {poolIsLive ? (
            <>
              {bungalow.tagline} {liveName} is live for {bungalow.symbol} on{' '}
              {chainLabel}, created on-chain and readable by anyone. The numbers below
              are read straight from the pool.
            </>
          ) : (
            <>
              {bungalow.tagline} The lighthouse pool is being built for {bungalow.symbol} on{' '}
              {chainLabel}. Until it is deployed and verified, this page makes no
              promises and asks for nothing.
            </>
          )}
        </p>
        {/* The top bar's Connect is EVM only (RainbowKit), and on this page it is
            the most visible one. A Trust wallet connected there showed "only the
            EVM chains" while every card here still asked for Solana, and Jupiter,
            Solana only, can never be in that list (owner, 2026-09-30). */}
        {poolIsLive && bungalow.chain === 'solana' && (
          <p className="text-white/70 text-[13px] max-w-lg leading-relaxed mt-3">
            This pool is on Solana: connect your wallet on the pool card below. The Connect button
            at the top of the page does not connect Solana.
          </p>
        )}
      </div>

      {/* THE LIVE POOL LEADS (2026-09-20): the ladder comes first in the DOM and spans
          the row. An open lighthouse pool shares row 2 with the funding card; a
          members-only one stacks under the ladder in its cell. DOM order IS visual
          order (no CSS `order`), so tab and screen-reader order match the screen. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Pool slot: the dark card until a pool address is configured, the live card
            after. An empty reward vault reads as a labeled real zero. */}
        {(bungalow.stakePool || bungalow.ladderPool) ? (
          <Suspense fallback={
            <div className={`relative overflow-hidden rounded-2xl glass-card-animated ${bungalow.chain === 'solana' && bungalow.ladderPool ? 'lg:col-span-2' : ''}`} style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.85)' }} />
              <div className="relative z-10 p-6"><p className="text-white/70 text-[13px]">{namesLadder ? 'Loading the lock ladder…' : 'Loading the lighthouse…'}</p></div>
            </div>
          }>
            {membersOnly ? (
              // The ladder, with the closed pool's members-only claim strip under it,
              // in ONE full-row cell.
              <div className="lg:col-span-2 min-w-0">
                <SolanaPoolStack bungalow={bungalow} />
              </div>
            ) : bungalow.chain === 'solana' ? (
              // BOTH full cards while the Streamflow pool is open, or its full card alone
              // with no ladder. Each reads its OWN program, never the other's account.
              <>
                {bungalow.ladderPool && (
                  <div className="lg:col-span-2 min-w-0">
                    <SolanaLadderPoolLive bungalow={bungalow as Bungalow & { ladderPool: string }} />
                  </div>
                )}
                {bungalow.stakePool && (
                  <div className="min-w-0">
                    <LighthousePoolLive bungalow={bungalow as Bungalow & { stakePool: string }} />
                  </div>
                )}
              </>
            ) : bungalow.poolKind === 'ladder' ? (
              <EvmLadderPoolLive bungalow={bungalow as Bungalow & { stakePool: string }} />
            ) : (
              <EvmLighthousePoolLive bungalow={bungalow as Bungalow & { stakePool: string }} />
            )}
          </Suspense>
        ) : (
        <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
          <div className="absolute inset-0">
            <ArtImg pageId="bungalow-farm" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.78)' }} />
          <div className="relative z-10 p-6">
            <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>Pool status</p>
            <h2 className="heading-luxury text-xl text-white mb-3">Not deployed yet</h2>
            <p className="text-white/85 text-[13px] leading-relaxed mb-4">
              No {bungalow.symbol} staking program exists on-chain today. There is no
              pool address, so nothing on this page can take a deposit. That is the
              point. When the pool ships it appears here with its address, its verified
              program, and the funded reward balance, in that order.
            </p>
            <p className="text-white/85 text-[13px] leading-relaxed">
              The shape it takes: stake {bungalow.symbol}, earn from a reward pool
              whose vault balance is always shown as it is. An unfunded pool reads
              as a real, labeled zero, never as a promise.
            </p>
          </div>
        </div>
        )}

        {/* Funding routes card: where incentives come from. Secondary to the
            live pool, so no glow loop. It spans the row when a ladder has no
            open lighthouse card beside it: none, or a members-only one stacked
            in the ladder's cell. */}
        <div
          className={`relative overflow-hidden rounded-2xl min-w-0 ${fundingAlone ? 'lg:col-span-2' : ''}`}
          style={{ border: '1px solid var(--color-purple-25)' }}
        >
          <div className="absolute inset-0">
            <ArtImg pageId="bungalow-farm" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.78)' }} />
          <div className="relative z-10 p-6">
            <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>How the pool gets funded</p>
            <h2 className="heading-luxury text-xl text-white mb-3">Routes under evaluation</h2>
            <ul className="text-white/85 text-[13px] leading-relaxed space-y-2 list-disc pl-4">
              {/* No creator-fee route: the venue does not control a pump.fun coin's creator
                  fee, and BAYLA's goes whole to the island. */}
              <li>
                <strong>Venue swap fees</strong>: {swapFeeLine}
              </li>
              {/* Names the mechanism, never another resident. */}
              <li><strong>Community top-ups</strong>: direct, visible transfers into the reward pool, the same way every pool here is seeded.</li>
            </ul>
          </div>
        </div>
      </div>

      {/* While-you-wait: the live surfaces. */}
      <div className="mt-6 rounded-2xl p-6" style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}>
        <p className="text-[10px] uppercase tracking-wider mb-3" style={{ color: 'var(--color-kyle)' }}>Live today</p>
        <div className="flex flex-wrap items-center gap-3">
          {(() => {
            const trade = bungalowTradeRoute(bungalow, isSolanaSwapLive());
            if (!trade) return null;
            if ('to' in trade) {
              return (
                <Link to={trade.to} className="btn-primary px-6 py-2.5 text-[13px] inline-block text-center">
                  Trade {bungalow.symbol}
                </Link>
              );
            }
            const label = trade.kind === 'chart' ? `${bungalow.symbol} chart` : `Trade ${bungalow.symbol}`;
            return (
              <a href={trade.href} target="_blank" rel="noopener noreferrer"
                aria-label={`${label} (opens in new tab)`}
                className="btn-primary px-6 py-2.5 text-[13px] inline-block text-center">
                {label} ↗
              </a>
            );
          })()}
          {bungalowScanRoute(bungalow) && (
            <Link to={bungalowScanRoute(bungalow)!} className="btn-secondary px-6 py-2.5 text-[13px]">
              Scan {bungalow.symbol}
            </Link>
          )}
          {(bungalow.pools ?? []).map((p) => (
            <a key={p.url} href={p.url} target="_blank" rel="noopener noreferrer"
              aria-label={`${p.label} (opens in new tab)`}
              className="btn-secondary px-6 py-2.5 text-[13px]">
              {p.label} ↗
            </a>
          ))}
        </div>
        {bungalow.address && (
          <div className="mt-4 inline-flex items-center gap-3 flex-wrap rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid var(--color-kyle-40)' }}>
            <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>Contract</span>
            <CopyButton text={bungalow.address} display={shortenAddress(bungalow.address, 6)} className="font-mono text-[12px]" style={{ color: 'var(--color-kyle)' }} />
            {explorer && (
              <a href={explorer} target="_blank" rel="noopener noreferrer" aria-label="View token on block explorer (opens in new tab)" className="text-[11px] underline underline-offset-2 text-white/70 hover:text-white">
                explorer ↗
              </a>
            )}
          </div>
        )}
      </div>

      {/* The island's held-time oracle — heat is the island's whole thesis. */}
      <HeatCard />
      </div>
    </div>
  );
}
