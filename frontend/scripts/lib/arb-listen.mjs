/**
 * The real-time engine's first stage (scripts/arb-listen.mjs): LISTEN ONLY. It holds no key and
 * sends nothing. It answers one question before any send is built: when the pools are watched
 * live, how many gaps clear the robot's floor, through which venues, and how long each stays open.
 */
import { DEXES } from './arb-chain.mjs';
import { JITO_LANDING_TIP_LAMPORTS, JITO_TIP_SHARE_PCT } from '../../src/lib/solana/keeper/jito.ts';

/** The venues whose swap the robot builds itself, with no Jupiter (keeper/directLegs.ts): x·y = k pools. */
export const DIRECT_DEXES = new Set(['ours', 'cpmm', 'pumpswap', 'ammV4']);

/** The accounts that move a pool's price: a band pool's own account; a pair or bin pool's and its two vaults. */
export const accountsOf = (p) => (p.kind === 'band' ? [p.address] : [p.address, p.vaultA, p.vaultB]);

/**
 * The accounts worth a websocket subscription when they are scarce (a public host gives a few
 * hundred an IP). A Raydium CPMM, AMM v4 or our pool trades on its two vaults; its own account
 * holds only the fees it owes, which grow by a share of each swap's fee, so it is re-read now and
 * then instead (arb-listen.mjs). A PumpSwap pool's account holds a price adjustment and a band
 * pool's its price: those stay watched.
 */
export const watchedOf = (p) => (p.kind === 'pair' && p.dex !== 'pumpswap' ? [p.vaultA, p.vaultB] : accountsOf(p));

/**
 * A trip's money after EVERY cost a send pays (Stage 0, owner 2026-11-07: arbs "that are actually
 * profitable"). Its gain already has the pools' fees and any transfer fee taken off (arb-chain.mjs
 * tripsFor); the robot's rule adds the network fee and its floor; on top comes the Jito tip a race
 * needs: JITO_TIP_SHARE_PCT of the gain, never under JITO_LANDING_TIP_LAMPORTS (smaller tips
 * landed 0 of 32, keeper/jito.ts). `paysAll`: the gain less the tip still clears the floor.
 * No SOL price: no tip can be priced, and nothing pays.
 */
export function afterCosts(t, solUsd) {
  const leastTipUsd = (Number(JITO_LANDING_TIP_LAMPORTS) / 1e9) * solUsd;
  const tipUsd = Math.max(leastTipUsd, (t.gainUsd * Number(JITO_TIP_SHARE_PCT)) / 100);
  const netAllUsd = t.gainUsd - t.feeUsd - tipUsd;
  const paysAll = t.inRaw > 0 && Number.isFinite(netAllUsd) && t.gainUsd - tipUsd >= t.floorUsd;
  return { tipUsd, netAllUsd, paysAll };
}

/** How soon after a gap opens a sender could reach it: from a home PC on a public websocket, about 1 to 3 s. */
export const REACT_MS = Object.freeze([1_000, 3_000]);

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
  /**
   * `pays` and `net` say which trips count as a gap and what one makes: by default the robot's
   * rule (its floor and the network fee); Stage 0 counts only what pays after every cost
   * (`afterCosts`: paysAll, netAllUsd).
   */
  constructor({ pays = (t) => t.pays, net = (t) => t.netUsd } = {}) {
    this.open = new Map();
    this.done = [];
    this.pays = pays;
    this.net = net;
  }

  seen(coin, trips, slot, now) {
    const paying = new Map(trips.filter((t) => this.pays(t)).map((t) => [routeOf(t), t]));
    const opened = [];
    const closed = [];
    for (const [route, t] of paying) {
      const g = this.open.get(route);
      const net = this.net(t);
      if (g) {
        g.lastSlot = slot;
        g.lastNetUsd = net;
        // What a sender reaching it REACT_MS after it opened would find: the newest judgement before then.
        for (const ms of REACT_MS) if (now - g.openedAt < ms) g.netBy[ms] = net;
        if (net > g.bestNetUsd) Object.assign(g, { bestNetUsd: net, bestInUsd: t.inUsd });
        continue;
      }
      const fresh = {
        route, coin, venues: venuesOf(t), dexes: t.legs.map((l) => l.dex),
        direct: t.legs.every((l) => DIRECT_DEXES.has(l.dex)), rough: t.legs.some((l) => l.rough), robotTakes: Boolean(t.robotTakes),
        openedSlot: slot, openedAt: now, lastSlot: slot, gapPct: t.gapPct, firstNetUsd: net, bestNetUsd: net, bestInUsd: t.inUsd, lastNetUsd: net,
        firstInUsd: t.inUsd, tipUsd: t.tipUsd ?? null, gapNetUsd: t.gapNetUsd ?? null, transferFeePct: t.transferFeePct ?? 0,
        netBy: Object.fromEntries(REACT_MS.map((ms) => [ms, net])),
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

/**
 * The coins of the chain-wide map (scripts/arb-map.mjs, its arb-map.json): each coin with two or
 * more pools deep enough, and those pools, in the map's order. Only the venues the robot prices to
 * the unit and swaps itself (DIRECT_DEXES): bin and band pools read as x·y = k made the fake gaps
 * of 11-06. `max`: the most coins kept.
 */
export function coinsFromMap(map, { max = Infinity } = {}) {
  const rows = Array.isArray(map?.rows) ? map.rows : [];
  const out = [];
  for (const r of rows) {
    if (out.length >= max) break;
    if (typeof r?.mint !== 'string' || !Array.isArray(r.pools)) continue;
    const pools = r.pools.filter((p) => typeof p?.address === 'string' && DIRECT_DEXES.has(p.dex)).map((p) => ({ address: p.address, dex: p.dex }));
    if (pools.length < 2) continue;
    out.push({ mint: r.mint, symbol: typeof r.symbol === 'string' ? r.symbol.slice(0, 16) : '?', pools });
  }
  return out;
}

/** A gap open this long was not left by every other robot: it is a misread (11-06: DLMM, quiet pools). */
export const SUSPECT_MS = 10 * 60_000;

/**
 * Stage 0's answer from its gaps (GapBook records, or the listener's JSON lines): how many paid
 * after every cost, how long they stayed, and the money a sender reaching each one REACT_MS after
 * it opened would have found there. A gap still open (no `ms`) counts as lasting until `now`. One
 * open past SUSPECT_MS is counted apart, never as money. A gap gone within the slot it opened in
 * was never there to take.
 */
export function stage0Report(gaps, now) {
  const rows = gaps.map((g) => ({ ...g, stillOpen: g.ms === undefined, ms: g.ms ?? now - g.openedAt }));
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const real = rows.filter((g) => g.ms < SUSPECT_MS);
  const sameSlot = (g) => !g.stillOpen && g.slots <= 0;
  const reached = (g, ms) => g.ms >= ms && !sameSlot(g);
  const at = (g, ms) => Math.max(0, g.netBy?.[ms] ?? g.firstNetUsd);
  const reach = Object.fromEntries(REACT_MS.map((ms) => {
    const xs = real.filter((g) => reached(g, ms));
    return [ms, { gaps: xs.length, usd: sum(xs, (g) => at(g, ms)) }];
  }));
  const byCoin = new Map();
  for (const g of real) {
    const x = byCoin.get(g.coin) ?? { coin: g.coin, symbol: g.symbol ?? null, gaps: 0, reached1s: 0, usdAt1s: 0, bestNetUsd: -Infinity };
    x.gaps++;
    if (reached(g, REACT_MS[0])) {
      x.reached1s++;
      x.usdAt1s += at(g, REACT_MS[0]);
    }
    x.bestNetUsd = Math.max(x.bestNetUsd, g.bestNetUsd);
    byCoin.set(g.coin, x);
  }
  return {
    gaps: real.length,
    sameSlot: real.filter(sameSlot).length,
    goneBeforeReach: real.filter((g) => !reached(g, REACT_MS[0])).length,
    reach,
    usdIfEveryOneTakenAtOpen: sum(real, (g) => Math.max(0, g.firstNetUsd)),
    suspect: rows.length - real.length,
    stillOpen: rows.filter((g) => g.stillOpen).length,
    topCoins: [...byCoin.values()].sort((a, b) => b.usdAt1s - a.usdAt1s || b.gaps - a.gaps).slice(0, 15),
  };
}
