import { useState, useMemo, useCallback } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { useAccount } from 'wagmi';
import { formatEther } from 'viem';
import { ART } from '../../lib/artConfig';
import { useNFTDropV2 } from '../../hooks/useNFTDropV2';
import { INPUT, LABEL, BTN_EMERALD } from './launchpadConstants';
import { ArtCard, PhaseIndicator, useExplorerAddressUrl, CreatorRevenueDashboard, LiveMintFeed } from './launchpadShared';
import { OwnerAdminPanelV2 } from './OwnerAdminPanelV2';
// R071: route external_link through the strict allowlist so a creator-supplied
// `javascript:` / `file:` / `data:text/html` URI never lands as a clickable href.
import { resolveSafeUrl } from '../../lib/imageSafety';

/// Detail view for TegridyDropV2 clones — mirrors the legacy v1
/// `CollectionDetail` layout but consumes `useNFTDropV2`, renders the
/// contractURI banner / description / external link when the off-chain JSON
/// loads, and routes the owner to `OwnerAdminPanelV2` (richer controls than
/// the v1 panel). Kept as a sibling file rather than a fork so both flows can
/// evolve independently — v1 is frozen once the v2 factory is live.
export function CollectionDetailV2({
  dropAddress,
  onClose,
  deployed,
}: {
  dropAddress: string;
  onClose: () => void;
  deployed: boolean;
}) {
  const { isConnected } = useAccount();
  const drop = useNFTDropV2(dropAddress);
  const explorerUrl = useExplorerAddressUrl(dropAddress);
  const [mintQty, setMintQty] = useState(1);
  const [proofInput, setProofInput] = useState('');
  const shortAddr = `${dropAddress.slice(0, 6)}...${dropAddress.slice(-4)}`;

  const totalCost = useMemo(
    () => Number(formatEther(drop.currentPrice * BigInt(mintQty))),
    [drop.currentPrice, mintQty],
  );

  const mintLabel = useMemo(() => {
    if (!deployed) return 'Contract Not Deployed';
    if (!isConnected) return 'Connect Wallet';
    if (drop.isCancelled) return 'Sale Cancelled';
    if (drop.paused) return 'Minting Paused';
    if (drop.isPending) return 'Confirm in Wallet...';
    if (drop.isConfirming) return 'Confirming...';
    if (drop.isSoldOut) return 'Sold Out';
    if (drop.currentPhase === 0) return 'Minting Paused';
    return `Mint ${mintQty} for ${totalCost.toFixed(4)} ETH`;
  }, [deployed, isConnected, drop.isCancelled, drop.paused, drop.isPending, drop.isConfirming, drop.isSoldOut, drop.currentPhase, mintQty, totalCost]);

  const mintDisabled =
    !deployed ||
    !isConnected ||
    drop.isCancelled ||
    drop.paused ||
    drop.isPending ||
    drop.isConfirming ||
    drop.isSoldOut ||
    drop.currentPhase === 0 ||
    (drop.currentPhase === 1 && !proofInput.trim());

  const progressPct = drop.maxSupply > 0 ? Math.min(100, (drop.totalSupply / drop.maxSupply) * 100) : 0;

  const handleMint = useCallback(() => {
    if (!deployed) return;
    const proof = proofInput.trim()
      ? proofInput.split(',').map((s) => s.trim() as `0x${string}`)
      : [];
    drop.mint(mintQty, proof);
  }, [drop, mintQty, proofInput, deployed]);

  const displayName = drop.collectionMetadata?.name ?? 'Collection Details';
  const displayDescription = drop.collectionMetadata?.description;
  // R071: scheme-allowlist external_link before it becomes a clickable href.
  // resolveSafeUrl returns null for anything outside https / ipfs / ar / data:image/* —
  // creator-supplied `javascript:` / `file:` / `data:text/html` is rejected.
  const safeExternalLink = useMemo(
    () => resolveSafeUrl(drop.collectionMetadata?.external_link ?? null),
    [drop.collectionMetadata?.external_link],
  );
  const rawExternalLink = drop.collectionMetadata?.external_link;

  return (
    <m.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="mb-8"
    >
      {/* Banner hero (only when contractURI supplies a banner) */}
      {drop.resolvedBanner && (
        <div
          className="relative w-full rounded-2xl mb-4 overflow-hidden"
          style={{
            height: '180px',
            border: '1px solid var(--color-purple-75)',
          }}
        >
          <img
            src={drop.resolvedBanner}
            alt={`${displayName} banner`}
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.75) 100%)',
            }}
          />
          <div className="relative z-10 h-full flex items-end px-5 pb-4">
            <div className="flex items-center gap-4">
              {drop.resolvedImage && (
                <img
                  src={drop.resolvedImage}
                  alt=""
                  className="w-16 h-16 rounded-xl border border-white/30 object-cover"
                  loading="lazy"
                />
              )}
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="heading-luxury text-xl sm:text-2xl text-white">
                    {displayName}
                  </h2>
                  <span
                    className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider"
                    style={{
                      background: 'rgba(16, 185, 129, 0.15)',
                      border: '1px solid rgba(16, 185, 129, 0.45)',
                      color: '#6ee7b7',
                    }}
                  >
                    V2
                  </span>
                </div>
                {displayDescription && (
                  <p className="text-white/80 text-xs mt-1 max-w-lg line-clamp-2">
                    {displayDescription}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main panel */}
      <ArtCard art={ART.beachVibes} opacity={1} overlay="none" className="rounded-2xl mb-0">
        <div className="p-1 sm:p-3">
          <div className="flex items-start justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h2 className="heading-luxury text-xl sm:text-2xl">
                  {displayName}
                </h2>
                {!drop.resolvedBanner && (
                  <span
                    className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider"
                    style={{
                      background: 'rgba(16, 185, 129, 0.15)',
                      border: '1px solid rgba(16, 185, 129, 0.45)',
                      color: '#065f46',
                    }}
                  >
                    V2
                  </span>
                )}
                {drop.isOwner && (
                  <span
                    className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider"
                    style={{
                      background: 'rgba(168, 85, 247, 0.15)',
                      border: '1px solid rgba(168, 85, 247, 0.45)',
                      color: '#6b21a8',
                    }}
                  >
                    Owned by you
                  </span>
                )}
              </div>
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-black/70 hover:text-black text-xs font-mono hover:underline"
              >
                {shortAddr}
              </a>
              {safeExternalLink ? (
                <>
                  <span className="text-black/30 text-xs mx-2">{'\u00B7'}</span>
                  <a
                    href={safeExternalLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-black/70 hover:text-black text-xs hover:underline"
                  >
                    Project site {'\u2197'}
                  </a>
                </>
              ) : rawExternalLink ? (
                <>
                  <span className="text-black/30 text-xs mx-2">{'\u00B7'}</span>
                  <span
                    className="text-black/40 text-xs cursor-not-allowed"
                    title="Project link uses an unsupported URI scheme and was hidden for safety."
                  >
                    Project site (link blocked)
                  </span>
                </>
              ) : null}
              {drop.metadataError && !drop.collectionMetadata && (
                <p className="text-amber-900/80 text-[10px] mt-1">
                  Off-chain metadata unavailable — showing on-chain basics only.
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-white hover:text-white text-sm transition-colors p-1"
            >
              {'\u2715'}
            </button>
          </div>

          {/* Phase Indicator */}
          <div className="flex justify-center mb-8">
            <PhaseIndicator current={drop.currentPhase} />
          </div>

          {/* Cancelled-sale refund banner */}
          {drop.isCancelled && (
            <div
              className="rounded-xl p-4 mb-6"
              style={{
                background: 'rgba(239, 68, 68, 0.10)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
              }}
              role="alert"
            >
              <div className="flex items-start gap-3">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fca5a5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 flex-shrink-0">
                  <circle cx="12" cy="12" r="9" />
                  <line x1="12" y1="8" x2="12" y2="13" />
                  <line x1="12" y1="16.5" x2="12" y2="16.5" />
                </svg>
                <div className="flex-1">
                  <p className="text-red-200 text-sm font-semibold mb-1">Sale cancelled {'\u2014'} refunds are open</p>
                  <p className="text-red-100/80 text-xs leading-relaxed">
                    The creator ended this drop. Minting is disabled. If you previously paid in, you can
                    pull your funds back now. Refunds are pull-pattern (non-custodial) and cannot be
                    blocked.
                  </p>
                  {drop.canRefund ? (
                    <div className="mt-3 flex items-center gap-3 flex-wrap">
                      <span className="text-red-100 text-xs font-mono">
                        You paid: {Number(drop.paidByUser) / 1e18} ETH
                      </span>
                      <button
                        onClick={() => drop.refund()}
                        disabled={drop.isPending || drop.isConfirming}
                        className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{
                          background: 'rgba(239, 68, 68, 0.2)',
                          border: '1px solid rgba(239, 68, 68, 0.5)',
                          color: '#fca5a5',
                        }}
                      >
                        {drop.isPending ? 'Check wallet\u2026' : drop.isConfirming ? 'Refunding\u2026' : 'Claim Refund'}
                      </button>
                    </div>
                  ) : (
                    <p className="mt-2 text-red-100/60 text-[11px]">
                      {isConnected ? 'No refund owed to this wallet.' : 'Connect your wallet to check for a refund.'}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Paused circuit banner (distinct from phase=Paused) */}
          {drop.paused && !drop.isCancelled && (
            <div
              className="rounded-xl p-3 mb-6"
              style={{
                background: 'rgba(234, 179, 8, 0.10)',
                border: '1px solid rgba(234, 179, 8, 0.35)',
              }}
              role="status"
            >
              <p className="text-amber-200 text-xs">
                Contract is paused by the owner {'\u2014'} minting temporarily disabled.
              </p>
            </div>
          )}

          {/* Stats Row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            <div className="rounded-xl p-3 sm:p-4 text-center bg-black/60 border border-white/[0.05]">
              <p className={LABEL}>Minted</p>
              <p className="text-white font-mono text-lg tabular-nums">
                {drop.totalSupply}
                <span className="text-white">/{drop.maxSupply}</span>
              </p>
            </div>
            <div className="rounded-xl p-3 sm:p-4 text-center bg-black/60 border border-white/[0.05]">
              <p className={LABEL}>Price</p>
              <p className="text-white font-mono text-lg tabular-nums">{drop.currentPriceFormatted} ETH</p>
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
              <div
                className="w-full h-2 rounded-full bg-black/60 overflow-hidden"
                role="progressbar"
                aria-valuenow={Math.round(progressPct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <m.div
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

          {/* Paused empty state (phase=0) */}
          {drop.currentPhase === 0 && (
            <ArtCard art={ART.towelieWindow} opacity={1} overlay="none" className="mb-6">
              <div className="text-center py-4">
                <div className="text-white/15 text-4xl mb-3">{'\u23F8'}</div>
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
                  <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                    <label className={LABEL} htmlFor="mint-v2-merkleProof">Merkle Proof</label>
                    <input
                      id="mint-v2-merkleProof"
                      type="text"
                      value={proofInput}
                      onChange={(e) => setProofInput(e.target.value)}
                      placeholder="0xabc...,0xdef..."
                      className={`${INPUT} font-mono text-xs`}
                    />
                    <span className="text-[10px] text-white mt-1 block">
                      Comma-separated hex strings. Get your proof from the project.
                    </span>
                  </m.div>
                )}
              </AnimatePresence>

              {/* Quantity + Mint */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <div className="flex items-center gap-2">
                  <button
                    className="w-9 h-9 rounded-lg bg-black/60 hover:bg-black/60 text-white transition-colors text-lg leading-none"
                    onClick={() => setMintQty(Math.max(1, mintQty - 1))}
                  >
                    {'\u2212'}
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
      {drop.isOwner && (
        <CreatorRevenueDashboard
          drop={{ mintPrice: drop.mintPrice, totalMinted: drop.totalSupply }}
        />
      )}

      {/* Owner Admin — V2 richer surface */}
      {drop.isOwner && <OwnerAdminPanelV2 dropAddress={dropAddress} deployed={deployed} />}
    </m.div>
  );
}
