import type { MarketRow } from '../../lib/geckoTerminal/pools';
import type { RowSafety } from '../../lib/terminal/rowSafety';
import { ageAtRead } from '../../lib/terminal/feedBanner';
import { SafetyBadge } from './SafetyBadge';

// The market table.
//
// EVERY ABSENT NUMBER RENDERS AS AN ABSENCE, with the reason in its title. A
// dash that means "the upstream did not report this" and a dash that means "this
// figure was withheld because the upstream's quote is not believable" are
// different facts, and a zero would be a third thing entirely — an assertion
// nobody measured. `MarketRow` types every money column as `number | null`
// precisely so this component cannot fall back to 0, and the two `title`s below
// are where the difference reaches a reader.
//
// AGE IS COMPUTED ONCE, against the feed's own `readAt`, and never against
// `Date.now()`. A clock read during render turns a static table into one whose
// ages drift apart from the prices beside them — a chart of two different
// moments presented as one.
//
// TWO LAYOUTS, ONE ROW LIST. A table below 768px either overflows the page or
// shrinks its text past legibility, so small screens get one <article> per row
// with the same fields and the same badge. The table itself lives inside its own
// `overflow-x-auto` so it is the TABLE that scrolls sideways, never the page.

export interface MarketTableProps {
  rows: readonly MarketRow[];
  /** Unix seconds the feed was read. Ages are computed against this, once. */
  readAt: number;
  safetyOf: (row: MarketRow) => RowSafety;
  selected: string | null;
  onSelect: (key: string) => void;
  isWatched: (key: string) => boolean;
  onToggleWatch: (key: string) => void;
  /** Extra name for a row (an island resident), or null. Never invented. */
  labelFor?: (row: MarketRow) => string | null;
  /** Rendered as the table's caption and the card list's heading. */
  caption: string;
}

const NOT_REPORTED = 'not reported upstream';
const WITHHELD =
  'withheld: the upstream’s own quote for this pool is not a believable market number, so the price, liquidity, FDV and volume are all shown as unknown together';

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Compact USD. Returns null for null — the caller renders the absence. */
function usd(n: number | null): string | null {
  if (n === null) return null;
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs === 0) return '$0.00';
  // Sub-dollar prices are the norm on a new-pool feed; rounding them to two
  // places would print $0.00 for every one of them, which reads as free.
  return `$${n.toPrecision(3)}`;
}

function pct(n: number | null): string | null {
  if (n === null) return null;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function Absent({ withheld }: { withheld: boolean }) {
  return (
    <span className="text-white/40" title={withheld ? WITHHELD : NOT_REPORTED}>
      —
    </span>
  );
}

function Money({ value, withheld }: { value: number | null; withheld: boolean }) {
  const text = usd(value);
  return text === null ? <Absent withheld={withheld} /> : <>{text}</>;
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <Absent withheld={false} />;
  const tone = value === 0 ? 'text-white/80' : value > 0 ? 'text-emerald-300' : 'text-rose-300';
  return <span className={tone}>{pct(value)}</span>;
}

function Flow({ row }: { row: MarketRow }) {
  if (!row.tx5m) {
    return (
      <span
        className="text-white/40"
        title="the upstream did not report a complete five-minute buy/sell count, and half a count is not a count"
      >
        —
      </span>
    );
  }
  return (
    <span>
      <span className="text-emerald-300">{row.tx5m.buys}</span>
      <span className="text-white/40"> / </span>
      <span className="text-rose-300">{row.tx5m.sells}</span>
    </span>
  );
}

function rowName(row: MarketRow, labelFor?: (r: MarketRow) => string | null): string {
  return labelFor?.(row) ?? row.name ?? short(row.token);
}

const BTN =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-white/25 px-3 text-xs font-medium text-white hover:bg-white/10';

export function MarketTable({
  rows,
  readAt,
  safetyOf,
  selected,
  onSelect,
  isWatched,
  onToggleWatch,
  labelFor,
  caption,
}: MarketTableProps) {
  return (
    <>
      {/* ≥md: the full grid, scrolling inside its own box. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[840px] border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-white/15 text-left text-[11px] uppercase tracking-wide text-white/60">
              <th scope="col" className="px-2 py-2 font-semibold">Watch</th>
              <th scope="col" className="px-2 py-2 font-semibold">Pool</th>
              <th scope="col" className="px-2 py-2 font-semibold">Age at read</th>
              <th scope="col" className="px-2 py-2 font-semibold">Liquidity</th>
              <th scope="col" className="px-2 py-2 font-semibold">24h volume</th>
              <th scope="col" className="px-2 py-2 font-semibold">24h change</th>
              <th scope="col" className="px-2 py-2 font-semibold">5m buys / sells</th>
              <th scope="col" className="px-2 py-2 font-semibold">Safety</th>
              <th scope="col" className="px-2 py-2 font-semibold">Read</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const age = ageAtRead(row.createdAt, readAt);
              const watched = isWatched(row.key);
              return (
                <tr
                  key={row.key}
                  className={`border-b border-white/10 align-top ${selected === row.key ? 'bg-white/[0.06]' : ''}`}
                >
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => onToggleWatch(row.key)}
                      aria-pressed={watched}
                      aria-label={`${watched ? 'Remove' : 'Add'} ${rowName(row, labelFor)} on ${row.network} ${watched ? 'from' : 'to'} watchlist`}
                      className={BTN}
                    >
                      {watched ? '★' : '☆'}
                    </button>
                  </td>
                  <td className="px-2 py-2">
                    <span className="block text-xs text-white" title={row.pool}>
                      {rowName(row, labelFor)}
                    </span>
                    <span className="block font-mono text-[10px] text-white/50" title={row.token}>
                      {short(row.token)}
                      {row.dex ? ` · ${row.dex}` : ''}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-xs text-white/80">
                    {age ?? (
                      <span className="text-white/40" title="the upstream reported no creation time for this pool, so no age is shown">
                        age not reported
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-white/85">
                    <Money value={row.liquidityUsd} withheld={row.withheld} />
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-white/85">
                    <Money value={row.volume24hUsd} withheld={row.withheld} />
                  </td>
                  <td className="px-2 py-2 font-mono text-xs">
                    <Change value={row.change24hPct} />
                  </td>
                  <td className="px-2 py-2 font-mono text-xs">
                    <Flow row={row} />
                  </td>
                  <td className="px-2 py-2">
                    <SafetyBadge safety={safetyOf(row)} />
                  </td>
                  <td className="px-2 py-2">
                    <button type="button" onClick={() => onSelect(row.key)} className={BTN}>
                      {selected === row.key ? 'Reading' : 'Read'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* <md: one card per row. Same fields, same badge, no sideways scroll. */}
      <ul className="space-y-3 md:hidden" aria-label={caption}>
        {rows.map((row) => {
          const age = ageAtRead(row.createdAt, readAt);
          const watched = isWatched(row.key);
          return (
            <li key={row.key}>
              <article
                className={`rounded-lg border p-3 ${selected === row.key ? 'border-emerald-400/40 bg-white/[0.06]' : 'border-white/15 bg-white/[0.02]'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white" title={row.pool}>
                      {rowName(row, labelFor)}
                    </p>
                    <p className="truncate font-mono text-[10px] text-white/50" title={row.token}>
                      {short(row.token)}
                      {row.dex ? ` · ${row.dex}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onToggleWatch(row.key)}
                    aria-pressed={watched}
                    aria-label={`${watched ? 'Remove' : 'Add'} ${rowName(row, labelFor)} on ${row.network} ${watched ? 'from' : 'to'} watchlist`}
                    className={BTN}
                  >
                    {watched ? '★' : '☆'}
                  </button>
                </div>

                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-white/55">Age at read</dt>
                    <dd className="text-white/85">{age ?? <span className="text-white/40">not reported</span>}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-white/55">Liquidity</dt>
                    <dd className="font-mono text-white/85">
                      <Money value={row.liquidityUsd} withheld={row.withheld} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-white/55">24h volume</dt>
                    <dd className="font-mono text-white/85">
                      <Money value={row.volume24hUsd} withheld={row.withheld} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-white/55">24h change</dt>
                    <dd className="font-mono">
                      <Change value={row.change24hPct} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-white/55">5m buys / sells</dt>
                    <dd className="font-mono">
                      <Flow row={row} />
                    </dd>
                  </div>
                </dl>

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <SafetyBadge safety={safetyOf(row)} />
                  <button type="button" onClick={() => onSelect(row.key)} className={BTN}>
                    {selected === row.key ? 'Reading' : 'Read'}
                  </button>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </>
  );
}
