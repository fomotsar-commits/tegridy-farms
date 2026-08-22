// Folding source reports into one total — and refusing to, when that would lie.
//
// Two rules produce everything below.
//
// 1. A leg contributes only if it was READ and PRICED. Anything else is omitted BY NAME,
//    and the presence of any omission downgrades the total to `partial`. There is no
//    path from "a leg failed" to a total that looks whole, because the failure mode this
//    guards is not a wrong number — it is a RIGHT-LOOKING number. A total that drops the
//    staking leg after an RPC timeout is a smaller, plausible, unflagged figure, and the
//    user reads it as a loss they took rather than data we did not get.
//
// 2. A total inherits the age of its OLDEST contributing leg, never its newest and never
//    the wall clock. Marking a portfolio "as of now" because one cheap read just landed,
//    while the largest position is five minutes cold, is the same lie told about time.
//
// `usd` is null — not 0 — whenever nothing contributed. Callers that write `usd ?? 0`
// have reintroduced the bug; `PortfolioTotal.usd`'s type is the enforcement.

import type {
  PortfolioCompleteness,
  PortfolioOmission,
  PortfolioSourceReport,
  PortfolioSourceState,
  PortfolioTotal,
} from './types';

/**
 * Legs are read in separate multicall batches that land within a round-trip of each
 * other, so a small spread is normal poll skew, not staleness. Beyond this, one batch
 * genuinely fell behind and the sum mixes two moments in time.
 */
export const FRESHNESS_TOLERANCE_SEC = 30;

/** Reason text per omission state. Rendered verbatim to users, so it says what happened. */
const OMISSION_REASON: Record<Exclude<PortfolioSourceState, 'ok'>, string> = {
  loading: 'still loading',
  unavailable: 'could not be read',
  unpriced: 'held, but no price available to value it',
  'out-of-scope': 'not tracked by this build',
};

/** A leg claiming success without a figure is a bug; it is omitted rather than trusted. */
const MALFORMED_REASON = 'reported as read but carried no value';
/** Likewise a leg with a value but no read time: its age cannot be stated, so it cannot be summed. */
const UNTIMED_REASON = 'read time unknown, so it cannot be dated against the other sources';

function omission(r: PortfolioSourceReport, reason: string): PortfolioOmission {
  return { id: r.id, label: r.label, state: r.state, reason };
}

export interface AggregateOptions {
  /** Seconds of read-time spread tolerated before `mixedFreshness` trips. */
  toleranceSec?: number;
}

/**
 * Fold per-source reports into one total plus the disclosure that makes it readable.
 *
 * Pure and total: any array of reports — including an empty one — yields a well-formed
 * `PortfolioTotal`. The empty case is `unavailable` with `usd: null`, because a venue
 * that knows nothing about a wallet is not a venue reporting that the wallet is empty.
 */
export function aggregatePortfolio(
  reports: readonly PortfolioSourceReport[],
  options: AggregateOptions = {},
): PortfolioTotal {
  const tolerance = Math.max(0, options.toleranceSec ?? FRESHNESS_TOLERANCE_SEC);

  const counted: PortfolioSourceReport[] = [];
  const omitted: PortfolioOmission[] = [];
  const outOfScope: PortfolioOmission[] = [];

  for (const r of reports) {
    if (r.state === 'out-of-scope') {
      outOfScope.push(omission(r, r.detail ?? OMISSION_REASON['out-of-scope']));
      continue;
    }
    if (r.state !== 'ok') {
      omitted.push(omission(r, r.detail ?? OMISSION_REASON[r.state]));
      continue;
    }
    if (typeof r.usd !== 'number' || !Number.isFinite(r.usd)) {
      omitted.push(omission(r, MALFORMED_REASON));
      continue;
    }
    if (r.asOf === null || !Number.isFinite(r.asOf)) {
      omitted.push(omission(r, UNTIMED_REASON));
      continue;
    }
    counted.push(r);
  }

  const ages = counted.map((r) => r.asOf as number);
  const asOfOldest = ages.length > 0 ? Math.min(...ages) : null;
  const asOfNewest = ages.length > 0 ? Math.max(...ages) : null;
  const freshnessSpreadSec =
    asOfOldest !== null && asOfNewest !== null ? asOfNewest - asOfOldest : null;

  let completeness: PortfolioCompleteness;
  if (counted.length === 0) completeness = 'unavailable';
  else if (omitted.length > 0) completeness = 'partial';
  else completeness = 'complete';

  return {
    usd: counted.length === 0 ? null : counted.reduce((sum, r) => sum + (r.usd as number), 0),
    completeness,
    counted: counted.map((r) => r.id),
    omitted,
    outOfScope,
    asOfOldest,
    asOfNewest,
    freshnessSpreadSec,
    mixedFreshness: freshnessSpreadSec !== null && freshnessSpreadSec > tolerance,
  };
}

/**
 * The single sentence that must accompany the total wherever it is shown.
 *
 * Exported as data rather than baked into JSX so the honesty guard can assert on the
 * words themselves, and so a second surface reusing the total cannot invent gentler
 * phrasing for the same condition.
 */
export function describeCompleteness(total: PortfolioTotal): string {
  if (total.completeness === 'unavailable') {
    return 'No source could be read and priced, so no total is shown.';
  }
  if (total.completeness === 'partial') {
    const names = total.omitted.map((o) => o.label).join(', ');
    // "this or higher", not "higher": every leg here is non-negative, so an omitted leg
    // can only add — but it may genuinely be zero, and overstating the gap is its own lie.
    return `PARTIAL — this total excludes ${names}. The real figure is this or higher.`;
  }
  return 'Every tracked source was read and priced.';
}
