import { Link } from 'react-router-dom';
import { UNISWAP_BUY_URL, ETHERSCAN_TOKEN, GECKOTERMINAL_URL, TOWELI_ADDRESS } from '../../lib/constants';
import { shortenAddress } from '../../lib/formatting';
import { CopyButton } from '../ui/CopyButton';

export function Footer() {
  return (
    <footer className="relative mt-8" role="contentinfo">
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        {/* Gold divider */}
        <div className="accent-divider" />

        {/* Top section */}
        <div className="pt-12 pb-8 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 md:gap-8">
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
          </div>

          {/* Navigation */}
          <div>
            <h4 className="text-white text-[11px] uppercase tracking-wider label-pill font-semibold mb-3">Protocol</h4>
            <div className="space-y-2">
              {[
                { to: '/farm', label: 'Farm' },
                { to: '/swap', label: 'Swap' },
                { to: '/dashboard', label: 'Dashboard' },
                { to: '/lending', label: 'NFT Finance' },
                { to: '/community', label: 'Community' },
                { to: '/gallery', label: 'Gallery' },
                { to: '/tokenomics', label: 'Tokenomics' },
                { to: '/premium', label: 'Gold Card' },
                { to: '/leaderboard', label: 'Points' },
              ].map((l) => (
                <Link key={l.to} to={l.to} className="block text-white/60 text-[13px] hover:text-white transition-colors">
                  {l.label}
                </Link>
              ))}
            </div>
          </div>

          {/* Resources */}
          <div>
            <h4 className="text-white text-[11px] uppercase tracking-wider label-pill font-semibold mb-3">Resources</h4>
            <div className="space-y-2">
              {[
                { href: UNISWAP_BUY_URL, label: 'Trade on Uniswap' },
                { href: ETHERSCAN_TOKEN, label: 'Etherscan' },
                { href: GECKOTERMINAL_URL, label: 'GeckoTerminal' },
              ].map((l) => (
                <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
                  aria-label={`${l.label} (opens in new tab)`}
                  className="block text-white/60 text-[13px] hover:text-white transition-colors">
                  {l.label} <span className="text-white/15">↗</span>
                </a>
              ))}
            </div>
            <div className="mt-4 rounded-lg p-3 inline-block" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-1">Contract</p>
              <CopyButton text={TOWELI_ADDRESS} display={shortenAddress(TOWELI_ADDRESS, 6)}
                className="font-mono text-[12px] text-white" />
            </div>
          </div>

          {/* Social & Legal */}
          <div>
            <h4 className="text-white text-[11px] uppercase tracking-wider label-pill font-semibold mb-3">Social</h4>
            <div className="space-y-2">
              <a href="https://x.com/junglebayac" target="_blank" rel="noopener noreferrer"
                aria-label="Twitter / X (opens in new tab)"
                className="block text-white/60 text-[13px] hover:text-white transition-colors">
                Twitter / X <span className="text-white/15">↗</span>
              </a>
              <a href="https://discord.gg/junglebay" target="_blank" rel="noopener noreferrer"
                aria-label="Discord (opens in new tab)"
                className="block text-white/60 text-[13px] hover:text-white transition-colors">
                Discord <span className="text-white/15">↗</span>
              </a>
              <a href="https://t.me/tegridyfarms" target="_blank" rel="noopener noreferrer"
                aria-label="Telegram (opens in new tab)"
                className="block text-white/60 text-[13px] hover:text-white transition-colors">
                Telegram <span className="text-white/15">↗</span>
              </a>
            </div>
            <div className="mt-4 space-y-1.5">
              {[
                { to: '/security', label: 'Security' },
                { to: '/faq', label: 'FAQ' },
                { to: '/changelog', label: 'Changelog' },
                { to: '/terms', label: 'Terms' },
                { to: '/privacy', label: 'Privacy' },
                { to: '/risks', label: 'Risks' },
              ].map((l) => (
                <Link key={l.to} to={l.to} className="block text-white/70 text-[11px] hover:text-white/60 transition-colors">
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
