import { useState, useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { m } from 'framer-motion';
import { type Address } from 'viem';
import { TEGRIDY_LAUNCHPAD_ADDRESS, TEGRIDY_LAUNCHPAD_V2_ADDRESS, isDeployed } from '../../lib/constants';
import { TEGRIDY_LAUNCHPAD_ABI, TEGRIDY_LAUNCHPAD_V2_ABI } from '../../lib/contracts';
import { shortenAddress } from '../../lib/formatting';
import { CreateCollectionForm } from '../launchpad/CreateCollectionForm';
import { CreateWizard } from '../launchpad/wizard/CreateWizard';
import { CollectionDetail } from '../launchpad/CollectionDetail';
import { CollectionDetailV2 } from '../launchpad/CollectionDetailV2';
import { FEATURE_BULLETS } from '../launchpad/launchpadConstants';
import { ART } from '../../lib/artConfig';

const CARD_BG = 'rgba(6, 12, 26, 0.80)';
const CARD_BORDER = 'var(--color-purple-12)';
const PANEL_STYLE: React.CSSProperties = {
  background: 'rgba(0,0,0,0.55)',
  backdropFilter: 'blur(2px)',
  border: '1px solid rgba(255,255,255,0.08)',
};

type CollectionRow = {
  version: 'v1' | 'v2';
  id: bigint;
  address: Address;
  creator: Address;
  name: string;
  symbol: string;
};

export function LaunchpadSection() {
  const deployed = isDeployed(TEGRIDY_LAUNCHPAD_ADDRESS);
  const v2Live = isDeployed(TEGRIDY_LAUNCHPAD_V2_ADDRESS);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState<{
    address: string;
    version: 'v1' | 'v2';
  } | null>(null);

  // ─── V1 factory reads (always attempted) ───────────────────────
  const { data: v1Count, refetch: refetchV1 } = useReadContract({
    address: TEGRIDY_LAUNCHPAD_ADDRESS as Address,
    abi: TEGRIDY_LAUNCHPAD_ABI,
    functionName: 'getCollectionCount',
    query: { enabled: deployed },
  });

  const v1CountNum = v1Count !== undefined ? Number(v1Count) : 0;

  const v1Contracts = useMemo(() => {
    const limit = Math.min(v1CountNum, 20);
    return Array.from({ length: limit }, (_, i) => ({
      address: TEGRIDY_LAUNCHPAD_ADDRESS as Address,
      abi: TEGRIDY_LAUNCHPAD_ABI,
      functionName: 'getCollection' as const,
      args: [BigInt(i)],
    }));
  }, [v1CountNum]);

  const { data: v1Results } = useReadContracts({
    contracts: v1Contracts,
    query: { enabled: v1CountNum > 0 },
  });

  // ─── V2 factory reads (gated on non-zero address) ─────────────
  // The query.enabled guard stops wagmi from hitting a zero-address while
  // the factory is pre-deploy — otherwise the read would revert and noise
  // up the page with red toasts.
  const { data: v2Count, refetch: refetchV2 } = useReadContract({
    address: TEGRIDY_LAUNCHPAD_V2_ADDRESS as Address,
    abi: TEGRIDY_LAUNCHPAD_V2_ABI,
    functionName: 'getCollectionCount',
    query: { enabled: v2Live },
  });

  const v2CountNum = v2Count !== undefined ? Number(v2Count) : 0;

  const v2Contracts = useMemo(() => {
    const limit = Math.min(v2CountNum, 20);
    return Array.from({ length: limit }, (_, i) => ({
      address: TEGRIDY_LAUNCHPAD_V2_ADDRESS as Address,
      abi: TEGRIDY_LAUNCHPAD_V2_ABI,
      functionName: 'getCollection' as const,
      args: [BigInt(i)],
    }));
  }, [v2CountNum]);

  const { data: v2Results } = useReadContracts({
    contracts: v2Contracts,
    query: { enabled: v2Live && v2CountNum > 0 },
  });

  // Merge V1 + V2 rows. V2 shown first so the newer flow leads visually;
  // otherwise maintain factory-order within each version.
  const rows: CollectionRow[] = useMemo(() => {
    const out: CollectionRow[] = [];
    if (v2Results) {
      v2Results.forEach((r) => {
        if (!r?.result) return;
        // V2 `getCollection` returns a struct, decoded by wagmi as an object
        const struct = r.result as {
          id: bigint;
          collection: Address;
          creator: Address;
          name: string;
          symbol: string;
        };
        out.push({
          version: 'v2',
          id: struct.id,
          address: struct.collection,
          creator: struct.creator,
          name: struct.name,
          symbol: struct.symbol,
        });
      });
    }
    if (v1Results) {
      v1Results.forEach((r) => {
        if (!r?.result) return;
        // V1 returns a flat tuple: (id, collection, creator, name, symbol)
        const [id, collection, creator, name, symbol] =
          r.result as [bigint, Address, Address, string, string];
        out.push({ version: 'v1', id, address: collection, creator, name, symbol });
      });
    }
    return out;
  }, [v1Results, v2Results]);

  const totalCount = rows.length;

  const refetch = () => {
    void refetchV1();
    if (v2Live) void refetchV2();
  };

  if (!deployed) {
    return (
      <div className="rounded-2xl p-8 text-center" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <p className="text-white/70 text-sm">Launchpad contract not deployed yet.</p>
      </div>
    );
  }

  // If viewing a specific collection detail — route by version tag
  if (selectedCollection) {
    if (selectedCollection.version === 'v2') {
      return (
        <CollectionDetailV2
          dropAddress={selectedCollection.address}
          onClose={() => setSelectedCollection(null)}
          deployed={v2Live}
        />
      );
    }
    return (
      <CollectionDetail
        dropAddress={selectedCollection.address}
        onClose={() => setSelectedCollection(null)}
        deployed={deployed}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Features Overview */}
      <div className="rounded-2xl relative overflow-hidden" style={{ border: `1px solid ${CARD_BORDER}` }}>
        <img src={ART.jungleBus.src} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
        <div className="relative z-10 m-2 md:m-3 rounded-lg p-4 md:p-5" style={PANEL_STYLE}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>NFT Launchpad</h3>
          <p className="text-[12px] mb-4" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
            Deploy ERC-721 collections with built-in allowlists, dutch auctions, delayed reveals, and on-chain royalties. No code required.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {FEATURE_BULLETS.map(({ label, icon, color }) => (
              <div key={label} className="flex items-center gap-2 text-[12px]" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
                <span style={{ color, textShadow: `0 0 8px ${color}88, 0 1px 4px rgba(0,0,0,0.95)` }}>{icon}</span>
                {label}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl relative overflow-hidden" style={{ border: `1px solid ${CARD_BORDER}` }}>
          <img src={ART.mfersHeaven.src} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
          <div className="relative z-10 m-2 rounded-lg p-3 md:p-4" style={PANEL_STYLE}>
            <p className="text-[11px] uppercase tracking-wider mb-1" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Collections Deployed</p>
            <p className="text-lg font-semibold" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
              {totalCount}
              {v2Live && v2CountNum > 0 && (
                <span className="text-[11px] text-white/60 ml-2">
                  ({v2CountNum} v2 {'\u00B7'} {v1CountNum} v1)
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="rounded-xl relative overflow-hidden" style={{ border: `1px solid ${CARD_BORDER}` }}>
          <img src={ART.jbacSkeleton.src} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
          <div className="relative z-10 m-2 rounded-lg p-3 md:p-4" style={PANEL_STYLE}>
            <p className="text-[11px] uppercase tracking-wider mb-1" style={{ color: '#22c55e', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>Contract</p>
            <a href={`https://etherscan.io/address/${v2Live ? TEGRIDY_LAUNCHPAD_V2_ADDRESS : TEGRIDY_LAUNCHPAD_ADDRESS}`} target="_blank" rel="noopener noreferrer"
              className="text-sm font-mono text-purple-200 hover:text-purple-100 transition-colors" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
              {shortenAddress(v2Live ? TEGRIDY_LAUNCHPAD_V2_ADDRESS : TEGRIDY_LAUNCHPAD_ADDRESS)}
            </a>
          </div>
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

      {/* Create flow — always the V2 wizard (image upload + Arweave + CSV + preview).
          Step 5 shows an amber "factory pending" banner until `TEGRIDY_LAUNCHPAD_V2_ADDRESS`
          is populated post-deploy, but every step before deploy (Connect → Upload →
          Preview → Fund+Upload) works end-to-end. The legacy name/symbol-only form
          is kept on disk for reference via `?legacy=1` but no longer the default. */}
      {showCreate && (() => {
        const legacyOverride =
          typeof window !== 'undefined' &&
          new URLSearchParams(window.location.search).get('legacy') === '1';
        return legacyOverride
          ? <CreateCollectionForm
              onCreated={() => { setShowCreate(false); refetch(); }}
              deployed={deployed}
            />
          : <CreateWizard onCreated={() => { setShowCreate(false); refetch(); }} />;
      })()}

      {/* Collection List */}
      <div className="rounded-2xl overflow-hidden" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <div className="px-5 py-4 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white">Deployed Collections</h3>
        </div>
        {totalCount === 0 ? (
          <p className="px-5 py-8 text-center text-white/30 text-sm">No collections deployed yet. Be the first.</p>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {rows.map((row, i) => (
              <m.button
                key={`${row.version}-${row.address}`}
                onClick={() => setSelectedCollection({ address: row.address, version: row.version })}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.05 }}
                className="w-full px-5 py-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold text-xs">
                    {row.symbol.slice(0, 3)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-semibold text-white">{row.name}</p>
                      <VersionChip version={row.version} />
                    </div>
                    <p className="text-[11px] text-white/70">{row.symbol} {'\u00B7'} by {shortenAddress(row.creator)}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-[11px] text-white/30 font-mono">{shortenAddress(row.address)}</p>
                </div>
              </m.button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function VersionChip({ version }: { version: 'v1' | 'v2' }) {
  if (version === 'v2') {
    return (
      <span
        className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider"
        style={{
          background: 'rgba(16, 185, 129, 0.15)',
          border: '1px solid rgba(16, 185, 129, 0.45)',
          color: '#6ee7b7',
        }}
      >
        V2
      </span>
    );
  }
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider"
      style={{
        background: 'rgba(168, 85, 247, 0.15)',
        border: '1px solid rgba(168, 85, 247, 0.45)',
        color: '#d8b4fe',
      }}
    >
      V1
    </span>
  );
}
