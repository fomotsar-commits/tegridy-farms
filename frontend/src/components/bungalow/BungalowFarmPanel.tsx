import { Link } from 'react-router-dom';
import type { Bungalow } from '../../lib/bungalows';
import { bungalowExplorerUrl } from '../../lib/bungalows';
import { usePageTitle } from '../../hooks/usePageTitle';
import { CopyButton } from '../ui/CopyButton';
import { shortenAddress } from '../../lib/formatting';
import { ArtImg } from '../ArtImg';

/**
 * The Farm surface while a non-default bungalow is active (Bayla today).
 *
 * FarmPage's whole TOWELI stack (staking card, LP farming, boost tables,
 * incentives strip) is Ethereum/TOWELI machinery — none of it applies to a
 * Solana bungalow token, so in bungalow mode the route renders this panel
 * INSTEAD, and the classic farm returns untouched the moment the visitor
 * switches back to Toweli.
 *
 * HONESTY CONTRACT (same convention as every gated surface in this repo —
 * CurveLaunchPage, AirdropPage, VestingPage): no staking program for this
 * token exists yet, so this panel states exactly that, asks for nothing,
 * and holds no wallet interaction. It describes how the pool will be funded
 * (the routes under evaluation in docs/BAYLA_BUNGALOW.md) and routes the
 * visitor to the surfaces that ARE live: the trade route, the scanner, and
 * the token's real liquidity pools. When a pool ships, this panel is where
 * its address lands (registry-driven), and the live staking card replaces
 * the status card.
 */
export function BungalowFarmPanel({ bungalow }: { bungalow: Bungalow }) {
  usePageTitle(
    `Farm — ${bungalow.symbol}`,
    `Stake ${bungalow.symbol} on ${bungalow.chain === 'solana' ? 'Solana' : bungalow.chain} — arriving at Jungle Bay Island.`,
  );
  const explorer = bungalowExplorerUrl(bungalow);
  const chainLabel = bungalow.chain === 'solana' ? 'Solana' : bungalow.chain === 'base' ? 'Base' : 'Ethereum';

  return (
    <div className="relative min-h-screen">
      {/* Art-first: fullscreen bungalow art behind the panel, same pattern as
          every established page (fixed, scrimmed, content above). */}
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="bungalow-farm" idx={2} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.55)' }} />
      </div>
      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-8 pb-16">
      {/* Header */}
      <div className="mb-8">
        <p className="text-white/70 text-[11px] uppercase tracking-[0.2em] mb-2">
          Jungle Bay Island · {bungalow.status}
        </p>
        <h1 className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3">
          Stake {bungalow.symbol}.
        </h1>
        <p className="text-white/85 text-[15px] max-w-lg leading-relaxed">
          {bungalow.tagline} The lighthouse pool is being built for {bungalow.symbol} on{' '}
          {chainLabel} — and until it is deployed and verified, this page makes no
          promises and asks for nothing.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Status card — the honest gate. */}
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
              pool address, so nothing on this page can take a deposit — that is the
              point. When the pool ships it appears here with its address, its verified
              program, and the funded reward balance, in that order.
            </p>
            <p className="text-white/85 text-[13px] leading-relaxed">
              The shape it takes: stake {bungalow.symbol}, earn from a reward pool that
              is <strong>funded before it advertises</strong> — the venue&rsquo;s rule
              that a dry pool must read as a real zero.
            </p>
          </div>
        </div>

        {/* Funding routes card — where incentives come from. */}
        <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
          <div className="absolute inset-0">
            <ArtImg pageId="bungalow-farm" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.78)' }} />
          <div className="relative z-10 p-6">
            <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--color-kyle)' }}>How the pool gets funded</p>
            <h2 className="heading-luxury text-xl text-white mb-3">Routes under evaluation</h2>
            <ul className="text-white/85 text-[13px] leading-relaxed space-y-2 list-disc pl-4">
              <li><strong>Creator-fee share</strong> from the graduated pump.fun pool — trading fees the pool already generates.</li>
              <li><strong>Venue swap fees</strong> — the Solana swap surface captures a platform fee that can route a share here.</li>
              <li><strong>Community top-ups</strong> — direct, visible transfers into the reward pool, the same way the TOWELI seed was funded.</li>
            </ul>
          </div>
        </div>
      </div>

      {/* While-you-wait: the live surfaces. */}
      <div className="mt-6 rounded-2xl p-6" style={{ background: 'rgba(4,9,18,0.72)', border: '1px solid var(--color-purple-25)' }}>
        <p className="text-[10px] uppercase tracking-wider mb-3" style={{ color: 'var(--color-kyle)' }}>Live today</p>
        <div className="flex flex-wrap items-center gap-3">
          {bungalow.swapUrl && (
            <a href={bungalow.swapUrl} target="_blank" rel="noopener noreferrer"
              aria-label={`Trade ${bungalow.symbol} (opens in new tab)`}
              className="btn-primary px-6 py-2.5 text-[13px] inline-block text-center">
              Trade {bungalow.symbol} ↗
            </a>
          )}
          {bungalow.address && (
            <Link to={`/scan?token=${bungalow.address}`} className="btn-secondary px-6 py-2.5 text-[13px]">
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
      </div>
    </div>
  );
}
