import { useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAccount, useWriteContract, useReadContract, useWaitForTransactionReceipt } from 'wagmi';
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
  'bg-gradient-to-br from-[rgba(13,21,48,0.6)] to-[rgba(6,12,26,0.8)] backdrop-blur-[20px] border border-white/[0.06]';
const INPUT =
  'w-full bg-transparent border-b border-white/10 px-1 py-2.5 text-white outline-none focus:border-emerald-500 transition-colors placeholder:text-white/20';
const LABEL = 'text-[11px] uppercase tracking-wider text-white/40 mb-1.5 block';
const BTN_EMERALD =
  'bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 transition-colors text-white font-medium disabled:opacity-40 disabled:pointer-events-none';

const PHASE_LABELS = ['Paused', 'Allowlist', 'Public'] as const;
const FEATURE_BULLETS = [
  { label: 'ERC-721 Collections', icon: '◈' },
  { label: 'Merkle Allowlists', icon: '◎' },
  { label: 'Dutch Auctions', icon: '◇' },
  { label: 'Delayed Reveals', icon: '◉' },
  { label: 'ERC-2981 Royalties', icon: '◆' },
  { label: 'Revenue Splits', icon: '◐' },
];

const fadeUp = { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35 } };
const stagger = { animate: { transition: { staggerChildren: 0.06 } } };

/* ─────────────────────────── Phase Indicator ─────────────────────────── */

function PhaseIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0">
      {PHASE_LABELS.map((label, i) => (
        <div key={label} className="flex items-center">
          {i > 0 && (
            <div
              className={`w-8 sm:w-12 h-[2px] transition-colors duration-500 ${
                i <= current ? 'bg-emerald-500' : 'bg-white/10'
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
              className={`text-[10px] uppercase tracking-wider ${
                i === current ? 'text-emerald-400' : 'text-white/30'
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
}: {
  collectionId: number;
  onSelect: (addr: string) => void;
  selectedAddr: string | null;
}) {
  const { data: collection } = useReadContract({
    address: TEGRIDY_LAUNCHPAD_ADDRESS,
    abi: TEGRIDY_LAUNCHPAD_ABI,
    functionName: 'getCollection',
    args: [BigInt(collectionId)],
  });

  if (!collection) {
    return <div className={`${GLASS} rounded-xl p-5 animate-pulse h-36`} />;
  }

  const [, contractAddr, creator, name, symbol] = collection;
  const shortAddr = `${contractAddr.slice(0, 6)}...${contractAddr.slice(-4)}`;
  const shortCreator = `${creator.slice(0, 6)}...${creator.slice(-4)}`;
  const isActive = selectedAddr?.toLowerCase() === contractAddr.toLowerCase();

  return (
    <motion.div
      {...fadeUp}
      className={`${GLASS} rounded-xl p-5 cursor-pointer transition-all duration-300 group ${
        isActive
          ? 'ring-1 ring-emerald-500/40 border-emerald-500/30 shadow-[0_0_24px_-6px_rgba(16,185,129,0.15)]'
          : 'hover:border-emerald-500/20 hover:shadow-[0_0_20px_-6px_rgba(16,185,129,0.08)]'
      }`}
      onClick={() => onSelect(contractAddr)}
    >
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center text-emerald-400 font-bold text-xs tracking-wide">
          {symbol.slice(0, 3)}
        </div>
        <div className="min-w-0">
          <h3 className="text-white font-medium truncate">{name}</h3>
          <span className="inline-block text-[10px] uppercase tracking-wider text-emerald-400/70 bg-emerald-500/10 px-1.5 py-0.5 rounded mt-0.5">
            {symbol}
          </span>
        </div>
      </div>
      <div className="space-y-1.5 text-sm">
        <div className="flex justify-between text-white/50">
          <span>Contract</span>
          <a
            href={`https://etherscan.io/address/${contractAddr}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-400/80 hover:text-emerald-400 hover:underline font-mono text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            {shortAddr}
          </a>
        </div>
        <div className="flex justify-between text-white/50">
          <span>Creator</span>
          <span className="text-white/70 font-mono text-xs">{shortCreator}</span>
        </div>
      </div>
    </motion.div>
  );
}

/* ─────────────────────────── Owner Admin Panel ───────────────────────── */

function OwnerAdminPanel({ dropAddress }: { dropAddress: string }) {
  const contractAddr = dropAddress as `0x${string}`;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState('0');
  const [merkleRoot, setMerkleRoot] = useState('');
  const [revealURI, setRevealURI] = useState('');

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });
  const busy = isPending || isConfirming;

  const exec = useCallback(
    (fn: string, args?: unknown[], opts?: { onSuccess?: () => void }) => {
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
    [contractAddr, writeContract],
  );

  return (
    <div className="mt-6 border-t border-emerald-500/15 pt-4">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between text-sm"
      >
        <span className="text-emerald-400 font-semibold tracking-wide uppercase text-[11px]">
          Owner Admin
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          className="text-emerald-400/50 text-xs"
        >
          ▼
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-5 pt-4">
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
                          : 'bg-white/5 text-white/50 hover:text-white border border-white/10 hover:border-white/20'
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
                  {busy ? 'Setting...' : 'Set Phase'}
                </button>
              </div>

              {/* Merkle Root */}
              <div>
                <label className={LABEL}>Merkle Root</label>
                <input
                  type="text"
                  value={merkleRoot}
                  onChange={(e) => setMerkleRoot(e.target.value)}
                  placeholder="0x..."
                  className={`${INPUT} font-mono text-xs`}
                />
                <button
                  className={`mt-2 w-full py-2 rounded-lg text-xs ${BTN_EMERALD}`}
                  disabled={busy || !merkleRoot.startsWith('0x')}
                  onClick={() =>
                    exec('setMerkleRoot', [merkleRoot as `0x${string}`], {
                      onSuccess: () => setMerkleRoot(''),
                    })
                  }
                >
                  {busy ? 'Setting...' : 'Set Merkle Root'}
                </button>
              </div>

              {/* Reveal */}
              <div>
                <label className={LABEL}>Reveal Base URI</label>
                <input
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
                  {busy ? 'Revealing...' : 'Reveal Collection'}
                </button>
              </div>

              {/* Withdraw */}
              <button
                className="w-full py-2.5 rounded-lg bg-amber-600/70 hover:bg-amber-600 text-white text-xs font-medium border border-amber-500/20 transition-colors disabled:opacity-40"
                disabled={busy}
                onClick={() => exec('withdraw')}
              >
                {busy ? 'Withdrawing...' : 'Withdraw Mint Revenue'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─────────────────────────── Collection Detail ───────────────────────── */

function CollectionDetail({ dropAddress, onClose }: { dropAddress: string; onClose: () => void }) {
  const { isConnected } = useAccount();
  const drop = useNFTDrop(dropAddress);
  const [mintQty, setMintQty] = useState(1);
  const [proofInput, setProofInput] = useState('');
  const shortAddr = `${dropAddress.slice(0, 6)}...${dropAddress.slice(-4)}`;

  const totalCost = useMemo(
    () => Number(formatEther(drop.mintPrice * BigInt(mintQty))),
    [drop.mintPrice, mintQty],
  );

  const mintLabel = useMemo(() => {
    if (!isConnected) return 'Connect Wallet';
    if (drop.isPending) return 'Confirm in Wallet...';
    if (drop.isConfirming) return 'Confirming...';
    if (drop.isSoldOut) return 'Sold Out';
    if (drop.currentPhase === 0) return 'Minting Paused';
    return `Mint ${mintQty} for ${totalCost.toFixed(4)} ETH`;
  }, [isConnected, drop.isPending, drop.isConfirming, drop.isSoldOut, drop.currentPhase, mintQty, totalCost]);

  const mintDisabled =
    !isConnected ||
    drop.isPending ||
    drop.isConfirming ||
    drop.isSoldOut ||
    drop.currentPhase === 0 ||
    (drop.currentPhase === 1 && !proofInput.trim());

  const progressPct = drop.maxSupply > 0 ? Math.min(100, (drop.totalMinted / drop.maxSupply) * 100) : 0;

  const handleMint = useCallback(() => {
    const proof = proofInput.trim()
      ? proofInput.split(',').map((s) => s.trim() as `0x${string}`)
      : [];
    drop.mint(mintQty, proof);
  }, [drop, mintQty, proofInput]);

  return (
    <motion.div
      className={`${GLASS} rounded-2xl p-6 sm:p-8 mb-8`}
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Hero */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="heading-luxury text-xl sm:text-2xl mb-1">Collection Details</h2>
          <a
            href={`https://etherscan.io/address/${dropAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-400/70 hover:text-emerald-400 text-xs font-mono hover:underline"
          >
            {shortAddr}
          </a>
        </div>
        <button
          onClick={onClose}
          className="text-white/30 hover:text-white text-sm transition-colors p-1"
        >
          ✕
        </button>
      </div>

      {/* Phase Indicator */}
      <div className="flex justify-center mb-8">
        <PhaseIndicator current={drop.currentPhase} />
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className={`${GLASS} rounded-xl p-3 sm:p-4 text-center`}>
          <p className={LABEL}>Minted</p>
          <p className="text-white font-mono text-lg tabular-nums">
            {drop.totalMinted}
            <span className="text-white/30">/{drop.maxSupply}</span>
          </p>
        </div>
        <div className={`${GLASS} rounded-xl p-3 sm:p-4 text-center`}>
          <p className={LABEL}>Price</p>
          <p className="text-white font-mono text-lg tabular-nums">{drop.mintPriceFormatted} ETH</p>
        </div>
        <div className={`${GLASS} rounded-xl p-3 sm:p-4 text-center`}>
          <p className={LABEL}>Phase</p>
          <p className="text-emerald-400 font-medium text-lg">{drop.phaseLabel}</p>
        </div>
      </div>

      {/* Progress Bar */}
      {drop.maxSupply > 0 && (
        <div className="mb-8">
          <div className="flex justify-between text-[10px] text-white/30 mb-1.5 uppercase tracking-wider">
            <span>Progress</span>
            <span className="font-mono tabular-nums">{progressPct.toFixed(1)}%</span>
          </div>
          <div className="w-full h-2 rounded-full bg-white/5 overflow-hidden">
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

      {/* Mint Interface */}
      <div className="space-y-4">
        {/* Allowlist proof input */}
        <AnimatePresence>
          {drop.currentPhase === 1 && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              <label className={LABEL}>Merkle Proof</label>
              <input
                type="text"
                value={proofInput}
                onChange={(e) => setProofInput(e.target.value)}
                placeholder="0xabc...,0xdef..."
                className={`${INPUT} font-mono text-xs`}
              />
              <span className="text-[10px] text-white/25 mt-1 block">
                Comma-separated hex strings. Get your proof from the project.
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Quantity + Mint */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="flex items-center gap-2">
            <button
              className="w-9 h-9 rounded-lg bg-white/5 hover:bg-white/10 text-white transition-colors text-lg leading-none"
              onClick={() => setMintQty(Math.max(1, mintQty - 1))}
            >
              −
            </button>
            <span className="text-white font-mono text-lg tabular-nums w-10 text-center">
              {mintQty}
            </span>
            <button
              className="w-9 h-9 rounded-lg bg-white/5 hover:bg-white/10 text-white transition-colors text-lg leading-none"
              onClick={() => setMintQty(mintQty + 1)}
            >
              +
            </button>
            <button
              className="px-3 h-9 rounded-lg bg-white/5 hover:bg-white/10 text-white/50 hover:text-white text-[10px] uppercase tracking-wider transition-colors"
              onClick={() => setMintQty(10)}
            >
              Max
            </button>
          </div>

          <button
            className={`flex-1 py-3 rounded-xl text-sm font-medium transition-all ${
              mintDisabled
                ? 'bg-white/5 text-white/30 cursor-not-allowed'
                : `${BTN_EMERALD} shadow-[0_0_20px_-6px_rgba(16,185,129,0.3)]`
            }`}
            disabled={mintDisabled}
            onClick={handleMint}
          >
            {mintLabel}
          </button>
        </div>

        {/* Total cost */}
        {drop.currentPhase > 0 && !drop.isSoldOut && (
          <p className="text-center text-xs text-white/30 font-mono tabular-nums">
            Total: {totalCost.toFixed(4)} ETH
          </p>
        )}
      </div>

      {/* Owner Admin */}
      {drop.isOwner && <OwnerAdminPanel dropAddress={dropAddress} />}
    </motion.div>
  );
}

/* ─────────────────────────── Create Collection ───────────────────────── */

function CreateCollectionForm({ onCreated }: { onCreated: () => void }) {
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

  const handleCreate = () => {
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
      className={`${GLASS} rounded-2xl p-6 sm:p-8 mb-8`}
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
        {/* Form Fields */}
        <div>
          <h2 className="heading-luxury text-xl mb-6">Create Collection</h2>

          <div className="grid grid-cols-2 gap-x-6 gap-y-5">
            <div>
              <label className={LABEL}>Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My NFT"
                className={INPUT}
              />
            </div>
            <div>
              <label className={LABEL}>Symbol</label>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="MNFT"
                className={INPUT}
              />
            </div>
            <div>
              <label className={LABEL}>Max Supply</label>
              <input
                type="number"
                value={maxSupply}
                onChange={(e) => setMaxSupply(e.target.value)}
                className={`${INPUT} font-mono`}
              />
            </div>
            <div>
              <label className={LABEL}>Mint Price (ETH)</label>
              <input
                type="number"
                value={mintPrice}
                onChange={(e) => setMintPrice(e.target.value)}
                className={`${INPUT} font-mono`}
              />
            </div>
            <div>
              <label className={LABEL}>Max Per Wallet</label>
              <input
                type="number"
                value={maxPerWallet}
                onChange={(e) => setMaxPerWallet(e.target.value)}
                className={`${INPUT} font-mono`}
              />
              <span className="text-[10px] text-white/25 mt-1 block">0 = unlimited</span>
            </div>
            <div>
              <label className={LABEL}>Royalty ({royaltyPct}%)</label>
              <input
                type="range"
                min={0}
                max={1000}
                step={25}
                value={royaltyBps}
                onChange={(e) => setRoyaltyBps(Number(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none bg-white/10 accent-emerald-500 cursor-pointer mt-2"
              />
              <div className="flex justify-between text-[10px] text-white/25 mt-1">
                <span>0%</span>
                <span className="text-emerald-400/60 font-mono">{royaltyBps} bps</span>
                <span>10%</span>
              </div>
            </div>
          </div>

          <button
            className={`mt-6 w-full py-3 rounded-xl text-sm ${BTN_EMERALD}`}
            disabled={busy || !name || !symbol}
            onClick={handleCreate}
          >
            {busy ? 'Deploying...' : 'Deploy Collection'}
          </button>
        </div>

        {/* Preview Card */}
        <div className="hidden lg:block">
          <label className={LABEL}>Preview</label>
          <div className={`${GLASS} rounded-xl p-5 mt-1.5`}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center text-emerald-400 font-bold text-xs">
                {(symbol || '???').slice(0, 3)}
              </div>
              <div className="min-w-0">
                <h3 className="text-white font-medium truncate text-sm">{name || 'Collection Name'}</h3>
                <span className="inline-block text-[10px] uppercase tracking-wider text-emerald-400/70 bg-emerald-500/10 px-1.5 py-0.5 rounded mt-0.5">
                  {symbol || 'SYM'}
                </span>
              </div>
            </div>
            <div className="space-y-1.5 text-xs text-white/40">
              <div className="flex justify-between">
                <span>Supply</span>
                <span className="text-white/60 font-mono tabular-nums">{maxSupply || '0'}</span>
              </div>
              <div className="flex justify-between">
                <span>Price</span>
                <span className="text-white/60 font-mono tabular-nums">{mintPrice || '0'} ETH</span>
              </div>
              <div className="flex justify-between">
                <span>Royalty</span>
                <span className="text-white/60 font-mono tabular-nums">{royaltyPct}%</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/* ─────────────────────────── Coming Soon ──────────────────────────────── */

function ComingSoonPanel() {
  return (
    <motion.div className="max-w-2xl mx-auto text-center" {...fadeUp}>
      <div className={`${GLASS} rounded-2xl p-8 sm:p-10 mb-8`}>
        <h2 className="heading-luxury text-2xl mb-3">Coming Soon</h2>
        <p className="text-white/50 max-w-md mx-auto mb-8 text-sm leading-relaxed">
          The Tegridy Launchpad is under development. Deploy NFT collections as minimal-proxy
          clones with multi-phase minting, Merkle allowlists, and Dutch auctions.
        </p>

        <motion.div
          className="grid grid-cols-2 sm:grid-cols-3 gap-3"
          variants={stagger}
          initial="initial"
          animate="animate"
        >
          {FEATURE_BULLETS.map(({ label, icon }) => (
            <motion.div
              key={label}
              variants={fadeUp}
              className={`${GLASS} rounded-xl p-4 flex flex-col items-center gap-2.5 hover:border-emerald-500/20 transition-colors`}
            >
              <span className="text-emerald-400 text-xl">{icon}</span>
              <span className="text-white/70 text-xs text-center leading-snug">{label}</span>
            </motion.div>
          ))}
        </motion.div>
      </div>
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
            style={{ opacity: 0.12 }}
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, rgba(6,12,26,0.88) 45%, rgba(6,12,26,0.98) 100%)',
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
            <h1 className="heading-luxury text-3xl md:text-4xl mb-3">NFT Launchpad</h1>
            <p className="text-white/50 max-w-lg mx-auto text-sm leading-relaxed">
              Launch your NFT collection with built-in allowlists, Dutch auctions, delayed
              reveals, and ERC-2981 royalties.
            </p>
          </motion.div>
        )}

        {/* Connect Wallet Gate (standalone only) */}
        {!isConnected && !embedded ? (
          <motion.div
            className={`${GLASS} rounded-2xl p-8 text-center max-w-md mx-auto`}
            {...fadeUp}
          >
            <p className="text-white/50 mb-5 text-sm">
              Connect your wallet to launch or browse collections.
            </p>
            <ConnectButton />
          </motion.div>
        ) : !deployed ? (
          /* Coming Soon */
          <ComingSoonPanel />
        ) : (
          /* Main Content */
          <>
            {/* Header Bar */}
            <motion.div
              className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8"
              {...fadeUp}
            >
              <div className="flex gap-3">
                <div className={`${GLASS} rounded-xl px-5 py-3`}>
                  <p className={LABEL}>Collections</p>
                  <p className="text-white font-mono text-xl tabular-nums">
                    {collectionCount?.toString() ?? '0'}
                  </p>
                </div>
              </div>
              <button
                className={`px-6 py-2.5 rounded-xl text-sm transition-all ${
                  showForm
                    ? 'bg-white/5 text-white/60 hover:text-white border border-white/10'
                    : BTN_EMERALD
                }`}
                onClick={() => setShowForm(!showForm)}
              >
                {showForm ? 'Cancel' : '+ Launch Collection'}
              </button>
            </motion.div>

            {/* Create Form */}
            <AnimatePresence>
              {showForm && (
                <CreateCollectionForm
                  onCreated={() => setShowForm(false)}
                />
              )}
            </AnimatePresence>

            {/* Selected Collection Detail */}
            <AnimatePresence>
              {selectedDrop && (
                <CollectionDetail
                  dropAddress={selectedDrop}
                  onClose={() => setSelectedDrop(null)}
                />
              )}
            </AnimatePresence>

            {/* Collection Grid */}
            <div className="mb-2">
              <h2 className="heading-luxury text-xl mb-5">Collections</h2>
            </div>

            {collectionIds.length === 0 ? (
              <motion.div
                className={`${GLASS} rounded-2xl p-10 text-center`}
                {...fadeUp}
              >
                <div className="text-white/10 text-5xl mb-4">◈</div>
                <p className="text-white/40 text-sm">
                  No collections launched yet. Be the first to deploy.
                </p>
              </motion.div>
            ) : (
              <motion.div
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
                variants={stagger}
                initial="initial"
                animate="animate"
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
