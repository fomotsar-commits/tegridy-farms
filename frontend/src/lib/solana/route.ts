/**
 * Which venue a Solana swap executes against.
 *
 * The venue hosts its own AMM pools and also quotes an aggregator. The rule the
 * operator set, and the only one this file implements:
 *
 *   ROUTE TO OUR OWN POOL UNLESS SOMEWHERE ELSE IS MORE EFFICIENT.
 *
 * Read the second half as strictly as the first. Self-preferencing a worse
 * price is not a routing preference, it is a worse fill charged to the trader,
 * so a tie goes to our pool, and anything short of a tie does not. There is
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
 * know what a wallet is. It takes the quotes and returns a decision plus the
 * sentence explaining it, so every surface can show the trader why their trade
 * went where it went. The swap page executes what it decides
 * (`swap/ownPoolRoute.ts` holds the decision again when Buy is pressed).
 */

export type RouteVenue = 'own-pool' | 'aggregator';

export interface RouteCandidate {
  venue: RouteVenue;
  /** Raw base units of the output mint the trader ends up with. */
  outAmount: bigint;
  /** Human label for the surface — "venue pool", "Jupiter", … */
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
  if (a.venue !== b.venue) return a.venue === 'own-pool' ? -1 : 1;
  // Two of our pools quoting the same: by address, so input order decides nothing.
  const [x, y] = [a.poolAddress ?? '', b.poolAddress ?? ''];
  return x < y ? -1 : x > y ? 1 : 0;
}

function edgeOver(winner: RouteCandidate, loser: RouteCandidate): number {
  if (loser.outAmount <= 0n) return 0;
  return Number(winner.outAmount - loser.outAmount) / Number(loser.outAmount);
}

/** An edge as a trader reads it. A real edge is never printed as 0%, which reads as a tie. */
export function edgePercent(edge: number): string {
  const pct = edge * 100;
  if (pct > 0 && pct < 0.001) return 'under 0.001%';
  return `${pct.toLocaleString(undefined, { maximumFractionDigits: 3 })}%`;
}

/**
 * Pick the venue. `candidates` holds one entry for each of our pools that quoted
 * (a pair can have several) and at most one for the aggregator; anything that
 * failed to quote should simply be absent rather than present with a zero.
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
  // The one that lost is the best of the OTHER venue. A second pool of ours is
  // not somewhere else, and "more output than our own pool" is no disclosure.
  const runnerUp = live.find((c) => c.venue !== chosen.venue) ?? null;

  if (!runnerUp) {
    return {
      chosen, candidates: live, runnerUp: null, edge: null,
      reason: chosen.venue === 'own-pool'
        ? 'Only our pool quoted this pair.'
        : `${chosen.label}. We have no pool for this pair.`,
    };
  }

  const edge = edgeOver(chosen, runnerUp);
  const pct = edgePercent(edge);

  let reason: string;
  if (edge === 0) {
    reason = chosen.venue === 'own-pool'
      ? `Our pool matches ${runnerUp.label}, so the trade stays here.`
      : `${chosen.label} and ${runnerUp.label} quoted the same output.`;
  } else if (chosen.venue === 'own-pool') {
    reason = `Our pool pays ${pct} more than ${runnerUp.label}.`;
  } else {
    // The case that proves the rule is real: our own pool existed and lost.
    reason = `${chosen.label} pays ${pct} more than our pool.`;
  }

  return { chosen, candidates: live, runnerUp, edge, reason };
}

/**
 * A candidate from an own-pool quote, or null when there is no pool / no
 * quote. Keeps the `bigint | null` unwrapping out of every caller.
 */
export function ownPoolCandidate(
  quote: { outAmount: bigint; poolAddress: string; priceImpact?: number } | null,
  label = 'venue pool',
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
