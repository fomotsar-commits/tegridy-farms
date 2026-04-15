import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAccount, useReadContract } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ART } from '../lib/artConfig';
import { TEGRIDY_LAUNCHPAD_ADDRESS, isDeployed } from '../lib/constants';
import { TEGRIDY_LAUNCHPAD_ABI } from '../lib/contracts';
import { usePageTitle } from '../hooks/usePageTitle';
import { useNFTDrop } from '../hooks/useNFTDrop';
import { GLASS, LABEL, BTN_EMERALD, FEATURE_BULLETS, fadeUp, fadeUpVariants, stagger } from '../components/launchpad/launchpadConstants';
import { ArtCard, PhaseBadge, useExplorerAddressUrl } from '../components/launchpad/launchpadShared';
import { CollectionDetail } from '../components/launchpad/CollectionDetail';
import { CreateCollectionForm } from '../components/launchpad/CreateCollectionForm';

/* ─────────────────────────── Collection Card ─────────────────────────── */

function CollectionCard({
  collectionId,
  onSelect,
  selectedAddr,
  deployed: _deployed,
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
  const contractAddr = collection ? (collection as unknown as unknown[])[1] as string : '';
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
          aria-label={`Select ${name} (${symbol})`}
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

/* ─────────────────────────── Coming Soon ──────────────────────────────── */

/** @internal Reserved for future use */
export function ComingSoonPanel() {
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
                <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl mb-3">NFT Launchpad</h1>
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
