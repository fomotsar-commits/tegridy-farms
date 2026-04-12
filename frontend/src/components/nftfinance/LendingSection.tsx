import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther, formatEther, type Address } from 'viem';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  TEGRIDY_LENDING_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  isDeployed,
} from '../../lib/constants';
import { TEGRIDY_LENDING_ABI, TEGRIDY_STAKING_ABI } from '../../lib/contracts';
import { formatTokenAmount, shortenAddress } from '../../lib/formatting';

// ─── Design tokens ──────────────────────────────────────────────
const CARD_BG = 'rgba(13, 21, 48, 0.6)';
const CARD_BORDER = 'rgba(16, 185, 129, 0.06)';
const CARD_BORDER_HOVER = 'rgba(16, 185, 129, 0.15)';
const ROW_BORDER = 'rgba(255, 255, 255, 0.04)';
const SHIMMER_BG =
  'linear-gradient(90deg, rgba(13,21,48,0.8) 25%, rgba(17,29,58,0.8) 50%, rgba(13,21,48,0.8) 75%)';
const EASE = [0.22, 1, 0.36, 1] as const;

// ─── Duration presets ───────────────────────────────────────────
const DURATION_PRESETS = [
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
  { label: '365d', days: 365 },
] as const;

// ─── Types ──────────────────────────────────────────────────────
type Tab = 'lend' | 'borrow' | 'myloans';
type LoanSubTab = 'borrower' | 'lender';
type SortKey = 'id' | 'principal' | 'apr' | 'duration' | 'minCollateral';
type SortDir = 'asc' | 'desc';

interface Offer {
  id: number;
  lender: string;
  principal: bigint;
  aprBps: bigint;
  duration: bigint;
  collateralContract: string;
  minPositionValue: bigint;
  active: boolean;
}

interface Loan {
  id: number;
  borrower: string;
  lender: string;
  offerId: bigint;
  tokenId: bigint;
  principal: bigint;
  aprBps: bigint;
  startTime: bigint;
  deadline: bigint;
  repaid: boolean;
  defaultClaimed: boolean;
}

type LoanStatus = 'active' | 'repaid' | 'overdue' | 'defaulted';

// ─── Helpers ────────────────────────────────────────────────────
function bpsToPercent(bps: bigint | number): string {
  const n = typeof bps === 'bigint' ? Number(bps) : bps;
  return (n / 100).toFixed(2);
}

function daysFromSeconds(s: bigint | number): number {
  return Math.ceil(Number(s) / 86400);
}

function getLoanStatus(loan: Loan): LoanStatus {
  if (loan.repaid) return 'repaid';
  if (loan.defaultClaimed) return 'defaulted';
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now > loan.deadline) return 'overdue';
  return 'active';
}

function useCountdown(deadline: bigint): string {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const iv = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(iv);
  }, []);
  const remaining = Number(deadline) - now;
  if (remaining <= 0) return '0d 0h 0m';
  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// ─── Skeleton Shimmer ───────────────────────────────────────────
function Shimmer({ className }: { className?: string }) {
  return (
    <div
      className={`rounded ${className ?? ''}`}
      style={{
        background: SHIMMER_BG,
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s ease-in-out infinite',
      }}
    />
  );
}

// ─── Skeleton Loading Layout ────────────────────────────────────
function SkeletonLayout() {
  return (
    <div className="space-y-6">
      <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      {/* Stats bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="rounded-xl p-4"
            style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
          >
            <Shimmer className="h-3 w-20 mb-3" />
            <Shimmer className="h-7 w-16" />
          </div>
        ))}
      </div>
      {/* Tabs */}
      <Shimmer className="h-10 w-64" />
      {/* Table rows */}
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <Shimmer key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

// ─── Status Badge ───────────────────────────────────────────────
const STATUS_COLORS: Record<LoanStatus, { bg: string; text: string; dot: string }> = {
  active: { bg: 'bg-blue-500/10', text: 'text-blue-400', dot: 'bg-blue-400' },
  repaid: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  overdue: { bg: 'bg-orange-500/10', text: 'text-orange-400', dot: 'bg-orange-400' },
  defaulted: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },
};

function StatusBadge({ status }: { status: LoanStatus }) {
  const c = STATUS_COLORS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${c.bg} ${c.text}`}>
      <span
        className={`w-1.5 h-1.5 rounded-full ${c.dot} ${status === 'active' ? 'animate-pulse' : ''}`}
      />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ─── Pulse Dot ──────────────────────────────────────────────────
function PulseDot({ color = 'bg-emerald-400' }: { color?: string }) {
  return (
    <span className="relative flex h-1.5 w-1.5">
      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color} opacity-75`} />
      <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${color}`} />
    </span>
  );
}

// ─── Glass Card ─────────────────────────────────────────────────
function GlassCard({
  children,
  className = '',
  hover = false,
}: {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={`rounded-xl backdrop-blur-[20px] transition-all duration-300 ${className}`}
      style={{
        background: CARD_BG,
        border: `1px solid ${hover ? CARD_BORDER_HOVER : CARD_BORDER}`,
        transitionTimingFunction: `cubic-bezier(${EASE.join(',')})`,
      }}
      onMouseEnter={(e) => {
        if (hover) (e.currentTarget.style.borderColor = CARD_BORDER_HOVER);
      }}
      onMouseLeave={(e) => {
        if (hover) (e.currentTarget.style.borderColor = CARD_BORDER);
      }}
    >
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// COMING SOON STATE
// ═══════════════════════════════════════════════════════════════════
function ComingSoonState() {
  const features = [
    'P2P fixed-term loans',
    'No oracles required',
    'Pro-rata interest',
    'NFT collateral',
  ];

  const mockOffers = [
    { id: 1, principal: '1.5000', apr: '8.50', duration: '30d', min: '2.0000', lender: '0x1a2b...9c0d' },
    { id: 2, principal: '5.0000', apr: '12.00', duration: '90d', min: '8.0000', lender: '0x3e4f...1a2b' },
    { id: 3, principal: '0.5000', apr: '6.25', duration: '14d', min: '0.8000', lender: '0x5c6d...3e4f' },
    { id: 4, principal: '10.0000', apr: '15.00', duration: '180d', min: '15.0000', lender: '0x7a8b...5c6d' },
  ];

  return (
    <div className="relative">
      {/* Blurred mockup */}
      <div className="filter blur-[2px] opacity-40 pointer-events-none select-none" aria-hidden="true">
        {/* Mock stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {['12', '3', '1.50', '24.5000'].map((val, i) => (
            <GlassCard key={i} className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1">
                {['Total Offers', 'Active Loans', 'Protocol Fee', 'TVL (ETH)'][i]}
              </div>
              <div className="font-mono text-xl text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {i === 2 ? `${val}%` : val}
              </div>
            </GlassCard>
          ))}
        </div>

        {/* Mock tabs */}
        <div className="flex gap-6 mb-6 border-b" style={{ borderColor: ROW_BORDER }}>
          {['Lend', 'Borrow', 'My Loans'].map((t, i) => (
            <div
              key={t}
              className={`pb-3 text-sm font-medium ${i === 1 ? 'text-emerald-400' : 'text-white/30'}`}
            >
              {t}
            </div>
          ))}
        </div>

        {/* Mock table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-white/40">
                <th className="py-2 pr-4 font-medium">Offer #</th>
                <th className="py-2 pr-4 font-medium">Principal</th>
                <th className="py-2 pr-4 font-medium">APR</th>
                <th className="py-2 pr-4 font-medium">Duration</th>
                <th className="py-2 pr-4 font-medium">Min Collateral</th>
                <th className="py-2 pr-4 font-medium">Lender</th>
              </tr>
            </thead>
            <tbody>
              {mockOffers.map((o) => (
                <tr key={o.id} style={{ borderTop: `1px solid ${ROW_BORDER}` }}>
                  <td className="py-3 pr-4 font-mono text-white/60">#{o.id}</td>
                  <td className="py-3 pr-4 font-mono text-white/60">{o.principal} ETH</td>
                  <td className="py-3 pr-4 font-mono text-emerald-400/60">{o.apr}%</td>
                  <td className="py-3 pr-4 text-white/60">{o.duration}</td>
                  <td className="py-3 pr-4 font-mono text-white/60">{o.min} ETH</td>
                  <td className="py-3 pr-4 font-mono text-white/40">{o.lender}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Overlay */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-center">
          <span className="inline-block px-3 py-1 rounded-full text-xs font-semibold tracking-wider uppercase bg-purple-500/20 text-purple-400 border border-purple-500/30 mb-4">
            Coming Soon
          </span>
          <h3 className="text-2xl font-bold text-white mb-2">NFT-Backed P2P Lending</h3>
          <p className="text-white/40 text-sm mb-6 max-w-md">
            Institutional-grade peer-to-peer lending using staked TOWELI positions as collateral.
          </p>
          <ul className="space-y-2 text-left inline-block">
            {features.map((f) => (
              <li key={f} className="flex items-center gap-2 text-sm text-white/60">
                <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {f}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STATS BAR
// ═══════════════════════════════════════════════════════════════════
function StatsBar() {
  const { data: offerCount } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'offerCount',
  });

  const { data: loanCount } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'loanCount',
  });

  const { data: protocolFeeBps } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'protocolFeeBps',
  });

  // We compute TVL client-side by iterating offers (simplified: just show offer count-based placeholder)
  // In production, this would use a subgraph or multicall for all active offer principals
  const stats = [
    {
      label: 'Total Offers',
      value: offerCount !== undefined ? Number(offerCount).toString() : '--',
    },
    {
      label: 'Active Loans',
      value: loanCount !== undefined ? Number(loanCount).toString() : '--',
    },
    {
      label: 'Protocol Fee',
      value: protocolFeeBps !== undefined ? `${bpsToPercent(protocolFeeBps)}%` : '--%',
    },
    {
      label: 'TVL (ETH)',
      value: '--', // requires multicall aggregation across all active offers
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {stats.map((s) => (
        <GlassCard key={s.label} className="p-4 group" hover>
          <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1">{s.label}</div>
          <div
            className="font-mono text-xl text-white group-hover:text-emerald-400 transition-colors duration-300"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {s.value}
          </div>
        </GlassCard>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════════════════════════════════
const TABS: { key: Tab; label: string }[] = [
  { key: 'lend', label: 'Lend' },
  { key: 'borrow', label: 'Borrow' },
  { key: 'myloans', label: 'My Loans' },
];

function TabNav({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div className="flex gap-6 border-b relative" style={{ borderColor: ROW_BORDER }}>
      {TABS.map((t) => (
        <button
          key={t.key}
          onClick={() => setTab(t.key)}
          className={`relative pb-3 text-sm font-medium transition-colors duration-300 ${
            tab === t.key ? 'text-emerald-400' : 'text-white/30 hover:text-white/60'
          }`}
          style={{ transitionTimingFunction: `cubic-bezier(${EASE.join(',')})` }}
        >
          {t.label}
          {tab === t.key && (
            <motion.div
              layoutId="lending-tab-indicator"
              className="absolute bottom-0 left-0 right-0 h-[2px] bg-emerald-400"
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            />
          )}
        </button>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LEND TAB (Create Offer)
// ═══════════════════════════════════════════════════════════════════
function LendTab() {
  const { address } = useAccount();
  const [principal, setPrincipal] = useState('');
  const [aprBps, setAprBps] = useState('');
  const [durationDays, setDurationDays] = useState(30);
  const [minCollateral, setMinCollateral] = useState('');

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isSuccess) {
      toast.success('Loan offer created successfully');
      setPrincipal('');
      setAprBps('');
      setMinCollateral('');
    }
  }, [isSuccess]);

  const aprPercent = aprBps ? (parseFloat(aprBps) / 100).toFixed(2) : '0.00';
  const estimatedEarnings = useMemo(() => {
    if (!principal || !aprBps || !durationDays) return '0.0000';
    const p = parseFloat(principal);
    const rate = parseFloat(aprBps) / 10000;
    const years = durationDays / 365;
    return formatTokenAmount(p * rate * years);
  }, [principal, aprBps, durationDays]);

  const handleCreate = useCallback(() => {
    if (!principal || !aprBps || !minCollateral) {
      toast.error('Fill all fields');
      return;
    }
    const principalWei = parseEther(principal);
    if (principalWei <= 0n) {
      toast.error('Principal must be greater than zero');
      return;
    }
    const aprBpsNum = parseInt(aprBps, 10);
    if (isNaN(aprBpsNum) || aprBpsNum <= 0 || aprBpsNum > 50000) {
      toast.error('APR must be between 0.01% and 500%');
      return;
    }
    writeContract({
      address: TEGRIDY_LENDING_ADDRESS as Address,
      abi: TEGRIDY_LENDING_ABI,
      functionName: 'createLoanOffer',
      args: [
        BigInt(aprBpsNum),
        BigInt(durationDays * 86400),
        TEGRIDY_STAKING_ADDRESS as Address,
        parseEther(minCollateral),
      ],
      value: principalWei,
    }, {
      onError: (err) => toast.error(err.message?.slice(0, 120) ?? 'Transaction failed'),
    });
  }, [principal, aprBps, durationDays, minCollateral, writeContract]);

  const loading = isPending || isConfirming;

  return (
    <div className="max-w-lg space-y-5 pt-4">
      {/* Principal */}
      <div>
        <label className="text-[11px] uppercase tracking-wider text-white/40 block mb-1.5">
          Principal (ETH)
        </label>
        <input
          type="number"
          inputMode="decimal"
          value={principal}
          onChange={(e) => setPrincipal(e.target.value)}
          placeholder="0.0"
          min="0"
          step="0.01"
          className="w-full bg-transparent font-mono text-[16px] text-white outline-none px-0 py-2.5 border-b border-white/10 focus:border-emerald-400/40 transition-colors duration-300"
        />
        {principal && parseFloat(principal) > 0 && (
          <div className="text-[11px] text-white/30 mt-1 font-mono">
            ~${formatTokenAmount(parseFloat(principal) * 3200, 2)} USD estimate
          </div>
        )}
      </div>

      {/* APR */}
      <div>
        <label className="text-[11px] uppercase tracking-wider text-white/40 block mb-1.5">
          APR (basis points)
        </label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            inputMode="numeric"
            value={aprBps}
            onChange={(e) => setAprBps(e.target.value)}
            placeholder="850"
            min="1"
            max="50000"
            step="1"
            className="flex-1 bg-transparent font-mono text-[16px] text-white outline-none px-0 py-2.5 border-b border-white/10 focus:border-emerald-400/40 transition-colors duration-300"
          />
          <span className="text-emerald-400 font-mono text-sm whitespace-nowrap">
            = {aprPercent}%
          </span>
        </div>
      </div>

      {/* Duration */}
      <div>
        <label className="text-[11px] uppercase tracking-wider text-white/40 block mb-1.5">
          Duration ({durationDays} days)
        </label>
        <div className="flex flex-wrap gap-2 mb-2">
          {DURATION_PRESETS.map((p) => (
            <button
              key={p.days}
              onClick={() => setDurationDays(p.days)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
                durationDays === p.days
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                  : 'bg-white/5 text-white/40 border border-white/10 hover:border-white/20 hover:text-white/60'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <input
          type="range"
          min={1}
          max={365}
          value={durationDays}
          onChange={(e) => setDurationDays(Number(e.target.value))}
          className="w-full accent-emerald-500 h-1"
        />
      </div>

      {/* Min Collateral */}
      <div>
        <label className="text-[11px] uppercase tracking-wider text-white/40 block mb-1.5">
          Min Collateral Value (ETH)
        </label>
        <input
          type="number"
          inputMode="decimal"
          value={minCollateral}
          onChange={(e) => setMinCollateral(e.target.value)}
          placeholder="0.0"
          min="0"
          step="0.01"
          className="w-full bg-transparent font-mono text-[16px] text-white outline-none px-0 py-2.5 border-b border-white/10 focus:border-emerald-400/40 transition-colors duration-300"
        />
      </div>

      {/* Interest preview */}
      <div
        className="rounded-lg px-4 py-3"
        style={{ background: 'rgba(16, 185, 129, 0.05)', border: `1px solid rgba(16, 185, 129, 0.1)` }}
      >
        <div className="text-[11px] uppercase tracking-wider text-white/40 mb-0.5">Estimated Earnings</div>
        <div className="font-mono text-emerald-400" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {estimatedEarnings} ETH
          <span className="text-white/30 text-sm ml-2">over {durationDays} days</span>
        </div>
      </div>

      {/* Submit */}
      {!address ? (
        <div className="text-white/40 text-sm text-center py-3">Connect wallet to create an offer</div>
      ) : (
        <button
          onClick={handleCreate}
          disabled={loading || !principal || !aprBps || !minCollateral}
          className="w-full py-3 rounded-xl font-semibold text-sm transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed bg-emerald-500 hover:bg-emerald-400 text-black"
          style={{ transitionTimingFunction: `cubic-bezier(${EASE.join(',')})` }}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {isPending ? 'Confirm in Wallet...' : 'Confirming...'}
            </span>
          ) : (
            'Create Loan Offer'
          )}
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// BORROW TAB (Available Offers)
// ═══════════════════════════════════════════════════════════════════
function OfferRow({
  offer,
  userAddress,
}: {
  offer: Offer;
  userAddress?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  // User's staking position
  const { data: userTokenId } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS as Address,
    abi: TEGRIDY_STAKING_ABI,
    functionName: 'userTokenId',
    args: userAddress ? [userAddress as Address] : undefined,
    query: { enabled: !!userAddress },
  });

  const tokenId = userTokenId ? Number(userTokenId) : 0;

  const { data: position } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS as Address,
    abi: TEGRIDY_STAKING_ABI,
    functionName: 'getPosition',
    args: tokenId > 0 ? [BigInt(tokenId)] : undefined,
    query: { enabled: tokenId > 0 },
  });

  // Check approval
  const { data: approved } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS as Address,
    abi: TEGRIDY_STAKING_ABI,
    functionName: 'getApproved',
    args: tokenId > 0 ? [BigInt(tokenId)] : undefined,
    query: { enabled: tokenId > 0 },
  });

  const isApproved =
    approved && (approved as string).toLowerCase() === TEGRIDY_LENDING_ADDRESS.toLowerCase();

  // Approve
  const { writeContract: approveWrite, data: approveTx, isPending: approvePending } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({
    hash: approveTx,
  });

  // Accept
  const { writeContract: acceptWrite, data: acceptTx, isPending: acceptPending } = useWriteContract();
  const { isLoading: acceptConfirming, isSuccess: acceptSuccess } = useWaitForTransactionReceipt({
    hash: acceptTx,
  });

  useEffect(() => {
    if (approveSuccess) toast.success('NFT approved for lending');
  }, [approveSuccess]);

  useEffect(() => {
    if (acceptSuccess) {
      toast.success('Loan accepted! Funds received.');
      setExpanded(false);
    }
  }, [acceptSuccess]);

  const handleApprove = () => {
    approveWrite({
      address: TEGRIDY_STAKING_ADDRESS as Address,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'approve',
      args: [TEGRIDY_LENDING_ADDRESS as Address, BigInt(tokenId)],
    }, {
      onError: (err) => toast.error(err.message?.slice(0, 120) ?? 'Approval failed'),
    });
  };

  const handleAccept = () => {
    acceptWrite({
      address: TEGRIDY_LENDING_ADDRESS as Address,
      abi: TEGRIDY_LENDING_ABI,
      functionName: 'acceptOffer',
      args: [BigInt(offer.id), BigInt(tokenId)],
    }, {
      onError: (err) => toast.error(err.message?.slice(0, 120) ?? 'Accept failed'),
    });
  };

  const positionAmount = position ? formatEther((position as readonly bigint[])[0]) : '0';

  return (
    <>
      <tr
        className="cursor-pointer hover:bg-white/[0.02] transition-colors duration-200"
        style={{ borderTop: `1px solid ${ROW_BORDER}` }}
        onClick={() => setExpanded(!expanded)}
      >
        <td className="py-3 pr-4 font-mono text-white/60 text-sm">#{offer.id}</td>
        <td className="py-3 pr-4 font-mono text-white text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatTokenAmount(formatEther(offer.principal))} ETH
        </td>
        <td className="py-3 pr-4 font-mono text-emerald-400 text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {bpsToPercent(offer.aprBps)}%
        </td>
        <td className="py-3 pr-4 text-white/60 text-sm">{daysFromSeconds(offer.duration)}d</td>
        <td className="py-3 pr-4 font-mono text-white/60 text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatTokenAmount(formatEther(offer.minPositionValue))} ETH
        </td>
        <td className="py-3 pr-4 font-mono text-white/40 text-sm">{shortenAddress(offer.lender)}</td>
        <td className="py-3 text-sm">
          <svg
            className={`w-4 h-4 text-white/30 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </td>
      </tr>
      <AnimatePresence>
        {expanded && (
          <tr>
            <td colSpan={7} className="p-0">
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25, ease: EASE as unknown as number[] }}
                className="overflow-hidden"
              >
                <div
                  className="px-4 py-4 mx-2 mb-2 rounded-lg"
                  style={{ background: 'rgba(13, 21, 48, 0.8)', border: `1px solid ${CARD_BORDER}` }}
                >
                  {!userAddress ? (
                    <p className="text-white/40 text-sm">Connect wallet to borrow</p>
                  ) : tokenId === 0 ? (
                    <div className="flex items-center gap-2 text-orange-400 text-sm">
                      <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Stake TOWELI first to borrow. You need a staking position NFT as collateral.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                        <div>
                          <span className="text-[11px] uppercase tracking-wider text-white/40">Your Position</span>
                          <div className="font-mono text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            Token #{tokenId} — {formatTokenAmount(positionAmount)} TOWELI
                          </div>
                        </div>
                        <div>
                          <span className="text-[11px] uppercase tracking-wider text-white/40">Loan Amount</span>
                          <div className="font-mono text-emerald-400" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {formatTokenAmount(formatEther(offer.principal))} ETH
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {!isApproved ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleApprove(); }}
                            disabled={approvePending || approveConfirming}
                            className="px-4 py-2 rounded-lg text-sm font-medium bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30 transition-colors duration-200 disabled:opacity-40"
                          >
                            {approvePending || approveConfirming ? 'Approving...' : '1. Approve NFT'}
                          </button>
                        ) : (
                          <span className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            Approved
                          </span>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); handleAccept(); }}
                          disabled={!isApproved || acceptPending || acceptConfirming}
                          className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500 text-black hover:bg-emerald-400 transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {acceptPending || acceptConfirming ? 'Accepting...' : '2. Accept Offer'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            </td>
          </tr>
        )}
      </AnimatePresence>
    </>
  );
}

function BorrowTab() {
  const { address } = useAccount();
  const [sortKey, setSortKey] = useState<SortKey>('id');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Get offer count
  const { data: offerCount } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'offerCount',
  });

  const count = offerCount ? Number(offerCount) : 0;

  // Fetch individual offers — limited to most recent 50 for performance
  const offerIds = useMemo(() => {
    const ids: number[] = [];
    const start = Math.max(0, count - 50);
    for (let i = start; i < count; i++) ids.push(i);
    return ids;
  }, [count]);

  // We batch-read offers manually by calling getOffer for each
  // In production use a multicall — here we read sequentially via individual hooks
  // Using a simplified approach: read a few offers
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loadingOffers, setLoadingOffers] = useState(false);

  // Use individual reads for first N offers via a polling pattern
  const { data: offer0 } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'getOffer',
    args: [0n],
    query: { enabled: count > 0 },
  });

  // Build offers array from on-chain reads
  // For a production version this would use multicall or a subgraph
  useEffect(() => {
    if (count === 0) {
      setOffers([]);
      return;
    }
    // Basic single-offer loading for demonstration
    // Real implementation: iterate with multicall
    if (offer0) {
      const o = offer0 as readonly [string, bigint, bigint, bigint, string, bigint, boolean];
      if (o[6]) {
        // active
        setOffers([
          {
            id: 0,
            lender: o[0],
            principal: o[1],
            aprBps: o[2],
            duration: o[3],
            collateralContract: o[4],
            minPositionValue: o[5],
            active: o[6],
          },
        ]);
      }
    }
  }, [offer0, count]);

  const sortedOffers = useMemo(() => {
    const sorted = [...offers];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'id':
          cmp = a.id - b.id;
          break;
        case 'principal':
          cmp = Number(a.principal - b.principal);
          break;
        case 'apr':
          cmp = Number(a.aprBps - b.aprBps);
          break;
        case 'duration':
          cmp = Number(a.duration - b.duration);
          break;
        case 'minCollateral':
          cmp = Number(a.minPositionValue - b.minPositionValue);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [offers, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const SortHeader = ({ label, sk }: { label: string; sk: SortKey }) => (
    <th
      className="py-2 pr-4 font-medium cursor-pointer select-none hover:text-white/60 transition-colors"
      onClick={() => handleSort(sk)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === sk && (
          <svg
            className={`w-3 h-3 transition-transform ${sortDir === 'asc' ? '' : 'rotate-180'}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        )}
      </span>
    </th>
  );

  return (
    <div className="pt-4">
      {sortedOffers.length === 0 && count === 0 ? (
        <div className="text-center py-12 text-white/30 text-sm">
          No loan offers available yet. Be the first to create one.
        </div>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-left text-[11px] uppercase tracking-wider text-white/40">
            <thead>
              <tr>
                <SortHeader label="Offer #" sk="id" />
                <SortHeader label="Principal" sk="principal" />
                <SortHeader label="APR" sk="apr" />
                <SortHeader label="Duration" sk="duration" />
                <SortHeader label="Min Collateral" sk="minCollateral" />
                <th className="py-2 pr-4 font-medium">Lender</th>
                <th className="py-2 font-medium w-8" />
              </tr>
            </thead>
            <tbody>
              {sortedOffers.map((offer) => (
                <OfferRow key={offer.id} offer={offer} userAddress={address} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MY LOANS TAB
// ═══════════════════════════════════════════════════════════════════
function LoanRow({
  loan,
  role,
}: {
  loan: Loan;
  role: 'borrower' | 'lender';
}) {
  const status = getLoanStatus(loan);
  const countdown = useCountdown(loan.deadline);

  // Repayment amount
  const { data: repaymentAmount } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'getRepaymentAmount',
    args: [BigInt(loan.id)],
    query: { enabled: status === 'active' || status === 'overdue' },
  });

  // Check defaulted
  const { data: defaulted } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'isDefaulted',
    args: [BigInt(loan.id)],
    query: { enabled: status === 'overdue' },
  });

  // Repay
  const { writeContract: repayWrite, data: repayTx, isPending: repayPending } = useWriteContract();
  const { isLoading: repayConfirming, isSuccess: repaySuccess } = useWaitForTransactionReceipt({ hash: repayTx });

  // Claim collateral
  const { writeContract: claimWrite, data: claimTx, isPending: claimPending } = useWriteContract();
  const { isLoading: claimConfirming, isSuccess: claimSuccess } = useWaitForTransactionReceipt({ hash: claimTx });

  useEffect(() => {
    if (repaySuccess) toast.success('Loan repaid successfully');
  }, [repaySuccess]);

  useEffect(() => {
    if (claimSuccess) toast.success('Collateral claimed');
  }, [claimSuccess]);

  const handleRepay = () => {
    if (!repaymentAmount) return;
    repayWrite({
      address: TEGRIDY_LENDING_ADDRESS as Address,
      abi: TEGRIDY_LENDING_ABI,
      functionName: 'repayLoan',
      args: [BigInt(loan.id)],
      value: repaymentAmount as bigint,
    }, {
      onError: (err) => toast.error(err.message?.slice(0, 120) ?? 'Repay failed'),
    });
  };

  const handleClaim = () => {
    claimWrite({
      address: TEGRIDY_LENDING_ADDRESS as Address,
      abi: TEGRIDY_LENDING_ABI,
      functionName: 'claimDefaultedCollateral',
      args: [BigInt(loan.id)],
    }, {
      onError: (err) => toast.error(err.message?.slice(0, 120) ?? 'Claim failed'),
    });
  };

  const repayLoading = repayPending || repayConfirming;
  const claimLoading = claimPending || claimConfirming;

  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 px-1"
      style={{ borderBottom: `1px solid ${ROW_BORDER}` }}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <StatusBadge status={status} />
        <span className="font-mono text-sm text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatTokenAmount(formatEther(loan.principal))} ETH
        </span>
        <span className="font-mono text-sm text-emerald-400" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {bpsToPercent(loan.aprBps)}%
        </span>
        <span className="text-sm text-white/40">NFT #{Number(loan.tokenId)}</span>
        {(status === 'active' || status === 'overdue') && (
          <span
            className={`font-mono text-sm ${status === 'overdue' ? 'text-orange-400' : 'text-white/50'}`}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {countdown}
          </span>
        )}
        {repaymentAmount && (status === 'active' || status === 'overdue') && (
          <span className="text-[11px] text-white/30 font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
            Repay: {formatTokenAmount(formatEther(repaymentAmount as bigint))} ETH
          </span>
        )}
      </div>

      <div className="flex gap-2 flex-shrink-0">
        {role === 'borrower' && (status === 'active' || status === 'overdue') && (
          <button
            onClick={handleRepay}
            disabled={repayLoading}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors disabled:opacity-40"
          >
            {repayLoading ? 'Repaying...' : 'Repay'}
          </button>
        )}
        {role === 'lender' && (defaulted || status === 'overdue') && !loan.defaultClaimed && (
          <button
            onClick={handleClaim}
            disabled={claimLoading}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors disabled:opacity-40"
          >
            {claimLoading ? 'Claiming...' : 'Claim Collateral'}
          </button>
        )}
      </div>
    </div>
  );
}

function MyLoansTab() {
  const { address } = useAccount();
  const [subTab, setSubTab] = useState<LoanSubTab>('borrower');

  // Get loan count
  const { data: loanCount } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'loanCount',
  });

  const count = loanCount ? Number(loanCount) : 0;

  // Read first loan as a minimal example
  // Production: multicall or subgraph for all user loans
  const { data: loan0 } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'getLoan',
    args: [0n],
    query: { enabled: count > 0 },
  });

  const allLoans = useMemo<Loan[]>(() => {
    if (!loan0) return [];
    const l = loan0 as readonly [string, string, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean];
    return [
      {
        id: 0,
        borrower: l[0],
        lender: l[1],
        offerId: l[2],
        tokenId: l[3],
        principal: l[4],
        aprBps: l[5],
        startTime: l[6],
        deadline: l[7],
        repaid: l[8],
        defaultClaimed: l[9],
      },
    ];
  }, [loan0]);

  const myBorrowed = useMemo(
    () => allLoans.filter((l) => l.borrower.toLowerCase() === address?.toLowerCase()),
    [allLoans, address],
  );

  const myLent = useMemo(
    () => allLoans.filter((l) => l.lender.toLowerCase() === address?.toLowerCase()),
    [allLoans, address],
  );

  const displayed = subTab === 'borrower' ? myBorrowed : myLent;

  if (!address) {
    return (
      <div className="text-center py-12 text-white/30 text-sm pt-4">
        Connect wallet to view your loans
      </div>
    );
  }

  return (
    <div className="pt-4">
      {/* Sub-tabs */}
      <div className="flex gap-4 mb-4">
        {(['borrower', 'lender'] as const).map((st) => (
          <button
            key={st}
            onClick={() => setSubTab(st)}
            className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-all duration-200 ${
              subTab === st
                ? 'bg-white/10 text-white'
                : 'text-white/30 hover:text-white/60 hover:bg-white/5'
            }`}
          >
            As {st === 'borrower' ? 'Borrower' : 'Lender'}
            <span className="ml-1.5 text-[11px] font-mono text-white/30">
              ({st === 'borrower' ? myBorrowed.length : myLent.length})
            </span>
          </button>
        ))}
      </div>

      {displayed.length === 0 ? (
        <div className="text-center py-12 text-white/30 text-sm">
          {subTab === 'borrower'
            ? 'You have no active borrows.'
            : 'You have no active loans as a lender.'}
        </div>
      ) : (
        <div>
          {displayed.map((loan) => (
            <LoanRow key={loan.id} loan={loan} role={subTab} />
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════
export function LendingSection({ address: propAddress }: { address?: string }) {
  const [tab, setTab] = useState<Tab>('lend');
  const [ready, setReady] = useState(false);
  const deployed = isDeployed(TEGRIDY_LENDING_ADDRESS);

  // Simulate initial load
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 600);
    return () => clearTimeout(t);
  }, []);

  if (!ready) {
    return (
      <section className="w-full">
        <SkeletonLayout />
      </section>
    );
  }

  if (!deployed) {
    return (
      <section className="w-full">
        <ComingSoonState />
      </section>
    );
  }

  return (
    <section className="w-full space-y-6">
      <StatsBar />
      <TabNav tab={tab} setTab={setTab} />
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: EASE as unknown as number[] }}
        >
          {tab === 'lend' && <LendTab />}
          {tab === 'borrow' && <BorrowTab />}
          {tab === 'myloans' && <MyLoansTab />}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
