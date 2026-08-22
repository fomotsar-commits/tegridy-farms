// Readings → states a surface is allowed to render.
//
// The whole module exists to keep three different silences apart, because all
// three arrive at a component as "no number" and only one of them is a fact:
//
//   unavailable  — nothing was read. NOT zero, NOT 1.00, NOT a dash that looks
//                  like a small value. The reason travels with it.
//   read + stale — a real measurement, taken a while ago. Shown WITH its age,
//                  and never counted toward a "best rate" claim.
//   read         — current. The only state a headline figure may come from.
//
// The ranking half enforces the claim, not just the cells. "Best-yielding" is a
// statement about a COMPLETE comparison, so a table with an unread row cannot
// make it — it can only say which of the rows it could read is highest, and how
// many it could not. That distinction is the difference between a router and an
// advert.

import type { YieldMeasurement, YieldReading } from './feed';
import { YIELD_READING_MAX_AGE_S } from './feed';
import type { YieldVenue } from './venues';

export type MetricRead =
  | {
      state: 'read';
      value: number;
      /** Where the feed got it. Rendered so a reader can go and check. */
      source: string;
      /** Unix seconds the feed took the reading. */
      asOf: number;
      /** Older than YIELD_READING_MAX_AGE_S. Still real, no longer current. */
      stale: boolean;
      /** Seconds between the reading and the moment it was classified. */
      ageSeconds: number;
    }
  | { state: 'unavailable'; reason: string };

/** True only for a current reading. The one predicate a headline may gate on. */
export function isCurrentRead(m: MetricRead): m is Extract<MetricRead, { state: 'read' }> {
  return m.state === 'read' && !m.stale;
}

function classify(
  measurement: YieldMeasurement | null | undefined,
  asOf: number,
  nowSeconds: number,
  absentReason: string,
): MetricRead {
  if (measurement == null) return { state: 'unavailable', reason: absentReason };
  // A reading stamped in the future is not a fresher reading, it is a clock this
  // module cannot reason about — treated as an unknown age rather than as brand
  // new, because "0 seconds old" is the most trustworthy thing a bad timestamp
  // could claim and the least earned.
  const ageSeconds = nowSeconds - asOf;
  if (ageSeconds < 0) {
    return {
      state: 'unavailable',
      reason: 'This figure is stamped in the future, so how old it is cannot be established.',
    };
  }
  return {
    state: 'read',
    value: measurement.value,
    source: measurement.source,
    asOf,
    stale: ageSeconds > YIELD_READING_MAX_AGE_S,
    ageSeconds,
  };
}

export interface VenueMetrics {
  venue: YieldVenue;
  apy: MetricRead;
  peg: MetricRead;
  exitLiquidity: MetricRead;
}

const NO_FEED_REASON =
  'No yield feed answered for this venue, so its rate, peg and exit liquidity were not read.';

/**
 * One row's three columns.
 *
 * `reading === null` fills all three with the same unavailable state rather than
 * leaving them undefined: a row that renders partially is a row whose blank cells
 * read as zeros, and the blank cell nobody notices is the peg.
 */
export function venueMetrics(
  venue: YieldVenue,
  reading: YieldReading | null,
  asOf: number | null,
  nowSeconds: number,
): VenueMetrics {
  if (reading === null || asOf === null) {
    const missing: MetricRead = { state: 'unavailable', reason: NO_FEED_REASON };
    return { venue, apy: missing, peg: missing, exitLiquidity: missing };
  }
  return {
    venue,
    apy: classify(
      reading.apyPct,
      asOf,
      nowSeconds,
      'The feed answered but carried no rate for this venue, so no APY is shown. This is not a rate of zero.',
    ),
    peg: classify(
      reading.pegRatio,
      asOf,
      nowSeconds,
      `The feed answered but carried no ${venue.pegReference} price for this position, so its peg is unknown. It is NOT assumed to be 1.00.`,
    ),
    exitLiquidity: classify(
      reading.exitLiquidityUsd,
      asOf,
      nowSeconds,
      'The feed answered but carried no exit-liquidity depth for this venue, so how fast this position could be sold was not measured.',
    ),
  };
}

/**
 * How far under its reference a position is trading before the discount is worth
 * printing as a discount rather than as noise.
 *
 * Half a percent, and it is a DISPLAY threshold, not a safety threshold: nothing
 * here decides that a position is safe, and a reading above the line is reported
 * as "at or above reference", never as "healthy", "pegged" or a tick.
 */
export const PEG_DISCOUNT_FLAG_PCT = 0.5;

export type PegAssessment =
  | { state: 'unknown'; reason: string }
  | { state: 'at-or-above-reference'; ratio: number; reference: 'ETH' | 'USD'; stale: boolean }
  | {
      state: 'below-reference';
      ratio: number;
      reference: 'ETH' | 'USD';
      /** Positive percent under the reference. */
      discountPct: number;
      /** Past PEG_DISCOUNT_FLAG_PCT — worth a reader's attention, not a verdict. */
      notable: boolean;
      stale: boolean;
    };

/**
 * What the peg column says.
 *
 * There is no fourth branch and there is deliberately no default. An unread peg
 * returns `unknown` carrying its reason, and the surface prints that reason —
 * because the reader who most needs the peg column is the one about to buy an
 * asset whose peg nobody checked.
 */
export function pegAssessment(peg: MetricRead, reference: 'ETH' | 'USD'): PegAssessment {
  if (peg.state !== 'read') return { state: 'unknown', reason: peg.reason };
  if (peg.value >= 1) {
    return { state: 'at-or-above-reference', ratio: peg.value, reference, stale: peg.stale };
  }
  const discountPct = (1 - peg.value) * 100;
  return {
    state: 'below-reference',
    ratio: peg.value,
    reference,
    discountPct,
    notable: discountPct >= PEG_DISCOUNT_FLAG_PCT,
    stale: peg.stale,
  };
}

export interface RankedVenue {
  venue: YieldVenue;
  apyPct: number;
  source: string;
  stale: boolean;
}

export interface UnrankedVenue {
  venue: YieldVenue;
  reason: string;
}

export interface YieldRanking {
  /** Descending by APY. Contains only venues whose APY was actually read. */
  ranked: RankedVenue[];
  /** Everything that could not be compared, each with why. Never silently dropped. */
  unranked: UnrankedVenue[];
  /** Highest READ rate, or null when nothing was read. Never a fallback row. */
  best: RankedVenue | null;
  /**
   * True only when every venue in scope contributed a CURRENT reading.
   *
   * The two ways this goes false are different sentences to a reader and the same
   * fact to this module: something in the comparison is missing, so "the best" is
   * a claim about a subset and has to be worded like one.
   */
  complete: boolean;
  /** Count of rows excluded because nothing was read for them. */
  unreadCount: number;
  /** Count of ranked rows whose reading is past YIELD_READING_MAX_AGE_S. */
  staleCount: number;
}

/**
 * Rank by read APY, never by absence.
 *
 * A venue with no readable rate is NOT ranked last — it is not ranked at all. The
 * distinction matters because "last" is a position on a leaderboard and carries
 * the claim that the row was measured and lost, which is the fabricated zero this
 * whole slice exists to refuse. Ties keep catalogue order so the table does not
 * reshuffle between renders that read the same numbers.
 */
export function rankByApy(rows: readonly VenueMetrics[]): YieldRanking {
  const ranked: RankedVenue[] = [];
  const unranked: UnrankedVenue[] = [];

  rows.forEach((row) => {
    if (row.apy.state !== 'read') {
      unranked.push({ venue: row.venue, reason: row.apy.reason });
      return;
    }
    ranked.push({
      venue: row.venue,
      apyPct: row.apy.value,
      source: row.apy.source,
      stale: row.apy.stale,
    });
  });

  ranked.sort((a, b) => b.apyPct - a.apyPct);
  const staleCount = ranked.filter((r) => r.stale).length;

  return {
    ranked,
    unranked,
    best: ranked[0] ?? null,
    complete: rows.length > 0 && unranked.length === 0 && staleCount === 0,
    unreadCount: unranked.length,
    staleCount,
  };
}

/**
 * The sentence a surface is allowed to put next to the top row.
 *
 * Returned as a string rather than left to each component, so the wording cannot
 * drift into "best rate available" on one panel while another hedges. The
 * incomplete forms name the number of rows that were not compared, because "best
 * of the three we could read" and "best of eight" are different products.
 */
export function bestRateClaim(ranking: YieldRanking): string {
  if (ranking.best === null) {
    return 'No rate could be read for any venue here, so there is nothing to rank. This is not a statement that the rates are low.';
  }
  if (ranking.complete) {
    return `Highest current rate of the ${ranking.ranked.length} venues compared here.`;
  }
  const caveats: string[] = [];
  if (ranking.unreadCount > 0) {
    caveats.push(
      `${ranking.unreadCount} venue${ranking.unreadCount === 1 ? '' : 's'} could not be read at all and may be higher`,
    );
  }
  if (ranking.staleCount > 0) {
    caveats.push(
      `${ranking.staleCount} reading${ranking.staleCount === 1 ? ' is' : 's are'} out of date`,
    );
  }
  return `Highest of the ${ranking.ranked.length} rate${ranking.ranked.length === 1 ? '' : 's'} that could be read — ${caveats.join(', ')}. This is not "the best rate available".`;
}
