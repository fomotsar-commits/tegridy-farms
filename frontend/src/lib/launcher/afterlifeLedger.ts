// Launch Afterlife — cohort ledger aggregation (docs/LAUNCHER_STRATEGY.md §2.5).
//
// The honest-tracking credibility asset: nobody in the launcher category keeps
// public, permanent post-launch statistics. We do — INCLUDING our failures.
// LaunchExplorer already renders the PER-LAUNCH ranked outcomes; this is the
// missing COHORT lens — the aggregate "of every launch we've powered, here's how
// many are still liquid, how many drained, how many went quiet" ledger that makes
// the "we publish our failures" claim legible at a glance.
//
// PURE + shape-only: it takes the exact OutcomeRecord[] the outcomes adapter
// already produces (via outcomesClient → api/_lib/launcher-outcomes.js) and folds
// them into counts. It reuses the SAME per-record cores (deriveOutcomeFlags /
// priceReturn from outcomes.ts) rather than re-deriving any flag — so the ledger
// can never disagree with the row-level disclosures the explorer shows.
//
// HONESTY INVARIANTS (mirrors LaunchExplorer's marketObserved gating):
//   • Adverse/clean cohorts are counted ONLY over records whose market was actually
//     OBSERVED at the last snapshot. A record with marketObserved === false had its
//     price/liquidity mirrored from the baseline, so deriving "drained" / "clean"
//     from it would fabricate a signal — those records count ONLY toward `tracked`
//     and `unavailable`, never toward any adverse or clean tally.
//   • Nothing is invented: an empty input yields all-zero counts and null
//     medianPriceReturn / asOf, so the surface self-gates to an honest empty state.
//   • Descriptive measurement, never a verdict. These are disclosed market-risk
//     outcomes, not "scam"/"safe" labels.

import {
  deriveOutcomeFlags,
  priceReturn,
  defaultOutcomeConfig,
  type OutcomeConfig,
  type OutcomeRecord,
} from './outcomes';

/**
 * Cohort-level summary of a set of tracked launches. Every count is a plain fact
 * derived from the records; adverse tallies never include market-unavailable
 * records (see file header). Adverse flags can OVERLAP (a launch may be both
 * liquidity-drained and likely-abandoned), so they do not sum to `observed`.
 */
export interface AfterlifeLedgerSummary {
  /** Total launches tracked (every record handed in, regardless of data quality). */
  tracked: number;
  /** Records with live market data observed at their last snapshot. */
  observed: number;
  /** Records whose last snapshot could NOT read live market data (excluded from adverse math). */
  unavailable: number;
  /** Observed launches with ZERO adverse outcome flags. */
  clean: number;
  /** Observed launches whose pool liquidity is materially below graduation. */
  liquidityDrained: number;
  /** Observed launches with at least one scheduled unlock sold into the pool in-window. */
  unlockDumped: number;
  /** Observed launches with no creator on-chain activity for a long stretch. */
  likelyAbandoned: number;
  /** Observed launches still holding materially their graduated liquidity (not drained). */
  stillLiquid: number;
  /**
   * Median signed price move vs launch across OBSERVED records that had a positive
   * launch price (e.g. -0.5 = median down 50%). Null when no such record exists —
   * the UI shows "—", never a fabricated 0%.
   */
  medianPriceReturn: number | null;
  /**
   * Most recent observation timestamp across ALL records (unix seconds), or null
   * when empty. The honest "as of" stamp for the whole ledger.
   */
  asOf: number | null;
}

/** A record counts as market-observed unless it explicitly flagged otherwise (back-compat: undefined = observed). */
function isObserved(r: OutcomeRecord): boolean {
  return r.marketObserved !== false;
}

/** Median of a numeric list. Pure; returns null for an empty list. Does not mutate input. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // length>0 guaranteed above, so mid and mid-1 are valid indices; the assertions
  // just satisfy noUncheckedIndexedAccess.
  const hi = sorted[mid]!;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + hi) / 2 : hi;
}

/**
 * Fold a set of tracked-launch outcome records into an {@link AfterlifeLedgerSummary}.
 * Pure and total: never throws, never fetches, never fabricates. The optional
 * {@link OutcomeConfig} is threaded verbatim into {@link deriveOutcomeFlags} so the
 * cohort tallies use the same drain/abandonment thresholds as the per-row surface.
 */
export function summarizeAfterlife(
  records: readonly OutcomeRecord[],
  cfg: OutcomeConfig = defaultOutcomeConfig(),
): AfterlifeLedgerSummary {
  let observed = 0;
  let unavailable = 0;
  let clean = 0;
  let liquidityDrained = 0;
  let unlockDumped = 0;
  let likelyAbandoned = 0;
  let stillLiquid = 0;
  let asOf: number | null = null;
  const observedReturns: number[] = [];

  for (const r of records) {
    // As-of stamp spans EVERY record — even one we couldn't read market data for
    // still has a real observedAt.
    if (Number.isFinite(r.observedAt)) {
      asOf = asOf == null ? r.observedAt : Math.max(asOf, r.observedAt);
    }

    if (!isObserved(r)) {
      unavailable += 1;
      continue; // never derive adverse/clean/price signals from an unobserved record
    }

    observed += 1;

    const flags = deriveOutcomeFlags(r, cfg);
    if (flags.liquidityDrained) liquidityDrained += 1;
    else stillLiquid += 1;
    if (flags.unlockDumped) unlockDumped += 1;
    if (flags.likelyAbandoned) likelyAbandoned += 1;
    if (!flags.liquidityDrained && !flags.unlockDumped && !flags.likelyAbandoned) clean += 1;

    // Median price move: only meaningful when the launch had a real launch price.
    if (r.launchPriceEth > 0) observedReturns.push(priceReturn(r));
  }

  return {
    tracked: records.length,
    observed,
    unavailable,
    clean,
    liquidityDrained,
    unlockDumped,
    likelyAbandoned,
    stillLiquid,
    medianPriceReturn: median(observedReturns),
    asOf,
  };
}
