// The exact strings the comparison table renders.
//
// Split out of the components so the one assertion that matters can be made
// without a DOM: that an unread figure NEVER renders as a figure. Every function
// here takes a `MetricRead`, and the unavailable branch returns a marker plus the
// reason — not '0%', not '1.00', not '$0', and not a bare dash that a reader
// scanning a column would take for a small number.
//
// UNAVAILABLE_MARK is an en dash rather than a zero-width blank on purpose: a
// truly empty cell reads as a rendering bug and invites a reload, whereas a mark
// with a tooltip'd reason reads as an answer. It is never used for a real value.

import { formatCurrency } from '../formatting';
import { pegAssessment, type MetricRead } from './metrics';

export const UNAVAILABLE_MARK = '—';

export interface MetricDisplay {
  /** The value column. Equal to UNAVAILABLE_MARK exactly when nothing was read. */
  text: string;
  /** True when `text` is the marker. Lets a cell style the two cases apart. */
  unavailable: boolean;
  /** Why it is unavailable, or where a read figure came from. Never empty. */
  detail: string;
  /** A real reading that is past its freshness window. */
  stale: boolean;
}

function ageWords(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function unavailable(reason: string): MetricDisplay {
  return { text: UNAVAILABLE_MARK, unavailable: true, detail: reason, stale: false };
}

function read(metric: Extract<MetricRead, { state: 'read' }>, text: string): MetricDisplay {
  const age = ageWords(metric.ageSeconds);
  return {
    text,
    unavailable: false,
    detail: metric.stale
      ? `Read from ${metric.source} ${age} — out of date, shown as it was measured rather than refreshed silently.`
      : `Read from ${metric.source}, ${age}.`,
    stale: metric.stale,
  };
}

/**
 * APY.
 *
 * A read 0.00% is printed as 0.00%, and that is not the failure this file guards.
 * The failure is the UNREAD rate arriving in the same cell wearing the same
 * glyphs — which is why the two branches cannot produce the same string.
 */
export function apyDisplay(metric: MetricRead): MetricDisplay {
  if (metric.state !== 'read') return unavailable(metric.reason);
  return read(metric, `${metric.value.toFixed(2)}%`);
}

/** Exit liquidity. A read zero is a real, loud answer and is printed as $0.00. */
export function exitLiquidityDisplay(metric: MetricRead): MetricDisplay {
  if (metric.state !== 'read') return unavailable(metric.reason);
  return read(metric, formatCurrency(metric.value));
}

export interface PegDisplay extends MetricDisplay {
  /** Worth a reader's attention. A measurement, never a verdict on the protocol. */
  notable: boolean;
}

/**
 * Peg, as four decimals against its reference.
 *
 * Four rather than two because the difference between 1.0000 and 0.9950 is the
 * entire subject of the column, and two decimals round a half-percent discount
 * into the same string as no discount at all.
 */
export function pegDisplay(metric: MetricRead, reference: 'ETH' | 'USD'): PegDisplay {
  // Narrowed before the assessment rather than after it so the unread case owns
  // the reason it already carries — `pegAssessment` would restate it one level
  // removed from where it was decided.
  if (metric.state !== 'read') return { ...unavailable(metric.reason), notable: false };
  const assessment = pegAssessment(metric, reference);
  if (assessment.state === 'unknown') return { ...unavailable(assessment.reason), notable: false };

  const base = read(metric, `${assessment.ratio.toFixed(4)} ${assessment.reference}`);
  if (assessment.state === 'at-or-above-reference') {
    return {
      ...base,
      notable: false,
      detail: `${base.detail} At or above its ${assessment.reference} reference at the time of the reading. That is a measurement, not a guarantee it holds.`,
    };
  }
  return {
    ...base,
    notable: assessment.notable,
    detail: `${base.detail} Trading ${assessment.discountPct.toFixed(2)}% under its ${assessment.reference} reference at the time of the reading.`,
  };
}

/**
 * How the table describes the feed itself.
 *
 * The unconfigured case is the resting state of this deployment and gets calm
 * wording; a set-but-broken URL is a live misconfiguration and gets the operator
 * sentence, because those two produce identical empty tables and only one of them
 * is somebody's mistake.
 */
export function feedStatusLine(status: 'loading' | 'ready' | 'unavailable', detail: string | null): string {
  if (status === 'loading') return 'Reading rates…';
  if (status === 'unavailable') {
    return detail ?? 'No rate, peg or exit-liquidity figure could be read. Every column below says so rather than showing a number.';
  }
  return detail ?? 'Figures below were read from the configured yield feed. Each cell names its own source.';
}
