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

  // Clear LP inputs only after a stake/withdraw confirms — not after an approve.
  // F105 (T5): the prior guard cleared both inputs on ANY success, which fires for
  // the approve leg too, wiping the amount the user just typed and was about to
  // stake. Read the last-action tag from the hook and only clear on stake/exit/
  // withdraw (the value-moving legs that consume the input).
  useEffect(() => {
    if (!lpFarm.isSuccess) return;
    const action = lpFarm.lastActionRef.current;
    if (action === 'stake' || action === 'exit') setLpStakeAmount('');
    if (action === 'withdraw' || action === 'exit') setLpWithdrawAmount('');
  }, [lpFarm.isSuccess, lpFarm.lastActionRef]);

  const poolTVL = usePoolTVL();
  const price = useTOWELIPrice();

  // Live LP-farming APR = annual TOWELI emissions (in USD) ÷ USD value of LP staked
  // in the farm. Honest and self-correcting: as more LP is staked the APR falls
  // toward steady state. Null when nothing is staked yet (an APR needs a non-zero
  // denominator) or while pool data is still loading — never a fabricated figure.
  //
  // Null, too, once the reward period has ended. useLPFarming zeroes the rate after
  // `periodFinish` (F100), and this memo used to divide that zero: with LP staked on
  // an ended period it returned exactly 0, and the hero printed a green "0.00%"
  // captioned "falls as more LP is staked" — a live, diluting yield on a schedule
  // that pays nothing. There is no APR to estimate there; the null branch says why.
  const lpApr = useMemo(() => {
    if (!lpFarm.isActive) return null;
    const lpSupply = poolTVL.lpSupply;
    const staked = lpFarm.totalStaked;
    if (!poolTVL.isLoaded || lpSupply === 0n || staked === 0n || price.priceInUsd <= 0) return null;
    const stakedUsd = poolTVL.tvl * (Number(staked) / Number(lpSupply));
    if (!(stakedUsd > 0)) return null;
    const annualRewardsUsd = lpFarm.rewardRatePerYear * price.priceInUsd;
    return (annualRewardsUsd / stakedUsd) * 100;
  }, [lpFarm.isActive, poolTVL.isLoaded, poolTVL.lpSupply, poolTVL.tvl, lpFarm.totalStaked, lpFarm.rewardRatePerYear, price.priceInUsd]);

  // Loading skeleton — render whenever we're still reading, regardless of deploy status.
  // Prior guard (`isDeployed && isReadLoading`) skipped the skeleton when isDeployed was
  // still undefined at first render, leaving the section blank for the critical first
  // frame. See audit blocker: LPFarmingSection double-return null.
  //
  // ⚠ THE HEADING IS NOT PART OF THE SKELETON, and shimmering it was a real defect.
  // "LP Farming" and its subtitle are compile-time constants — they depend on no read,
  // so there is nothing to wait for before printing them. Standing two grey bars where
  // the section's NAME goes meant that for as long as the batch was in flight, /farm
  // showed a nameless pulsing box: a screen reader got nothing to announce, and a
  // sighted user could not tell which section was loading. This is the section's
  // identity disappearing while it loads — the same class of bug as rendering an
  // unreadable value as a confident zero, one step earlier.
  //
  // It is not a hypothetical window either. The batch below retries twice (App.tsx
  // sets retry: 2) with viem's 10s per-transport timeout behind a 2-endpoint fallback,
  // so a degraded RPC can hold this state for tens of seconds. Measured on the CI
  // Anvil fork it runs 2.5-6.7s on a COLD fork — see the named budget in
  // e2e/claim-rewards.spec.ts, which this shape is what lets that spec separate
  // "the section mounted" from "its reads landed".
  //
  // Shimmer only what the read actually decides: the stat tiles and the CTA. The
  // house pattern elsewhere is the same — BountiesSection keeps its <h3> and
  // skeletons the rows beneath it; this section was the only one that early-returned
  // its own heading away.
  if (lpFarm.isReadLoading) {
    return (
      <m.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} aria-busy="true">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="heading-luxury text-white text-[22px] tracking-tight">LP Farming</h2>
            <p className="text-white text-[13px] mt-0.5">Stake LP tokens &middot; earn TOWELI rewards</p>
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
          {/* Farm-wide reads — same three-branch shape as the position notice below,
              but ABOVE the isConnected fork, because these seven reads run for
              logged-out visitors too (FarmPage.tsx:429 mounts this section at
              isConnected={false}) and every one of them collapses to 0n. */}
          {lpFarm.statsUnread && (
            <div
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 mb-5 text-[13px] text-amber-100"
              data-testid="lp-farming-stats-unread"
            >
              <p>
                The farm&rsquo;s figures could not be read just now &mdash; the network did
                not answer. The farm figures below are unknown, not zero: this is not a
                statement that nothing is staked or that rewards have ended. Retry before
                acting on them.
              </p>
              <button
                type="button"
                className="btn-secondary mt-2 px-4 py-1.5 text-[12px]"
                onClick={() => { void lpFarm.refetch(); }}
              >
                Retry
              </button>
            </div>
          )}
          {/* APR hero — the headline number a farmer wants, derived live from on-chain
              emissions + staked TVL (not a hardcoded figure).

              `statsUnread` has to suppress the figure itself, not just the caption:
              a landed `totalRawSupply` beside a FAILED `rewardRate` gives
              rewardRatePerYear = 0 and a finite denominator, so this printed a
              confident "0.00%" for an emission rate nobody read. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-5">
            <span className="text-white/85 text-[11px] uppercase tracking-wider label-pill">Est. APR</span>
            {lpApr !== null && !lpFarm.statsUnread ? (
              <>
                <span className="stat-value text-[26px] font-bold" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{formatPercent(lpApr)}</span>
                <span className="text-white/55 text-[10px]">estimated from staked TVL &middot; falls as more LP is staked</span>
              </>
            ) : (
              <>
                <span className="stat-value text-[26px] font-bold text-white/70">&ndash;</span>
                <span className="text-white/55 text-[10px]">
                  {/* The ORDER is the fix. An unread read stays first: it must not
                      invite you to be first on a farm that may be fully subscribed,
                      and it outranks the ended claim too. `statsUnread` includes the
                      pool totals (poolStatsUnread) and every other farm-wide read,
                      and the notice above carries the Retry this points at. The
                      ended period comes BEFORE the empty pool — the other way round,
                      a farm paying nothing invited "be the first to stake LP to
                      activate the live APR". Worded as an end, not "between epochs":
                      the Reward Rate tile below says why that reads as a lull. */}
                  {lpFarm.statsUnread
                    ? 'the farm figures could not be read — retry above'
                    : !lpFarm.isActive
                      ? 'reward period ended — staking LP earns nothing until the farm is refunded'
                      : lpFarm.totalStaked === 0n
                        ? 'be the first to stake LP to activate the live APR'
                        : 'calculating…'}
                </span>
              </>
            )}
          </div>
          {/* Stats row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
            <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              <p className="text-white text-[10px] mb-0.5">Total LP Staked</p>
              <p className="stat-value text-[14px] text-white font-mono">
                {lpFarm.statsUnread ? '–' : formatTokenAmount(lpFarm.totalStakedFormatted)}
              </p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              {/* The NUMBER here was already correct: useLPFarming zeroes rewardRatePerDay
                  once `periodFinish` lapses (fix F100), so this read "0.00 / day" rather
                  than a live figure. What it did not do is say WHY. "0.00 / day" beside a
                  past "Period Ends" date reads like a lull between epochs; the reward
                  period actually ended 2026-06-15 and is unfunded. This is a legibility
                  change on an already-honest number, not a correction.

                  What it ALSO did not do is separate that ended-schedule zero from an
                  unread one. `isActive` is derived from `periodFinish`, which collapses
                  to 0 on a failed read, so an outage printed the amber "0 / day" and the
                  tooltip "The reward period has ended" — a claim about the schedule
                  sourced from a read that never landed. Three branches now, not two. */}
              <p className="text-white text-[10px] mb-0.5">
                {lpFarm.statsUnread || lpFarm.isActive ? 'Reward Rate' : 'Reward Rate (ended)'}
              </p>
              {lpFarm.statsUnread ? (
                <p className="stat-value text-[14px] text-white font-mono">–</p>
              ) : lpFarm.isActive ? (
                <p className="stat-value text-[14px] text-white font-mono">{formatNumber(lpFarm.rewardRatePerDay, 2)} / day</p>
              ) : (
                <p className="stat-value text-[14px] text-amber-300 font-mono" title="The reward period has ended — staking LP here accrues nothing until it is refunded.">
                  0 / day
                </p>
              )}
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              <p className="text-white text-[10px] mb-0.5">Total Funded</p>
              <p className="stat-value text-[14px] text-white font-mono">
                {lpFarm.statsUnread ? '–' : `${formatNumber(parseFloat(lpFarm.totalRewardsFundedFormatted), 0)} TOWELI`}
              </p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              {/* The date already rendered an en-dash for a zero `periodFinish`, but the
                  LABEL and the amber both asserted "Period Ended" over it — the one half
                  a failed read could not honestly say. */}
              <p className="text-white text-[10px] mb-0.5">
                {lpFarm.statsUnread || lpFarm.isActive ? 'Period Ends' : 'Period Ended'}
              </p>
              <p className={`stat-value text-[14px] font-mono ${lpFarm.statsUnread || lpFarm.isActive ? 'text-white' : 'text-amber-300'}`}>
                {!lpFarm.statsUnread && lpFarm.periodFinish > 0 ? new Date(lpFarm.periodFinish * 1000).toLocaleDateString() : '–'}
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
              {/* User position - three branches, never two. The unread notice sits
                  BEFORE the card, so a failed read can no longer fall through to the
                  silent "no position" state (and, below, to the first-time-staker
                  impermanent-loss panel gated on the same flag). */}
              {lpFarm.positionUnread ? (
                <div
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 mb-4 text-[13px] text-amber-100"
                  data-testid="lp-farming-position-unread"
                >
                  <p>
                    Your staked LP could not be read just now - the network did not answer.
                    This is not a statement that you have nothing staked: anything you staked
                    is still staked, and the contract is the record. Retry before acting on
                    this panel.
                  </p>
                  <button
                    type="button"
                    className="btn-secondary mt-2 px-4 py-1.5 text-[12px]"
                    onClick={() => { void lpFarm.refetch(); }}
                  >
                    Retry
                  </button>
                </div>
              ) : lpFarm.stakedBalance > 0n ? (
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
              ) : null}

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
                      className="text-[10px] text-white/60 hover:text-white px-3 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 inline-flex items-center justify-center"
                      onClick={() => setLpStakeAmount(lpFarm.walletLPBalanceFormatted)}
                    >MAX</button>
                  </div>
                  <p className="text-white text-[10px] mb-2 font-mono">Wallet: {lpFarm.positionUnread ? '–' : formatTokenAmount(lpFarm.walletLPBalanceFormatted)} LP</p>
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
                  {/* An unread MIN_STAKE collapses to 0n, which fails BOTH tests below
                      and used to render nothing at all — so the screen quietly claimed
                      this pool has no minimum, and `belowMin` above stopped blocking.
                      Say we could not read it instead. Staking stays enabled: the
                      contract enforces MIN_STAKE regardless, so the cost here is a
                      revert, and refusing a legitimate stake over one unanswered read
                      of a constant would be the worse trade. */}
                  {lpFarm.minStakeUnread ? (
                    <p className="text-white/50 text-[10px] mt-2">
                      Minimum stake <span className="font-mono">unread</span> &mdash; if this pool has one,
                      a stake below it will revert. Retry in a moment to check.
                    </p>
                  ) : lpFarm.minStake > 0n && (
                    <p className="text-white/50 text-[10px] mt-2">
                      Min stake <span className="font-mono">{formatTokenAmount(lpFarm.minStakeFormatted, 0)}</span> LP
                      {!lpFarm.positionUnread && parseFloat(lpFarm.walletLPBalanceFormatted) < parseFloat(lpFarm.minStakeFormatted) && (
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
                      className="text-[10px] text-white/60 hover:text-white px-3 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 inline-flex items-center justify-center"
                      onClick={() => setLpWithdrawAmount(lpFarm.stakedBalanceFormatted)}
                    >MAX</button>
                  </div>
                  <p className="text-white text-[10px] mb-2 font-mono">Staked: {lpFarm.positionUnread ? '–' : formatTokenAmount(lpFarm.stakedBalanceFormatted)} LP</p>
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

              {/* IL Warning for first-time LP stakers. The `!positionUnread` gate is
                  the load-bearing half: without it a failed read renders the
                  you-have-never-staked panel at the same moment the notice above
                  says the position is unknown. */}
              {!lpFarm.positionUnread && lpFarm.stakedBalance === 0n && (
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
