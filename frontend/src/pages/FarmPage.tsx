import { useState } from 'react';
import { motion } from 'framer-motion';
import { PoolCard } from '../components/farm/PoolCard';
import { ART } from '../lib/artConfig';
import { TOWELI_WETH_LP_ADDRESS, TOWELI_ADDRESS } from '../lib/constants';
import { useFarmStats } from '../hooks/useFarmStats';
import { usePoolData } from '../hooks/usePoolData';

export default function FarmPage() {
  const stats = useFarmStats();
  const lpPool = usePoolData(0n);
  const toweliPool = usePoolData(1n);

  const [calcAmount, setCalcAmount] = useState('10000');
  const [calcPool, setCalcPool] = useState<'lp' | 'staking'>('lp');

  const lpApr = lpPool.isDeployed ? parseFloat(lpPool.apr) : 0;
  const stakingApr = toweliPool.isDeployed ? parseFloat(toweliPool.apr) : 0;
  const apr = calcPool === 'lp' ? lpApr : stakingApr;

  const amtNum = parseFloat(calcAmount);
  const isValidCalcInput = !isNaN(amtNum) && amtNum > 0;
  const daily = isValidCalcInput ? (amtNum * apr / 100) / 365 : 0;

  const formatApr = (pool: typeof lpPool) => pool.isDeployed ? `${pool.apr}%` : '–';

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.jungleBus.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 15%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.2) 30%, rgba(0,0,0,0.35) 60%, rgba(0,0,0,0.6) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-20 pb-12">
        <motion.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Farm</h1>
          <p className="text-white/50 text-[14px]">Stake tokens and earn TOWELI rewards</p>
        </motion.div>

        {/* Stats */}
        <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          {[
            { l: 'Total Value Locked', v: stats.tvl, sub: 'Across all pools', art: ART.mfersHeaven.src },
            { l: 'TOWELI Price', v: stats.toweliPrice, sub: 'Live', art: ART.towelieWindow.src },
            { l: 'LP Pool APR', v: formatApr(lpPool), sub: 'TOWELI/ETH LP', accent: true, art: ART.mumuBull.src },
            { l: 'Staking APR', v: formatApr(toweliPool), sub: 'Single-sided', accent: true, art: ART.bobowelie.src },
          ].map((s) => (
            <div key={s.l} className="relative rounded-xl overflow-hidden" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
              <div className="absolute inset-0">
                <img src={s.art} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(6,12,26,0.7) 0%, rgba(6,12,26,0.88) 100%)' }} />
              </div>
              <div className="relative z-10 p-4">
                <p className="text-white/40 text-[11px] uppercase tracking-wider mb-1.5">{s.l}</p>
                <p className={`stat-value text-xl ${s.accent ? 'text-primary' : 'text-white'}`}>{s.v}</p>
                <p className="text-white/30 text-[11px] mt-0.5">{s.sub}</p>
              </div>
            </div>
          ))}
        </motion.div>

        {/* Low rewards warning */}
        {lpPool.isDeployed && lpPool.rewardsLow && (
          <motion.div className="rounded-xl p-4 mb-6" style={{ background: 'rgba(255,178,55,0.08)', border: '1px solid rgba(255,178,55,0.20)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <p className="text-warning text-[13px] font-semibold mb-1">Rewards Running Low</p>
            <p className="text-white/50 text-[12px]">
              Approximately {lpPool.daysRemaining} days of rewards remaining. The emission rate is being automatically throttled to prevent sudden depletion.
              Rewards will taper off gradually until the farm is topped up.
            </p>
          </motion.div>
        )}

        {/* Active Pools */}
        <div className="flex items-center gap-2.5 mb-5">
          <h2 className="heading-luxury text-[17px] text-white">Active Pools</h2>
          <span className="badge badge-primary">2</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-12">
          {/* LP Pool */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <div className="relative rounded-xl overflow-hidden" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
              <div className="absolute inset-0">
                <img src={ART.poolParty.src} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-0" style={{
                  background: 'linear-gradient(to bottom, rgba(6,12,26,0.2) 0%, rgba(6,12,26,0.5) 30%, rgba(6,12,26,0.88) 60%, rgba(6,12,26,0.95) 100%)',
                }} />
              </div>
              <div className="relative z-10 p-5">
                <div className="flex items-end justify-between mb-36 md:mb-44">
                  <div>
                    <p className="text-white/40 text-[11px] font-medium mb-0.5">{ART.poolParty.title}</p>
                    <h3 className="heading-luxury text-white text-[22px]">TOWELI/ETH LP</h3>
                  </div>
                  <div className="text-right">
                    <p className="stat-value text-[28px] text-primary">{formatApr(lpPool)}</p>
                    <p className="text-white/40 text-[11px]">APR</p>
                  </div>
                </div>
                <PoolCard pid={0} name="TOWELI/ETH LP" subtitle="Provide liquidity, earn TOWELI rewards"
                  tokenSymbol="TOWELI-LP" lpTokenAddress={TOWELI_WETH_LP_ADDRESS}
                  allocPercent={60} icon="&#127807;" color="green" />
              </div>
            </div>
          </motion.div>

          {/* Staking Pool */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <div className="relative rounded-xl overflow-hidden" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
              <div className="absolute inset-0">
                <img src={ART.boxingRing.src} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-0" style={{
                  background: 'linear-gradient(to bottom, rgba(6,12,26,0.2) 0%, rgba(6,12,26,0.5) 30%, rgba(6,12,26,0.88) 60%, rgba(6,12,26,0.95) 100%)',
                }} />
              </div>
              <div className="relative z-10 p-5">
                <div className="flex items-end justify-between mb-36 md:mb-44">
                  <div>
                    <p className="text-white/40 text-[11px] font-medium mb-0.5">{ART.boxingRing.title}</p>
                    <h3 className="heading-luxury text-white text-[22px]">TOWELI Staking</h3>
                  </div>
                  <div className="text-right">
                    <p className="stat-value text-[28px] text-primary">{formatApr(toweliPool)}</p>
                    <p className="text-white/40 text-[11px]">APR</p>
                  </div>
                </div>
                <PoolCard pid={1} name="TOWELI Staking" subtitle="Stake TOWELI, earn TOWELI rewards"
                  tokenSymbol="TOWELI" lpTokenAddress={TOWELI_ADDRESS}
                  allocPercent={40} icon="&#129531;" color="green" />
              </div>
            </div>
          </motion.div>
        </div>

        {/* Calculator */}
        <motion.div initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <div className="relative rounded-xl overflow-hidden" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
            <div className="absolute inset-0">
              <img src={ART.chaosScene.src} alt="" className="w-full h-full object-cover" />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(6,12,26,0.75) 0%, rgba(6,12,26,0.9) 30%, rgba(6,12,26,0.95) 100%)' }} />
            </div>
            <div className="relative z-10 p-6">
            <div className="mb-6">
              <h3 className="heading-luxury text-white text-[20px]">Rewards Calculator</h3>
              <p className="text-white/40 text-[12px]">Estimate your earnings</p>
            </div>

            {!lpPool.isDeployed && (
              <div className="rounded-lg p-3 mb-4 text-[11px] text-white/50"
                style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
                Calculator will use live APR data once the farm is deployed.
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6">
              <div>
                <label className="text-white/40 text-[11px] uppercase tracking-wider mb-2 block">Stake Amount (TOWELI)</label>
                <input type="number" value={calcAmount} onChange={(e) => setCalcAmount(e.target.value)}
                  className={`w-full rounded-lg p-4 font-mono text-xl text-white outline-none token-input ${!isValidCalcInput && calcAmount ? 'border-danger/50' : ''}`}
                  style={{ background: 'rgba(139,92,246,0.04)', border: `1px solid ${!isValidCalcInput && calcAmount ? 'rgba(239,68,68,0.4)' : 'rgba(139,92,246,0.12)'}` }}
                  placeholder="0" min="0" />
                {!isValidCalcInput && calcAmount && (
                  <p className="text-danger text-[11px] mt-1">Enter a valid positive number</p>
                )}
              </div>
              <div>
                <label className="text-white/40 text-[11px] uppercase tracking-wider mb-2 block">Select Pool</label>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setCalcPool('lp')}
                    className="rounded-lg p-3 text-center cursor-pointer transition-all"
                    style={{
                      background: calcPool === 'lp' ? 'rgba(139,92,246,0.12)' : 'rgba(255,255,255,0.04)',
                      border: calcPool === 'lp' ? '1px solid rgba(139,92,246,0.3)' : '1px solid rgba(255,255,255,0.08)',
                    }}>
                    <p className="stat-value text-[15px] text-primary mb-0.5">{formatApr(lpPool)}</p>
                    <p className="text-white/40 text-[11px]">LP Pool</p>
                  </button>
                  <button onClick={() => setCalcPool('staking')}
                    className="rounded-lg p-3 text-center cursor-pointer transition-all"
                    style={{
                      background: calcPool === 'staking' ? 'rgba(139,92,246,0.12)' : 'rgba(255,255,255,0.04)',
                      border: calcPool === 'staking' ? '1px solid rgba(139,92,246,0.3)' : '1px solid rgba(255,255,255,0.08)',
                    }}>
                    <p className="stat-value text-[15px] text-primary mb-0.5">{formatApr(toweliPool)}</p>
                    <p className="text-white/40 text-[11px]">Staking</p>
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { l: 'Daily', v: daily },
                { l: 'Weekly', v: daily * 7 },
                { l: 'Monthly', v: daily * 30 },
                { l: 'Yearly', v: daily * 365 },
              ].map((p) => (
                <div key={p.l} className="rounded-lg p-4 text-center"
                  style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
                  <p className="text-white/40 text-[11px] mb-1.5">{p.l}</p>
                  <p className="stat-value text-xl text-primary">{isValidCalcInput && apr > 0 ? p.v.toFixed(2) : '–'}</p>
                  <p className="text-white/30 text-[10px] mt-1">TOWELI</p>
                </div>
              ))}
            </div>

            <p className="text-white/30 text-[11px] mt-5 text-center">
              Estimates based on current APR. Actual returns may vary with pool participation.
            </p>
          </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
