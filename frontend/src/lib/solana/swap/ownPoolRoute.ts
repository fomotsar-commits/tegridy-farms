import type { AggregatorSeen, Prepared } from '../../launcher/solana/write/types';
import { aggregatorCandidate, chooseRoute, type RouteCandidate, type RouteDecision } from '../route';
import type { VenuePoolCandidate } from './venuePools';

/**
 * The route, decided again when Buy is pressed: both venues are quoted again and a route
 * that changed is shown to the trader, never taken. So the rule (lib/solana/route.ts)
 * holds for what is SENT, both ways. "What the aggregator pays" is what its transaction
 * FROM THIS SITE would pay: without the site fee on a route where it cannot be taken
 * (swap/jupiterFeeRetry.ts). No fetch and no wallet here: every read is handed in.
 */

export const OWN_ROUTE_COPY = {
  routeMoved: 'Jupiter now pays more for this trade than our own pool does, so nothing was built here. Start over and press Buy again to take the better route.',
  poolGone: 'Our own pool could not be quoted just now, so nothing was built here. Start over and press Buy again.',
  ownNowWins: 'Our own pool now pays at least as much as Jupiter for this trade. Review the new route and press Buy again.',
} as const;

const notBuilt = (message: string): Prepared => ({ ok: false, outcome: { status: 'not-sent', stage: 'build', message } });

/** The decision on quotes taken just now. `aggregatorOut` null = the aggregator gave none. */
export function freshDecision(own: readonly VenuePoolCandidate[], aggregatorOut: bigint | null, aggregatorLabel = 'Jupiter'): RouteDecision {
  const agg = aggregatorOut === null ? null : aggregatorCandidate({ outAmount: aggregatorOut.toString() }, aggregatorLabel);
  return chooseRoute([...own, agg].filter((c): c is RouteCandidate => c !== null));
}

export interface OwnPoolSwapDeps {
  /**
   * What the aggregator would pay for this trade now, in the output's base units. Null
   * when it answers that it has no route. THROWS when it could not be asked.
   */
  aggregatorOut(): Promise<bigint | null>;
  /** Our pools for the pair, read again and quoted. Never throws; none = none could be quoted. */
  ownPools(): Promise<VenuePoolCandidate[]>;
  /** Build and test-run the swap in `pool`, refusing if it pays less than the aggregator was seen to. */
  prepare(pool: string, aggregator: AggregatorSeen): Promise<Prepared>;
}

/**
 * Build the swap in our own pool, if our pool is still where the trade belongs.
 * `shownAggregatorOut` (the aggregator's quote on screen, or null) stands in only when
 * the aggregator cannot be asked again, so a pool is never taken at less than the last
 * figure the trader saw beside it. With neither, the swap is built and its review says
 * the aggregator could not be asked: an unanswered question is never "no route".
 */
export async function prepareOwnPoolSwap(deps: OwnPoolSwapDeps, shownAggregatorOut: bigint | null): Promise<Prepared> {
  const [agg, own] = await Promise.all([
    deps.aggregatorOut().then(
      (out): AggregatorSeen => (out === null ? { kind: 'no-route' } : { kind: 'quoted', out, when: 'now' }),
      (): AggregatorSeen => (shownAggregatorOut === null ? { kind: 'unreachable' } : { kind: 'quoted', out: shownAggregatorOut, when: 'earlier' }),
    ),
    deps.ownPools(),
  ]);
  if (own.length === 0) return notBuilt(OWN_ROUTE_COPY.poolGone);
  const chosen = freshDecision(own, agg.kind === 'quoted' ? agg.out : null).chosen;
  if (chosen?.venue !== 'own-pool' || !chosen.poolAddress) return notBuilt(OWN_ROUTE_COPY.routeMoved);
  return deps.prepare(chosen.poolAddress, agg);
}

/** With what the aggregator's transaction would pay in hand: does one of our pools, read again now, take the trade? */
export async function ownPoolNowWins(ownPools: () => Promise<VenuePoolCandidate[]>, aggregatorOut: bigint): Promise<boolean> {
  const own = await ownPools();
  return freshDecision(own, aggregatorOut).chosen?.venue === 'own-pool';
}

/** `p`, or `fallback` when it has not answered within `ms`: a read that hangs must not hold a trade. */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
