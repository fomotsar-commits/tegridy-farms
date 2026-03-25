import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Link } from 'react-router-dom';
import { ART } from '../lib/artConfig';
import { MIN_LOCK_DURATION, MAX_LOCK_DURATION, MIN_BOOST_BPS, MAX_BOOST_BPS, JBAC_BONUS_BPS, CURRENT_SEASON } from '../lib/constants';
import { useFarmStats } from '../hooks/useFarmStats';
import { usePoolData } from '../hooks/usePoolData';
import { useUserPosition } from '../hooks/useUserPosition';
import { useFarmActions } from '../hooks/useFarmActions';
import { useNFTBoost } from '../hooks/useNFTBoost';
import { formatTokenAmount } from '../lib/formatting';
import { AnimatedCounter } from '../components/AnimatedCounter';
import { Sparkline } from '../components/Sparkline';
import { PulseDot } from '../components/PulseDot';
import { useToweliPrice } from '../hooks/useToweliPrice';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';
import type { ReceiptType } from '../hooks/useTransactionReceipt';
import { useConfetti } from '../hooks/useConfetti';

const LOCK_OPTIONS = [
  { label: '7 Days', seconds: 7 * 86400 },
  { label: '30 Days', seconds: 30 * 86400 },
  { label: '90 Days', seconds: 90 * 86400 },
  { label: '6 Months', seconds: 180 * 86400 },
  { label: '1 Year', seconds: 365 * 86400 },
  { label: '2 Years', seconds: 730 * 86400 },
  { label: '4 Years', seconds: 1460 * 86400 },
];

function calculateBoost(durationSec: number): number {
  if (durationSec <= MIN_LOCK_DURATION) return MIN_BOOST_BPS;
  if (durationSec >= MAX_LOCK_DURATION) return MAX_BOOST_BPS;
  const range = MAX_LOCK_DURATION - MIN_LOCK_DURATION;
  const boostRange = MAX_BOOST_BPS - MIN_BOOST_BPS;
  const elapsed = durationSec - MIN_LOCK_DURATION;
  return MIN_BOOST_BPS + (elapsed * boostRange) / range;
}

export default function FarmPage() {
  const { isConnected } = useAccount();
  const stats = useFarmStats();
  const pool = usePoolData();
  const pos = useUserPosition();
  const actions = useFarmActions();
  const nft = useNFTBoost();
  const price = useToweliPrice();
  const priceHistory = usePriceHistory(price.priceInUsd);

  const { showReceipt } = useTransactionReceipt();
  const confetti = useConfetti();
  const lastActionRef = useRef<ReceiptType | null>(null);
  const receiptShownHashRef = useRef<string | null>(null);

  const [stakeAmount, setStakeAmount] = useState('');
  const [selectedLock, setSelectedLock] = useState(LOCK_OPTIONS[2]); // Default 90 days
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [confirmEarlyWithdraw, setConfirmEarlyWithdraw] = useState(false);

  const boostBps = calculateBoost(selectedLock.seconds);
  const nftBonus = nft.holdsJBAC ? JBAC_BONUS_BPS : 0;
  const totalBoostBps = Math.min(boostBps + nftBonus, 45000);
  const boostDisplay = (totalBoostBps / 10000).toFixed(2);

  const amtNum = parseFloat(stakeAmount) || 0;
  const effectiveStake = amtNum * totalBoostBps / 10000;

  // Season countdown
  const seasonEnd = new Date(CURRENT_SEASON.endDate).getTime();
  const daysLeft = Math.max(0, Math.ceil((seasonEnd - Date.now()) / 86400000));

  const handleStake = () => {
    if (amtNum <= 0) return;
    if (pos.needsApproval) {
      actions.approve(stakeAmount);
    } else {
      lastActionRef.current = 'stake';
      actions.stake(stakeAmount, BigInt(selectedLock.seconds));
    }
  };

  // Show transaction receipt on farm action success
  useEffect(() => {
    if (actions.isSuccess && actions.hash && receiptShownHashRef.current !== actions.hash) {
      receiptShownHashRef.current = actions.hash;
      const actionType = lastActionRef.current ?? 'stake';

      if (actionType === 'stake') {
        showReceipt({
          type: 'stake',
          data: {
            amount: stakeAmount,
            token: 'TOWELI',
            lockDuration: selectedLock.label,
            boost: boostDisplay,
            estimatedAPR: pool.isDeployed ? pool.apr : undefined,
            txHash: actions.hash,
          },
        });
      } else if (actionType === 'claim') {
        showReceipt({
          type: 'claim',
          data: {
            rewardAmount: pos.pendingFormatted,
            token: 'TOWELI',
            txHash: actions.hash,
          },
        });
      } else if (actionType === 'unstake') {
        showReceipt({
          type: 'unstake',
          data: {
            amount: pos.stakedFormatted,
            token: 'TOWELI',
            txHash: actions.hash,
          },
        });
      }

      // Fire confetti on stake or claim success
      if (actionType === 'stake' || actionType === 'claim') {
        confetti.fire();
      }
    }
  }, [actions.isSuccess, actions.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.jungleBus.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 20%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.2) 30%, rgba(0,0,0,0.35) 60%, rgba(0,0,0,0.6) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-20 pb-12">
        <motion.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Farm</h1>
          <p className="text-white/50 text-[14px]">Stake TOWELI and earn rewards &middot; <span className="text-primary/40">FAFO</span></p>
        </motion.div>

        {/* Stats */}
        <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          {[
            { l: 'Total Value Locked', v: stats.tvl, art: ART.apeHug.src, pos: 'center 30%' },
            { l: 'TOWELI Price', v: stats.toweliPrice, art: ART.roseApe.src, pos: 'center 30%' },
            { l: 'Base APR', v: pool.isDeployed ? `${pool.apr}%` : '–', accent: true, art: ART.wrestler.src, pos: 'center 0%' },
            { l: 'Season', v: `${daysLeft}d left`, sub: CURRENT_SEASON.name, art: ART.beachSunset.src, pos: 'center 30%' },
          ].map((s) => (
            <div key={s.l} className="relative overflow-hidden rounded-xl card-hover" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
              <div className="absolute inset-0">
                <img src={s.art} alt="" className="w-full h-full object-cover" style={{ objectPosition: s.pos }} />
                <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(6,12,26,0.40) 0%, rgba(6,12,26,0.75) 50%, rgba(6,12,26,0.92) 100%)' }} />
              </div>
              <div className="relative z-10 p-5 pt-8 pb-6">
              <p className="text-white/50 text-[11px] uppercase tracking-wider mb-2 flex items-center gap-1.5">{s.l}{s.l === 'TOWELI Price' && <PulseDot size={5} />}</p>
              <div className="flex items-center gap-2">
                <p className={`stat-value text-2xl ${s.accent ? 'text-primary' : 'text-white'}`}>{s.v}</p>
                {s.l === 'TOWELI Price' && priceHistory.length > 1 && (
                  <Sparkline data={priceHistory} width={48} height={18} />
                )}
              </div>
              {s.sub && <p className="text-white/30 text-[11px] mt-1">{s.sub}</p>}
              </div>
            </div>
          ))}
        </motion.div>

        {/* Season banner */}
        <motion.div className="relative overflow-hidden rounded-xl mb-8" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="absolute inset-0">
            <img src={ART.bobowelie.src} alt="" className="w-full h-full object-cover" />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
          </div>
          <div className="relative z-10 p-6 py-8 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-white text-[17px] font-semibold">Season {CURRENT_SEASON.number}: {CURRENT_SEASON.name}</span>
                {nft.boostLabel && <span className="badge badge-warning text-[10px]">{nft.boostLabel}</span>}
              </div>
              <p className="text-white/40 text-[13px]">
                Lock TOWELI for up to 4x boost. Longer lock = more rewards + governance power.
              </p>
            </div>
            {nft.holdsJBAC && (
              <div className="text-right">
                <p className="stat-value text-[16px] text-primary">+0.5x NFT Boost</p>
                <p className="text-white/25 text-[11px]">{nft.holdsGoldCard ? 'Gold Card' : 'JBAC Holder'}</p>
              </div>
            )}
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-12">
          {/* Staking Card */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <div className="relative overflow-hidden rounded-xl glass-card-animated card-hover" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
              <div className="absolute inset-0">
                <img src={ART.poolParty.src} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(6,12,26,0.40) 0%, rgba(6,12,26,0.75) 50%, rgba(6,12,26,0.92) 100%)' }} />
              </div>
              <div className="relative z-10 p-6">
              <h3 className="heading-luxury text-white text-[20px] mb-5">
                {pos.hasPosition ? 'Your Position' : 'Stake TOWELI'}
              </h3>

              {pos.hasPosition ? (
                /* Existing position display */
                <div>
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
                      <p className="text-white/30 text-[10px] mb-0.5">Staked</p>
                      <AnimatedCounter value={parseFloat(pos.stakedFormatted) || 0} decimals={2} className="stat-value text-[16px] text-white" />
                    </div>
                    <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
                      <p className="text-white/30 text-[10px] mb-0.5">Boost</p>
                      <AnimatedCounter value={pos.boostMultiplier} decimals={2} suffix="x" className="stat-value text-[16px] text-primary" />
                    </div>
                    <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
                      <p className="text-white/30 text-[10px] mb-0.5">Claimable</p>
                      <AnimatedCounter value={parseFloat(pos.pendingFormatted) || 0} decimals={4} className="stat-value text-[16px] text-primary" />
                    </div>
                    <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
                      <p className="text-white/30 text-[10px] mb-0.5">Lock Expires</p>
                      <p className="stat-value text-[14px] text-white">
                        {pos.autoMaxLock ? 'Auto-Max' : pos.isLocked ? new Date(pos.lockEnd * 1000).toLocaleDateString() : 'Unlocked'}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <button onClick={() => { lastActionRef.current = 'claim'; actions.claim(pos.tokenId); }}
                      disabled={actions.isPending || actions.isConfirming || Number(pos.pendingFormatted) < 0.01}
                      className="btn-primary w-full py-3 text-[14px] disabled:opacity-35 disabled:cursor-not-allowed">
                      {actions.isPending || actions.isConfirming ? 'Processing...' : 'Claim Rewards'}
                    </button>
                    <div className="grid grid-cols-2 gap-2">
                      {pos.canWithdraw && !confirmWithdraw && (
                        <button onClick={() => setConfirmWithdraw(true)}
                          disabled={actions.isPending || actions.isConfirming}
                          className="btn-secondary w-full py-2.5 text-[13px] disabled:opacity-35">
                          Withdraw
                        </button>
                      )}
                      {pos.canWithdraw && confirmWithdraw && (
                        <div className="col-span-2 rounded-lg p-3" style={{ background: 'rgba(255,178,55,0.06)', border: '1px solid rgba(255,178,55,0.15)' }}>
                          <p className="text-warning/80 text-[11px] mb-2">Are you sure you want to withdraw your staked TOWELI?</p>
                          <div className="flex gap-2">
                            <button onClick={() => setConfirmWithdraw(false)}
                              className="flex-1 py-2 rounded-lg text-[12px] text-white/50 cursor-pointer"
                              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                              Cancel
                            </button>
                            <button onClick={() => { setConfirmWithdraw(false); lastActionRef.current = 'unstake'; actions.withdraw(pos.tokenId); }}
                              disabled={actions.isPending || actions.isConfirming}
                              className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-warning cursor-pointer disabled:opacity-35"
                              style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.25)' }}>
                              Confirm Withdraw
                            </button>
                          </div>
                        </div>
                      )}
                      {pos.isLocked && !confirmEarlyWithdraw && (
                        <button onClick={() => setConfirmEarlyWithdraw(true)}
                          disabled={actions.isPending || actions.isConfirming}
                          className="w-full py-2.5 text-[13px] rounded-lg disabled:opacity-35"
                          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: 'rgba(239,68,68,0.8)' }}>
                          Early Withdraw (25% penalty)
                        </button>
                      )}
                      {pos.isLocked && confirmEarlyWithdraw && (
                        <div className="col-span-2 rounded-lg p-3" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
                          <p className="text-danger text-[11px] font-semibold mb-1">You will lose 25% of your staked TOWELI. This cannot be undone.</p>
                          <div className="flex gap-2 mt-2">
                            <button onClick={() => setConfirmEarlyWithdraw(false)}
                              className="flex-1 py-2 rounded-lg text-[12px] text-white/50 cursor-pointer"
                              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                              Cancel
                            </button>
                            <button onClick={() => { setConfirmEarlyWithdraw(false); lastActionRef.current = 'unstake'; actions.earlyWithdraw(pos.tokenId); }}
                              disabled={actions.isPending || actions.isConfirming}
                              className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-danger cursor-pointer disabled:opacity-35"
                              style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)' }}>
                              Confirm Early Withdrawal
                            </button>
                          </div>
                        </div>
                      )}
                      <button onClick={() => actions.toggleAutoMaxLock(pos.tokenId)}
                        disabled={actions.isPending || actions.isConfirming}
                        className="btn-secondary w-full py-2.5 text-[13px] disabled:opacity-35">
                        {pos.autoMaxLock ? 'Disable Auto-Lock' : 'Enable Auto-Max Lock'}
                      </button>
                    </div>
                    <Link to="/restake" className="text-center text-primary/60 text-[12px] hover:text-primary transition-colors mt-1">
                      Restake for bonus yield &#8594;
                    </Link>
                  </div>
                </div>
              ) : !isConnected ? (
                <div className="text-center py-8">
                  <p className="text-white/40 text-[13px] mb-4">Connect wallet to start staking</p>
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
                      <label className="text-white/40 text-[11px] uppercase tracking-wider">Amount</label>
                      <button onClick={() => setStakeAmount(pos.walletBalanceFormatted)}
                        className="text-primary/50 text-[11px] hover:text-primary transition-colors cursor-pointer">
                        Balance: {formatTokenAmount(pos.walletBalanceFormatted, 0)}
                      </button>
                    </div>
                    <input type="number" value={stakeAmount} onChange={(e) => setStakeAmount(e.target.value)}
                      placeholder="0" min="0"
                      className="w-full rounded-lg p-4 font-mono text-xl text-white outline-none token-input"
                      style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.12)' }} />
                  </div>

                  <div className="mb-4">
                    <label className="text-white/40 text-[11px] uppercase tracking-wider mb-2 block">Lock Duration</label>
                    <div className="grid grid-cols-4 gap-2">
                      {LOCK_OPTIONS.map((opt) => (
                        <button key={opt.label} onClick={() => setSelectedLock(opt)}
                          className="rounded-lg p-2.5 text-center cursor-pointer transition-all text-[12px]"
                          style={{
                            background: selectedLock.label === opt.label ? 'rgba(139,92,246,0.12)' : 'rgba(255,255,255,0.03)',
                            border: selectedLock.label === opt.label ? '1px solid rgba(139,92,246,0.3)' : '1px solid rgba(255,255,255,0.06)',
                            color: selectedLock.label === opt.label ? '#8b5cf6' : 'rgba(255,255,255,0.5)',
                          }}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Boost preview */}
                  <div className="rounded-lg p-4 mb-4" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-white/40 text-[11px]">Your Boost</span>
                      <span className="stat-value text-[16px] text-primary">{boostDisplay}x</span>
                    </div>
                    {nft.holdsJBAC && (
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-white/30 text-[11px]">Includes JBAC bonus</span>
                        <span className="text-primary/50 text-[11px]">+0.5x</span>
                      </div>
                    )}
                    {amtNum > 0 && (
                      <>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-white/30 text-[11px]">Effective stake</span>
                          <span className="text-white/60 text-[11px]">{formatTokenAmount(effectiveStake.toString(), 0)} TOWELI</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-white/30 text-[11px]">Voting power</span>
                          <span className="text-white/60 text-[11px]">{formatTokenAmount(effectiveStake.toString(), 0)}</span>
                        </div>
                      </>
                    )}
                  </div>

                  <button onClick={handleStake}
                    disabled={actions.isPending || actions.isConfirming || amtNum <= 0}
                    className="btn-primary w-full py-3.5 text-[14px] disabled:opacity-35 disabled:cursor-not-allowed">
                    {actions.isPending || actions.isConfirming
                      ? 'Processing...'
                      : pos.needsApproval ? 'Approve TOWELI' : amtNum <= 0 ? 'Enter Amount' : `Stake & Lock for ${selectedLock.label}`}
                  </button>

                  <p className="text-white/20 text-[10px] text-center mt-3">
                    Early withdrawal available with 25% penalty (redistributed to stakers)
                  </p>
                </div>
              )}
              </div>
            </div>
          </motion.div>

          {/* Boost Table */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <div className="relative overflow-hidden rounded-xl" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
              <div className="absolute inset-0">
                <img src={ART.boxingRing.src} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(6,12,26,0.40) 0%, rgba(6,12,26,0.75) 50%, rgba(6,12,26,0.92) 100%)' }} />
              </div>
              <div className="relative z-10 p-6">
              <h3 className="heading-luxury text-white text-[20px] mb-5">Boost Schedule</h3>
              <p className="text-white/40 text-[12px] mb-4">Lock longer = higher boost + more voting power. JBAC NFT holders get +0.5x bonus.</p>

              <div className="space-y-1.5">
                {LOCK_OPTIONS.map((opt) => {
                  const b = calculateBoost(opt.seconds);
                  const withNft = b + JBAC_BONUS_BPS;
                  return (
                    <div key={opt.label} className="flex items-center justify-between rounded-lg px-4 py-2.5"
                      style={{
                        background: selectedLock.label === opt.label ? 'rgba(139,92,246,0.08)' : 'rgba(255,255,255,0.02)',
                        border: selectedLock.label === opt.label ? '1px solid rgba(139,92,246,0.2)' : '1px solid transparent',
                      }}>
                      <span className="text-white/60 text-[13px]">{opt.label}</span>
                      <div className="flex items-center gap-3">
                        <span className="stat-value text-[14px] text-primary">{(b / 10000).toFixed(2)}x</span>
                        <span className="text-white/20 text-[11px]">({(withNft / 10000).toFixed(2)}x w/NFT)</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-6 relative overflow-hidden rounded-lg" style={{ border: '1px solid rgba(255,178,55,0.12)' }}>
                <div className="absolute inset-0">
                  <img src={ART.chaosScene.src} alt="" className="w-full h-full object-cover" />
                  <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
                </div>
                <div className="relative z-10 p-4">
                  <p className="text-warning/80 text-[12px] font-medium mb-1">Early Withdrawal</p>
                  <p className="text-white/40 text-[11px]">
                    You can exit your lock at any time with a 25% penalty. Penalty tokens are redistributed to remaining stakers — so diamond hands get rewarded.
                  </p>
                </div>
              </div>

              <div className="mt-4 relative overflow-hidden rounded-lg" style={{ border: '1px solid rgba(139,92,246,0.10)' }}>
                <div className="absolute inset-0">
                  <img src={ART.forestScene.src} alt="" className="w-full h-full object-cover" />
                  <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
                </div>
                <div className="relative z-10 p-4">
                  <p className="text-primary/80 text-[12px] font-medium mb-1">Auto-Max Lock</p>
                  <p className="text-white/40 text-[11px]">
                    Enable auto-max lock to keep maximum boost (4.0x) perpetually. Your lock auto-renews on every claim. Disable anytime to let it expire naturally.
                  </p>
                </div>
              </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
