import { useState, useMemo, useEffect } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther, parseEther, type Address } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_NFT_LENDING_ADDRESS } from '../../lib/constants';
import { TEGRIDY_NFT_LENDING_ABI, ERC721_ABI } from '../../lib/contracts';
import { InfoTooltip, HowItWorks, StepIndicator, RiskBanner, TxSummary } from '../ui/InfoTooltip';
import { ART, pageArt, artStyle } from '../../lib/artConfig';
import { ArtImg } from '../ArtImg';

// Per-collection art for the collateral selector — pulls from each project's
// canonical asset instead of Tegridy's art pool so the cards represent the
// actual collection. Paths match frontend/src/nakamigos/constants.js.
const COLLECTION_ART: Record<string, string> = {
  JBAC: ART.jbacSkeleton.src,
  NAKA: '/splash/skeleton.jpg',
  GNSS: '/collections/gnssart.jpg',
};

/* ─── Constants ─────────────────────────────────────────────────── */
// Bumped from 0.6 → 0.80 so form labels and stat cards stay legible against the
// animated art backgrounds that sit behind this whole section. Border bumped from
// var(--color-purple-12) (4% alpha, almost invisible) → 18% white so cards have
// a clear edge against the art.
const CARD_BG = 'rgba(6, 12, 26, 0.80)';
const CARD_BORDER = 'rgba(255, 255, 255, 0.18)';
const LABEL_STYLE: React.CSSProperties = { textShadow: '0 1px 6px rgba(0,0,0,0.95)' };
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const COLLECTIONS = [
  { name: 'Jungle Bay Ape Club', symbol: 'JBAC', address: '0xd37264c71e9af940e49795F0d3a8336afAaFDdA9' as Address },
  { name: 'Nakamigos', symbol: 'NAKA', address: '0xd774557b647330C91Bf44cfEAB205095f7E6c367' as Address },
  { name: 'GNSS Art', symbol: 'GNSS', address: '0xa1De9f93c56C290C48849B1393b09eB616D55dbb' as Address },
];

const DURATION_PRESETS = [
  { label: '7d', seconds: 7 * 86400 },
  { label: '14d', seconds: 14 * 86400 },
  { label: '30d', seconds: 30 * 86400 },
  { label: '90d', seconds: 90 * 86400 },
  { label: '180d', seconds: 180 * 86400 },
  { label: '365d', seconds: 365 * 86400 },
];

const TABS = ['Lend', 'Borrow', 'My Loans'] as const;
type Tab = (typeof TABS)[number];

/* ─── Helpers ───────────────────────────────────────────────────── */
function shortenAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr || '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days >= 365) return `${Math.floor(days / 365)}y`;
  return `${days}d`;
}

function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2);
}

interface LoanData {
  borrower: Address;
  lender: Address;
  offerId: bigint;
  tokenId: bigint;
  collateralContract: Address;
  principal: bigint;
  aprBps: bigint;
  startTime: bigint;
  deadline: bigint;
  repaid: boolean;
  defaultClaimed: boolean;
}

function getLoanStatus(loan: LoanData): 'active' | 'overdue' | 'repaid' | 'defaulted' {
  if (loan.repaid) return 'repaid';
  if (loan.defaultClaimed) return 'defaulted';
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now > loan.deadline) return 'overdue';
  return 'active';
}

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  active: { bg: 'rgba(16,185,129,0.12)', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  overdue: { bg: 'rgba(234,179,8,0.12)', text: 'text-yellow-400', border: 'border-yellow-500/30' },
  repaid: { bg: 'var(--color-purple-12)', text: 'text-purple-400', border: 'border-purple-500/30' },
  defaulted: { bg: 'rgba(239,68,68,0.12)', text: 'text-red-400', border: 'border-red-500/30' },
};

function collectionName(addr: string): string {
  const c = COLLECTIONS.find((c) => c.address.toLowerCase() === addr.toLowerCase());
  return c ? c.symbol : shortenAddress(addr);
}

/* ─── Main Component ────────────────────────────────────────────── */
export function NFTLendingSection() {
  void useAccount(); // keep wagmi context alive
  const [activeTab, setActiveTab] = useState<Tab>('Lend');

  /* ── Protocol Stats ──────────────────────────────────────────── */
  const { data: offerCountData } = useReadContract({
    address: TEGRIDY_NFT_LENDING_ADDRESS,
    abi: TEGRIDY_NFT_LENDING_ABI,
    functionName: 'offerCount',
  });
  const { data: loanCountData } = useReadContract({
    address: TEGRIDY_NFT_LENDING_ADDRESS,
    abi: TEGRIDY_NFT_LENDING_ABI,
    functionName: 'loanCount',
  });
  const { data: protocolFeeBpsData } = useReadContract({
    address: TEGRIDY_NFT_LENDING_ADDRESS,
    abi: TEGRIDY_NFT_LENDING_ABI,
    functionName: 'protocolFeeBps',
  });

  const offerCount = offerCountData ? Number(offerCountData) : 0;
  const loanCount = loanCountData ? Number(loanCountData) : 0;
  const protocolFeeBps = protocolFeeBpsData ? Number(protocolFeeBpsData) : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <m.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ease: EASE }}>
        <h2 className="heading-luxury text-xl md:text-2xl text-white mb-2">NFT Lending</h2>
        <p className="text-white/70 text-[13px]">
          Borrow ETH against your NFTs or lend ETH and earn interest. P2P — no oracles, no liquidations.
        </p>
      </m.div>

      {/* How It Works */}
      <HowItWorks
        storageKey="tegridy-nft-lending-how"
        title="How does NFT Lending work?"
        steps={[
          { label: 'Set Terms', description: 'Lender picks a collection and sets loan terms — ETH amount, APR, and duration.' },
          { label: 'Lock NFT', description: 'Borrower locks their NFT as collateral and receives the ETH instantly.' },
          { label: 'Repay Loan', description: 'Borrower repays principal + pro-rata interest before the deadline to reclaim their NFT.' },
          { label: 'Default', description: 'If the deadline passes without repayment, the lender claims the NFT. No oracles, no liquidations.' },
        ]}
      />

      {/* Stats Bar */}
      <m.div
        className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ease: EASE, delay: 0.03 }}
      >
        {[
          { label: 'Total Offers', value: offerCount.toString(), tooltip: 'Number of active loan offers available for borrowers', art: pageArt('nft-lending', 0) },
          { label: 'Active Loans', value: loanCount.toString(), tooltip: 'Loans currently outstanding with locked NFT collateral', art: pageArt('nft-lending', 1) },
          { label: 'Protocol Fee', value: `${bpsToPercent(protocolFeeBps)}%`, tooltip: 'Fee taken from interest earned by lenders, paid to the protocol treasury', art: pageArt('nft-lending', 2) },
          { label: 'Collections', value: COLLECTIONS.length.toString(), tooltip: `Supported collections: ${COLLECTIONS.map(c => c.symbol).join(', ')}`, art: pageArt('nft-lending', 3) },
        ].map((s) => (
          <div
            key={s.label}
            className="relative overflow-hidden rounded-xl"
            style={{ border: `1px solid ${CARD_BORDER}` }}
          >
            <img src={s.art.src} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" style={artStyle(s.art)} />
            {/* Translucent black content panel — art bleeds through around the
                edges while the stat stays readable. */}
            <div
              className="relative z-10 m-2 rounded-lg p-3 md:p-4"
              style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <p className="text-white/90 text-[11px] uppercase tracking-wider mb-1 flex items-center gap-1" style={LABEL_STYLE}>
                {s.label}
                <InfoTooltip text={s.tooltip} />
              </p>
              <p className="text-white text-xl font-semibold" style={LABEL_STYLE}>{s.value}</p>
            </div>
          </div>
        ))}
      </m.div>

      {/* Tab Navigation */}
      <m.div
        className="flex gap-1 rounded-xl p-1"
        style={{ background: 'rgba(13, 21, 48, 0.4)', border: `1px solid ${CARD_BORDER}` }}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ease: EASE, delay: 0.05 }}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`relative flex-1 min-h-[44px] rounded-lg text-[13px] font-medium transition-colors ${
              activeTab === tab ? 'text-white' : 'text-white/70 hover:text-white/70'
            }`}
          >
            {activeTab === tab && (
              <m.div
                layoutId="lending-tab-indicator"
                className="absolute inset-0 rounded-lg"
                style={{ background: 'var(--color-stan)', boxShadow: '0 4px 12px var(--color-stan-40)' }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              />
            )}
            <span className="relative z-10">{tab}</span>
          </button>
        ))}
      </m.div>

      {/* Tab Content */}
      <AnimatePresence mode="wait">
        {activeTab === 'Lend' && (
          <m.div key="lend" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ ease: EASE }}>
            <LendTab />
          </m.div>
        )}
        {activeTab === 'Borrow' && (
          <m.div key="borrow" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ ease: EASE }}>
            <BorrowTab offerCount={offerCount} />
          </m.div>
        )}
        {activeTab === 'My Loans' && (
          <m.div key="myloans" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ ease: EASE }}>
            <MyLoansTab loanCount={loanCount} />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   LEND TAB
   ═══════════════════════════════════════════════════════════════════ */
function LendTab() {
  const { isConnected } = useAccount();
  const [selectedCollection, setSelectedCollection] = useState<Address>(COLLECTIONS[0]!.address);
  const [principal, setPrincipal] = useState('');
  const [aprBps, setAprBps] = useState('');
  const [duration, setDuration] = useState(DURATION_PRESETS[2]!.seconds); // default 30d

  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isSuccess) {
      toast.success('Offer created successfully!');
      setPrincipal('');
      setAprBps('');
      reset();
    }
  }, [isSuccess, reset]);

  const interestPreview = useMemo(() => {
    const p = parseFloat(principal || '0');
    const apr = parseInt(aprBps || '0');
    if (p <= 0 || apr <= 0) return '0';
    const interest = (p * apr * duration) / (10000 * 31536000);
    return interest.toFixed(6);
  }, [principal, aprBps, duration]);

  const handleCreateOffer = () => {
    if (!principal || parseFloat(principal) <= 0) {
      toast.error('Enter a valid principal amount');
      return;
    }
    if (!aprBps || parseInt(aprBps) <= 0) {
      toast.error('Enter a valid APR in basis points');
      return;
    }
    try {
      writeContract({
        address: TEGRIDY_NFT_LENDING_ADDRESS,
        abi: TEGRIDY_NFT_LENDING_ABI,
        functionName: 'createOffer',
        args: [parseEther(principal), BigInt(aprBps), BigInt(duration), selectedCollection],
        value: parseEther(principal),
      });
    } catch (err: any) {
      toast.error(err?.shortMessage || 'Transaction failed');
    }
  };

  return (
    <div className="space-y-5">
      {/* Collection Selector */}
      <div>
        <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 block" style={LABEL_STYLE}>Collateral Collection</label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {COLLECTIONS.map((c) => (
            <button
              key={c.address}
              onClick={() => setSelectedCollection(c.address)}
              className={`relative overflow-hidden aspect-square rounded-xl text-left transition-all ${
                selectedCollection === c.address
                  ? 'border-2 border-emerald-500/70 text-white'
                  : 'border border-white/10 text-white hover:border-white/25'
              }`}
            >
              <img src={COLLECTION_ART[c.symbol]} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
              {/* Label overlaid on the art — text sits inside a tight black
                  inline-block sized to the text itself, not a full-width panel. */}
              <div className="absolute inset-0 p-3 flex flex-col justify-end items-start">
                <span
                  className="inline-block text-[15px] font-semibold px-2 py-0.5 rounded"
                  style={{ color: '#22c55e', background: 'rgba(0,0,0,0.85)', textShadow: '0 1px 4px rgba(0,0,0,0.95)' }}
                >
                  {c.name}
                </span>
                <span
                  className="inline-block text-[11px] font-mono px-2 py-0.5 mt-0.5 rounded"
                  style={{ color: '#22c55e', background: 'rgba(0,0,0,0.85)', textShadow: '0 1px 4px rgba(0,0,0,0.95)' }}
                >
                  {c.symbol}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Principal + APR */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 block" style={LABEL_STYLE}>Principal (ETH)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            className="w-full min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50 placeholder:text-white/85"
            style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
          />
        </div>
        <div>
          <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 flex items-center gap-1.5" style={LABEL_STYLE}>
            APR (bps){' '}
            {aprBps && parseInt(aprBps) > 0 && (
              <span className="text-emerald-400 normal-case">({bpsToPercent(parseInt(aprBps))}%)</span>
            )}
            <InfoTooltip text="Annual Percentage Rate in basis points. 100 bps = 1%. Example: 1000 bps = 10% APR. Interest is pro-rata — borrowers pay less if they repay early." />
          </label>
          <input
            type="number"
            step="1"
            min="0"
            placeholder="e.g. 1000 = 10%"
            value={aprBps}
            onChange={(e) => setAprBps(e.target.value)}
            className="w-full min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50 placeholder:text-white/85"
            style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
          />
        </div>
      </div>

      {/* Duration Presets */}
      <div>
        <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 block" style={LABEL_STYLE}>Loan Duration</label>
        <div className="flex flex-wrap gap-2">
          {DURATION_PRESETS.map((d) => (
            <button
              key={d.seconds}
              onClick={() => setDuration(d.seconds)}
              className={`min-h-[44px] px-4 py-2 rounded-xl text-[13px] font-medium transition-all ${
                duration === d.seconds
                  ? 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-400'
                  : 'border border-white/5 text-white/70 hover:text-white/70 hover:border-white/15'
              }`}
              style={duration !== d.seconds ? { background: CARD_BG } : undefined}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Interest Preview */}
      {principal && aprBps && parseFloat(principal) > 0 && parseInt(aprBps) > 0 && (
        <m.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl p-3 md:p-5"
          style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}
        >
          <p className="text-white/85 text-[11px] uppercase tracking-wider mb-1">Estimated Interest Earned</p>
          <p className="text-emerald-400 text-xl font-semibold">{interestPreview} ETH</p>
          <p className="text-white/70 text-[11px] mt-1">
            {principal} ETH at {bpsToPercent(parseInt(aprBps))}% APR for {formatDuration(duration)}
          </p>
        </m.div>
      )}

      {/* Transaction Summary */}
      {principal && parseFloat(principal) > 0 && aprBps && parseInt(aprBps) > 0 && (
        <TxSummary>
          You'll deposit <span className="font-mono text-white font-semibold">{principal} ETH</span>. If a borrower accepts and repays, you earn ~<span className="font-mono text-emerald-400 font-semibold">{interestPreview} ETH</span> interest over {formatDuration(duration)}.
        </TxSummary>
      )}

      {/* Create Offer Button */}
      <button
        onClick={handleCreateOffer}
        disabled={!isConnected || isPending || isConfirming}
        className="w-full min-h-[44px] rounded-xl text-[13px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: isPending || isConfirming ? 'var(--color-purple-15)' : 'linear-gradient(135deg, rgba(16,185,129,0.3), var(--color-purple-30))',
          border: '1px solid var(--color-purple-30)',
          color: 'white',
        }}
      >
        {!isConnected
          ? 'Connect Wallet'
          : isPending
          ? 'Confirm in Wallet...'
          : isConfirming
          ? 'Creating Offer...'
          : 'Create Loan Offer'}
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   BORROW TAB
   ═══════════════════════════════════════════════════════════════════ */
function BorrowTab({ offerCount }: { offerCount: number }) {
  const [filter, setFilter] = useState<string>('all');
  const [expandedOffer, setExpandedOffer] = useState<number | null>(null);

  // Batch-read all offers
  const offerContracts = useMemo(() => {
    if (offerCount === 0) return [];
    return Array.from({ length: offerCount }, (_, i) => ({
      address: TEGRIDY_NFT_LENDING_ADDRESS,
      abi: TEGRIDY_NFT_LENDING_ABI,
      functionName: 'getOffer' as const,
      args: [BigInt(i + 1)] as const,
    }));
  }, [offerCount]);

  const { data: offersRaw, isLoading: offersLoading } = useReadContracts({
    contracts: offerContracts,
  });

  interface OfferData {
    id: number;
    lender: Address;
    principal: bigint;
    aprBps: bigint;
    duration: bigint;
    collateralContract: Address;
    active: boolean;
  }

  const offers: OfferData[] = useMemo(() => {
    if (!offersRaw) return [];
    const result: OfferData[] = [];
    for (let i = 0; i < offersRaw.length; i++) {
      const r = offersRaw[i]!;
      if (r.status !== 'success' || !r.result) continue;
      const [lender, principal, aprBps, dur, collateral, active] = r.result as [Address, bigint, bigint, bigint, Address, boolean];
      if (!active) continue;
      result.push({ id: i + 1, lender, principal, aprBps, duration: dur, collateralContract: collateral, active });
    }
    return result;
  }, [offersRaw]);

  const filteredOffers = useMemo(() => {
    if (filter === 'all') return offers;
    const col = COLLECTIONS.find((c) => c.symbol === filter);
    if (!col) return offers;
    return offers.filter((o) => o.collateralContract.toLowerCase() === col.address.toLowerCase());
  }, [offers, filter]);

  // Best rate highlights
  const bestApr = useMemo(() => {
    if (filteredOffers.length === 0) return null;
    return Math.min(...filteredOffers.map(o => Number(o.aprBps)));
  }, [filteredOffers]);

  const quickestDuration = useMemo(() => {
    if (filteredOffers.length === 0) return null;
    return Math.min(...filteredOffers.map(o => Number(o.duration)));
  }, [filteredOffers]);

  const largestPrincipal = useMemo(() => {
    if (filteredOffers.length === 0) return null;
    return filteredOffers.reduce((max, o) => o.principal > max ? o.principal : max, 0n);
  }, [filteredOffers]);

  return (
    <div className="space-y-5">
      {/* Collection filter cards — matched to the Lend tab's card size
          (aspect-square, full-bleed art, green name + symbol labels) so both
          tabs feel like the same picker. "All" stands in for every collection
          and uses the gallery collage. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(['all', ...COLLECTIONS.map((c) => c.symbol)] as const).map((f) => {
          const art =
            f === 'all' ? ART.galleryCollage.src : COLLECTION_ART[f] ?? ART.galleryCollage.src;
          const isActive = filter === f;
          const col = f === 'all' ? null : COLLECTIONS.find((c) => c.symbol === f) ?? null;
          const title = f === 'all' ? 'All Collections' : col?.name ?? f;
          const badge = f === 'all' ? 'ALL' : f;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`relative overflow-hidden aspect-square rounded-xl text-left transition-all ${
                isActive
                  ? 'border-2 border-emerald-500/70 text-white'
                  : 'border border-white/10 text-white hover:border-white/25'
              }`}
            >
              <img src={art} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
              <div className="absolute inset-0 p-3 flex flex-col justify-end items-start">
                <span
                  className="inline-block text-[15px] font-semibold px-2 py-0.5 rounded"
                  style={{ color: '#22c55e', background: 'rgba(0,0,0,0.85)', textShadow: '0 1px 4px rgba(0,0,0,0.95)' }}
                >
                  {title}
                </span>
                <span
                  className="inline-block text-[11px] font-mono px-2 py-0.5 mt-0.5 rounded"
                  style={{ color: '#22c55e', background: 'rgba(0,0,0,0.85)', textShadow: '0 1px 4px rgba(0,0,0,0.95)' }}
                >
                  {badge}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Best Rate Highlights */}
      {filteredOffers.length > 0 && bestApr !== null && (
        <div
          className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl px-4 py-2.5"
          style={{ background: 'rgba(16, 185, 129, 0.06)', border: '1px solid rgba(16, 185, 129, 0.12)' }}
        >
          <span className="text-[11px] text-white/85 uppercase tracking-wider">Highlights:</span>
          <span className="text-[12px] text-emerald-400 font-medium">Best APR: {bpsToPercent(bestApr)}%</span>
          {quickestDuration !== null && (
            <span className="text-[12px] text-purple-400 font-medium">Quickest: {formatDuration(quickestDuration)}</span>
          )}
          {largestPrincipal !== null && (
            <span className="text-[12px] text-blue-400 font-medium">Largest: {parseFloat(formatEther(largestPrincipal)).toFixed(2)} ETH</span>
          )}
        </div>
      )}

      {/* Offers */}
      {offersLoading ? (
        <div className="text-center py-12 text-white/70 text-[13px]">Loading offers...</div>
      ) : filteredOffers.length === 0 ? (
        <div
          className="relative overflow-hidden rounded-xl"
          style={{ border: `1px solid ${CARD_BORDER}` }}
        >
          <ArtImg pageId="nft-lending" idx={4} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
          <div
            className="relative z-10 m-2 rounded-lg p-6 md:p-8 text-center"
            style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <p className="text-[13px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
              No offers {filter !== 'all' ? `for ${filter} ` : ''}yet.
            </p>
            <p className="text-[11px] mt-1" style={{ color: '#22c55e', opacity: 0.85, textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
              Be the first! Switch to the Lend tab to create an offer.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredOffers.map((offer) => (
            <OfferCard
              key={offer.id}
              offer={offer}
              isExpanded={expandedOffer === offer.id}
              onToggle={() => setExpandedOffer(expandedOffer === offer.id ? null : offer.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── NFT Collateral Picker ───────────────────────────────────────
 * Replaces the former bare "Your NFT Token ID" number input with a
 * wallet-scoped gallery, so borrowers can pick the NFT they're about
 * to collateralize instead of having to look up a token ID off-page.
 *
 * Data: calls `/api/alchemy?endpoint=getNFTsForOwner` (rate-limited,
 * API-key-hidden server proxy) filtered to the single collection the
 * current offer accepts. Thumbnails are drawn from the NFT's `image`
 * field with a graceful fallback to the collection art + #tokenId
 * badge when the image link is missing or 404s.
 *
 * UX:
 *   - Loading: a row of 3 skeleton tiles.
 *   - Success with ≥1 owned NFT: scrollable grid; click to select.
 *     Selected tile gets a purple ring + checkmark.
 *   - Success with 0 owned: "You don't own any NFTs in this collection"
 *     empty state plus the legacy text input as a fallback so the
 *     borrower isn't blocked (maybe they plan to transfer one in).
 *   - Fetch error: same fallback input, with a line explaining the
 *     picker couldn't load.
 *
 * Rate-limit aware: ≤1 request per (owner, collection, mount) so the
 * user switching between offer expansions doesn't hammer the proxy.
 */
interface OwnedNft {
  tokenId: string;
  name?: string;
  image?: string;
}

function NFTCollateralPicker({
  collectionContract,
  selectedTokenId,
  onSelect,
}: {
  collectionContract: Address;
  selectedTokenId: string;
  onSelect: (tokenId: string) => void;
}) {
  const { address } = useAccount();
  const [nfts, setNfts] = useState<OwnedNft[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualEntry, setManualEntry] = useState(false);

  useEffect(() => {
    if (!address) {
      setNfts(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const url =
      `/api/alchemy?endpoint=getNFTsForOwner&owner=${address}` +
      `&contractAddresses%5B%5D=${collectionContract}` +
      `&pageSize=50&withMetadata=true`;
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const ownedRaw: unknown = data?.ownedNfts ?? [];
        if (!Array.isArray(ownedRaw)) throw new Error('Unexpected response shape');
        const parsed: OwnedNft[] = ownedRaw.flatMap((n) => {
          if (!n || typeof n !== 'object') return [];
          const row = n as Record<string, unknown>;
          const tokenId =
            typeof row.tokenId === 'string' ? row.tokenId :
            typeof row.id === 'object' && row.id && typeof (row.id as Record<string, unknown>).tokenId === 'string'
              ? String((row.id as Record<string, unknown>).tokenId)
              : null;
          if (!tokenId) return [];
          const name = typeof row.name === 'string' ? row.name : undefined;
          const imageObj = row.image as Record<string, unknown> | undefined;
          const imageUrl =
            typeof imageObj?.cachedUrl === 'string' ? imageObj.cachedUrl :
            typeof imageObj?.thumbnailUrl === 'string' ? imageObj.thumbnailUrl :
            typeof imageObj?.originalUrl === 'string' ? imageObj.originalUrl :
            typeof row.image === 'string' ? row.image :
            undefined;
          return [{ tokenId, name, image: imageUrl }];
        });
        setNfts(parsed);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load NFTs');
        setNfts(null);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [address, collectionContract]);

  const fallbackArt = COLLECTION_ART[collectionName(collectionContract)] ?? '/art/bobowelie.jpg';
  const hasNfts = !!nfts && nfts.length > 0;

  // Manual entry appears when (a) fetch failed, (b) user has none, or
  // (c) user toggles it. Keeps the borrower unblocked even if Alchemy
  // is down or the NFT just landed in their wallet mid-session.
  const showManual = manualEntry || !!error || (!!nfts && nfts.length === 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-white/85 text-[11px] uppercase tracking-wider block">
          {hasNfts ? 'Pick Your NFT' : 'Your NFT Token ID'}
        </label>
        {hasNfts && (
          <button
            type="button"
            onClick={() => setManualEntry((m) => !m)}
            className="text-[10px] text-white/60 hover:text-white underline underline-offset-2"
          >
            {manualEntry ? 'Pick from wallet' : 'Enter ID manually'}
          </button>
        )}
      </div>

      {loading && (
        <div className="grid grid-cols-4 sm:grid-cols-5 gap-2" aria-label="Loading your NFTs">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="aspect-square rounded-lg bg-white/5 animate-pulse"
              style={{ border: `1px solid ${CARD_BORDER}` }}
            />
          ))}
        </div>
      )}

      {!loading && hasNfts && !manualEntry && (
        <div
          className="grid grid-cols-4 sm:grid-cols-5 gap-2 max-h-[220px] overflow-y-auto pr-1"
          role="radiogroup"
          aria-label={`Your ${collectionName(collectionContract)} NFTs`}
        >
          {nfts!.map((nft) => {
            const active = nft.tokenId === selectedTokenId;
            return (
              <button
                key={nft.tokenId}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onSelect(nft.tokenId)}
                title={nft.name ? `${nft.name} · #${nft.tokenId}` : `#${nft.tokenId}`}
                className={`relative aspect-square rounded-lg overflow-hidden transition-all focus-visible:ring-2 focus-visible:ring-purple-400 focus-visible:outline-none`}
                style={{
                  border: active
                    ? '2px solid rgb(139 92 246)'
                    : `1px solid ${CARD_BORDER}`,
                  background: 'rgba(13,21,48,0.8)',
                }}
              >
                <img
                  src={nft.image || fallbackArt}
                  alt={nft.name ?? `NFT ${nft.tokenId}`}
                  loading="lazy"
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (img.src !== fallbackArt) img.src = fallbackArt;
                  }}
                />
                <span
                  className="absolute bottom-0 left-0 right-0 px-1.5 py-0.5 text-[10px] font-mono text-white bg-gradient-to-t from-black/85 to-transparent truncate"
                  style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}
                >
                  #{nft.tokenId}
                </span>
                {active && (
                  <span
                    aria-hidden
                    className="absolute top-1 right-1 w-4 h-4 rounded-full bg-purple-500 flex items-center justify-center text-white text-[10px] font-bold"
                  >
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {!loading && showManual && (
        <>
          {error && (
            <p className="text-[11px] text-amber-300 mb-1.5" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
              Couldn't load your NFTs from the indexer. Enter a token ID manually — the contract validates ownership anyway.
            </p>
          )}
          {!error && nfts && nfts.length === 0 && !manualEntry && (
            <p className="text-[11px] text-white/60 mb-1.5" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
              You don't own any {collectionName(collectionContract)} NFTs yet. Enter a token ID below if one is on the way.
            </p>
          )}
          <input
            type="number"
            step="1"
            min="0"
            placeholder="e.g. 1234"
            value={selectedTokenId}
            onChange={(e) => onSelect(e.target.value)}
            className="w-full min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50 placeholder:text-white/85"
            style={{ background: 'rgba(13,21,48,0.8)', border: `1px solid ${CARD_BORDER}` }}
          />
        </>
      )}
    </div>
  );
}

/* ─── Offer Card ────────────────────────────────────────────────── */
function OfferCard({
  offer,
  isExpanded,
  onToggle,
}: {
  offer: {
    id: number;
    lender: Address;
    principal: bigint;
    aprBps: bigint;
    duration: bigint;
    collateralContract: Address;
  };
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { isConnected } = useAccount();
  const [tokenId, setTokenId] = useState('');

  const { writeContract: approveNft, data: approveTx, isPending: approving } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveTx });

  const { writeContract: acceptOffer, data: acceptTx, isPending: accepting } = useWriteContract();
  const { isLoading: acceptConfirming, isSuccess: acceptSuccess } = useWaitForTransactionReceipt({ hash: acceptTx });

  useEffect(() => {
    if (approveSuccess) {
      toast.success('NFT approved! Now accept the offer.');
    }
  }, [approveSuccess]);

  useEffect(() => {
    if (acceptSuccess) {
      toast.success('Offer accepted! Loan created.');
      setTokenId('');
    }
  }, [acceptSuccess]);

  const handleApprove = () => {
    if (!tokenId) {
      toast.error('Enter a token ID');
      return;
    }
    approveNft({
      address: offer.collateralContract,
      abi: ERC721_ABI,
      functionName: 'approve',
      args: [TEGRIDY_NFT_LENDING_ADDRESS, BigInt(tokenId)],
    });
  };

  const handleAccept = () => {
    if (!tokenId) {
      toast.error('Enter a token ID');
      return;
    }
    acceptOffer({
      address: TEGRIDY_NFT_LENDING_ADDRESS,
      abi: TEGRIDY_NFT_LENDING_ABI,
      functionName: 'acceptOffer',
      args: [BigInt(offer.id), BigInt(tokenId)],
    });
  };

  return (
    <div
      className="rounded-xl overflow-hidden cursor-pointer transition-all hover:border-purple-500/25"
      style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
      onClick={onToggle}
    >
      <div className="p-3 md:p-5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-white/70 text-[11px] font-mono">Offer #{offer.id}</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
            {collectionName(offer.collateralContract)}
          </span>
        </div>
        <div>
          <p className="text-white text-xl font-semibold">{parseFloat(formatEther(offer.principal)).toFixed(4)} ETH</p>
          <p className="text-white/70 text-[11px]">Principal</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <p className="text-emerald-400 text-[13px] font-medium">{bpsToPercent(Number(offer.aprBps))}%</p>
            <p className="text-white/70 text-[11px]">APR</p>
          </div>
          <div>
            <p className="text-purple-400 text-[13px] font-medium">{formatDuration(Number(offer.duration))}</p>
            <p className="text-white/70 text-[11px]">Duration</p>
          </div>
          <div className="truncate">
            <p className="text-white/80 text-[13px] font-mono truncate">{shortenAddress(offer.lender)}</p>
            <p className="text-white/70 text-[11px]">Lender</p>
          </div>
        </div>
      </div>

      {/* Expanded: Accept UI */}
      <AnimatePresence>
        {isExpanded && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ ease: EASE }}
            className="overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 pb-3 md:px-5 md:pb-5 space-y-3 border-t border-white/5 pt-3">
              <NFTCollateralPicker
                collectionContract={offer.collateralContract}
                selectedTokenId={tokenId}
                onSelect={setTokenId}
              />

              {/* Repayment Preview */}
              {tokenId && (
                <TxSummary>
                  {(() => {
                    const principalEth = parseFloat(formatEther(offer.principal));
                    const maxInterest = principalEth * (Number(offer.aprBps) / 10000) * (Number(offer.duration) / 31536000);
                    const totalRepay = principalEth + maxInterest;
                    return (
                      <>
                        You'll lock <span className="font-mono text-white font-semibold">{collectionName(offer.collateralContract)} #{tokenId}</span> and receive <span className="font-mono text-white font-semibold">{principalEth.toFixed(4)} ETH</span>.
                        Total repayment: <span className="font-mono text-emerald-400 font-semibold">{totalRepay.toFixed(6)} ETH</span> ({principalEth.toFixed(4)} + {maxInterest.toFixed(6)} interest over {formatDuration(Number(offer.duration))}).
                        <span className="block text-[11px] text-white/70 mt-1">Repay early to save — interest is pro-rata.</span>
                      </>
                    );
                  })()}
                </TxSummary>
              )}

              {/* Risk Warning */}
              {tokenId && (
                <RiskBanner variant="warning">
                  Your {collectionName(offer.collateralContract)} NFT #{tokenId} will be locked as collateral. If you miss the repayment deadline, the lender keeps it permanently.
                </RiskBanner>
              )}

              {/* Step Indicator */}
              <StepIndicator
                steps={['Approve NFT', 'Accept Offer']}
                currentStep={approveSuccess ? 1 : 0}
              />

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleApprove}
                  disabled={!isConnected || approving || approveConfirming || !tokenId || approveSuccess}
                  className="min-h-[44px] rounded-xl text-[13px] font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed text-white"
                  style={{ background: approveSuccess ? 'rgba(16,185,129,0.15)' : 'var(--color-purple-20)', border: `1px solid ${approveSuccess ? 'rgba(16,185,129,0.3)' : 'var(--color-purple-30)'}` }}
                >
                  {approveSuccess ? 'Approved' : approving ? 'Confirm...' : approveConfirming ? 'Approving...' : 'Approve NFT'}
                </button>
                <button
                  onClick={handleAccept}
                  disabled={!isConnected || accepting || acceptConfirming || !tokenId}
                  className="min-h-[44px] rounded-xl text-[13px] font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed text-white"
                  style={{
                    background: 'linear-gradient(135deg, rgba(16,185,129,0.25), var(--color-purple-25))',
                    border: '1px solid rgba(16,185,129,0.3)',
                  }}
                >
                  {accepting ? 'Confirm...' : acceptConfirming ? 'Accepting...' : 'Accept Offer'}
                </button>
              </div>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MY LOANS TAB
   ═══════════════════════════════════════════════════════════════════ */
function MyLoansTab({ loanCount }: { loanCount: number }) {
  const { address, isConnected } = useAccount();

  // Batch-read all loans
  const loanContracts = useMemo(() => {
    if (loanCount === 0) return [];
    return Array.from({ length: loanCount }, (_, i) => ({
      address: TEGRIDY_NFT_LENDING_ADDRESS,
      abi: TEGRIDY_NFT_LENDING_ABI,
      functionName: 'getLoan' as const,
      args: [BigInt(i + 1)] as const,
    }));
  }, [loanCount]);

  const { data: loansRaw, isLoading: loansLoading } = useReadContracts({
    contracts: loanContracts,
  });

  interface ParsedLoan extends LoanData {
    id: number;
  }

  const myLoans: ParsedLoan[] = useMemo(() => {
    if (!loansRaw || !address) return [];
    return loansRaw
      .map((r, i) => {
        if (r.status !== 'success' || !r.result) return null;
        const [borrower, lender, offerId, tokenId, collateralContract, principal, aprBps, startTime, deadline, repaid, defaultClaimed] =
          r.result as [Address, Address, bigint, bigint, Address, bigint, bigint, bigint, bigint, boolean, boolean];
        // Only show loans where user is borrower or lender
        if (borrower.toLowerCase() !== address.toLowerCase() && lender.toLowerCase() !== address.toLowerCase()) return null;
        return {
          id: i + 1,
          borrower,
          lender,
          offerId,
          tokenId,
          collateralContract,
          principal,
          aprBps,
          startTime,
          deadline,
          repaid,
          defaultClaimed,
        };
      })
      .filter((l): l is ParsedLoan => l !== null);
  }, [loansRaw, address]);

  if (!isConnected) {
    return (
      <div
        className="rounded-xl p-8 text-center"
        style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
      >
        <p className="text-white/70 text-[13px]">Connect your wallet to view your loans.</p>
      </div>
    );
  }

  if (loansLoading) {
    return <div className="text-center py-12 text-white/70 text-[13px]">Loading loans...</div>;
  }

  if (myLoans.length === 0) {
    return (
      <div
        className="rounded-xl p-8 text-center"
        style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
      >
        <p className="text-white/70 text-[13px]">No loans yet.</p>
        <p className="text-white/70 text-[11px] mt-1">Browse available offers in the Borrow tab to get started, or create your own in the Lend tab!</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {myLoans.map((loan) => (
        <LoanCard key={loan.id} loan={loan} userAddress={address!} />
      ))}
    </div>
  );
}

/* ─── Loan Card ─────────────────────────────────────────────────── */
function LoanCard({ loan, userAddress }: { loan: LoanData & { id: number }; userAddress: Address }) {
  const status = getLoanStatus(loan);
  const colors = STATUS_COLORS[status] ?? { text: 'text-white/80', border: 'border-white/20', bg: 'rgba(255,255,255,0.05)' };
  const isBorrower = loan.borrower.toLowerCase() === userAddress.toLowerCase();
  const isLender = loan.lender.toLowerCase() === userAddress.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const deadline = Number(loan.deadline);
  const timeLeft = deadline - now;

  // Read repayment amount for borrower
  const { data: repaymentData } = useReadContract({
    address: TEGRIDY_NFT_LENDING_ADDRESS,
    abi: TEGRIDY_NFT_LENDING_ABI,
    functionName: 'getRepaymentAmount',
    args: [BigInt(loan.id)],
    query: { enabled: isBorrower && status === 'active' },
  });

  const { writeContract: repayLoan, data: repayTx, isPending: repaying } = useWriteContract();
  const { isLoading: repayConfirming, isSuccess: repaySuccess } = useWaitForTransactionReceipt({ hash: repayTx });

  const { writeContract: claimDefault, data: claimTx, isPending: claiming } = useWriteContract();
  const { isLoading: claimConfirming, isSuccess: claimSuccess } = useWaitForTransactionReceipt({ hash: claimTx });

  useEffect(() => {
    if (repaySuccess) toast.success('Loan repaid! Your NFT has been returned.');
  }, [repaySuccess]);

  useEffect(() => {
    if (claimSuccess) toast.success('Default claimed! NFT transferred to you.');
  }, [claimSuccess]);

  const handleRepay = () => {
    if (!repaymentData) {
      toast.error('Could not read repayment amount');
      return;
    }
    repayLoan({
      address: TEGRIDY_NFT_LENDING_ADDRESS,
      abi: TEGRIDY_NFT_LENDING_ABI,
      functionName: 'repayLoan',
      args: [BigInt(loan.id)],
      value: repaymentData as bigint,
    });
  };

  const handleClaimDefault = () => {
    claimDefault({
      address: TEGRIDY_NFT_LENDING_ADDRESS,
      abi: TEGRIDY_NFT_LENDING_ABI,
      functionName: 'claimDefault',
      args: [BigInt(loan.id)],
    });
  };

  const deadlineStr = (() => {
    if (status === 'repaid' || status === 'defaulted') return '--';
    if (timeLeft <= 0) return 'Expired';
    const days = Math.floor(timeLeft / 86400);
    const hrs = Math.floor((timeLeft % 86400) / 3600);
    if (days > 0) return `${days}d ${hrs}h`;
    const mins = Math.floor((timeLeft % 3600) / 60);
    return `${hrs}h ${mins}m`;
  })();

  return (
    <div
      className="rounded-xl p-3 md:p-5 space-y-3"
      style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-white/70 text-[11px] font-mono">Loan #{loan.id}</span>
        <div className="flex items-center gap-2">
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full border ${colors.text} ${colors.border}`}
            style={{ background: colors.bg }}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </span>
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full border ${
              isBorrower ? 'text-blue-400 border-blue-500/30 bg-blue-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10'
            }`}
          >
            {isBorrower ? 'Borrower' : 'Lender'}
          </span>
        </div>
      </div>

      {/* Info */}
      <div>
        <p className="text-white text-xl font-semibold">{parseFloat(formatEther(loan.principal)).toFixed(4)} ETH</p>
        <p className="text-white/70 text-[11px]">Principal</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <p className="text-emerald-400 text-[13px] font-medium">{bpsToPercent(Number(loan.aprBps))}%</p>
          <p className="text-white/70 text-[11px]">APR</p>
        </div>
        <div>
          <p className="text-purple-400 text-[13px] font-medium">{collectionName(loan.collateralContract)}</p>
          <p className="text-white/70 text-[11px]">Collection</p>
        </div>
        <div>
          <p className="text-white/70 text-[13px] font-mono">#{loan.tokenId.toString()}</p>
          <p className="text-white/70 text-[11px]">Token</p>
        </div>
      </div>

      {/* Deadline */}
      {(status === 'active' || status === 'overdue') && (
        <div
          className="rounded-lg p-2 text-center"
          style={{
            background: status === 'overdue' ? 'rgba(234,179,8,0.08)' : 'var(--color-purple-08)',
            border: `1px solid ${status === 'overdue' ? 'rgba(234,179,8,0.2)' : 'var(--color-purple-15)'}`,
          }}
        >
          <p className={`text-[11px] ${status === 'overdue' ? 'text-yellow-400' : 'text-white/70'}`}>
            {status === 'overdue' ? 'OVERDUE' : 'Time Remaining'}
          </p>
          <p className={`text-[13px] font-semibold ${status === 'overdue' ? 'text-yellow-400' : 'text-white'}`}>
            {deadlineStr}
          </p>
        </div>
      )}

      {/* Repayment Amount */}
      {isBorrower && status === 'active' && repaymentData && (
        <div className="rounded-lg p-2 text-center" style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)' }}>
          <p className="text-white/70 text-[11px]">Repayment Amount</p>
          <p className="text-emerald-400 text-[13px] font-semibold">
            {parseFloat(formatEther(repaymentData as bigint)).toFixed(6)} ETH
          </p>
        </div>
      )}

      {/* Actions */}
      {isBorrower && status === 'active' && (
        <button
          onClick={handleRepay}
          disabled={repaying || repayConfirming}
          className="w-full min-h-[44px] rounded-xl text-[13px] font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: 'linear-gradient(135deg, rgba(16,185,129,0.25), var(--color-purple-25))',
            border: '1px solid rgba(16,185,129,0.3)',
          }}
        >
          {repaying ? 'Confirm in Wallet...' : repayConfirming ? 'Repaying...' : 'Repay Loan'}
        </button>
      )}

      {isLender && (status === 'overdue') && (
        <button
          onClick={handleClaimDefault}
          disabled={claiming || claimConfirming}
          className="w-full min-h-[44px] rounded-xl text-[13px] font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)' }}
        >
          {claiming ? 'Confirm in Wallet...' : claimConfirming ? 'Claiming...' : 'Claim Default'}
        </button>
      )}
    </div>
  );
}
