// A range pool's depth: the liquidity in use at each price, across the bands that were read.
//
// The pool account says how much liquidity is in use at its own price. Each used price (tick)
// in a band says how much that changes when the price crosses it (`liquidityNet`: added going
// up, taken away going down). Walking out from the pool's price over the bands `readBandsNear`
// returned gives the liquidity on every stretch between two used prices.
//
// What it covers is exactly the bands read, and no further: `from`/`to` say where the reading
// stops, and nothing is claimed past them. The bands read are neighbours in the pool's own
// map, so no used price can sit in a gap between two of them.
//
// Resting limit orders (a tick's `ordersAmount`) are not liquidity in use and are not counted.
import { tickCount } from './bitmap';
import type { PoolStateView, TickArrayView } from './program';

/** One stretch of prices with the same liquidity in use: ticks `from` (included) to `to` (not). */
export interface DepthStep {
  from: number;
  to: number;
  liquidity: bigint;
}

export interface DepthProfile {
  /** The ticks the reading covers: `from` included, `to` not. */
  from: number;
  to: number;
  /** Lowest price first, touching end to end across the whole of `from`..`to`. */
  steps: DepthStep[];
}

/**
 * The depth across `bands`, or null when no band was read (a pool nobody has a position in).
 * Throws when the bands and the pool disagree (liquidity would fall below zero): the caller
 * shows that as unread, never as a shape.
 */
export function depthProfile(pool: Pick<PoolStateView, 'liquidity' | 'tickCurrent' | 'tickSpacing'>, bands: Map<number, TickArrayView>): DepthProfile | null {
  if (bands.size === 0) return null;
  const starts = [...bands.keys()];
  const span = tickCount(pool.tickSpacing);
  const here = pool.tickCurrent;
  // The pool's own price is always inside the reading: the liquidity there is the pool's figure.
  const from = Math.min(here, ...starts);
  const to = Math.max(here + 1, ...starts.map((s) => s + span));

  const used = [...bands.values()]
    .flatMap((b) => b.ticks)
    .filter((t) => t.liquidityGross > 0n)
    .sort((a, b) => a.tick - b.tick);

  const steps: DepthStep[] = [];
  const push = (a: number, b: number, liquidity: bigint) => {
    if (liquidity < 0n) throw new Error('the bands read do not add up to the pool’s liquidity');
    if (b > a) steps.push({ from: a, to: b, liquidity });
  };

  // Up: a price above the pool's adds its net when crossed.
  let l = pool.liquidity;
  let edge = here;
  for (const t of used) {
    if (t.tick <= here) continue;
    push(edge, t.tick, l);
    l += t.liquidityNet;
    edge = t.tick;
  }
  push(edge, to, l);

  // Down: a price at or below the pool's was crossed going up, so going down takes its net away.
  l = pool.liquidity;
  edge = here;
  for (let i = used.length - 1; i >= 0; i--) {
    const t = used[i]!;
    if (t.tick > here) continue;
    push(t.tick, edge, l);
    l -= t.liquidityNet;
    edge = t.tick;
  }
  push(from, edge, l);

  steps.sort((a, b) => a.from - b.from);
  // Two stretches that touch and hold the same liquidity are one.
  const joined: DepthStep[] = [];
  for (const s of steps) {
    const last = joined[joined.length - 1];
    if (last && last.to === s.from && last.liquidity === s.liquidity) last.to = s.to;
    else joined.push({ ...s });
  }
  return { from, to, steps: joined };
}

/** The liquidity in use at `tick`, or null outside what was read. */
export function liquidityAt(profile: DepthProfile, tick: number): bigint | null {
  for (const s of profile.steps) if (tick >= s.from && tick < s.to) return s.liquidity;
  return null;
}
