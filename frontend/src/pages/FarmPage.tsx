import { useState, useEffect, useRef } from 'react';
import { m } from 'framer-motion';
import { useAccount } from 'wagmi';
import { Link } from 'react-router-dom';
import { pageArt } from '../lib/artConfig';
import { JBAC_BONUS_BPS, CURRENT_SEASON } from '../lib/constants';
import { calculateBoost } from '../lib/boostCalculations';
import { useFarmStats } from '../hooks/useFarmStats';
import { usePoolData } from '../hooks/usePoolData';
import { useUserPosition } from '../hooks/useUserPosition';
import { useFarmActions } from '../hooks/useFarmActions';
import { useNFTBoost } from '../hooks/useNFTBoost';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { useTransactionReceipt } from '../hooks/useTransactionReceipt';
import type { ReceiptType } from '../hooks/useTransactionReceipt';
import { useConfetti } from '../hooks/useConfetti';
import { useNetworkCheck } from '../hooks/useNetworkCheck';
import { usePoolTVL } from '../hooks/usePoolTVL';
import { useLPFarming } from '../hooks/useLPFarming';
import { usePageTitle } from '../hooks/usePageTitle';
import { usePoints } from '../hooks/usePoints';
import { useAutoReset } from '../hooks/useAutoReset';
import { useRestaking } from '../hooks/useRestaking';
import { parseEther } from 'viem';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';
import { ConnectPrompt } from '../components/ui/ConnectPrompt';

import { FarmStatsRow } from '../components/farm/FarmStatsRow';
import { LPFarmingSection } from '../components/farm/LPFarmingSection';
import { StakingCard } from '../components/farm/StakingCard';
import type { ConfirmState } from '../components/farm/StakingCard';
import { BoostScheduleTable } from '../components/farm/BoostScheduleTable';
import { UPCOMING_POOLS } from '../components/farm/poolConfig';
import { LivePoolCard } from '../components/farm/LivePoolCard';
import { UpcomingPoolCard } from '../components/farm/UpcomingPoolCard';
import { ArtImg } from '../components/ArtImg';

/* ── Staking Lock Options ────────────────────────────────────────────── */
const LOCK_OPTIONS = [
  { label: '7 Days', seconds: 7 * 86400 },
  { label: '30 Days', seconds: 30 * 86400 },
  { label: '90 Days', seconds: 90 * 86400 },
  { label: '6 Months', seconds: 180 * 86400 },
  { label: '1 Year', seconds: 365 * 86400 },
  { label: '2 Years', seconds: 730 * 86400 },
  { label: '4 Years', seconds: 1460 * 86400 },
];

export default function FarmPage() {
  usePageTitle('Farm');
  const { isConnected } = useAccount();
  const { isWrongNetwork } = useNetworkCheck();
  const stats = useFarmStats();
  const pool = usePoolData();
  const pos = useUserPosition();
  const actions = useFarmActions();
  const nft = useNFTBoost();
  const points = usePoints();
  const price = useTOWELIPrice();
  const priceHistory = usePriceHistory(price.priceInUsd);
  const { history: priceData, error: priceError } = priceHistory;

  const { showReceipt } = useTransactionReceipt();
  const confetti = useConfetti();
  const lastActionRef = useRef<ReceiptType | null>(null);
  const receiptShownHashRef = useRef<string | null>(null);
  // Capture values at submission time to avoid stale closures in the receipt effect
  const submittedDataRef = useRef<{ stakeAmount: string; lockLabel: string; boostDisplay: string } | null>(null);

  const [stakeAmount, setStakeAmount] = useState('');
  const [selectedLock, setSelectedLock] = useState(LOCK_OPTIONS[2]!); // Default 90 days
  const [extendLockDuration, setExtendLockDuration] = useState(LOCK_OPTIONS[2]!);
  const [confirms, setConfirms] = useState<ConfirmState>({
    withdraw: false,
    earlyWithdraw: false,
    emergencyExit: false,
    extendLock: false,
  });
  const setConfirm = (key: keyof ConfirmState, val: boolean) =>
    setConfirms((prev) => ({ ...prev, [key]: val }));

  const poolTVL = usePoolTVL();
  const lpFarm = useLPFarming();
  const restaking = useRestaking();

  // Auto-dismiss confirmation dialogs after 5 seconds (regular withdrawals only).
  // Emergency exit is a dangerous financial action — never auto-dismiss.
  useAutoReset(confirms.withdraw, (v: boolean) => setConfirm('withdraw', v), 5000);
  useAutoReset(confirms.earlyWithdraw, (v: boolean) => setConfirm('earlyWithdraw', v), 5000);

  const boostBps = calculateBoost(selectedLock.seconds);
  const nftBonus = nft.holdsJBAC ? JBAC_BONUS_BPS : 0;
  const totalBoostBps = Math.min(boostBps + nftBonus, 45000);
  const boostDisplay = (totalBoostBps / 10000).toFixed(2);

  const amtNum = parseFloat(stakeAmount) || 0;
  const effectiveStake = amtNum * totalBoostBps / 10000;

  // Season countdown
  const seasonEnd = new Date(CURRENT_SEASON.endDate).getTime();
  const daysLeft = Math.max(0, Math.ceil((seasonEnd - Date.now()) / 86400000));

  const stakeNeedsApproval = pos.allowance < (amtNum > 0 ? parseEther(stakeAmount) : 0n);

  const handleStake = () => {
    if (amtNum <= 0) return;
    if (stakeNeedsApproval) {
      actions.approve(stakeAmount);
    } else {
      lastActionRef.current = 'stake';
      submittedDataRef.current = { stakeAmount, lockLabel: selectedLock.label, boostDisplay };
      actions.stake(stakeAmount, BigInt(selectedLock.seconds));
    }
  };

  // Show transaction receipt on farm action success
  useEffect(() => {
    if (actions.isSuccess && actions.hash && receiptShownHashRef.current !== actions.hash) {
      receiptShownHashRef.current = actions.hash;
      const actionType = lastActionRef.current ?? 'stake';

      if (actionType === 'stake') {
        const submitted = submittedDataRef.current;
        showReceipt({
          type: 'stake',
          data: {
            amount: submitted?.stakeAmount ?? stakeAmount,
            token: 'TOWELI',
            lockDuration: submitted?.lockLabel ?? selectedLock.label,
            boost: submitted?.boostDisplay ?? boostDisplay,
            estimatedAPR: pool.isDeployed ? pool.apr : undefined,
            txHash: actions.hash,
          },
        });
        submittedDataRef.current = null;
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

      // Log points for farm actions
      points.logAction(actionType, nft.holdsGoldCard);

      // Fire confetti on stake or claim success
      if (actionType === 'stake' || actionType === 'claim') {
        confetti.fire();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stakeAmount/selectedLock/boostDisplay captured via submittedDataRef at submission time
  }, [actions.isSuccess, actions.hash, showReceipt, confetti, pool.isDeployed, pool.apr, pos.pendingFormatted, pos.stakedFormatted]);

  // Wallet-gate: render ConnectPrompt instead of broken interactive UI
  // when no wallet is connected. Keeps the scenery, swaps the content.
  if (!isConnected) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <ArtImg pageId="farm" idx={0} fallbackPosition="center 20%" alt="" loading="lazy" className="w-full h-full object-cover" />
          <div className="absolute inset-0" style={{ background: 'rgba(6, 12, 26, 0.55)' }} aria-hidden="true" />
        </div>
        <div className="relative z-10 pt-20">
          <ConnectPrompt surface="farm" />
        </div>
      </div>
    );
  }

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="farm" idx={0} fallbackPosition="center 20%" alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <ErrorBoundary>
      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        {/* Wrong network banner (#82 audit) */}
        {isWrongNetwork && (
          <div role="alert" aria-live="assertive" className="mb-4 px-5 py-4 rounded-xl text-[14px] font-semibold text-yellow-200 flex items-center gap-3" style={{ background: 'rgba(234,179,8,0.18)', border: '2px solid rgba(234,179,8,0.4)' }}>
            <span className="text-[20px]" aria-hidden="true">&#9888;</span>
            Wrong network detected &mdash; please switch to Ethereum Mainnet to use this app.
          </div>
        )}
        <m.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl text-white tracking-tight mb-1">Farm</h1>
          <p className="text-white text-[14px]">Stake TOWELI and earn rewards &middot; <span className="text-white">FAFO</span></p>
        </m.div>

        {/* Stats */}
        <FarmStatsRow
          stats={stats}
          pool={pool}
          price={price}
          priceData={priceData}
          priceError={priceError}
          daysLeft={daysLeft}
        />

        {/* Season banner */}
        <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-8" style={{ border: '1px solid var(--color-purple-75)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="absolute inset-0">
            <ArtImg pageId="farm" idx={1} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 m-2 md:m-3 rounded-lg p-4 md:p-6 py-6 md:py-7 flex flex-col md:flex-row md:items-center justify-between gap-3" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-white text-[17px] font-semibold">Season {CURRENT_SEASON.number}: {CURRENT_SEASON.name}</span>
                {nft.boostLabel && <span className="badge badge-warning text-[10px]">{nft.boostLabel}</span>}
              </div>
              <p className="text-white text-[13px]">
                Lock TOWELI for up to 4x boost. Longer lock = more rewards + governance power.
              </p>
            </div>
            {nft.holdsJBAC && (
              <div className="md:text-right">
                <p className="stat-value text-[16px] text-white">+0.5x NFT Boost</p>
                <p className="text-white text-[11px]">{nft.holdsGoldCard ? 'Gold Card' : 'JBAC Holder'}</p>
              </div>
            )}
          </div>
        </m.div>

        {/* ── Native LP Pools ── */}
        <m.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="heading-luxury text-white text-[22px] tracking-tight">Liquidity Pools</h2>
              <p className="text-white text-[13px] mt-0.5">Provide liquidity to native pairs &middot; earn trading fees</p>
            </div>
            <Link to="/liquidity" className="text-white/60 text-[12px] hover:text-white transition-colors">
              View all pools &#8594;
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <LivePoolCard poolData={poolTVL} />
            {UPCOMING_POOLS.map((pool) => (
              <UpcomingPoolCard key={pool.id} pool={pool} />
            ))}
          </div>
        </m.div>

        {/* ── LP Farming ── */}
        <LPFarmingSection lpFarm={lpFarm} isConnected={isConnected} />

        {/* ── Restaking (Bonus Yield Layer) ── */}
        {isConnected && pos.hasPosition && (
          <m.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="heading-luxury text-white text-[22px] tracking-tight">Restaking</h2>
                <p className="text-white text-[13px] mt-0.5">Earn bonus TOWELI rewards on top of your staking position</p>
              </div>
              {restaking.bonusAPR > 0 && (
                <span className="stat-value text-[15px] text-green-400">+{restaking.bonusAPR.toFixed(1)}% Bonus APR</span>
              )}
            </div>
            <div className="glass-card p-5 rounded-xl" style={{ border: '1px solid var(--color-purple-12)' }}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
                <div>
                  <p className="text-white/90 text-[10px] uppercase tracking-wider mb-0.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Status</p>
                  <p className="stat-value text-[14px]" style={{ color: restaking.isRestaked ? '#22c55e' : 'var(--color-purple-75)' }}>
                    {restaking.isRestaked ? 'Active' : 'Not Restaked'}
                  </p>
                </div>
                <div>
                  <p className="text-white/90 text-[10px] uppercase tracking-wider mb-0.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Restaked</p>
                  <p className="stat-value text-[14px] text-white">{restaking.restakedFormatted.toLocaleString()} TOWELI</p>
                </div>
                <div>
                  <p className="text-white/90 text-[10px] uppercase tracking-wider mb-0.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Pending Rewards</p>
                  <p className="stat-value text-[14px] text-green-400">{restaking.pendingTotalFormatted.toFixed(4)} TOWELI</p>
                </div>
                <div>
                  <p className="text-white/90 text-[10px] uppercase tracking-wider mb-0.5" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>Total Restaked (Protocol)</p>
                  <p className="stat-value text-[14px] text-white">{restaking.totalRestakedFormatted.toLocaleString()}</p>
                </div>
              </div>
              {restaking.pendingTotalFormatted > 0 && (
                <div className="flex items-center gap-3 mb-4 px-3 py-2 rounded-lg" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}>
                  <span className="text-white/60 text-[11px]">Base: {restaking.pendingBaseFormatted.toFixed(4)}</span>
                  <span className="text-white/30">+</span>
                  <span className="text-green-400 text-[11px]">Bonus: {restaking.pendingBonusFormatted.toFixed(4)}</span>
                </div>
              )}
              <div className="flex gap-3">
                {!restaking.isRestaked ? (
                  <button
                    onClick={restaking.restake}
                    disabled={restaking.isPending || restaking.isConfirming}
                    className="btn-primary px-6 py-2.5 min-h-[44px] text-[13px] flex-1"
                  >
                    {restaking.isPending ? 'Confirm in wallet...' : restaking.isConfirming ? 'Confirming...' : 'Restake Position'}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={restaking.claimAll}
                      disabled={restaking.isPending || restaking.isConfirming || restaking.pendingTotal === 0n}
                      className="btn-primary px-6 py-2.5 min-h-[44px] text-[13px] flex-1"
                    >
                      {restaking.isPending ? 'Confirm...' : restaking.isConfirming ? 'Confirming...' : `Claim ${restaking.pendingTotalFormatted.toFixed(4)} TOWELI`}
                    </button>
                    <button
                      onClick={restaking.unrestake}
                      disabled={restaking.isPending || restaking.isConfirming}
                      className="btn-outline px-4 py-2.5 min-h-[44px] text-[13px]"
                    >
                      Unrestake
                    </button>
                  </>
                )}
              </div>
            </div>
          </m.div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-12">
          {/* Staking Card */}
          <StakingCard
            isConnected={isConnected}
            pos={pos}
            actions={actions}
            nft={nft}
            pool={{ apr: pool.apr, isDeployed: pool.isDeployed }}
            input={{
              amount: stakeAmount,
              setAmount: setStakeAmount,
              lock: selectedLock,
              setLock: setSelectedLock,
              extendLockDuration,
              setExtendLockDuration,
            }}
            confirms={confirms}
            setConfirm={setConfirm}
            computed={{
              boostDisplay,
              totalBoostBps,
              amtNum,
              effectiveStake,
              stakeNeedsApproval,
            }}
            handleStake={handleStake}
            lastActionRef={lastActionRef}
          />

          {/* Boost Table */}
          <BoostScheduleTable selectedLockLabel={selectedLock.label} apr={pool.apr} />
        </div>
      </div>
      </ErrorBoundary>
    </div>
  );
}
