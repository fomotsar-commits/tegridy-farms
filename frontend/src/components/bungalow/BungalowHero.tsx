import { Link } from 'react-router-dom';
import type { Bungalow, BungalowIdentity } from '../../lib/bungalows';
import { bungalowExplorerUrl, bungalowLpDoor, bungalowScanRoute, bungalowTradeRoute, OPEN_BUNGALOW_ABOUT_EVENT } from '../../lib/bungalows';
import { isSolanaSwapLive } from '../../lib/solana';
import { CoinName } from '../ui/CoinName';
import { FinePrint } from '../ui/FinePrint';

/**
 * The hero of a room that speaks for itself, rendered by HomePage in place of the TOWELI
 * cluster when getBungalowIdentity() is non-null. No yield claims and no numbers that
 * drift: lore, and links to surfaces anyone can check. Stake routes to /earn/<id>, whose
 * BungalowFarmPanel never advertises a pool that does not exist.
 */
export function BungalowHero({ bungalow }: { bungalow: Bungalow & { identity: BungalowIdentity } }) {
  const id = bungalow.identity;
  const explorer = bungalowExplorerUrl(bungalow);
  // In-venue swap preset when the Solana surface is live; canon deep link otherwise.
  const trade = bungalowTradeRoute(bungalow, isSolanaSwapLive());
  // The LP door (island, answer twenty): second, before Stake, only where the coin has a SOL pool on the venue.
  const lpDoor = bungalowLpDoor(bungalow);
  const tradeClass = 'px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#d4a843]';
  const tradeStyle = { background: 'linear-gradient(135deg, #d4a843 0%, #b8892e 100%)', color: '#0a0a0f' } as const;
  // Scan's outline, shared by the Marketplace and NFT loans doors.
  const doorClass = 'px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#1E88E5]';
  const doorStyle = { background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(30,136,229,0.55)', color: 'var(--color-stan)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' } as const;
  return (
    <>
      <h1 className="heading-luxury text-[clamp(1.25rem,7.4vw,1.875rem)] md:text-6xl text-white leading-[1.1] tracking-tight mb-4">
        {/* A real space before the break, as on the venue hero (answer ten, ruling 3):
            a <br> is not text, so without it the heading read "BAYLA.The muse". */}
        {id.heroTitle}{' '}<br /><span className="text-white">{id.heroLine}</span>
      </h1>

      {/* One line under the name (owner, 2026-10-14: fewer words). The room's paragraph
          (heroCopy) is folded below the buttons, word for word, in the small print. */}
      <p className="text-white text-base md:text-lg mb-6 max-w-md leading-relaxed">
        Trade {bungalow.symbol}. Hold it. Time held is what counts.
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
            aria-label={`${trade.kind === 'chart' ? `${bungalow.symbol} chart` : `Trade ${bungalow.symbol}`} (opens in new tab)`}
            className={tradeClass}
            style={tradeStyle}
          >
            {trade.kind === 'chart' ? `${bungalow.symbol} chart` : `Trade ${bungalow.symbol}`}
          </a>
        ))}
        {/* One filled button, the rule VenueHero keeps too: Trade, the action any visitor
            can complete. Stake is an outline in the same kyle green, and Scan wears
            --color-stan, the trust hue, so the two secondary actions differ by meaning.
            The LP door wears the pool teal. */}
        {lpDoor && (
          <Link
            to={lpDoor.to}
            className="px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#31d0aa]"
            style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(49,208,170,0.6)', color: '#31d0aa', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
          >
            {lpDoor.label}
          </Link>
        )}
        <Link
          to={`/earn/${bungalow.id}`}
          className="px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#4CAF50]"
          style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(76,175,80,0.55)', color: 'var(--color-kyle)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        >
          {bungalow.stakePool ? `Stake ${bungalow.symbol}` : 'The lighthouse'}
        </Link>
        {bungalowScanRoute(bungalow) && (
          <Link to={bungalowScanRoute(bungalow)!} className={doorClass} style={doorStyle}>
            Scan {bungalow.symbol}
          </Link>
        )}
        {/* The two doors this room never showed (owner, 2026-10-14): the marketplace and
            NFT loans. Outlines in Scan's trust hue, so the row stays one filled Trade. */}
        <Link to="/nakamigos" className={doorClass} style={doorStyle}>
          Marketplace
        </Link>
        <Link to="/nft-finance" className={doorClass} style={doorStyle}>
          NFT loans
        </Link>
      </div>

      {/* The muse line — same pill geometry as the Towelie ticker it replaces,
          but static: one line of canon, not a rotating joke. */}
      <div className="mt-4 min-h-[48px] md:min-h-[34px] flex items-center">
        <span
          className="inline-flex items-baseline gap-2 text-[13px] italic rounded-full px-3 py-1.5"
          style={{ background: 'rgba(6,12,26,0.55)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
        >
          <span className="text-white/90">&ldquo;{id.museLine}&rdquo;</span>
          {/* A middle dot, as the venue hero uses (answer ten, ruling 6). The dash
              here sat alone in its own text node, so every count filed it as the
              unread placeholder while every reader saw a prose dash. */}
          <span className="text-[11px] not-italic" style={{ color: 'var(--color-weed)' }}>&middot; {id.museBy}</span>
        </span>
      </div>

      {/* WAVE SEVEN, element E: the room's three-step welcome used to open
          ITSELF over the page on a first visit. It waits here instead. The copy
          is unchanged and undeleted; it simply arrives when somebody asks, which
          is the whole rule — a modal exists only behind a tap. */}
      {/* The hero paragraph, moved here word for word (owner, 2026-10-14: one line on
          the page, the rest one press away). */}
      <FinePrint summary={`About ${bungalow.symbol}`} className="mt-2 max-w-md">
        <p>{id.heroCopy}</p>
      </FinePrint>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event(OPEN_BUNGALOW_ABOUT_EVENT))}
        className="mt-1 text-[12px] underline underline-offset-4 decoration-white/30 hover:decoration-white transition-colors"
        style={{ color: 'rgba(255,255,255,0.75)' }}
      >
        About this bungalow
      </button>

      {/* Contract chip: the coin's name copies its whole address (CoinName, island answer twenty-four), then the explorer link. */}
      {bungalow.address && (
        <div className="mt-4 rounded-lg p-3 inline-flex items-center gap-3 flex-wrap" style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid var(--color-kyle-40)' }}>
          <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>
            {bungalow.symbol} · {bungalow.chain}
          </span>
          <CoinName name={bungalow.symbol} address={bungalow.address} className="text-[12px]" />
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
