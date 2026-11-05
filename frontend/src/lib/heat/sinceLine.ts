// SINCE, the trencher layer's early flex (island answer twenty-four, build 7): "In {coin}
// since {month year}." on the heat read and in every room, from the island's own first-hold
// time for that coin. The percentile form waits for the island: it serves `earlier_than_pct`
// beside `held_since_unix` (answer twenty-five, §4), so it speaks for the one coin that time
// belongs to and for no other. The words are TRENCHER_WORDS, quoted.

import { TRENCHER_WORDS } from '../arrival';
import type { HeatBreakdownRow, HeatReading } from './heatOracle';

/** "October 2026". UTC, as the island's card prints the date, so the month never moves with the viewer's clock. */
export function sinceMonth(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The coin held_since_unix belongs to: the row whose first hold is that instant, the deepest on
 *  a tie. Null when the island served no such row: then the read names no coin. */
export function earliestRow(reading: HeatReading): HeatBreakdownRow | null {
  const at = reading.heldSinceUnix;
  if (at === null) return null;
  const rows = reading.breakdown.filter((r) => r.firstSeenAtUnix === at);
  return rows.length ? rows.reduce((a, b) => (b.degrees > a.degrees ? b : a)) : null;
}

/** The served percentile in whole points when it can only be this row's; null otherwise, or
 *  under one point. Floored, so it never claims more than was served. */
function percentileOf(reading: HeatReading, row: HeatBreakdownRow): number | null {
  const pct = reading.earlierThanPct ?? null;
  if (pct === null || reading.heldSinceUnix === null) return null;
  const owners = reading.breakdown.filter((r) => r.firstSeenAtUnix === reading.heldSinceUnix);
  if (owners.length !== 1 || owners[0] !== row) return null;
  const whole = Math.floor(pct);
  return whole >= 1 ? whole : null;
}

/** The since line for one coin of this reading, or null when the island served no first hold for it. */
export function sinceLine(reading: HeatReading, row: HeatBreakdownRow, coin: string): string | null {
  if (row.firstSeenAtUnix === null) return null;
  const month = sinceMonth(row.firstSeenAtUnix);
  const pct = percentileOf(reading, row);
  return pct === null ? TRENCHER_WORDS.since(coin, month) : TRENCHER_WORDS.sinceEarlier(coin, month, pct);
}
