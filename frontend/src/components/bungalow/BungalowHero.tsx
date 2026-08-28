import { Link } from 'react-router-dom';
import type { Bungalow, BungalowIdentity } from '../../lib/bungalows';
import { bungalowExplorerUrl, bungalowTradeRoute } from '../../lib/bungalows';
import { isSolanaSwapLive } from '../../lib/solana';
import { CopyButton } from '../ui/CopyButton';
import { shortenAddress } from '../../lib/formatting';

/**
 * Token-first hero cluster for a bungalow that speaks for itself (Bayla).
 * Rendered by HomePage IN PLACE OF the TOWELI H1/copy/CTA/quote cluster when
 * `getBungalowIdentity()` is non-null; the chain pills and security badge
 * around it stay shared (they are venue facts, not token copy).
 *
 * Honesty rules carried over from the surface it replaces: no yield claims,
 * no numbers that drift — the copy speaks lore and links to checkable
 * surfaces (trade route, scanner, contract). The Stake CTA routes to /farm,
 * which in bungalow mode renders the self-gating BungalowFarmPanel — it can
 * never advertise a pool that does not exist.
 */
export function BungalowHero({ bungalow }: { bungalow: Bungalow & { identity: BungalowIdentity } }) {
  const id = bungalow.identity;
  const explorer = bungalowExplorerUrl(bungalow);
  // In-venue swap preset when the Solana surface is live; canon deep link otherwise.
  const trade = bungalowTradeRoute(bungalow, isSolanaSwapLive());
  const tradeClass = 'px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#d4a843]';
  const tradeStyle = { background: 'linear-gradient(135deg, #d4a843 0%, #b8892e 100%)', color: '#0a0a0f' } as const;
  return (
    <>
      <h1 className="heading-luxury text-3xl md:text-6xl text-white leading-[1.1] tracking-tight mb-4">
        {id.heroTitle}<br /><span className="text-white">{id.heroLine}</span>
      </h1>

      <p className="text-white text-base md:text-lg mb-6 max-w-md leading-relaxed">
        {id.heroCopy}
      </p>

      <div className="flex flex-wrap gap-3">
        {trade && ('to' in trade ? (
          <Link to={trade.to} className={tradeClass} style={tradeStyle}>
            Trade {bungalow.symbol}
          </Link>
        ) : (
          <a
            href={trade.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Trade ${bungalow.symbol} (opens in new tab)`}
            className={tradeClass}
            style={tradeStyle}
          >
            Trade {bungalow.symbol}
          </a>
        ))}
        <Link to="/farm" className="btn-primary px-7 py-2.5 text-[14px] inline-block text-center">
          Stake {bungalow.symbol}
        </Link>
        {bungalow.address && (
          <Link
            to={`/scan?token=${bungalow.address}`}
            className="px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#4CAF50]"
            style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(76,175,80,0.55)', color: 'var(--color-kyle)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
          >
            Scan {bungalow.symbol}
          </Link>
        )}
      </div>

      {/* The muse line — same pill geometry as the Towelie ticker it replaces,
          but static: one line of canon, not a rotating joke. */}
      <div className="mt-4 min-h-[48px] md:min-h-[34px] flex items-center">
        <span
          className="inline-flex items-baseline gap-2 text-[13px] italic rounded-full px-3 py-1.5"
          style={{ background: 'rgba(6,12,26,0.55)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
        >
          <span className="text-white/90">&ldquo;{id.museLine}&rdquo;</span>
          <span className="text-[11px] not-italic" style={{ color: 'var(--color-weed)' }}>&mdash; {id.museBy}</span>
        </span>
      </div>

      {/* Contract chip — copyable mint + explorer link, mirroring the footer card. */}
      {bungalow.address && (
        <div className="mt-4 rounded-lg p-3 inline-flex items-center gap-3 flex-wrap" style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid var(--color-kyle-40)' }}>
          <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>
            {bungalow.symbol} · {bungalow.chain}
          </span>
          <CopyButton text={bungalow.address} display={shortenAddress(bungalow.address, 6)} className="font-mono text-[12px]" style={{ color: 'var(--color-kyle)' }} />
          {explorer && (
            <a href={explorer} target="_blank" rel="noopener noreferrer" aria-label="View token on block explorer (opens in new tab)" className="text-[11px] underline underline-offset-2 text-white/70 hover:text-white">
              explorer ↗
            </a>
          )}
        </div>
      )}
    </>
  );
}
