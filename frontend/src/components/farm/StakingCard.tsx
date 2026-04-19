import { m } from 'framer-motion';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Link } from 'react-router-dom';
import { pageArt } from '../../lib/artConfig';
import { formatTokenAmount } from '../../lib/formatting';
import { AnimatedCounter } from '../AnimatedCounter';
import { PENALTY_COPY } from '../../lib/copy';
import type { useFarmActions } from '../../hooks/useFarmActions';
import type { useUserPosition } from '../../hooks/useUserPosition';
import type { useNFTBoost } from '../../hooks/useNFTBoost';
import { ArtImg } from '../ArtImg';

const EARLY_WITHDRAWAL_PENALTY_PCT = 25;

const LOCK_OPTIONS = [
  { label: '7 Days', seconds: 7 * 86400 },
  { label: '30 Days', seconds: 30 * 86400 },
  { label: '90 Days', seconds: 90 * 86400 },
  { label: '6 Months', seconds: 180 * 86400 },
  { label: '1 Year', seconds: 365 * 86400 },
  { label: '2 Years', seconds: 730 * 86400 },
  { label: '4 Years', seconds: 1460 * 86400 },
];

export interface ConfirmState {
  withdraw: boolean;
  earlyWithdraw: boolean;
  emergencyExit: boolean;
  extendLock: boolean;
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
  pool?: { apr: string; isDeployed: boolean };
  computed: {
    boostDisplay: string;
    totalBoostBps: number;
    amtNum: number;
    effectiveStake: number;
    stakeNeedsApproval: boolean;
  };
  handleStake: () => void;
  lastActionRef: React.MutableRefObject<string | null>;
}

export function StakingCard({
  isConnected, pos, actions, nft,
  input, confirms, setConfirm, pool, computed,
  handleStake, lastActionRef,
}: StakingCardProps) {
  const { amount: stakeAmount, setAmount: setStakeAmount, lock: selectedLock, setLock: setSelectedLock, extendLockDuration, setExtendLockDuration } = input;
  const { boostDisplay, amtNum, effectiveStake, stakeNeedsApproval, totalBoostBps } = computed;
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
                {pos.hasPosition && !pos.isLocked && pos.boostMultiplier > 1 && (
                  <button
                    onClick={() => actions.revalidateBoost(pos.tokenId)}
                    disabled={actions.isPending || actions.isConfirming}
                    className="btn-secondary text-[11px] mt-1.5 w-full py-1.5 rounded-lg disabled:opacity-70 disabled:cursor-not-allowed">
                    Revalidate Boost
                  </button>
                )}
              </div>
              <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                <p className="text-white text-[10px] mb-0.5">Claimable</p>
                <AnimatedCounter value={parseFloat(pos.pendingFormatted) || 0} decimals={4} className="stat-value text-[16px] text-white" />
              </div>
              <div className="rounded-lg p-3" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                <p className="text-white text-[10px] mb-0.5">Lock Expires</p>
                <p className="stat-value text-[14px] text-white">
                  {pos.autoMaxLock ? 'Auto-Max' : pos.isLocked ? new Date(pos.lockEnd * 1000).toLocaleDateString() : 'Unlocked'}
                </p>
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
                        onClick={() => { actions.extendLock(pos.tokenId, BigInt(extendLockDuration.seconds)); setConfirm('extendLock', false); }}
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
              <button onClick={() => { lastActionRef.current = 'claim'; actions.claim(pos.tokenId); }}
                disabled={actions.isPending || actions.isConfirming || pos.isLoading || Number(pos.pendingFormatted) < 0.01}
                className="btn-primary w-full py-3 text-[14px] disabled:opacity-70 disabled:cursor-not-allowed">
                {actions.isPending || actions.isConfirming ? 'Processing...' : 'Claim Rewards'}
              </button>
              {pos.unsettledFormatted && parseFloat(pos.unsettledFormatted) > 0 && (
                <div className="rounded-lg p-3 mt-2" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
                  <p className="text-white text-[11px] mb-1.5">Unsettled: {pos.unsettledFormatted} TOWELI</p>
                  <button
                    onClick={() => actions.claimUnsettled()}
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
                      <button onClick={() => { setConfirm('withdraw', false); lastActionRef.current = 'unstake'; actions.withdraw(pos.tokenId); }}
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
                      <button onClick={() => { setConfirm('earlyWithdraw', false); lastActionRef.current = 'unstake'; actions.earlyWithdraw(pos.tokenId); }}
                        disabled={actions.isPending || actions.isConfirming}
                        className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-danger cursor-pointer disabled:opacity-70"
                        style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)' }}>
                        Pay the {PENALTY_COPY.earlyExitLabel}
                      </button>
                    </div>
                  </div>
                  );
                })()}
                <button onClick={() => actions.toggleAutoMaxLock(pos.tokenId)}
                  disabled={actions.isPending || actions.isConfirming}
                  className="btn-secondary w-full py-2.5 text-[13px] disabled:opacity-70">
                  {pos.autoMaxLock ? 'Disable Auto-Lock' : 'Enable Auto-Max Lock'}
                </button>
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
                      <button onClick={() => { setConfirm('emergencyExit', false); actions.emergencyExit(pos.tokenId); }}
                        disabled={actions.isPending || actions.isConfirming}
                        className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-danger cursor-pointer disabled:opacity-70"
                        style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)' }}>
                        Confirm Emergency Exit
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <Link to="/restake" className="text-center text-white/60 text-[12px] hover:text-white transition-colors mt-1">
                Restake for bonus yield &#8594;
              </Link>
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
                <label className="text-white text-[11px] uppercase tracking-wider label-pill">Amount</label>
                <button onClick={() => setStakeAmount(pos.walletBalanceFormatted)}
                  className="text-white/60 text-[11px] hover:text-white transition-colors cursor-pointer">
                  Balance: {formatTokenAmount(pos.walletBalanceFormatted, 0)}
                </button>
              </div>
              <input type="number" inputMode="decimal" value={stakeAmount} onChange={(e) => setStakeAmount(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'))}
                placeholder="0" min="0" step="any"
                className="w-full rounded-lg p-4 min-h-[44px] font-mono text-xl text-white outline-none token-input"
                style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }} />
            </div>

            <div className="mb-4">
              <label className="text-white text-[11px] uppercase tracking-wider label-pill mb-2 block">Lock Duration</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {LOCK_OPTIONS.map((opt) => (
                  <button key={opt.label} onClick={() => setSelectedLock(opt)}
                    className="rounded-lg p-2.5 min-h-[44px] text-center cursor-pointer transition-all text-[12px]"
                    style={{
                      background: selectedLock.label === opt.label ? 'var(--color-purple-75)' : 'rgba(0,0,0,0.55)',
                      border: selectedLock.label === opt.label ? '1px solid var(--color-purple-30)' : '1px solid rgba(255,255,255,0.25)',
                      color: selectedLock.label === opt.label ? '#000000' : 'rgba(255,255,255,1)',
                    }}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Boost preview */}
            <div className="rounded-lg p-4 mb-4" style={{ background: 'var(--color-purple-75)', border: '1px solid var(--color-purple-75)' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-white text-[11px]">Your Boost</span>
                <span className="stat-value text-[16px] text-white">{boostDisplay}x</span>
              </div>
              {nft.holdsJBAC && (
                <div className="flex items-center justify-between mb-2">
                  <span className="text-white text-[11px]">Includes JBAC bonus</span>
                  <span className="text-white text-[11px]">+0.5x</span>
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
            {amtNum > 0 && pool?.isDeployed && parseFloat(pool.apr) > 0 && (
              <div className="rounded-lg p-4 mb-4" style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)' }}>
                <p className="text-emerald-400 text-[11px] font-semibold mb-2 uppercase tracking-wider">Projected Earnings</p>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: '30 Days', days: 30 },
                    { label: '90 Days', days: 90 },
                    { label: '1 Year', days: 365 },
                  ].map(({ label, days }) => {
                    const boostedApr = parseFloat(pool.apr) * (totalBoostBps / 10000);
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
              </div>
            )}

            <button onClick={handleStake}
              disabled={actions.isPending || actions.isConfirming || amtNum <= 0}
              className="btn-primary w-full py-3.5 text-[14px] disabled:opacity-70 disabled:cursor-not-allowed">
              {actions.isPending || actions.isConfirming
                ? 'Processing...'
                : stakeNeedsApproval ? 'Approve TOWELI' : amtNum <= 0 ? 'Enter Amount' : `Stake & Lock for ${selectedLock.label}`}
            </button>

            <p className="text-white text-[10px] text-center mt-3">
              Early exit available — {EARLY_WITHDRAWAL_PENALTY_PCT}% {PENALTY_COPY.earlyExitLabel} redistributed to stakers still farming with tegridy
            </p>
          </div>
        )}
        </div>
      </div>
    </m.div>
  );
}
