import { useState, useEffect, useMemo } from 'react';
import { m } from 'framer-motion';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { formatTokenAmount, formatPercent, formatNumber, sanitizeDecimalInput } from '../../lib/formatting';
import { parseEther } from 'viem';
import type { useLPFarming } from '../../hooks/useLPFarming';
import { ILCalculator } from './ILCalculator';
import { ArtImg } from '../ArtImg';
import { Link } from 'react-router-dom';
import { usePoolTVL } from '../../hooks/usePoolTVL';
import { useTOWELIPrice } from '../../contexts/PriceContext';

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

  const poolTVL = usePoolTVL();
  const price = useTOWELIPrice();

  // Live LP-farming APR = annual TOWELI emissions (in USD) ÷ USD value of LP staked
  // in the farm. Honest and self-correcting: as more LP is staked the APR falls
  // toward steady state. Null when nothing is staked yet (an APR needs a non-zero
  // denominator) or while pool data is still loading — never a fabricated figure.
  const lpApr = useMemo(() => {
    const lpSupply = poolTVL.lpSupply;
    const staked = lpFarm.totalStaked;
    if (!poolTVL.isLoaded || lpSupply === 0n || staked === 0n || price.priceInUsd <= 0) return null;
    const stakedUsd = poolTVL.tvl * (Number(staked) / Number(lpSupply));
    if (!(stakedUsd > 0)) return null;
    const annualRewardsUsd = lpFarm.rewardRatePerYear * price.priceInUsd;
    return (annualRewardsUsd / stakedUsd) * 100;
  }, [poolTVL.isLoaded, poolTVL.lpSupply, poolTVL.tvl, lpFarm.totalStaked, lpFarm.rewardRatePerYear, price.priceInUsd]);

  // Loading skeleton — render whenever we're still reading, regardless of deploy status.
  // Prior guard (`isDeployed && isReadLoading`) skipped the skeleton when isDeployed was
  // still undefined at first render, leaving the section blank for the critical first
  // frame. See audit blocker: LPFarmingSection double-return null.
  if (lpFarm.isReadLoading) {
    return (
      <m.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <div className="h-6 w-40 rounded bg-white/10 animate-pulse" />
            <div className="h-4 w-64 rounded bg-white/10 animate-pulse mt-1.5" />
          </div>
        </div>
        <div className="rounded-xl p-6" style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid var(--color-purple-15)' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="rounded-lg p-3" style={{ background: 'var(--color-purple-15)', border: '1px solid var(--color-purple-15)' }}>
                <div className="h-3 w-20 rounded bg-white/10 animate-pulse mb-2" />
                <div className="h-5 w-24 rounded bg-white/10 animate-pulse" />
              </div>
            ))}
          </div>
          <div className="h-10 w-full rounded-lg bg-white/10 animate-pulse" />
        </div>
      </m.div>
    );
  }

  // Contract not deployed — render a lightweight "coming soon" panel rather than
  // returning null, so the section slot is acknowledged in the page flow.
  if (!lpFarm.isDeployed) {
    return (
      <m.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="heading-luxury text-white text-[22px] tracking-tight" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>LP Farming</h2>
            <p className="text-white/85 text-[13px] mt-0.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Stake LP tokens &middot; earn TOWELI rewards</p>
          </div>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">SOON</span>
        </div>
        <div className="relative overflow-hidden rounded-xl" style={{ border: '1px solid var(--color-purple-40)' }}>
          <div className="absolute inset-0">
            <ArtImg pageId="lp-farming" idx={0} fallbackPosition="center 30%" alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-8 text-center" style={{ background: 'rgba(6,12,26,0.65)' }}>
            <p className="text-white/90 text-[13px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
              LP farming contract is not yet deployed on this network.
            </p>
            <p className="text-white/70 text-[11px] mt-1.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
              Provide liquidity on the Trade page &rarr; Liquidity tab in the meantime.
            </p>
          </div>
        </div>
      </m.div>
    );
  }

  return (
    <m.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="heading-luxury text-white text-[22px] tracking-tight">LP Farming</h2>
          <p className="text-white text-[13px] mt-0.5">Stake LP tokens &middot; earn TOWELI rewards</p>
        </div>
        {lpFarm.isActive && <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-500/20 text-green-400 border border-green-500/30">LIVE</span>}
      </div>

      <div className="relative overflow-hidden rounded-xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
        <div className="absolute inset-0">
          <ArtImg pageId="lp-farming" idx={1} fallbackPosition="center 30%" alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 p-6">
          {/* APR hero — the headline number a farmer wants, derived live from on-chain
              emissions + staked TVL (not a hardcoded figure). */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-5">
            <span className="text-white/85 text-[11px] uppercase tracking-wider label-pill">Est. APR</span>
            {lpApr !== null ? (
              <>
                <span className="stat-value text-[26px] font-bold" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{formatPercent(lpApr)}</span>
                <span className="text-white/55 text-[10px]">estimated from staked TVL &middot; falls as more LP is staked</span>
              </>
            ) : (
              <>
                <span className="stat-value text-[26px] font-bold text-white/70">&ndash;</span>
                <span className="text-white/55 text-[10px]">
                  {lpFarm.totalStaked === 0n
                    ? 'be the first to stake LP to activate the live APR'
                    : !lpFarm.isActive
                      ? 'reward period ended — awaiting refill'
                      : 'calculating&hellip;'}
                </span>
              </>
            )}
          </div>
          {/* Stats row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
            <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              <p className="text-white text-[10px] mb-0.5">Total LP Staked</p>
              <p className="stat-value text-[14px] text-white font-mono">{formatTokenAmount(lpFarm.totalStakedFormatted)}</p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              <p className="text-white text-[10px] mb-0.5">Reward Rate</p>
              <p className="stat-value text-[14px] text-white font-mono">{formatNumber(lpFarm.rewardRatePerDay, 2)} / day</p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              <p className="text-white text-[10px] mb-0.5">Total Funded</p>
              <p className="stat-value text-[14px] text-white font-mono">{formatNumber(parseFloat(lpFarm.totalRewardsFundedFormatted), 0)} TOWELI</p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
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
                <div className="rounded-lg p-4" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                  <p className="text-white text-[11px] mb-2 font-semibold uppercase tracking-wider label-pill">Stake LP</p>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text" inputMode="decimal"
                      placeholder="0.0"
                      value={lpStakeAmount}
                      onChange={e => setLpStakeAmount(sanitizeDecimalInput(e.target.value))}
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
                    let stakeWei = 0n;
                    try { stakeWei = amt > 0 ? parseEther(lpStakeAmount) : 0n; } catch { stakeWei = 0n; }
                    // On-chain MIN_STAKE guard — without this, a sub-minimum amount builds a
                    // tx that reverts with StakeBelowMinimum() and the wallet shows a scary
                    // revert-fallback gas estimate. Block it client-side instead.
                    const belowMin = stakeWei > 0n && lpFarm.minStake > 0n && stakeWei < lpFarm.minStake;
                    const needsApproval = stakeWei > 0n && lpFarm.lpAllowance < stakeWei;
                    if (belowMin) {
                      return (
                        <button className="btn-primary w-full py-2 text-sm rounded-lg" disabled>
                          Min {formatTokenAmount(lpFarm.minStakeFormatted, 0)} LP required
                        </button>
                      );
                    }
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
                  {lpFarm.minStake > 0n && (
                    <p className="text-white/50 text-[10px] mt-2">
                      Min stake <span className="font-mono">{formatTokenAmount(lpFarm.minStakeFormatted, 0)}</span> LP
                      {parseFloat(lpFarm.walletLPBalanceFormatted) < parseFloat(lpFarm.minStakeFormatted) && (
                        <> &middot; you hold {formatTokenAmount(lpFarm.walletLPBalanceFormatted)} &mdash; <Link to="/liquidity" className="underline hover:text-white">add liquidity</Link></>
                      )}
                    </p>
                  )}
                </div>

                {/* Withdraw */}
                <div className="rounded-lg p-4" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                  <p className="text-white text-[11px] mb-2 font-semibold uppercase tracking-wider label-pill">Withdraw LP</p>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text" inputMode="decimal"
                      placeholder="0.0"
                      value={lpWithdrawAmount}
                      onChange={e => setLpWithdrawAmount(sanitizeDecimalInput(e.target.value))}
                      className="flex-1 bg-black/60 border border-white/25 rounded-lg px-3 py-2 min-h-[44px] text-white text-[16px] font-mono"
                    />
                    <button
                      className="text-[10px] text-white/60 hover:text-white"
                      onClick={() => setLpWithdrawAmount(lpFarm.stakedBalanceFormatted)}
                    >MAX</button>
                  </div>
                  <p className="text-white text-[10px] mb-2 font-mono">Staked: {formatTokenAmount(lpFarm.stakedBalanceFormatted)} LP</p>
                  {(() => {
                    // F111: pre-check against the staked balance so an over-staked
                    // amount can't build a tx that reverts in-wallet (mirrors the
                    // stake-side belowMin guard). parseEther is wrapped — a bad
                    // shape just falls through to the normal disabled state.
                    const wAmt = parseFloat(lpWithdrawAmount) || 0;
                    let withdrawWei = 0n;
                    try { withdrawWei = wAmt > 0 ? parseEther(lpWithdrawAmount) : 0n; } catch { withdrawWei = 0n; }
                    const overStaked = withdrawWei > 0n && lpFarm.stakedBalance > 0n && withdrawWei > lpFarm.stakedBalance;
                    return (
                      <button
                        className="btn-secondary w-full py-2 text-sm rounded-lg"
                        disabled={wAmt <= 0 || lpFarm.stakedBalance === 0n || overStaked || lpFarm.isPending || lpFarm.isConfirming}
                        onClick={() => { lpFarm.withdraw(lpWithdrawAmount); }}
                      >
                        {lpFarm.isPending || lpFarm.isConfirming
                          ? 'Withdrawing...'
                          : overStaked
                            ? `Max ${formatTokenAmount(lpFarm.stakedBalanceFormatted)} LP`
                            : 'Withdraw'}
                      </button>
                    );
                  })()}
                </div>
              </div>

              {/* IL Warning for first-time LP stakers */}
              {lpFarm.stakedBalance === 0n && (
                <div className="rounded-lg p-3 mt-4 text-[11px]" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)' }}>
                  <p className="text-amber-400 font-medium mb-1">Impermanent loss risk</p>
                  <p className="text-white/60">When TOWELI price changes relative to ETH, your LP position may be worth less than holding the tokens separately. Farm rewards can offset this over time.</p>
                </div>
              )}

              {/* IL Calculator */}
              <div className="mt-4">
                <ILCalculator />
              </div>
            </>
          )}
        </div>
      </div>
    </m.div>
  );
}
