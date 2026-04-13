import { useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt, useChains } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { parseEther, formatEther } from 'viem';
import { ART } from '../lib/artConfig';
import { TEGRIDY_LAUNCHPAD_ADDRESS, isDeployed } from '../lib/constants';
import { TEGRIDY_LAUNCHPAD_ABI, TEGRIDY_DROP_ABI } from '../lib/contracts';
import { usePageTitle } from '../hooks/usePageTitle';
import { useNFTDrop } from '../hooks/useNFTDrop';
import { toast } from 'sonner';

/* ─── design tokens ─── */
const GLASS =
  'bg-gradient-to-br from-[rgba(13,21,48,0.6)] to-[rgba(6,12,26,0.8)] backdrop-blur-[20px] border border-white/20';
const INPUT =
  'w-full bg-transparent border-b border-white/10 px-1 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors placeholder:text-white';
const LABEL = 'text-[11px] uppercase tracking-wider label-pill text-white mb-1.5 block';
const BTN_EMERALD =
  'bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 transition-colors text-white font-medium disabled:opacity-70 disabled:pointer-events-none';

const PHASE_LABELS = ['Paused', 'Allowlist', 'Public'] as const;
const FEATURE_BULLETS = [
  { label: 'ERC-721 Collections', icon: '\u25C8' },
  { label: 'Merkle Allowlists', icon: '\u25CE' },
  { label: 'Dutch Auctions', icon: '\u25C7' },
  { label: 'Delayed Reveals', icon: '\u25C9' },
  { label: 'ERC-2981 Royalties', icon: '\u25C6' },
  { label: 'Revenue Splits', icon: '\u25D0' },
];

const fadeUp = { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35 } };
const fadeUpVariants = { hidden: { opacity: 0, y: 14 }, visible: { opacity: 1, y: 0, transition: { duration: 0.35 } } };
const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } };

/** Return the block explorer address URL for the current chain */
function useExplorerAddressUrl(address: string) {
  const chains = useChains();
  const { chain } = useAccount();
  const activeChain = chain ?? chains[0];
  const base = activeChain?.blockExplorers?.default?.url ?? 'https://etherscan.io';
  return `${base}/address/${address}`;
}

/* ─── Art-backed glass card helper ─── */
function ArtCard({
  art,
  opacity = 1,
  overlay = 'none',
  className = '',
  children,
}: {
  art: { src: string };
  opacity?: number;
  overlay?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl glass-card-animated ${className}`}
      style={{ border: '1px solid rgba(139,92,246,0.75)' }}
    >
      <div className="absolute inset-0">
        <img src={art.src} alt="" className="w-full h-full object-cover" style={{ opacity }} />
        <div className="absolute inset-0" style={{ background: overlay }} />
      </div>
      <div className="relative z-10 p-5">{children}</div>
    </div>
  );
}

/* ─── Phase badge for cards ─── */
function PhaseBadge({ phase }: { phase: number }) {
  const config =
    phase === 2
      ? { color: 'bg-emerald-500', ring: 'ring-emerald-400/30', text: 'text-emerald-300', label: 'Public', pulse: true }
      : phase === 1
        ? { color: 'bg-yellow-500', ring: 'ring-yellow-400/30', text: 'text-yellow-300', label: 'Allowlist', pulse: false }
        : { color: 'bg-gray-500', ring: 'ring-gray-400/20', text: 'text-gray-400', label: 'Paused', pulse: false };

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/40 backdrop-blur-sm ring-1 ${config.ring}`}>
      <span className="relative flex h-2 w-2">
        {config.pulse && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.color} opacity-60`} />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${config.color}`} />
      </span>
      <span className={`text-[10px] font-medium uppercase tracking-wider label-pill ${config.text}`}>
        {config.label}
      </span>
    </div>
  );
}

/* ─────────────────────────── Phase Indicator ─────────────────────────── */

function PhaseIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0">
      {PHASE_LABELS.map((label, i) => (
        <div key={label} className="flex items-center">
          {i > 0 && (
            <div
              className={`w-8 sm:w-12 h-[2px] transition-colors duration-500 ${
                i <= current ? 'bg-emerald-500' : 'bg-black/60'
              }`}
            />
          )}
          <div className="flex flex-col items-center gap-1.5">
            <div
              className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-500 ${
                i === current
                  ? 'border-emerald-400 bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.4)]'
                  : i < current
                    ? 'border-emerald-500/60 bg-emerald-500/30'
                    : 'border-white/15 bg-transparent'
              }`}
            >
              {i <= current && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
            </div>
            <span
              className={`text-[10px] uppercase tracking-wider label-pill ${
                i === current ? 'text-black' : 'text-white'
              }`}
            >
              {label}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────── Collection Card ─────────────────────────── */

function CollectionCard({
  collectionId,
  onSelect,
  selectedAddr,
  deployed,
}: {
  collectionId: number;
  onSelect: (addr: string) => void;
  selectedAddr: string | null;
  deployed: boolean;
}) {
  const { data: collection } = useReadContract({
    address: TEGRIDY_LAUNCHPAD_ADDRESS,
    abi: TEGRIDY_LAUNCHPAD_ABI,
    functionName: 'getCollection',
    args: [BigInt(collectionId)],
  });

  // Read live drop data for this card
  const contractAddr = collection ? (collection as unknown[])[1] as string : '';
  const drop = useNFTDrop(contractAddr);
  const explorerUrl = useExplorerAddressUrl(contractAddr);

  if (!collection) {
    return <div className={`${GLASS} rounded-xl p-5 animate-pulse h-44`} />;
  }

  const [, , creator, name, symbol] = collection as [bigint, string, string, string, string];
  const shortAddr = `${contractAddr.slice(0, 6)}...${contractAddr.slice(-4)}`;
  const shortCreator = `${creator.slice(0, 6)}...${creator.slice(-4)}`;
  const isActive = selectedAddr?.toLowerCase() === contractAddr.toLowerCase();
  const progressPct = drop.maxSupply > 0 ? Math.min(100, (drop.totalMinted / drop.maxSupply) * 100) : 0;

  return (
    <motion.div variants={fadeUpVariants}>
      <ArtCard art={ART.galleryCollage} opacity={1} overlay="none" className={`cursor-pointer transition-all duration-300 group ${
        isActive
          ? 'ring-1 ring-emerald-500/40 shadow-[0_0_24px_-6px_rgba(16,185,129,0.15)]'
          : 'hover:shadow-[0_0_20px_-6px_rgba(16,185,129,0.08)]'
      }`}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(contractAddr)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(contractAddr); } }}
        >
          {/* Phase badge top-right */}
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center text-black font-bold text-xs tracking-wide">
                {symbol.slice(0, 3)}
              </div>
              <div className="min-w-0">
                <h3 className="text-white font-medium truncate">{name}</h3>
                <span className="inline-block text-[10px] uppercase tracking-wider label-pill text-black/70 bg-emerald-500/30 px-1.5 py-0.5 rounded mt-0.5">
                  {symbol}
                </span>
              </div>
            </div>
            <PhaseBadge phase={drop.currentPhase} />
          </div>

          {/* Mini progress bar */}
          <div className="mb-3">
            <div className="flex justify-between text-[10px] text-white mb-1">
              <span className="font-mono tabular-nums">{drop.totalMinted}/{drop.maxSupply}</span>
              <span className="font-mono tabular-nums">{progressPct.toFixed(0)}%</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-black/60 overflow-hidden" role="progressbar" aria-valuenow={Math.round(progressPct)} aria-valuemin={0} aria-valuemax={100}>
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400"
                initial={{ width: 0 }}
                animate={{ width: `${progressPct}%` }}
                transition={{ duration: 0.8, ease: 'easeOut' }}
              />
            </div>
          </div>

          {/* Info rows */}
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between text-white">
              <span>Price</span>
              <span className="text-black/80 font-mono text-xs tabular-nums">{drop.mintPriceFormatted} ETH</span>
            </div>
            <div className="flex justify-between text-white">
              <span>Contract</span>
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-black/80 hover:text-black hover:underline font-mono text-xs"
                onClick={(e) => e.stopPropagation()}
              >
                {shortAddr}
              </a>
            </div>
            <div className="flex justify-between text-white">
              <span>Creator</span>
              <span className="text-white font-mono text-xs">{shortCreator}</span>
            </div>
          </div>
        </div>
      </ArtCard>
    </motion.div>
  );
}

/* ─────────────────────────── Owner Admin Panel ───────────────────────── */

function OwnerAdminPanel({ dropAddress, deployed }: { dropAddress: string; deployed: boolean }) {
  const contractAddr = dropAddress as `0x${string}`;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState('0');
  const [merkleRoot, setMerkleRoot] = useState('');
  const [revealURI, setRevealURI] = useState('');

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });
  const busy = isPending || isConfirming || !deployed;

  const exec = useCallback(
    (fn: string, args?: unknown[], opts?: { onSuccess?: () => void }) => {
      if (!deployed) return;
      writeContract(
        { address: contractAddr, abi: TEGRIDY_DROP_ABI, functionName: fn, args: args as never[] },
        {
          onSuccess: () => {
            toast.success(`${fn} succeeded`);
            opts?.onSuccess?.();
          },
          onError: (e) => toast.error(e.message.slice(0, 80)),
        },
      );
    },
    [contractAddr, writeContract, deployed],
  );

  return (
    <ArtCard art={ART.roseApe} opacity={1} overlay="none" className="mt-6">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between text-sm"
      >
        <span className="text-black font-semibold tracking-wide uppercase text-[11px]">
          Owner Admin
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          className="text-black/50 text-xs"
        >
          \u25BC
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-5 pt-4">
              {!deployed && (
                <p className="text-amber-400/70 text-xs text-center py-2 rounded-lg bg-amber-500/5 border border-amber-500/10">
                  Contract Not Deployed - Admin actions disabled
                </p>
              )}

              {/* Phase Control */}
              <div>
                <label className={LABEL}>Mint Phase</label>
                <div className="grid grid-cols-3 gap-2">
                  {PHASE_LABELS.map((label, i) => (
                    <button
                      key={label}
                      className={`py-2 rounded-lg text-xs font-medium transition-all ${
                        phase === String(i)
                          ? 'bg-emerald-600 text-white shadow-[0_0_12px_-4px_rgba(16,185,129,0.4)]'
                          : 'bg-black/60 text-white hover:text-white border border-white/25 hover:border-white/20'
                      }`}
                      onClick={() => setPhase(String(i))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  className={`mt-2 w-full py-2 rounded-lg text-xs ${BTN_EMERALD}`}
                  disabled={busy}
                  onClick={() => exec('setMintPhase', [Number(phase)])}
                >
                  {isPending || isConfirming ? 'Setting...' : !deployed ? 'Contract Not Deployed' : 'Set Phase'}
                </button>
              </div>

              {/* Merkle Root */}
              <div>
                <label className={LABEL} htmlFor="admin-merkleRoot">Merkle Root</label>
                <input
                  id="admin-merkleRoot"
                  type="text"
                  value={merkleRoot}
                  onChange={(e) => setMerkleRoot(e.target.value)}
                  placeholder="0x..."
                  className={`${INPUT} font-mono text-xs`}
                />
                <button
                  className={`mt-2 w-full py-2 rounded-lg text-xs ${BTN_EMERALD}`}
                  disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(merkleRoot)}
                  onClick={() =>
                    exec('setMerkleRoot', [merkleRoot as `0x${string}`], {
                      onSuccess: () => setMerkleRoot(''),
                    })
                  }
                >
                  {isPending || isConfirming ? 'Setting...' : !deployed ? 'Contract Not Deployed' : 'Set Merkle Root'}
                </button>
              </div>

              {/* Reveal */}
              <div>
                <label className={LABEL} htmlFor="admin-revealURI">Reveal Base URI</label>
                <input
                  id="admin-revealURI"
                  type="text"
                  value={revealURI}
                  onChange={(e) => setRevealURI(e.target.value)}
                  placeholder="ipfs://Qm..."
                  className={`${INPUT} font-mono text-xs`}
                />
                <button
                  className={`mt-2 w-full py-2 rounded-lg text-xs ${BTN_EMERALD}`}
                  disabled={busy || !revealURI}
                  onClick={() =>
                    exec('reveal', [revealURI], { onSuccess: () => setRevealURI('') })
                  }
                >
                  {isPending || isConfirming ? 'Revealing...' : !deployed ? 'Contract Not Deployed' : 'Reveal Collection'}
                </button>
              </div>

              {/* Withdraw */}
              <button
                className="w-full py-2.5 rounded-lg bg-amber-600/70 hover:bg-amber-600 text-white text-xs font-medium border border-amber-500/20 transition-colors disabled:opacity-70 disabled:pointer-events-none"
                disabled={busy}
                onClick={() => exec('withdraw')}
              >
                {isPending || isConfirming ? 'Withdrawing...' : !deployed ? 'Contract Not Deployed' : 'Withdraw Mint Revenue'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </ArtCard>
  );
}

/* ─────────────────────────── Creator Revenue Dashboard ───────────────── */

function CreatorRevenueDashboard({ drop }: { drop: ReturnType<typeof useNFTDrop> }) {
  const totalRevenue = Number(formatEther(drop.mintPrice * BigInt(drop.totalMinted)));

  return (
    <ArtCard art={ART.roseApe} opacity={1} overlay="none" className="mb-6">
      <h3 className="text-black font-semibold tracking-wide uppercase text-[11px] mb-4">
        Creator Revenue Dashboard
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="text-center p-3 rounded-lg bg-black/60 border border-white/20">
          <p className={LABEL}>Total Minted</p>
          <p className="text-white font-mono text-xl tabular-nums">{drop.totalMinted}</p>
        </div>
        <div className="text-center p-3 rounded-lg bg-black/60 border border-white/20">
          <p className={LABEL}>Total Revenue</p>
          <p className="text-white font-mono text-xl tabular-nums">{totalRevenue.toFixed(4)} <span className="text-white text-sm">ETH</span></p>
        </div>
        <div className="text-center p-3 rounded-lg bg-black/60 border border-white/20">
          <p className={LABEL}>Unique Holders</p>
          <p className="text-white font-mono text-xl tabular-nums">--</p>
          <p className="text-[9px] text-white mt-0.5">Coming soon</p>
        </div>
      </div>
    </ArtCard>
  );
}

/* ─────────────────────────── Live Mint Feed ──────────────────────────── */

function LiveMintFeed() {
  const mockMints = [
    { addr: '0x1a2b...3c4d', qty: 3, time: '2m ago' },
    { addr: '0x5e6f...7a8b', qty: 1, time: '5m ago' },
    { addr: '0x9c0d...1e2f', qty: 5, time: '12m ago' },
    { addr: '0x3a4b...5c6d', qty: 2, time: '18m ago' },
  ];

  return (
    <ArtCard art={ART.danceNight} opacity={1} overlay="none" className="mb-6">
      <h3 className="text-black font-semibold tracking-wide uppercase text-[11px] mb-4">
        Live Mint Feed
      </h3>
      <div className="space-y-2.5 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
        {mockMints.map((m, i) => (
          <div
            key={i}
            className="flex items-center justify-between py-2 px-3 rounded-lg bg-black/60 border border-white/20"
          >
            <div className="flex items-center gap-2.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="text-white font-mono text-xs">{m.addr}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-black/80 text-xs font-mono">x{m.qty}</span>
              <span className="text-white text-[10px]">{m.time}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="text-center text-[10px] text-white mt-3">
        Recent mints will appear here when the collection is live
      </p>
    </ArtCard>
  );
}

/* ─────────────────────────── Collection Detail ───────────────────────── */

function CollectionDetail({
  dropAddress,
  onClose,
  deployed,
}: {
  dropAddress: string;
  onClose: () => void;
  deployed: boolean;
}) {
  const { isConnected } = useAccount();
  const drop = useNFTDrop(dropAddress);
  const explorerUrl = useExplorerAddressUrl(dropAddress);
  const [mintQty, setMintQty] = useState(1);
  const [proofInput, setProofInput] = useState('');
  const shortAddr = `${dropAddress.slice(0, 6)}...${dropAddress.slice(-4)}`;

  const totalCost = useMemo(
    () => Number(formatEther(drop.mintPrice * BigInt(mintQty))),
    [drop.mintPrice, mintQty],
  );

  const mintLabel = useMemo(() => {
    if (!deployed) return 'Contract Not Deployed';
    if (!isConnected) return 'Connect Wallet';
    if (drop.isPending) return 'Confirm in Wallet...';
    if (drop.isConfirming) return 'Confirming...';
    if (drop.isSoldOut) return 'Sold Out';
    if (drop.currentPhase === 0) return 'Minting Paused';
    return `Mint ${mintQty} for ${totalCost.toFixed(4)} ETH`;
  }, [deployed, isConnected, drop.isPending, drop.isConfirming, drop.isSoldOut, drop.currentPhase, mintQty, totalCost]);

  const mintDisabled =
    !deployed ||
    !isConnected ||
    drop.isPending ||
    drop.isConfirming ||
    drop.isSoldOut ||
    drop.currentPhase === 0 ||
    (drop.currentPhase === 1 && !proofInput.trim());

  const progressPct = drop.maxSupply > 0 ? Math.min(100, (drop.totalMinted / drop.maxSupply) * 100) : 0;

  const handleMint = useCallback(() => {
    if (!deployed) return;
    const proof = proofInput.trim()
      ? proofInput.split(',').map((s) => s.trim() as `0x${string}`)
      : [];
    drop.mint(mintQty, proof);
  }, [drop, mintQty, proofInput, deployed]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="mb-8"
    >
      {/* Hero */}
      <ArtCard art={ART.beachVibes} opacity={1} overlay="none" className="rounded-2xl mb-0">
        <div className="p-1 sm:p-3">
          <div className="flex items-start justify-between mb-6">
            <div>
              <h2 className="heading-luxury text-xl sm:text-2xl mb-1">Collection Details</h2>
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-black/70 hover:text-black text-xs font-mono hover:underline"
              >
                {shortAddr}
              </a>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-white hover:text-white text-sm transition-colors p-1"
            >
              \u2715
            </button>
          </div>

          {/* Phase Indicator */}
          <div className="flex justify-center mb-8">
            <PhaseIndicator current={drop.currentPhase} />
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            <div className="rounded-xl p-3 sm:p-4 text-center bg-black/60 border border-white/[0.05]">
              <p className={LABEL}>Minted</p>
              <p className="text-white font-mono text-lg tabular-nums">
                {drop.totalMinted}
                <span className="text-white">/{drop.maxSupply}</span>
              </p>
            </div>
            <div className="rounded-xl p-3 sm:p-4 text-center bg-black/60 border border-white/[0.05]">
              <p className={LABEL}>Price</p>
              <p className="text-white font-mono text-lg tabular-nums">{drop.mintPriceFormatted} ETH</p>
            </div>
            <div className="rounded-xl p-3 sm:p-4 text-center bg-black/60 border border-white/[0.05]">
              <p className={LABEL}>Phase</p>
              <p className="text-black font-medium text-lg">{drop.phaseLabel}</p>
            </div>
          </div>

          {/* Progress Bar */}
          {drop.maxSupply > 0 && (
            <div className="mb-8">
              <div className="flex justify-between text-[10px] text-white mb-1.5 uppercase tracking-wider label-pill">
                <span>Progress</span>
                <span className="font-mono tabular-nums">{progressPct.toFixed(1)}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-black/60 overflow-hidden" role="progressbar" aria-valuenow={Math.round(progressPct)} aria-valuemin={0} aria-valuemax={100}>
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400"
                  initial={{ width: 0 }}
                  animate={{ width: `${progressPct}%` }}
                  transition={{ duration: 0.8, ease: 'easeOut' }}
                  style={{
                    boxShadow: progressPct > 0 ? '0 0 12px rgba(16,185,129,0.3)' : 'none',
                  }}
                />
              </div>
            </div>
          )}

          {/* Paused empty state */}
          {drop.currentPhase === 0 && (
            <ArtCard art={ART.towelieWindow} opacity={1} overlay="none" className="mb-6">
              <div className="text-center py-4">
                <div className="text-white/15 text-4xl mb-3">\u23F8</div>
                <p className="text-white text-sm">Minting is currently paused for this collection.</p>
              </div>
            </ArtCard>
          )}

          {/* Mint Interface */}
          <ArtCard art={ART.danceNight} opacity={1} overlay="none">
            <div className="space-y-4">
              {/* Allowlist proof input */}
              <AnimatePresence>
                {drop.currentPhase === 1 && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                    <label className={LABEL} htmlFor="mint-merkleProof">Merkle Proof</label>
                    <input
                      id="mint-merkleProof"
                      type="text"
                      value={proofInput}
                      onChange={(e) => setProofInput(e.target.value)}
                      placeholder="0xabc...,0xdef..."
                      className={`${INPUT} font-mono text-xs`}
                    />
                    <span className="text-[10px] text-white mt-1 block">
                      Comma-separated hex strings. Get your proof from the project.
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Quantity + Mint */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <div className="flex items-center gap-2">
                  <button
                    className="w-9 h-9 rounded-lg bg-black/60 hover:bg-black/60 text-white transition-colors text-lg leading-none"
                    onClick={() => setMintQty(Math.max(1, mintQty - 1))}
                  >
                    \u2212
                  </button>
                  <span className="text-white font-mono text-lg tabular-nums w-10 text-center">
                    {mintQty}
                  </span>
                  <button
                    className="w-9 h-9 rounded-lg bg-black/60 hover:bg-black/60 text-white transition-colors text-lg leading-none"
                    onClick={() => setMintQty((q) => { const cap = drop.maxPerWallet > 0 ? drop.maxPerWallet : Infinity; return Math.min(q + 1, cap); })}
                  >
                    +
                  </button>
                  <button
                    className="px-3 h-9 rounded-lg bg-black/60 hover:bg-black/60 text-white hover:text-white text-[10px] uppercase tracking-wider label-pill transition-colors"
                    onClick={() => setMintQty(drop.maxPerWallet > 0 ? drop.maxPerWallet : 10)}
                  >
                    Max
                  </button>
                </div>

                <button
                  className={`flex-1 py-3 rounded-xl text-sm font-medium transition-all ${
                    mintDisabled
                      ? 'bg-black/60 text-white cursor-not-allowed'
                      : `${BTN_EMERALD} shadow-[0_0_20px_-6px_rgba(16,185,129,0.3)]`
                  }`}
                  disabled={mintDisabled}
                  onClick={handleMint}
                >
                  {mintLabel}
                </button>
              </div>

              {/* Total cost */}
              {drop.currentPhase > 0 && !drop.isSoldOut && deployed && (
                <p className="text-center text-xs text-white font-mono tabular-nums">
                  Total: {totalCost.toFixed(4)} ETH
                </p>
              )}
            </div>
          </ArtCard>
        </div>
      </ArtCard>

      {/* Live Mint Feed */}
      <div className="mt-6">
        <LiveMintFeed />
      </div>

      {/* Creator Revenue Dashboard (owner only) */}
      {drop.isOwner && <CreatorRevenueDashboard drop={drop} />}

      {/* Owner Admin */}
      {drop.isOwner && <OwnerAdminPanel dropAddress={dropAddress} deployed={deployed} />}
    </motion.div>
  );
}

/* ─────────────────────────── Create Collection ───────────────────────── */

function CreateCollectionForm({ onCreated, deployed }: { onCreated: () => void; deployed: boolean }) {
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [maxSupply, setMaxSupply] = useState('10000');
  const [mintPrice, setMintPrice] = useState('0.05');
  const [maxPerWallet, setMaxPerWallet] = useState('5');
  const [royaltyBps, setRoyaltyBps] = useState(500);

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });
  const busy = isPending || isConfirming;

  const royaltyPct = (royaltyBps / 100).toFixed(1);
  const royaltyFillPct = (royaltyBps / 1000) * 100;

  const handleCreate = () => {
    if (!deployed) return toast.error('Contracts not deployed yet');
    if (!name || !symbol) return toast.error('Name and symbol are required');
    if (Number(maxSupply) === 0) return toast.error('Max supply must be greater than 0');

    writeContract(
      {
        address: TEGRIDY_LAUNCHPAD_ADDRESS,
        abi: TEGRIDY_LAUNCHPAD_ABI,
        functionName: 'createCollection',
        args: [
          name,
          symbol,
          BigInt(maxSupply),
          parseEther(mintPrice || '0'),
          BigInt(maxPerWallet || '0'),
          royaltyBps,
        ],
      },
      {
        onSuccess: () => {
          toast.success('Collection deployed!');
          setName('');
          setSymbol('');
          onCreated();
        },
        onError: (e) => toast.error(e.message.slice(0, 80)),
      },
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-8"
    >
      <ArtCard art={ART.chaosScene} opacity={1} overlay="none" className="rounded-2xl">
        <div className="p-1 sm:p-3">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
            {/* Form Fields */}
            <div>
              <h2 className="heading-luxury text-xl mb-6">Create Collection</h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
                <div>
                  <label className={LABEL} htmlFor="create-name">Name</label>
                  <input
                    id="create-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My NFT"
                    className={INPUT}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="create-symbol">Symbol</label>
                  <input
                    id="create-symbol"
                    type="text"
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                    placeholder="MNFT"
                    className={INPUT}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="create-maxSupply">Max Supply</label>
                  <input
                    id="create-maxSupply"
                    type="number"
                    value={maxSupply}
                    onChange={(e) => setMaxSupply(String(Math.max(0, parseInt(e.target.value) || 0)))}
                    className={`${INPUT} font-mono`}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="create-mintPrice">Mint Price (ETH)</label>
                  <input
                    id="create-mintPrice"
                    type="number"
                    value={mintPrice}
                    onChange={(e) => setMintPrice(String(Math.max(0, parseFloat(e.target.value) || 0)))}
                    className={`${INPUT} font-mono`}
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="create-maxPerWallet">Max Per Wallet</label>
                  <input
                    id="create-maxPerWallet"
                    type="number"
                    value={maxPerWallet}
                    onChange={(e) => setMaxPerWallet(String(Math.max(0, parseInt(e.target.value) || 0)))}
                    className={`${INPUT} font-mono`}
                  />
                  <span className="text-[10px] text-white mt-1 block">0 = unlimited</span>
                </div>
                <div>
                  <label className={LABEL} htmlFor="create-royalty">Royalty ({royaltyPct}%)</label>
                  <input
                    id="create-royalty"
                    type="range"
                    min={0}
                    max={1000}
                    step={25}
                    value={royaltyBps}
                    onChange={(e) => setRoyaltyBps(Number(e.target.value))}
                    className="w-full h-1.5 rounded-full appearance-none bg-black/60 accent-emerald-500 cursor-pointer mt-2"
                  />
                  {/* Royalty fill visualization */}
                  <div className="w-full h-1.5 rounded-full bg-black/60 overflow-hidden mt-1.5" role="progressbar" aria-valuenow={Math.round(royaltyFillPct)} aria-valuemin={0} aria-valuemax={100}>
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-300"
                      style={{ width: `${royaltyFillPct}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-white mt-1">
                    <span>0%</span>
                    <span className="text-black/60 font-mono">{royaltyBps} bps</span>
                    <span>10%</span>
                  </div>
                </div>
              </div>

              <button
                className={`mt-6 w-full py-3 rounded-xl text-sm ${BTN_EMERALD}`}
                disabled={busy || !name || !symbol || !deployed}
                onClick={handleCreate}
              >
                {!deployed
                  ? 'Contract Not Deployed'
                  : busy
                    ? 'Deploying...'
                    : 'Deploy Collection'}
              </button>
            </div>

            {/* Preview Card */}
            <div className="hidden lg:block">
              <label className={LABEL}>Live Preview</label>
              <ArtCard art={ART.galleryCollage} opacity={1} overlay="none" className="mt-1.5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center text-black font-bold text-xs">
                      {(symbol || '???').slice(0, 3)}
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-white font-medium truncate text-sm">{name || 'Collection Name'}</h3>
                      <span className="inline-block text-[10px] uppercase tracking-wider label-pill text-black/70 bg-emerald-500/30 px-1.5 py-0.5 rounded mt-0.5">
                        {symbol || 'SYM'}
                      </span>
                    </div>
                  </div>
                  <PhaseBadge phase={0} />
                </div>
                {/* Mini progress preview */}
                <div className="mb-3">
                  <div className="flex justify-between text-[10px] text-white mb-1">
                    <span className="font-mono">0/{maxSupply || '0'}</span>
                    <span className="font-mono">0%</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-black/60" />
                </div>
                <div className="space-y-1.5 text-xs text-white">
                  <div className="flex justify-between">
                    <span>Supply</span>
                    <span className="text-white font-mono tabular-nums">{maxSupply || '0'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Price</span>
                    <span className="text-white font-mono tabular-nums">{mintPrice || '0'} ETH</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Royalty</span>
                    <span className="text-white font-mono tabular-nums">{royaltyPct}%</span>
                  </div>
                </div>
              </ArtCard>
            </div>
          </div>
        </div>
      </ArtCard>
    </motion.div>
  );
}

/* ─────────────────────────── Coming Soon ──────────────────────────────── */

function ComingSoonPanel() {
  return (
    <motion.div className="max-w-2xl mx-auto text-center" {...fadeUp}>
      <ArtCard art={ART.jungleBus} opacity={1} overlay="none" className="rounded-2xl mb-8">
        <div className="p-3 sm:p-5">
          <h2 className="heading-luxury text-2xl mb-3">Coming Soon</h2>
          <p className="text-white max-w-md mx-auto mb-8 text-sm leading-relaxed">
            The Tegridy Launchpad is under development. Deploy NFT collections as minimal-proxy
            clones with multi-phase minting, Merkle allowlists, and Dutch auctions.
          </p>

          <motion.div
            className="grid grid-cols-2 sm:grid-cols-3 gap-3"
            variants={stagger}
            initial="hidden"
            animate="visible"
          >
            {FEATURE_BULLETS.map(({ label, icon }) => (
              <motion.div
                key={label}
                variants={fadeUpVariants}
                className="rounded-xl p-4 flex flex-col items-center gap-2.5 bg-black/60 border border-white/20 hover:border-emerald-500/40 transition-colors"
              >
                <span className="text-black text-xl">{icon}</span>
                <span className="text-white text-xs text-center leading-snug">{label}</span>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </ArtCard>
    </motion.div>
  );
}

/* ─────────────────────────── Main Page ────────────────────────────────── */

export default function LaunchpadPage({ embedded }: { embedded?: boolean }) {
  usePageTitle(embedded ? '' : 'Launchpad');
  const { isConnected } = useAccount();
  const deployed = isDeployed(TEGRIDY_LAUNCHPAD_ADDRESS);

  const [showForm, setShowForm] = useState(false);
  const [selectedDrop, setSelectedDrop] = useState<string | null>(null);

  const { data: collectionCount } = useReadContract({
    address: TEGRIDY_LAUNCHPAD_ADDRESS,
    abi: TEGRIDY_LAUNCHPAD_ABI,
    functionName: 'getCollectionCount',
    query: { enabled: deployed },
  });

  const collectionIds = useMemo(
    () =>
      collectionCount
        ? Array.from({ length: Number(collectionCount) }, (_, i) => i)
            .reverse()
            .slice(0, 24)
        : [],
    [collectionCount],
  );

  /* ── Render ── */
  return (
    <div className={embedded ? '' : '-mt-14 relative min-h-screen'}>
      {/* Background */}
      {!embedded && (
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <img
            src={ART.chaosScene.src}
            alt=""
            className="w-full h-full object-cover"
           
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                'none',
            }}
          />
        </div>
      )}

      <div
        className={`relative z-10 ${
          embedded ? '' : 'max-w-[1100px] mx-auto px-4 md:px-6 pt-24 pb-16'
        }`}
      >
        {/* Heading (standalone only) */}
        {!embedded && (
          <motion.div className="text-center mb-10" {...fadeUp}>
            <ArtCard art={ART.jbChristmas} opacity={1} overlay="none" className="inline-block rounded-2xl px-2 py-1 mb-0">
              <div className="px-4 sm:px-8 py-4">
                <h1 className="heading-luxury text-3xl md:text-4xl mb-3">NFT Launchpad</h1>
                <p className="text-white max-w-lg mx-auto text-sm leading-relaxed">
                  Launch your NFT collection with built-in allowlists, Dutch auctions, delayed
                  reveals, and ERC-2981 royalties.
                </p>
              </div>
            </ArtCard>
          </motion.div>
        )}

        {/* Connect Wallet Gate (standalone only) */}
        {!isConnected && !embedded ? (
          <motion.div
            className={`${GLASS} rounded-2xl p-8 text-center max-w-md mx-auto`}
            {...fadeUp}
          >
            <p className="text-white mb-5 text-sm">
              Connect your wallet to launch or browse collections.
            </p>
            <ConnectButton />
          </motion.div>
        ) : (
          /* Main Content */
          <>
            {!deployed && (
              <div className="rounded-xl px-4 py-3 text-center text-[13px] text-amber-400/80 border border-amber-500/20 mb-6" style={{ background: 'rgba(245,158,11,0.06)' }}>
                Launchpad contracts are under development. Explore the interface below.
              </div>
            )}

            {/* Header Bar */}
            <motion.div
              className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8"
              {...fadeUp}
            >
              <div className="flex gap-3">
                <ArtCard art={ART.jbChristmas} opacity={1} overlay="none" className="rounded-xl">
                  <p className={LABEL}>Collections</p>
                  <p className="text-white font-mono text-xl tabular-nums">
                    {collectionCount?.toString() ?? '0'}
                  </p>
                </ArtCard>
              </div>
              <button
                className={`px-6 py-2.5 rounded-xl text-sm transition-all ${
                  showForm
                    ? 'bg-black/60 text-white hover:text-white border border-white/10'
                    : !deployed
                      ? 'bg-black/60 text-white cursor-not-allowed border border-white/10'
                      : BTN_EMERALD
                }`}
                onClick={() => deployed && setShowForm(!showForm)}
                disabled={!deployed && !showForm}
              >
                {showForm ? 'Cancel' : !deployed ? 'Contract Not Deployed' : '+ Launch Collection'}
              </button>
            </motion.div>

            {/* Create Form */}
            <AnimatePresence>
              {showForm && (
                <CreateCollectionForm
                  onCreated={() => setShowForm(false)}
                  deployed={deployed}
                />
              )}
            </AnimatePresence>

            {/* Selected Collection Detail */}
            <AnimatePresence>
              {selectedDrop && (
                <CollectionDetail
                  dropAddress={selectedDrop}
                  onClose={() => setSelectedDrop(null)}
                  deployed={deployed}
                />
              )}
            </AnimatePresence>

            {/* Collection Grid */}
            <div className="mb-2">
              <h2 className="heading-luxury text-xl mb-5">Collections</h2>
            </div>

            {collectionIds.length === 0 ? (
              <motion.div {...fadeUp}>
                <ArtCard art={ART.towelieWindow} opacity={1} overlay="none" className="rounded-2xl">
                  <div className="text-center py-6">
                    <div className="text-white/10 text-5xl mb-4">{'\u25C8'}</div>
                    <p className="text-white text-sm">
                      No collections launched yet. Be the first to deploy.
                    </p>
                  </div>
                </ArtCard>
              </motion.div>
            ) : (
              <motion.div
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
                variants={stagger}
                initial="hidden"
                animate="visible"
              >
                {collectionIds.map((id) => (
                  <CollectionCard
                    key={id}
                    collectionId={id}
                    onSelect={(addr) =>
                      setSelectedDrop(
                        selectedDrop?.toLowerCase() === addr.toLowerCase() ? null : addr,
                      )
                    }
                    selectedAddr={selectedDrop}
                    deployed={deployed}
                  />
                ))}
              </motion.div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
