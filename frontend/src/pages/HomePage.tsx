import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ART, GALLERY_ORDER } from '../lib/artConfig';
import { useFarmStats } from '../hooks/useFarmStats';

export default function HomePage() {
  const stats = useFarmStats();

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.galleryCollage.src} alt="" className="w-full h-full object-cover object-center" />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.15) 25%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0.55) 75%, rgba(0,0,0,0.75) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-6">
        <div className="pt-28 pb-20">
          <motion.div className="max-w-xl" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <div className="badge badge-primary mb-5 text-[10px]">LIVE ON ETHEREUM</div>

            <h1 className="heading-luxury text-4xl md:text-6xl text-white leading-[1.1] tracking-tight mb-4">
              Yield with<br /><span className="text-primary">Tegridy Farms</span>
            </h1>

            <p className="text-white/60 text-base md:text-lg mb-8 max-w-md leading-relaxed">
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
              <Link to="/swap" className="btn-secondary px-7 py-2.5 text-[14px]">Buy TOWELI</Link>
            </div>
          </motion.div>

          <motion.div className="mt-14 flex flex-wrap gap-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
            {[
              { l: 'TVL', v: stats.tvl },
              { l: 'TOWELI Price', v: stats.toweliPrice },
              { l: 'Rewards Paid', v: stats.rewardsDistributed },
            ].map((s) => (
              <div key={s.l} className="flex items-center gap-3 px-4 py-2.5 rounded-lg"
                style={{ background: 'rgba(6,12,26,0.82)', backdropFilter: 'blur(12px)', border: '1px solid rgba(139,92,246,0.12)' }}>
                <span className="text-white/40 text-[12px]">{s.l}</span>
                <span className="stat-value text-white text-[13px]">{s.v}</span>
              </div>
            ))}
          </motion.div>
        </div>

        {/* Protocol Overview */}
        <div className="pb-16">
          <motion.div className="mb-10" initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="heading-luxury text-2xl text-white tracking-tight mb-1">Protocol Overview</h2>
            <p className="text-white/40 text-[13px]">Farm, swap, and track your positions.</p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { to: '/swap', title: 'Swap', desc: 'Trade ETH ↔ TOWELI via Uniswap V2 with custom slippage controls.', stat: 'Uniswap V2', label: 'Router', art: ART.mumuBull.src },
              { to: '/farm', title: 'Farm', desc: 'Stake TOWELI or LP tokens across two active pools to earn yield.', stat: '2', label: 'Active Pools', art: ART.poolParty.src },
              { to: '/dashboard', title: 'Dashboard', desc: 'Track your portfolio, positions, claimable rewards, and projections.', stat: 'Real-time', label: 'On-chain Data', art: ART.towelieWindow.src },
            ].map((f, i) => (
              <motion.div key={f.title} initial={{ opacity: 0, y: 15 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }} transition={{ delay: i * 0.08 }}>
                <Link to={f.to} className="block group relative rounded-xl overflow-hidden" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
                  <div className="absolute inset-0">
                    <img src={f.art} alt="" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                    <div className="absolute inset-0" style={{
                      background: 'linear-gradient(to bottom, rgba(6,12,26,0.4) 0%, rgba(6,12,26,0.8) 50%, rgba(6,12,26,0.95) 100%)',
                    }} />
                  </div>
                  <div className="relative z-10 p-6 min-h-[220px] flex flex-col">
                    <h3 className="heading-luxury text-[17px] text-white mb-2 group-hover:text-primary transition-colors">{f.title}</h3>
                    <p className="text-white/50 text-[13px] leading-relaxed mb-auto">{f.desc}</p>
                    <div className="pt-4 flex items-center justify-between mt-4" style={{ borderTop: '1px solid rgba(139,92,246,0.10)' }}>
                      <span className="stat-value text-primary text-[16px]">{f.stat}</span>
                      <span className="text-white/30 text-[11px] uppercase tracking-wider">{f.label}</span>
                    </div>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Art Preview */}
        <div className="pb-16">
          <div className="flex items-end justify-between mb-6">
            <div>
              <h2 className="heading-luxury text-xl text-white tracking-tight">The Collection</h2>
              <p className="text-white/40 text-[12px] mt-0.5">{GALLERY_ORDER.length} original pieces</p>
            </div>
            <Link to="/gallery" className="text-primary text-[13px] font-medium hover:opacity-80 transition-opacity">
              View all →
            </Link>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {GALLERY_ORDER.slice(0, 4).map((piece, i) => (
              <motion.div key={piece.src} initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }} transition={{ delay: i * 0.06 }}>
                <Link to="/gallery" className="block group">
                  <div className="rounded-xl aspect-square relative overflow-hidden" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
                    <img src={piece.src} alt={piece.title}
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/35 transition-all flex items-end">
                      <div className="w-full p-3 opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ background: 'linear-gradient(to top, rgba(6,12,26,0.8) 0%, transparent 100%)' }}>
                        <span className="text-[12px] text-white/90 font-medium">{piece.title}</span>
                      </div>
                    </div>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
