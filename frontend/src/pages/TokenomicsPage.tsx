import { motion } from 'framer-motion';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { usePoolData } from '../hooks/usePoolData';
import { useToweliPrice } from '../hooks/useToweliPrice';
import { ART } from '../lib/artConfig';
import {
  TOWELI_ADDRESS, TEGRIDY_FARM_ADDRESS, FEE_DISTRIBUTOR_ADDRESS,
  ETHERSCAN_TOKEN, UNISWAP_BUY_URL, DEXSCREENER_URL,
  TOWELI_TOTAL_SUPPLY,
} from '../lib/constants';
import { formatNumber, formatCurrency, shortenAddress } from '../lib/formatting';

const SUPPLY_DATA = [
  { name: 'Circulating', value: 65, color: '#8b5cf6' },
  { name: 'Staking Rewards', value: 20, color: '#ffb237' },
  { name: 'LP Rewards', value: 10, color: '#8b5cf6' },
  { name: 'Treasury', value: 5, color: '#ff4ea3' },
];

const CONTRACTS = [
  { label: 'TOWELI Token', address: TOWELI_ADDRESS, live: true },
  { label: 'TegridyFarm', address: TEGRIDY_FARM_ADDRESS, live: false },
  { label: 'FeeDistributor', address: FEE_DISTRIBUTOR_ADDRESS, live: false },
];

export default function TokenomicsPage() {
  const price = useToweliPrice();
  const lpPool = usePoolData(0n);

  const rewardPerDay = parseFloat(lpPool.rewardPerSecond) * 86400;
  const remaining = parseFloat(lpPool.totalRewardsRemaining);
  const daysLeft = rewardPerDay > 0 ? remaining / rewardPerDay : 0;

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0">
        <img src={ART.swordOfLove.src} alt="" className="w-full h-full object-cover object-top" />
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
            { l: 'Token', v: 'TOWELI' },
            { l: 'Total Supply', v: formatNumber(TOWELI_TOTAL_SUPPLY, 0) },
            { l: 'Price', v: formatCurrency(price.priceInUsd, 6) },
            { l: 'Market Cap', v: formatCurrency(TOWELI_TOTAL_SUPPLY * price.priceInUsd) },
          ].map((i) => (
            <div key={i.l} className="rounded-xl p-4" style={{ background: 'rgba(6,12,26,0.82)', backdropFilter: 'blur(12px)', border: '1px solid rgba(139,92,246,0.12)' }}>
              <p className="text-white/40 text-[11px] uppercase tracking-wider mb-1">{i.l}</p>
              <p className="stat-value text-base text-white">{i.v}</p>
            </div>
          ))}
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
          {/* Chart */}
          <motion.div className="rounded-xl p-5" style={{ background: 'rgba(6,12,26,0.82)', backdropFilter: 'blur(12px)', border: '1px solid rgba(139,92,246,0.12)' }}
            initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
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
          </motion.div>

          {/* Emissions */}
          <motion.div className="rounded-xl p-5" style={{ background: 'rgba(6,12,26,0.82)', backdropFilter: 'blur(12px)', border: '1px solid rgba(139,92,246,0.12)' }}
            initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }}>
            <h3 className="heading-luxury text-[15px] text-white mb-3">Emission Schedule</h3>
            <div className="space-y-3">
              {[
                { l: 'Rewards / Day', v: lpPool.isDeployed ? `${formatNumber(rewardPerDay, 0)} TOWELI` : '–' },
                { l: 'Rewards / Second', v: lpPool.isDeployed ? `${parseFloat(lpPool.rewardPerSecond).toFixed(4)} TOWELI` : '–' },
                { l: 'Remaining', v: lpPool.isDeployed ? `${formatNumber(remaining, 0)} TOWELI` : '–' },
                { l: 'Est. Duration', v: lpPool.isDeployed && daysLeft > 0 ? `~${Math.floor(daysLeft)} days` : '–' },
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
          </motion.div>
        </div>

        {/* Contracts */}
        <motion.div className="rounded-xl p-5 mb-8" style={{ background: 'rgba(6,12,26,0.82)', backdropFilter: 'blur(12px)', border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
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
                <a href={`https://etherscan.io/address/${c.address}`} target="_blank" rel="noopener noreferrer"
                  className="font-mono text-[11px] text-primary hover:opacity-80 transition-opacity">
                  {shortenAddress(c.address, 6)}
                </a>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Links */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
          {[
            { href: UNISWAP_BUY_URL, label: 'Trade on Uniswap' },
            { href: ETHERSCAN_TOKEN, label: 'Etherscan' },
            { href: DEXSCREENER_URL, label: 'DexScreener' },
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
