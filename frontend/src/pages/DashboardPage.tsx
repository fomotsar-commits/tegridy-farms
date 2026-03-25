import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useAccount, useBalance, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther } from 'viem';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Link } from 'react-router-dom';
import { TOWELI_ADDRESS, GECKOTERMINAL_URL, GECKOTERMINAL_EMBED, REVENUE_DISTRIBUTOR_ADDRESS } from '../lib/constants';
import { ERC20_ABI, REVENUE_DISTRIBUTOR_ABI } from '../lib/contracts';
import { useUserPosition } from '../hooks/useUserPosition';
import { usePoolData } from '../hooks/usePoolData';
import { useToweliPrice } from '../hooks/useToweliPrice';
import { useFarmActions } from '../hooks/useFarmActions';
import { useNFTBoost } from '../hooks/useNFTBoost';
import { useDCA } from '../hooks/useDCA';
import { useLimitOrders } from '../hooks/useLimitOrders';
import { ART } from '../lib/artConfig';
import { formatTokenAmount, formatCurrency } from '../lib/formatting';
import { Skeleton } from '../components/ui/Skeleton';
import { AnimatedCounter } from '../components/AnimatedCounter';
import { Sparkline } from '../components/Sparkline';
import { PulseDot } from '../components/PulseDot';
import { TegridyScoreMini } from '../components/TegridyScoreMini';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { FlashValue } from '../components/FlashValue';

export default function DashboardPage() {
  const { isConnected, address } = useAccount();
  const { data: ethBalance } = useBalance({ address });
  const rawPrice = useToweliPrice();

  // Direct API fallback for price — ensures price always shows
  const [apiPrice, setApiPrice] = useState<number>(() => {
    try {
      const c = localStorage.getItem('tegridy_api_price');
      if (c) { const { price: p, ts } = JSON.parse(c); if (Date.now() - ts < 600_000 && p > 0) return p; }
    } catch {} return 0;
  });
  useEffect(() => {
    fetch(`https://api.geckoterminal.com/api/v2/simple/networks/eth/token_price/${TOWELI_ADDRESS.toLowerCase()}`)
      .then(r => r.json()).then(d => {
        const p = parseFloat(d?.data?.attributes?.token_prices?.[TOWELI_ADDRESS.toLowerCase()] ?? '0');
        if (p > 0) { setApiPrice(p); localStorage.setItem('tegridy_api_price', JSON.stringify({ price: p, ts: Date.now() })); }
      }).catch(() => {});
  }, []);

  // Use whichever price source is available
  const price = {
    ...rawPrice,
    priceInUsd: rawPrice.priceInUsd > 0 ? rawPrice.priceInUsd : apiPrice,
    isLoaded: rawPrice.isLoaded || apiPrice > 0,
  };
  const farmActions = useFarmActions();
  const nft = useNFTBoost();
  const dca = useDCA();
  const limitOrders = useLimitOrders();
  const pos = useUserPosition();
  const pool = usePoolData();
  const priceHistory = usePriceHistory(price.priceInUsd);

  const { data: toweliBalance } = useReadContract({
    address: TOWELI_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: !!address },
  });

  const walletToweli = toweliBalance ? Number(formatEther(toweliBalance)) : 0;
  const pendingTotal = Number(pos.pendingFormatted);
  const stakedTotal = Number(pos.stakedFormatted);

  // Portfolio value in USD
  const ethBal = ethBalance ? Number(formatEther(ethBalance.value)) : 0;
  const portfolioUsd = price.isLoaded ? (
    (walletToweli * price.priceInUsd) +
    (stakedTotal * price.priceInUsd) +
    (pendingTotal * price.priceInUsd) +
    (price.oracleStale ? 0 : ethBal * price.ethUsd)
  ) : 0;

  // Claim handler
  const handleClaim = () => {
    if (pendingTotal < 0.01 || !pos.hasPosition) return;
    farmActions.claim(pos.tokenId);
  };

  // Deferred iframe rendering
  const [showChart, setShowChart] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShowChart(true), 500);
    return () => clearTimeout(t);
  }, []);

  // Price change indicator
  const priceChangeStr = price.priceChange !== 0
    ? `${price.priceChange > 0 ? '+' : ''}${price.priceChange.toFixed(2)}%`
    : '';

  if (!isConnected) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <img src={ART.busCrew.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 5%' }} />
          <div className="absolute inset-0" style={{
            background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.1) 60%, rgba(0,0,0,0.25) 100%)',
          }} />
        </div>
        <div className="relative z-10 min-h-screen flex items-center justify-center px-6">
          <motion.div className="text-center max-w-sm" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}>
            <h2 className="heading-luxury text-2xl text-white mb-2">Connect Wallet</h2>
            <p className="text-white/40 text-[13px] mb-6">View your portfolio, positions, and earnings.</p>
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
                  <button onClick={openConnectModal} className="btn-primary px-7 py-2.5 text-[14px]">
                    Connect Wallet
                  </button>
                </div>
              )}
            </ConnectButton.Custom>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.towelieWindow.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 85%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.35) 30%, rgba(0,0,0,0.55) 60%, rgba(0,0,0,0.8) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-20 pb-12">
        {/* Header with Portfolio Value */}
        <motion.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Dashboard</h1>
              {nft.boostLabel && (
                <span className="badge badge-warning text-[10px]">{nft.boostLabel}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Link to="/leaderboard" className="text-[12px] text-primary/50 hover:text-primary transition-colors">
                Points &#8594;
              </Link>
              <Link to="/history" className="text-[12px] text-white/30 hover:text-primary transition-colors">
                History &#8594;
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-3 mt-2">
            {price.isLoaded ? (
              <AnimatedCounter value={portfolioUsd} prefix="$" decimals={2} className="stat-value text-2xl md:text-3xl text-white" />
            ) : (
              <Skeleton width={120} height={32} />
            )}
            <span className="text-white/30 text-[13px]">Portfolio Value</span>
          </div>
        </motion.div>

        {/* Summary Stats */}
        <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          {[
            { l: 'TOWELI Balance', numVal: walletToweli, decimals: 0, sub: price.isLoaded ? formatCurrency(walletToweli * price.priceInUsd) : '–', art: ART.mumuBull.src },
            { l: 'ETH Balance', numVal: ethBal, decimals: 4, sub: ethBalance && price.ethUsd > 0 ? formatCurrency(ethBal * price.ethUsd) : '–', art: ART.jungleBus.src },
            { l: 'Claimable', numVal: pendingTotal, decimals: 2, sub: price.isLoaded ? formatCurrency(pendingTotal * price.priceInUsd) : '–', accent: true, art: ART.swordOfLove.src },
            { l: 'TOWELI Price', numVal: price.priceInUsd, decimals: price.priceInUsd < 0.01 ? 8 : 6, prefix: '$', sub: priceChangeStr || (price.priceInUsd > 0 ? 'Live' : (price.oracleStale ? 'Stale' : '–')), priceUp: price.priceChange > 0, priceDown: price.priceChange < 0, stale: price.oracleStale, art: ART.bobowelie.src, showSparkline: true, isPrice: true },
          ].map((s) => (
            <div key={s.l} className="relative overflow-hidden rounded-xl glass-card-animated card-hover" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
              <div className="absolute inset-0">
                <img src={s.art} alt="" className="w-full h-full object-cover" />
                <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, rgba(6,12,26,0.40) 0%, rgba(6,12,26,0.75) 50%, rgba(6,12,26,0.92) 100%)' }} />
              </div>
              <div className="relative z-10 p-5 pt-8 pb-6">
              <p className="text-white/50 text-[11px] uppercase tracking-wider mb-2">{s.l}</p>
              <div className={`flex items-center gap-2`}>
                {s.isPrice ? (
                  <FlashValue value={s.numVal}>
                    <AnimatedCounter value={s.numVal} prefix={s.prefix} decimals={s.decimals} className={`stat-value text-2xl ${s.accent ? 'text-primary' : 'text-white'}`} />
                  </FlashValue>
                ) : (
                  <AnimatedCounter value={s.numVal} prefix={s.prefix} decimals={s.decimals} className={`stat-value text-2xl ${s.accent ? 'text-primary' : 'text-white'}`} />
                )}
                {s.showSparkline && priceHistory.length > 1 && (
                  <Sparkline data={priceHistory} width={48} height={18} />
                )}
              </div>
              <p className={`text-[12px] mt-1.5 ${s.stale ? 'text-warning' : s.priceUp ? 'text-success' : s.priceDown ? 'text-danger' : 'text-white/30'}`}>
                {s.priceUp && '▲ '}{s.priceDown && '▼ '}
                {s.stale ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>Stale</span>
                  </span>
                ) : s.sub === 'Live' ? <span className="inline-flex items-center gap-1">Live <PulseDot size={5} /></span> : s.sub}
              </p>
              </div>
            </div>
          ))}
        </motion.div>

        {/* Tegridy Score */}
        <motion.div className="relative overflow-hidden rounded-xl mb-6 p-4" style={{ border: '1px solid rgba(139,92,246,0.12)', background: 'rgba(6,12,26,0.82)', backdropFilter: 'blur(12px)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <div className="flex items-center justify-between">
            <TegridyScoreMini />
            <Link to="/leaderboard" className="text-[11px] text-primary/50 hover:text-primary transition-colors">
              View Breakdown &#8594;
            </Link>
          </div>
        </motion.div>

        {/* Claim Button */}
        {pendingTotal >= 0.01 && pos.hasPosition && (
          <motion.div className="mb-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <button onClick={handleClaim}
              disabled={farmActions.isPending || farmActions.isConfirming}
              className="btn-primary px-6 py-2.5 text-[13px] disabled:opacity-35 disabled:cursor-not-allowed">
              {farmActions.isPending || farmActions.isConfirming
                ? 'Claiming...'
                : `Claim Rewards (${formatTokenAmount(pendingTotal.toString(), 2)} TOWELI)`}
            </button>
          </motion.div>
        )}

        {/* ETH Revenue Sharing */}
        {address && <ETHRevenueClaim address={address} />}

        {/* DCA Due Alerts */}
        {dca.dueSchedules.length > 0 && (
          <motion.div className="relative overflow-hidden rounded-xl mb-5" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="absolute inset-0">
              <img src={ART.porchChill.src} alt="" className="w-full h-full object-cover" />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
            </div>
            <div className="relative z-10 p-4 flex items-center justify-between">
              <div>
                <p className="text-warning text-[13px] font-medium">{dca.dueSchedules.length} DCA swap{dca.dueSchedules.length > 1 ? 's' : ''} due</p>
                <p className="text-white/30 text-[11px]">Go to Swap to execute</p>
              </div>
              <Link to="/swap" className="btn-secondary px-4 py-2 text-[12px]">Execute &#8594;</Link>
            </div>
          </motion.div>
        )}

        {/* Active Limit Orders */}
        {limitOrders.activeOrders.length > 0 && (
          <motion.div className="relative overflow-hidden rounded-xl mb-5" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="absolute inset-0">
              <img src={ART.roseApe.src} alt="" className="w-full h-full object-cover" />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
            </div>
            <div className="relative z-10 p-4">
              <p className="text-white/60 text-[13px] font-medium mb-1">{limitOrders.activeOrders.length} active price alert{limitOrders.activeOrders.length > 1 ? 's' : ''}</p>
              <p className="text-white/25 text-[11px]">Check Swap for details</p>
            </div>
          </motion.div>
        )}

        {/* Position */}
        <h2 className="heading-luxury text-[16px] text-white mb-4">Your Position</h2>
        {pos.hasPosition ? (
          <motion.div className="relative overflow-hidden rounded-xl mb-10 card-hover" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <div className="absolute inset-0">
              <img src={ART.forestScene.src} alt="" className="w-full h-full object-cover" />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
            </div>
            <div className="relative z-10 p-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-white/30 text-[10px] mb-0.5">Staked</p>
                  <AnimatedCounter value={stakedTotal} decimals={2} className="stat-value text-[16px] text-white" />
                </div>
                <div>
                  <p className="text-white/30 text-[10px] mb-0.5">Boost</p>
                  <AnimatedCounter value={pos.boostMultiplier} decimals={2} suffix="x" className="stat-value text-[16px] text-primary" />
                </div>
                <div>
                  <p className="text-white/30 text-[10px] mb-0.5">Lock Expires</p>
                  <p className="stat-value text-[14px] text-white">
                    {pos.autoMaxLock ? 'Auto-Max (Forever)' : pos.isLocked ? new Date(pos.lockEnd * 1000).toLocaleDateString() : 'Unlocked'}
                  </p>
                </div>
                <div>
                  <p className="text-white/30 text-[10px] mb-0.5">Voting Power</p>
                  <AnimatedCounter value={stakedTotal * pos.boostMultiplier} decimals={0} className="stat-value text-[14px] text-white" />
                </div>
              </div>
              <div className="flex items-center gap-2 mt-4">
                {pos.isLocked && (
                  <span className="badge badge-warning text-[10px]">
                    {pos.autoMaxLock ? 'Auto-Max Lock' : `Locked until ${new Date(pos.lockEnd * 1000).toLocaleDateString()}`}
                  </span>
                )}
                {nft.boostLabel && (
                  <span className="badge badge-primary text-[10px]">{nft.boostLabel}</span>
                )}
                <Link to="/restake" className="text-[11px] text-primary/50 hover:text-primary transition-colors ml-auto">
                  Restake for bonus yield &#8594;
                </Link>
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.div className="relative overflow-hidden rounded-xl mb-10" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="absolute inset-0">
              <img src={ART.jbChristmas.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 20%' }} />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
            </div>
            <div className="relative z-10 p-8 py-12 text-center">
              <p className="text-white/50 text-[15px] mb-4">No staking position yet</p>
              <Link to="/farm" className="btn-primary px-8 py-3 text-[14px]">Start Staking &#8594;</Link>
            </div>
          </motion.div>
        )}

        {/* Projections */}
        {pos.hasPosition && (
          <motion.div className="mb-10" initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h3 className="heading-luxury text-[16px] text-white mb-4">Earnings Projection</h3>
            <Projections staked={stakedTotal} apr={parseFloat(pool.apr)} price={price.priceInUsd} boost={pos.boostMultiplier} />
          </motion.div>
        )}

        {/* Chart */}
        <motion.div initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="heading-luxury text-[16px] text-white">Price Chart</h3>
            <a href={GECKOTERMINAL_URL} target="_blank" rel="noopener noreferrer"
              className="text-primary text-[12px] font-medium hover:opacity-80 transition-opacity">
              GeckoTerminal &#8594;
            </a>
          </div>
          <div className="relative rounded-xl overflow-hidden aspect-square max-h-[500px]" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
            {showChart ? (
              <iframe
                src={GECKOTERMINAL_EMBED}
                className="w-full h-full border-0"
                title="GeckoTerminal Chart"
                allow="clipboard-write"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <span className="text-white/20 text-[13px]">Loading chart...</span>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function ETHRevenueClaim({ address }: { address: string }) {
  const { data: pendingETH } = useReadContract({
    address: REVENUE_DISTRIBUTOR_ADDRESS,
    abi: REVENUE_DISTRIBUTOR_ABI,
    functionName: 'pendingETH',
    args: [address as `0x${string}`],
    query: { enabled: !!address },
  });

  const { data: isRegistered } = useReadContract({
    address: REVENUE_DISTRIBUTOR_ADDRESS,
    abi: REVENUE_DISTRIBUTOR_ABI,
    functionName: 'hasRegistered',
    args: [address as `0x${string}`],
    query: { enabled: !!address },
  });

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash });

  const pending = pendingETH ? Number(formatEther(pendingETH as bigint)) : 0;
  const registered = isRegistered as boolean;

  if (!registered && pending === 0) {
    return (
      <motion.div className="relative overflow-hidden rounded-xl mb-5" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <div className="absolute inset-0">
          <img src={ART.smokingDuo.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 55%' }} />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
        </div>
        <div className="relative z-10 p-8 py-10 flex items-center justify-between">
          <div>
            <p className="text-white text-[20px] font-medium mb-2">ETH Revenue Sharing</p>
            <p className="text-white/40 text-[14px]">Register to earn ETH from protocol fees</p>
          </div>
          <button onClick={() => writeContract({ address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'register' })}
            disabled={isPending || isConfirming}
            className="btn-primary px-6 py-3 text-[14px] disabled:opacity-35">
            {isPending || isConfirming ? 'Registering...' : 'Register'}
          </button>
        </div>
      </motion.div>
    );
  }

  if (pending > 0) {
    return (
      <motion.div className="relative overflow-hidden rounded-xl mb-5" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <div className="absolute inset-0">
          <img src={ART.smokingDuo.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 55%' }} />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
        </div>
        <div className="relative z-10 p-4 flex items-center justify-between">
          <div>
            <p className="text-white text-[13px] font-medium">ETH Revenue</p>
            <span className="stat-value text-[16px] text-success"><AnimatedCounter value={pending} decimals={6} suffix=" ETH" /></span>
          </div>
          <button onClick={() => writeContract({ address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'claim' })}
            disabled={isPending || isConfirming}
            className="btn-primary px-5 py-2.5 text-[13px] disabled:opacity-35">
            {isPending || isConfirming ? 'Claiming...' : 'Claim ETH'}
          </button>
        </div>
      </motion.div>
    );
  }

  return null;
}

function Projections({ staked, apr, price }: {
  staked: number; apr: number; price: number; boost?: number;
}) {
  const daily = (staked * apr / 100) / 365;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {[{ l: '7 Days', m: 7 }, { l: '30 Days', m: 30 }, { l: '90 Days', m: 90 }, { l: '1 Year', m: 365 }].map(({ l, m }) => (
        <div key={l} className="glass-card rounded-lg p-3 text-center card-hover">
          <p className="text-white/40 text-[10px] mb-1">{l}</p>
          <AnimatedCounter value={daily * m} decimals={0} className="stat-value text-[14px] text-primary" />
          <p className="text-white/25 text-[9px]">~{formatCurrency(daily * m * price)}</p>
        </div>
      ))}
    </div>
  );
}
