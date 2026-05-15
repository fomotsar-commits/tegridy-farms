import { useEnsName, useAccount } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { formatEther } from 'viem';
import { useLeaderboards, highlightRowIf } from '../../hooks/useLeaderboards';
import { shortenAddress } from '../../lib/formatting';

/**
 * Real top-N leaderboards (P1-5). Three tables in one card:
 *
 *   • Top 100 stakers — ranked by boosted voting power (amount × boost).
 *   • Top 20 voters this epoch — ranked by power applied.
 *   • Top 20 creators — ranked by drops launched (V2 launchpad).
 *
 * The whole component returns null when the indexer is unavailable or
 * has nothing to report, so the existing personal-stats card on
 * LeaderboardPage stays the page's sole content. ENS resolved per row;
 * the connected wallet's row is highlighted.
 */
export function LeaderboardTables() {
  const { address } = useAccount();
  const { stakers, voters, creators, isAvailable, isLoading } = useLeaderboards();

  if (!isAvailable) return null;
  if (isLoading) return <LoadingShimmer />;

  const hasAny = stakers.length + voters.length + creators.length > 0;
  if (!hasAny) return null;

  return (
    <div className="mb-6 space-y-4">
      <h2
        className="heading-luxury text-xl text-white tracking-tight"
        style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
      >
        Leaderboards
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {stakers.length > 0 && (
          <Table
            title="Top stakers"
            subtitle="By boosted voting power"
            rows={stakers}
            address={address}
            renderRow={(s, i) => (
              <Row
                key={s.user}
                rank={i + 1}
                address={s.user}
                primary={`${trimEth(s.boostedAmount)} TOWELI`}
                secondary={s.positions > 1 ? `${s.positions} positions` : '1 position'}
                isMe={highlightRowIf(s.user, address)}
              />
            )}
          />
        )}

        {voters.length > 0 && (
          <Table
            title="Top voters this epoch"
            subtitle="By power applied"
            rows={voters}
            address={address}
            renderRow={(v, i) => (
              <Row
                key={v.user}
                rank={i + 1}
                address={v.user}
                primary={`${trimEth(v.totalPower)} power`}
                secondary={v.votes > 1 ? `${v.votes} votes` : '1 vote'}
                isMe={highlightRowIf(v.user, address)}
              />
            )}
          />
        )}

        {creators.length > 0 && (
          <Table
            title="Top creators"
            subtitle="By drops launched"
            rows={creators}
            address={address}
            renderRow={(c, i) => (
              <Row
                key={c.creator}
                rank={i + 1}
                address={c.creator}
                primary={`${c.drops} drop${c.drops > 1 ? 's' : ''}`}
                secondary={`Latest ${new Date(c.newestTimestamp * 1000).toLocaleDateString()}`}
                isMe={highlightRowIf(c.creator, address)}
              />
            )}
          />
        )}
      </div>
    </div>
  );
}

function Table<T>({
  title,
  subtitle,
  rows,
  renderRow,
}: {
  title: string;
  subtitle: string;
  rows: readonly T[];
  address?: `0x${string}`;
  renderRow: (row: T, idx: number) => React.ReactNode;
}) {
  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: 'rgba(6,12,26,0.78)',
        border: '1px solid var(--color-purple-40)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--color-purple-12)' }}>
        <h3 className="text-white text-[13px] font-semibold">{title}</h3>
        <p className="text-white/60 text-[11px]">{subtitle}</p>
      </div>
      <ul className="divide-y divide-white/[0.04] max-h-[480px] overflow-y-auto">
        {rows.map((row, i) => renderRow(row, i))}
      </ul>
    </div>
  );
}

function Row({
  rank,
  address,
  primary,
  secondary,
  isMe,
}: {
  rank: number;
  address: `0x${string}`;
  primary: string;
  secondary?: string;
  isMe: boolean;
}) {
  // ENS resolved per row. wagmi caches results aggressively (24h staleTime
  // by default in the hooks-level config); pulling 100 stakers + 20
  // voters + 20 creators = ~140 simultaneous useEnsName calls. The cache
  // collapses duplicates (one address per query key) and viem batches
  // the underlying eth_call multicalls.
  const { data: ens } = useEnsName({
    address,
    chainId: mainnet.id,
    query: { staleTime: 24 * 60 * 60 * 1000, gcTime: 24 * 60 * 60 * 1000 },
  });

  return (
    <li
      className="px-4 py-2.5 flex items-center gap-3 text-[12px]"
      style={
        isMe
          ? {
              background: 'rgba(45,139,78,0.18)',
              borderLeft: '2px solid var(--color-weed)',
            }
          : undefined
      }
    >
      <span
        className="text-[11px] font-mono w-6 shrink-0 text-right tabular-nums"
        style={{ color: isMe ? '#86efac' : 'rgba(255,255,255,0.45)' }}
      >
        {rank}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-white truncate" title={address}>
          {ens ?? shortenAddress(address)}
          {isMe && (
            <span
              className="ml-2 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide"
              style={{ background: 'rgba(45,139,78,0.45)', color: '#fff' }}
            >
              You
            </span>
          )}
        </p>
        {secondary && (
          <p className="text-white/50 text-[10px] truncate">{secondary}</p>
        )}
      </div>
      <span className="text-white/85 font-mono shrink-0 text-[11px]">{primary}</span>
    </li>
  );
}

function LoadingShimmer() {
  return (
    <div className="mb-6 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-xl shimmer"
            style={{
              height: 320,
              background: 'rgba(6,12,26,0.78)',
              border: '1px solid var(--color-purple-40)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

function trimEth(wei: bigint): string {
  if (wei <= 0n) return '0';
  const n = Number(formatEther(wei));
  if (n < 0.0001) return n.toExponential(2);
  if (n < 1) return n.toFixed(4);
  if (n < 1000) return n.toFixed(2);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}
