import { Link } from 'react-router-dom';
import { UNISWAP_BUY_URL, ETHERSCAN_TOKEN, DEXSCREENER_URL, TOWELI_ADDRESS } from '../../lib/constants';
import { shortenAddress } from '../../lib/formatting';

export function Footer() {
  return (
    <footer className="relative mt-8">
      <div className="max-w-[1200px] mx-auto px-6">
        {/* Gold divider */}
        <div className="gold-divider" />

        {/* Top section */}
        <div className="pt-12 pb-8 grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Brand */}
          <div>
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
                { href: DEXSCREENER_URL, label: 'DexScreener' },
              ].map((l) => (
                <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
                  className="block text-white/30 text-[13px] hover:text-primary transition-colors">
                  {l.label} <span className="text-white/15">↗</span>
                </a>
              ))}
            </div>
            <div className="mt-4 rounded-lg p-3 inline-block" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
              <p className="text-white/30 text-[10px] uppercase tracking-wider mb-1">Contract</p>
              <a href={`https://etherscan.io/token/${TOWELI_ADDRESS}`} target="_blank" rel="noopener noreferrer"
                className="font-mono text-[12px] text-primary hover:opacity-80 transition-opacity">
                {shortenAddress(TOWELI_ADDRESS, 6)}
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
            © 2025 Tegridy Farms
          </span>
        </div>
      </div>
    </footer>
  );
}
