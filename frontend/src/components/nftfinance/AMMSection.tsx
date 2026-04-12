import { useState, useMemo, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  useAccount,
  useWriteContract,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
} from 'wagmi';
import { parseEther, formatEther } from 'viem';
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

// ─── Constants ────────────────────────────────────────────────────

const POOL_TYPE_LABELS = ['BUY', 'SELL', 'TRADE'] as const;
type PoolType = 0 | 1 | 2;

const POOL_TYPE_COLORS: Record<number, string> = {
  0: 'text-blue-400 border-blue-400/30 bg-blue-400/10',
  1: 'text-orange-400 border-orange-400/30 bg-orange-400/10',
  2: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10',
};

const POOL_TYPE_ACCENT: Record<number, string> = {
  0: 'border-blue-400/20 hover:border-blue-400/40',
  1: 'border-orange-400/20 hover:border-orange-400/40',
  2: 'border-emerald-400/20 hover:border-emerald-400/40',
};

const POOL_TYPE_BG_SELECTED: Record<number, string> = {
  0: 'bg-blue-500/20 border-blue-400 ring-1 ring-blue-400/30',
  1: 'bg-orange-500/20 border-orange-400 ring-1 ring-orange-400/30',
  2: 'bg-emerald-500/20 border-emerald-400 ring-1 ring-emerald-400/30',
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

type Tab = 'trade' | 'create' | 'pools';

const isValidAddress = (addr: string): addr is `0x${string}` =>
  /^0x[a-fA-F0-9]{40}$/.test(addr);

const cardClass =
  'rounded-2xl border border-[rgba(16,185,129,0.06)] hover:border-[rgba(16,185,129,0.15)] transition-all duration-300';
const cardBg = 'bg-[rgba(13,21,48,0.6)] backdrop-blur-[20px]';
const labelClass = 'text-[11px] uppercase tracking-wider text-white/40 font-medium';
const inputClass =
  'w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-white outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/20 transition-all duration-200 font-mono text-sm placeholder:text-white/20';
const btnPrimary =
  'w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 transition-all duration-300 text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-emerald-500/10';

// ─── Bonding Curve Chart ──────────────────────────────────────────

function BondingCurveChart({
  spotPrice,
  delta,
  numSteps = 10,
  height = 200,
}: {
  spotPrice: number;
  delta: number;
  numSteps?: number;
  height?: number;
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
      const y = scaleY(prices[i]);
      if (i === 0) {
        d += `M${x},${y}`;
      } else {
        const prevX = scaleX(i - 1);
        d += ` L${x},${scaleY(prices[i - 1])} L${x},${y}`;
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

  // Y-axis ticks
  const tickCount = 5;
  const ticks = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i <= tickCount; i++) {
      arr.push(minPrice + (range / tickCount) * i);
    }
    return arr;
  }, [minPrice, range, tickCount]);

  // Grid lines
  const gridLines = useMemo(() => {
    return ticks.map((t) => scaleY(t));
  }, [ticks]);

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
              {ticks[i] < 0.001 ? ticks[i].toExponential(1) : ticks[i].toFixed(3)}
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
          cy={scaleY(spotPrice)}
          r="5"
          fill="rgb(16,185,129)"
          stroke="rgba(6,12,26,0.8)"
          strokeWidth="2"
        />
        <circle
          cx={scaleX(0)}
          cy={scaleY(spotPrice)}
          r="8"
          fill="none"
          stroke="rgb(16,185,129)"
          strokeWidth="1"
          opacity="0.3"
        >
          <animate
            attributeName="r"
            values="8;12;8"
            dur="2s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.3;0.1;0.3"
            dur="2s"
            repeatCount="indefinite"
          />
        </circle>

        {/* Current price label */}
        <rect
          x={scaleX(0) - 32}
          y={scaleY(spotPrice) - 22}
          width="64"
          height="16"
          rx="4"
          fill="rgb(16,185,129)"
          opacity="0.15"
        />
        <text
          x={scaleX(0)}
          y={scaleY(spotPrice) - 11}
          textAnchor="middle"
          fill="rgb(16,185,129)"
          fontSize="9"
          fontWeight="600"
          fontFamily="monospace"
        >
          {spotPrice.toFixed(4)} ETH
        </text>

        {/* Legend */}
        <g transform={`translate(${chartWidth - padding.right - 100}, ${padding.top})`}>
          <line x1="0" y1="0" x2="14" y2="0" stroke="rgb(16,185,129)" strokeWidth="2" />
          <text x="18" y="3" fill="rgba(255,255,255,0.5)" fontSize="9">
            Buy Price
          </text>
          <line
            x1="0"
            y1="14"
            x2="14"
            y2="14"
            stroke="rgb(251,146,60)"
            strokeWidth="1.5"
            opacity="0.7"
          />
          <text x="18" y="17" fill="rgba(255,255,255,0.5)" fontSize="9">
            Sell Price
          </text>
        </g>

        {/* Axis lines */}
        <line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={height - padding.bottom}
          stroke="rgba(255,255,255,0.08)"
        />
        <line
          x1={padding.left}
          y1={height - padding.bottom}
          x2={chartWidth - padding.right}
          y2={height - padding.bottom}
          stroke="rgba(255,255,255,0.08)"
        />
      </svg>
    </div>
  );
}

// ─── Stats Bar ────────────────────────────────────────────────────

function StatsBar({ poolCount }: { poolCount: bigint | undefined }) {
  const stats = [
    { label: 'Total Pools', value: poolCount?.toString() ?? '0' },
    { label: 'Total Volume', value: '\u2014' },
    { label: 'Protocol Fee', value: '0.5%' },
  ];

  return (
    <div className="grid grid-cols-3 gap-3 sm:gap-4 mb-8">
      {stats.map((s) => (
        <div
          key={s.label}
          className={`${cardBg} ${cardClass} p-4 text-center`}
        >
          <p className={labelClass}>{s.label}</p>
          <p className="text-xl sm:text-2xl font-mono tabular-nums text-white mt-1 font-semibold">
            {s.value}
          </p>
        </div>
      ))}
    </div>
  );
}

// ─── Tab Navigation ───────────────────────────────────────────────

function TabNav({
  active,
  onChange,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'trade', label: 'Trade' },
    { id: 'create', label: 'Create Pool' },
    { id: 'pools', label: 'My Pools' },
  ];

  return (
    <div className="relative flex gap-1 mb-8 border-b border-white/[0.06]">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`relative px-5 py-3 text-sm font-medium transition-colors duration-200 ${
            active === t.id ? 'text-white' : 'text-white/40 hover:text-white/70'
          }`}
        >
          {t.label}
          {active === t.id && (
            <motion.div
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
        POOL_TYPE_COLORS[type] ?? POOL_TYPE_COLORS[2]
      }`}
    >
      {POOL_TYPE_LABELS[type] ?? 'UNKNOWN'}
    </span>
  );
}

// ─── Buy/Sell Panel ───────────────────────────────────────────────

function BuySellPanel() {
  const { address } = useAccount();
  const [mode, setMode] = useState<'buy' | 'sell'>('buy');
  const [collection, setCollection] = useState('');
  const [buyQty, setBuyQty] = useState(1);
  const [sellIds, setSellIds] = useState('');

  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const validCollection = isValidAddress(collection);

  // Best buy pool quote
  const { data: buyQuote } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getBestBuyPool',
    args: [collection as Address, BigInt(buyQty)],
    query: { enabled: validCollection && mode === 'buy' && buyQty > 0 },
  });

  // Best sell pool quote
  const parsedSellIds = useMemo(() => {
    if (!sellIds.trim()) return [];
    return sellIds
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => BigInt(s));
  }, [sellIds]);

  const { data: sellQuote } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getBestSellPool',
    args: [collection as Address, BigInt(parsedSellIds.length)],
    query: {
      enabled: validCollection && mode === 'sell' && parsedSellIds.length > 0,
    },
  });

  const bestPool =
    mode === 'buy'
      ? (buyQuote as [Address, bigint] | undefined)?.[0]
      : (sellQuote as [Address, bigint] | undefined)?.[0];
  const bestAmount =
    mode === 'buy'
      ? (buyQuote as [Address, bigint] | undefined)?.[1]
      : (sellQuote as [Address, bigint] | undefined)?.[1];

  // Get individual pool quote for fee breakdown
  const { data: detailedBuyQuote } = useReadContract({
    address: bestPool as Address,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getBuyQuote',
    args: [BigInt(buyQty)],
    query: { enabled: !!bestPool && mode === 'buy' && bestPool !== '0x0000000000000000000000000000000000000000' },
  });

  const { data: detailedSellQuote } = useReadContract({
    address: bestPool as Address,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getSellQuote',
    args: [BigInt(parsedSellIds.length)],
    query: { enabled: !!bestPool && mode === 'sell' && parsedSellIds.length > 0 && bestPool !== '0x0000000000000000000000000000000000000000' },
  });

  const protocolFee =
    mode === 'buy'
      ? (detailedBuyQuote as [bigint, bigint] | undefined)?.[1]
      : (detailedSellQuote as [bigint, bigint] | undefined)?.[1];

  // Get spot price for price impact
  const { data: currentSpotPrice } = useReadContract({
    address: bestPool as Address,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'spotPrice',
    query: { enabled: !!bestPool && bestPool !== '0x0000000000000000000000000000000000000000' },
  });

  const priceImpact = useMemo(() => {
    if (!bestAmount || !currentSpotPrice || currentSpotPrice === 0n) return null;
    const items = mode === 'buy' ? buyQty : parsedSellIds.length;
    if (items === 0) return null;
    const avgPrice = bestAmount / BigInt(items);
    const diff = Number(avgPrice) - Number(currentSpotPrice);
    return (diff / Number(currentSpotPrice)) * 100;
  }, [bestAmount, currentSpotPrice, mode, buyQty, parsedSellIds.length]);

  const handleExecute = () => {
    if (!bestPool || bestPool === '0x0000000000000000000000000000000000000000') {
      return toast.error('No pool found for this collection');
    }
    if (!address) return toast.error('Connect your wallet');

    try {
      if (mode === 'buy') {
        // Get held token IDs from pool, then swap
        writeContract(
          {
            address: bestPool as Address,
            abi: TEGRIDY_NFT_POOL_ABI,
            functionName: 'swapETHForNFTs',
            args: [[]],  // Empty array = buy any available
            value: bestAmount!,
          },
          {
            onSuccess: () => toast.success('NFTs purchased successfully!'),
            onError: (e: Error) =>
              toast.error(e.message?.slice(0, 100) || 'Transaction failed'),
          }
        );
      } else {
        const minOutput = (bestAmount! * 95n) / 100n; // 5% slippage
        writeContract(
          {
            address: bestPool as Address,
            abi: TEGRIDY_NFT_POOL_ABI,
            functionName: 'swapNFTsForETH',
            args: [parsedSellIds, minOutput],
          },
          {
            onSuccess: () => toast.success('NFTs sold successfully!'),
            onError: (e: Error) =>
              toast.error(e.message?.slice(0, 100) || 'Transaction failed'),
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
    }
  }, [isSuccess]);

  return (
    <div className={`${cardBg} ${cardClass} p-6`}>
      <h3 className="text-lg font-semibold text-white mb-5">
        Instant {mode === 'buy' ? 'Buy' : 'Sell'}
      </h3>

      {/* Buy/Sell Toggle */}
      <div className="flex rounded-xl bg-white/[0.03] p-1 mb-5">
        {(['buy', 'sell'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 ${
              mode === m
                ? m === 'buy'
                  ? 'bg-emerald-500/20 text-emerald-400 shadow-inner'
                  : 'bg-orange-500/20 text-orange-400 shadow-inner'
                : 'text-white/40 hover:text-white/60'
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
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors text-xs font-medium"
          >
            PASTE
          </button>
        </div>
      </div>

      {/* Buy: Quantity Selector */}
      {mode === 'buy' && (
        <div className="mb-5">
          <label className={`${labelClass} mb-2 block`}>Quantity</label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setBuyQty(Math.max(1, buyQty - 1))}
              className="w-11 h-11 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white/60 hover:text-white hover:border-white/20 transition-all text-lg font-medium flex items-center justify-center"
            >
              -
            </button>
            <div className="flex-1 text-center">
              <span className="text-2xl font-mono font-bold text-white tabular-nums">
                {buyQty}
              </span>
              <span className="text-white/30 text-sm ml-1">
                NFT{buyQty !== 1 ? 's' : ''}
              </span>
            </div>
            <button
              onClick={() => setBuyQty(Math.min(10, buyQty + 1))}
              className="w-11 h-11 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white/60 hover:text-white hover:border-white/20 transition-all text-lg font-medium flex items-center justify-center"
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
            Token IDs{' '}
            <span className="normal-case tracking-normal text-white/25">
              (comma-separated)
            </span>
          </label>
          <input
            type="text"
            value={sellIds}
            onChange={(e) => setSellIds(e.target.value)}
            placeholder="1, 42, 100"
            className={inputClass}
          />
          {parsedSellIds.length > 0 && (
            <p className="text-[10px] text-white/30 mt-1.5 font-mono">
              {parsedSellIds.length} token{parsedSellIds.length !== 1 ? 's' : ''}{' '}
              selected
            </p>
          )}
        </div>
      )}

      {/* Quote Card */}
      {validCollection && bestAmount && bestPool !== '0x0000000000000000000000000000000000000000' && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className={`rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 mb-5`}
        >
          <div className="flex items-center justify-between mb-3">
            <span className={labelClass}>Price Quote</span>
            <span className="text-[10px] font-mono text-white/25">
              Pool: {shortenAddress(bestPool)}
            </span>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-white/50">
                {mode === 'buy' ? 'Total Cost' : 'Payout'}
              </span>
              <span className="font-mono tabular-nums text-white font-semibold">
                {formatTokenAmount(formatEther(bestAmount), 6)} ETH
              </span>
            </div>
            {protocolFee !== undefined && (
              <div className="flex justify-between text-sm">
                <span className="text-white/50">Protocol Fee</span>
                <span className="font-mono tabular-nums text-white/60">
                  {formatTokenAmount(formatEther(protocolFee), 6)} ETH
                </span>
              </div>
            )}
            {priceImpact !== null && (
              <div className="flex justify-between text-sm">
                <span className="text-white/50">Price Impact</span>
                <span
                  className={`font-mono tabular-nums font-medium ${
                    Math.abs(priceImpact) > 5
                      ? 'text-red-400'
                      : Math.abs(priceImpact) > 2
                      ? 'text-orange-400'
                      : 'text-emerald-400'
                  }`}
                >
                  {priceImpact > 0 ? '+' : ''}
                  {priceImpact.toFixed(2)}%
                </span>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* Empty quote state */}
      {validCollection && (!bestAmount || bestPool === '0x0000000000000000000000000000000000000000') && (
        <div className="rounded-xl border border-white/[0.04] bg-white/[0.01] p-4 mb-5 text-center">
          <p className="text-sm text-white/30">No pools found for this collection</p>
        </div>
      )}

      {/* Execute */}
      <button
        className={btnPrimary}
        disabled={
          !address ||
          !validCollection ||
          !bestAmount ||
          bestPool === '0x0000000000000000000000000000000000000000' ||
          isConfirming ||
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
    </div>
  );
}

// ─── Pool Card ────────────────────────────────────────────────────

function PoolCard({
  poolAddress,
  isOwner,
}: {
  poolAddress: Address;
  isOwner?: boolean;
}) {
  const { address } = useAccount();
  const [expanded, setExpanded] = useState(false);
  const [liqNftIds, setLiqNftIds] = useState('');
  const [liqEth, setLiqEth] = useState('');

  const { data: poolInfo } = useReadContract({
    address: poolAddress,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getPoolInfo',
  });

  const { data: heldTokenIds } = useReadContract({
    address: poolAddress,
    abi: TEGRIDY_NFT_POOL_ABI,
    functionName: 'getHeldTokenIds',
  });

  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  if (!poolInfo) {
    return (
      <div
        className={`${cardBg} ${cardClass} p-4 animate-pulse`}
      >
        <div className="h-4 bg-white/5 rounded w-24 mb-3" />
        <div className="h-3 bg-white/5 rounded w-32" />
      </div>
    );
  }

  const [nftCollection, poolType, spotPrice, delta, feeBps, protocolFeeBps, owner, numNFTs, ethBalance] =
    poolInfo as [Address, number, bigint, bigint, bigint, bigint, Address, bigint, bigint];

  const poolOwnerIsUser = address && owner.toLowerCase() === address.toLowerCase();
  const showOwnerControls = isOwner || poolOwnerIsUser;

  const handleAddLiquidity = () => {
    try {
      const ids = liqNftIds.trim()
        ? liqNftIds.split(',').map((s) => BigInt(s.trim()))
        : [];
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
          onError: (e: Error) =>
            toast.error(e.message?.slice(0, 100) || 'Failed'),
        }
      );
    } catch {
      toast.error('Invalid input');
    }
  };

  return (
    <motion.div
      layout
      className={`${cardBg} ${cardClass} p-5 ${
        POOL_TYPE_ACCENT[poolType] ?? ''
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <PoolTypeBadge type={poolType} />
          <span className="text-[10px] font-mono text-white/25">
            {shortenAddress(poolAddress)}
          </span>
        </div>
        {showOwnerControls && (
          <span className="text-[9px] uppercase tracking-widest text-emerald-400/60 font-semibold">
            Owner
          </span>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-4">
        <div>
          <p className={labelClass}>Spot Price</p>
          <p className="text-sm font-mono tabular-nums text-white mt-0.5">
            {formatTokenAmount(formatEther(spotPrice), 4)} ETH
          </p>
        </div>
        <div>
          <p className={labelClass}>Delta</p>
          <p className="text-sm font-mono tabular-nums text-white/70 mt-0.5">
            {formatTokenAmount(formatEther(delta), 4)} ETH
          </p>
        </div>
        <div>
          <p className={labelClass}>NFTs Held</p>
          <p className="text-sm font-mono tabular-nums text-white mt-0.5">
            {numNFTs.toString()}
          </p>
        </div>
        <div>
          <p className={labelClass}>ETH Balance</p>
          <p className="text-sm font-mono tabular-nums text-white mt-0.5">
            {formatTokenAmount(formatEther(ethBalance), 4)}
          </p>
        </div>
        <div>
          <p className={labelClass}>LP Fee</p>
          <p className="text-sm font-mono tabular-nums text-white/70 mt-0.5">
            {(Number(feeBps) / 100).toFixed(2)}%
          </p>
        </div>
        <div>
          <p className={labelClass}>Collection</p>
          <p className="text-[11px] font-mono text-white/50 mt-0.5">
            {shortenAddress(nftCollection)}
          </p>
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
                className="px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.06] text-[10px] font-mono text-white/50"
              >
                #{id.toString()}
              </span>
            ))}
            {(heldTokenIds as bigint[]).length > 20 && (
              <span className="px-2 py-0.5 text-[10px] text-white/30">
                +{(heldTokenIds as bigint[]).length - 20} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Owner: Add Liquidity */}
      {showOwnerControls && (
        <>
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full text-left text-xs text-emerald-400/70 hover:text-emerald-400 transition-colors font-medium py-2 flex items-center gap-1.5"
          >
            <svg
              className={`w-3 h-3 transition-transform duration-200 ${
                expanded ? 'rotate-90' : ''
              }`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 5l7 7-7 7"
              />
            </svg>
            Add Liquidity
          </button>
          <AnimatePresence>
            {expanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="pt-3 space-y-3 border-t border-white/[0.04]">
                  <div>
                    <label className={`${labelClass} mb-1 block`}>
                      NFT Token IDs
                    </label>
                    <input
                      type="text"
                      value={liqNftIds}
                      onChange={(e) => setLiqNftIds(e.target.value)}
                      placeholder="1, 42, 100"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={`${labelClass} mb-1 block`}>
                      ETH Amount
                    </label>
                    <input
                      type="number"
                      value={liqEth}
                      onChange={(e) => setLiqEth(e.target.value)}
                      placeholder="0.0"
                      className={inputClass}
                    />
                  </div>
                  <button
                    className="w-full py-2.5 rounded-xl bg-emerald-600/80 hover:bg-emerald-600 transition-colors text-white text-sm font-medium disabled:opacity-40"
                    disabled={
                      isConfirming ||
                      (!liqNftIds.trim() && !liqEth)
                    }
                    onClick={handleAddLiquidity}
                  >
                    {isConfirming ? 'Adding...' : 'Add Liquidity'}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </motion.div>
  );
}

// ─── Pool Explorer ────────────────────────────────────────────────

function PoolExplorer() {
  const [searchAddr, setSearchAddr] = useState('');
  const validSearch = isValidAddress(searchAddr);

  const { data: pools } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getPoolsForCollection',
    args: [searchAddr as Address],
    query: { enabled: validSearch },
  });

  const poolList = (pools as Address[] | undefined) ?? [];

  return (
    <div className={`${cardBg} ${cardClass} p-6`}>
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
        <div className="text-center py-12">
          <div className="w-12 h-12 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-5 h-5 text-white/20"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
          </div>
          <p className="text-sm text-white/30">
            Enter a collection address to discover pools
          </p>
        </div>
      )}

      {validSearch && poolList.length === 0 && (
        <div className="text-center py-10">
          <p className="text-sm text-white/30">No pools found</p>
        </div>
      )}

      {validSearch && poolList.length > 0 && (
        <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-white/10">
          {poolList.map((addr) => (
            <PoolCard key={addr} poolAddress={addr} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Trade Tab ────────────────────────────────────────────────────

function TradeTab() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <BuySellPanel />
      <PoolExplorer />
    </div>
  );
}

// ─── Create Pool Tab ──────────────────────────────────────────────

function CreatePoolTab() {
  const { address } = useAccount();
  const [step, setStep] = useState(1);
  const [collection, setCollection] = useState('');
  const [poolType, setPoolType] = useState<PoolType>(2);
  const [spotPriceInput, setSpotPriceInput] = useState('0.1');
  const [deltaInput, setDeltaInput] = useState('0.01');
  const [ethDeposit, setEthDeposit] = useState('');
  const [nftIds, setNftIds] = useState('');
  const [feeBps, setFeeBps] = useState('200');

  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const spotNum = parseFloat(spotPriceInput) || 0;
  const deltaNum = parseFloat(deltaInput) || 0;

  const parsedNftIds = useMemo(() => {
    if (!nftIds.trim()) return [];
    return nftIds
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => BigInt(s));
  }, [nftIds]);

  const canProceed = useCallback(
    (s: number) => {
      if (s === 1) return isValidAddress(collection);
      if (s === 2) return spotNum > 0;
      if (s === 3) return true;
      return false;
    },
    [collection, spotNum]
  );

  const handleDeploy = () => {
    if (!address) return toast.error('Connect your wallet');
    if (!isValidAddress(collection)) return toast.error('Invalid collection address');

    try {
      writeContract(
        {
          address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
          abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
          functionName: 'createPool',
          args: [
            collection as Address,
            poolType,
            parseEther(spotPriceInput || '0'),
            parseEther(deltaInput || '0'),
            BigInt(feeBps || '0'),
            parsedNftIds,
          ],
          value: ethDeposit ? parseEther(ethDeposit) : 0n,
        },
        {
          onSuccess: () => {
            toast.success('Pool deployed successfully!');
            setStep(1);
            setCollection('');
            setNftIds('');
            setEthDeposit('');
          },
          onError: (e: Error) =>
            toast.error(e.message?.slice(0, 100) || 'Pool creation failed'),
        }
      );
    } catch {
      toast.error('Invalid input values');
    }
  };

  // Step indicator
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
            <div
              key={num}
              className="flex items-center gap-2 flex-1"
            >
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 flex-shrink-0 ${
                  isActive
                    ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30'
                    : isDone
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-white/[0.04] text-white/30 border border-white/[0.06]'
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
              <span
                className={`text-xs font-medium hidden sm:block ${
                  isActive ? 'text-white' : 'text-white/30'
                }`}
              >
                {label}
              </span>
              {i < stepLabels.length - 1 && (
                <div
                  className={`flex-1 h-px mx-2 ${
                    isDone ? 'bg-emerald-500/30' : 'bg-white/[0.06]'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step 1: Collection & Type */}
      <AnimatePresence mode="wait">
        {step === 1 && (
          <motion.div
            key="step1"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className={`${cardBg} ${cardClass} p-6`}
          >
            <h3 className="text-lg font-semibold text-white mb-6">
              Choose Collection & Pool Type
            </h3>

            <div className="mb-6">
              <label className={`${labelClass} mb-2 block`}>
                NFT Collection Address
              </label>
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
              <div className="grid grid-cols-3 gap-3">
                {([0, 1, 2] as PoolType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => setPoolType(type)}
                    className={`p-4 rounded-xl border text-left transition-all duration-200 ${
                      poolType === type
                        ? POOL_TYPE_BG_SELECTED[type]
                        : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.12]'
                    }`}
                  >
                    <svg
                      className={`w-5 h-5 mb-2 ${
                        poolType === type
                          ? type === 0
                            ? 'text-blue-400'
                            : type === 1
                            ? 'text-orange-400'
                            : 'text-emerald-400'
                          : 'text-white/30'
                      }`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d={POOL_TYPE_ICONS[type]}
                      />
                    </svg>
                    <p
                      className={`text-sm font-semibold mb-1 ${
                        poolType === type
                          ? type === 0
                            ? 'text-blue-400'
                            : type === 1
                            ? 'text-orange-400'
                            : 'text-emerald-400'
                          : 'text-white/60'
                      }`}
                    >
                      {POOL_TYPE_LABELS[type]}
                    </p>
                    <p className="text-[10px] text-white/30 leading-relaxed">
                      {POOL_TYPE_DESCRIPTIONS[type]}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            <button
              className={btnPrimary}
              disabled={!canProceed(1)}
              onClick={() => setStep(2)}
            >
              Continue
            </button>
          </motion.div>
        )}

        {/* Step 2: Pricing */}
        {step === 2 && (
          <motion.div
            key="step2"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className={`${cardBg} ${cardClass} p-6`}
          >
            <h3 className="text-lg font-semibold text-white mb-6">
              Configure Pricing
            </h3>

            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <label className={`${labelClass} mb-2 block`}>
                  Spot Price (ETH)
                </label>
                <input
                  type="number"
                  step="0.001"
                  value={spotPriceInput}
                  onChange={(e) => setSpotPriceInput(e.target.value)}
                  className={inputClass}
                />
                <p className="text-[10px] text-white/25 mt-1">
                  Starting price for the first trade
                </p>
              </div>
              <div>
                <label className={`${labelClass} mb-2 block`}>
                  Delta (ETH)
                </label>
                <input
                  type="number"
                  step="0.001"
                  value={deltaInput}
                  onChange={(e) => setDeltaInput(e.target.value)}
                  className={inputClass}
                />
                <p className="text-[10px] text-white/25 mt-1">
                  Price change per trade
                </p>
              </div>
            </div>

            {/* Bonding Curve Visualization */}
            <div className="mb-6">
              <label className={`${labelClass} mb-3 block`}>
                Bonding Curve Preview
              </label>
              <div className={`rounded-xl border border-white/[0.06] bg-[rgba(6,12,26,0.8)] p-4`}>
                <BondingCurveChart
                  spotPrice={spotNum}
                  delta={deltaNum}
                  numSteps={10}
                  height={220}
                />
                <div className="flex justify-between text-[10px] text-white/25 mt-2 px-1 font-mono">
                  <span>
                    1st buy: {(spotNum).toFixed(4)} ETH
                  </span>
                  <span>
                    10th buy: {(spotNum + deltaNum * 9).toFixed(4)} ETH
                  </span>
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                className="flex-1 py-3.5 rounded-xl bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.15] text-white/60 hover:text-white transition-all text-sm font-medium"
                onClick={() => setStep(1)}
              >
                Back
              </button>
              <button
                className={`flex-1 ${btnPrimary}`}
                disabled={!canProceed(2)}
                onClick={() => setStep(3)}
              >
                Continue
              </button>
            </div>
          </motion.div>
        )}

        {/* Step 3: Liquidity & Deploy */}
        {step === 3 && (
          <motion.div
            key="step3"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className={`${cardBg} ${cardClass} p-6`}
          >
            <h3 className="text-lg font-semibold text-white mb-6">
              Add Initial Liquidity
            </h3>

            <div className="space-y-4 mb-6">
              <div>
                <label className={`${labelClass} mb-2 block`}>
                  Initial ETH Deposit
                </label>
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
                  <span className="normal-case tracking-normal text-white/20">
                    (comma-separated)
                  </span>
                </label>
                <input
                  type="text"
                  value={nftIds}
                  onChange={(e) => setNftIds(e.target.value)}
                  placeholder="1, 42, 100"
                  className={inputClass}
                />
                <p className="text-[10px] text-white/25 mt-1">
                  Approve NFTs for the factory contract first
                </p>
              </div>

              {/* Fee input for TRADE pools */}
              {poolType === 2 && (
                <div>
                  <label className={`${labelClass} mb-2 block`}>
                    LP Fee (basis points)
                  </label>
                  <input
                    type="number"
                    value={feeBps}
                    onChange={(e) => setFeeBps(e.target.value)}
                    placeholder="200"
                    className={inputClass}
                  />
                  <p className="text-[10px] text-white/25 mt-1">
                    {(Number(feeBps) / 100).toFixed(2)}% fee on each trade
                    (TRADE pools only)
                  </p>
                </div>
              )}
            </div>

            {/* Summary Card */}
            <div className="rounded-xl border border-emerald-500/10 bg-emerald-500/[0.03] p-5 mb-6">
              <h4 className={`${labelClass} text-emerald-400/60 mb-4`}>
                Pool Summary
              </h4>
              <div className="space-y-2.5">
                <SummaryRow
                  label="Collection"
                  value={shortenAddress(collection)}
                />
                <SummaryRow
                  label="Pool Type"
                  value={POOL_TYPE_LABELS[poolType]}
                />
                <SummaryRow
                  label="Spot Price"
                  value={`${spotPriceInput} ETH`}
                />
                <SummaryRow label="Delta" value={`${deltaInput} ETH`} />
                {poolType === 2 && (
                  <SummaryRow
                    label="LP Fee"
                    value={`${(Number(feeBps) / 100).toFixed(2)}%`}
                  />
                )}
                <SummaryRow
                  label="Initial ETH"
                  value={ethDeposit ? `${ethDeposit} ETH` : 'None'}
                />
                <SummaryRow
                  label="Initial NFTs"
                  value={
                    parsedNftIds.length > 0
                      ? `${parsedNftIds.length} token${parsedNftIds.length !== 1 ? 's' : ''}`
                      : 'None'
                  }
                />
                <div className="border-t border-white/[0.04] pt-2.5 mt-2.5">
                  <SummaryRow
                    label="Est. 1st Buy"
                    value={`${spotNum.toFixed(4)} ETH`}
                    highlight
                  />
                  <SummaryRow
                    label="Est. 1st Sell"
                    value={`${Math.max(0, spotNum - deltaNum).toFixed(4)} ETH`}
                    highlight
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                className="flex-1 py-3.5 rounded-xl bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.15] text-white/60 hover:text-white transition-all text-sm font-medium"
                onClick={() => setStep(2)}
              >
                Back
              </button>
              <button
                className={`flex-1 ${btnPrimary}`}
                disabled={isConfirming || !address}
                onClick={handleDeploy}
              >
                {isConfirming
                  ? 'Deploying Pool...'
                  : !address
                  ? 'Connect Wallet'
                  : 'Deploy Pool'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-white/40">{label}</span>
      <span
        className={`font-mono tabular-nums ${
          highlight ? 'text-emerald-400 font-medium' : 'text-white/80'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

// ─── My Pools Tab ─────────────────────────────────────────────────

function MyPoolsTab() {
  const { address } = useAccount();
  const [expandedPool, setExpandedPool] = useState<string | null>(null);

  const { data: poolCount } = useReadContract({
    address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
    abi: TEGRIDY_NFT_POOL_FACTORY_ABI,
    functionName: 'getPoolCount',
  });

  if (!address) {
    return (
      <div className={`${cardBg} ${cardClass} p-10 text-center max-w-md mx-auto`}>
        <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mx-auto mb-5">
          <svg
            className="w-6 h-6 text-white/20"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"
            />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-white mb-2">
          Connect Your Wallet
        </h3>
        <p className="text-sm text-white/40">
          Connect your wallet to view and manage your liquidity pools.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Earnings Summary */}
      <div className={`${cardBg} ${cardClass} p-5 mb-6`}>
        <div className="flex items-center justify-between">
          <div>
            <p className={labelClass}>Your Pool Earnings</p>
            <p className="text-2xl font-mono tabular-nums text-white font-semibold mt-1">
              {'\u2014'}
            </p>
            <p className="text-[10px] text-white/25 mt-0.5">
              Cumulative LP fees (available after launch)
            </p>
          </div>
          <div className="text-right">
            <p className={labelClass}>Active Pools</p>
            <p className="text-2xl font-mono tabular-nums text-white font-semibold mt-1">
              {'\u2014'}
            </p>
          </div>
        </div>
      </div>

      {/* Pool Table Header */}
      <div className="hidden lg:grid grid-cols-7 gap-4 px-5 py-2 mb-2">
        {['Collection', 'Type', 'Spot Price', 'NFTs', 'ETH Balance', 'Fee', 'Actions'].map(
          (h) => (
            <p key={h} className={labelClass}>
              {h}
            </p>
          )
        )}
      </div>

      {/* Placeholder rows */}
      <div className="space-y-3">
        <div className={`${cardBg} ${cardClass} p-5`}>
          <div className="text-center py-8">
            <p className="text-sm text-white/30 mb-1">
              Pool ownership tracking available after deployment
            </p>
            <p className="text-[10px] text-white/20">
              Your pools will appear here with full management controls
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Coming Soon State ────────────────────────────────────────────

function ComingSoon() {
  const features = [
    {
      title: 'Linear Bonding Curves',
      desc: 'Predictable pricing with configurable spot price and delta parameters.',
    },
    {
      title: 'Buy / Sell / Trade Pools',
      desc: 'Create single-sided or two-sided liquidity pools for any NFT collection.',
    },
    {
      title: 'Instant NFT Liquidity',
      desc: 'Swap NFTs instantly without waiting for a buyer or seller.',
    },
    {
      title: 'LP Fee Earnings',
      desc: 'Earn fees on every trade through your liquidity pools.',
    },
  ];

  return (
    <div className="max-w-xl mx-auto">
      {/* Hero Card */}
      <div className="relative overflow-hidden rounded-2xl border border-emerald-500/10 bg-[rgba(13,21,48,0.6)] backdrop-blur-[20px] p-8 sm:p-10">
        {/* Glow */}
        <div className="absolute -top-20 -right-20 w-60 h-60 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-16 -left-16 w-48 h-48 bg-purple-500/5 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Coming Soon
          </div>

          <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">
            NFT AMM
          </h2>
          <p className="text-sm text-white/50 leading-relaxed mb-8 max-w-md">
            Create bonding-curve liquidity pools for any NFT collection.
            Automated market making with linear pricing, instant swaps, and
            protocol-level fee routing.
          </p>

          {/* Blurred Preview */}
          <div className="rounded-xl border border-white/[0.04] bg-white/[0.02] p-5 mb-8 relative overflow-hidden">
            <div className="blur-[2px] opacity-60 pointer-events-none select-none">
              <BondingCurveChart
                spotPrice={0.1}
                delta={0.005}
                numSteps={10}
                height={160}
              />
            </div>
            <div className="absolute inset-0 flex items-center justify-center bg-[rgba(6,12,26,0.3)]">
              <span className="text-sm font-medium text-white/60 bg-[rgba(13,21,48,0.8)] px-4 py-2 rounded-lg border border-white/[0.08]">
                Interactive bonding curve visualization
              </span>
            </div>
          </div>

          {/* Feature List */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {features.map((f) => (
              <div
                key={f.title}
                className="flex gap-3 items-start"
              >
                <div className="w-5 h-5 rounded-md bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg
                    className="w-3 h-3 text-emerald-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-white/80">
                    {f.title}
                  </p>
                  <p className="text-[11px] text-white/30 leading-relaxed mt-0.5">
                    {f.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
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
    query: { enabled: deployed },
  });

  // Coming Soon state when not deployed
  if (!deployed) {
    return <ComingSoon />;
  }

  return (
    <div>
      <StatsBar poolCount={poolCount as bigint | undefined} />
      <TabNav active={activeTab} onChange={setActiveTab} />

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === 'trade' && <TradeTab />}
          {activeTab === 'create' && <CreatePoolTab />}
          {activeTab === 'pools' && <MyPoolsTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
