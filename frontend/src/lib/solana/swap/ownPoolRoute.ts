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
  routeMoved: 'Jupiter now pays more for this trade than our own pool, so nothing was sent. Press again to take the better route.',
  underLastQuote: 'Our own pool now pays less than the last quote Jupiter gave, and Jupiter could not be asked again just now, so nothing was sent. Check the route and press again.',
  poolGone: 'Our own pool could not be quoted just now, so nothing was sent. Press again.',
  ownNowWins: 'Our own pool now pays at least as much as Jupiter for this trade. Check the new route and press again.',
  notChecked: 'Our own pools did not answer in time, so nothing was sent. Press again.',
  formChanged: 'The trade on the form changed while its route was being checked, so nothing was sent.',
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
  /**
   * Would the transaction for the quote `aggregatorOut` just gave pass its own test run?
   * Asked only when that quote would take the trade from our pool. False only when the
   * test run refused it: one that could not run is true, as the Jupiter path sends it.
   */
  aggregatorSends?(): Promise<boolean>;
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
  let seen = agg;
  let chosen = freshDecision(own, agg.kind === 'quoted' ? agg.out : null).chosen;
  // A quote whose transaction this site would refuse to send is no better route.
  if (chosen?.venue !== 'own-pool' && agg.kind === 'quoted' && agg.when === 'now' && deps.aggregatorSends && !(await deps.aggregatorSends())) {
    seen = { kind: 'refused' };
    chosen = freshDecision(own, null).chosen;
  }
  if (chosen?.venue !== 'own-pool' || !chosen.poolAddress) {
    // A figure from earlier is the last quote Jupiter gave, not an answer it gave now.
    return notBuilt(agg.kind === 'quoted' && agg.when === 'earlier' ? OWN_ROUTE_COPY.underLastQuote : OWN_ROUTE_COPY.routeMoved);
  }
  return deps.prepare(chosen.poolAddress, seen);
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
