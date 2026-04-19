import { Link } from 'react-router-dom';
import { UNISWAP_BUY_URL, ETHERSCAN_TOKEN, GECKOTERMINAL_URL, TOWELI_ADDRESS } from '../../lib/constants';
import { shortenAddress } from '../../lib/formatting';
import { CopyButton } from '../ui/CopyButton';

/**
 * Footer — four-column IA: Product / Resources / Community / Legal.
 * Every route demoted from the top nav must be reachable here so the
 * reduced TopNav doesn't strand any page.
 */
const PRODUCT_LINKS: { to: string; label: string }[] = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/farm', label: 'Farm' },
  { to: '/swap', label: 'Trade' },
  { to: '/lending', label: 'NFT Finance' },
  { to: '/community', label: 'Governance' },
  { to: '/premium', label: 'Gold Card' },
  { to: '/leaderboard', label: 'Points' },
  { to: '/nakamigos', label: 'Tradermigos' },
];

const RESOURCE_LINKS: { to: string; label: string }[] = [
  { to: '/tokenomics', label: 'Tokenomics' },
  { to: '/gallery', label: 'Gallery' },
  { to: '/lore', label: 'Lore' },
  { to: '/history', label: 'History' },
  { to: '/changelog', label: 'Changelog' },
  { to: '/faq', label: 'FAQ' },
  { to: '/contracts', label: 'Contracts' },
  { to: '/treasury', label: 'Treasury' },
];

const EXTERNAL_RESOURCES: { href: string; label: string }[] = [
  { href: UNISWAP_BUY_URL, label: 'Trade on Uniswap' },
  { href: ETHERSCAN_TOKEN, label: 'Etherscan' },
  { href: GECKOTERMINAL_URL, label: 'GeckoTerminal' },
];

const COMMUNITY_LINKS: { href: string; label: string }[] = [
  { href: 'https://x.com/junglebayac', label: 'Twitter / X' },
  { href: 'https://discord.gg/junglebay', label: 'Discord' },
  { href: 'https://t.me/tegridyfarms', label: 'Telegram' },
];

const LEGAL_LINKS: { to: string; label: string }[] = [
  { to: '/security', label: 'Security' },
  { to: '/risks', label: 'Risks' },
  { to: '/terms', label: 'Terms' },
  { to: '/privacy', label: 'Privacy' },
];

export function Footer() {
  // Footer sits on top of whatever fixed art background the current page provides
  // (galleryCollage on Home, apeHug on Trade, etc.). Before this change, links were
  // text-white/60 with no scrim — barely legible over bright art regions. Now we
  // layer a dark frosted panel under the whole footer and bump link contrast so the
  // IA is readable regardless of what's behind it.
  const LINK_CLASS = 'block text-white/90 text-[13px] hover:text-white transition-colors';
  const LINK_SHADOW = { textShadow: '0 1px 6px rgba(0,0,0,0.95)' } as const;
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
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        {/* Gold divider */}
        <div className="accent-divider" />

        {/* Top section */}
        <div className="pt-12 pb-8 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4 md:gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[18px] font-bold tracking-wide" style={{ ...LINK_SHADOW, color: 'var(--color-kyle)', fontFamily: 'var(--font-family-heading)' }}>
                <span>TEGRIDY</span>{' '}
                <span>FARMS</span>
              </span>
            </div>
            <p className="text-[13px] leading-relaxed max-w-[280px]" style={{ ...LINK_SHADOW, color: 'var(--color-kyle)' }}>
              Art-first yield farming on Ethereum. Stake TOWELI & LP tokens to earn rewards. 100% of protocol revenue goes to stakers.
            </p>
            <div className="mt-4 rounded-lg p-3 inline-block" style={{ background: 'rgba(0,0,0,0.75)', border: '1px solid var(--color-kyle-40)' }}>
              <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>Contract</p>
              <CopyButton text={TOWELI_ADDRESS} display={shortenAddress(TOWELI_ADDRESS, 6)}
                className="font-mono text-[12px]"
                style={{ color: 'var(--color-kyle)', textShadow: '0 1px 4px rgba(0,0,0,0.85)' }} />
            </div>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider font-semibold mb-3" style={{ ...LINK_SHADOW, color: 'var(--color-kyle)' }}>Product</h4>
            <div className="space-y-2">
              {PRODUCT_LINKS.map((l) => (
                <Link key={l.to} to={l.to} className={LINK_CLASS}
                  style={l.to === '/premium' ? { color: '#d4a017', ...LINK_SHADOW } : LINK_SHADOW}>
                  {l.label}
                </Link>
              ))}
            </div>
          </div>

          {/* Resources */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider font-semibold mb-3" style={{ ...LINK_SHADOW, color: 'var(--color-kyle)' }}>Resources</h4>
            <div className="space-y-2">
              {RESOURCE_LINKS.map((l) => (
                <Link key={l.to} to={l.to} className={LINK_CLASS} style={LINK_SHADOW}>
                  {l.label}
                </Link>
              ))}
              {EXTERNAL_RESOURCES.map((l) => (
                <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
                  aria-label={`${l.label} (opens in new tab)`}
                  className={LINK_CLASS} style={LINK_SHADOW}>
                  {l.label} <span className="text-white/40">↗</span>
                </a>
              ))}
            </div>
          </div>

          {/* Community */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider font-semibold mb-3" style={{ ...LINK_SHADOW, color: 'var(--color-kyle)' }}>Community</h4>
            <div className="space-y-2">
              <Link to="/community" className={LINK_CLASS} style={LINK_SHADOW}>
                Governance
              </Link>
              {COMMUNITY_LINKS.map((l) => (
                <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
                  aria-label={`${l.label} (opens in new tab)`}
                  className={LINK_CLASS} style={LINK_SHADOW}>
                  {l.label} <span className="text-white/40">↗</span>
                </a>
              ))}
            </div>
          </div>

          {/* Legal */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider font-semibold mb-3" style={{ ...LINK_SHADOW, color: 'var(--color-kyle)' }}>Legal</h4>
            <div className="space-y-2">
              {LEGAL_LINKS.map((l) => (
                <Link key={l.to} to={l.to} className={LINK_CLASS} style={LINK_SHADOW}>
                  {l.label}
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="accent-divider" />
        <div className="py-5 flex flex-col md:flex-row items-center justify-between gap-3">
          <span className="text-white/90 text-[11px]" style={LINK_SHADOW}>
            Experimental protocol. Use at your own risk. Not financial advice. <Link to="/risks" className="text-white hover:text-white/80 underline" style={LINK_SHADOW}>Risk Disclosure</Link> · <Link to="/security" className="text-white hover:text-white/80 underline" style={LINK_SHADOW}>Security</Link>
          </span>
          <span className="text-white/60 text-[11px]" style={LINK_SHADOW}>
            © 2026 Tegridy Farms
          </span>
        </div>
      </div>
    </footer>
  );
}
