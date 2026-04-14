import { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther, parseEther, type Address } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_NFT_LENDING_ADDRESS } from '../../lib/constants';
import { TEGRIDY_NFT_LENDING_ABI, ERC721_ABI } from '../../lib/contracts';
// ART import available for future card backgrounds
// import { ART } from '../../lib/artConfig';

/* ─── Constants ─────────────────────────────────────────────────── */
const CARD_BG = 'rgba(13, 21, 48, 0.6)';
const CARD_BORDER = 'rgba(139, 92, 246, 0.12)';
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
  repaid: { bg: 'rgba(139,92,246,0.12)', text: 'text-purple-400', border: 'border-purple-500/30' },
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
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ease: EASE }}>
        <h2 className="heading-luxury text-xl md:text-2xl text-white mb-2">NFT Lending</h2>
        <p className="text-white/70 text-[13px]">
          Borrow ETH against your NFTs or lend ETH and earn interest. P2P — no oracles, no liquidations.
        </p>
      </motion.div>

      {/* Stats Bar */}
      <motion.div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ease: EASE, delay: 0.03 }}
      >
        {[
          { label: 'Total Offers', value: offerCount.toString() },
          { label: 'Active Loans', value: loanCount.toString() },
          { label: 'Protocol Fee', value: `${bpsToPercent(protocolFeeBps)}%` },
          { label: 'Collections', value: COLLECTIONS.length.toString() },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-xl p-3 md:p-5"
            style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
          >
            <p className="text-white/50 text-[11px] uppercase tracking-wider mb-1">{s.label}</p>
            <p className="text-white text-xl font-semibold">{s.value}</p>
          </div>
        ))}
      </motion.div>

      {/* Tab Navigation */}
      <motion.div
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
              activeTab === tab ? 'text-white' : 'text-white/50 hover:text-white/70'
            }`}
          >
            {activeTab === tab && (
              <motion.div
                layoutId="lending-tab-indicator"
                className="absolute inset-0 rounded-lg"
                style={{ background: 'rgba(139, 92, 246, 0.2)', border: '1px solid rgba(139, 92, 246, 0.3)' }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              />
            )}
            <span className="relative z-10">{tab}</span>
          </button>
        ))}
      </motion.div>

      {/* Tab Content */}
      <AnimatePresence mode="wait">
        {activeTab === 'Lend' && (
          <motion.div key="lend" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ ease: EASE }}>
            <LendTab />
          </motion.div>
        )}
        {activeTab === 'Borrow' && (
          <motion.div key="borrow" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ ease: EASE }}>
            <BorrowTab offerCount={offerCount} />
          </motion.div>
        )}
        {activeTab === 'My Loans' && (
          <motion.div key="myloans" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ ease: EASE }}>
            <MyLoansTab loanCount={loanCount} />
          </motion.div>
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
        <label className="text-white/50 text-[11px] uppercase tracking-wider mb-2 block">Collateral Collection</label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {COLLECTIONS.map((c) => (
            <button
              key={c.address}
              onClick={() => setSelectedCollection(c.address)}
              className={`min-h-[44px] rounded-xl p-3 text-left transition-all ${
                selectedCollection === c.address
                  ? 'bg-emerald-500/15 border border-emerald-500/40 text-white'
                  : 'border border-white/5 text-white/60 hover:border-white/15 hover:text-white/80'
              }`}
              style={selectedCollection !== c.address ? { background: CARD_BG } : undefined}
            >
              <span className="text-[13px] font-medium block">{c.name}</span>
              <span className="text-[11px] opacity-60 font-mono">{c.symbol}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Principal + APR */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-white/50 text-[11px] uppercase tracking-wider mb-2 block">Principal (ETH)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            className="w-full min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50 placeholder:text-white/20"
            style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
          />
        </div>
        <div>
          <label className="text-white/50 text-[11px] uppercase tracking-wider mb-2 block">
            APR (bps){' '}
            {aprBps && parseInt(aprBps) > 0 && (
              <span className="text-emerald-400 normal-case">({bpsToPercent(parseInt(aprBps))}%)</span>
            )}
          </label>
          <input
            type="number"
            step="1"
            min="0"
            placeholder="e.g. 1000 = 10%"
            value={aprBps}
            onChange={(e) => setAprBps(e.target.value)}
            className="w-full min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50 placeholder:text-white/20"
            style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
          />
        </div>
      </div>

      {/* Duration Presets */}
      <div>
        <label className="text-white/50 text-[11px] uppercase tracking-wider mb-2 block">Loan Duration</label>
        <div className="flex flex-wrap gap-2">
          {DURATION_PRESETS.map((d) => (
            <button
              key={d.seconds}
              onClick={() => setDuration(d.seconds)}
              className={`min-h-[44px] px-4 py-2 rounded-xl text-[13px] font-medium transition-all ${
                duration === d.seconds
                  ? 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-400'
                  : 'border border-white/5 text-white/50 hover:text-white/70 hover:border-white/15'
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
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl p-3 md:p-5"
          style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}
        >
          <p className="text-white/50 text-[11px] uppercase tracking-wider mb-1">Estimated Interest Earned</p>
          <p className="text-emerald-400 text-xl font-semibold">{interestPreview} ETH</p>
          <p className="text-white/40 text-[11px] mt-1">
            {principal} ETH at {bpsToPercent(parseInt(aprBps))}% APR for {formatDuration(duration)}
          </p>
        </motion.div>
      )}

      {/* Create Offer Button */}
      <button
        onClick={handleCreateOffer}
        disabled={!isConnected || isPending || isConfirming}
        className="w-full min-h-[44px] rounded-xl text-[13px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: isPending || isConfirming ? 'rgba(139,92,246,0.15)' : 'linear-gradient(135deg, rgba(16,185,129,0.3), rgba(139,92,246,0.3))',
          border: '1px solid rgba(139, 92, 246, 0.3)',
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

  return (
    <div className="space-y-5">
      {/* Filter Pills */}
      <div className="flex flex-wrap gap-2">
        {['all', ...COLLECTIONS.map((c) => c.symbol)].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`min-h-[44px] px-4 py-2 rounded-xl text-[13px] font-medium transition-all ${
              filter === f
                ? 'bg-purple-500/15 border border-purple-500/40 text-purple-400'
                : 'border border-white/5 text-white/50 hover:text-white/70 hover:border-white/15'
            }`}
            style={filter !== f ? { background: CARD_BG } : undefined}
          >
            {f === 'all' ? 'All' : f}
          </button>
        ))}
      </div>

      {/* Offers */}
      {offersLoading ? (
        <div className="text-center py-12 text-white/40 text-[13px]">Loading offers...</div>
      ) : filteredOffers.length === 0 ? (
        <div
          className="rounded-xl p-8 text-center"
          style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
        >
          <p className="text-white/40 text-[13px]">No active offers found{filter !== 'all' ? ` for ${filter}` : ''}.</p>
          <p className="text-white/25 text-[11px] mt-1">Check back later or switch to the Lend tab to create one.</p>
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
          <span className="text-white/40 text-[11px] font-mono">Offer #{offer.id}</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
            {collectionName(offer.collateralContract)}
          </span>
        </div>
        <div>
          <p className="text-white text-xl font-semibold">{parseFloat(formatEther(offer.principal)).toFixed(4)} ETH</p>
          <p className="text-white/40 text-[11px]">Principal</p>
        </div>
        <div className="flex gap-4">
          <div>
            <p className="text-emerald-400 text-[13px] font-medium">{bpsToPercent(Number(offer.aprBps))}%</p>
            <p className="text-white/40 text-[11px]">APR</p>
          </div>
          <div>
            <p className="text-purple-400 text-[13px] font-medium">{formatDuration(Number(offer.duration))}</p>
            <p className="text-white/40 text-[11px]">Duration</p>
          </div>
          <div>
            <p className="text-white/60 text-[13px] font-mono">{shortenAddress(offer.lender)}</p>
            <p className="text-white/40 text-[11px]">Lender</p>
          </div>
        </div>
      </div>

      {/* Expanded: Accept UI */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ ease: EASE }}
            className="overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 pb-3 md:px-5 md:pb-5 space-y-3 border-t border-white/5 pt-3">
              <div>
                <label className="text-white/50 text-[11px] uppercase tracking-wider mb-1 block">Your NFT Token ID</label>
                <input
                  type="number"
                  step="1"
                  min="0"
                  placeholder="e.g. 1234"
                  value={tokenId}
                  onChange={(e) => setTokenId(e.target.value)}
                  className="w-full min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50 placeholder:text-white/20"
                  style={{ background: 'rgba(13,21,48,0.8)', border: `1px solid ${CARD_BORDER}` }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleApprove}
                  disabled={!isConnected || approving || approveConfirming || !tokenId}
                  className="min-h-[44px] rounded-xl text-[13px] font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed text-white"
                  style={{ background: 'rgba(139,92,246,0.2)', border: '1px solid rgba(139,92,246,0.3)' }}
                >
                  {approving ? 'Confirm...' : approveConfirming ? 'Approving...' : 'Approve NFT'}
                </button>
                <button
                  onClick={handleAccept}
                  disabled={!isConnected || accepting || acceptConfirming || !tokenId}
                  className="min-h-[44px] rounded-xl text-[13px] font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed text-white"
                  style={{
                    background: 'linear-gradient(135deg, rgba(16,185,129,0.25), rgba(139,92,246,0.25))',
                    border: '1px solid rgba(16,185,129,0.3)',
                  }}
                >
                  {accepting ? 'Confirm...' : acceptConfirming ? 'Accepting...' : 'Accept Offer'}
                </button>
              </div>
            </div>
          </motion.div>
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
        <p className="text-white/40 text-[13px]">Connect your wallet to view your loans.</p>
      </div>
    );
  }

  if (loansLoading) {
    return <div className="text-center py-12 text-white/40 text-[13px]">Loading loans...</div>;
  }

  if (myLoans.length === 0) {
    return (
      <div
        className="rounded-xl p-8 text-center"
        style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
      >
        <p className="text-white/40 text-[13px]">You have no active or past loans.</p>
        <p className="text-white/25 text-[11px] mt-1">Accept an offer in the Borrow tab or create one in the Lend tab.</p>
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
  const colors = STATUS_COLORS[status] ?? { text: 'text-white/60', border: 'border-white/20', bg: 'rgba(255,255,255,0.05)' };
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
        <span className="text-white/40 text-[11px] font-mono">Loan #{loan.id}</span>
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
        <p className="text-white/40 text-[11px]">Principal</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <p className="text-emerald-400 text-[13px] font-medium">{bpsToPercent(Number(loan.aprBps))}%</p>
          <p className="text-white/40 text-[11px]">APR</p>
        </div>
        <div>
          <p className="text-purple-400 text-[13px] font-medium">{collectionName(loan.collateralContract)}</p>
          <p className="text-white/40 text-[11px]">Collection</p>
        </div>
        <div>
          <p className="text-white/70 text-[13px] font-mono">#{loan.tokenId.toString()}</p>
          <p className="text-white/40 text-[11px]">Token</p>
        </div>
      </div>

      {/* Deadline */}
      {(status === 'active' || status === 'overdue') && (
        <div
          className="rounded-lg p-2 text-center"
          style={{
            background: status === 'overdue' ? 'rgba(234,179,8,0.08)' : 'rgba(139,92,246,0.08)',
            border: `1px solid ${status === 'overdue' ? 'rgba(234,179,8,0.2)' : 'rgba(139,92,246,0.15)'}`,
          }}
        >
          <p className={`text-[11px] ${status === 'overdue' ? 'text-yellow-400' : 'text-white/50'}`}>
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
          <p className="text-white/50 text-[11px]">Repayment Amount</p>
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
            background: 'linear-gradient(135deg, rgba(16,185,129,0.25), rgba(139,92,246,0.25))',
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
