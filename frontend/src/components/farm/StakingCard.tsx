import { useEffect, useState } from 'react';
import { m } from 'framer-motion';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Link } from 'react-router-dom';
import { formatTokenAmount, sanitizeDecimalInput } from '../../lib/formatting';
import { AnimatedCounter } from '../AnimatedCounter';
import { PENALTY_COPY } from '../../lib/copy';
import type { useFarmActions } from '../../hooks/useFarmActions';
import type { useUserPosition } from '../../hooks/useUserPosition';
import type { useNFTBoost } from '../../hooks/useNFTBoost';
import { ArtImg } from '../ArtImg';
import { useReadContract } from 'wagmi';
import { formatEther, parseEther } from 'viem';
import { TEGRIDY_STAKING_ABI } from '../../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, CHAIN_ID, LOCK_OPTIONS, EARLY_WITHDRAWAL_PENALTY_BPS, MAX_LOCK_DURATION, TEGRIDY_RESTAKING_ADDRESS, isDeployed } from '../../lib/constants';

// Derive from the canonical constant so the penalty label + math track one source.
const EARLY_WITHDRAWAL_PENALTY_PCT = EARLY_WITHDRAWAL_PENALTY_BPS / 100;

export interface ConfirmState {
  withdraw: boolean;
  earlyWithdraw: boolean;
  emergencyExit: boolean;
  extendLock: boolean;
  /**
   * Gates the ENABLE direction of Auto-Max Lock only. Enabling is the most
   * expensive irreversible click on this card — see the panel for why.
   */
  autoMaxLock: boolean;
}

export interface StakeInputState {
  amount: string;
  setAmount: (v: string) => void;
  lock: { label: string; seconds: number };
  setLock: (v: { label: string; seconds: number }) => void;
  extendLockDuration: { label: string; seconds: number };
  setExtendLockDuration: (v: { label: string; seconds: number }) => void;
}

interface StakingCardProps {
  isConnected: boolean;
  pos: ReturnType<typeof useUserPosition>;
  actions: ReturnType<typeof useFarmActions>;
  nft: ReturnType<typeof useNFTBoost>;
  input: StakeInputState;
  confirms: ConfirmState;
  setConfirm: (key: keyof ConfirmState, val: boolean) => void;
  pool?: { apr: string; aprNum: number; isDeployed: boolean; isDry?: boolean; secondsRemaining?: number };
  computed: {
    boostDisplay: string;
    totalBoostBps: number;
    amtNum: number;
    effectiveStake: number;
    stakeNeedsApproval: boolean;
  };
  handleStake: () => void;
  lastActionRef: React.MutableRefObject<string | null>;
  /** F106: submit-time snapshot of the claim/unstake amount (avoids "claimed 0"). */
  submittedAmountRef: React.MutableRefObject<string | null>;
}

export function StakingCard({
  isConnected, pos, actions, nft,
  input, confirms, setConfirm, pool, computed,
  handleStake, lastActionRef, submittedAmountRef,
}: StakingCardProps) {
  const { amount: stakeAmount, setAmount: setStakeAmount, lock: selectedLock, setLock: setSelectedLock, extendLockDuration, setExtendLockDuration } = input;
  const { boostDisplay, amtNum, effectiveStake, stakeNeedsApproval, totalBoostBps } = computed;
  // Tick once per minute so the boost-expiry countdown stays fresh without
  // calling Date.now() during render (which React Compiler treats as impure).
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, []);

  // Surface the staking contract's per-wallet cap + minimum so the form never lets the
  // user build a reverting stake (the "Likely to Fail" footgun). The cap is read on-chain
  // so it auto-updates when governance raises it (testing-phase 50,000 → later) — no
  // frontend redeploy needed. MIN_STAKE mirrors TegridyStaking.MIN_STAKE (100e18).
  const { data: maxStakeRaw } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS,
    abi: TEGRIDY_STAKING_ABI,
    functionName: 'maxStakePerUser',
    chainId: CHAIN_ID,
  });
  const MIN_STAKE_TOWELI = 100;
  const maxStakeWei = (maxStakeRaw as bigint | undefined) ?? 0n;
  const maxStakeDisplay = maxStakeWei > 0n ? formatTokenAmount(formatEther(maxStakeWei), 0) : '—';
  let stakeWei = 0n;
  try {
    stakeWei = amtNum > 0 ? parseEther(stakeAmount) : 0n;
  } catch {
    stakeWei = 0n;
  }
  const overCap = maxStakeWei > 0n && stakeWei > maxStakeWei;
  const belowMin = amtNum > 0 && amtNum < MIN_STAKE_TOWELI;
  const stakeBlocked = overCap || belowMin;

  return (
    <m.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
      <div className="relative overflow-hidden rounded-xl glass-card-animated card-hover" style={{ border: '1px solid var(--color-purple-75)' }}>
        <div className="absolute inset-0">
          <ArtImg pageId="staking-card" idx={0} fallbackPosition="center 40%" alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 p-6">
        <h3 className="heading-luxury text-white text-[20px] mb-5">
          {pos.hasPosition ? 'Your Position' : 'Stake TOWELI'}
        </h3>

        {pos.hasPosition ? (
          /* Existing position display */
          <div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                <p className="text-white text-[10px] mb-0.5">Staked</p>
                <AnimatedCounter value={parseFloat(pos.stakedFormatted) || 0} decimals={2} className="stat-value text-[16px] text-white" />
              </div>
              <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                <p className="text-white text-[10px] mb-0.5">Boost</p>
                <AnimatedCounter value={pos.boostMultiplier} decimals={2} suffix="x" className="stat-value text-[16px] text-white" />
                {/* STAKING_LOOK §2.3: revalidateBoost reverts LockExpired() on
                    any EXPIRED position (DS2-07 guard) — the old condition
                    (!pos.isLocked) rendered this button exactly and only in
                    the one state where every click burned gas and reverted.
                    It belongs on ACTIVE locks, where the call can succeed. */}
                {pos.hasPosition && pos.isLocked && pos.boostMultiplier > 1 && (
                  <button
                    onClick={() => { lastActionRef.current = null; actions.revalidateBoost(pos.tokenId); }}
                    disabled={actions.isPending || actions.isConfirming}
                    title="Re-checks the boost's NFT custody on an active lock"
                    className="btn-secondary text-[11px] mt-1.5 w-full py-1.5 rounded-lg disabled:opacity-70 disabled:cursor-not-allowed">
                    Revalidate Boost
                  </button>
                )}
              </div>
              {/* F104 (T10): announce claimable-reward changes to screen readers
                  so they aren't silent visual-only updates. */}
              <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                <p className="text-white text-[10px] mb-0.5">Claimable</p>
                <div aria-hidden="true">
                  {/* STAKING_LOOK §2.7: the live interpolator ticks at the
                      NOMINAL rate; once the reserve is dry the contract
                      accrues nothing, so ticking here would be a permanent
                      up-snap-back sawtooth of phantom accrual. Pin to the
                      exact on-chain value when dry. */}
                  <AnimatedCounter
                    value={pos.accrualPerSec > 0 && !pool?.isDry ? pos.pendingLive : (parseFloat(pos.pendingFormatted) || 0)}
                    decimals={pos.accrualPerSec > 0 && !pool?.isDry ? 6 : 4}
                    duration={900}
                    className="stat-value text-[16px] text-white" />
                </div>
                <span className="sr-only" aria-live="polite">
                  {parseFloat(pos.pendingFormatted) || 0} TOWELI claimable
                </span>
                {/* Only rendered when a real on-chain rate exists. Labelled "est."
                    because it is an interpolation between refreshes, not a fresh read. */}
                {pos.accrualPerSec > 0 && (
                  <p
                    className="text-white/45 text-[9px] mt-0.5 font-mono"
                    title="Estimated between the 30-second on-chain refreshes, using this position's live reward rate. Snaps back to the exact value on each refresh.">
                    est. live &middot; +{pos.accrualPerSec.toFixed(6)}/s
                  </p>
                )}
              </div>
              <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                <p className="text-white text-[10px] mb-0.5">Lock Expires</p>
                <p className="stat-value text-[14px] text-white">
                  {pos.autoMaxLock ? 'Auto-Max' : pos.isLocked ? new Date(pos.lockEnd * 1000).toLocaleDateString() : 'Unlocked'}
                </p>
                {/* AUDIT FARM-UX: boost-expiry countdown. Without this, users
                    only saw the absolute date and missed impending unlock
                    → sudden boost collapse surprise. `daysLeft ≤ 5` flips
                    the chip to red; 6-30 days flips amber; >30 days is
                    neutral. Updates on every render which is fine since
                    the parent refetches position every 30s. */}
                {pos.hasPosition && pos.isLocked && !pos.autoMaxLock && (() => {
                  const secondsLeft = Math.max(0, pos.lockEnd - nowSec);
                  const daysLeft = Math.floor(secondsLeft / 86400);
                  const hoursLeft = Math.floor((secondsLeft % 86400) / 3600);
                  const soon = daysLeft <= 5;
                  const warn = !soon && daysLeft <= 30;
                  const label = daysLeft > 0
                    ? `${daysLeft}d ${hoursLeft}h left`
                    : hoursLeft > 0
                      ? `${hoursLeft}h left`
                      : 'expires soon';
                  return (
                    <p
                      className={`text-[10px] mt-0.5 font-mono ${soon ? 'text-red-300 font-semibold' : warn ? 'text-amber-300' : 'text-white/60'}`}
                      aria-label={soon ? `Lock expires in ${label} — consider extending` : `Lock expires in ${label}`}
                    >
                      {soon ? '⚠ ' : ''}{label}
                    </p>
                  );
                })()}
                {pos.hasPosition && pos.isLocked && !confirms.extendLock && (
                  <button
                    onClick={() => setConfirm('extendLock', true)}
                    disabled={actions.isPending || actions.isConfirming}
                    className="btn-secondary text-[11px] mt-1.5 w-full py-1.5 rounded-lg disabled:opacity-70 disabled:cursor-not-allowed">
                    Extend Lock
                  </button>
                )}
                {pos.hasPosition && pos.isLocked && confirms.extendLock && (
                  <div className="mt-2">
                    <div className="grid grid-cols-2 gap-1.5 mb-2">
                      {LOCK_OPTIONS.map((opt) => (
                        <button key={opt.label} onClick={() => setExtendLockDuration(opt)}
                          className="rounded-lg px-2 py-1.5 text-center cursor-pointer transition-all text-[10px]"
                          style={{
                            background: extendLockDuration.label === opt.label ? 'var(--color-purple-75)' : 'rgba(0,0,0,0.55)',
                            border: extendLockDuration.label === opt.label ? '1px solid var(--color-purple-30)' : '1px solid rgba(255,255,255,0.25)',
                            color: extendLockDuration.label === opt.label ? '#000000' : 'rgba(255,255,255,1)',
                          }}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => setConfirm('extendLock', false)}
                        className="flex-1 py-1.5 rounded-lg text-[10px] text-white cursor-pointer"
                        style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.20)' }}>
                        Cancel
                      </button>
                      <button
                        onClick={() => { lastActionRef.current = null; actions.extendLock(pos.tokenId, BigInt(extendLockDuration.seconds)); setConfirm('extendLock', false); }}
                        disabled={actions.isPending || actions.isConfirming}
                        className="btn-secondary flex-1 py-1.5 rounded-lg text-[10px] disabled:opacity-70 disabled:cursor-not-allowed">
                        Extend {extendLockDuration.label}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button onClick={() => { lastActionRef.current = 'claim'; submittedAmountRef.current = pos.pendingFormatted; actions.claim(pos.tokenId); }}
                disabled={actions.isPending || actions.isConfirming || pos.isLoading || Number(pos.pendingFormatted) < 0.01}
                className="btn-primary w-full py-3 text-[14px] disabled:opacity-70 disabled:cursor-not-allowed">
                {actions.isPending || actions.isConfirming ? 'Processing...' : 'Claim Rewards'}
              </button>
              {pos.unsettledFormatted && parseFloat(pos.unsettledFormatted) > 0 && (
                <div className="rounded-lg p-3 mt-2" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                  <p className="text-white text-[11px] mb-1.5">Unsettled: {pos.unsettledFormatted} TOWELI</p>
                  <button
                    onClick={() => { lastActionRef.current = null; actions.claimUnsettled(); }}
                    disabled={actions.isPending || actions.isConfirming}
                    className="btn-secondary w-full py-2 text-[13px] disabled:opacity-70 disabled:cursor-not-allowed">
                    {actions.isPending || actions.isConfirming ? 'Processing...' : 'Claim Unsettled'}
                  </button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {pos.canWithdraw && !confirms.withdraw && (
                  <button onClick={() => setConfirm('withdraw', true)}
                    disabled={actions.isPending || actions.isConfirming}
                    className="btn-secondary w-full py-2.5 text-[13px] disabled:opacity-70">
                    Withdraw
                  </button>
                )}
                {pos.canWithdraw && confirms.withdraw && (
                  <div className="col-span-2 rounded-lg p-3" style={{ background: 'rgba(255,178,55,0.06)', border: '1px solid rgba(255,178,55,0.15)' }}>
                    <p className="text-warning/80 text-[11px] mb-2">Withdraw <span className="font-mono font-semibold">{pos.stakedFormatted} TOWELI</span>? This will unstake your full position.</p>
                    <div className="flex gap-2">
                      <button onClick={() => setConfirm('withdraw', false)}
                        className="flex-1 py-2 rounded-lg text-[12px] text-white cursor-pointer"
                        style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.20)' }}>
                        Cancel
                      </button>
                      <button onClick={() => { setConfirm('withdraw', false); lastActionRef.current = 'unstake'; submittedAmountRef.current = pos.stakedFormatted; actions.withdraw(pos.tokenId); }}
                        disabled={actions.isPending || actions.isConfirming}
                        className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-warning cursor-pointer disabled:opacity-70"
                        style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.25)' }}>
                        Confirm Withdraw
                      </button>
                    </div>
                  </div>
                )}
                {pos.isLocked && !confirms.earlyWithdraw && (
                  <button onClick={() => setConfirm('earlyWithdraw', true)}
                    disabled={actions.isPending || actions.isConfirming}
                    className="w-full py-2.5 text-[13px] rounded-lg disabled:opacity-70"
                    style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: 'rgba(239,68,68,0.8)' }}>
                    {PENALTY_COPY.earlyExitLabel} ({EARLY_WITHDRAWAL_PENALTY_PCT}%)
                  </button>
                )}
                {pos.isLocked && confirms.earlyWithdraw && (() => {
                  const stakedNum = parseFloat(pos.stakedFormatted) || 0;
                  const penaltyAmt = stakedNum * (EARLY_WITHDRAWAL_PENALTY_PCT / 100);
                  const receiveAmt = stakedNum - penaltyAmt;
                  return (
                  <div className="col-span-2 rounded-lg p-3" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
                    <p className="text-danger text-[12px] font-semibold mb-2">The cops showed up. You'll lose {EARLY_WITHDRAWAL_PENALTY_PCT}% of your crop to the {PENALTY_COPY.earlyExitLabel} — {PENALTY_COPY.earlyExitTagline}</p>
                    <div className="rounded-lg p-2.5 mb-2" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.10)' }}>
                      <p className="text-danger/80 text-[11px] mb-1">Penalty: <span className="font-mono font-semibold">{penaltyAmt.toFixed(2)} TOWELI</span> will be sent to treasury</p>
                      <p className="text-white/80 text-[11px]">You will receive: <span className="font-mono font-semibold">{receiveAmt.toFixed(2)} TOWELI</span></p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setConfirm('earlyWithdraw', false)}
                        className="flex-1 py-2 rounded-lg text-[12px] text-white cursor-pointer"
                        style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.20)' }}>
                        Cancel
                      </button>
                      <button onClick={() => { setConfirm('earlyWithdraw', false); lastActionRef.current = 'unstake'; submittedAmountRef.current = pos.stakedFormatted; actions.earlyWithdraw(pos.tokenId); }}
                        disabled={actions.isPending || actions.isConfirming}
                        className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-danger cursor-pointer disabled:opacity-70"
                        style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)' }}>
                        Pay the {PENALTY_COPY.earlyExitLabel}
                      </button>
                    </div>
                  </div>
                  );
                })()}
{/* AUTO-MAX LOCK — confirm the ENABLE direction only.
                    This used to fire on a single click in both directions, and
                    enabling is the most expensive irreversible action on the
                    card: TegridyStaking.toggleAutoMaxLock sets
                    `lockEnd = block.timestamp + MAX_LOCK_DURATION` immediately
                    (contracts/src/TegridyStaking.sol:1197-1203), and its own
                    docs record that "Disabling autoMaxLock does NOT restore
                    original lockDuration... users who toggled then want a
                    shorter conceptual lock must withdraw and re-stake fresh".
                    So one tap committed four years, and the button said nothing
                    about it.
                    DISABLING stays one click on purpose — it is harmless, and
                    gating it would only make an unwanted state harder to leave.
                    A field review flagged this as a copy-placement problem
                    ("explained even further down"). It is not: the penalty is
                    already disclosed three times and matches the contract
                    exactly. What was missing is this control. */}
                {pos.autoMaxLock && (
                  <button onClick={() => { lastActionRef.current = null; actions.toggleAutoMaxLock(pos.tokenId); }}
                    disabled={actions.isPending || actions.isConfirming}
                    className="btn-secondary w-full py-2.5 text-[13px] disabled:opacity-70">
                    Disable Auto-Lock
                  </button>
                )}
                {!pos.autoMaxLock && !confirms.autoMaxLock && (
                  <button onClick={() => setConfirm('autoMaxLock', true)}
                    disabled={actions.isPending || actions.isConfirming}
                    className="btn-secondary w-full py-2.5 text-[13px] disabled:opacity-70">
                    Enable Auto-Max Lock
                  </button>
                )}
                {!pos.autoMaxLock && confirms.autoMaxLock && (
                  <div className="col-span-2 rounded-lg p-3" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
                    <p className="text-danger text-[12px] font-semibold mb-2">
                      This locks your {pos.stakedFormatted} TOWELI until{' '}
                      {new Date((nowSec + MAX_LOCK_DURATION) * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                      {' '}— four years from now.
                    </p>
                    <div className="rounded-lg p-2.5 mb-2" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.10)' }}>
                      <p className="text-danger/80 text-[11px] mb-1">
                        Turning it back off later stops the auto-renew but does <span className="font-semibold">not</span> shorten this lock.
                      </p>
                      <p className="text-white/80 text-[11px]">
                        Need out early? You keep {100 - EARLY_WITHDRAWAL_PENALTY_PCT}% — the other {EARLY_WITHDRAWAL_PENALTY_PCT}% goes to treasury.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setConfirm('autoMaxLock', false)}
                        className="flex-1 py-2 rounded-lg text-[12px] text-white cursor-pointer"
                        style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.20)' }}>
                        Cancel
                      </button>
                      <button onClick={() => { setConfirm('autoMaxLock', false); lastActionRef.current = null; actions.toggleAutoMaxLock(pos.tokenId); }}
                        disabled={actions.isPending || actions.isConfirming}
                        className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-danger cursor-pointer disabled:opacity-70"
                        style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)' }}>
                        Lock for four years
                      </button>
                    </div>
                  </div>
                )}
                {pos.isPaused && pos.hasPosition && !confirms.emergencyExit && (
                  <button
                    onClick={() => setConfirm('emergencyExit', true)}
                    disabled={actions.isPending || actions.isConfirming}
                    className="col-span-2 w-full py-2.5 text-[13px] rounded-lg font-semibold disabled:opacity-70 disabled:cursor-not-allowed"
                    style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171' }}>
                    Emergency Exit (Forfeit Rewards)
                  </button>
                )}
                {pos.isPaused && pos.hasPosition && confirms.emergencyExit && (
                  <div className="col-span-2 rounded-lg p-3" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
                    <p className="text-danger text-[11px] font-semibold mb-1">Emergency exit forfeits all pending rewards. This cannot be undone.</p>
                    <div className="flex gap-2 mt-2">
                      <button onClick={() => setConfirm('emergencyExit', false)}
                        className="flex-1 py-2 rounded-lg text-[12px] text-white cursor-pointer"
                        style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.20)' }}>
                        Cancel
                      </button>
                      <button onClick={() => { setConfirm('emergencyExit', false); lastActionRef.current = null; actions.emergencyExit(pos.tokenId); }}
                        disabled={actions.isPending || actions.isConfirming}
                        className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-danger cursor-pointer disabled:opacity-70"
                        style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)' }}>
                        Confirm Emergency Exit
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {/* Restaking is DEFERRED to Phase 7 — TEGRIDY_RESTAKING_ADDRESS is
                  zeroed, so FarmPage's restaking section never renders. Advertising
                  "bonus yield" with a link back to this same page was a live CTA for
                  a dead feature; show an honest status label until it deploys. */}
              {isDeployed(TEGRIDY_RESTAKING_ADDRESS) ? (
                <Link to="/farm" className="text-center text-white/60 text-[12px] hover:text-white transition-colors mt-1">
                  Restake for bonus yield &#8594;
                </Link>
              ) : (
                <span className="text-center text-white/40 text-[12px] mt-1">
                  Restaking &mdash; coming in Phase 7
                </span>
              )}
            </div>
          </div>
        ) : !isConnected ? (
          <div className="text-center py-8">
            <p className="text-white text-[13px] mb-4">Connect wallet to start staking</p>
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
                  <button onClick={openConnectModal} className="btn-primary px-7 py-2.5 text-[14px]">
                    Connect Wallet
                  </button>
                </div>
              )}
            </ConnectButton.Custom>
          </div>
        ) : (
          /* New stake form */
          <div>
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                {/* F104: associate the label with the input so AT announces it. */}
                <label htmlFor="stake-amount-input" className="text-white text-[11px] uppercase tracking-wider label-pill">Amount</label>
                <button onClick={() => {
                    const bal = parseFloat(pos.walletBalanceFormatted) || 0;
                    const cap = maxStakeWei > 0n ? parseFloat(formatEther(maxStakeWei)) : bal;
                    setStakeAmount(String(Math.min(bal, cap)));
                  }}
                  className="text-white/60 text-[11px] hover:text-white transition-colors cursor-pointer">
                  Balance: {formatTokenAmount(pos.walletBalanceFormatted, 0)}
                </button>
              </div>
              <input id="stake-amount-input" type="text" inputMode="decimal" value={stakeAmount} onChange={(e) => setStakeAmount(sanitizeDecimalInput(e.target.value))}
                placeholder="0"
                aria-label="Amount of TOWELI to stake"
                className="w-full rounded-lg p-4 min-h-[44px] font-mono text-xl text-white outline-none token-input"
                style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }} />
              <p className="text-white/50 text-[10px] mt-1.5">
                Max <span className="font-mono text-white/70">{maxStakeDisplay}</span> TOWELI per wallet &middot; min {MIN_STAKE_TOWELI}
                <span className="text-white/35"> (testing phase)</span>
              </p>
            </div>

            <div className="mb-4">
              <label id="stake-lock-label" className="text-white text-[11px] uppercase tracking-wider label-pill mb-2 block">Lock Duration</label>
              {/* F104: radiogroup semantics + a non-color (checkmark) selected
                  indicator so the choice isn't conveyed by background alone. */}
              <div role="radiogroup" aria-labelledby="stake-lock-label" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {LOCK_OPTIONS.map((opt) => {
                  const isSelected = selectedLock.label === opt.label;
                  return (
                  <button key={opt.label} onClick={() => setSelectedLock(opt)}
                    role="radio"
                    aria-checked={isSelected}
                    className="rounded-lg p-2.5 min-h-[44px] text-center cursor-pointer transition-all text-[12px]"
                    style={{
                      background: isSelected ? 'var(--color-purple-75)' : 'rgba(0,0,0,0.55)',
                      border: isSelected ? '1px solid var(--color-purple-30)' : '1px solid rgba(255,255,255,0.25)',
                      color: isSelected ? '#000000' : 'rgba(255,255,255,1)',
                    }}>
                    {isSelected && <span aria-hidden="true" className="mr-1">&#10003;</span>}
                    {opt.label}
                  </button>
                  );
                })}
              </div>
            </div>

            {/* Boost preview */}
            <div className="rounded-lg p-4 mb-4" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-white text-[11px]">Your Boost</span>
                <span className="stat-value text-[16px] text-white">{boostDisplay}x</span>
              </div>
              {/* STAKING_LOOK §2.1: this stake path can NEVER grant the JBAC
                  bonus (plain stake(); the +0.5x requires stakeWithBoost's
                  NFT deposit, which this UI doesn't drive) — so the preview
                  states that instead of advertising a boost it won't deliver. */}
              {nft.holdsJBAC && (
                <div className="flex items-start justify-between gap-3 mb-2">
                  <span className="text-white/70 text-[11px]">JBAC bonus (+0.5x)</span>
                  <span className="text-white/70 text-[11px] text-right">not applied — requires NFT-deposit staking</span>
                </div>
              )}
              {amtNum > 0 && (
                <>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-white text-[11px]">Effective stake</span>
                    <span className="text-white text-[11px]">{formatTokenAmount(effectiveStake.toString(), 0)} TOWELI</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white text-[11px]">Voting power</span>
                    <span className="text-white text-[11px]">{formatTokenAmount(effectiveStake.toString(), 0)}</span>
                  </div>
                </>
              )}
            </div>

            {/* Yield Projections — shows estimated earnings based on current APR and selected boost */}
            {amtNum > 0 && pool?.isDeployed && pool.aprNum > 0 && (
              <div className="rounded-lg p-4 mb-4" style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)' }}>
                <p className="text-emerald-400 text-[11px] font-semibold mb-2 uppercase tracking-wider">Projected Earnings</p>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: '30 Days', days: 30 },
                    { label: '90 Days', days: 90 },
                    { label: '1 Year', days: 365 },
                  ].map(({ label, days }) => {
                    const boostedApr = pool.aprNum * (totalBoostBps / 10000);
                    const projected = amtNum * (boostedApr / 100) * (days / 365);
                    return (
                      <div key={label} className="text-center">
                        <p className="text-white/40 text-[9px] uppercase mb-0.5">{label}</p>
                        <p className="stat-value text-white text-[13px]">{projected < 0.01 ? '<0.01' : projected.toFixed(2)}</p>
                        <p className="text-white/30 text-[9px]">TOWELI</p>
                      </div>
                    );
                  })}
                </div>
                <p className="text-white/30 text-[9px] mt-2 text-center">
                  Based on {pool.apr}% base APR × {boostDisplay}x boost. Rates change with total staked.
                </p>
                {/* STAKING_LOOK §4: the same runway guard DashboardPage already
                    carries — figures past the reserve's runway assume refills. */}
                {(() => {
                  const runwayDays = Math.floor((pool.secondsRemaining ?? 0) / 86400);
                  return runwayDays > 0 && runwayDays < 365 ? (
                    <p className="text-[9px] mt-1 text-center" style={{ color: '#e3b341', opacity: 0.85 }}>
                      Current reserve runs ≈ {runwayDays}d at this rate — figures beyond that assume refills.
                    </p>
                  ) : null;
                })()}
              </div>
            )}

            <button onClick={handleStake}
              disabled={actions.isPending || actions.isConfirming || amtNum <= 0 || stakeBlocked}
              className="btn-primary w-full py-3.5 text-[14px] disabled:opacity-70 disabled:cursor-not-allowed">
              {actions.isPending || actions.isConfirming
                ? 'Processing...'
                : amtNum <= 0 ? 'Enter Amount'
                : belowMin ? `Minimum ${MIN_STAKE_TOWELI} TOWELI`
                : overCap ? `Max ${maxStakeDisplay} per wallet`
                : stakeNeedsApproval ? 'Approve TOWELI'
                : `Stake & Lock for ${selectedLock.label}`}
            </button>

            <p className="text-white text-[10px] text-center mt-3">
              Early exit available — {EARLY_WITHDRAWAL_PENALTY_PCT}% {PENALTY_COPY.earlyExitLabel} sent to the treasury
            </p>
          </div>
        )}
        </div>
      </div>
    </m.div>
  );
}
