/**
 * Which of two quotes wins a Solana swap: our pool's or the aggregator's. Our pool wins a
 * tie and nothing short of one: no band, and no knob to add one. Both candidates are RAW
 * OUTPUT UNITS THE TRADER RECEIVES, fees already out (the aggregator's site fee is priced
 * into its quote; our pool's quote runs the program's own maths), so no fee is adjusted
 * here. Pure: it neither fetches nor sends. The words are lib/solana/swap/venueChoice.ts.
 */

export type RouteVenue = 'own-pool' | 'aggregator';

export interface RouteCandidate {
  venue: RouteVenue;
  /** Raw base units of the output mint the trader ends up with. */
  outAmount: bigint;
  /** Human label for the surface: "venue pool", "Jupiter". */
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
  /** The one that lost, when there was one. */
  runnerUp: RouteCandidate | null;
  /**
   * How much better the winner is than the runner-up, as a fraction of the
   * runner-up's output. 0 means a tie. Null when there was nothing to compare.
   */
  edge: number | null;
}

/** Sort best-first, and keep the ordering total so it is deterministic. */
function byOutputDesc(a: RouteCandidate, b: RouteCandidate): number {
  if (a.outAmount > b.outAmount) return -1;
  if (a.outAmount < b.outAmount) return 1;
  // Equal output: our pool first. The one preference the rule allows.
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
  const chosen = live[0] ?? null;
  const runnerUp = live[1] ?? null;
  return { chosen, candidates: live, runnerUp, edge: chosen && runnerUp ? edgeOver(chosen, runnerUp) : null };
}
