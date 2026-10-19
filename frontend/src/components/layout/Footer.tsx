import { Link, useLocation } from 'react-router-dom';
import { UNISWAP_BUY_URL, ETHERSCAN_TOKEN, GECKOTERMINAL_URL, TOWELI_ADDRESS, SOCIAL_LINKS } from '../../lib/constants';
import { bungalowTradeBlurb, getBungalowIdentity, bungalowExplorerUrl } from '../../lib/bungalows';
import { InstallPrompt } from '../pwa/InstallPrompt';
import { ConsentRow } from '../ui/ConsentRow';
import { isSolanaSwapLive } from '../../lib/solana';
import { shortenAddress } from '../../lib/formatting';
import { CopyButton } from '../ui/CopyButton';
import { voiceAt, VENUE } from '../../lib/arrival';
import { isToweliRoomPage, roomSpeaksOn } from '../../lib/routeVoice';
import { useActiveBungalowId } from '../../hooks/useActiveBungalowId';
import { IslandSoundLinks } from '../IslandSound';

/**
 * Eight links on one screen (the island's venue review, item 1; owner 2026-10-03): the page
 * links below, the AI file and the two community links. Every page the footer used to list
 * opens from the bar or the drawer (navReach.test.tsx). The bar's Island word opens the hall.
 */
const PAGE_LINKS: { to: string; label: string }[] = [
  { to: '/faq', label: 'FAQ' },
  { to: '/security', label: 'Security' },
  { to: '/risks', label: 'Risks' },
  { to: '/terms', label: 'Terms' },
  { to: '/privacy', label: 'Privacy' },
];

/** The farm's markets: in its own room only, beside its contract card (docs/FACE_LAWS.md, law 21). */
const TOWELI_MARKETS: { href: string; label: string }[] = [
  { href: UNISWAP_BUY_URL, label: 'Trade on Uniswap' },
  { href: ETHERSCAN_TOKEN, label: 'Etherscan' },
  { href: GECKOTERMINAL_URL, label: 'GeckoTerminal' },
];

const SHADOW = { textShadow: '0 1px 6px rgba(0,0,0,0.95)' } as const;
// A 44px touch target per link; the frosted panel keeps them legible on any page's art.
const LINK_CLASS = 'text-white/90 text-[13px] hover:text-white transition-colors min-h-[44px] inline-flex items-center';

export function Footer() {
  // A door changes the room in place, so the footer re-reads it.
  useActiveBungalowId();
  // The route decides who speaks here, never the room opened last (docs/FACE_LAWS.md, law 21):
  // a resident's sentence and card on that resident's pages, the farm's on TOWELI's, else the venue's.
  const { pathname, search } = useLocation();
  const lastRoom = getBungalowIdentity();
  const bungalowIdentity = lastRoom && roomSpeaksOn(pathname, lastRoom.id) ? lastRoom : null;
  const toweliVoice = isToweliRoomPage(pathname) || voiceAt(pathname, search) === 'toweli';
  return (
    <footer
      className="relative mt-8"
      role="contentinfo"
      style={{
        background: 'rgba(6,12,26,0.78)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        borderTop: '1px solid var(--color-purple-20)',
      }}
    >
      <div className="page-column mx-auto px-4 md:px-6">
        <div className="accent-divider" />

        <div className="pt-8 pb-3 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] md:gap-10 md:items-start">
          <div>
            <p className="text-[18px] font-bold tracking-wide mb-2" style={{ ...SHADOW, color: 'var(--color-kyle)', fontFamily: 'var(--font-family-heading)' }}>
              <span>{VENUE.markMain}</span><span>{VENUE.markSub}</span>
            </p>
            {bungalowIdentity ? (
              <p className="text-[13px] leading-relaxed max-w-[420px]" style={{ ...SHADOW, color: 'var(--color-kyle)' }}>
                {bungalowIdentity.name} bungalow, Jungle Bay Island. {bungalowIdentity.tagline}{' '}
                {bungalowTradeBlurb(bungalowIdentity, isSolanaSwapLive())}
              </p>
            ) : toweliVoice ? (
              <p className="text-[13px] leading-relaxed max-w-[420px]" style={{ ...SHADOW, color: 'var(--color-kyle)' }}>
                Art-first DeFi on Ethereum and Solana. Stake TOWELI &amp; LP tokens to earn rewards; protocol swap fees route on-chain, after a referral share, to stakers in ETH. On Solana, swap in our own pools or through Jupiter, whichever pays you more.
              </p>
            ) : (
              <p className="text-[13px] leading-relaxed max-w-[420px]" style={{ ...SHADOW, color: 'var(--color-kyle)' }}>
                {VENUE.tagline}. Bungalows for meme communities, launches that open on Heat, and fees you can read onchain. Ethereum, Base and Solana.
              </p>
            )}
            {/* The venue pins no single resident's contract: a room's card shows on its own pages. */}
            {(bungalowIdentity || toweliVoice) && (
              <div className="mt-3 flex flex-wrap items-center gap-x-4">
                <div className="rounded-lg p-3 inline-block" style={{ background: 'rgba(0,0,0,0.75)', border: '1px solid var(--color-kyle-40)' }}>
                  <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>
                    {bungalowIdentity ? `${bungalowIdentity.symbol} contract` : 'TOWELI contract'}
                  </p>
                  <CopyButton
                    text={bungalowIdentity?.address ?? TOWELI_ADDRESS}
                    display={shortenAddress(bungalowIdentity?.address ?? TOWELI_ADDRESS, 6)}
                    className="font-mono text-[12px]"
                    style={{ color: 'var(--color-kyle)', textShadow: '0 1px 4px rgba(0,0,0,0.85)' }} />
                  {bungalowIdentity && bungalowExplorerUrl(bungalowIdentity) && (
                    <a href={bungalowExplorerUrl(bungalowIdentity)!} target="_blank" rel="noopener noreferrer"
                      aria-label="View token on block explorer (opens in new tab)"
                      className="block mt-1 text-[11px] underline underline-offset-2 text-white/80 hover:text-white" style={SHADOW}>
                      View on explorer ↗
                    </a>
                  )}
                </div>
                {toweliVoice && TOWELI_MARKETS.map((l) => (
                  <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
                    aria-label={`${l.label} (opens in new tab)`}
                    className={LINK_CLASS} style={SHADOW}>
                    {l.label} <span className="text-white/40 ml-1">↗</span>
                  </a>
                ))}
              </div>
            )}
          </div>

          <div>
            <nav aria-label="Footer">
              <ul className="flex flex-wrap gap-x-5 md:gap-x-6">
                {PAGE_LINKS.map((l) => (
                  <li key={l.to}>
                    <Link to={l.to} className={LINK_CLASS} style={SHADOW}>{l.label}</Link>
                  </li>
                ))}
                {/* llms.txt (answer ten): what an AI assistant may say about the venue. A plain
                    <a>, because client-side routing would land a static file on the not-found page. */}
                <li>
                  <a href="/llms.txt" className={LINK_CLASS} style={SHADOW}>For your AI</a>
                </li>
                {SOCIAL_LINKS.map((l) => (
                  <li key={l.label}>
                    <a href={l.href} target="_blank" rel="noopener noreferrer"
                      aria-label={`${l.label} (opens in new tab)`}
                      className={LINK_CLASS} style={SHADOW}>
                      {l.label} <span className="text-white/40 ml-1">↗</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            {/* A row only when the browser handed over an unfired install prompt. */}
            <InstallPrompt />
          </div>
        </div>

        {/* The consent ask, in the footer's flow, only while the answer is pending (ConsentRow.tsx). */}
        <ConsentRow />

        <div className="accent-divider" />
        <div className="py-4 flex flex-col md:flex-row items-center justify-between gap-2 text-center md:text-left">
          <span className="text-white/90 text-[11px]" style={SHADOW}>
            Experimental protocol. Use at your own risk. Not financial advice.
          </span>
          <span className="text-white/60 text-[11px]" style={SHADOW}>
            © 2026 memetics.finance · built by the jungle bay artists collective · <IslandSoundLinks />
          </span>
        </div>
        {/* The public line agreed with Jungle Bay Island (2026-10-18), verbatim, on every page. */}
        <p className="pb-4 -mt-2 text-white/60 text-[11px] text-center md:text-right" style={SHADOW}>
          {VENUE.venueLine}
        </p>
      </div>
    </footer>
  );
}
