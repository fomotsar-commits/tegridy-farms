import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
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
import { ART } from '../../lib/artConfig';
import { useTOWELIPrice } from '../../contexts/PriceContext';
import { InfoTooltip, HowItWorks, StepIndicator, RiskBanner, TxSummary } from '../ui/InfoTooltip';

// ─── Design tokens ──────────────────────────────────────────────
const CARD_BG = 'rgba(13, 21, 48, 0.6)';
const CARD_BORDER = 'rgba(139, 92, 246, 0.12)';
/** @internal Reserved for future styling */
export const CARD_BORDER_HOVER = 'rgba(139, 92, 246, 0.25)';
const ROW_BORDER = 'rgba(255, 255, 255, 0.04)';
const DARK_OVERLAY = 'none';
const DARK_OVERLAY_HEAVY = 'none';
const SHIMMER_BG =
  'linear-gradient(90deg, rgba(13,21,48,0.8) 25%, rgba(17,29,58,0.8) 50%, rgba(13,21,48,0.8) 75%)';
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// ─── Duration presets ───────────────────────────────────────────
const DURATION_PRESETS = [
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
  { label: '365d', days: 365 },
] as const;

// ─── Filter types ───────────────────────────────────────────────
type AprFilter = 'all' | 'low' | 'med' | 'high';
type DurationFilter = 'all' | 'short' | 'medium' | 'long';
type PrincipalFilter = 'all' | 'small' | 'medium' | 'large';

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

function useCountdown(deadline: bigint): { text: string; isUrgent: boolean; isExpired: boolean } {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const iv = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(iv);
  }, []);
  const remaining = Number(deadline) - now;
  if (remaining <= 0) return { text: 'Expired', isUrgent: true, isExpired: true };
  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const isUrgent = remaining < 86400;
  return { text: `${d}d:${String(h).padStart(2, '0')}h:${String(m).padStart(2, '0')}m`, isUrgent, isExpired: false };
}

function computeLTV(principal: bigint, positionValueEth: string): { ratio: number; color: string } {
  const pv = parseFloat(positionValueEth);
  if (pv <= 0) return { ratio: 0, color: 'text-white' };
  const principalEth = parseFloat(formatEther(principal));
  const ratio = (principalEth / pv) * 100;
  if (ratio < 50) return { ratio, color: 'text-black' };
  if (ratio < 75) return { ratio, color: 'text-yellow-400' };
  return { ratio, color: 'text-red-400' };
}

// ─── Art Background Panel ───────────────────────────────────────
function ArtPanel({
  artSrc,
  opacity = 0.12,
  overlay = DARK_OVERLAY,
  children,
  className = '',
  style = {},
}: {
  artSrc: string;
  opacity?: number;
  overlay?: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl glass-card-animated ${className}`}
      style={{ border: `1px solid ${CARD_BORDER}`, ...style }}
    >
      <div className="absolute inset-0">
        <img src={artSrc} alt="" loading="lazy" className="w-full h-full object-cover" style={{ opacity }} />
        <div className="absolute inset-0" style={{ background: overlay }} />
      </div>
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
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

/** @internal Reserved for loading state */
export function SkeletonLayout() {
  return (
    <div className="space-y-6">
      <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
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
      <Shimmer className="h-10 w-64" />
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
  repaid: { bg: 'bg-emerald-500/30', text: 'text-black', dot: 'bg-emerald-400' },
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
/** @internal Reserved for future use */
export function LendingPulseDot({ color = 'bg-emerald-400' }: { color?: string }) {
  return (
    <span className="relative flex h-1.5 w-1.5">
      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color} opacity-75`} />
      <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${color}`} />
    </span>
  );
}

// ─── Disabled Tooltip Wrapper ───────────────────────────────────
function DisabledWrap({
  deployed,
  children,
}: {
  deployed: boolean;
  children: React.ReactNode;
}) {
  if (deployed) return <>{children}</>;
  return (
    <div className="relative group/disabled">
      <div className="pointer-events-none opacity-40">{children}</div>
      <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap px-2 py-1 rounded bg-black/90 text-[10px] text-amber-400 border border-amber-500/20 opacity-0 group-hover/disabled:opacity-100 transition-opacity pointer-events-none z-20">
        Contract not deployed yet
      </div>
    </div>
  );
}

// ─── Empty State ────────────────────────────────────────────────
function EmptyState({
  artSrc,
  title,
  subtitle,
}: {
  artSrc: string;
  title: string;
  subtitle: string;
}) {
  return (
    <ArtPanel artSrc={artSrc} opacity={1} overlay="none">
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
        <div className="w-10 h-10 rounded-full bg-purple-500/40 flex items-center justify-center mb-4">
          <svg className="w-5 h-5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
        </div>
        <h4 className="text-white font-semibold text-sm mb-1">{title}</h4>
        <p className="text-white text-xs max-w-xs">{subtitle}</p>
      </div>
    </ArtPanel>
  );
}

// ─── Filter Pill ────────────────────────────────────────────────
function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-[11px] font-medium transition-all duration-200 ${
        active
          ? 'bg-purple-500/50 text-black border border-purple-500/40'
          : 'bg-black/60 text-white border border-white/25 hover:border-white/20 hover:text-white'
      }`}
      style={{ transitionTimingFunction: `cubic-bezier(${EASE.join(',')})` }}
    >
      {label}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════
// COMING SOON STATE
// ═══════════════════════════════════════════════════════════════════
/** @internal Reserved for future use */
export function ComingSoonState() {
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
      <div className="filter blur-[2px] opacity-40 pointer-events-none select-none" aria-hidden="true">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {['12', '3', '1.50', '24.5000'].map((val, i) => (
            <ArtPanel key={i} artSrc={ART.forestScene.src} opacity={1}>
              <div className="p-4">
                <div className="text-[11px] uppercase tracking-wider label-pill text-white mb-1">
                  {['Total Offers', 'Active Loans', 'Protocol Fee', 'TVL (ETH)'][i] ?? ''}
                </div>
                <div className="font-mono text-xl text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {i === 2 ? `${val}%` : val}
                </div>
              </div>
            </ArtPanel>
          ))}
        </div>

        <div className="flex gap-6 mb-6 border-b" style={{ borderColor: ROW_BORDER }}>
          {['Lend', 'Borrow', 'My Loans'].map((t, i) => (
            <div
              key={t}
              className={`pb-3 text-sm font-medium ${i === 1 ? 'text-black' : 'text-white'}`}
            >
              {t}
            </div>
          ))}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider label-pill text-white">
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
                  <td className="py-3 pr-4 font-mono text-white">#{o.id}</td>
                  <td className="py-3 pr-4 font-mono text-white">{o.principal} ETH</td>
                  <td className="py-3 pr-4 font-mono text-black/60">{o.apr}%</td>
                  <td className="py-3 pr-4 text-white">{o.duration}</td>
                  <td className="py-3 pr-4 font-mono text-white">{o.min} ETH</td>
                  <td className="py-3 pr-4 font-mono text-white">{o.lender}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-center">
          <span className="inline-block px-3 py-1 rounded-full text-xs font-semibold tracking-wider uppercase bg-purple-500/50 text-black border border-purple-500/30 mb-4">
            Coming Soon
          </span>
          <h3 className="text-2xl font-bold text-white mb-2">NFT-Backed P2P Lending</h3>
          <p className="text-white text-sm mb-6 max-w-md">
            Institutional-grade peer-to-peer lending using staked TOWELI positions as collateral.
          </p>
          <ul className="space-y-2 text-left inline-block">
            {features.map((f) => (
              <li key={f} className="flex items-center gap-2 text-sm text-white">
                <svg className="w-4 h-4 text-black flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
function StatsBar({ allOffers, allLoans }: { allOffers: Offer[]; allLoans: Loan[] }) {
  const offerCountNum = allOffers.length;
  const activeLoansCount = allLoans.filter((l) => {
    const s = getLoanStatus(l);
    return s === 'active' || s === 'overdue';
  }).length;

  const { data: protocolFeeBps } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'protocolFeeBps',
  });

  // TVL = sum of principal from active offers + outstanding loan principal
  const tvl = useMemo(() => {
    let total = 0n;
    for (const o of allOffers) {
      if (o.active) total += o.principal;
    }
    for (const l of allLoans) {
      const s = getLoanStatus(l);
      if (s === 'active' || s === 'overdue') total += l.principal;
    }
    return total;
  }, [allOffers, allLoans]);

  const stats = [
    {
      label: 'Total Offers',
      value: offerCountNum.toString(),
      tooltip: 'Number of active loan offers available for borrowers to accept',
      icon: (
        <svg className="w-4 h-4 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      ),
    },
    {
      label: 'Active Loans',
      value: activeLoansCount.toString(),
      tooltip: 'Loans currently outstanding — borrowers have received ETH and must repay before their deadline',
      icon: (
        <svg className="w-4 h-4 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
        </svg>
      ),
    },
    {
      label: 'Protocol Fee',
      value: protocolFeeBps !== undefined ? `${bpsToPercent(protocolFeeBps as bigint)}%` : '--%',
      tooltip: 'Percentage fee taken from interest earned by lenders. Paid to the protocol treasury.',
      icon: (
        <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
    },
    {
      label: 'TVL (ETH)',
      value: formatTokenAmount(formatEther(tvl)),
      tooltip: 'Total Value Locked — sum of ETH in active offers plus outstanding loan principal',
      icon: (
        <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
      {stats.map((s, idx) => (
        <motion.div
          key={s.label}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: idx * 0.08, ease: EASE as [number, number, number, number] }}
        >
          <ArtPanel artSrc={ART.forestScene.src} opacity={1} overlay={DARK_OVERLAY} className="group hover:scale-[1.02] transition-transform duration-300" style={{ transitionTimingFunction: `cubic-bezier(${EASE.join(',')})` }}>
            <div className="p-4">
              <div className="flex items-center gap-2 mb-2">
                {s.icon}
                <span className="text-[11px] uppercase tracking-wider label-pill text-white">{s.label}</span>
                <InfoTooltip text={s.tooltip} />
              </div>
              <div
                className="font-mono text-xl text-white group-hover:text-black transition-colors duration-300"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {s.value}
              </div>
            </div>
          </ArtPanel>
        </motion.div>
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
            tab === t.key ? 'text-black' : 'text-white hover:text-white'
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
// OFFER FILTER BAR
// ═══════════════════════════════════════════════════════════════════
function OfferFilterBar({
  aprFilter,
  setAprFilter,
  durationFilter,
  setDurationFilter,
  principalFilter,
  setPrincipalFilter,
}: {
  aprFilter: AprFilter;
  setAprFilter: (f: AprFilter) => void;
  durationFilter: DurationFilter;
  setDurationFilter: (f: DurationFilter) => void;
  principalFilter: PrincipalFilter;
  setPrincipalFilter: (f: PrincipalFilter) => void;
}) {
  const activeCount = [aprFilter !== 'all', durationFilter !== 'all', principalFilter !== 'all'].filter(Boolean).length;

  const clearAll = () => {
    setAprFilter('all');
    setDurationFilter('all');
    setPrincipalFilter('all');
  };

  return (
    <ArtPanel artSrc={ART.porchChill.src} opacity={1} overlay={DARK_OVERLAY_HEAVY}>
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] uppercase tracking-wider label-pill text-white mr-1">Filters</span>

          {/* APR */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-white uppercase">APR:</span>
            <FilterPill label="Low <5%" active={aprFilter === 'low'} onClick={() => setAprFilter(aprFilter === 'low' ? 'all' : 'low')} />
            <FilterPill label="Med 5-15%" active={aprFilter === 'med'} onClick={() => setAprFilter(aprFilter === 'med' ? 'all' : 'med')} />
            <FilterPill label="High 15%+" active={aprFilter === 'high'} onClick={() => setAprFilter(aprFilter === 'high' ? 'all' : 'high')} />
          </div>

          <div className="hidden sm:block w-px h-5 bg-black/60" />

          {/* Duration */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-white uppercase">Duration:</span>
            <FilterPill label="<30d" active={durationFilter === 'short'} onClick={() => setDurationFilter(durationFilter === 'short' ? 'all' : 'short')} />
            <FilterPill label="30-90d" active={durationFilter === 'medium'} onClick={() => setDurationFilter(durationFilter === 'medium' ? 'all' : 'medium')} />
            <FilterPill label="90d+" active={durationFilter === 'long'} onClick={() => setDurationFilter(durationFilter === 'long' ? 'all' : 'long')} />
          </div>

          <div className="hidden sm:block w-px h-5 bg-black/60" />

          {/* Principal */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-white uppercase">Size:</span>
            <FilterPill label="<1 ETH" active={principalFilter === 'small'} onClick={() => setPrincipalFilter(principalFilter === 'small' ? 'all' : 'small')} />
            <FilterPill label="1-10 ETH" active={principalFilter === 'medium'} onClick={() => setPrincipalFilter(principalFilter === 'medium' ? 'all' : 'medium')} />
            <FilterPill label="10+ ETH" active={principalFilter === 'large'} onClick={() => setPrincipalFilter(principalFilter === 'large' ? 'all' : 'large')} />
          </div>

          {activeCount > 0 && (
            <button
              onClick={clearAll}
              className="ml-auto flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium text-red-400/80 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 transition-colors"
            >
              Clear
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500/30 text-[9px] text-red-300">{activeCount}</span>
            </button>
          )}
        </div>
      </div>
    </ArtPanel>
  );
}

function applyOfferFilters(
  offers: Offer[],
  aprFilter: AprFilter,
  durationFilter: DurationFilter,
  principalFilter: PrincipalFilter,
): Offer[] {
  return offers.filter((o) => {
    const aprPct = Number(o.aprBps) / 100;
    if (aprFilter === 'low' && aprPct >= 5) return false;
    if (aprFilter === 'med' && (aprPct < 5 || aprPct > 15)) return false;
    if (aprFilter === 'high' && aprPct < 15) return false;

    const days = daysFromSeconds(o.duration);
    if (durationFilter === 'short' && days >= 30) return false;
    if (durationFilter === 'medium' && (days < 30 || days > 90)) return false;
    if (durationFilter === 'long' && days < 90) return false;

    const ethVal = parseFloat(formatEther(o.principal));
    if (principalFilter === 'small' && ethVal >= 1) return false;
    if (principalFilter === 'medium' && (ethVal < 1 || ethVal > 10)) return false;
    if (principalFilter === 'large' && ethVal < 10) return false;

    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════
// LEND TAB (Create Offer)
// ═══════════════════════════════════════════════════════════════════
function LendTab({ deployed }: { deployed: boolean }) {
  const { address } = useAccount();
  const { ethUsd } = useTOWELIPrice();
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
    if (!deployed) {
      toast.error('Contract not deployed yet');
      return;
    }
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
  }, [principal, aprBps, durationDays, minCollateral, writeContract, deployed]);

  const loading = isPending || isConfirming;

  return (
    <ArtPanel artSrc={ART.mfersHeaven.src} opacity={1} overlay={DARK_OVERLAY}>
      <div className="p-5 sm:p-6 max-w-lg space-y-5">
        {/* Principal */}
        <div>
          <label className="text-[11px] uppercase tracking-wider label-pill text-white block mb-1.5">
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
            className="w-full bg-transparent font-mono text-[16px] text-white outline-none px-0 py-2.5 border-b border-white/10 focus:border-purple-400/40 transition-colors duration-300"
          />
          {principal && parseFloat(principal) > 0 && (
            <div className="text-[11px] text-white mt-1 font-mono">
              {ethUsd > 0
                ? `~$${formatTokenAmount(parseFloat(principal) * ethUsd, 2)} USD estimate`
                : 'USD estimate unavailable'}
            </div>
          )}
        </div>

        {/* APR */}
        <div>
          <label className="text-[11px] uppercase tracking-wider label-pill text-white mb-1.5 flex items-center gap-1.5">
            APR (basis points)
            <InfoTooltip text="Annual Percentage Rate in basis points. 100 bps = 1%. Example: 850 bps = 8.50% APR. The borrower pays this rate pro-rata — if they repay early, they pay less." />
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
              className="flex-1 bg-transparent font-mono text-[16px] text-white outline-none px-0 py-2.5 border-b border-white/10 focus:border-purple-400/40 transition-colors duration-300"
            />
            <span className="text-black font-mono text-sm whitespace-nowrap">
              = {aprPercent}%
            </span>
          </div>
        </div>

        {/* Duration */}
        <div>
          <label className="text-[11px] uppercase tracking-wider label-pill text-white block mb-1.5">
            Duration ({durationDays} days)
          </label>
          <div className="flex flex-wrap gap-2 mb-2">
            {DURATION_PRESETS.map((p) => (
              <button
                key={p.days}
                onClick={() => setDurationDays(p.days)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
                  durationDays === p.days
                    ? 'bg-emerald-500/40 text-black border border-emerald-500/40'
                    : 'bg-black/60 text-white border border-white/25 hover:border-white/20 hover:text-white'
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
          <label className="text-[11px] uppercase tracking-wider label-pill text-white mb-1.5 flex items-center gap-1.5">
            Min Collateral Value (ETH)
            <InfoTooltip text="Minimum ETH value of the staking position you'll accept as collateral. Higher values mean safer loans with lower LTV ratios." />
          </label>
          <input
            type="number"
            inputMode="decimal"
            value={minCollateral}
            onChange={(e) => setMinCollateral(e.target.value)}
            placeholder="0.0"
            min="0"
            step="0.01"
            className="w-full bg-transparent font-mono text-[16px] text-white outline-none px-0 py-2.5 border-b border-white/10 focus:border-purple-400/40 transition-colors duration-300"
          />
        </div>

        {/* Interest preview */}
        <div
          className="rounded-lg px-4 py-3"
          style={{ background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.1)' }}
        >
          <div className="text-[11px] uppercase tracking-wider label-pill text-white mb-0.5">Estimated Earnings</div>
          <div className="font-mono text-black" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {estimatedEarnings} ETH
            <span className="text-white text-sm ml-2">over {durationDays} days</span>
          </div>
        </div>

        {/* Transaction Summary */}
        {principal && parseFloat(principal) > 0 && aprBps && (
          <TxSummary>
            You'll deposit <span className="font-mono text-white font-semibold">{principal} ETH</span>. If a borrower accepts and repays on time, you earn ~<span className="font-mono text-emerald-400 font-semibold">{estimatedEarnings} ETH</span> interest over {durationDays} days.
          </TxSummary>
        )}

        {/* Submit */}
        {!address ? (
          <div className="text-white text-sm text-center py-3">Connect wallet to create an offer</div>
        ) : (
          <button
            onClick={handleCreate}
            disabled={loading || !principal || !aprBps || !minCollateral || !deployed}
            className="w-full py-3 rounded-xl font-semibold text-sm transition-all duration-300 disabled:opacity-70 disabled:cursor-not-allowed bg-emerald-500 hover:bg-emerald-400 text-black"
            style={{ transitionTimingFunction: `cubic-bezier(${EASE.join(',')})` }}
          >
            {!deployed ? (
              'Contract Not Deployed'
            ) : loading ? (
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
    </ArtPanel>
  );
}

// ═══════════════════════════════════════════════════════════════════
// BORROW TAB (Available Offers)
// ═══════════════════════════════════════════════════════════════════
function OfferRow({
  offer,
  userAddress,
  deployed,
  idx,
}: {
  offer: Offer;
  userAddress?: string;
  deployed: boolean;
  idx: number;
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
    if (!deployed) return;
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
    if (!deployed) return;
    acceptWrite({
      address: TEGRIDY_LENDING_ADDRESS as Address,
      abi: TEGRIDY_LENDING_ABI,
      functionName: 'acceptOffer',
      args: [BigInt(offer.id), BigInt(tokenId)],
    }, {
      onError: (err) => toast.error(err.message?.slice(0, 120) ?? 'Accept failed'),
    });
  };

  const positionAmount = position ? formatEther((position as readonly bigint[])[0] ?? 0n) : '0';
  const ltv = computeLTV(offer.principal, positionAmount);

  // Desktop row
  const desktopRow = (
    <tr
      className="cursor-pointer hover:bg-black/60 transition-colors duration-200 hidden sm:table-row"
      style={{ borderTop: `1px solid ${ROW_BORDER}` }}
      onClick={() => setExpanded(!expanded)}
    >
      <td className="py-3 pr-4 font-mono text-white text-sm">#{offer.id}</td>
      <td className="py-3 pr-4 font-mono text-white text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatTokenAmount(formatEther(offer.principal))} ETH
      </td>
      <td className="py-3 pr-4 font-mono text-black text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {bpsToPercent(offer.aprBps)}%
      </td>
      <td className="py-3 pr-4 text-white text-sm">{daysFromSeconds(offer.duration)}d</td>
      <td className="py-3 pr-4 font-mono text-white text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatTokenAmount(formatEther(offer.minPositionValue))} ETH
      </td>
      <td className="py-3 pr-4 font-mono text-white text-sm">{shortenAddress(offer.lender)}</td>
      <td className="py-3 text-sm">
        <svg
          className={`w-4 h-4 text-white transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </td>
    </tr>
  );

  // Mobile card
  const mobileCard = (
    <tr className="sm:hidden" style={{ borderTop: `1px solid ${ROW_BORDER}` }}>
      <td colSpan={7} className="p-0">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: idx * 0.05, ease: EASE as [number, number, number, number] }}
          className="p-3 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-white text-xs">#{offer.id}</span>
            <svg
              className={`w-4 h-4 text-white transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-[10px] uppercase tracking-wider label-pill text-white">Principal</span>
              <div className="font-mono text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatTokenAmount(formatEther(offer.principal))} ETH
              </div>
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider label-pill text-white">APR</span>
              <div className="font-mono text-black" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {bpsToPercent(offer.aprBps)}%
              </div>
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider label-pill text-white">Duration</span>
              <div className="text-white">{daysFromSeconds(offer.duration)}d</div>
            </div>
            <div>
              <span className="text-[10px] uppercase tracking-wider label-pill text-white">Min Collateral</span>
              <div className="font-mono text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatTokenAmount(formatEther(offer.minPositionValue))} ETH
              </div>
            </div>
          </div>
          <div className="mt-1 font-mono text-[10px] text-white">{shortenAddress(offer.lender)}</div>
        </motion.div>
      </td>
    </tr>
  );

  // Expanded detail (shared between mobile/desktop)
  const expandedDetail = (
    <AnimatePresence>
      {expanded && (
        <tr>
          <td colSpan={7} className="p-0">
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE as [number, number, number, number] }}
              className="overflow-hidden"
            >
              <ArtPanel artSrc={ART.apeHug.src} opacity={1} overlay={DARK_OVERLAY_HEAVY} className="mx-2 mb-2">
                <div className="p-4">
                  {!userAddress ? (
                    <p className="text-white text-sm">Connect wallet to borrow</p>
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
                          <span className="text-[11px] uppercase tracking-wider label-pill text-white">Your Position</span>
                          <div className="font-mono text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            Token #{tokenId} -- {formatTokenAmount(positionAmount)} TOWELI
                          </div>
                        </div>
                        <div>
                          <span className="text-[11px] uppercase tracking-wider label-pill text-white">Position Value</span>
                          <div className="font-mono text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {formatTokenAmount(positionAmount)} ETH
                          </div>
                        </div>
                        <div>
                          <span className="text-[11px] uppercase tracking-wider label-pill text-white">Loan Amount</span>
                          <div className="font-mono text-black" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {formatTokenAmount(formatEther(offer.principal))} ETH
                          </div>
                        </div>
                        <div>
                          <span className="text-[11px] uppercase tracking-wider label-pill text-white flex items-center gap-1">LTV Ratio <InfoTooltip text="Loan-to-Value ratio — your loan amount divided by your collateral value. Lower LTV is safer. Above 75% is high risk." /></span>
                          <div className={`font-mono ${ltv.color}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {ltv.ratio.toFixed(1)}%
                            {ltv.ratio >= 75 && (
                              <span className="ml-1.5 text-[10px] text-red-400/80 uppercase">High Risk</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* LTV bar */}
                      <div className="w-full h-1.5 rounded-full bg-black/60 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${Math.min(ltv.ratio, 100)}%`,
                            background: ltv.ratio < 50 ? '#34d399' : ltv.ratio < 75 ? '#facc15' : '#ef4444',
                            transitionTimingFunction: `cubic-bezier(${EASE.join(',')})`,
                          }}
                        />
                      </div>

                      {/* Total Repayment Preview */}
                      {(() => {
                        const principalEth = parseFloat(formatEther(offer.principal));
                        const maxInterest = principalEth * (Number(offer.aprBps) / 10000) * (Number(offer.duration) / (365 * 86400));
                        const totalRepay = principalEth + maxInterest;
                        return (
                          <TxSummary>
                            You'll lock NFT <span className="font-mono text-white font-semibold">#{tokenId}</span> and receive <span className="font-mono text-white font-semibold">{formatTokenAmount(principalEth)} ETH</span>.
                            Total repayment: <span className="font-mono text-emerald-400 font-semibold">{formatTokenAmount(totalRepay)} ETH</span> ({formatTokenAmount(principalEth)} principal + {formatTokenAmount(maxInterest)} interest over {daysFromSeconds(offer.duration)}d).
                            <span className="block text-[11px] text-white/50 mt-1">Repay early to save — interest is calculated pro-rata.</span>
                          </TxSummary>
                        );
                      })()}

                      {/* Risk Warning */}
                      <RiskBanner variant="warning">
                        Your staking NFT (#{tokenId}) will be locked as collateral. If you don't repay by the deadline, the lender can claim it permanently.
                      </RiskBanner>

                      {/* Step Indicator */}
                      <StepIndicator
                        steps={['Approve NFT', 'Accept Offer']}
                        currentStep={isApproved ? 1 : 0}
                      />

                      <DisabledWrap deployed={deployed}>
                        <div className="flex flex-wrap gap-2">
                          {!isApproved ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleApprove(); }}
                              disabled={approvePending || approveConfirming || !deployed}
                              className="px-4 py-2 rounded-lg text-sm font-medium bg-purple-500/50 text-black border border-purple-500/30 hover:bg-purple-500/30 transition-colors duration-200 disabled:opacity-70"
                            >
                              {approvePending || approveConfirming ? 'Approving...' : 'Approve NFT'}
                            </button>
                          ) : (
                            <span className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500/30 text-black border border-emerald-500/40">
                              Approved
                            </span>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); handleAccept(); }}
                            disabled={!isApproved || acceptPending || acceptConfirming || !deployed}
                            className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500 text-black hover:bg-emerald-400 transition-colors duration-200 disabled:opacity-70 disabled:cursor-not-allowed"
                          >
                            {acceptPending || acceptConfirming ? 'Accepting...' : 'Accept Offer'}
                          </button>
                        </div>
                      </DisabledWrap>
                    </div>
                  )}
                </div>
              </ArtPanel>
            </motion.div>
          </td>
        </tr>
      )}
    </AnimatePresence>
  );

  return (
    <>
      {desktopRow}
      {mobileCard}
      {expandedDetail}
    </>
  );
}

function BorrowTab({ deployed, allOffers, offersLoading }: { deployed: boolean; allOffers: Offer[]; offersLoading: boolean }) {
  const { address } = useAccount();
  const [sortKey, setSortKey] = useState<SortKey>('id');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [aprFilter, setAprFilter] = useState<AprFilter>('all');
  const [durationFilter, setDurationFilter] = useState<DurationFilter>('all');
  const [principalFilter, setPrincipalFilter] = useState<PrincipalFilter>('all');

  // Only show active offers for borrowers
  const activeOffers = useMemo(() => allOffers.filter((o) => o.active), [allOffers]);

  const filteredOffers = useMemo(
    () => applyOfferFilters(activeOffers, aprFilter, durationFilter, principalFilter),
    [activeOffers, aprFilter, durationFilter, principalFilter],
  );

  const sortedOffers = useMemo(() => {
    const sorted = [...filteredOffers];
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
  }, [filteredOffers, sortKey, sortDir]);

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
      className="py-2 pr-4 font-medium cursor-pointer select-none hover:text-white transition-colors"
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
    <div className="pt-4 space-y-4">
      {/* Filter bar */}
      <OfferFilterBar
        aprFilter={aprFilter}
        setAprFilter={setAprFilter}
        durationFilter={durationFilter}
        setDurationFilter={setDurationFilter}
        principalFilter={principalFilter}
        setPrincipalFilter={setPrincipalFilter}
      />

      {offersLoading ? (
        <ArtPanel artSrc={ART.beachVibes.src} opacity={1} overlay={DARK_OVERLAY_HEAVY}>
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <svg className="animate-spin h-8 w-8 text-purple-400 mb-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-white text-sm">Loading offers...</p>
          </div>
        </ArtPanel>
      ) : sortedOffers.length === 0 && activeOffers.length === 0 ? (
        <EmptyState
          artSrc={ART.beachVibes.src}
          title="No loan offers yet"
          subtitle="Create the first one! Switch to the Lend tab to get started."
        />
      ) : sortedOffers.length === 0 ? (
        <div className="text-center py-12 text-white text-sm">
          No offers match your filters. Try adjusting them.
        </div>
      ) : (
        <ArtPanel artSrc={ART.poolParty.src} opacity={1} overlay={DARK_OVERLAY_HEAVY}>
          <div className="p-4 overflow-x-auto -mx-1">
            <table className="w-full text-left text-[11px] uppercase tracking-wider label-pill text-white">
              <thead>
                <tr className="hidden sm:table-row">
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
                {sortedOffers.map((offer, idx) => (
                  <OfferRow key={offer.id} offer={offer} userAddress={address} deployed={deployed} idx={idx} />
                ))}
              </tbody>
            </table>
          </div>
        </ArtPanel>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PNL SUMMARY CARD
// ═══════════════════════════════════════════════════════════════════
function PnlSummaryCard({
  myBorrowed,
  myLent,
}: {
  myBorrowed: Loan[];
  myLent: Loan[];
}) {
  const activeBorrowed = myBorrowed.filter((l) => getLoanStatus(l) === 'active').length;
  const activeLent = myLent.filter((l) => getLoanStatus(l) === 'active').length;
  const completedBorrowed = myBorrowed.filter((l) => getLoanStatus(l) === 'repaid').length;
  const completedLent = myLent.filter((l) => getLoanStatus(l) === 'repaid').length;

  // Calculate simplified interest estimates
  const interestEarned = useMemo(() => {
    return myLent.reduce((acc, l) => {
      if (!l.repaid) return acc;
      const principal = parseFloat(formatEther(l.principal));
      const aprPct = Number(l.aprBps) / 10000;
      const durationSec = Number(l.deadline - l.startTime);
      const years = durationSec / (365 * 86400);
      return acc + principal * aprPct * years;
    }, 0);
  }, [myLent]);

  const interestPaid = useMemo(() => {
    return myBorrowed.reduce((acc, l) => {
      if (!l.repaid) return acc;
      const principal = parseFloat(formatEther(l.principal));
      const aprPct = Number(l.aprBps) / 10000;
      const durationSec = Number(l.deadline - l.startTime);
      const years = durationSec / (365 * 86400);
      return acc + principal * aprPct * years;
    }, 0);
  }, [myBorrowed]);

  const netPnl = interestEarned - interestPaid;

  return (
    <ArtPanel artSrc={ART.swordOfLove.src} opacity={1} overlay="none">
      <div className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <svg className="w-4 h-4 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
          </svg>
          <span className="text-[11px] uppercase tracking-wider label-pill text-white font-medium">P&L Summary</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <div>
            <span className="text-[10px] uppercase tracking-wider label-pill text-white block mb-1">Interest Earned</span>
            <div className="font-mono text-black text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
              +{formatTokenAmount(interestEarned)} ETH
            </div>
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-wider label-pill text-white block mb-1">Interest Paid</span>
            <div className="font-mono text-red-400 text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
              -{formatTokenAmount(interestPaid)} ETH
            </div>
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-wider label-pill text-white block mb-1">Net PnL</span>
            <div
              className={`font-mono text-sm ${netPnl >= 0 ? 'text-black' : 'text-red-400'}`}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {netPnl >= 0 ? '+' : ''}{formatTokenAmount(netPnl)} ETH
            </div>
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-wider label-pill text-white block mb-1">Active Positions</span>
            <div className="font-mono text-white text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {activeBorrowed + activeLent}
              <span className="text-white text-[10px] ml-1">({activeBorrowed}B / {activeLent}L)</span>
            </div>
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-wider label-pill text-white block mb-1">Completed</span>
            <div className="font-mono text-white text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {completedBorrowed + completedLent}
              <span className="text-white text-[10px] ml-1">({completedBorrowed}B / {completedLent}L)</span>
            </div>
          </div>
        </div>
      </div>
    </ArtPanel>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MY LOANS TAB
// ═══════════════════════════════════════════════════════════════════
function LoanRow({
  loan,
  role,
  deployed,
  idx,
}: {
  loan: Loan;
  role: 'borrower' | 'lender';
  deployed: boolean;
  idx: number;
}) {
  const status = getLoanStatus(loan);
  const countdown = useCountdown(loan.deadline);

  const { data: repaymentAmount } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'getRepaymentAmount',
    args: [BigInt(loan.id)],
    query: { enabled: status === 'active' || status === 'overdue' },
  });

  const { data: defaulted } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'isDefaulted',
    args: [BigInt(loan.id)],
    query: { enabled: status === 'overdue' },
  });

  const { writeContract: repayWrite, data: repayTx, isPending: repayPending } = useWriteContract();
  const { isLoading: repayConfirming, isSuccess: repaySuccess } = useWaitForTransactionReceipt({ hash: repayTx });

  const { writeContract: claimWrite, data: claimTx, isPending: claimPending } = useWriteContract();
  const { isLoading: claimConfirming, isSuccess: claimSuccess } = useWaitForTransactionReceipt({ hash: claimTx });

  useEffect(() => {
    if (repaySuccess) toast.success('Loan repaid successfully');
  }, [repaySuccess]);

  useEffect(() => {
    if (claimSuccess) toast.success('Collateral claimed');
  }, [claimSuccess]);

  const handleRepay = () => {
    if (!repaymentAmount || !deployed) return;
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
    if (!deployed) return;
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
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.35, delay: idx * 0.06, ease: EASE as [number, number, number, number] }}
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 px-1"
      style={{ borderBottom: `1px solid ${ROW_BORDER}` }}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <StatusBadge status={status} />
        <span className="font-mono text-sm text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatTokenAmount(formatEther(loan.principal))} ETH
        </span>
        <span className="font-mono text-sm text-black" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {bpsToPercent(loan.aprBps)}%
        </span>
        <span className="text-sm text-white">NFT #{Number(loan.tokenId)}</span>
        {(status === 'active' || status === 'overdue') && (
          countdown.isExpired ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 text-[11px] font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
              Expired
            </span>
          ) : (
            <span
              className={`font-mono text-sm ${countdown.isUrgent ? 'text-red-400' : 'text-white'}`}
              style={{
                fontVariantNumeric: 'tabular-nums',
                animation: countdown.isUrgent ? 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' : undefined,
              }}
            >
              {countdown.text}
            </span>
          )
        )}
        {repaymentAmount && (status === 'active' || status === 'overdue') && (
          <span className="text-[11px] text-white font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
            Repay: {formatTokenAmount(formatEther(repaymentAmount as bigint))} ETH
          </span>
        )}
      </div>

      <div className="flex gap-2 flex-shrink-0">
        {role === 'borrower' && (status === 'active' || status === 'overdue') && (
          <DisabledWrap deployed={deployed}>
            <button
              onClick={handleRepay}
              disabled={repayLoading || !deployed}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/40 text-black border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors disabled:opacity-70"
            >
              {repayLoading ? 'Repaying...' : 'Repay'}
            </button>
          </DisabledWrap>
        )}
        {role === 'lender' && (defaulted || status === 'overdue') && !loan.defaultClaimed && (
          <DisabledWrap deployed={deployed}>
            <button
              onClick={handleClaim}
              disabled={claimLoading || !deployed}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors disabled:opacity-70"
            >
              {claimLoading ? 'Claiming...' : 'Claim Collateral'}
            </button>
          </DisabledWrap>
        )}
      </div>
    </motion.div>
  );
}

function MyLoansTab({ deployed, allLoans, loansLoading }: { deployed: boolean; allLoans: Loan[]; loansLoading: boolean }) {
  const { address } = useAccount();
  const [subTab, setSubTab] = useState<LoanSubTab>('borrower');

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
      <div className="text-center py-12 text-white text-sm pt-4">
        Connect wallet to view your loans
      </div>
    );
  }

  if (loansLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
        <svg className="animate-spin h-8 w-8 text-purple-400 mb-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="text-white text-sm">Loading loans...</p>
      </div>
    );
  }

  return (
    <div className="pt-4 space-y-4">
      {/* PnL Summary */}
      <PnlSummaryCard myBorrowed={myBorrowed} myLent={myLent} />

      {/* Sub-tabs */}
      <div className="flex gap-4">
        {(['borrower', 'lender'] as const).map((st) => (
          <button
            key={st}
            onClick={() => setSubTab(st)}
            className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-all duration-200 ${
              subTab === st
                ? 'bg-black/60 text-white'
                : 'text-white hover:text-white hover:bg-white/5'
            }`}
          >
            As {st === 'borrower' ? 'Borrower' : 'Lender'}
            <span className="ml-1.5 text-[11px] font-mono text-white">
              ({st === 'borrower' ? myBorrowed.length : myLent.length})
            </span>
          </button>
        ))}
      </div>

      {displayed.length === 0 ? (
        <EmptyState
          artSrc={ART.porchChill.src}
          title={subTab === 'borrower' ? 'No borrows yet' : 'No loans as lender yet'}
          subtitle={subTab === 'borrower'
            ? "You haven't borrowed yet. Browse offers in the Borrow tab to get started!"
            : "You haven't lent yet. Switch to the Lend tab to create your first offer!"}
        />
      ) : (
        <ArtPanel artSrc={ART.swordOfLove.src} opacity={1} overlay={DARK_OVERLAY_HEAVY}>
          <div className="p-4">
            {displayed.map((loan, idx) => (
              <LoanRow key={loan.id} loan={loan} role={subTab} deployed={deployed} idx={idx} />
            ))}
          </div>
        </ArtPanel>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════
// ─── Hook: Batch-fetch all offers ──────────────────────────────
function useAllOffers() {
  const { data: offerCount } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'offerCount',
  });

  const count = offerCount ? Number(offerCount) : 0;

  const offerContracts = useMemo(() => {
    if (count === 0) return [];
    return Array.from({ length: count }, (_, i) => ({
      address: TEGRIDY_LENDING_ADDRESS as Address,
      abi: TEGRIDY_LENDING_ABI,
      functionName: 'getOffer' as const,
      args: [BigInt(i)] as const,
    }));
  }, [count]);

  const { data: offerResults, isLoading } = useReadContracts({
    contracts: offerContracts,
    query: { enabled: count > 0 },
  });

  const offers = useMemo<Offer[]>(() => {
    if (!offerResults) return [];
    const parsed: Offer[] = [];
    for (let i = 0; i < offerResults.length; i++) {
      const result = offerResults[i]!;
      if (result.status !== 'success' || !result.result) continue;
      const o = result.result as readonly [string, bigint, bigint, bigint, string, bigint, boolean];
      parsed.push({
        id: i,
        lender: o[0],
        principal: o[1],
        aprBps: o[2],
        duration: o[3],
        collateralContract: o[4],
        minPositionValue: o[5],
        active: o[6],
      });
    }
    return parsed;
  }, [offerResults]);

  return { offers, isLoading, count };
}

// ─── Hook: Batch-fetch all loans ───────────────────────────────
function useAllLoans() {
  const { data: loanCount } = useReadContract({
    address: TEGRIDY_LENDING_ADDRESS as Address,
    abi: TEGRIDY_LENDING_ABI,
    functionName: 'loanCount',
  });

  const count = loanCount ? Number(loanCount) : 0;

  const loanContracts = useMemo(() => {
    if (count === 0) return [];
    return Array.from({ length: count }, (_, i) => ({
      address: TEGRIDY_LENDING_ADDRESS as Address,
      abi: TEGRIDY_LENDING_ABI,
      functionName: 'getLoan' as const,
      args: [BigInt(i)] as const,
    }));
  }, [count]);

  const { data: loanResults, isLoading } = useReadContracts({
    contracts: loanContracts,
    query: { enabled: count > 0 },
  });

  const loans = useMemo<Loan[]>(() => {
    if (!loanResults) return [];
    const parsed: Loan[] = [];
    for (let i = 0; i < loanResults.length; i++) {
      const result = loanResults[i]!;
      if (result.status !== 'success' || !result.result) continue;
      const l = result.result as readonly [string, string, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean];
      parsed.push({
        id: i,
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
      });
    }
    return parsed;
  }, [loanResults]);

  return { loans, isLoading, count };
}

export function LendingSection({ address: _propAddress }: { address?: string }) {
  const [tab, setTab] = useState<Tab>('lend');
  const deployed = isDeployed(TEGRIDY_LENDING_ADDRESS);

  // Batch-fetch all offers and loans at the top level
  const { offers: allOffers, isLoading: offersLoading } = useAllOffers();
  const { loans: allLoans, isLoading: loansLoading } = useAllLoans();

  return (
    <section className="w-full space-y-6">
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }`}</style>
      {!deployed && (
        <ArtPanel artSrc={ART.smokingDuo.src} opacity={1} overlay="none">
          <div className="px-4 py-3 text-center text-[13px] text-amber-400/80">
            Lending contracts are being audited and will be deployed soon. Explore the interface below. <a href="/security" className="underline hover:text-amber-300 transition-colors">View security details</a>
          </div>
        </ArtPanel>
      )}
      <StatsBar allOffers={allOffers} allLoans={allLoans} />

      <HowItWorks
        storageKey="tegridy-token-lending-how"
        title="How does Token Lending work?"
        steps={[
          { label: 'Create an Offer', description: 'Lenders deposit ETH and set their terms — APR, duration, and minimum collateral value.' },
          { label: 'Lock Collateral', description: 'Borrowers lock their staking position NFT as collateral and receive the ETH.' },
          { label: 'Repay on Time', description: 'Borrowers repay principal + pro-rata interest before the deadline to reclaim their NFT.' },
          { label: 'Default Protection', description: 'If the borrower misses the deadline, the lender can claim the staking NFT.' },
        ]}
      />

      <TabNav tab={tab} setTab={setTab} />
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: EASE as [number, number, number, number] }}
        >
          {tab === 'lend' && <LendTab deployed={deployed} />}
          {tab === 'borrow' && <BorrowTab deployed={deployed} allOffers={allOffers} offersLoading={offersLoading} />}
          {tab === 'myloans' && <MyLoansTab deployed={deployed} allLoans={allLoans} loansLoading={loansLoading} />}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
