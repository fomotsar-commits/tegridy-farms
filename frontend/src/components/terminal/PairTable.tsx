import type { TerminalPairRow } from '../../lib/terminal/feed';
import type { RowSafety } from '../../lib/terminal/rowSafety';
import { SafetyBadge } from './SafetyBadge';

// The feed table.
//
// Two columns carry the honesty of this page and neither may fall back to a
// number: SAFETY renders `SafetyBadge` (never a colour computed here) and
// ACTIVITY renders the discriminated `PairActivity` — a pair the event window
// never reached shows the reason it was not reached, not a dash and not a zero.
// A dash would be read as "nothing happened", which is the same lie as a zero
// with better manners.

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export interface PairTableProps {
  rows: readonly TerminalPairRow[];
  /** Safety for a row, by pair address. Rows with no entry render as unscored. */
  safetyOf: (row: TerminalPairRow) => RowSafety;
  selected: string | null;
  onSelect: (pair: string) => void;
  isWatched: (pair: string) => boolean;
  onToggleWatch: (pair: string) => void;
}

export function PairTable({
  rows,
  safetyOf,
  selected,
  onSelect,
  isWatched,
  onToggleWatch,
}: PairTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <caption className="sr-only">
          Indexed pairs with their safety read. Rows that could not be scored say so and are not
          ranked.
        </caption>
        <thead>
          <tr className="border-b border-white/15 text-left text-[11px] uppercase tracking-wide text-white/60">
            <th scope="col" className="px-2 py-2 font-semibold">
              Watch
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              Pair
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              Tokens
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              Safety
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              Activity in window
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isSelected = selected?.toLowerCase() === row.pair.toLowerCase();
            const watched = isWatched(row.pair);
            return (
              <tr
                key={row.pair}
                className={`border-b border-white/10 align-top ${isSelected ? 'bg-white/[0.06]' : ''}`}
              >
                <td className="px-2 py-2">
                  <button
                    type="button"
                    onClick={() => onToggleWatch(row.pair)}
                    aria-pressed={watched}
                    aria-label={`${watched ? 'Remove' : 'Add'} ${short(row.pair)} ${watched ? 'from' : 'to'} watchlist`}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-white/25 px-3 text-xs text-white hover:bg-white/10"
                  >
                    {watched ? '★' : '☆'}
                  </button>
                </td>
                <td className="px-2 py-2">
                  <button
                    type="button"
                    onClick={() => onSelect(row.pair)}
                    className="inline-flex min-h-11 min-w-11 items-center font-mono text-xs text-white underline decoration-white/30 underline-offset-2 hover:decoration-white"
                  >
                    {short(row.pair)}
                  </button>
                </td>
                <td className="px-2 py-2 font-mono text-[11px] text-white/70">
                  <div>{short(row.token0)}</div>
                  <div>{short(row.token1)}</div>
                </td>
                <td className="px-2 py-2">
                  <SafetyBadge safety={safetyOf(row)} />
                </td>
                <td className="px-2 py-2 text-[11px] leading-snug text-white/75">
                  <ActivityCell row={row} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ActivityCell({ row }: { row: TerminalPairRow }) {
  if (row.activity.state === 'unknown') {
    return <span className="text-white/60">Not read — {row.activity.reason}</span>;
  }
  const { events, earliestInWindow, latestInWindow } = row.activity;
  return (
    <span>
      {events} indexed event{events === 1 ? '' : 's'} between{' '}
      {new Date(Number(earliestInWindow) * 1000).toISOString()} and{' '}
      {new Date(Number(latestInWindow) * 1000).toISOString()}
    </span>
  );
}
