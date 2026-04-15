import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { Link } from 'react-router-dom';
import { ART } from '../lib/artConfig';
import { MIN_LOCK_DURATION, MAX_LOCK_DURATION, MIN_BOOST_BPS, MAX_BOOST_BPS, JBAC_BONUS_BPS, CURRENT_SEASON } from '../lib/constants';
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
import { parseEther } from 'viem';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';

import { FarmStatsRow } from '../components/farm/FarmStatsRow';
import { LPFarmingSection } from '../components/farm/LPFarmingSection';
import { StakingCard } from '../components/farm/StakingCard';
import { BoostScheduleTable } from '../components/farm/BoostScheduleTable';

/* ── Native LP Pools ─────────────────────────────────────────────────── */
interface LPPool {
  id: string;
  name: string;
  tokenA: { symbol: string; logo: string; };
  tokenB: { symbol: string; logo: string; };
  fee: string;
  tvl: string;
  apr: string;
  volume24h: string;
  status: 'live' | 'new' | 'hot' | 'soon';
  art: string;
  artPos: string;
}

// Token logo URLs from CoinGecko
const TOKEN_LOGOS: Record<string, string> = {
  TOWELI: '/art/bobowelie.jpg',
  ETH: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
  WETH: 'https://assets.coingecko.com/coins/images/2518/small/weth.png',
  USDT: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  USDC: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',
  WBTC: 'https://assets.coingecko.com/coins/images/7598/small/wrapped_bitcoin_wbtc.png',
  DOT: 'https://assets.coingecko.com/coins/images/12171/small/polkadot.png',
  MANA: 'https://assets.coingecko.com/coins/images/878/small/decentraland-mana.png',
};

const UPCOMING_POOLS: Omit<LPPool, 'tvl' | 'apr' | 'volume24h'>[] = [
  {
    id: 'usdt-usdc',
    name: 'USDT / USDC',
    tokenA: { symbol: 'USDT', logo: TOKEN_LOGOS.USDT! },
    tokenB: { symbol: 'USDC', logo: TOKEN_LOGOS.USDC! },
    fee: '0.05%',
    status: 'soon',
    art: ART.beachSunset.src,
    artPos: 'center 40%',
  },
  {
    id: 'eth-wbtc',
    name: 'ETH / WBTC',
    tokenA: { symbol: 'ETH', logo: TOKEN_LOGOS.ETH! },
    tokenB: { symbol: 'WBTC', logo: TOKEN_LOGOS.WBTC! },
    fee: '0.3%',
    status: 'soon',
    art: ART.boxingRing.src,
    artPos: 'center 20%',
  },
  {
    id: 'dot-eth',
    name: 'DOT / ETH',
    tokenA: { symbol: 'DOT', logo: TOKEN_LOGOS.DOT! },
    tokenB: { symbol: 'ETH', logo: TOKEN_LOGOS.ETH! },
    fee: '0.3%',
    status: 'soon',
    art: ART.forestScene.src,
    artPos: 'center 30%',
  },
  {
    id: 'mana-eth',
    name: 'MANA / ETH',
    tokenA: { symbol: 'MANA', logo: TOKEN_LOGOS.MANA! },
    tokenB: { symbol: 'ETH', logo: TOKEN_LOGOS.ETH! },
    fee: '0.3%',
    status: 'soon',
    art: ART.jungleDark.src,
    artPos: 'center 20%',
  },
];

function PoolStatusBadge({ status }: { status: LPPool['status'] }) {
  const styles = {
    live: { bg: 'rgba(45,139,78,0.15)', border: 'rgba(45,139,78,0.35)', color: '#2D8B4E', label: 'LIVE' },
    new: { bg: 'rgba(139,92,246,0.75)', border: 'rgba(139,92,246,0.75)', color: '#000000', label: 'NEW' },
    hot: { bg: 'rgba(239,68,68,0.15)', border: 'rgba(239,68,68,0.35)', color: '#ef4444', label: '🔥 HOT' },
    soon: { bg: 'rgba(139,92,246,0.75)', border: 'rgba(139,92,246,0.75)', color: '#000000', label: 'PROPOSED · NOT GUARANTEED' },
  };
  const s = styles[status];
  return (
    <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full"
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
      {s.label}
    </span>
  );
}

/** Live TOWELI/ETH pool card with on-chain data */
function LivePoolCard({ poolData }: { poolData: ReturnType<typeof usePoolTVL> }) {
  return (
    <div className="relative overflow-hidden rounded-xl card-hover group" style={{ border: '1px solid rgba(239,68,68,0.15)' }}>
      <div className="absolute inset-0">
        <img src={ART.poolParty.src} alt="" loading="lazy" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" style={{ objectPosition: 'center 30%' }} />
      </div>
      <div className="relative z-10 p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2">
              <img src={TOKEN_LOGOS.TOWELI} alt="TOWELI" className="w-9 h-9 rounded-full object-cover"
                style={{ border: '2px solid rgba(139,92,246,0.3)' }} />
              <img src={TOKEN_LOGOS.ETH} alt="ETH" className="w-9 h-9 rounded-full object-cover bg-[#627eea]/20"
                style={{ border: '2px solid rgba(45,139,78,0.3)' }} />
            </div>
            <div>
              <p className="text-white font-semibold text-[15px]">TOWELI / ETH</p>
              <p className="text-white text-[11px]">Fee: 0.3%</p>
            </div>
          </div>
          <PoolStatusBadge status="hot" />
        </div>

        {/* Stats Grid — live data */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
          <div className="rounded-lg p-2.5" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
            <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-0.5">TVL</p>
            <p className="stat-value text-[14px] text-white">{poolData.tvlFormatted}</p>
          </div>
          <div className="rounded-lg p-2.5" style={{ background: 'rgba(45,139,78,0.04)', border: '1px solid rgba(45,139,78,0.08)' }}>
            <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-0.5">Est. APR</p>
            <p className="stat-value text-[14px] text-white">{poolData.apr}</p>
          </div>
          <div className="rounded-lg p-2.5" style={{ background: 'rgba(212,160,23,0.04)', border: '1px solid rgba(212,160,23,0.08)' }}>
            <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-0.5">Est. 24h Vol</p>
            <p className="stat-value text-[14px] text-white">{poolData.vol24hFormatted}</p>
          </div>
        </div>

        <p className="text-white text-[10px] mb-3 text-center">APR &amp; volume estimated from on-chain reserves</p>

        {/* Action */}
        <Link to="/liquidity" className="btn-primary w-full py-2.5 text-[13px] text-center block">
          Provide Liquidity
        </Link>
      </div>
    </div>
  );
}

/** Coming soon pool card */
function UpcomingPoolCard({ pool }: { pool: typeof UPCOMING_POOLS[number] }) {
  return (
    <div className="relative overflow-hidden rounded-xl glass-card-animated card-hover group" style={{ border: '1px solid rgba(139,92,246,0.75)' }}>
      <div className="absolute inset-0">
        <img src={pool.art} alt="" loading="lazy" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" style={{ objectPosition: pool.artPos }} />
      </div>
      <div className="relative z-10 p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2">
              <img src={pool.tokenA.logo} alt={pool.tokenA.symbol} className="w-9 h-9 rounded-full object-cover bg-black/60"
                style={{ border: '2px solid rgba(255,255,255,0.12)' }} />
              <img src={pool.tokenB.logo} alt={pool.tokenB.symbol} className="w-9 h-9 rounded-full object-cover bg-black/60"
                style={{ border: '2px solid rgba(255,255,255,0.12)' }} />
            </div>
            <div>
              <p className="text-white font-semibold text-[15px]">{pool.name}</p>
              <p className="text-white text-[11px]">Fee: {pool.fee}</p>
            </div>
          </div>
          <PoolStatusBadge status="soon" />
        </div>

        {/* Placeholder Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
          {['TVL', 'APR', '24h Vol'].map((label) => (
            <div key={label} className="rounded-lg p-2.5" style={{ background: 'rgba(0,0,0,0.50)', border: '1px solid rgba(255,255,255,0.20)' }}>
              <p className="text-white text-[10px] uppercase tracking-wider label-pill mb-0.5">{label}</p>
              <p className="stat-value text-[14px] text-white">–</p>
            </div>
          ))}
        </div>

        {/* Action — link to liquidity page */}
        <Link to="/liquidity" className="w-full py-2.5 text-[13px] text-center rounded-lg font-semibold block transition-colors"
          style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.25)', color: '#000000' }}>
          Add Liquidity
        </Link>
      </div>
    </div>
  );
}

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

function calculateBoost(durationSec: number): number {
  if (durationSec <= MIN_LOCK_DURATION) return MIN_BOOST_BPS;
  if (durationSec >= MAX_LOCK_DURATION) return MAX_BOOST_BPS;
  const range = MAX_LOCK_DURATION - MIN_LOCK_DURATION;
  const boostRange = MAX_BOOST_BPS - MIN_BOOST_BPS;
  const elapsed = durationSec - MIN_LOCK_DURATION;
  return MIN_BOOST_BPS + (elapsed * boostRange) / range;
}

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
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [confirmEarlyWithdraw, setConfirmEarlyWithdraw] = useState(false);
  const [showExtendLock, setShowExtendLock] = useState(false);
  const [extendLockDuration, setExtendLockDuration] = useState(LOCK_OPTIONS[2]!);
  const [confirmEmergencyExit, setConfirmEmergencyExit] = useState(false);

  const poolTVL = usePoolTVL();
  const lpFarm = useLPFarming();

  // Auto-dismiss confirmation dialogs after 5 seconds
  useEffect(() => {
    if (!confirmWithdraw) return;
    const t = setTimeout(() => setConfirmWithdraw(false), 5000);
    return () => clearTimeout(t);
  }, [confirmWithdraw]);

  useEffect(() => {
    if (!confirmEarlyWithdraw) return;
    const t = setTimeout(() => setConfirmEarlyWithdraw(false), 5000);
    return () => clearTimeout(t);
  }, [confirmEarlyWithdraw]);

  useEffect(() => {
    if (!confirmEmergencyExit) return;
    const t = setTimeout(() => setConfirmEmergencyExit(false), 5000);
    return () => clearTimeout(t);
  }, [confirmEmergencyExit]);

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

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.jungleBus.src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 20%' }} />
      </div>

      <ErrorBoundary>
      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        {/* Wrong network banner (#82 audit) */}
        {isWrongNetwork && (
          <div className="mb-4 px-5 py-4 rounded-xl text-[14px] font-semibold text-yellow-200 flex items-center gap-3" style={{ background: 'rgba(234,179,8,0.18)', border: '2px solid rgba(234,179,8,0.4)' }}>
            <span className="text-[20px]" aria-hidden="true">&#9888;</span>
            Wrong network detected &mdash; please switch to Ethereum Mainnet to use this app.
          </div>
        )}
        <motion.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl text-white tracking-tight mb-1">Farm</h1>
          <p className="text-white text-[14px]">Stake TOWELI and earn rewards &middot; <span className="text-white">FAFO</span></p>
        </motion.div>

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
        <motion.div className="relative overflow-hidden rounded-xl glass-card-animated mb-8" style={{ border: '1px solid rgba(139,92,246,0.75)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="absolute inset-0">
            <img src={ART.bobowelie.src} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10 p-6 py-8 flex flex-col md:flex-row md:items-center justify-between gap-3">
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
        </motion.div>

        {/* ── Native LP Pools ── */}
        <motion.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
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
        </motion.div>

        {/* ── LP Farming ── */}
        <LPFarmingSection lpFarm={lpFarm} isConnected={isConnected} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-12">
          {/* Staking Card */}
          <StakingCard
            isConnected={isConnected}
            pos={pos}
            actions={actions}
            nft={nft}
            stakeAmount={stakeAmount}
            setStakeAmount={setStakeAmount}
            selectedLock={selectedLock}
            setSelectedLock={setSelectedLock}
            boostDisplay={boostDisplay}
            totalBoostBps={totalBoostBps}
            amtNum={amtNum}
            effectiveStake={effectiveStake}
            stakeNeedsApproval={stakeNeedsApproval}
            handleStake={handleStake}
            lastActionRef={lastActionRef}
            confirmWithdraw={confirmWithdraw}
            setConfirmWithdraw={setConfirmWithdraw}
            confirmEarlyWithdraw={confirmEarlyWithdraw}
            setConfirmEarlyWithdraw={setConfirmEarlyWithdraw}
            confirmEmergencyExit={confirmEmergencyExit}
            setConfirmEmergencyExit={setConfirmEmergencyExit}
            showExtendLock={showExtendLock}
            setShowExtendLock={setShowExtendLock}
            extendLockDuration={extendLockDuration}
            setExtendLockDuration={setExtendLockDuration}
          />

          {/* Boost Table */}
          <BoostScheduleTable selectedLockLabel={selectedLock.label} />
        </div>
      </div>
      </ErrorBoundary>
    </div>
  );
}
