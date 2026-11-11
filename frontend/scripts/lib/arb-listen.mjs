/**
 * The real-time engine's first stage (scripts/arb-listen.mjs): LISTEN ONLY. It holds no key and
 * sends nothing. It answers one question before any send is built: when the pools are watched
 * live, how many gaps clear the robot's floor, through which venues, and how long each stays open.
 */
import { DEXES } from './arb-chain.mjs';

/** The venues whose swap the robot builds itself, with no Jupiter (keeper/directLegs.ts): x·y = k pools. */
export const DIRECT_DEXES = new Set(['ours', 'cpmm', 'pumpswap', 'ammV4']);

/** The accounts that move a pool's price: a band pool's own account; a pair or bin pool's and its two vaults. */
export const accountsOf = (p) => (p.kind === 'band' ? [p.address] : [p.address, p.vaultA, p.vaultB]);

export const routeOf = (t) => t.legs.map((l) => l.pool).join('>');
export const venuesOf = (t) => t.legs.map((l) => DEXES[l.dex]?.name ?? l.dex).join(' > ');

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Gaps that clear the robot's floor, as they open and close. `seen` takes ONE coin's trips, judged
 * at one slot: a paying trip not open yet opens; an open trip of that coin that no longer pays
 * closes, with how long it stayed open, in ms and in slots. A gap that closes in the slot it
 * opened in was never there to take (two vault updates of one swap arriving apart, say).
 */
export class GapBook {
  constructor() {
    this.open = new Map();
    this.done = [];
  }

  seen(coin, trips, slot, now) {
    const paying = new Map(trips.filter((t) => t.pays).map((t) => [routeOf(t), t]));
    const opened = [];
    const closed = [];
    for (const [route, t] of paying) {
      const g = this.open.get(route);
      if (g) {
        g.lastSlot = slot;
        if (t.netUsd > g.bestNetUsd) Object.assign(g, { bestNetUsd: t.netUsd, bestInUsd: t.inUsd });
        continue;
      }
      const fresh = {
        route, coin, venues: venuesOf(t), dexes: t.legs.map((l) => l.dex),
        direct: t.legs.every((l) => DIRECT_DEXES.has(l.dex)), rough: t.legs.some((l) => l.rough), robotTakes: Boolean(t.robotTakes),
        openedSlot: slot, openedAt: now, lastSlot: slot, gapPct: t.gapPct, firstNetUsd: t.netUsd, bestNetUsd: t.netUsd, bestInUsd: t.inUsd,
      };
      this.open.set(route, fresh);
      opened.push(fresh);
    }
    for (const [route, g] of this.open) {
      if (g.coin !== coin || paying.has(route)) continue;
      this.open.delete(route);
      const done = { ...g, closedSlot: slot, closedAt: now, ms: now - g.openedAt, slots: slot - g.openedSlot };
      this.done.push(done);
      closed.push(done);
    }
    return { opened, closed };
  }

  /**
   * Every gap so far, grouped by `keyOf` (default: its venues in order): how many opened, how many
   * were gone within their slot, how long the rest stayed open (median and longest, closed ones),
   * how many are open now, and the best net any made.
   */
  counts(now, keyOf = (g) => g.venues) {
    const groups = new Map();
    const add = (g, isOpen) => {
      for (const k of [keyOf(g)].flat()) {
        const x = groups.get(k) ?? { key: k, opened: 0, sameSlot: 0, closedMs: [], closedSlots: [], openNow: 0, oldestOpenMs: 0, bestNetUsd: -Infinity, direct: 0, rough: 0, robotTakes: 0 };
        x.opened++;
        if (isOpen) {
          x.openNow++;
          x.oldestOpenMs = Math.max(x.oldestOpenMs, now - g.openedAt);
        } else if (g.slots <= 0) x.sameSlot++;
        else {
          x.closedMs.push(g.ms);
          x.closedSlots.push(g.slots);
        }
        x.bestNetUsd = Math.max(x.bestNetUsd, g.bestNetUsd);
        x.direct += Number(g.direct);
        x.rough += Number(g.rough);
        x.robotTakes += Number(g.robotTakes);
        groups.set(k, x);
      }
    };
    this.done.forEach((g) => add(g, false));
    this.open.forEach((g) => add(g, true));
    return [...groups.values()]
      .map(({ closedMs, closedSlots, ...x }) => ({ ...x, closed: closedMs.length, medianMs: median(closedMs), longestMs: closedMs.length ? Math.max(...closedMs) : null, medianSlots: median(closedSlots) }))
      .sort((a, b) => b.opened - a.opened);
  }
}

/** Each venue on its own: a gap counts once under every venue it passes through. */
export const byEachVenue = (g) => [...new Set(g.dexes.map((d) => DEXES[d]?.name ?? d))];

/**
 * Which coins a changed account moves: every account of a coin's pools and of the pools linking
 * its pricing coins. `coins` is [{ mint, pools, links }].
 */
export function coinsByAccount(coins) {
  const out = new Map();
  for (const c of coins) {
    for (const a of [...c.pools, ...(c.links ?? [])].flatMap(accountsOf)) {
      const set = out.get(a) ?? new Set();
      set.add(c.mint);
      out.set(a, set);
    }
  }
  return out;
}
