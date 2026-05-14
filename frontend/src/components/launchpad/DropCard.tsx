import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { useEnsName } from 'wagmi';
import { formatEther } from 'viem';
import { mainnet } from 'wagmi/chains';
import { ArtImg } from '../ArtImg';
import { shortenAddress } from '../../lib/formatting';
import { resolveAssetUrl, resolveContractUri } from '../../hooks/useNFTDropV2';
import type { DropRow } from '../../hooks/useLaunchpadList';
import { PHASE } from '../../hooks/useLaunchpadList';
import type { ContractMetadata } from '../../lib/nftMetadata';

type Props = {
  drop: DropRow;
  /** Position in the gallery — used for deterministic fallback art rotation. */
  idx: number;
};

function phaseLabel(d: DropRow): { label: string; tone: 'live' | 'soon' | 'closed' } {
  const isFull = d.maxSupply > 0n && d.totalSupply >= d.maxSupply;
  if (isFull) return { label: 'Sold out', tone: 'closed' };
  if (d.mintPhase === PHASE.CANCELLED) return { label: 'Cancelled', tone: 'closed' };
  if (d.paused) return { label: 'Paused', tone: 'closed' };
  if (d.mintPhase === PHASE.DUTCH) return { label: 'Dutch auction', tone: 'live' };
  if (d.mintPhase === PHASE.PUBLIC) return { label: 'Public mint', tone: 'live' };
  if (d.mintPhase === PHASE.ALLOWLIST) return { label: 'Allowlist', tone: 'live' };
  return { label: 'Coming soon', tone: 'soon' };
}

const TONE_STYLE: Record<'live' | 'soon' | 'closed', React.CSSProperties> = {
  live: { background: 'rgba(34,197,94,0.18)', color: '#86efac', border: '1px solid rgba(34,197,94,0.4)' },
  soon: { background: 'rgba(244,191,68,0.18)', color: '#fde68a', border: '1px solid rgba(244,191,68,0.4)' },
  closed: { background: 'rgba(148,163,184,0.18)', color: '#cbd5e1', border: '1px solid rgba(148,163,184,0.4)' },
};

export function DropCard({ drop, idx }: Props) {
  const { label, tone } = phaseLabel(drop);
  const isFull = drop.maxSupply > 0n && drop.totalSupply >= drop.maxSupply;
  const canMint =
    !isFull &&
    !drop.paused &&
    drop.mintPhase !== PHASE.CLOSED &&
    drop.mintPhase !== PHASE.CANCELLED;

  // ENS reverse-resolution. wagmi gates this to mainnet automatically; we
  // keep it cheap with a generous staleTime so first-paint feeds the
  // shortened address and the ENS swaps in once resolved.
  const { data: ens } = useEnsName({
    address: drop.creator,
    chainId: mainnet.id,
    query: { staleTime: 24 * 60 * 60 * 1000, gcTime: 24 * 60 * 60 * 1000 },
  });
  const creatorDisplay = ens ?? shortenAddress(drop.creator);

  // ─── art preview ────────────────────────────────────────────────
  // First try the collection's contractURI image (Arweave); fall back to a
  // deterministic pageArt rotation so cards never render an empty box.
  const [metadata, setMetadata] = useState<ContractMetadata | null>(null);
  useEffect(() => {
    if (!drop.contractURI) {
      setMetadata(null);
      return;
    }
    const url = resolveContractUri(drop.contractURI);
    if (!url) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6_000);
    fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => setMetadata(JSON.parse(t) as ContractMetadata))
      .catch(() => setMetadata(null))
      .finally(() => clearTimeout(timer));
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [drop.contractURI]);
  const collectionImage = resolveAssetUrl(metadata?.image);

  const supplyRemaining = useMemo(() => {
    if (drop.maxSupply <= 0n) return null;
    if (drop.totalSupply >= drop.maxSupply) return 0n;
    return drop.maxSupply - drop.totalSupply;
  }, [drop.maxSupply, drop.totalSupply]);

  const priceEth = useMemo(() => {
    const wei = drop.mintPhase === PHASE.DUTCH ? drop.currentPrice : drop.mintPrice;
    if (wei <= 0n) return '0';
    const n = Number(formatEther(wei));
    if (n < 0.0001) return n.toFixed(6);
    if (n < 1) return n.toFixed(4);
    return n.toFixed(3);
  }, [drop.mintPrice, drop.currentPrice, drop.mintPhase]);

  // Link both for "Mint" and "View" — the detail panel inside LendingPage
  // already exists (CollectionDetailV2). We deep-link via ?address=… and
  // section=launchpad so users land on the right tab.
  const detailHref = `/nft-finance?section=launchpad&address=${drop.address}`;

  return (
    <m.div
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.35, delay: Math.min(idx, 6) * 0.04 }}
    >
      <Link
        to={detailHref}
        aria-label={`${drop.name}: ${label}, ${supplyRemaining ?? 'unlimited'} left`}
        className="block group relative rounded-xl overflow-hidden glass-card-animated card-hover focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
        style={{ border: '1px solid var(--color-purple-75)' }}
      >
        {/* Art layer — uses contractURI image when available, else a
            deterministic page-art fallback. The art is part of the
            personality surface we never delete. */}
        <div className="relative aspect-[4/5] overflow-hidden">
          {collectionImage ? (
            <img
              src={collectionImage}
              alt={drop.name}
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            />
          ) : (
            <ArtImg
              pageId={`launchpad-card-${drop.address.slice(2, 10)}`}
              idx={0}
              alt={drop.name}
              loading="lazy"
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            />
          )}

          {/* Phase badge (top-left) */}
          <div
            className="absolute top-2 left-2 px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide"
            style={TONE_STYLE[tone]}
          >
            {label}
          </div>

          {/* Supply remaining (top-right) — only when there is a cap */}
          {supplyRemaining !== null && (
            <div
              className="absolute top-2 right-2 px-2 py-0.5 rounded-md text-[10px] font-mono"
              style={{
                background: 'rgba(6,12,26,0.78)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: '#fff',
                backdropFilter: 'blur(6px)',
                WebkitBackdropFilter: 'blur(6px)',
              }}
            >
              {supplyRemaining.toString()}/{drop.maxSupply.toString()}
            </div>
          )}
        </div>

        {/* Info panel — dark, readable over any art. */}
        <div className="relative p-3 md:p-4" style={{ background: 'rgba(6,12,26,0.92)' }}>
          <div className="flex items-baseline justify-between gap-2">
            <h3
              className="text-white text-[14px] md:text-[15px] font-semibold truncate"
              title={drop.name}
            >
              {drop.name || drop.symbol || shortenAddress(drop.address)}
            </h3>
            <span
              className="text-[11px] font-mono shrink-0"
              style={{ color: 'var(--color-weed)' }}
            >
              {priceEth} ETH
            </span>
          </div>
          <p
            className="text-[11px] mt-0.5 truncate"
            style={{ color: 'rgba(255,255,255,0.6)' }}
            title={drop.creator}
          >
            by {creatorDisplay}
          </p>

          {/* Single CTA per card — Mint when live, View otherwise. The
              wrapping <Link> already navigates; the button keeps a tap
              affordance and a clear verb. */}
          <div
            className="mt-3 w-full py-2 rounded-lg text-[12px] font-semibold text-center transition-all"
            style={
              canMint
                ? {
                    background: 'linear-gradient(135deg, #2D8B4E 0%, #1f6e3d 100%)',
                    color: '#fff',
                    boxShadow: '0 2px 10px rgba(45,139,78,0.35)',
                  }
                : {
                    background: 'rgba(255,255,255,0.06)',
                    color: 'rgba(255,255,255,0.75)',
                    border: '1px solid rgba(255,255,255,0.12)',
                  }
            }
          >
            {canMint ? 'Mint' : 'View'}
          </div>
        </div>
      </Link>
    </m.div>
  );
}
