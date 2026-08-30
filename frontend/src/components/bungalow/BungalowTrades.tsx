import type { Bungalow } from '../../lib/bungalows';
import { usePoolTrades, type PoolTrade } from '../../hooks/usePoolTrades';

/**
 * The bungalow's trade tape — the last fills on its own pool.
 *
 * The venue's LiveActivity pill is TOWELI-denominated and muted inside a
 * bungalow (AppLayout gates it on `!bungalowIdentity`), so a token-first page
 * showed no sign of life whatsoever. This is the honest replacement: real
 * fills, each linked to its own transaction so any row can be checked.
 *
 * An EMPTY tape after a successful read is a real fact ("no trades came back")
 * and is labelled as such — distinct from the outage line the hook returns when
 * the read itself failed.
 */
export function BungalowTrades({ bungalow }: { bungalow: Bungalow }) {
  const market = bungalow.market ?? null;
  const { trades, isLoading, error, refresh } = usePoolTrades(
    market?.network ?? null,
    market?.pool ?? null,
  );

  if (!market) return null;

  return (
    <div className="mt-5">
      <div className="flex items-center gap-3 mb-3">
        <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-kyle)' }}>
          Recent trades
        </p>
        <div className="flex-1" />
        <button
          onClick={refresh}
          disabled={isLoading}
          className="text-[11px] px-3 py-1 rounded border border-white/10 bg-white/5 text-white/70 hover:text-white disabled:opacity-50"
        >
          {isLoading ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <p className="text-[12px]" style={{ color: '#f0b26b' }}>{error}</p>
      ) : trades.length === 0 ? (
        <p className="text-[12px] text-white/55">
          {isLoading ? 'Reading the tape…' : 'No trades came back for this pool.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] min-w-[520px]">
            <thead>
              <tr className="text-white/45 text-[10px] uppercase tracking-wider">
                <th className="text-left font-medium pb-2">Side</th>
                <th className="text-right font-medium pb-2">{bungalow.symbol}</th>
                <th className="text-right font-medium pb-2">Value</th>
                <th className="text-right font-medium pb-2">When</th>
                <th className="text-right font-medium pb-2">Wallet</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <Row key={t.txHash + t.at} trade={t} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ trade }: { trade: PoolTrade }) {
  const isBuy = trade.kind === 'buy';
  return (
    <tr className="border-t border-white/5">
      <td className="py-1.5">
        <span style={{ color: isBuy ? '#22c55e' : '#ef4444' }}>{isBuy ? 'Buy' : 'Sell'}</span>
      </td>
      <td className="py-1.5 text-right tabular-nums text-white/85">{fmtAmount(trade.tokenAmount)}</td>
      <td className="py-1.5 text-right tabular-nums text-white/85">
        {trade.usd === null ? '—' : `$${trade.usd < 1 ? trade.usd.toFixed(2) : Math.round(trade.usd).toLocaleString()}`}
      </td>
      <td className="py-1.5 text-right text-white/55">{ago(trade.at)}</td>
      <td className="py-1.5 text-right">
        <a
          href={`https://solscan.io/tx/${trade.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View transaction on Solscan (opens in new tab)"
          className="text-white/55 hover:text-white underline underline-offset-2"
        >
          {trade.wallet ? `${trade.wallet.slice(0, 4)}…${trade.wallet.slice(-4)}` : 'tx'} ↗
        </a>
      </td>
    </tr>
  );
}

function fmtAmount(v: number | null): string {
  if (v === null) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(2);
}

/** Relative time. An unparseable stamp renders "—" rather than "Invalid Date". */
function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}
