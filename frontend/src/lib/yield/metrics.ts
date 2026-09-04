// Readings → states a surface is allowed to render.
//
// The whole module exists to keep FOUR different silences apart, because all
// four arrive at a component as "no number" and only one of them is a fact:
//
//   unavailable    — nothing was read. NOT zero, NOT 1.00, NOT a dash that looks
//                    like a small value. The reason names the call that failed.
//   not-applicable — there is nothing to read, and that is a property of the
//                    position rather than an outage. A rebasing token has no
//                    share rate; a vault redeemed at its own rate has no market
//                    price. Filing those under "unavailable" would invite an
//                    operator to go and wire a source that cannot exist.
//   read + stale   — a real measurement, taken a while ago. Shown WITH its age,
//                    and never counted toward a "best rate" claim.
//   read           — current. The only state a headline figure may come from.
//
// Staleness is per-reading, against that source's OWN maximum age. A Chainlink
// feed with a 24-hour heartbeat and a lending rate recomputed every block do not
// go stale on the same schedule, and one global window would have called the
// first broken or the second fresh.
//
// The ranking half enforces the claim, not just the cells. "Best-yielding" is a
// statement about a COMPLETE comparison, so a table with an unread row cannot
// make it — it can only say which of the rows it could read is highest, and how
// many it could not.

import type { YieldVenue } from './venues';

/** What a figure is denominated in. Rendered, never inferred from the number. */
export type MetricUnit = 'pct' | 'ratio' | 'ETH' | 'USD' | 'USDC' | 'USDS' | 'stETH';

export type MetricRead =
  | {
      state: 'read';
      value: number;
      unit: MetricUnit;
      /** The contract.function, feed pair + round, or round span it came from. */
      source: string;
      /** Unix seconds the SOURCE is stamped with — never when the browser asked. */
      asOf: number;
      /** The block whose state produced it. Every figure on a row names one. */
      block: number;
      /** Older than this reading's own `maxAgeS`. Still real, no longer current. */
      stale: boolean;
      ageSeconds: number;
      /** This source's freshness window. Per-source, never global. */
      maxAgeS: number;
      /**
       * For an exit figure: whether the number is liquidity a holder can take
       * NOW, or a queue standing in front of them. The two are opposite facts
       * and would otherwise render identically.
       */
      meaning?: 'available-now' | 'queued-ahead';
      /** How a rate was annualised, when rows in one table were annualised differently. */
      basis?: string;
    }
  | { state: 'unavailable'; reason: string }
  | { state: 'not-applicable'; reason: string };

export type ReadMetric = Extract<MetricRead, { state: 'read' }>;

/** True only for a current reading. The one predicate a headline may gate on. */
export function isCurrentRead(m: MetricRead): m is ReadMetric {
  return m.state === 'read' && !m.stale;
}

export interface VenueMetrics {
  venue: YieldVenue;
  /** Annualised, compounded per second. The ranked column. */
  rate: MetricRead;
  /** What the protocol itself says one unit is worth. */
  nav: MetricRead;
  /** What a market says one unit is worth. Never an exchange-rate feed. */
  market: MetricRead;
  /** market ÷ nav, unit-less. Both legs read, or the cell is unavailable. */
  vsNav: MetricRead;
  /** Redeemable depth or the queue in front of it — `meaning` says which. */
  exit: MetricRead;
  /** The block every read cell on this row was taken at, or null. */
  block: number | null;
  /** That block's own timestamp, from the same call. Never the browser clock. */
  asOf: number | null;
}

/**
 * How far under its NAV a position is trading before the discount is worth
 * printing as a discount rather than as noise.
 *
 * Half a percent, and it is a DISPLAY threshold, not a safety threshold: nothing
 * here decides that a position is safe, and a reading above the line is reported
 * as "at or above NAV", never as "healthy", "pegged" or a tick.
 */
export const PEG_DISCOUNT_FLAG_PCT = 0.5;

export type PegAssessment =
  | { state: 'unknown'; reason: string }
  | { state: 'at-or-above-nav'; ratio: number; stale: boolean }
  | {
      state: 'below-nav';
      ratio: number;
      /** Positive percent under NAV. */
      discountPct: number;
      /** Past PEG_DISCOUNT_FLAG_PCT — worth a reader's attention, not a verdict. */
      notable: boolean;
      stale: boolean;
    };

/**
 * What the vs-NAV column says.
 *
 * There is no fourth branch and deliberately no default. An unread ratio returns
 * `unknown` carrying its reason, and the surface prints that reason — because
 * the reader who most needs this column is the one about to buy an asset whose
 * discount nobody checked.
 */
export function pegAssessment(ratio: MetricRead): PegAssessment {
  if (ratio.state !== 'read') return { state: 'unknown', reason: ratio.reason };
  if (ratio.value >= 1) return { state: 'at-or-above-nav', ratio: ratio.value, stale: ratio.stale };
  const discountPct = (1 - ratio.value) * 100;
  return {
    state: 'below-nav',
    ratio: ratio.value,
    discountPct,
    notable: discountPct >= PEG_DISCOUNT_FLAG_PCT,
    stale: ratio.stale,
  };
}

export interface RankedVenue {
  venue: YieldVenue;
  ratePct: number;
  source: string;
  stale: boolean;
  basis: string | null;
}

export interface UnrankedVenue {
  venue: YieldVenue;
  reason: string;
}

export interface YieldRanking {
  /** Descending by rate. Contains only venues whose rate was actually read. */
  ranked: RankedVenue[];
  /** Everything that could not be compared, each with why. Never silently dropped. */
  unranked: UnrankedVenue[];
  /** Highest READ rate, or null when nothing was read. Never a fallback row. */
  best: RankedVenue | null;
  /** True only when every venue in scope contributed a CURRENT reading. */
  complete: boolean;
  /** Count of rows excluded because nothing was read for them. */
  unreadCount: number;
  /** Count of ranked rows past their OWN freshness window. */
  staleCount: number;
  /** True when the ranked rows were not all annualised the same way. */
  mixedBases: boolean;
}

/**
 * Rank by read rate, never by absence.
 *
 * A venue with no readable rate is NOT ranked last — it is not ranked at all.
 * "Last" is a position on a leaderboard and carries the claim that the row was
 * measured and lost, which is the fabricated zero this whole slice refuses.
 * `not-applicable` is treated the same way for the same reason. Ties keep
 * catalogue order so the table does not reshuffle between identical renders.
 */
export function rankByRate(rows: readonly VenueMetrics[]): YieldRanking {
  const ranked: RankedVenue[] = [];
  const unranked: UnrankedVenue[] = [];

  rows.forEach((row) => {
    if (row.rate.state !== 'read') {
      unranked.push({ venue: row.venue, reason: row.rate.reason });
      return;
    }
    ranked.push({
      venue: row.venue,
      ratePct: row.rate.value,
      source: row.rate.source,
      stale: row.rate.stale,
      basis: row.rate.basis ?? null,
    });
  });

  ranked.sort((a, b) => b.ratePct - a.ratePct);
  const staleCount = ranked.filter((r) => r.stale).length;
  const bases = new Set(ranked.map((r) => r.basis ?? 'compounded per second from the protocol'));

  return {
    ranked,
    unranked,
    best: ranked[0] ?? null,
    complete: rows.length > 0 && unranked.length === 0 && staleCount === 0,
    unreadCount: unranked.length,
    staleCount,
    mixedBases: bases.size > 1,
  };
}

/**
 * The sentence a surface is allowed to put next to the top row.
 *
 * Returned as a string rather than left to each component, so the wording cannot
 * drift into "best rate available" on one panel while another hedges. The
 * incomplete forms name the number of rows that were not compared, because "best
 * of the three we could read" and "best of eight" are different products — and
 * the mixed-bases caveat exists because a lending APY and a trailing NAV change
 * are not the same kind of number even when both are printed as a percent.
 */
export function bestRateClaim(ranking: YieldRanking): string {
  if (ranking.best === null) {
    return 'No rate could be read for any venue here, so there is nothing to rank. This is not a statement that the rates are low.';
  }
  const mixed = ranking.mixedBases
    ? ' Rates here are annualised on different bases — see each row.'
    : '';
  if (ranking.complete) {
    return `Highest current rate of the ${ranking.ranked.length} venues compared here.${mixed} Token incentives are excluded from every figure.`;
  }
  const caveats: string[] = [];
  if (ranking.unreadCount > 0) {
    caveats.push(
      `${ranking.unreadCount} venue${ranking.unreadCount === 1 ? '' : 's'} could not be read at all and may be higher`,
    );
  }
  if (ranking.staleCount > 0) {
    caveats.push(`${ranking.staleCount} reading${ranking.staleCount === 1 ? ' is' : 's are'} out of date`);
  }
  return (
    `Highest of the ${ranking.ranked.length} rate${ranking.ranked.length === 1 ? '' : 's'} that could be read — ` +
    `${caveats.join(', ')}. This is not "the best rate available".${mixed} Token incentives are excluded from every figure.`
  );
}
