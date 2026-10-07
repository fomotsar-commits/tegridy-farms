import type { PoolView } from './poolFinder';
import { formatWhen } from './poolHealth';

/**
 * A pool's past, from what the finder already read for free: the price record the
 * program itself writes. `initialized` flips only inside the oracle's `update`, which
 * only a swap calls (states/oracle.rs, swap_base_input.rs), so it is the fact "a trade
 * has reached this pool", and `last_update_timestamp` is when the last one did. The fee
 * counters are never the source: a dust swap books a protocol fee of 0 and still flips
 * the record. The time is printed, never the word "active": a dust swap makes any dead
 * pool's record read minutes old.
 */

export type LastTrade = { kind: 'none' } | { kind: 'at'; time: bigint } | { kind: 'unread'; detail: string };

/** When the pool's last trade happened, from its own record; `none` before the first swap. */
export function lastTrade(view: PoolView): LastTrade {
  const h = view.history;
  if (h.kind === 'not-read') return { kind: 'unread', detail: 'not read yet' };
  if (h.kind === 'unread') return { kind: 'unread', detail: h.detail };
  const obs = h.obs;
  if (!obs.initialized) return { kind: 'none' };
  // The newest slot's own time stands in when `last_update_timestamp` is 0 (as ownPrice.ts reads it).
  const time = obs.lastUpdate > 0n ? obs.lastUpdate : obs.observations[obs.index]!.blockTimestamp;
  return { kind: 'at', time };
}

export const NO_TRADE_YET = 'No trade has reached this pool yet.';

export const lastTradeText = (t: LastTrade): string => {
  if (t.kind === 'none') return NO_TRADE_YET;
  if (t.kind === 'at') return `Last trade: ${formatWhen(t.time)}`;
  return `Its trade record could not be read (${t.detail}).`;
};
