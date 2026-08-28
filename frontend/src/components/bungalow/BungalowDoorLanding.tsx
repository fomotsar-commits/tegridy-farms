import { Link } from 'react-router-dom';
import type { Bungalow } from '../../lib/bungalows';
import {
  OPEN_BUNGALOWS_EVENT,
  bungalowExplorerUrl,
  bungalowTradeRoute,
} from '../../lib/bungalows';
import { isSolanaConfigured } from '../../lib/solana';
import { usePageTitle } from '../../hooks/usePageTitle';
import { CopyButton } from '../ui/CopyButton';
import { shortenAddress } from '../../lib/formatting';
import { ArtImg } from '../ArtImg';
import { HeatCard } from './HeatCard';

const CHAIN_LABEL: Record<Bungalow['chain'], string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  solana: 'Solana',
  tbd: 'TBD',
};

/**
 * A settled bungalow's front-door landing — what memetics.finance/<slug>
 * renders while the slot is not yet `live` (no community art drop).
 *
 * Before this page existed, a settled door rendered the venue homepage under
 * whatever skin was active: a PEPE holder arriving at /pepe met TOWELI (or
 * BAYLA) branding and not one string about their token. This page is the
 * registry made visible: plaque, contract, trade route, scanner, heat — all
 * from rails that already exist. It fabricates nothing: the skin itself
 * stays closed until the community brings its art, and the page says so.
 *
 * Honesty rules:
 *  - Registry facts only — no market numbers, no partnership claims, no
 *    yield anything. The island's own status word and plaque line ARE the
 *    copy.
 *  - A Dexscreener link is labeled "Chart", never "Trade" (it is an info
 *    page, and two residents had no indexed pair at all on 2026-08-25).
 *  - The scanner reads Ethereum + Solana only, so Base tokens get no Scan
 *    button rather than a wrong-chain scan.
 *  - Nothing here asks for a wallet signature.
 */
export function BungalowDoorLanding({ bungalow }: { bungalow: Bungalow }) {
  const hasToken = Boolean(bungalow.address);
  usePageTitle(
    hasToken ? `${bungalow.symbol} — Jungle Bay Island` : 'Jungle Bay Island',
    hasToken
      ? `${bungalow.name} has a bungalow on Jungle Bay Island — ${bungalow.tagline} Contract, trade route and held-time heat, on ${CHAIN_LABEL[bungalow.chain]}.`
      : 'A quiet bungalow on Jungle Bay Island — someone is building here.',
  );
  const explorer = bungalowExplorerUrl(bungalow);
  const trade = bungalowTradeRoute(bungalow, isSolanaConfigured());
  const scanSupported = bungalow.chain === 'ethereum' || bungalow.chain === 'solana';
  const accent = bungalow.accent ?? 'var(--color-kyle)';

  return (
    <div className="relative min-h-screen">
      {/* Classic art backdrop — the bungalow's OWN art arrives with its drop;
          until then the island's classic pieces hold the wall. */}
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="bungalow-door" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.62)' }} />
      </div>
      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-10 pb-16">
        {/* The plaque */}
        <div className="mb-8">
          <p className="text-white/70 text-[11px] uppercase tracking-[0.2em] mb-2">
            Jungle Bay Island · {bungalow.status}
          </p>
          <h1 className="heading-luxury text-3xl md:text-6xl text-white leading-[1.1] tracking-tight mb-3">
            {hasToken ? `${bungalow.symbol}.` : 'Unmarked.'}
            <br />
            <span className="text-white">{hasToken ? 'This bungalow is settled.' : 'Someone is building here.'}</span>
          </h1>
          <p className="text-white/85 text-[15px] max-w-lg leading-relaxed">
            {bungalow.tagline}{' '}
            {hasToken ? (
              <>
                {bungalow.name} lives on {CHAIN_LABEL[bungalow.chain]} and holds a spot on the
                island. The door is open today — contract, trade route and heat below. The full
                skin (this venue dressed in {bungalow.name}&apos;s own art) opens when its
                community brings the art drop.
              </>
            ) : (
              <>The island keeps one bungalow unmarked. Check back.</>
            )}
          </p>
        </div>

        {hasToken && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Contract + live surfaces */}
            <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.82)' }} />
              <div className="relative z-10 p-6">
                <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: accent }}>Live today</p>
                <div className="flex flex-wrap items-center gap-3 mb-4">
                  {trade && ('to' in trade ? (
                    <Link to={trade.to} className="btn-primary px-6 py-2.5 text-[13px] inline-block text-center">
                      Trade {bungalow.symbol}
                    </Link>
                  ) : (
                    <a
                      href={trade.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${trade.kind === 'chart' ? 'Chart for' : 'Trade'} ${bungalow.symbol} (opens in new tab)`}
                      className="btn-primary px-6 py-2.5 text-[13px] inline-block text-center"
                    >
                      {trade.kind === 'chart' ? `${bungalow.symbol} chart ↗` : `Trade ${bungalow.symbol} ↗`}
                    </a>
                  ))}
                  {scanSupported && bungalow.address && (
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
                <div className="inline-flex items-center gap-3 flex-wrap rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid var(--color-kyle-40)' }}>
                  <span className="text-[10px] uppercase tracking-wider" style={{ color: accent }}>
                    {bungalow.symbol} · {CHAIN_LABEL[bungalow.chain]}
                  </span>
                  <CopyButton text={bungalow.address!} display={shortenAddress(bungalow.address!, 6)} className="font-mono text-[12px]" style={{ color: 'var(--color-kyle)' }} />
                  {explorer && (
                    <a href={explorer} target="_blank" rel="noopener noreferrer" aria-label="View token on block explorer (opens in new tab)" className="text-[11px] underline underline-offset-2 text-white/70 hover:text-white">
                      explorer ↗
                    </a>
                  )}
                </div>
              </div>
            </div>

            {/* The art-drop invitation */}
            <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0">
                <ArtImg pageId="bungalow-door" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
              </div>
              <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.8)' }} />
              <div className="relative z-10 p-6">
                <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: accent }}>The skin</p>
                <h2 className="heading-luxury text-xl text-white mb-3">Opens with the art drop</h2>
                <p className="text-white/85 text-[13px] leading-relaxed mb-4">
                  Every live bungalow dresses this whole venue in its community&apos;s art —
                  15–30 pieces and a blessing is all it takes. Until {bungalow.name}&apos;s
                  people bring theirs, the classic island art holds the wall and this address
                  keeps working exactly as it does today.
                </p>
                <p className="text-white/85 text-[13px] leading-relaxed">
                  See the living demo: the{' '}
                  <Link to="/bayla" className="underline underline-offset-2 text-white hover:text-white/80">
                    BAYLA bungalow
                  </Link>{' '}
                  is a full token-first home — hero, farm, gallery wing, the works.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Held-time heat — the island's whole thesis, works for any wallet. */}
        {hasToken && <HeatCard />}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event(OPEN_BUNGALOWS_EVENT))}
            className="btn-secondary px-6 py-2.5 text-[13px]"
          >
            🏝️ Browse the island
          </button>
          <Link to="/" className="btn-secondary px-6 py-2.5 text-[13px] inline-block text-center">
            Enter the venue
          </Link>
        </div>
      </div>
    </div>
  );
}
