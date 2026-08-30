/**
 * Which venue a Solana swap executes against.
 *
 * The venue hosts its own AMM pools and also quotes an aggregator. The rule the
 * operator set, and the only one this file implements:
 *
 *   ROUTE TO OUR OWN POOL UNLESS SOMEWHERE ELSE IS MORE EFFICIENT.
 *
 * Read the second half as strictly as the first. Self-preferencing a worse
 * price is not a routing preference, it is a worse fill charged to the trader
 * — so a tie goes to our pool, and anything short of a tie does not. There is
 * no configurable fudge factor, no "within 10 bps" band, and deliberately no
 * knob to add one: a band is exactly how a best-execution promise becomes a
 * marketing line.
 *
 * COMPARABILITY. Both candidates are quoted as RAW OUTPUT UNITS THE TRADER
 * RECEIVES, which is what makes them comparable at all:
 *   - the aggregator quote already has any venue platform fee deducted
 *     (jupiter.ts keeps `platformFeeBps` and `feeAccount` coupled, and sends
 *     neither when no fee account is configured);
 *   - our own-pool quote already has the pool's trade fee, protocol cut, fund
 *     cut and creator fee taken out, because it runs the program's own maths.
 * Neither number is "before fees", so no fee adjustment happens here. If a
 * future venue fee sits OUTSIDE the quote, it must be subtracted before a
 * candidate reaches this file, not compensated for inside it.
 *
 * WHAT THIS FILE DOES NOT DO: it does not execute, does not fetch, and does not
 * know what a wallet is. It takes two quotes and returns a decision plus the
 * sentence explaining it, so every surface can show the trader why their trade
 * went where it went.
 */

export type RouteVenue = 'own-pool' | 'aggregator';

export interface RouteCandidate {
  venue: RouteVenue;
  /** Raw base units of the output mint the trader ends up with. */
  outAmount: bigint;
  /** Human label for the surface — "Tegridy pool", "Jupiter", … */
  label: string;
  /** Set for own-pool candidates so the surface can link the pool. */
  poolAddress?: string;
  /** Price impact as a fraction, where the venue reports one. */
  priceImpact?: number;
}

export interface RouteDecision {
  chosen: RouteCandidate | null;
  /** Every candidate that produced a quote, best first. */
  candidates: RouteCandidate[];
  /** The one that lost, when there was one — for the "we checked" line. */
  runnerUp: RouteCandidate | null;
  /**
   * How much better the winner is than the runner-up, as a fraction of the
   * runner-up's output. 0 means a tie. Null when there was nothing to compare.
   */
  edge: number | null;
  /** Plain-language reason, safe to render verbatim. */
  reason: string;
}

/** Sort best-first, and keep the ordering total so it is deterministic. */
function byOutputDesc(a: RouteCandidate, b: RouteCandidate): number {
  if (a.outAmount > b.outAmount) return -1;
  if (a.outAmount < b.outAmount) return 1;
  // Equal output: our own pool first. This is the tie-break the rule allows,
  // and the ONLY thing in this file that prefers us.
  if (a.venue === b.venue) return 0;
  return a.venue === 'own-pool' ? -1 : 1;
}

function edgeOver(winner: RouteCandidate, loser: RouteCandidate): number {
  if (loser.outAmount <= 0n) return 0;
  return Number(winner.outAmount - loser.outAmount) / Number(loser.outAmount);
}

/**
 * Pick the venue. `candidates` may contain at most one of each venue; anything
 * that failed to quote should simply be absent rather than present with a zero.
 */
export function chooseRoute(candidates: RouteCandidate[]): RouteDecision {
  const live = candidates.filter((c) => c.outAmount > 0n).sort(byOutputDesc);

  if (live.length === 0) {
    return {
      chosen: null, candidates: [], runnerUp: null, edge: null,
      reason: 'No venue could quote this trade.',
    };
  }

  const chosen = live[0]!;
  const runnerUp = live[1] ?? null;

  if (!runnerUp) {
    return {
      chosen, candidates: live, runnerUp: null, edge: null,
      reason: chosen.venue === 'own-pool'
        ? `Routed to the ${chosen.label} — it was the only venue that quoted this pair.`
        : `Routed to ${chosen.label}. This venue has no pool for this pair.`,
    };
  }

  const edge = edgeOver(chosen, runnerUp);
  const pct = (edge * 100).toLocaleString(undefined, { maximumFractionDigits: 3 });

  let reason: string;
  if (edge === 0) {
    reason = chosen.venue === 'own-pool'
      ? `The ${chosen.label} and ${runnerUp.label} quoted the same output, so the trade stays here.`
      : `${chosen.label} and ${runnerUp.label} quoted the same output.`;
  } else if (chosen.venue === 'own-pool') {
    reason = `Routed to the ${chosen.label} — ${pct}% more output than ${runnerUp.label}.`;
  } else {
    // The case that proves the rule is real: our own pool existed and lost.
    reason = `Routed to ${chosen.label} — ${pct}% better than our own pool, so the trade went there.`;
  }

  return { chosen, candidates: live, runnerUp, edge, reason };
}

/**
 * A candidate from an own-pool quote, or null when there is no pool / no
 * quote. Keeps the `bigint | null` unwrapping out of every caller.
 */
export function ownPoolCandidate(
  quote: { outAmount: bigint; poolAddress: string; priceImpact?: number } | null,
  label = 'Tegridy pool',
): RouteCandidate | null {
  if (!quote || quote.outAmount <= 0n) return null;
  return {
    venue: 'own-pool',
    outAmount: quote.outAmount,
    label,
    poolAddress: quote.poolAddress,
    priceImpact: quote.priceImpact,
  };
}

/**
 * A candidate from an aggregator quote. `outAmount` is the aggregator's own
 * `outAmount` string in raw units — NOT `otherAmountThreshold`, which is the
 * post-slippage floor and would systematically under-represent the aggregator
 * and bias every comparison toward our own pool.
 */
export function aggregatorCandidate(
  quote: { outAmount: string; priceImpactPct?: string } | null,
  label = 'Jupiter',
): RouteCandidate | null {
  if (!quote) return null;
  let out: bigint;
  try {
    out = BigInt(quote.outAmount);
  } catch {
    return null;
  }
  if (out <= 0n) return null;
  const impact = quote.priceImpactPct === undefined ? undefined : Number(quote.priceImpactPct);
  return {
    venue: 'aggregator',
    outAmount: out,
    label,
    priceImpact: Number.isFinite(impact) ? impact : undefined,
  };
}
