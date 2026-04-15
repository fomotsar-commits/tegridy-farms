import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ART } from '../../lib/artConfig';
import { formatTokenAmount } from '../../lib/formatting';
import { parseEther } from 'viem';
import type { useLPFarming } from '../../hooks/useLPFarming';

type LPFarmHook = ReturnType<typeof useLPFarming>;

interface LPFarmingSectionProps {
  lpFarm: LPFarmHook;
  isConnected: boolean;
}

export function LPFarmingSection({ lpFarm, isConnected }: LPFarmingSectionProps) {
  const [lpStakeAmount, setLpStakeAmount] = useState('');
  const [lpWithdrawAmount, setLpWithdrawAmount] = useState('');

  // Clear LP inputs only after transaction confirms
  useEffect(() => {
    if (lpFarm.isSuccess) {
      setLpStakeAmount('');
      setLpWithdrawAmount('');
    }
  }, [lpFarm.isSuccess]);

  // Loading skeleton
  if (lpFarm.isDeployed && lpFarm.isReadLoading) {
    return (
      <motion.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <div className="h-6 w-40 rounded bg-white/10 animate-pulse" />
            <div className="h-4 w-64 rounded bg-white/10 animate-pulse mt-1.5" />
          </div>
        </div>
        <div className="rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(139,92,246,0.15)' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.15)' }}>
                <div className="h-3 w-20 rounded bg-white/10 animate-pulse mb-2" />
                <div className="h-5 w-24 rounded bg-white/10 animate-pulse" />
              </div>
            ))}
          </div>
          <div className="h-10 w-full rounded-lg bg-white/10 animate-pulse" />
        </div>
      </motion.div>
    );
  }

  if (!lpFarm.isDeployed || lpFarm.isReadLoading) return null;

  return (
    <motion.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="heading-luxury text-white text-[22px] tracking-tight">LP Farming</h2>
          <p className="text-white text-[13px] mt-0.5">Stake LP tokens &middot; earn TOWELI rewards</p>
        </div>
        {lpFarm.isActive && <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-500/20 text-green-400 border border-green-500/30">LIVE</span>}
      </div>

      <div className="relative overflow-hidden rounded-xl glass-card-animated" style={{ border: '1px solid rgba(139,92,246,0.75)' }}>
        <div className="absolute inset-0">
          <img src={ART.smokingDuo.src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 30%' }} />
        </div>
        <div className="relative z-10 p-6">
          {/* Stats row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
              <p className="text-white text-[10px] mb-0.5">Total LP Staked</p>
              <p className="stat-value text-[14px] text-white font-mono">{formatTokenAmount(lpFarm.totalStakedFormatted)}</p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
              <p className="text-white text-[10px] mb-0.5">Reward Rate</p>
              <p className="stat-value text-[14px] text-white font-mono">{formatTokenAmount(String(lpFarm.rewardRatePerDay))} / day</p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
              <p className="text-white text-[10px] mb-0.5">Total Funded</p>
              <p className="stat-value text-[14px] text-white font-mono">{formatTokenAmount(lpFarm.totalRewardsFundedFormatted)} TOWELI</p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
              <p className="text-white text-[10px] mb-0.5">Period Ends</p>
              <p className="stat-value text-[14px] text-white font-mono">
                {lpFarm.periodFinish > 0 ? new Date(lpFarm.periodFinish * 1000).toLocaleDateString() : '–'}
              </p>
            </div>
          </div>

          {!isConnected ? (
            <div className="text-center py-8">
              <p className="text-white text-sm mb-3">Connect wallet to stake LP tokens</p>
              <ConnectButton />
            </div>
          ) : (
            <>
              {/* User position */}
              {lpFarm.stakedBalance > 0n && (
                <div className="rounded-lg p-4 mb-4" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)' }}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="text-white text-[10px]">Your Staked LP</p>
                      <p className="text-white font-mono text-[14px]">{formatTokenAmount(lpFarm.stakedBalanceFormatted)}</p>
                    </div>
                    <div>
                      <p className="text-white text-[10px]">Pending Rewards</p>
                      <p className="text-green-400 font-mono text-[14px]">{formatTokenAmount(lpFarm.pendingRewardFormatted)} TOWELI</p>
                    </div>
                    <div>
                      <p className="text-white text-[10px]">Wallet LP</p>
                      <p className="text-white font-mono text-[14px]">{formatTokenAmount(lpFarm.walletLPBalanceFormatted)}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-4">
                    <button
                      className="btn-primary flex-1 py-2 text-sm rounded-lg"
                      disabled={lpFarm.pendingReward === 0n || lpFarm.isPending || lpFarm.isConfirming}
                      onClick={() => { lpFarm.claim(); }}
                    >
                      {lpFarm.isPending || lpFarm.isConfirming ? 'Claiming...' : 'Claim Rewards'}
                    </button>
                    <button
                      className="btn-secondary flex-1 py-2 text-sm rounded-lg"
                      disabled={lpFarm.stakedBalance === 0n || lpFarm.isPending || lpFarm.isConfirming}
                      onClick={() => { lpFarm.exit(); }}
                    >
                      Exit (Withdraw All + Claim)
                    </button>
                  </div>
                </div>
              )}

              {/* Stake / Withdraw inputs */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Stake */}
                <div className="rounded-lg p-4" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                  <p className="text-white text-[11px] mb-2 font-semibold uppercase tracking-wider label-pill">Stake LP</p>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="number" inputMode="decimal"
                      placeholder="0.0"
                      value={lpStakeAmount}
                      onChange={e => setLpStakeAmount(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
                      className="flex-1 bg-black/60 border border-white/25 rounded-lg px-3 py-2 min-h-[44px] text-white text-[16px] font-mono"
                    />
                    <button
                      className="text-[10px] text-white/60 hover:text-white"
                      onClick={() => setLpStakeAmount(lpFarm.walletLPBalanceFormatted)}
                    >MAX</button>
                  </div>
                  <p className="text-white text-[10px] mb-2 font-mono">Wallet: {formatTokenAmount(lpFarm.walletLPBalanceFormatted)} LP</p>
                  {(() => {
                    const amt = parseFloat(lpStakeAmount) || 0;
                    let needsApproval = false;
                    try { needsApproval = amt > 0 && lpFarm.lpAllowance < parseEther(lpStakeAmount || '0'); } catch { /* invalid input */ }
                    return needsApproval ? (
                      <button
                        className="btn-secondary w-full py-2 text-sm rounded-lg"
                        disabled={lpFarm.isPending || lpFarm.isConfirming}
                        onClick={() => lpFarm.approveLP(lpStakeAmount)}
                      >
                        {lpFarm.isPending || lpFarm.isConfirming ? 'Approving...' : 'Approve LP'}
                      </button>
                    ) : (
                      <button
                        className="btn-primary w-full py-2 text-sm rounded-lg"
                        disabled={amt <= 0 || lpFarm.isPending || lpFarm.isConfirming}
                        onClick={() => { lpFarm.stake(lpStakeAmount); }}
                      >
                        {lpFarm.isPending || lpFarm.isConfirming ? 'Staking...' : 'Stake'}
                      </button>
                    );
                  })()}
                </div>

                {/* Withdraw */}
                <div className="rounded-lg p-4" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                  <p className="text-white text-[11px] mb-2 font-semibold uppercase tracking-wider label-pill">Withdraw LP</p>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="number" inputMode="decimal"
                      placeholder="0.0"
                      value={lpWithdrawAmount}
                      onChange={e => setLpWithdrawAmount(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
                      className="flex-1 bg-black/60 border border-white/25 rounded-lg px-3 py-2 min-h-[44px] text-white text-[16px] font-mono"
                    />
                    <button
                      className="text-[10px] text-white/60 hover:text-white"
                      onClick={() => setLpWithdrawAmount(lpFarm.stakedBalanceFormatted)}
                    >MAX</button>
                  </div>
                  <p className="text-white text-[10px] mb-2 font-mono">Staked: {formatTokenAmount(lpFarm.stakedBalanceFormatted)} LP</p>
                  <button
                    className="btn-secondary w-full py-2 text-sm rounded-lg"
                    disabled={(parseFloat(lpWithdrawAmount) || 0) <= 0 || lpFarm.stakedBalance === 0n || lpFarm.isPending || lpFarm.isConfirming}
                    onClick={() => { lpFarm.withdraw(lpWithdrawAmount); }}
                  >
                    {lpFarm.isPending || lpFarm.isConfirming ? 'Withdrawing...' : 'Withdraw'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}
