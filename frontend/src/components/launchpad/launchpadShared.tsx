/* ─── Shared small components for Launchpad ─── */
import { useState, useEffect, useMemo } from 'react';
import { useAccount, useChains, usePublicClient, useWatchContractEvent } from 'wagmi';
import { formatEther, parseAbiItem, type Address } from 'viem';
import { pageArt } from '../../lib/artConfig';
import { CHAIN_ID } from '../../lib/constants';
import { PHASE_LABELS, LABEL } from './launchpadConstants';
import { shortenAddress } from '../../lib/formatting';
import { artImgProps } from '../../lib/artSrcSet';

/** Return the block explorer address URL for the current chain */
// eslint-disable-next-line react-refresh/only-export-components
export function useExplorerAddressUrl(address: string) {
  const chains = useChains();
  const { chain } = useAccount();
  const activeChain = chain ?? chains[0]!;
  const base = activeChain?.blockExplorers?.default?.url ?? 'https://etherscan.io';
  return `${base}/address/${address}`;
}

/* ─── Art-backed glass card helper ─── */
export function ArtCard({
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
      style={{ border: '1px solid var(--color-purple-75)' }}
    >
      <div className="absolute inset-0">
        <img src={art.src} {...artImgProps(art.src)} alt="" loading="lazy" className="w-full h-full object-cover" style={{ opacity }} />
        <div className="absolute inset-0" style={{ background: overlay }} />
      </div>
      <div className="relative z-10 p-5">{children}</div>
    </div>
  );
}

/* ─── Phase badge for cards ─── */
// F261: derive from PHASE_LABELS so a live Dutch auction (3) badges "Dutch
// Auction" and CLOSED (0) / CANCELLED (4) read distinctly — the old 3-branch
// ternary collapsed every non-1/2 phase into a single misleading "Paused".
// (paused() is a separate boolean, surfaced by its own banner.)
const PHASE_BADGE_CONFIG: Record<number, { color: string; ring: string; text: string; pulse: boolean }> = {
  0: { color: 'bg-gray-500', ring: 'ring-gray-400/20', text: 'text-gray-400', pulse: false },     // Closed
  1: { color: 'bg-yellow-500', ring: 'ring-yellow-400/30', text: 'text-yellow-300', pulse: false }, // Allowlist
  2: { color: 'bg-emerald-500', ring: 'ring-emerald-400/30', text: 'text-emerald-300', pulse: true }, // Public
  3: { color: 'bg-blue-500', ring: 'ring-blue-400/30', text: 'text-blue-300', pulse: true },        // Dutch Auction
  4: { color: 'bg-red-500', ring: 'ring-red-400/30', text: 'text-red-300', pulse: false },          // Cancelled
};

export function PhaseBadge({ phase }: { phase: number }) {
  const cfg = PHASE_BADGE_CONFIG[phase] ?? PHASE_BADGE_CONFIG[0]!;
  const config = { ...cfg, label: PHASE_LABELS[phase] ?? 'Closed' };

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

/* ─── Phase Indicator ─── */
export function PhaseIndicator({ current }: { current: number }) {
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
                i === current ? 'text-white' : 'text-white/50'
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

/* ─── On-chain mint activity (Live Mint Feed + Unique Minters) ─── */
// ERC-721 mints are Transfer events from the zero address. We read them
// straight from the connected RPC: the /api/* Alchemy proxy is locked to a
// 3-collection allowlist, so a freshly-deployed launchpad drop must be read
// client-side. Mirrors the bounded-getLogs pattern proven in AMMSection's
// PoolTradeHistory; chunked into 10k-block reads because most RPCs cap
// eth_getLogs at a 10k range.
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
);
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
const MINT_LOOKBACK = 50_000n; // ~1 week @ 12s/block
const LOGS_CHUNK = 10_000n;

interface MintRow {
  to: Address;
  qty: number;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

type RawTransferLog = {
  args: { to?: Address };
  blockNumber: bigint | null;
  transactionHash: `0x${string}` | null;
};

// Collapse raw mint Transfer logs into per-tx rows (a wallet minting N in one
// tx emits N Transfers → one row, qty N). Newest block first.
function groupMints(logs: RawTransferLog[]): MintRow[] {
  const byTx = new Map<string, MintRow>();
  for (const l of logs) {
    const txHash = l.transactionHash ?? ('0x' as `0x${string}`);
    const existing = byTx.get(txHash);
    if (existing) {
      existing.qty += 1;
    } else {
      byTx.set(txHash, {
        to: (l.args.to ?? ZERO_ADDR) as Address,
        qty: 1,
        blockNumber: l.blockNumber ?? 0n,
        txHash,
      });
    }
  }
  return [...byTx.values()].sort((a, b) => Number(b.blockNumber - a.blockNumber));
}

// Approximate "time ago" from a block delta (12s/block), prefixed "~" since
// it's an estimate rather than a per-block timestamp fetch.
function blocksAgo(block: bigint, tip: bigint | null): string {
  if (!tip || block <= 0n || tip < block) return 'just now';
  const secs = Number(tip - block) * 12;
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `~${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `~${hrs}h ago`;
  return `~${Math.round(hrs / 24)}d ago`;
}

interface DropMints {
  mints: MintRow[] | null;
  uniqueMinters: number;
  loading: boolean;
  error: string | null;
  deployed: boolean;
  tipBlock: bigint | null;
}

// Reads a drop's recent mint history once on mount, then tails new mints live.
function useDropMints(dropAddress?: string): DropMints {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const deployed = !!dropAddress && dropAddress !== ZERO_ADDR;
  const [mints, setMints] = useState<MintRow[] | null>(null);
  const [tipBlock, setTipBlock] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publicClient || !deployed || !dropAddress) {
      setMints(deployed ? null : []);
      return;
    }
    const client = publicClient;
    const addr = dropAddress as Address;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const tip = await client.getBlockNumber();
        const start = tip > MINT_LOOKBACK ? tip - MINT_LOOKBACK : 0n;
        const raw: RawTransferLog[] = [];
        for (let from = start; from <= tip; from += LOGS_CHUNK) {
          const toB = from + LOGS_CHUNK - 1n > tip ? tip : from + LOGS_CHUNK - 1n;
          const logs = await client.getLogs({
            address: addr,
            event: TRANSFER_EVENT,
            args: { from: ZERO_ADDR as Address },
            fromBlock: from,
            toBlock: toB,
          });
          raw.push(...(logs as unknown as RawTransferLog[]));
        }
        if (cancelled) return;
        setTipBlock(tip);
        setMints(groupMints(raw));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message.slice(0, 100) : 'Failed to load mints');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, dropAddress, deployed]);

  // Live tail: append new mints without re-sweeping history.
  useWatchContractEvent({
    address: deployed ? (dropAddress as Address) : undefined,
    abi: [TRANSFER_EVENT],
    eventName: 'Transfer',
    args: { from: ZERO_ADDR as Address },
    chainId: CHAIN_ID,
    enabled: deployed,
    onLogs: (logs) => {
      const fresh = groupMints(logs as unknown as RawTransferLog[]);
      if (fresh.length === 0) return;
      setMints((prev) => {
        const prevRows = prev ?? [];
        const seen = new Set(prevRows.map((mr) => mr.txHash));
        // If one tx's mints straddle two poll batches, fold the new qty into the
        // existing row instead of dropping it (which would undercount qty).
        const freshByTx = new Map(fresh.map((mr) => [mr.txHash, mr.qty] as const));
        const merged = prevRows.map((mr) =>
          freshByTx.has(mr.txHash) ? { ...mr, qty: mr.qty + freshByTx.get(mr.txHash)! } : mr,
        );
        const added = fresh.filter((mr) => !seen.has(mr.txHash));
        return [...added, ...merged];
      });
      const newest = fresh[0]?.blockNumber ?? 0n;
      setTipBlock((t) => (t && t > newest ? t : newest));
    },
  });

  const uniqueMinters = useMemo(
    () => new Set((mints ?? []).map((mr) => mr.to.toLowerCase())).size,
    [mints],
  );

  return { mints, uniqueMinters, loading, error, deployed, tipBlock };
}

/* ─── Creator Revenue Dashboard ─── */
export function CreatorRevenueDashboard({
  drop,
  dropAddress,
}: {
  drop: { mintPrice: bigint; totalMinted: number };
  dropAddress?: string;
}) {
  const totalRevenue = Number(formatEther(drop.mintPrice * BigInt(drop.totalMinted)));
  const { uniqueMinters, loading } = useDropMints(dropAddress);

  return (
    <ArtCard art={pageArt('launchpad-shared', 0)} opacity={1} overlay="none" className="mb-6">
      <h3 className="text-white font-semibold tracking-wide uppercase text-[11px] mb-4">
        Creator Revenue Dashboard
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="text-center p-3 rounded-lg bg-black/60 border border-white/20">
          <p className={LABEL}>Total Minted</p>
          <p className="text-white font-mono text-xl tabular-nums">{drop.totalMinted}</p>
        </div>
        <div className="text-center p-3 rounded-lg bg-black/60 border border-white/20">
          {/* F270: mintPrice × totalMinted assumes a flat price — wrong for
              Dutch-auction or repriced drops, so label it an estimate. */}
          <p className={LABEL}>Est. Revenue</p>
          <p className="text-white font-mono text-xl tabular-nums">{totalRevenue.toFixed(4)} <span className="text-white text-sm">ETH</span></p>
          <p className="text-[9px] text-white mt-0.5">Flat-price estimate</p>
        </div>
        <div className="text-center p-3 rounded-lg bg-black/60 border border-white/20">
          <p className={LABEL}>Unique Minters</p>
          <p className="text-white font-mono text-xl tabular-nums">
            {loading && uniqueMinters === 0 ? '…' : uniqueMinters.toLocaleString()}
          </p>
          <p className="text-[9px] text-white mt-0.5">Recent on-chain mints</p>
        </div>
      </div>
    </ArtCard>
  );
}

/* ─── Live Mint Feed ─── */
export function LiveMintFeed({ dropAddress }: { dropAddress?: string }) {
  const { mints, loading, error, deployed, tipBlock } = useDropMints(dropAddress);
  const visible = (mints ?? []).slice(0, 8);
  const showSkeleton = deployed && mints === null && loading;

  return (
    <ArtCard art={pageArt('launchpad-shared', 1)} opacity={1} overlay="none" className="mb-6">
      <h3 className="text-white font-semibold tracking-wide uppercase text-[11px] mb-4">
        Live Mint Feed
      </h3>
      <div className="space-y-2.5 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
        {showSkeleton ? (
          [0, 1, 2].map((i) => (
            <div key={i} className="h-9 rounded-lg bg-black/40 border border-white/10 animate-pulse" />
          ))
        ) : visible.length > 0 ? (
          visible.map((mintRow) => (
            <div
              key={mintRow.txHash}
              className="flex items-center justify-between py-2 px-3 rounded-lg bg-black/60 border border-white/20"
            >
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                <span className="text-white font-mono text-xs">{shortenAddress(mintRow.to)}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-white/80 text-xs font-mono">x{mintRow.qty}</span>
                <span className="text-white text-[10px]">{blocksAgo(mintRow.blockNumber, tipBlock)}</span>
              </div>
            </div>
          ))
        ) : (
          <div className="py-6 text-center">
            <span className="relative inline-flex h-2 w-2 mb-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <p className="text-white text-[11px]">
              {error
                ? 'Mint activity is momentarily unavailable.'
                : 'No mints yet — this feed updates live as collectors mint.'}
            </p>
          </div>
        )}
      </div>
      <p className="text-center text-[10px] text-white mt-3">
        Live from on-chain mint events
      </p>
    </ArtCard>
  );
}
