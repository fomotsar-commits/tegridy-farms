import { useState, useMemo, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import {
  useAccount,
  useWriteContract,
  useReadContract,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { parseEther, formatEther, decodeEventLog } from 'viem';
import type { Address } from 'viem';
import { toast } from 'sonner';
import {
  TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
  isDeployed,
} from '../../lib/constants';
import {
  TEGRIDY_NFT_POOL_FACTORY_ABI,
  TEGRIDY_NFT_POOL_ABI,
} from '../../lib/contracts';
import { formatTokenAmount, shortenAddress } from '../../lib/formatting';
import { ART } from '../../lib/artConfig';
import { InfoTooltip, HowItWorks, RiskBanner } from '../ui/InfoTooltip';
import { isValidAddress as _isValidAddress } from '../../lib/tokenList';

// ─── Constants ────────────────────────────────────────────────────

const POOL_TYPE_LABELS = ['BUY', 'SELL', 'TRADE'] as const;
type PoolType = 0 | 1 | 2;

const POOL_TYPE_COLORS: Record<number, string> = {
  0: 'text-blue-400 border-blue-400/30 bg-blue-400/10',
  1: 'text-orange-400 border-orange-400/30 bg-orange-400/10',
  2: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10',
};

const POOL_TYPE_BG_SELECTED: Record<number, string> = {
  0: 'bg-blue-500/20 border-blue-400 ring-1 ring-blue-400/30',
  1: 'bg-orange-500/20 border-orange-400 ring-1 ring-orange-400/30',
  2: 'bg-emerald-500/40 border-emerald-400 ring-1 ring-emerald-400/30',
};

const POOL_TYPE_DESCRIPTIONS: Record<number, string> = {
  0: 'Buy NFTs from the pool using ETH. Price increases with each purchase.',
  1: 'Sell NFTs into the pool for ETH. Price decreases with each sale.',
  2: 'Two-sided liquidity. Earn fees on every buy and sell.',
};

const POOL_TYPE_ICONS: Record<number, string> = {
  0: 'M3 3l8 4.5V15l-8 4.5V3z M21 3l-8 4.5V15l8 4.5V3z',
  1: 'M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
  2: 'M8 3H5a2 2 0 00-2 2v3 M21 8V5a2 2 0 00-2-2h-3 M3 16v3a2 2 0 002 2h3 M16 21h3a2 2 0 002-2v-3',
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

// ─── Tracked pools (shared across tabs in this section) ─────────────
// Module-level helper so CreatePoolTab can auto-add a freshly-deployed pool
// and MyPoolsTab picks it up without a refresh. Sync is via a custom event
// because the `storage` event only fires cross-tab, not same-tab.
const POOL_LIST_EVENT = 'tegridy-amm-tracked-pools-updated';

function addTrackedPool(addr: string) {
  if (!_isValidAddress(addr)) return;
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    const prev: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    const lower = addr.toLowerCase();
    if (prev.some((p) => p.toLowerCase() === lower)) return;
    const next = [...prev, addr];
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(POOL_LIST_EVENT));
  } catch {
    /* ignore — localStorage can throw in private mode */
  }
}

const ERC721_APPROVAL_ABI = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    name: 'isApprovedForAll',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    name: 'setApprovalForAll',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

type Tab = 'trade' | 'create' | 'pools';

const LOCAL_STORAGE_KEY = 'tegridy-amm-tracked-pools';

const isValidAddress = (addr: string): addr is `0x${string}` =>
  _isValidAddress(addr);

const labelClass = 'text-[11px] uppercase tracking-wider label-pill text-white font-medium';
const inputClass =
  'w-full bg-black/60 border border-white/25 rounded-xl px-4 py-3 text-white outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/20 transition-all duration-200 font-mono text-sm placeholder:text-white';
const btnPrimary =
  'w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 transition-all duration-300 text-white font-semibold text-sm disabled:opacity-70 disabled:cursor-not-allowed shadow-lg shadow-emerald-500/10';
const btnDisabled =
  'w-full py-3.5 rounded-xl bg-black/60 border border-white/25 text-white text-sm font-semibold cursor-not-allowed';

// ─── Art Card Wrapper ────────────────────────────────────────────

function ArtCard({
  art,
  opacity = 1,
  overlay = 'none',
  border = 'var(--color-purple-75)',
  className = '',
  children,
}: {
  art: { src: string };
  opacity?: number;
  overlay?: string;
  border?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl glass-card-animated ${className}`}
      style={{ border: `1px solid ${border}` }}
    >
      <div className="absolute inset-0">
        <img src={art.src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ opacity }} />
        <div className="absolute inset-0" style={{ background: overlay }} />
      </div>
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
}

// ─── Bonding Curve Chart ──────────────────────────────────────────

function BondingCurveChart({
  spotPrice,
  delta,
  numSteps = 10,
  height = 200,
  currentPriceMarker,
}: {
  spotPrice: number;
  delta: number;
  numSteps?: number;
  height?: number;
  currentPriceMarker?: number;
}) {
  const padding = { top: 20, right: 16, bottom: 32, left: 56 };

  const { buyPrices, sellPrices, maxPrice, minPrice } = useMemo(() => {
    const buy: number[] = [];
    const sell: number[] = [];
    for (let i = 0; i <= numSteps; i++) {
      buy.push(spotPrice + delta * i);
      sell.push(Math.max(0, spotPrice - delta * i));
    }
    const allPrices = [...buy, ...sell].filter((p) => p >= 0);
    const max = Math.max(...allPrices, spotPrice + delta);
    const min = Math.min(...allPrices, 0);
    return { buyPrices: buy, sellPrices: sell, maxPrice: max, minPrice: min };
  }, [spotPrice, delta, numSteps]);

  const chartWidth = 480;
  const innerW = chartWidth - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const scaleX = (i: number) => padding.left + (i / numSteps) * innerW;
  const range = maxPrice - minPrice || 1;
  const scaleY = (price: number) =>
    padding.top + innerH - ((price - minPrice) / range) * innerH;

  const buildStepPath = (prices: number[]) => {
    let d = '';
    for (let i = 0; i < prices.length; i++) {
      const x = scaleX(i);
      const y = scaleY(prices[i]!);
      if (i === 0) {
        d += `M${x},${y}`;
      } else {
        d += ` L${x},${scaleY(prices[i - 1]!)} L${x},${y}`;
      }
    }
    return d;
  };

  const buildAreaPath = (prices: number[]) => {
    const linePath = buildStepPath(prices);
    const lastX = scaleX(prices.length - 1);
    const firstX = scaleX(0);
    const baseY = scaleY(minPrice);
    return `${linePath} L${lastX},${baseY} L${firstX},${baseY} Z`;
  };

  const tickCount = 5;
  const ticks = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i <= tickCount; i++) {
      arr.push(minPrice + (range / tickCount) * i);
    }
    return arr;
  }, [minPrice, range, tickCount]);

  const gridLines = useMemo(() => {
    return ticks.map((t) => scaleY(t));
  }, [ticks]);

  const markerPrice = currentPriceMarker ?? spotPrice;

  return (
    <div className="w-full overflow-hidden">
      <svg
        viewBox={`0 0 ${chartWidth} ${height}`}
        className="w-full"
        style={{ height: `${height}px`, maxHeight: `${height}px` }}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id="buyGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(16,185,129)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="rgb(16,185,129)" stopOpacity="0.01" />
          </linearGradient>
          <linearGradient id="sellGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(251,146,60)" stopOpacity="0.15" />
            <stop offset="100%" stopColor="rgb(251,146,60)" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Grid */}
        {gridLines.map((y, i) => (
          <g key={i}>
            <line
              x1={padding.left}
              y1={y}
              x2={chartWidth - padding.right}
              y2={y}
              stroke="rgba(255,255,255,0.04)"
              strokeDasharray="4 4"
            />
            <text
              x={padding.left - 8}
              y={y + 3}
              textAnchor="end"
              fill="rgba(255,255,255,0.3)"
              fontSize="9"
              fontFamily="monospace"
            >
              {ticks[i]! < 0.001 ? ticks[i]!.toExponential(1) : ticks[i]!.toFixed(3)}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {Array.from({ length: numSteps + 1 }, (_, i) => i)
          .filter((i) => i % 2 === 0)
          .map((i) => (
            <text
              key={i}
              x={scaleX(i)}
              y={height - 8}
              textAnchor="middle"
              fill="rgba(255,255,255,0.25)"
              fontSize="9"
              fontFamily="monospace"
            >
              {i === 0 ? 'Now' : `+${i}`}
            </text>
          ))}

        {/* Sell curve area + line */}
        <path d={buildAreaPath(sellPrices)} fill="url(#sellGradient)" />
        <path
          d={buildStepPath(sellPrices)}
          fill="none"
          stroke="rgb(251,146,60)"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.7"
        />

        {/* Buy curve area + line */}
        <path d={buildAreaPath(buyPrices)} fill="url(#buyGradient)" />
        <path
          d={buildStepPath(buyPrices)}
          fill="none"
          stroke="rgb(16,185,129)"
          strokeWidth="2"
          strokeLinecap="round"
        />

        {/* Current price marker */}
        <circle
          cx={scaleX(0)}
          cy={scaleY(markerPrice)}
          r="5"
          fill="rgb(16,185,129)"
          stroke="rgba(6,12,26,0.8)"
          strokeWidth="2"
        />
        <circle
          cx={scaleX(0)}
          cy={scaleY(markerPrice)}
          r="8"
          fill="none"
          stroke="rgb(16,185,129)"
          strokeWidth="1"
          opacity="0.3"
        >
          <animate attributeName="r" values="8;12;8" dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.3;0.1;0.3" dur="2s" repeatCount="indefinite" />
        </circle>

        {/* Current price label */}
        <rect
          x={scaleX(0) - 32}
          y={scaleY(markerPrice) - 22}
          width="64"
          height="16"
          rx="4"
          fill="rgb(16,185,129)"
          opacity="0.15"
        />
        <text
          x={scaleX(0)}
          y={scaleY(markerPrice) - 11}
          textAnchor="middle"
          fill="rgb(16,185,129)"
          fontSize="9"
          fontWeight="600"
          fontFamily="monospace"
        >
          {markerPrice.toFixed(4)} ETH
        </text>

        {/* Legend */}
        <g transform={`translate(${chartWidth - padding.right - 100}, ${padding.top})`}>
          <line x1="0" y1="0" x2="14" y2="0" stroke="rgb(16,185,129)" strokeWidth="2" />
          <text x="18" y="3" fill="rgba(255,255,255,1)" fontSize="9">
            Buy Price
          </text>
          <line x1="0" y1="14" x2="14" y2="14" stroke="rgb(251,146,60)" strokeWidth="1.5" opacity="0.7" />
          <text x="18" y="17" fill="rgba(255,255,255,1)" fontSize="9">
            Sell Price
          </text>
        </g>

        {/* Axis lines */}
        <line
          x1={padding.left} y1={padding.top}
          x2={padding.left} y2={height - padding.bottom}
          stroke="rgba(255,255,255,0.08)"
        />
        <line
          x1={padding.left} y1={height - padding.bottom}
          x2={chartWidth - padding.right} y2={height - padding.bottom}
          stroke="rgba(255,255,255,0.08)"
        />
      </svg>
    </div>
  );
}

// ─── Price Impact Badge ──────────────────────────────────────────

function PriceImpactBadge({ impact }: { impact: number | null }) {
  if (impact === null) return null;
  const abs = Math.abs(impact);
  let color = 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20';
  let icon = null;
  if (abs > 15) {
    color = 'text-red-400 bg-red-400/10 border-red-400/20';
    icon = (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
    );
  } else if (abs > 5) {
    color = 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20';
    icon = (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border ${color}`}>
      {icon}
      {impact > 0 ? '+' : ''}{impact.toFixed(1)}%
    </span>
  );
}

// ─── Stats Bar ────────────────────────────────────────────────────

function AMMStatsBar({ poolCount }: { poolCount: bigint | undefined }) {
  const stats = [
    { label: 'Total Pools', value: poolCount?.toString() ?? '0', tooltip: 'Number of bonding curve pools deployed for NFT trading' },
    { label: 'Total Volume', value: '\u2014', tooltip: 'Cumulative ETH volume traded through all pools' },
    { label: 'Protocol Fee', value: '0.5%', tooltip: 'Fee taken by the protocol on each trade, separate from LP fees' },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-8">
      {stats.map((s, i) => (
        <m.div
          key={s.label}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.08 }}
        >
          <ArtCard art={ART.boxingRing} opacity={1} overlay="none">
            <div className="p-4 text-center">
              <p className={`${labelClass} inline-flex items-center gap-1`}>
                {s.label}
                <InfoTooltip text={s.tooltip} />
              </p>
              <p className="text-xl sm:text-2xl font-mono tabular-nums text-white mt-1 font-semibold">
                {s.value}
              </p>
            </div>
          </ArtCard>
        </m.div>
      ))}
    </div>
  );
}

// ─── Tab Navigation ───────────────────────────────────────────────

function TabNav({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'trade', label: 'Trade' },
    { id: 'create', label: 'Create Pool' },
    { id: 'pools', label: 'My Pools' },
  ];

  return (
    <div className="relative flex gap-1 mb-8 border-b border-white/20">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`relative px-5 py-3 text-sm font-medium transition-colors duration-200 ${
            active === t.id ? 'text-white' : 'text-white/60 hover:text-white/80'
          }`}
        >
          {t.label}
          {active === t.id && (
            <m.div
              layoutId="amm-tab-underline"
              className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-emerald-400 to-emerald-500"
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            />
          )}
        </button>
      ))}
    </div>
  );
}

// ─── Pool Type Badge ──────────────────────────────────────────────

function PoolTypeBadge({ type }: { type: number }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-widest border ${
        POOL_TYPE_COLORS[type] ?? POOL_TYPE_COLORS[2] ?? ''
      }`}
    >
      {POOL_TYPE_LABELS[type] ?? 'UNKNOWN'}
    </span>
  );
}

// ─── Buy/Sell Panel ───────────────────────────────────────────────

function BuySellPanel({ deployed }: { deployed: boolean }) {
  const { address } = useAccount();
  const [mode, setMode] = useState<'buy' | 'sell'>('buy');
  const [collection, setCollection] = useState('');
  const [buyQty, setBuyQty] = useState(1);
  const [sellIds, setSellIds] = useState('');
  const [approvalStep, setApprovalStep] = useState<'check' | 'approving' | 'approved'>('check');

  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const { writeContract: writeApproval, data: approvalTxHash } = useWriteContract();
  const { isLoading: isApproving, isSuccess: approvalSuccess } = useWaitForTransactionReceipt({ hash: approvalTxHash });

  const validCollection = isValidAddress(collection);

  // Best buy pool quote
  const { data: buyQuote, refetch: refetchBuyQuote, isFetching: isFetchingBuy } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getBestBuyPool',
    args: [collection as Address, BigInt(buyQty)],
    query: { enabled: validCollection && mode === 'buy' && buyQty > 0 && deployed },
  });

  // Best sell pool quote
  const parsedSellIds = useMemo(() => {
    if (!sellIds.trim()) return [];
    return sellIds.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map((s) => BigInt(s));
  }, [sellIds]);

  const { data: sellQuote, refetch: refetchSellQuote, isFetching: isFetchingSell } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getBestSellPool',
    args: [collection as Address, BigInt(parsedSellIds.length)],
    query: { enabled: validCollection && mode === 'sell' && parsedSellIds.length > 0 && deployed },
  });

  const isFetchingPoolData = isFetchingBuy || isFetchingSell;

  const bestPool = mode === 'buy'
    ? (buyQuote as [Address, bigint] | undefined)?.[0]
    : (sellQuote as [Address, bigint] | undefined)?.[0];
  const bestAmount = mode === 'buy'
    ? (buyQuote as [Address, bigint] | undefined)?.[1]
    : (sellQuote as [Address, bigint] | undefined)?.[1];

  const hasPool = bestPool && bestPool !== ZERO_ADDRESS;

  // Detailed quotes for fee breakdown
  const { data: detailedBuyQuote } = useReadContract({
    address: bestPool as Address,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getBuyQuote',
    args: [BigInt(buyQty)],
    query: { enabled: !!hasPool && mode === 'buy' },
  });

  const { data: detailedSellQuote } = useReadContract({
    address: bestPool as Address,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getSellQuote',
    args: [BigInt(parsedSellIds.length)],
    query: { enabled: !!hasPool && mode === 'sell' && parsedSellIds.length > 0 },
  });

  const protocolFee = mode === 'buy'
    ? (detailedBuyQuote as [bigint, bigint] | undefined)?.[1]
    : (detailedSellQuote as [bigint, bigint] | undefined)?.[1];

  // Get held token IDs from the best buy pool (needed for swapETHForNFTs)
  const { data: heldTokenIdsRaw, refetch: refetchHeldIds } = useReadContract({
    address: bestPool as Address,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getHeldTokenIds',
    query: { enabled: !!hasPool && mode === 'buy' },
  });

  const heldTokenIds = heldTokenIdsRaw as bigint[] | undefined;

  // Get spot price + delta for bonding curve
  const { data: currentSpotPrice } = useReadContract({
    address: bestPool as Address,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'spotPrice',
    query: { enabled: !!hasPool },
  });

  const { data: currentDelta } = useReadContract({
    address: bestPool as Address,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'delta',
    query: { enabled: !!hasPool },
  });

  // NFT approval check for sell flow
  const { data: isApproved, refetch: refetchApproval } = useReadContract({
    address: collection as Address,
    abi: ERC721_APPROVAL_ABI,
    functionName: 'isApprovedForAll',
    args: [address as Address, bestPool as Address],
    query: { enabled: !!address && !!hasPool && validCollection && mode === 'sell' },
  });

  useEffect(() => {
    if (approvalSuccess) {
      setApprovalStep('approved');
      refetchApproval();
      toast.success('Collection approved for trading!');
    }
  }, [approvalSuccess, refetchApproval]);

  // Reset approval step when switching modes or collections
  useEffect(() => {
    setApprovalStep('check');
  }, [mode, collection, bestPool]);

  const needsApproval = mode === 'sell' && hasPool && isApproved === false && approvalStep !== 'approved';

  // Price impact calculation
  const priceImpact = useMemo(() => {
    if (!bestAmount || !currentSpotPrice || currentSpotPrice === 0n) return null;
    const items = mode === 'buy' ? buyQty : parsedSellIds.length;
    if (items === 0) return null;
    const avgPrice = bestAmount / BigInt(items);
    const diff = Number(avgPrice) - Number(currentSpotPrice);
    return (diff / Number(currentSpotPrice)) * 100;
  }, [bestAmount, currentSpotPrice, mode, buyQty, parsedSellIds.length]);

  const spotNum = currentSpotPrice ? Number(formatEther(currentSpotPrice)) : 0;
  const deltaNum = currentDelta ? Number(formatEther(currentDelta)) : 0;

  // Verify bonding curve type matches visualization
  // poolType 0 = linear (delta added), poolType 1 = exponential (delta multiplied)
  // The BondingCurveChart component assumes linear pricing (spot + delta*i).
  // If the pool ever uses exponential curves, the chart is only approximate.
  const isLinearCurve = true; // All current pools use linear curves; update if exponential pools are added

  const handleApprove = () => {
    if (!hasPool || !validCollection || !address) return;
    setApprovalStep('approving');
    writeApproval(
      {
        address: collection as Address,
        abi: ERC721_APPROVAL_ABI,
        functionName: 'setApprovalForAll',
        args: [bestPool as Address, true],
      },
      {
        onError: (e: Error) => {
          setApprovalStep('check');
          toast.error(e.message?.slice(0, 100) || 'Approval failed');
        },
      }
    );
  };

  const handleExecute = () => {
    if (!hasPool) return toast.error('No pool found for this collection');
    if (!address) return toast.error('Connect your wallet');

    try {
      if (mode === 'buy') {
        if (!heldTokenIds || heldTokenIds.length === 0) {
          return toast.error('No NFTs available in this pool');
        }
        const idsToSwap = heldTokenIds.slice(0, buyQty);
        if (idsToSwap.length === 0) {
          return toast.error('No NFTs available to buy');
        }
        writeContract(
          {
            address: bestPool as Address,
            abi: TEGRIDY_NFT_POOL_ABI,
            functionName: 'swapETHForNFTs',
            args: [idsToSwap],
            value: bestAmount!,
          },
          {
            onSuccess: () => toast.success('NFTs purchased successfully!'),
            onError: (e: Error) => toast.error(e.message?.slice(0, 100) || 'Transaction failed'),
          }
        );
      } else {
        const minOutput = (bestAmount! * 95n) / 100n;
        writeContract(
          {
            address: bestPool as Address,
            abi: TEGRIDY_NFT_POOL_ABI,
            functionName: 'swapNFTsForETH',
            args: [parsedSellIds, minOutput],
          },
          {
            onSuccess: () => toast.success('NFTs sold successfully!'),
            onError: (e: Error) => toast.error(e.message?.slice(0, 100) || 'Transaction failed'),
          }
        );
      }
    } catch {
      toast.error('Transaction failed');
    }
  };

  useEffect(() => {
    if (isSuccess) {
      setBuyQty(1);
      setSellIds('');
      // Refetch pool data after successful transaction
      refetchBuyQuote();
      refetchSellQuote();
      refetchHeldIds();
    }
  }, [isSuccess, refetchBuyQuote, refetchSellQuote, refetchHeldIds]);

  return (
    <ArtCard art={ART.poolParty} opacity={1} overlay="none" className="rounded-2xl">
      <div className="p-6">
        <h3 className="text-lg font-semibold text-white mb-5">
          Instant {mode === 'buy' ? 'Buy' : 'Sell'}
        </h3>

        {/* Buy/Sell Toggle */}
        <div className="flex rounded-xl bg-black/60 p-1 mb-5">
          {(['buy', 'sell'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 ${
                mode === m
                  ? m === 'buy'
                    ? 'bg-emerald-500/40 text-emerald-300 shadow-inner'
                    : 'bg-orange-500/20 text-orange-400 shadow-inner'
                  : 'text-white/60 hover:text-white/80'
              }`}
            >
              {m === 'buy' ? 'Buy NFTs' : 'Sell NFTs'}
            </button>
          ))}
        </div>

        {/* Collection input */}
        <div className="mb-4">
          <label className={`${labelClass} mb-2 block`}>Collection Address</label>
          <div className="relative">
            <input
              type="text"
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              placeholder="0x..."
              className={inputClass}
            />
            <button
              onClick={async () => {
                try {
                  const text = await navigator.clipboard.readText();
                  setCollection(text.trim());
                } catch {
                  toast.error('Failed to read clipboard');
                }
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white hover:text-white transition-colors text-xs font-medium"
            >
              PASTE
            </button>
          </div>
        </div>

        {/* Buy: Quantity Selector */}
        {mode === 'buy' && (
          <div className="mb-5">
            <label className={`${labelClass} mb-2 block`}>Quantity <span className="normal-case tracking-normal text-white/70">(max 10)</span></label>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setBuyQty(Math.max(1, buyQty - 1))}
                className="w-11 h-11 rounded-xl bg-black/60 border border-white/25 text-white hover:text-white hover:border-white/20 transition-all text-lg font-medium flex items-center justify-center"
              >
                -
              </button>
              <div className="flex-1 text-center">
                <span className="text-2xl font-mono font-bold text-white tabular-nums">{buyQty}</span>
                <span className="text-white text-sm ml-1">NFT{buyQty !== 1 ? 's' : ''}</span>
              </div>
              <button
                onClick={() => setBuyQty(Math.min(10, buyQty + 1))}
                className="w-11 h-11 rounded-xl bg-black/60 border border-white/25 text-white hover:text-white hover:border-white/20 transition-all text-lg font-medium flex items-center justify-center"
              >
                +
              </button>
            </div>
          </div>
        )}

        {/* Sell: Token IDs */}
        {mode === 'sell' && (
          <div className="mb-5">
            <label className={`${labelClass} mb-2 block`}>
              Token IDs <span className="normal-case tracking-normal text-white">(comma-separated)</span>
            </label>
            <input
              type="text"
              value={sellIds}
              onChange={(e) => setSellIds(e.target.value)}
              placeholder="1, 42, 100"
              className={inputClass}
            />
            {parsedSellIds.length > 0 && (
              <p className="text-[10px] text-white mt-1.5 font-mono">
                {parsedSellIds.length} token{parsedSellIds.length !== 1 ? 's' : ''} selected
              </p>
            )}
          </div>
        )}

        {/* Loading indicator */}
        {validCollection && isFetchingPoolData && !bestAmount && (
          <div className="rounded-xl border border-white/20 bg-black/60 p-4 mb-5 flex items-center justify-center gap-2">
            <svg className="animate-spin w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            <span className="text-sm text-white/60">Fetching pool data...</span>
          </div>
        )}

        {/* Quote Card */}
        {validCollection && bestAmount && hasPool && (
          <m.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-xl border border-white/20 bg-black/60 p-4 mb-5"
          >
            <div className="flex items-center justify-between mb-3">
              <span className={labelClass}>Price Quote</span>
              <span className="text-[10px] font-mono text-white">Pool: {shortenAddress(bestPool!)}</span>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-white">{mode === 'buy' ? 'Total Cost' : 'Payout'}</span>
                <span className="font-mono tabular-nums text-white font-semibold">
                  {formatTokenAmount(formatEther(bestAmount), 6)} ETH
                </span>
              </div>
              {protocolFee !== undefined && (
                <div className="flex justify-between text-sm">
                  <span className="text-white">Protocol Fee</span>
                  <span className="font-mono tabular-nums text-white">
                    {formatTokenAmount(formatEther(protocolFee), 6)} ETH
                  </span>
                </div>
              )}
              {priceImpact !== null && (
                <div className="flex justify-between text-sm items-center">
                  <span className="text-white">Price Impact</span>
                  <PriceImpactBadge impact={priceImpact} />
                </div>
              )}
            </div>
          </m.div>
        )}

        {/* Bonding Curve in Trade Tab (when pool found) */}
        {validCollection && hasPool && spotNum > 0 && (
          <m.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="mb-5"
          >
            <ArtCard art={ART.beachSunset} opacity={1} overlay="none" border="rgba(16,185,129,0.08)">
              <div className="p-4">
                <p className={`${labelClass} mb-2`}>Bonding Curve</p>
                {!isLinearCurve && (
                  <div className="mb-2 px-3 py-1.5 rounded-lg bg-yellow-400/10 border border-yellow-400/20 text-yellow-400 text-[11px] font-medium">
                    This pool uses an exponential bonding curve. Chart visualization is approximate.
                  </div>
                )}
                <BondingCurveChart
                  spotPrice={spotNum}
                  delta={deltaNum}
                  numSteps={10}
                  height={180}
                  currentPriceMarker={spotNum}
                />
              </div>
            </ArtCard>
          </m.div>
        )}

        {/* Empty quote state */}
        {validCollection && (!bestAmount || !hasPool) && deployed && (
          <div className="rounded-xl border border-white/20 bg-black/60 p-4 mb-5 text-center">
            <p className="text-sm text-white">No pools found for this collection</p>
          </div>
        )}

        {/* Price Impact Warning Banner */}
        {priceImpact !== null && Math.abs(priceImpact) > 5 && (
          <m.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className={`rounded-xl border p-3 mb-4 text-xs font-medium flex items-center gap-2 ${
              Math.abs(priceImpact) > 15
                ? 'border-red-400/20 bg-red-400/5 text-red-400'
                : 'border-yellow-400/20 bg-yellow-400/5 text-yellow-400'
            }`}
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            {Math.abs(priceImpact) > 15
              ? `High price impact (${Math.abs(priceImpact).toFixed(1)}%). Consider reducing quantity.`
              : `Moderate price impact (${Math.abs(priceImpact).toFixed(1)}%). Proceed with caution.`}
          </m.div>
        )}

        {/* Execute Buttons */}
        {!deployed ? (
          <button className={btnDisabled} disabled>
            Contract Not Deployed
          </button>
        ) : needsApproval ? (
          <div className="space-y-3">
            <button
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 transition-all duration-300 text-white font-semibold text-sm disabled:opacity-70 disabled:cursor-not-allowed shadow-lg shadow-purple-500/10"
              disabled={isApproving || approvalStep === 'approving'}
              onClick={handleApprove}
            >
              {isApproving || approvalStep === 'approving' ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  Approving...
                </span>
              ) : (
                'Step 1: Approve Collection'
              )}
            </button>
            <button className={btnDisabled} disabled>
              Step 2: Sell NFTs
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              className={`flex-1 ${btnPrimary}`}
              disabled={
                !address || !validCollection || !bestAmount || !hasPool || isConfirming ||
                (mode === 'sell' && parsedSellIds.length === 0)
              }
              onClick={handleExecute}
            >
              {!address
                ? 'Connect Wallet'
                : isConfirming
                ? 'Confirming...'
                : mode === 'buy'
                ? `Buy ${buyQty} NFT${buyQty !== 1 ? 's' : ''}`
                : `Sell ${parsedSellIds.length} NFT${parsedSellIds.length !== 1 ? 's' : ''}`}
            </button>
            {priceImpact !== null && Math.abs(priceImpact) > 5 && (
              <PriceImpactBadge impact={priceImpact} />
            )}
          </div>
        )}
      </div>
    </ArtCard>
  );
}

// ─── Trade History Placeholder ────────────────────────────────────

function TradeHistory() {
  return (
    <ArtCard art={ART.chaosScene} opacity={1} overlay="none" border="var(--color-purple-75)">
      <div className="p-6 text-center">
        <div className="w-12 h-12 rounded-xl bg-black/60 border border-white/20 flex items-center justify-center mx-auto mb-4">
          <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h4 className="text-sm font-semibold text-white mb-1.5">Trade History</h4>
        <p className="text-xs text-white leading-relaxed max-w-xs mx-auto">
          Trade history will appear here once the protocol is live. All swaps, fees, and pool interactions will be tracked.
        </p>
      </div>
    </ArtCard>
  );
}

// ─── Pool Card ────────────────────────────────────────────────────

function PoolCard({
  poolAddress,
  isOwner,
  index = 0,
}: {
  poolAddress: Address;
  isOwner?: boolean;
  index?: number;
}) {
  const { address } = useAccount();
  const [expanded, setExpanded] = useState(false);
  const [liqNftIds, setLiqNftIds] = useState('');
  const [liqEth, setLiqEth] = useState('');
  const [withdrawNftIds, setWithdrawNftIds] = useState('');
  const [withdrawEth, setWithdrawEth] = useState('');
  const [activeAction, setActiveAction] = useState<'deposit' | 'withdraw'>('deposit');

  const { data: poolInfo, refetch: refetchPoolInfo } = useReadContract({
    address: poolAddress,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getPoolInfo',
  });

  const { data: heldTokenIds, refetch: refetchPoolHeldIds } = useReadContract({
    address: poolAddress,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getHeldTokenIds',
  });

  // isPending = wallet signing phase; isConfirming = on-chain confirmation.
  // Both must gate buttons to prevent double-submit during wallet prompt.
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: poolTxSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  // Refetch pool data after successful liquidity operations
  useEffect(() => {
    if (poolTxSuccess) {
      refetchPoolInfo();
      refetchPoolHeldIds();
    }
  }, [poolTxSuccess, refetchPoolInfo, refetchPoolHeldIds]);

  if (!poolInfo) {
    return (
      <div className="rounded-2xl border border-[rgba(16,185,129,0.06)] bg-[rgba(13,21,48,0.6)] backdrop-blur-[20px] p-4 animate-pulse">
        <div className="h-4 bg-black/60 rounded w-24 mb-3" />
        <div className="h-3 bg-black/60 rounded w-32" />
      </div>
    );
  }

  const [nftCollection, poolType, spotPrice, delta, feeBps, _protocolFeeBps, owner, numNFTs, ethBalance] =
    poolInfo as [Address, number, bigint, bigint, bigint, bigint, Address, bigint, bigint];

  const poolOwnerIsUser = address && owner.toLowerCase() === address.toLowerCase();
  const showOwnerControls = isOwner || poolOwnerIsUser;

  const handleAddLiquidity = () => {
    try {
      const ids = liqNftIds.trim() ? liqNftIds.split(',').map((s) => BigInt(s.trim())) : [];
      writeContract(
        {
          address: poolAddress,
          abi: TEGRIDY_NFT_POOL_ABI,
          functionName: 'addLiquidity',
          args: [ids],
          value: liqEth ? parseEther(liqEth) : 0n,
        },
        {
          onSuccess: () => {
            toast.success('Liquidity added!');
            setLiqNftIds('');
            setLiqEth('');
            setExpanded(false);
          },
          onError: (e: Error) => toast.error(e.message?.slice(0, 100) || 'Failed'),
        }
      );
    } catch {
      toast.error('Invalid input');
    }
  };

  const handleWithdraw = () => {
    try {
      const ids = withdrawNftIds.trim() ? withdrawNftIds.split(',').map((s) => BigInt(s.trim())) : [];
      const ethAmt = withdrawEth ? parseEther(withdrawEth) : 0n;
      writeContract(
        {
          address: poolAddress,
          abi: TEGRIDY_NFT_POOL_ABI,
          functionName: 'removeLiquidity' as 'addLiquidity',
          args: [ids, ethAmt] as never,
        },
        {
          onSuccess: () => {
            toast.success('Liquidity withdrawn!');
            setWithdrawNftIds('');
            setWithdrawEth('');
            setExpanded(false);
          },
          onError: (e: Error) => toast.error(e.message?.slice(0, 100) || 'Failed'),
        }
      );
    } catch {
      toast.error('Invalid input');
    }
  };

  return (
    <m.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06 }}
    >
      <ArtCard
        art={isOwner ? ART.wrestler : ART.jungleDark}
        opacity={1}
        overlay="none"
        border={poolType === 0 ? 'rgba(96,165,250,0.15)' : poolType === 1 ? 'rgba(251,146,60,0.15)' : 'rgba(16,185,129,0.15)'}
        className="rounded-2xl"
      >
        <div className="p-5">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <PoolTypeBadge type={poolType} />
              <span className="text-[10px] font-mono text-white">{shortenAddress(poolAddress)}</span>
            </div>
            {showOwnerControls && (
              <span className="text-[9px] uppercase tracking-widest text-emerald-400/60 font-semibold">Owner</span>
            )}
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-4">
            <div>
              <p className={`${labelClass} inline-flex items-center gap-1`}>Spot Price <InfoTooltip text="Current price for the next NFT buy or sell in this pool" /></p>
              <p className="text-sm font-mono tabular-nums text-white mt-0.5">
                {formatTokenAmount(formatEther(spotPrice), 4)} ETH
              </p>
            </div>
            <div>
              <p className={`${labelClass} inline-flex items-center gap-1`}>Delta <InfoTooltip text="Price change after each trade. The bonding curve shifts by this amount per NFT." /></p>
              <p className="text-sm font-mono tabular-nums text-white mt-0.5">
                {formatTokenAmount(formatEther(delta), 4)} ETH
              </p>
            </div>
            <div>
              <p className={labelClass}>NFTs Held</p>
              <p className="text-sm font-mono tabular-nums text-white mt-0.5">{numNFTs.toString()}</p>
            </div>
            <div>
              <p className={labelClass}>ETH Balance</p>
              <p className="text-sm font-mono tabular-nums text-white mt-0.5">
                {formatTokenAmount(formatEther(ethBalance), 4)}
              </p>
            </div>
            <div>
              <p className={`${labelClass} inline-flex items-center gap-1`}>LP Fee <InfoTooltip text="Fee earned by the pool owner on each swap. Only TRADE pools earn LP fees." /></p>
              <p className="text-sm font-mono tabular-nums text-white mt-0.5">
                {(Number(feeBps) / 100).toFixed(2)}%
              </p>
            </div>
            <div>
              <p className={labelClass}>Collection</p>
              <p className="text-[11px] font-mono text-white mt-0.5">{shortenAddress(nftCollection)}</p>
            </div>
          </div>

          {/* Held Token IDs */}
          {heldTokenIds && (heldTokenIds as bigint[]).length > 0 && (
            <div className="mb-4">
              <p className={`${labelClass} mb-1.5`}>Held Token IDs</p>
              <div className="flex flex-wrap gap-1.5">
                {(heldTokenIds as bigint[]).slice(0, 20).map((id) => (
                  <span
                    key={id.toString()}
                    className="px-2 py-0.5 rounded-md bg-black/60 border border-white/20 text-[10px] font-mono text-white"
                  >
                    #{id.toString()}
                  </span>
                ))}
                {(heldTokenIds as bigint[]).length > 20 && (
                  <span className="px-2 py-0.5 text-[10px] text-white">
                    +{(heldTokenIds as bigint[]).length - 20} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Owner: Manage Liquidity */}
          {showOwnerControls && (
            <>
              <button
                onClick={() => setExpanded(!expanded)}
                className="w-full text-left text-xs text-white/70 hover:text-white/80 transition-colors font-medium py-2 flex items-center gap-1.5"
              >
                <svg
                  className={`w-3 h-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                Manage Liquidity
              </button>
              <AnimatePresence>
                {expanded && (
                  <m.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto' }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="pt-3 border-t border-white/20">
                      {/* Deposit / Withdraw toggle */}
                      <div className="flex rounded-lg bg-black/60 p-0.5 mb-4">
                        {(['deposit', 'withdraw'] as const).map((a) => (
                          <button
                            key={a}
                            onClick={() => setActiveAction(a)}
                            className={`flex-1 py-2 rounded-md text-xs font-semibold transition-all capitalize ${
                              activeAction === a
                                ? a === 'deposit'
                                  ? 'bg-emerald-500/40 text-emerald-300'
                                  : 'bg-orange-500/20 text-orange-400'
                                : 'text-white/60 hover:text-white/80'
                            }`}
                          >
                            {a}
                          </button>
                        ))}
                      </div>

                      {activeAction === 'deposit' ? (
                        <div className="space-y-3">
                          <div>
                            <label className={`${labelClass} mb-1 block`}>NFT Token IDs</label>
                            <input
                              type="text"
                              value={liqNftIds}
                              onChange={(e) => setLiqNftIds(e.target.value)}
                              placeholder="1, 42, 100"
                              className={inputClass}
                            />
                          </div>
                          <div>
                            <label className={`${labelClass} mb-1 block`}>ETH Amount</label>
                            <input
                              type="number"
                              value={liqEth}
                              onChange={(e) => setLiqEth(e.target.value)}
                              placeholder="0.0"
                              className={inputClass}
                            />
                          </div>
                          <button
                            className="w-full py-2.5 rounded-xl bg-emerald-600/80 hover:bg-emerald-600 transition-colors text-white text-sm font-medium disabled:opacity-70"
                            disabled={isPending || isConfirming || (!liqNftIds.trim() && !liqEth)}
                            onClick={handleAddLiquidity}
                          >
                            {isPending ? 'Check wallet…' : isConfirming ? 'Adding...' : 'Deposit Liquidity'}
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div>
                            <label className={`${labelClass} mb-1 block`}>Withdraw NFT IDs</label>
                            <input
                              type="text"
                              value={withdrawNftIds}
                              onChange={(e) => setWithdrawNftIds(e.target.value)}
                              placeholder="1, 42, 100"
                              className={inputClass}
                            />
                          </div>
                          <div>
                            <label className={`${labelClass} mb-1 block`}>Withdraw ETH</label>
                            <input
                              type="number"
                              value={withdrawEth}
                              onChange={(e) => setWithdrawEth(e.target.value)}
                              placeholder="0.0"
                              className={inputClass}
                            />
                          </div>
                          <button
                            className="w-full py-2.5 rounded-xl bg-orange-600/80 hover:bg-orange-600 transition-colors text-white text-sm font-medium disabled:opacity-70"
                            disabled={isPending || isConfirming || (!withdrawNftIds.trim() && !withdrawEth)}
                            onClick={handleWithdraw}
                          >
                            {isPending ? 'Check wallet…' : isConfirming ? 'Withdrawing...' : 'Withdraw Liquidity'}
                          </button>
                        </div>
                      )}
                    </div>
                  </m.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>
      </ArtCard>
    </m.div>
  );
}

// ─── Pool Explorer ────────────────────────────────────────────────

function PoolExplorer({ deployed }: { deployed: boolean }) {
  const [searchAddr, setSearchAddr] = useState('');
  const validSearch = isValidAddress(searchAddr);

  const { data: pools, isFetching: isFetchingPools } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getPoolsForCollection',
    args: [searchAddr as Address],
    query: { enabled: validSearch && deployed },
  });

  const poolList = (pools as Address[] | undefined) ?? [];

  return (
    <ArtCard art={ART.jungleDark} opacity={1} overlay="none" className="rounded-2xl">
      <div className="p-6">
        <h3 className="text-lg font-semibold text-white mb-5">Pool Explorer</h3>

        <div className="mb-5">
          <label className={`${labelClass} mb-2 block`}>Collection Address</label>
          <input
            type="text"
            value={searchAddr}
            onChange={(e) => setSearchAddr(e.target.value)}
            placeholder="0x..."
            className={inputClass}
          />
        </div>

        {!validSearch && (
          <ArtCard art={ART.jungleDark} opacity={1} overlay="none" border="rgba(255,255,255,0.04)">
            <div className="text-center py-12 px-4">
              <div className="w-12 h-12 rounded-xl bg-black/60 border border-white/20 flex items-center justify-center mx-auto mb-4">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
              </div>
              <p className="text-sm text-white">Enter a collection address to discover pools</p>
            </div>
          </ArtCard>
        )}

        {validSearch && isFetchingPools && poolList.length === 0 && (
          <div className="text-center py-10 flex flex-col items-center gap-2">
            <svg className="animate-spin w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            <p className="text-sm text-white/60">Searching for pools...</p>
          </div>
        )}

        {validSearch && !isFetchingPools && poolList.length === 0 && (
          <div className="text-center py-10">
            <p className="text-sm text-white">No pools found for this collection.</p>
            <p className="text-xs text-white/70 mt-1">Be the first! Create a pool in the Create Pool tab.</p>
          </div>
        )}

        {validSearch && poolList.length > 0 && (
          <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-white/10">
            {poolList.map((addr, i) => (
              <PoolCard key={addr} poolAddress={addr} index={i} />
            ))}
          </div>
        )}
      </div>
    </ArtCard>
  );
}

// ─── Trade Tab ────────────────────────────────────────────────────

function TradeTab({ deployed }: { deployed: boolean }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BuySellPanel deployed={deployed} />
        <PoolExplorer deployed={deployed} />
      </div>
      <TradeHistory />
    </div>
  );
}

// ─── Create Pool Tab ──────────────────────────────────────────────

function CreatePoolTab({ deployed }: { deployed: boolean }) {
  const { address } = useAccount();
  const [step, setStep] = useState(1);
  const [collection, setCollection] = useState('');
  const [poolType, setPoolType] = useState<PoolType>(2);
  const [spotPriceInput, setSpotPriceInput] = useState('0.1');
  const [deltaInput, setDeltaInput] = useState('0.01');
  const [ethDeposit, setEthDeposit] = useState('');
  const [nftIds, setNftIds] = useState('');
  const [feeBps, setFeeBps] = useState('200');
  const [autoTracked, setAutoTracked] = useState<string | null>(null);

  // Two parallel tx lifecycles: one for the ERC721 setApprovalForAll,
  // one for the factory.createPool call. Keeping them separate means we
  // can watch receipts independently and react to each stage.
  const { writeContract: writeApprove, data: approveTx, isPending: isApprovePending } = useWriteContract();
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveTx });

  const { writeContract: writeDeploy, data: deployTx, isPending: isDeployPending } = useWriteContract();
  const { data: deployReceipt, isLoading: isDeployConfirming, isSuccess: isDeploySuccess } = useWaitForTransactionReceipt({ hash: deployTx });

  const spotNum = parseFloat(spotPriceInput) || 0;
  const deltaNum = parseFloat(deltaInput) || 0;

  const parsedNftIds = useMemo(() => {
    if (!nftIds.trim()) return [];
    return nftIds.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map((s) => BigInt(s));
  }, [nftIds]);

  // Approval state — only relevant when the user plans to seed the pool with
  // NFTs. The factory pulls them via transferFrom during createPool().
  const validCollection = isValidAddress(collection);
  const needsNFTs = parsedNftIds.length > 0;

  const { data: isApproved, refetch: refetchApproval } = useReadContract({
    address: validCollection ? (collection as Address) : undefined,
    abi: ERC721_APPROVAL_ABI,
    functionName: 'isApprovedForAll',
    args: address && validCollection ? [address as Address, TEGRIDY_NFT_POOL_FACTORY_ADDRESS as Address] : undefined,
    query: { enabled: !!address && validCollection && needsNFTs, refetchInterval: 10_000 },
  });

  useEffect(() => {
    if (isApproveSuccess) {
      toast.success('Collection approved — ready to deploy');
      refetchApproval();
    }
  }, [isApproveSuccess, refetchApproval]);

  // Decode PoolCreated from the deploy receipt so the new pool can be auto-
  // tracked without the user pasting the address by hand.
  useEffect(() => {
    if (!isDeploySuccess || !deployReceipt || autoTracked) return;
    for (const log of deployReceipt.logs) {
      if (log.address.toLowerCase() !== TEGRIDY_NFT_POOL_FACTORY_ADDRESS.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'PoolCreated') {
          const poolAddr = (decoded.args as { pool?: Address } | undefined)?.pool;
          if (poolAddr) {
            addTrackedPool(poolAddr);
            setAutoTracked(poolAddr);
            toast.success('Pool deployed & tracked — see My Pools tab');
            setStep(1);
            setCollection('');
            setNftIds('');
            setEthDeposit('');
          }
          return;
        }
      } catch { /* skip non-matching logs */ }
    }
  }, [isDeploySuccess, deployReceipt, autoTracked]);

  // Type-specific hints — don't hard-gate (the contract enforces the real
  // rules), just warn when the combination doesn't match the chosen type.
  const typeMismatch = useMemo<string | null>(() => {
    if (poolType === 0 && parsedNftIds.length > 0) {
      return 'BUY pools only accumulate NFTs from trades — remove the token IDs, or pick TRADE / SELL instead.';
    }
    if (poolType === 1 && ethDeposit && parseFloat(ethDeposit) > 0) {
      return 'SELL pools only hold NFTs — remove the ETH deposit, or pick TRADE / BUY instead.';
    }
    return null;
  }, [poolType, parsedNftIds.length, ethDeposit]);

  const canProceed = useCallback(
    (s: number) => {
      if (s === 1) return validCollection;
      if (s === 2) return spotNum > 0;
      if (s === 3) return true;
      return false;
    },
    [validCollection, spotNum]
  );

  const isPending = isDeployPending;
  const isConfirming = isDeployConfirming;
  const approvalNeeded = needsNFTs && isApproved === false;

  const handleApproveCollection = () => {
    if (!validCollection || !address) return;
    writeApprove(
      {
        address: collection as Address,
        abi: ERC721_APPROVAL_ABI,
        functionName: 'setApprovalForAll',
        args: [TEGRIDY_NFT_POOL_FACTORY_ADDRESS as Address, true],
      },
      { onError: (e: Error) => toast.error(e.message?.slice(0, 100) || 'Approval failed') },
    );
  };

  const handleDeploy = () => {
    if (!address) return toast.error('Connect your wallet');
    if (!validCollection) return toast.error('Invalid collection address');
    if (approvalNeeded) return toast.error('Approve the collection first');

    try {
      writeDeploy(
        {
          address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
          abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
          functionName: 'createPool',
          args: [
            collection as Address,
            poolType,
            parseEther(spotPriceInput || '0'),
            parseEther(deltaInput || '0'),
            BigInt(poolType === 2 ? (feeBps || '0') : '0'),
            parsedNftIds,
          ],
          value: ethDeposit ? parseEther(ethDeposit) : 0n,
        },
        {
          onError: (e: Error) => toast.error(e.message?.slice(0, 100) || 'Pool creation failed'),
        }
      );
    } catch {
      toast.error('Invalid input values');
    }
  };

  const stepLabels = ['Collection & Type', 'Pricing', 'Liquidity & Deploy'];

  return (
    <div className="max-w-2xl mx-auto">
      {/* Step Progress */}
      <div className="flex items-center justify-between mb-8 px-2">
        {stepLabels.map((label, i) => {
          const num = i + 1;
          const isActive = step === num;
          const isDone = step > num;
          return (
            <div key={num} className="flex items-center gap-2 flex-1">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 flex-shrink-0 ${
                  isActive
                    ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30'
                    : isDone
                    ? 'bg-emerald-500/40 text-emerald-300 border border-emerald-500/30'
                    : 'bg-black/60 text-white border border-white/20'
                }`}
              >
                {isDone ? (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  num
                )}
              </div>
              <span className={`text-xs font-medium hidden sm:block ${isActive ? 'text-white' : 'text-white/70'}`}>
                {label}
              </span>
              {i < stepLabels.length - 1 && (
                <div className={`flex-1 h-px mx-2 ${isDone ? 'bg-emerald-500/30' : 'bg-black/60'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step 1: Collection & Type */}
      <AnimatePresence mode="wait">
        {step === 1 && (
          <m.div
            key="step1"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
          >
            <ArtCard art={ART.mumuBull} opacity={1} overlay="none" className="rounded-2xl">
              <div className="p-6">
                <h3 className="text-lg font-semibold text-white mb-6">Choose Collection & Pool Type</h3>

                <div className="mb-6">
                  <label className={`${labelClass} mb-2 block`}>NFT Collection Address</label>
                  <input
                    type="text"
                    value={collection}
                    onChange={(e) => setCollection(e.target.value)}
                    placeholder="0x..."
                    className={inputClass}
                  />
                </div>

                <div className="mb-6">
                  <label className={`${labelClass} mb-3 block`}>Pool Type</label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {([0, 1, 2] as PoolType[]).map((type) => (
                      <button
                        key={type}
                        onClick={() => setPoolType(type)}
                        className={`p-4 rounded-xl border text-left transition-all duration-200 ${
                          poolType === type
                            ? (POOL_TYPE_BG_SELECTED[type] ?? '')
                            : 'bg-black/60 border-white/20 hover:border-white/[0.12]'
                        }`}
                      >
                        <svg
                          className={`w-5 h-5 mb-2 ${
                            poolType === type
                              ? type === 0 ? 'text-blue-400' : type === 1 ? 'text-orange-400' : 'text-emerald-400'
                              : 'text-white'
                          }`}
                          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d={POOL_TYPE_ICONS[type] ?? ''} />
                        </svg>
                        <p
                          className={`text-sm font-semibold mb-1 ${
                            poolType === type
                              ? type === 0 ? 'text-blue-400' : type === 1 ? 'text-orange-400' : 'text-emerald-400'
                              : 'text-white'
                          }`}
                        >
                          {POOL_TYPE_LABELS[type] ?? 'UNKNOWN'}
                        </p>
                        <p className="text-[10px] text-white leading-relaxed">{POOL_TYPE_DESCRIPTIONS[type] ?? ''}</p>
                      </button>
                    ))}
                  </div>
                </div>

                {!deployed ? (
                  <button className={btnDisabled} disabled>Contract Not Deployed</button>
                ) : (
                  <button className={btnPrimary} disabled={!canProceed(1)} onClick={() => setStep(2)}>
                    Continue
                  </button>
                )}
              </div>
            </ArtCard>
          </m.div>
        )}

        {/* Step 2: Pricing */}
        {step === 2 && (
          <m.div
            key="step2"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
          >
            <ArtCard art={ART.mumuBull} opacity={1} overlay="none" className="rounded-2xl">
              <div className="p-6">
                <h3 className="text-lg font-semibold text-white mb-6">Configure Pricing</h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                  <div>
                    <label className={`${labelClass} mb-2 flex items-center gap-1.5`}>
                      Spot Price (ETH)
                      <InfoTooltip text="The current price for the next NFT buy or sell. This is the starting point of your bonding curve." />
                    </label>
                    <input
                      type="number"
                      step="0.001"
                      value={spotPriceInput}
                      onChange={(e) => setSpotPriceInput(e.target.value)}
                      className={inputClass}
                    />
                    <p className="text-[10px] text-white mt-1">Starting price for the first trade</p>
                  </div>
                  <div>
                    <label className={`${labelClass} mb-2 flex items-center gap-1.5`}>
                      Delta (ETH)
                      <InfoTooltip text="How much the price changes after each trade. Higher delta = more price movement per trade. Set to 0 for a flat price." />
                    </label>
                    <input
                      type="number"
                      step="0.001"
                      value={deltaInput}
                      onChange={(e) => setDeltaInput(e.target.value)}
                      className={inputClass}
                    />
                    <p className="text-[10px] text-white mt-1">Price change per trade</p>
                  </div>
                </div>

                {/* Bonding Curve Visualization */}
                <div className="mb-6">
                  <label className={`${labelClass} mb-3 block`}>Bonding Curve Preview</label>
                  <ArtCard art={ART.beachSunset} opacity={1} overlay="none" border="rgba(16,185,129,0.08)">
                    <div className="p-4">
                      <BondingCurveChart spotPrice={spotNum} delta={deltaNum} numSteps={10} height={220} />
                      <div className="flex justify-between text-[10px] text-white mt-2 px-1 font-mono">
                        <span>1st buy: {spotNum.toFixed(4)} ETH</span>
                        <span>10th buy: {(spotNum + deltaNum * 9).toFixed(4)} ETH</span>
                      </div>
                    </div>
                  </ArtCard>
                </div>

                <div className="flex gap-3">
                  <button
                    className="flex-1 py-3.5 rounded-xl bg-black/60 border border-white/25 hover:border-white/[0.15] text-white hover:text-white transition-all text-sm font-medium"
                    onClick={() => setStep(1)}
                  >
                    Back
                  </button>
                  <button className={`flex-1 ${btnPrimary}`} disabled={!canProceed(2)} onClick={() => setStep(3)}>
                    Continue
                  </button>
                </div>
              </div>
            </ArtCard>
          </m.div>
        )}

        {/* Step 3: Liquidity & Deploy */}
        {step === 3 && (
          <m.div
            key="step3"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
          >
            <ArtCard art={ART.mumuBull} opacity={1} overlay="none" className="rounded-2xl">
              <div className="p-6">
                <h3 className="text-lg font-semibold text-white mb-6">Add Initial Liquidity</h3>

                <div className="space-y-4 mb-6">
                  <div>
                    <label className={`${labelClass} mb-2 block`}>Initial ETH Deposit</label>
                    <input
                      type="number"
                      step="0.01"
                      value={ethDeposit}
                      onChange={(e) => setEthDeposit(e.target.value)}
                      placeholder="0.0"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={`${labelClass} mb-2 block`}>
                      Initial NFT Token IDs{' '}
                      <span className="normal-case tracking-normal text-white">(comma-separated)</span>
                    </label>
                    <input
                      type="text"
                      value={nftIds}
                      onChange={(e) => setNftIds(e.target.value)}
                      placeholder="1, 42, 100"
                      className={inputClass}
                    />
                    <p className="text-[10px] text-white mt-1">Approve NFTs for the factory contract first</p>
                  </div>

                  {poolType === 2 && (
                    <div>
                      <label className={`${labelClass} mb-2 flex items-center gap-1.5`}>
                        LP Fee (basis points)
                        <InfoTooltip text="Fee earned by the pool owner on each trade. Only applies to TRADE pools. 200 bps = 2% fee." />
                      </label>
                      <input
                        type="number"
                        value={feeBps}
                        onChange={(e) => setFeeBps(e.target.value)}
                        placeholder="200"
                        className={inputClass}
                      />
                      <p className="text-[10px] text-white mt-1">
                        {(Number(feeBps) / 100).toFixed(2)}% fee on each trade (TRADE pools only)
                      </p>
                    </div>
                  )}

                  {poolType === 2 && (
                    <RiskBanner variant="info">
                      TRADE pools are exposed to inventory risk. If the NFT floor price drops, your pool may accumulate NFTs worth less than the ETH you deposited. This is similar to impermanent loss in token AMMs.
                    </RiskBanner>
                  )}
                </div>

                {/* Summary Card */}
                <ArtCard art={ART.busCrew} opacity={1} overlay="none" border="rgba(16,185,129,0.10)">
                  <div className="p-5">
                    <h4 className={`${labelClass} text-white/60 mb-4`}>Pool Summary</h4>
                    <div className="space-y-2.5">
                      <SummaryRow label="Collection" value={shortenAddress(collection)} />
                      <SummaryRow label="Pool Type" value={POOL_TYPE_LABELS[poolType] ?? 'UNKNOWN'} />
                      <SummaryRow label="Spot Price" value={`${spotPriceInput} ETH`} />
                      <SummaryRow label="Delta" value={`${deltaInput} ETH`} />
                      {poolType === 2 && <SummaryRow label="LP Fee" value={`${(Number(feeBps) / 100).toFixed(2)}%`} />}
                      <SummaryRow label="Initial ETH" value={ethDeposit ? `${ethDeposit} ETH` : 'None'} />
                      <SummaryRow
                        label="Initial NFTs"
                        value={parsedNftIds.length > 0 ? `${parsedNftIds.length} token${parsedNftIds.length !== 1 ? 's' : ''}` : 'None'}
                      />
                      <div className="border-t border-white/20 pt-2.5 mt-2.5">
                        <SummaryRow label="Est. 1st Buy" value={`${spotNum.toFixed(4)} ETH`} highlight />
                        <SummaryRow label="Est. 1st Sell" value={`${Math.max(0, spotNum - deltaNum).toFixed(4)} ETH`} highlight />
                      </div>
                    </div>
                  </div>
                </ArtCard>

                {typeMismatch && (
                  <div className="mb-4">
                    <RiskBanner variant="warning">{typeMismatch}</RiskBanner>
                  </div>
                )}

                {needsNFTs && validCollection && (
                  <div
                    className="mb-4 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap"
                    style={{
                      background: isApproved ? 'rgba(16,185,129,0.08)' : 'rgba(234,179,8,0.08)',
                      border: `1px solid ${isApproved ? 'rgba(16,185,129,0.25)' : 'rgba(234,179,8,0.25)'}`,
                    }}
                  >
                    <div className="min-w-0">
                      <p className={`text-[11px] uppercase tracking-wider font-semibold mb-0.5 ${isApproved ? 'text-emerald-400' : 'text-yellow-300'}`}>
                        Step A · Approve collection
                      </p>
                      <p className="text-white/80 text-[12px]">
                        {isApproved
                          ? 'Factory is approved to pull your NFTs during deploy.'
                          : 'The factory needs permission to move your NFT IDs into the pool.'}
                      </p>
                    </div>
                    {!isApproved && (
                      <button
                        onClick={handleApproveCollection}
                        disabled={isApprovePending || isApproveConfirming || !address}
                        className="flex-shrink-0 px-4 py-2 rounded-lg bg-yellow-500/20 text-yellow-200 border border-yellow-500/40 hover:bg-yellow-500/30 transition-colors text-[12px] font-semibold disabled:opacity-40"
                      >
                        {isApprovePending ? 'Check wallet…' : isApproveConfirming ? 'Approving…' : 'Approve'}
                      </button>
                    )}
                  </div>
                )}

                <div className="flex gap-3 mt-6">
                  <button
                    className="flex-1 py-3.5 rounded-xl bg-black/60 border border-white/25 hover:border-white/[0.15] text-white hover:text-white transition-all text-sm font-medium"
                    onClick={() => setStep(2)}
                  >
                    Back
                  </button>
                  {!deployed ? (
                    <button className={`flex-1 ${btnDisabled}`} disabled>Contract Not Deployed</button>
                  ) : (
                    <button
                      className={`flex-1 ${btnPrimary}`}
                      disabled={isPending || isConfirming || !address || approvalNeeded}
                      onClick={handleDeploy}
                    >
                      {isPending
                        ? 'Check wallet…'
                        : isConfirming
                        ? 'Deploying Pool...'
                        : !address
                        ? 'Connect Wallet'
                        : approvalNeeded
                        ? 'Approve Collection First'
                        : 'Deploy Pool'}
                    </button>
                  )}
                </div>
              </div>
            </ArtCard>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SummaryRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-white">{label}</span>
      <span className={`font-mono tabular-nums ${highlight ? 'text-emerald-400 font-medium' : 'text-white'}`}>
        {value}
      </span>
    </div>
  );
}

// ─── My Pools Tab ─────────────────────────────────────────────────

function useTrackedPools() {
  const readFromStorage = useCallback((): string[] => {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item: unknown) => typeof item === 'string' && isValidAddress(item));
    } catch {
      return [];
    }
  }, []);

  const [pools, setPools] = useState<string[]>(readFromStorage);

  // Keep the list in sync when another surface (CreatePoolTab auto-tracks a
  // freshly-deployed pool) calls addTrackedPool(). Same-tab updates use the
  // custom event; cross-tab falls back to the native storage event.
  useEffect(() => {
    const refresh = () => setPools(readFromStorage());
    window.addEventListener(POOL_LIST_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(POOL_LIST_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [readFromStorage]);

  const addPool = useCallback((addr: string) => {
    if (!isValidAddress(addr)) return;
    addTrackedPool(addr);
    setPools(readFromStorage());
  }, [readFromStorage]);

  const removePool = useCallback((addr: string) => {
    setPools((prev) => {
      const next = prev.filter((p) => p.toLowerCase() !== addr.toLowerCase());
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent(POOL_LIST_EVENT));
      return next;
    });
  }, []);

  return { pools, addPool, removePool };
}

function MyPoolsTab({ deployed: _deployed }: { deployed: boolean }) {
  const { address } = useAccount();
  const { pools: trackedPools, addPool, removePool } = useTrackedPools();
  const [newPoolAddr, setNewPoolAddr] = useState('');

  const handleAddPool = () => {
    if (!isValidAddress(newPoolAddr)) return toast.error('Invalid pool address');
    addPool(newPoolAddr);
    setNewPoolAddr('');
    toast.success('Pool added to tracking list');
  };

  if (!address) {
    return (
      <ArtCard art={ART.wrestler} opacity={1} overlay="none" className="rounded-2xl max-w-md mx-auto">
        <div className="p-10 text-center">
          <div className="w-14 h-14 rounded-2xl bg-black/60 border border-white/20 flex items-center justify-center mx-auto mb-5">
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">Connect Your Wallet</h3>
          <p className="text-sm text-white">Connect your wallet to view and manage your liquidity pools.</p>
        </div>
      </ArtCard>
    );
  }

  return (
    <div className="space-y-6">
      {/* Earnings Summary */}
      <ArtCard art={ART.wrestler} opacity={1} overlay="none" className="rounded-2xl">
        <div className="p-5">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className={labelClass}>Your Pool Earnings</p>
              <p className="text-2xl font-mono tabular-nums text-white font-semibold mt-1">{'\u2014'}</p>
              <p className="text-[10px] text-white mt-0.5">Cumulative LP fees (available after launch)</p>
            </div>
            <div className="text-left sm:text-right">
              <p className={labelClass}>Tracked Pools</p>
              <p className="text-2xl font-mono tabular-nums text-white font-semibold mt-1">{trackedPools.length}</p>
            </div>
          </div>
        </div>
      </ArtCard>

      {/* Add Pool Input */}
      <ArtCard art={ART.busCrew} opacity={1} overlay="none" className="rounded-2xl">
        <div className="p-5">
          <h4 className="text-sm font-semibold text-white mb-3">Track a Pool</h4>
          <p className="text-xs text-white mb-4">
            Enter a pool address to track it. Pool ownership is verified on-chain.
          </p>
          <div className="flex gap-3">
            <input
              type="text"
              value={newPoolAddr}
              onChange={(e) => setNewPoolAddr(e.target.value)}
              placeholder="Pool address (0x...)"
              className={`flex-1 ${inputClass}`}
              onKeyDown={(e) => e.key === 'Enter' && handleAddPool()}
            />
            <button
              onClick={handleAddPool}
              disabled={!isValidAddress(newPoolAddr)}
              className="px-5 py-3 rounded-xl bg-emerald-600/80 hover:bg-emerald-600 transition-colors text-white text-sm font-medium disabled:opacity-70 disabled:cursor-not-allowed flex-shrink-0"
            >
              Track
            </button>
          </div>
        </div>
      </ArtCard>

      {/* Pool List */}
      {trackedPools.length === 0 ? (
        <ArtCard art={ART.wrestler} opacity={1} overlay="none" border="rgba(255,255,255,0.04)" className="rounded-2xl">
          <div className="py-12 px-6 text-center">
            <div className="w-12 h-12 rounded-xl bg-black/60 border border-white/20 flex items-center justify-center mx-auto mb-4">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
            <p className="text-sm text-white mb-1">No pools tracked yet</p>
            <p className="text-xs text-white">You haven't created any pools yet. Go to Create Pool to get started, or enter a pool address above to track an existing one.</p>
          </div>
        </ArtCard>
      ) : (
        <div className="space-y-3">
          {trackedPools.map((addr, i) => (
            <div key={addr} className="relative">
              <PoolCard poolAddress={addr as Address} isOwner index={i} />
              <button
                onClick={() => {
                  removePool(addr);
                  toast.success('Pool removed from tracking');
                }}
                className="absolute top-3 right-3 z-20 w-7 h-7 rounded-lg bg-black/60 border border-white/25 hover:border-red-400/30 hover:bg-red-400/10 text-white hover:text-red-400 transition-all flex items-center justify-center"
                title="Remove from tracking"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Coming Soon State ────────────────────────────────────────────

/** @internal Reserved for future use */
export function ComingSoon() {
  const features = [
    { title: 'Linear Bonding Curves', desc: 'Predictable pricing with configurable spot price and delta parameters.' },
    { title: 'Buy / Sell / Trade Pools', desc: 'Create single-sided or two-sided liquidity pools for any NFT collection.' },
    { title: 'Instant NFT Liquidity', desc: 'Swap NFTs instantly without waiting for a buyer or seller.' },
    { title: 'LP Fee Earnings', desc: 'Earn fees on every trade through your liquidity pools.' },
  ];

  return (
    <div className="max-w-xl mx-auto">
      <ArtCard art={ART.poolParty} opacity={1} overlay="none" border="rgba(16,185,129,0.10)" className="rounded-2xl">
        <div className="p-8 sm:p-10">
          {/* Glow */}
          <div className="absolute -top-20 -right-20 w-60 h-60 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute -bottom-16 -left-16 w-48 h-48 bg-purple-500/5 rounded-full blur-3xl pointer-events-none" />

          <div className="relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-xs font-semibold mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Coming Soon
            </div>

            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">NFT AMM</h2>
            <p className="text-sm text-white leading-relaxed mb-8 max-w-md">
              Create bonding-curve liquidity pools for any NFT collection.
              Automated market making with linear pricing, instant swaps, and protocol-level fee routing.
            </p>

            {/* Blurred Preview */}
            <ArtCard art={ART.beachSunset} opacity={1} overlay="none" border="rgba(255,255,255,0.04)" className="rounded-xl mb-8">
              <div className="p-5 relative">
                <div className="blur-[2px] opacity-60 pointer-events-none select-none">
                  <BondingCurveChart spotPrice={0.1} delta={0.005} numSteps={10} height={160} />
                </div>
                <div className="absolute inset-0 flex items-center justify-center bg-[rgba(6,12,26,0.3)]">
                  <span className="text-sm font-medium text-white bg-[rgba(13,21,48,0.8)] px-4 py-2 rounded-lg border border-white/25">
                    Interactive bonding curve visualization
                  </span>
                </div>
              </div>
            </ArtCard>

            {/* Feature List */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {features.map((f) => (
                <div key={f.title} className="flex gap-3 items-start">
                  <div className="w-5 h-5 rounded-md bg-emerald-500/30 border border-emerald-500/40 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <svg className="w-3 h-3 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{f.title}</p>
                    <p className="text-[11px] text-white leading-relaxed mt-0.5">{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </ArtCard>
    </div>
  );
}

// ─── Main Export ───────────────────────────────────────────────────

export function AMMSection() {
  const deployed = isDeployed(TEGRIDY_NFT_POOL_FACTORY_ADDRESS);
  const [activeTab, setActiveTab] = useState<Tab>('trade');

  const { data: poolCount } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getPoolCount',
    query: { enabled: deployed, refetchInterval: 30_000 },
  });

  return (
    <div>
      {!deployed && (
        <div
          className="rounded-xl px-4 py-3 text-center text-[13px] text-amber-400/80 border border-amber-500/20 mb-6"
          style={{ background: 'rgba(245,158,11,0.06)' }}
        >
          NFT AMM contracts are being finalized and will be deployed soon. Explore the interface below. <Link to="/security" className="underline hover:text-amber-300 transition-colors">View security details</Link>
        </div>
      )}
      <AMMStatsBar poolCount={poolCount as bigint | undefined} />

      <HowItWorks
        storageKey="tegridy-amm-how"
        title="How does NFT AMM work?"
        steps={[
          { label: 'Create a Pool', description: 'Liquidity providers deposit NFTs and/or ETH into a pool and set a bonding curve (spot price + delta).' },
          { label: 'Traders Buy/Sell', description: 'Traders buy NFTs from the pool (price goes up by delta) or sell NFTs in (price goes down by delta).' },
          { label: 'Earn LP Fees', description: 'TRADE pools earn LP fees on every swap. BUY/SELL pools are single-sided.' },
          { label: 'Linear Pricing', description: 'Price changes by "delta" per trade. Predictable, transparent, no oracles needed.' },
        ]}
      />

      <TabNav active={activeTab} onChange={setActiveTab} />

      <AnimatePresence mode="wait">
        <m.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === 'trade' && <TradeTab deployed={deployed} />}
          {activeTab === 'create' && <CreatePoolTab deployed={deployed} />}
          {activeTab === 'pools' && <MyPoolsTab deployed={deployed} />}
        </m.div>
      </AnimatePresence>
    </div>
  );
}
