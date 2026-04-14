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

/** Early withdrawal penalty percentage — should match the contract's EARLY_EXIT_PENALTY_BPS / 100 */
const EARLY_WITHDRAWAL_PENALTY_PCT = 25;

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
        <img src={ART.poolParty.src} alt="" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" style={{ objectPosition: 'center 30%' }} />
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
        <img src={pool.art} alt="" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" style={{ objectPosition: pool.artPos }} />
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
  const [lpStakeAmount, setLpStakeAmount] = useState('');
  const [lpWithdrawAmount, setLpWithdrawAmount] = useState('');

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

  // Clear LP inputs only after transaction confirms
  useEffect(() => {
    if (lpFarm.isSuccess) {
      setLpStakeAmount('');
      setLpWithdrawAmount('');
    }
  }, [lpFarm.isSuccess]);

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.jungleBus.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 20%' }} />
      </div>

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
        <motion.div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          {[
            { l: 'Total Value Locked', v: stats.tvl, art: ART.apeHug.src, pos: 'center 30%' },
            { l: 'TOWELI Price', v: stats.toweliPrice + (price.displayPriceStale ? ' (stale)' : ''), art: ART.roseApe.src, pos: 'center 30%' },
            { l: 'Base APR', v: pool.isDeployed ? `${pool.apr}%` : '–', accent: true, art: ART.wrestler.src, pos: 'center 0%', sub: pool.aprDisclaimer },
            { l: 'Season', v: `${daysLeft}d left`, sub: CURRENT_SEASON.name, art: ART.beachSunset.src, pos: 'center 30%' },
          ].map((s) => (
            <div key={s.l} className="relative overflow-hidden rounded-xl glass-card-animated card-hover" style={{ border: '1px solid rgba(139,92,246,0.75)' }}>
              <div className="absolute inset-0">
                <img src={s.art} alt="" className="w-full h-full object-cover" style={{ objectPosition: s.pos }} />
              </div>
              <div className="relative z-10 p-5 pt-8 pb-6">
              <p className="text-white text-[11px] uppercase tracking-wider label-pill mb-2 flex items-center gap-1.5">{s.l}{s.l === 'TOWELI Price' && <PulseDot size={5} />}</p>
              <div className="flex items-center gap-2">
                <p className={`stat-value text-2xl text-white`}>{s.v}</p>
                {s.l === 'TOWELI Price' && priceData.length > 1 && (
                  <Sparkline data={priceData} width={48} height={18} />
                )}
                {s.l === 'TOWELI Price' && priceError && priceData.length === 0 && (
                  <span className="text-white text-[10px]">Price data unavailable</span>
                )}
              </div>
              {s.sub && <p className="text-white text-[11px] mt-1">{s.sub}</p>}
              </div>
            </div>
          ))}
        </motion.div>

        {/* Season banner */}
        <motion.div className="relative overflow-hidden rounded-xl glass-card-animated mb-8" style={{ border: '1px solid rgba(139,92,246,0.75)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div className="absolute inset-0">
            <img src={ART.bobowelie.src} alt="" className="w-full h-full object-cover" />
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
        {lpFarm.isDeployed && lpFarm.isReadLoading && (
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
        )}
        {lpFarm.isDeployed && !lpFarm.isReadLoading && (
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
                <img src={ART.smokingDuo.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 30%' }} />
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
                            className="flex-1 bg-black/60 border border-white/25 rounded-lg px-3 py-2 min-h-[44px] text-white text-sm font-mono"
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
                            className="flex-1 bg-black/60 border border-white/25 rounded-lg px-3 py-2 min-h-[44px] text-white text-sm font-mono"
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
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-12">
          {/* Staking Card */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
            <div className="relative overflow-hidden rounded-xl glass-card-animated card-hover" style={{ border: '1px solid rgba(139,92,246,0.75)' }}>
              <div className="absolute inset-0">
                <img src={ART.beachVibes.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 40%' }} />
              </div>
              <div className="relative z-10 p-6">
              <h3 className="heading-luxury text-white text-[20px] mb-5">
                {pos.hasPosition ? 'Your Position' : 'Stake TOWELI'}
              </h3>

              {pos.hasPosition ? (
                /* Existing position display */
                <div>
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                      <p className="text-white text-[10px] mb-0.5">Staked</p>
                      <AnimatedCounter value={parseFloat(pos.stakedFormatted) || 0} decimals={2} className="stat-value text-[16px] text-white" />
                    </div>
                    <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
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
                    <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                      <p className="text-white text-[10px] mb-0.5">Claimable</p>
                      <AnimatedCounter value={parseFloat(pos.pendingFormatted) || 0} decimals={4} className="stat-value text-[16px] text-white" />
                    </div>
                    <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                      <p className="text-white text-[10px] mb-0.5">Lock Expires</p>
                      <p className="stat-value text-[14px] text-white">
                        {pos.autoMaxLock ? 'Auto-Max' : pos.isLocked ? new Date(pos.lockEnd * 1000).toLocaleDateString() : 'Unlocked'}
                      </p>
                      {pos.hasPosition && pos.isLocked && !showExtendLock && (
                        <button
                          onClick={() => setShowExtendLock(true)}
                          disabled={actions.isPending || actions.isConfirming}
                          className="btn-secondary text-[11px] mt-1.5 w-full py-1.5 rounded-lg disabled:opacity-70 disabled:cursor-not-allowed">
                          Extend Lock
                        </button>
                      )}
                      {pos.hasPosition && pos.isLocked && showExtendLock && (
                        <div className="mt-2">
                          <div className="grid grid-cols-2 gap-1.5 mb-2">
                            {LOCK_OPTIONS.map((opt) => (
                              <button key={opt.label} onClick={() => setExtendLockDuration(opt)}
                                className="rounded-lg px-2 py-1.5 text-center cursor-pointer transition-all text-[10px]"
                                style={{
                                  background: extendLockDuration.label === opt.label ? 'rgba(139,92,246,0.75)' : 'rgba(0,0,0,0.55)',
                                  border: extendLockDuration.label === opt.label ? '1px solid rgba(139,92,246,0.3)' : '1px solid rgba(255,255,255,0.25)',
                                  color: extendLockDuration.label === opt.label ? '#000000' : 'rgba(255,255,255,1)',
                                }}>
                                {opt.label}
                              </button>
                            ))}
                          </div>
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => setShowExtendLock(false)}
                              className="flex-1 py-1.5 rounded-lg text-[10px] text-white cursor-pointer"
                              style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.20)' }}>
                              Cancel
                            </button>
                            <button
                              onClick={() => { actions.extendLock(pos.tokenId, BigInt(extendLockDuration.seconds)); setShowExtendLock(false); }}
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
                      <div className="rounded-lg p-3 mt-2" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
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
                      {pos.canWithdraw && !confirmWithdraw && (
                        <button onClick={() => setConfirmWithdraw(true)}
                          disabled={actions.isPending || actions.isConfirming}
                          className="btn-secondary w-full py-2.5 text-[13px] disabled:opacity-70">
                          Withdraw
                        </button>
                      )}
                      {pos.canWithdraw && confirmWithdraw && (
                        <div className="col-span-2 rounded-lg p-3" style={{ background: 'rgba(255,178,55,0.06)', border: '1px solid rgba(255,178,55,0.15)' }}>
                          <p className="text-warning/80 text-[11px] mb-2">Withdraw <span className="font-mono font-semibold">{pos.stakedFormatted} TOWELI</span>? This will unstake your full position.</p>
                          <div className="flex gap-2">
                            <button onClick={() => setConfirmWithdraw(false)}
                              className="flex-1 py-2 rounded-lg text-[12px] text-white cursor-pointer"
                              style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.20)' }}>
                              Cancel
                            </button>
                            <button onClick={() => { setConfirmWithdraw(false); lastActionRef.current = 'unstake'; actions.withdraw(pos.tokenId); }}
                              disabled={actions.isPending || actions.isConfirming}
                              className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-warning cursor-pointer disabled:opacity-70"
                              style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.25)' }}>
                              Confirm Withdraw
                            </button>
                          </div>
                        </div>
                      )}
                      {pos.isLocked && !confirmEarlyWithdraw && (
                        <button onClick={() => setConfirmEarlyWithdraw(true)}
                          disabled={actions.isPending || actions.isConfirming}
                          className="w-full py-2.5 text-[13px] rounded-lg disabled:opacity-70"
                          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: 'rgba(239,68,68,0.8)' }}>
                          Early Withdraw ({EARLY_WITHDRAWAL_PENALTY_PCT}% penalty)
                        </button>
                      )}
                      {pos.isLocked && confirmEarlyWithdraw && (
                        <div className="col-span-2 rounded-lg p-3" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
                          <p className="text-danger text-[11px] font-semibold mb-1">Warning: Early withdrawal incurs a penalty. You will lose {EARLY_WITHDRAWAL_PENALTY_PCT}% of your <span className="font-mono">{pos.stakedFormatted} TOWELI</span>. This cannot be undone.</p>
                          <div className="flex gap-2 mt-2">
                            <button onClick={() => setConfirmEarlyWithdraw(false)}
                              className="flex-1 py-2 rounded-lg text-[12px] text-white cursor-pointer"
                              style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.20)' }}>
                              Cancel
                            </button>
                            <button onClick={() => { setConfirmEarlyWithdraw(false); lastActionRef.current = 'unstake'; actions.earlyWithdraw(pos.tokenId); }}
                              disabled={actions.isPending || actions.isConfirming}
                              className="flex-1 py-2 rounded-lg text-[12px] font-semibold text-danger cursor-pointer disabled:opacity-70"
                              style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)' }}>
                              Confirm Early Withdrawal
                            </button>
                          </div>
                        </div>
                      )}
                      <button onClick={() => actions.toggleAutoMaxLock(pos.tokenId)}
                        disabled={actions.isPending || actions.isConfirming}
                        className="btn-secondary w-full py-2.5 text-[13px] disabled:opacity-70">
                        {pos.autoMaxLock ? 'Disable Auto-Lock' : 'Enable Auto-Max Lock'}
                      </button>
                      {pos.isPaused && pos.hasPosition && !confirmEmergencyExit && (
                        <button
                          onClick={() => setConfirmEmergencyExit(true)}
                          disabled={actions.isPending || actions.isConfirming}
                          className="col-span-2 w-full py-2.5 text-[13px] rounded-lg font-semibold disabled:opacity-70 disabled:cursor-not-allowed"
                          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171' }}>
                          Emergency Exit (Forfeit Rewards)
                        </button>
                      )}
                      {pos.isPaused && pos.hasPosition && confirmEmergencyExit && (
                        <div className="col-span-2 rounded-lg p-3" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}>
                          <p className="text-danger text-[11px] font-semibold mb-1">Emergency exit forfeits all pending rewards. This cannot be undone.</p>
                          <div className="flex gap-2 mt-2">
                            <button onClick={() => setConfirmEmergencyExit(false)}
                              className="flex-1 py-2 rounded-lg text-[12px] text-white cursor-pointer"
                              style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.20)' }}>
                              Cancel
                            </button>
                            <button onClick={() => { setConfirmEmergencyExit(false); actions.emergencyExit(pos.tokenId); }}
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
                      style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }} />
                  </div>

                  <div className="mb-4">
                    <label className="text-white text-[11px] uppercase tracking-wider label-pill mb-2 block">Lock Duration</label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                      {LOCK_OPTIONS.map((opt) => (
                        <button key={opt.label} onClick={() => setSelectedLock(opt)}
                          className="rounded-lg p-2.5 min-h-[44px] text-center cursor-pointer transition-all text-[12px]"
                          style={{
                            background: selectedLock.label === opt.label ? 'rgba(139,92,246,0.75)' : 'rgba(0,0,0,0.55)',
                            border: selectedLock.label === opt.label ? '1px solid rgba(139,92,246,0.3)' : '1px solid rgba(255,255,255,0.25)',
                            color: selectedLock.label === opt.label ? '#000000' : 'rgba(255,255,255,1)',
                          }}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Boost preview */}
                  <div className="rounded-lg p-4 mb-4" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
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

                  <button onClick={handleStake}
                    disabled={actions.isPending || actions.isConfirming || amtNum <= 0}
                    className="btn-primary w-full py-3.5 text-[14px] disabled:opacity-70 disabled:cursor-not-allowed">
                    {actions.isPending || actions.isConfirming
                      ? 'Processing...'
                      : stakeNeedsApproval ? 'Approve TOWELI' : amtNum <= 0 ? 'Enter Amount' : `Stake & Lock for ${selectedLock.label}`}
                  </button>

                  <p className="text-white text-[10px] text-center mt-3">
                    Early withdrawal available with {EARLY_WITHDRAWAL_PENALTY_PCT}% penalty (redistributed to stakers)
                  </p>
                </div>
              )}
              </div>
            </div>
          </motion.div>

          {/* Boost Table */}
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <div className="relative overflow-hidden rounded-xl glass-card-animated" style={{ border: '1px solid rgba(139,92,246,0.75)' }}>
              <div className="absolute inset-0">
                <img src={ART.swordOfLove.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 30%' }} />
              </div>
              <div className="relative z-10 p-6">
              <h3 className="heading-luxury text-white text-[20px] mb-5">Boost Schedule</h3>
              <p className="text-white text-[12px] mb-4">Lock longer = higher boost + more voting power. JBAC NFT holders get +0.5x bonus.</p>

              <div className="space-y-1.5">
                {LOCK_OPTIONS.map((opt) => {
                  const b = calculateBoost(opt.seconds);
                  const withNft = b + JBAC_BONUS_BPS;
                  return (
                    <div key={opt.label} className="flex items-center justify-between rounded-lg px-4 py-2.5"
                      style={{
                        background: selectedLock.label === opt.label ? 'rgba(139,92,246,0.75)' : 'rgba(0,0,0,0.50)',
                        border: selectedLock.label === opt.label ? '1px solid rgba(139,92,246,0.2)' : '1px solid transparent',
                      }}>
                      <span className="text-white text-[13px]">{opt.label}</span>
                      <div className="flex items-center gap-3">
                        <span className="stat-value text-[14px] text-white">{(b / 10000).toFixed(2)}x</span>
                        <span className="text-white text-[11px]">({(withNft / 10000).toFixed(2)}x w/NFT)</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-6 relative overflow-hidden rounded-lg" style={{ border: '1px solid rgba(255,178,55,0.12)' }}>
                <div className="absolute inset-0">
                  <img src={ART.chaosScene.src} alt="" className="w-full h-full object-cover" />
                </div>
                <div className="relative z-10 p-4">
                  <p className="text-warning/80 text-[12px] font-medium mb-1">Early Withdrawal</p>
                  <p className="text-white text-[11px]">
                    You can exit your lock at any time with a {EARLY_WITHDRAWAL_PENALTY_PCT}% penalty. Penalty tokens are redistributed to remaining stakers — so diamond hands get rewarded.
                  </p>
                </div>
              </div>

              <div className="mt-4 relative overflow-hidden rounded-lg" style={{ border: '1px solid rgba(139,92,246,0.75)' }}>
                <div className="absolute inset-0">
                  <img src={ART.forestScene.src} alt="" className="w-full h-full object-cover" />
                </div>
                <div className="relative z-10 p-4">
                  <p className="text-white text-[12px] font-medium mb-1">Auto-Max Lock</p>
                  <p className="text-white text-[11px]">
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
