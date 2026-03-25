import { Link } from 'react-router-dom';
import { UNISWAP_BUY_URL, ETHERSCAN_TOKEN, GECKOTERMINAL_URL, TOWELI_ADDRESS } from '../../lib/constants';
import { shortenAddress } from '../../lib/formatting';
import { CopyButton } from '../ui/CopyButton';

export function Footer() {
  return (
    <footer className="relative mt-8">
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        {/* Gold divider */}
        <div className="gold-divider" />

        {/* Top section */}
        <div className="pt-12 pb-8 grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <span className="heading-luxury text-[18px]">
                <span className="text-primary">TEGRIDY</span>{' '}
                <span className="text-white">FARMS</span>
              </span>
            </div>
            <p className="text-white/40 text-[13px] leading-relaxed max-w-[280px]">
              Art-first yield farming on Ethereum. Stake TOWELI & LP tokens to earn rewards. 100% of protocol revenue goes to stakers.
            </p>
          </div>

          {/* Navigation */}
          <div>
            <h4 className="text-primary/60 text-[11px] uppercase tracking-wider font-semibold mb-3">Protocol</h4>
            <div className="space-y-2">
              {[
                { to: '/farm', label: 'Farm' },
                { to: '/swap', label: 'Swap' },
                { to: '/dashboard', label: 'Dashboard' },
                { to: '/gallery', label: 'Gallery' },
                { to: '/tokenomics', label: 'Tokenomics' },
                { to: '/bounties', label: 'Bounties' },
                { to: '/restake', label: 'Restake' },
              ].map((l) => (
                <Link key={l.to} to={l.to} className="block text-white/30 text-[13px] hover:text-primary transition-colors">
                  {l.label}
                </Link>
              ))}
            </div>
          </div>

          {/* Resources */}
          <div>
            <h4 className="text-primary/60 text-[11px] uppercase tracking-wider font-semibold mb-3">Resources</h4>
            <div className="space-y-2">
              {[
                { href: UNISWAP_BUY_URL, label: 'Trade on Uniswap' },
                { href: ETHERSCAN_TOKEN, label: 'Etherscan' },
                { href: GECKOTERMINAL_URL, label: 'GeckoTerminal' },
              ].map((l) => (
                <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
                  className="block text-white/30 text-[13px] hover:text-primary transition-colors">
                  {l.label} <span className="text-white/15">↗</span>
                </a>
              ))}
            </div>
            <div className="mt-4 rounded-lg p-3 inline-block" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
              <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">Contract</p>
              <CopyButton text={TOWELI_ADDRESS} display={shortenAddress(TOWELI_ADDRESS, 6)}
                className="font-mono text-[12px] text-primary" />
            </div>
          </div>

          {/* Social */}
          <div>
            <h4 className="text-primary/60 text-[11px] uppercase tracking-wider font-semibold mb-3">Social</h4>
            <div className="space-y-2">
              <a href="https://x.com/junglebayac" target="_blank" rel="noopener noreferrer"
                className="block text-white/30 text-[13px] hover:text-primary transition-colors">
                Twitter / X <span className="text-white/15">↗</span>
              </a>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="gold-divider" />
        <div className="py-5 flex flex-col md:flex-row items-center justify-between gap-3">
          <span className="text-white/20 text-[11px]">
            Unaudited experimental protocol. Use at your own risk. Not financial advice.
          </span>
          <span className="text-white/15 text-[11px]">
            © 2026 Tegridy Farms
          </span>
        </div>
      </div>
    </footer>
  );
}
