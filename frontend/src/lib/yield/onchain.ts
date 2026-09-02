// Raw contract answers → numbers a reader is allowed to see.
//
// Pure, so every conversion in this file is pinned by vectors rather than by a
// screenshot. That matters more here than in most modules: a wrong exponent in
// an annualisation does not throw, does not fail a render and does not look
// wrong — it produces a plausible percentage that a reader would act on.
//
// EVERY function refuses rather than defaults. There is no branch anywhere below
// that returns 0, 1.00 or a fallback: an input that cannot be turned into a real
// figure comes back as `{state:'unavailable'}` carrying the sentence that says
// which read was missing. A fabricated zero on a yield surface is the single
// most persuasive wrong answer available, because 0.00% beside a 1.0000 peg
// reads exactly like a considered measurement.

import type { MetricRead } from './metrics';
import type { FeedMarketClass } from './protocols';

/** Seconds in a 365-day year. The compounding base for every annualisation. */
export const SECONDS_PER_YEAR = 31_536_000;

/**
 * ONE convention for the ranked column: annualised, compounded per second.
 *
 * Aave quotes a per-second APR in ray, Compound a per-second rate in 1e18, Sky a
 * per-second growth factor in ray. Presenting those three side by side without
 * converting them to the same thing would rank a 5% APR above a 5.1% APY that is
 * actually the larger number. The APR is not thrown away — it appears in the
 * source string, so a reader comparing this page with the protocol's own UI can
 * see which figure they are looking at.
 */
function annualiseFromPerSecondRate(perSecond: number): number {
  return ((1 + perSecond) ** SECONDS_PER_YEAR - 1) * 100;
}

/** Aave v3 `currentLiquidityRate`: an APR in ray (1e27) per year. */
export function aaveRayRateToApyPct(ray: bigint): number {
  return annualiseFromPerSecondRate(Number(ray) / 1e27 / SECONDS_PER_YEAR);
}

/** Compound v3 `getSupplyRate(utilisation)`: a per-SECOND rate scaled by 1e18. */
export function compoundPerSecondToApyPct(rate1e18: bigint): number {
  return annualiseFromPerSecondRate(Number(rate1e18) / 1e18);
}

/** Compound's own headline, kept for the source string so the two are legible together. */
export function compoundPerSecondToAprPct(rate1e18: bigint): number {
  return (Number(rate1e18) / 1e18) * SECONDS_PER_YEAR * 100;
}

/**
 * Sky `ssr()`: a per-second GROWTH FACTOR in ray, so it is already 1 + r and the
 * subtraction happens after exponentiation rather than before.
 */
export function ssrToApyPct(ssrRay: bigint): number {
  const perSecondFactor = Number(ssrRay) / 1e27;
  return (perSecondFactor ** SECONDS_PER_YEAR - 1) * 100;
}

/** Twenty hours. Below this a two-round span is mostly publication jitter. */
export const MIN_TRAILING_SPAN_S = 72_000;

export interface FeedRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}

/**
 * The prior round ids to ask for, without ever crossing a phase boundary.
 *
 * A Chainlink round id packs a 16-bit phase into the high bits and the
 * aggregator's own round counter into the low 64. Decrementing across the
 * boundary produces an id that belongs to the PREVIOUS aggregator, and
 * `getRoundData` either reverts or answers from a different instrument. Either
 * way it is not the same series, so the walk stops at 1.
 */
export function previousRoundIds(roundId: bigint, n: number): bigint[] {
  const low = roundId & 0xffff_ffff_ffff_ffffn;
  const ids: bigint[] = [];
  for (let k = 1n; k <= BigInt(n); k += 1n) {
    if (low - k < 1n) break;
    ids.push(roundId - k);
  }
  return ids;
}

function formatStamp(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * Growth in a protocol's published NAV between two feed rounds, annualised.
 *
 * The EARLIEST qualifying round is chosen rather than the nearest, because a
 * short span turns publication jitter into a headline: over 24 hours a 0.1%
 * wobble annualises to 44%. Over the eight days the free round history reaches,
 * the same wobble is under 5%. The span that was actually used is printed in the
 * source string, so nobody has to guess whether they are reading a day or a week.
 *
 * A DECLINE returns a real negative number. That is deliberate: a restaking NAV
 * can fall — slashing, fee changes, a publisher revision — and clamping it at
 * zero would be the fabricated floor this file exists to refuse.
 */
export function trailingNavGrowthApyPct(
  pair: string,
  latest: FeedRound,
  prior: readonly FeedRound[],
  blockTs: bigint,
  block: bigint,
): MetricRead {
  const qualifying = prior
    .filter((r) => r.answer > 0n && latest.updatedAt - r.updatedAt >= BigInt(MIN_TRAILING_SPAN_S))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
  const earliest = qualifying[0];
  if (earliest === undefined) {
    return {
      state: 'unavailable',
      reason:
        `A growth rate needs two ${pair} feed rounds at least 20 hours apart; the feed's round history at ` +
        `block ${block} did not give two. That is a missing measurement, not a rate of zero.`,
    };
  }
  if (latest.answer <= 0n) {
    return { state: 'unavailable', reason: `The latest ${pair} round answered ${latest.answer}, which is not a rate.` };
  }
  const spanS = Number(latest.updatedAt - earliest.updatedAt);
  const ratio = Number(latest.answer) / Number(earliest.answer);
  const value = (ratio ** (SECONDS_PER_YEAR / spanS) - 1) * 100;
  if (!Number.isFinite(value)) {
    return { state: 'unavailable', reason: `The ${pair} rounds ${earliest.roundId} and ${latest.roundId} did not annualise to a finite number.` };
  }
  return {
    state: 'read',
    value,
    unit: 'pct',
    source:
      `Chainlink ${pair} exchange-rate rounds ${earliest.roundId} → ${latest.roundId}, ` +
      `${(spanS / 86400).toFixed(1)} days apart (${formatStamp(earliest.updatedAt)} → ${formatStamp(latest.updatedAt)}), via getRoundData`,
    asOf: Number(latest.updatedAt),
    block: Number(block),
    stale: false,
    ageSeconds: Number(blockTs - latest.updatedAt),
    maxAgeS: MIN_TRAILING_SPAN_S,
    basis: `trailing change in the rate ether.fi and Renzo publish to Chainlink, over the ${(spanS / 86400).toFixed(1)} days the feed's round history reached — not a forward quote`,
  };
}

/**
 * One Chainlink round, turned into a ratio or refused.
 *
 * Four refusals, and none of them can be reached by a healthy feed:
 *   answer ≤ 0                — not a price; a signed zero here would render 0.0000
 *   answeredInRound < roundId — the aggregator carried a previous answer forward
 *   updatedAt > blockTs       — stamped after the block that read it
 *   blockTs − updatedAt > 2h  — where h is the publisher's heartbeat: one missed
 *                               publication is normal, two is a stopped feed
 *
 * Staleness is judged against the CHAIN's clock, taken in the same multicall.
 * The browser's clock belongs to the visitor and is routinely wrong by hours; a
 * feed marked stale because somebody's laptop is set to next Tuesday would be a
 * failure invented entirely on the client.
 */
export function chainlinkRatio(
  pair: string,
  round: FeedRound,
  decimals: number,
  blockTs: bigint,
  block: bigint,
  heartbeatS: number,
  unit: 'ETH' | 'USD',
): MetricRead {
  const where = `Chainlink ${pair} round ${round.roundId} at block ${block}`;
  if (round.answer <= 0n) {
    return { state: 'unavailable', reason: `${where} answered ${round.answer}, which is not a price. Nothing is assumed in its place.` };
  }
  if (round.answeredInRound < round.roundId) {
    return { state: 'unavailable', reason: `${where} carried an answer forward from an earlier round (answeredInRound ${round.answeredInRound} < roundId ${round.roundId}), so it is not a current reading.` };
  }
  if (round.updatedAt > blockTs) {
    return { state: 'unavailable', reason: `${where} is stamped in the future relative to the block that read it, so how old it is cannot be established.` };
  }
  const maxAgeS = heartbeatS * 2;
  const ageSeconds = Number(blockTs - round.updatedAt);
  return {
    state: 'read',
    value: Number(round.answer) / 10 ** decimals,
    unit,
    source: `Chainlink ${pair}, round ${round.roundId}, updated ${formatStamp(round.updatedAt)}`,
    asOf: Number(round.updatedAt),
    block: Number(block),
    stale: ageSeconds > maxAgeS,
    ageSeconds,
    maxAgeS,
  };
}

/**
 * How far an exchange-rate feed may drift from the protocol rate it republishes
 * before this build stops believing it is still republishing it. Fifty basis
 * points: wide enough that ordinary publication lag never trips it, narrow
 * enough that a feed which has quietly become something else does.
 */
export const NAV_TRACKING_TOLERANCE = 0.005;

export type FeedLegVerdict =
  | { ok: true; marketClass: FeedMarketClass }
  | { ok: false; reason: string };

/**
 * Is the pinned class still true of the live feed?
 *
 * ONE-WAY on purpose. An exchange-rate feed that has drifted far from the
 * protocol's own rate has stopped tracking it and is refused. A MARKET feed is
 * never reclassified for sitting close to NAV — that is what a healthy peg looks
 * like, and treating it as evidence of anything would misclassify every
 * well-behaved market. The verification run made the point concrete: CBETH/ETH
 * and RETH/ETH are both market feeds and sat 4.55 and 5.68 bps from their
 * protocols' rates, one basis point either side of a symmetric 5-bps threshold.
 */
export function classifyFeedLeg(
  pair: string,
  pinnedClass: FeedMarketClass,
  feedRatio: number,
  navRatio: number | null,
): FeedLegVerdict {
  if (pinnedClass === 'market') return { ok: true, marketClass: 'market' };
  if (navRatio === null || navRatio <= 0) return { ok: true, marketClass: 'exchange-rate' };
  const drift = Math.abs(feedRatio - navRatio) / navRatio;
  if (drift > NAV_TRACKING_TOLERANCE) {
    return {
      ok: false,
      reason:
        `The ${pair} feed is pinned as the protocol's own published rate, but it is ${(drift * 100).toFixed(2)}% ` +
        `away from the rate read from the protocol's contract in the same call. It is no longer tracking what this ` +
        'build believes it tracks, so nothing is shown from it.',
    };
  }
  return { ok: true, marketClass: 'exchange-rate' };
}

/**
 * Market price ÷ protocol NAV. Unit-less by construction — the two legs cancel,
 * which is exactly why it must never be rendered with a currency suffix.
 */
export function vsNav(market: number, nav: number): number {
  return market / nav;
}
