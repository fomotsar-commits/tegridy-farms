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
  { to: '/nakamigos', label: 'Marketplace' },
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
  return (
    <footer className="relative mt-8" role="contentinfo">
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        {/* Gold divider */}
        <div className="accent-divider" />

        {/* Top section */}
        <div className="pt-12 pb-8 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4 md:gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <span className="heading-luxury text-[18px]">
                <span className="text-white">TEGRIDY</span>{' '}
                <span className="text-white">FARMS</span>
              </span>
            </div>
            <p className="text-white text-[13px] leading-relaxed max-w-[280px]">
              Art-first yield farming on Ethereum. Stake TOWELI & LP tokens to earn rewards. 100% of protocol revenue goes to stakers.
            </p>
            <div className="mt-4 rounded-lg p-3 inline-block" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-1">Contract</p>
              <CopyButton text={TOWELI_ADDRESS} display={shortenAddress(TOWELI_ADDRESS, 6)}
                className="font-mono text-[12px] text-white" />
            </div>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-white text-[11px] uppercase tracking-wider label-pill font-semibold mb-3">Product</h4>
            <div className="space-y-2">
              {PRODUCT_LINKS.map((l) => (
                <Link key={l.to} to={l.to} className="block text-white/60 text-[13px] hover:text-white transition-colors"
                  style={l.to === '/premium' ? { color: '#d4a017' } : undefined}>
                  {l.label}
                </Link>
              ))}
            </div>
          </div>

          {/* Resources */}
          <div>
            <h4 className="text-white text-[11px] uppercase tracking-wider label-pill font-semibold mb-3">Resources</h4>
            <div className="space-y-2">
              {RESOURCE_LINKS.map((l) => (
                <Link key={l.to} to={l.to} className="block text-white/60 text-[13px] hover:text-white transition-colors">
                  {l.label}
                </Link>
              ))}
              {EXTERNAL_RESOURCES.map((l) => (
                <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
                  aria-label={`${l.label} (opens in new tab)`}
                  className="block text-white/60 text-[13px] hover:text-white transition-colors">
                  {l.label} <span className="text-white/15">↗</span>
                </a>
              ))}
            </div>
          </div>

          {/* Community */}
          <div>
            <h4 className="text-white text-[11px] uppercase tracking-wider label-pill font-semibold mb-3">Community</h4>
            <div className="space-y-2">
              <Link to="/community" className="block text-white/60 text-[13px] hover:text-white transition-colors">
                Governance
              </Link>
              {COMMUNITY_LINKS.map((l) => (
                <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
                  aria-label={`${l.label} (opens in new tab)`}
                  className="block text-white/60 text-[13px] hover:text-white transition-colors">
                  {l.label} <span className="text-white/15">↗</span>
                </a>
              ))}
            </div>
          </div>

          {/* Legal */}
          <div>
            <h4 className="text-white text-[11px] uppercase tracking-wider label-pill font-semibold mb-3">Legal</h4>
            <div className="space-y-2">
              {LEGAL_LINKS.map((l) => (
                <Link key={l.to} to={l.to} className="block text-white/60 text-[13px] hover:text-white transition-colors">
                  {l.label}
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="accent-divider" />
        <div className="py-5 flex flex-col md:flex-row items-center justify-between gap-3">
          <span className="text-white text-[11px]">
            Experimental protocol. Use at your own risk. Not financial advice. <Link to="/risks" className="text-white/70 hover:text-white/60 underline">Risk Disclosure</Link> · <Link to="/security" className="text-white/70 hover:text-white/60 underline">Security</Link>
          </span>
          <span className="text-white/15 text-[11px]">
            © 2026 Tegridy Farms
          </span>
        </div>
      </div>
    </footer>
  );
}
