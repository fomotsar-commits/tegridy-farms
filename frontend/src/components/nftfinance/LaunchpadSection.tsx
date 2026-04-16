import { useState, useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { motion } from 'framer-motion';
import { type Address } from 'viem';
import { TEGRIDY_LAUNCHPAD_ADDRESS, isDeployed } from '../../lib/constants';
import { TEGRIDY_LAUNCHPAD_ABI } from '../../lib/contracts';
import { shortenAddress } from '../../lib/formatting';
import { CreateCollectionForm } from '../launchpad/CreateCollectionForm';
import { CollectionDetail } from '../launchpad/CollectionDetail';
import { FEATURE_BULLETS } from '../launchpad/launchpadConstants';

const CARD_BG = 'rgba(13, 21, 48, 0.6)';
const CARD_BORDER = 'var(--color-purple-12)';

export function LaunchpadSection() {
  const deployed = isDeployed(TEGRIDY_LAUNCHPAD_ADDRESS);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);

  const { data: collectionCount, refetch } = useReadContract({
    address: TEGRIDY_LAUNCHPAD_ADDRESS as Address,
    abi: TEGRIDY_LAUNCHPAD_ABI,
    functionName: 'getCollectionCount',
    query: { enabled: deployed },
  });

  const count = collectionCount !== undefined ? Number(collectionCount) : 0;

  // Read all collections (up to 20)
  const collectionContracts = useMemo(() => {
    const limit = Math.min(count, 20);
    return Array.from({ length: limit }, (_, i) => ({
      address: TEGRIDY_LAUNCHPAD_ADDRESS as Address,
      abi: TEGRIDY_LAUNCHPAD_ABI,
      functionName: 'getCollection' as const,
      args: [BigInt(i)],
    }));
  }, [count]);

  const { data: collectionResults } = useReadContracts({
    contracts: collectionContracts,
    query: { enabled: count > 0 },
  });

  if (!deployed) {
    return (
      <div className="rounded-2xl p-8 text-center" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <p className="text-white/50 text-sm">Launchpad contract not deployed yet.</p>
      </div>
    );
  }

  // If viewing a specific collection detail
  if (selectedCollection) {
    return (
      <CollectionDetail
        dropAddress={selectedCollection}
        onClose={() => setSelectedCollection(null)}
        deployed={deployed}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Features Overview */}
      <div className="rounded-2xl p-5" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <h3 className="text-sm font-semibold text-white mb-3">NFT Launchpad</h3>
        <p className="text-[12px] text-white/50 mb-4">
          Deploy ERC-721 collections with built-in allowlists, dutch auctions, delayed reveals, and on-chain royalties. No code required.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {FEATURE_BULLETS.map(({ label, icon }) => (
            <div key={label} className="flex items-center gap-2 text-[12px] text-white/60">
              <span className="text-emerald-400">{icon}</span>
              {label}
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
          <p className="text-[11px] text-white/40 uppercase tracking-wider mb-1">Collections Deployed</p>
          <p className="text-lg font-semibold text-white">{count}</p>
        </div>
        <div className="rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
          <p className="text-[11px] text-white/40 uppercase tracking-wider mb-1">Contract</p>
          <a href={`https://etherscan.io/address/${TEGRIDY_LAUNCHPAD_ADDRESS}`} target="_blank" rel="noopener noreferrer"
            className="text-sm font-mono text-purple-300 hover:text-purple-200 transition-colors">
            {shortenAddress(TEGRIDY_LAUNCHPAD_ADDRESS)}
          </a>
        </div>
      </div>

      {/* Create Toggle */}
      <button onClick={() => setShowCreate(!showCreate)}
        className="w-full py-3 rounded-xl text-sm font-semibold transition-all"
        style={{
          background: showCreate ? 'rgba(239,68,68,0.1)' : 'linear-gradient(135deg, rgb(16 185 129), rgb(5 150 105))',
          color: showCreate ? '#ef4444' : 'white',
          border: showCreate ? '1px solid rgba(239,68,68,0.3)' : 'none',
          boxShadow: showCreate ? 'none' : '0 4px 15px rgba(16, 185, 129, 0.3)',
        }}>
        {showCreate ? 'Cancel' : 'Deploy New Collection'}
      </button>

      {/* Create Form */}
      {showCreate && (
        <CreateCollectionForm
          onCreated={() => { setShowCreate(false); refetch(); }}
          deployed={deployed}
        />
      )}

      {/* Collection List */}
      <div className="rounded-2xl overflow-hidden" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <div className="px-5 py-4 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white">Deployed Collections</h3>
        </div>
        {count === 0 ? (
          <p className="px-5 py-8 text-center text-white/30 text-sm">No collections deployed yet. Be the first.</p>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {collectionResults?.map((result, i) => {
              if (!result?.result) return null;
              const [, collectionAddr, creator, name, symbol] =
                result.result as [bigint, Address, Address, string, string];

              return (
                <motion.button key={i} onClick={() => setSelectedCollection(collectionAddr)}
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.05 }}
                  className="w-full px-5 py-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors text-left">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold text-xs">
                      {symbol.slice(0, 3)}
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold text-white">{name}</p>
                      <p className="text-[11px] text-white/40">{symbol} &middot; by {shortenAddress(creator)}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] text-white/30 font-mono">{shortenAddress(collectionAddr)}</p>
                  </div>
                </motion.button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
