import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { ART, GALLERY_ORDER } from '../lib/artConfig';
import { useFarmStats } from '../hooks/useFarmStats';
import { usePoolData } from '../hooks/usePoolData';
import { useRevenueStats } from '../hooks/useRevenueStats';
import { Sparkline } from '../components/Sparkline';
import { PulseDot } from '../components/PulseDot';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { formatCurrency } from '../lib/formatting';
import { FlashValue } from '../components/FlashValue';
import { ReferralWidget } from '../components/ReferralWidget';
import { usePageTitle } from '../hooks/usePageTitle';

export default function HomePage() {
  usePageTitle('Home', 'Earn ETH yields on Ethereum. Stake TOWELI & earn 100% of protocol revenue.');
  const { address } = useAccount();
  const stats = useFarmStats();
  const pool = usePoolData();
  const revenueStats = useRevenueStats();
  const price = useTOWELIPrice();
  const priceHistory = usePriceHistory(price.priceInUsd);
  const { history: priceData, error: priceError } = priceHistory;

  // Use PriceContext price (useToweliPrice already fetches from GeckoTerminal as fallback)
  const effectiveToweliPrice = price.priceInUsd > 0 ? formatCurrency(price.priceInUsd, 6) : stats.toweliPrice;

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.galleryCollage.src} alt="" className="w-full h-full object-cover object-center" />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6">
        <div className="pt-28 pb-20">
          <motion.div className="max-w-xl" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <div className="badge badge-primary mb-5 text-[10px]">LIVE ON ETHEREUM</div>

            <h1 className="heading-luxury text-3xl md:text-6xl text-white leading-[1.1] tracking-tight mb-4">
              Yield with<br /><span className="text-white">Tegridy Farms</span>
            </h1>

            <p className="text-white text-base md:text-lg mb-6 max-w-md leading-relaxed">
              Stake TOWELI & LP tokens to earn rewards. 100% of protocol revenue goes to stakers.
            </p>

            <div className="flex flex-wrap gap-3">
              <ConnectButton.Custom>
                {({ account, chain, openConnectModal, mounted }) => {
                  const connected = mounted && account && chain;
                  return (
                    <div {...(!mounted && { 'aria-hidden': true, style: { opacity: 0, pointerEvents: 'none' } })}>
                      {!connected ? (
                        <button onClick={openConnectModal} className="btn-primary px-7 py-2.5 text-[14px]">
                          Connect Wallet
                        </button>
                      ) : (
                        <Link to="/farm" className="btn-primary px-7 py-2.5 text-[14px] inline-block text-center">
                          Start Farming
                        </Link>
                      )}
                    </div>
                  );
                }}
              </ConnectButton.Custom>
              <Link to="/swap"
                className="px-7 py-2.5 text-[14px] font-semibold rounded-lg transition-all inline-block text-center"
                style={{ background: 'linear-gradient(135deg, #d4a843 0%, #b8892e 100%)', color: '#0a0a0f' }}>
                Buy TOWELI
              </Link>
            </div>
          </motion.div>

          <motion.div className="mt-14 flex flex-wrap gap-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
            {[
              { l: 'TVL', v: stats.tvl },
              { l: 'TOWELI Price', v: effectiveToweliPrice || '–', showSparkline: true },
              { l: 'Base APR', v: pool.isDeployed && pool.apr !== '0' ? `${pool.apr}%` : '–' },
              { l: 'ETH Distributed', v: revenueStats.totalDistributed > 0 ? `${revenueStats.totalDistributed.toFixed(4)} ETH` : '–' },
            ].map((s) => (
              <div key={s.l} className="glass-card flex items-center gap-3 px-4 py-2.5">
                <span className="text-white text-[12px] flex items-center gap-1.5">{s.l}{s.showSparkline && <PulseDot size={5} />}</span>
                {s.showSparkline ? (
                  <FlashValue value={price.priceInUsd}>
                    <span className="stat-value text-white text-[13px]">{(!s.v || s.v === '–') ? <span className="inline-block w-16 h-4 rounded bg-black/60 shimmer" /> : s.v}</span>
                  </FlashValue>
                ) : (
                  <span className="stat-value text-white text-[13px]">{(!s.v || s.v === '–') ? <span className="inline-block w-16 h-4 rounded bg-black/60 shimmer" /> : s.v}</span>
                )}
                {s.showSparkline && priceData.length > 1 && (
                  <Sparkline data={priceData} width={48} height={16} />
                )}
                {s.showSparkline && priceError && priceData.length === 0 && (
                  <span className="text-white text-[10px]">Price data unavailable</span>
                )}
              </div>
            ))}
          </motion.div>
        </div>

        {/* Protocol Overview */}
        <div className="pb-16">
          <motion.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="heading-luxury text-2xl text-white tracking-tight mb-1">Protocol Overview</h2>
            <p className="text-white text-[13px]">Farm, swap, and track your positions.</p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { to: '/swap', title: 'Swap', desc: 'Trade ETH ↔ TOWELI via Uniswap V2 with custom slippage controls.', stat: 'Uniswap V2', label: 'Router', art: ART.mumuBull.src },
              { to: '/farm', title: 'Farm', desc: 'Stake TOWELI or LP tokens across two active pools to earn yield.', stat: '2', label: 'Active Pools', art: ART.poolParty.src },
              { to: '/dashboard', title: 'Dashboard', desc: 'Track your portfolio, positions, claimable rewards, and projections.', stat: 'Real-time', label: 'On-chain Data', art: ART.towelieWindow.src },
            ].map((f, i) => (
              <motion.div key={f.title} initial={{ opacity: 0, y: 40, scale: 0.9 }} whileInView={{ opacity: 1, y: 0, scale: 1 }}
                viewport={{ once: true, margin: '-50px' }} transition={{ delay: i * 0.15, type: 'spring', damping: 20, stiffness: 100 }}>
                <Link to={f.to} className="block group relative rounded-xl overflow-hidden glass-card-animated card-hover" style={{ border: '1px solid var(--color-purple-75)' }}>
                  <div className="absolute inset-0">
                    <img src={f.art} alt="" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
                  </div>
                  <div className="relative z-10 p-6 min-h-[220px] flex flex-col">
                    <h3 className="heading-luxury text-[17px] text-white mb-2 group-hover:text-white transition-colors">{f.title}</h3>
                    <p className="text-white text-[13px] leading-relaxed mb-auto">{f.desc}</p>
                    <div className="pt-4 flex items-center justify-between mt-4" style={{ borderTop: '1px solid var(--color-purple-75)' }}>
                      <span className="stat-value text-white text-[16px]">{f.stat}</span>
                      <span className="text-white text-[11px] uppercase tracking-wider label-pill">{f.label}</span>
                    </div>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>

        {/* How It Works */}
        <div className="pb-16">
          <motion.div initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="heading-luxury text-xl text-white tracking-tight mb-6 text-center">How It Works</h2>
          </motion.div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { step: '1', title: 'Buy TOWELI', desc: 'Swap ETH for TOWELI on our DEX with smart routing across 9 sources.', to: '/swap' },
              { step: '2', title: 'Stake & Lock', desc: 'Lock 7 days to 4 years. Longer lock = higher boost (up to 4.5x with NFT).', to: '/farm' },
              { step: '3', title: 'Earn ETH Revenue', desc: '100% of protocol fees distributed to stakers as ETH. Claim anytime.', to: '/dashboard' },
            ].map((s, i) => (
              <motion.div key={s.step} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.1 }}>
                <Link to={s.to} className="block glass-card rounded-xl p-5 hover:border-emerald-600/30 transition-colors" style={{ border: '1px solid var(--color-purple-12)' }}>
                  <span className="inline-block w-8 h-8 rounded-full bg-emerald-600/20 border border-emerald-600/40 text-emerald-400 text-[14px] font-bold flex items-center justify-center mb-3">{s.step}</span>
                  <h3 className="text-white text-[15px] font-semibold mb-1">{s.title}</h3>
                  <p className="text-white/60 text-[12px] leading-relaxed">{s.desc}</p>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Trust Badges */}
        <div className="pb-16">
          <div className="flex flex-wrap justify-center gap-3">
            {[
              { label: '82 Findings Resolved', to: '/security' },
              { label: 'Contracts Verified', to: '/security' },
              { label: 'Bug Bounty Active', to: '/security' },
              { label: 'Open Source', href: 'https://github.com/fomotsar-commits/tegridy-farms' },
            ].map((b) => (
              'href' in b ? (
                <a key={b.label} href={b.href} target="_blank" rel="noopener noreferrer"
                  className="glass-card px-4 py-2 rounded-lg text-white/60 text-[11px] hover:text-white transition-colors flex items-center gap-1.5">
                  <span className="text-emerald-400">&#10003;</span> {b.label}
                </a>
              ) : (
                <Link key={b.label} to={b.to}
                  className="glass-card px-4 py-2 rounded-lg text-white/60 text-[11px] hover:text-white transition-colors flex items-center gap-1.5">
                  <span className="text-emerald-400">&#10003;</span> {b.label}
                </Link>
              )
            ))}
          </div>
        </div>

        {/* Ecosystem */}
        <div className="pb-16">
          <h2 className="heading-luxury text-xl text-white tracking-tight mb-1">Ecosystem</h2>
          <p className="text-white text-[12px] mb-5">The Jungle Bay universe</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <motion.div initial={{ opacity: 0, y: 40, scale: 0.9 }} whileInView={{ opacity: 1, y: 0, scale: 1 }} viewport={{ once: true, margin: '-50px' }} transition={{ delay: 0, type: 'spring', damping: 20, stiffness: 100 }}>
            <a href="https://opensea.io/collection/junglebay" target="_blank" rel="noopener noreferrer"
              className="relative overflow-hidden rounded-xl glass-card-animated group block" style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0">
                <img src={ART.apeHug.src} alt="" className="w-full h-full object-cover" loading="lazy" />
              </div>
              <div className="relative z-10 p-5">
                <p className="text-white text-[14px] font-semibold group-hover:text-white transition-colors mb-1">JBAC NFTs</p>
                <p className="text-white text-[12px]">5,555 customizable apes. The genesis collection that started it all.</p>
              </div>
            </a>
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 40, scale: 0.9 }} whileInView={{ opacity: 1, y: 0, scale: 1 }} viewport={{ once: true, margin: '-50px' }} transition={{ delay: 0.15, type: 'spring', damping: 20, stiffness: 100 }}>
            <a href="https://app.uniswap.org/swap?chain=base" target="_blank" rel="noopener noreferrer"
              className="relative overflow-hidden rounded-xl glass-card-animated group block" style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0">
                <img src={ART.beachSunset.src} alt="" className="w-full h-full object-cover" loading="lazy" />
              </div>
              <div className="relative z-10 p-5">
                <p className="text-white text-[14px] font-semibold group-hover:text-white transition-colors mb-1">$JBM on Base</p>
                <p className="text-white text-[12px]">The accidental community token. Born from a bot glitch, adopted by the degens.</p>
              </div>
            </a>
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 40, scale: 0.9 }} whileInView={{ opacity: 1, y: 0, scale: 1 }} viewport={{ once: true, margin: '-50px' }} transition={{ delay: 0.3, type: 'spring', damping: 20, stiffness: 100 }}>
            <Link to="/lore" className="relative overflow-hidden rounded-xl glass-card-animated group block" style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0">
                <img src={ART.jungleDark.src} alt="" className="w-full h-full object-cover" loading="lazy" />
              </div>
              <div className="relative z-10 p-5">
                <p className="text-white text-[14px] font-semibold group-hover:text-white transition-colors mb-1">The Story</p>
                <p className="text-white text-[12px]">From rug to riches. How we became the blueprint for community-built DeFi.</p>
              </div>
            </Link>
            </motion.div>
          </div>
        </div>

        {/* Art Preview (moved below ecosystem) */}
        <div className="pb-16">
          <div className="flex items-end justify-between mb-6">
            <div>
              <h2 className="heading-luxury text-xl text-white tracking-tight">The Collection</h2>
              <p className="text-white text-[12px] mt-0.5">{GALLERY_ORDER.length} original pieces</p>
            </div>
            <Link to="/gallery" className="text-white text-[13px] font-medium hover:opacity-80 transition-opacity">
              View all →
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {GALLERY_ORDER.slice(0, 4).map((piece, i) => (
              <motion.div key={piece.src} initial={{ opacity: 0, y: 25, scale: 0.85 }} whileInView={{ opacity: 1, y: 0, scale: 1 }}
                viewport={{ once: true, margin: '-50px' }} transition={{ delay: i * 0.15, type: 'spring', damping: 20, stiffness: 100 }}>
                <Link to="/gallery" className="block group">
                  <div className="rounded-xl aspect-square relative overflow-hidden glass-card-animated card-hover" style={{ border: '1px solid var(--color-purple-75)' }}>
                    <img src={piece.src} alt={piece.title}
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/35 transition-all flex items-end">
                      <div className="w-full p-3 opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ background: 'linear-gradient(to top, rgba(6,12,26,0.8) 0%, transparent 100%)' }}>
                        <span className="text-[12px] text-white font-medium">{piece.title}</span>
                      </div>
                    </div>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Referral Widget for connected users */}
        {address && (
          <div className="pb-16">
            <ReferralWidget
              address={address}
              referredCount={revenueStats.referredCount}
              referralEarned={revenueStats.referralEarned}
              referralPending={revenueStats.referralPending}
            />
          </div>
        )}
      </div>
    </div>
  );
}
