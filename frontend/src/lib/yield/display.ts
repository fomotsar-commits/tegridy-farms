// The exact strings the comparison table renders.
//
// Split out of the components so the one assertion that matters can be made
// without a DOM: that an unread figure NEVER renders as a figure. Every function
// here takes a `MetricRead`, and the two absent branches return a marker plus
// the reason — not '0%', not '1.00', not '$0', and not a bare dash a reader
// scanning a column would take for a small number.
//
// UNAVAILABLE_MARK is an en dash rather than a zero-width blank on purpose: a
// truly empty cell reads as a rendering bug and invites a reload, whereas a mark
// with a reason beside it reads as an answer. It is never used for a real value.
//
// EVERY FIGURE CARRIES ITS UNIT. A vs-NAV ratio is unit-less and a market price
// is in ETH, and the two are frequently the same number to four decimals when a
// token trades near NAV — so the ratio is rendered with '×' and never with a
// currency suffix, because '1.0002 ETH' and '1.0002×' are different claims.

import { pegAssessment, type MetricRead, type ReadMetric } from './metrics';

export const UNAVAILABLE_MARK = '—';

export interface MetricDisplay {
  /** The value column. Equal to UNAVAILABLE_MARK exactly when nothing was read. */
  text: string;
  /** True when `text` is the marker. Lets a cell style the two cases apart. */
  unavailable: boolean;
  /** True for a cell there is nothing to read, as opposed to a failed read. */
  notApplicable: boolean;
  /** Why it is absent, or where a read figure came from. Never empty. */
  detail: string;
  /** A real reading that is past its own freshness window. */
  stale: boolean;
}

function ageWords(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function absent(reason: string, notApplicable: boolean): MetricDisplay {
  return { text: UNAVAILABLE_MARK, unavailable: true, notApplicable, detail: reason, stale: false };
}

/** Routes the two absent states to their own wording without duplicating either. */
function nonRead(metric: Exclude<MetricRead, ReadMetric>): MetricDisplay {
  return absent(metric.reason, metric.state === 'not-applicable');
}

function read(metric: ReadMetric, text: string): MetricDisplay {
  const age = ageWords(metric.ageSeconds);
  const basis = metric.basis === undefined ? '' : ` Basis: ${metric.basis}.`;
  return {
    text,
    unavailable: false,
    notApplicable: false,
    detail: metric.stale
      ? `Read from ${metric.source} — ${age}, past this source's ${Math.round(metric.maxAgeS / 3600)}h window, so it is shown as it was measured rather than refreshed silently.${basis}`
      : `Read from ${metric.source}.${basis}`,
    stale: metric.stale,
  };
}

/**
 * The ranked rate column.
 *
 * A read 0.00% is printed as 0.00%, and that is not the failure this file
 * guards. The failure is the UNREAD rate arriving in the same cell wearing the
 * same glyphs — which is why the branches cannot produce the same string.
 */
export function rateDisplay(metric: MetricRead): MetricDisplay {
  if (metric.state !== 'read') return nonRead(metric);
  return read(metric, `${metric.value.toFixed(2)}%`);
}

/** What the protocol says one unit is worth, in the protocol's own denomination. */
export function navDisplay(metric: MetricRead): MetricDisplay {
  if (metric.state !== 'read') return nonRead(metric);
  return read(metric, `${metric.value.toFixed(4)} ${metric.unit}`);
}

/** What a market says one unit is worth. Same shape as NAV so the two compare. */
export function marketDisplay(metric: MetricRead): MetricDisplay {
  if (metric.state !== 'read') return nonRead(metric);
  return read(metric, `${metric.value.toFixed(4)} ${metric.unit}`);
}

export interface VsNavDisplay extends MetricDisplay {
  /** Worth a reader's attention. A measurement, never a verdict on the protocol. */
  notable: boolean;
}

/**
 * Market ÷ NAV, as a unit-less multiple.
 *
 * Four decimals because the difference between 1.0000 and 0.9950 is the entire
 * subject of the column, and two decimals round a half-percent discount into the
 * same string as no discount at all. The '×' suffix is load-bearing: without it
 * this cell and the market-price cell beside it would print the same glyphs for
 * two different claims.
 */
export function vsNavDisplay(metric: MetricRead): VsNavDisplay {
  // Narrowed before the assessment rather than after it so the absent case owns
  // the reason it already carries — `pegAssessment` would restate it one level
  // removed from where it was decided.
  if (metric.state !== 'read') return { ...nonRead(metric), notable: false };
  const assessment = pegAssessment(metric);
  if (assessment.state === 'unknown') return { ...absent(assessment.reason, false), notable: false };

  const base = read(metric, `${assessment.ratio.toFixed(4)}×`);
  if (assessment.state === 'at-or-above-nav') {
    return {
      ...base,
      notable: false,
      detail: `${base.detail} At or above the protocol's own rate at the time of the reading. That is a measurement, not a guarantee it holds.`,
    };
  }
  return {
    ...base,
    notable: assessment.notable,
    detail: `${base.detail} Trading ${assessment.discountPct.toFixed(2)}% under the protocol's own rate at the time of the reading.`,
  };
}

/**
 * Exit depth, or the queue standing in front of it.
 *
 * `meaning` decides the whole sentence and the two must never be confused: a
 * withdrawal backlog is the OPPOSITE of available liquidity, and rendering
 * 6,402 stETH the same way for both would tell a reader they can leave when the
 * number means the reverse. The queued-ahead sentence is asserted by test never
 * to contain the word "available".
 */
export function exitDisplay(metric: MetricRead): MetricDisplay {
  if (metric.state !== 'read') return nonRead(metric);
  const amount = `${metric.value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${metric.unit}`;
  const base = read(metric, amount);
  if (metric.meaning === 'queued-ahead') {
    return {
      ...base,
      detail: `${amount} queued ahead of a new withdrawal request. ${base.detail}`,
    };
  }
  return { ...base, detail: `Redeemable now, at this block. ${base.detail}` };
}

/**
 * How the table describes its own read.
 *
 * The partial case is the one worth wording carefully. A table where three of
 * forty figures failed is still a useful table, and hiding that behind the same
 * sentence as a clean read would let a reader take the gaps for zeroes.
 */
export function readStatusLine(
  status: 'loading' | 'ready' | 'partial' | 'unavailable',
  block: number | null,
  asOf: number | null,
  unreadCells: number,
  totalCells: number,
  detail: string | null,
): string {
  if (status === 'loading') return 'Reading Ethereum mainnet…';
  if (status === 'unavailable') {
    return (
      detail ??
      'Ethereum mainnet could not be read, so no rate, price or depth figure is shown. Every column below says so ' +
        'rather than showing a number.'
    );
  }
  const when = asOf === null ? 'an unknown time' : new Date(asOf * 1000).toISOString().replace('.000Z', 'Z');
  const where = `Read from Ethereum mainnet at block ${block ?? 'unknown'}, chain time ${when}`;
  if (status === 'partial') {
    return `${where}; ${unreadCells} of ${totalCells} figures could not be read and say so in place.`;
  }
  return `${where}. Each cell names its own source.`;
}
