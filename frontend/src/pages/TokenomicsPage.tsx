import { motion } from 'framer-motion';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { usePoolData } from '../hooks/usePoolData';
import { useToweliPrice } from '../hooks/useToweliPrice';
import { ART } from '../lib/artConfig';
import {
  TOWELI_ADDRESS, TEGRIDY_STAKING_ADDRESS, SWAP_FEE_ROUTER_ADDRESS,
  COMMUNITY_GRANTS_ADDRESS, MEME_BOUNTY_BOARD_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS,
  REFERRAL_SPLITTER_ADDRESS, PREMIUM_ACCESS_ADDRESS,
  ETHERSCAN_TOKEN, UNISWAP_BUY_URL, GECKOTERMINAL_URL,
  TOWELI_TOTAL_SUPPLY,
} from '../lib/constants';
import { formatNumber, shortenAddress } from '../lib/formatting';
import { CopyButton } from '../components/ui/CopyButton';
import { AnimatedCounter } from '../components/AnimatedCounter';
import { Sparkline } from '../components/Sparkline';
import { usePriceHistory } from '../hooks/usePriceHistory';

const SUPPLY_DATA = [
  { name: 'Circulating', value: 65, color: '#8b5cf6' },
  { name: 'Staking Rewards', value: 20, color: '#ffb237' },
  { name: 'LP Rewards', value: 10, color: '#8b5cf6' },
  { name: 'Treasury', value: 5, color: '#ff4ea3' },
];

const CONTRACTS = [
  { label: 'TOWELI Token', address: TOWELI_ADDRESS, live: true },
  { label: 'TegridyStaking', address: TEGRIDY_STAKING_ADDRESS, live: true },
  { label: 'SwapFeeRouter', address: SWAP_FEE_ROUTER_ADDRESS, live: true },
  { label: 'RevenueDistributor', address: REVENUE_DISTRIBUTOR_ADDRESS, live: true },
  { label: 'CommunityGrants', address: COMMUNITY_GRANTS_ADDRESS, live: true },
  { label: 'MemeBountyBoard', address: MEME_BOUNTY_BOARD_ADDRESS, live: true },
  { label: 'ReferralSplitter', address: REFERRAL_SPLITTER_ADDRESS, live: true },
  { label: 'PremiumAccess', address: PREMIUM_ACCESS_ADDRESS, live: true },
];

export default function TokenomicsPage() {
  const price = useToweliPrice();
  const pool = usePoolData();
  const priceHistory = usePriceHistory(price.priceInUsd);

  const rewardPerDay = parseFloat(pool.rewardPerSecond) * 86400;
  const totalFunded = parseFloat(pool.totalRewardsFunded);
  const daysLeft = rewardPerDay > 0 ? totalFunded / rewardPerDay : 0;

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0">
        <img src={ART.swordOfLove.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 25%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.25) 30%, rgba(0,0,0,0.4) 60%, rgba(0,0,0,0.6) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[1000px] mx-auto px-4 md:px-6 pt-20 pb-12">
        <motion.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Tokenomics</h1>
          <p className="text-white/50 text-[14px]">TOWELI token economics and protocol transparency</p>
        </motion.div>

        {/* Token info */}
        <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          {[
            { l: 'Token', v: 'TOWELI', art: ART.smokingDuo.src, pos: 'center 40%' },
            { l: 'Total Supply', v: '1B', art: ART.poolParty.src, pos: 'center 30%' },
            { l: 'Price', v: price.priceInUsd > 0 ? undefined : '–', numVal: price.priceInUsd, decimals: price.priceInUsd < 0.01 ? 8 : 6, prefix: '$', showSparkline: true, art: ART.mumuBull.src, pos: 'center 30%' },
            { l: 'FDV', v: price.priceInUsd > 0 ? undefined : '–', numVal: TOWELI_TOTAL_SUPPLY * price.priceInUsd, decimals: 2, prefix: '$', art: ART.bobowelie.src, pos: 'center 20%' },
          ].map((i) => (
            <div key={i.l} className="relative overflow-hidden rounded-xl" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
              <div className="absolute inset-0">
                <img src={i.art} alt="" className="w-full h-full object-cover" style={{ objectPosition: i.pos }} />
                <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(6,12,26,0.40) 0%, rgba(6,12,26,0.75) 50%, rgba(6,12,26,0.92) 100%)' }} />
              </div>
              <div className="relative z-10 p-5 pt-8 pb-6">
              <p className="text-white/50 text-[11px] uppercase tracking-wider mb-2">{i.l}</p>
              <div className="flex items-center gap-2">
                {i.v !== undefined ? (
                  <p className="stat-value text-2xl text-white">{i.v}</p>
                ) : (
                  <AnimatedCounter value={i.numVal!} prefix={i.prefix} decimals={i.decimals} className="stat-value text-2xl text-white" />
                )}
                {i.showSparkline && priceHistory.length > 1 && (
                  <Sparkline data={priceHistory} width={48} height={18} />
                )}
              </div>
              </div>
            </div>
          ))}
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
          {/* Chart */}
          <motion.div className="relative overflow-hidden rounded-xl" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
            initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
            <div className="absolute inset-0">
              <img src={ART.danceNight.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 15%' }} />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
            </div>
            <div className="relative z-10 p-5">
            <h3 className="heading-luxury text-[15px] text-white mb-3">Supply Distribution</h3>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={SUPPLY_DATA} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value" stroke="none">
                    {SUPPLY_DATA.map((e) => <Cell key={e.name} fill={e.color} />)}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: 'rgba(6,12,26,0.9)', border: '1px solid rgba(139,92,246,0.15)',
                      borderRadius: '8px', fontFamily: "'Inter', sans-serif", color: '#f0ead6', fontSize: '12px',
                    }}
                    formatter={(v) => `${v}%`}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-2 gap-1.5 mt-2">
              {SUPPLY_DATA.map((d) => (
                <div key={d.name} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                  <span className="text-white/40 text-[11px]">{d.name} · {d.value}%</span>
                </div>
              ))}
            </div>
            </div>
          </motion.div>

          {/* Emissions */}
          <motion.div className="relative overflow-hidden rounded-xl" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
            initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }}>
            <div className="absolute inset-0">
              <img src={ART.jbChristmas.src} alt="" className="w-full h-full object-cover" />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
            </div>
            <div className="relative z-10 p-5">
            <h3 className="heading-luxury text-[15px] text-white mb-3">Emission Schedule</h3>
            <div className="space-y-3">
              {[
                { l: 'Rewards / Day', v: pool.isDeployed ? `${formatNumber(rewardPerDay, 0)} TOWELI` : '–' },
                { l: 'Rewards / Second', v: pool.isDeployed ? `${parseFloat(pool.rewardPerSecond).toFixed(4)} TOWELI` : '–' },
                { l: 'Total Funded', v: pool.isDeployed ? `${formatNumber(totalFunded, 0)} TOWELI` : '–' },
                { l: 'Est. Duration', v: pool.isDeployed && daysLeft > 0 ? `~${Math.floor(daysLeft)} days` : '–' },
              ].map((r) => (
                <div key={r.l} className="flex items-center justify-between">
                  <span className="text-white/40 text-[13px]">{r.l}</span>
                  <span className="stat-value text-[13px] text-white">{r.v}</span>
                </div>
              ))}
              <div className="pt-3 gold-divider" />
              <p className="text-white/30 text-[11px] leading-relaxed pt-2">
                Rewards split: LP Pool (60%) + Staking Pool (40%). 100% of protocol revenue goes to stakers.
              </p>
            </div>
            </div>
          </motion.div>
        </div>

        {/* Community Treasury */}
        <motion.div className="relative overflow-hidden rounded-xl mb-8" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <div className="absolute inset-0">
            <img src={ART.beachVibes.src} alt="" className="w-full h-full object-cover" />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
          </div>
          <div className="relative z-10 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="heading-luxury text-[15px] text-white">Community Treasury</h3>
              <a href={`https://etherscan.io/address/${TEGRIDY_STAKING_ADDRESS}`} target="_blank" rel="noopener noreferrer"
                className="text-[11px] text-primary/60 hover:text-primary transition-colors">
                View on Etherscan &#8599;
              </a>
            </div>
            <p className="text-white/30 text-[12px] mb-3">
              100% of protocol revenue is distributed to stakers. The farm contract holds all staked tokens and manages reward distribution transparently on-chain.
            </p>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
                <p className="text-white/30 text-[10px] uppercase tracking-wider mb-0.5">Rewards Remaining</p>
                <p className="stat-value text-[13px] text-primary">{pool.totalRewardsFunded || '0'} TOWELI</p>
              </div>
              <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
                <p className="text-white/30 text-[10px] uppercase tracking-wider mb-0.5">Emission Rate</p>
                <p className="stat-value text-[13px] text-white">{(parseFloat(pool.rewardPerSecond) * 86400).toFixed(2)} / day</p>
              </div>
              <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
                <p className="text-white/30 text-[10px] uppercase tracking-wider mb-0.5">Est. Duration</p>
                <p className="stat-value text-[13px] text-white">{daysLeft > 0 ? `${daysLeft.toFixed(0)} days` : '–'}</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Contracts */}
        <motion.div className="relative overflow-hidden rounded-xl mb-8" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <div className="absolute inset-0">
            <img src={ART.jbacSkeleton.src} alt="" className="w-full h-full object-cover" />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
          </div>
          <div className="relative z-10 p-5">
            <h3 className="heading-luxury text-[15px] text-white mb-3">Contracts</h3>
            <div className="space-y-1.5">
              {CONTRACTS.map((c) => (
                <div key={c.label} className="rounded-lg p-3 flex items-center justify-between flex-wrap gap-2"
                  style={{ background: 'rgba(139,92,246,0.03)', border: '1px solid rgba(139,92,246,0.08)' }}>
                  <div className="flex items-center gap-2">
                    <span className="text-white/60 text-[13px]">{c.label}</span>
                    {c.live ? (
                      <span className="badge badge-success text-[9px]">Live</span>
                    ) : !c.live ? (
                      <span className="badge badge-warning text-[9px]">Deployed</span>
                    ) : null}
                  </div>
                  <CopyButton text={c.address} display={shortenAddress(c.address, 6)}
                    className="font-mono text-[11px] text-primary" />
                </div>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Links */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
          {[
            { href: UNISWAP_BUY_URL, label: 'Trade on Uniswap' },
            { href: ETHERSCAN_TOKEN, label: 'Etherscan' },
            { href: GECKOTERMINAL_URL, label: 'GeckoTerminal' },
          ].map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
              className="rounded-xl p-3.5 flex items-center justify-between group"
              style={{ background: 'rgba(6,12,26,0.82)', border: '1px solid rgba(139,92,246,0.12)', backdropFilter: 'blur(8px)' }}>
              <span className="text-white/50 text-[13px] group-hover:text-white transition-colors">{l.label}</span>
              <span className="text-white/30 text-[12px] group-hover:text-primary transition-colors">→</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
