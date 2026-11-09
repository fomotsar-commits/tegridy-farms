/**
 * The real-time engine's first stage (scripts/arb-listen.mjs): LISTEN ONLY. It holds no key and
 * sends nothing. It answers one question before any send is built: when the pools are watched
 * live, how many gaps clear the robot's floor, through which venues, and how long each stays open.
 */
import { DEXES, SOL_MINT, USDC_MINT } from './arb-chain.mjs';
import { JITO_LANDING_TIP_LAMPORTS, JITO_TIP_SHARE_PCT } from '../../src/lib/solana/keeper/jito.ts';

/** The venues whose swap the robot builds itself, with no Jupiter (keeper/directLegs.ts): x·y = k pools. */
export const DIRECT_DEXES = new Set(['ours', 'cpmm', 'pumpswap', 'ammV4']);

/**
 * The venues whose swap the robot builds for a trip the engine hands it (scripts/lib/arb-legs.mjs,
 * through keeper/engine.ts): the four above, and the band and bin venues priced to the unit.
 */
export const BUILDABLE_DEXES = new Set([...DIRECT_DEXES, 'whirlpool', 'clmm', 'dlmm', 'damm']);

/**
 * How long a handover stands: the robot acts on a record this young, measured from the judgement,
 * and discards anything older (the published practice: a stale route is a lost race, not a trade).
 */
export const HANDOVER_TTL_MS = 800;
/** A trip of more swaps than this is not handed over: the robot holds two coins mid-trip at most. */
export const HANDOVER_MAX_LEGS = 3;

/**
 * The record the engine hands the robot for one paying trip (owner 2026-11-07: "build it"): the
 * route in order with each leg's pool, venue, direction, fee and the accounts its exact quote
 * walked (tick or bin arrays, an Orca pool's Oracle, a CLMM pool's fee config and far-band map);
 * the size and what each leg pays at it, in raw units as decimal strings (the robot chains its
 * minimums from them); what it makes after every cost; the prices it was judged at; and when it
 * stops standing. Null when the trip does not pay after every cost, has too many legs, a leg the
 * robot cannot build, or no size. `ctx`: coin { mint, symbol, decimals }, slot, now, usd (mint →
 * USD), programOf (mint → its token program, or null), arraysOf (pool → the accounts read for it).
 */
export function handoverOf(t, ctx) {
  if (!t.paysAll || !(t.inRaw >= 1) || !Array.isArray(t.outs) || t.outs.length !== t.legs.length) return null;
  if (t.legs.length < 2 || t.legs.length > HANDOVER_MAX_LEGS) return null;
  if (!t.legs.every((l) => BUILDABLE_DEXES.has(l.dex))) return null;
  if (!t.outs.every((x) => Number.isFinite(x) && x >= 1)) return null;
  const mints = [...new Set(t.legs.flatMap((l) => [l.from, l.to]))];
  // The prices the robot's floor and cap need: the trip's coins, and always SOL (the network fee
  // and any tip are paid in it) and USDC.
  const priced = [...new Set([...mints, SOL_MINT, USDC_MINT])];
  const route = routeOf(t);
  return {
    id: `${route}@${ctx.slot}@${ctx.now}`,
    route,
    at: ctx.now,
    slot: ctx.slot,
    expiresAt: ctx.now + HANDOVER_TTL_MS,
    coin: t.coin,
    mint: ctx.coin.mint,
    symbol: ctx.coin.symbol,
    decimals: ctx.coin.decimals,
    legs: t.legs.map((l) => ({ pool: l.pool, dex: l.dex, from: l.from, to: l.to, fee: l.fee, inCut: l.inCut ?? 0, outCut: l.outCut ?? 0, accounts: ctx.arraysOf(l.pool) ?? [] })),
    inRaw: String(Math.floor(t.inRaw)),
    outs: t.outs.map((x) => String(Math.floor(x))),
    inUsd: t.inUsd,
    gainUsd: t.gainUsd,
    feeUsd: t.feeUsd,
    floorUsd: t.floorUsd,
    netUsd: t.netUsd,
    tipUsd: t.tipUsd,
    netAllUsd: t.netAllUsd,
    gapPct: t.gapPct,
    transferFeePct: t.transferFeePct ?? 0,
    mints: Object.fromEntries(mints.map((m) => [m, ctx.programOf(m)])),
    usd: Object.fromEntries(priced.filter((m) => ctx.usd.get(m) > 0).map((m) => [m, ctx.usd.get(m)])),
  };
}

/** Whether a handover still stands at `now`. */
export const handoverStands = (rec, now) => now < rec.expiresAt;

const plainText = (x, max) => (typeof x === 'string' ? x.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max) : null);

/**
 * What the robot says it did with a handover (POST /outcome from this computer): the record's id,
 * the robot's outcome word (keeper/cycle.ts Tried: sent, unsure, not-sent, test-failed,
 * test-checks, quote-short, …; or 'stale' when the record had stopped standing, 'skipped' with a
 * note), how long after the judgement it acted, and a note. Null when it is not that.
 */
export function outcomeOf(json) {
  if (!json || typeof json !== 'object') return null;
  const id = plainText(json.id, 240);
  const outcome = plainText(json.outcome, 40);
  if (!id || !outcome) return null;
  const ms = Number.isFinite(json.ms) && json.ms >= 0 ? Math.round(json.ms) : null;
  return { id, outcome, ms, note: plainText(json.note, 240) || null, route: id.split('@')[0] };
}

/** The robot's outcomes, the latest `max` kept whole and every one counted by its word. */
export class Outcomes {
  constructor(max = 200) {
    this.max = max;
    this.latest = [];
    this.byOutcome = new Map();
    this.actMs = [];
  }

  add(o, now) {
    this.latest.unshift({ ...o, at: now });
    if (this.latest.length > this.max) this.latest.length = this.max;
    this.byOutcome.set(o.outcome, (this.byOutcome.get(o.outcome) ?? 0) + 1);
    if (o.ms !== null) this.actMs.push(o.ms);
  }

  /** Each outcome word's count, how many came in all, and the median time from judgement to the robot's act. */
  counts() {
    return { total: [...this.byOutcome.values()].reduce((a, b) => a + b, 0), byOutcome: Object.fromEntries(this.byOutcome), medianActMs: median(this.actMs) };
  }
}

/**
 * The accounts that move a pool's price: a band pool's own account and its tick arrays; a pair or
 * bin pool's and its two vaults, and a bin pool's bin arrays. `arrays` are the array accounts the
 * listener read for the pool (lib/arb-venues.mjs), none until it has.
 */
export const accountsOf = (p) => (p.kind === 'band' ? [p.address, ...(p.arrays ?? [])] : [p.address, p.vaultA, p.vaultB, ...(p.arrays ?? [])]);

/**
 * The accounts worth a websocket subscription when they are scarce (a public host gives a few
 * hundred an IP). A Raydium CPMM, AMM v4 or our pool trades on its two vaults; its own account
 * holds only the fees it owes, which grow by a share of each swap's fee, so it is re-read now and
 * then instead (arb-listen.mjs). A PumpSwap pool's account holds a price adjustment and a band
 * pool's its price and in-band liquidity: those stay watched; a band pool's tick arrays change
 * only when liquidity is added or taken, so they are re-read now and then. A bin pool's bin
 * arrays change with every swap through them: watched.
 */
export const watchedOf = (p) => {
  if (p.kind === 'pair') return p.dex === 'pumpswap' ? accountsOf(p) : [p.vaultA, p.vaultB];
  // An adaptive-fee Orca pool's Oracle (`oracle`) moves with every swap, as its fee does: watched.
  if (p.kind === 'band') return [p.address, ...(p.oracle ? [p.oracle] : [])];
  return [p.address, ...(p.arrays ?? [])];
};

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
 * The coins one of OUR pools is listed under (arb-listen.mjs listFromMarkets): the coin it holds
 * that is neither a trip's coin (`coins`: SOL, USDC) nor a fixed pricing coin (`quotes`: BAYLA,
 * USDT); a pricing coin's own pool (BAYLA / SOL) is that coin's. A pool of two memecoins, which
 * the site's pairing coins allow (owner 2026-11-07: BOBO, SOY, BRAINLET, RIZZ; BIG BRAIN /
 * BRAINLET), is listed under BOTH: from each coin's side the other is reached through its own
 * deepest pool, so only both sides between them judge every route through it.
 */
export function ourPoolCoins(pool, coins, quotes) {
  const sides = [pool.mintA, pool.mintB];
  const plain = sides.filter((x) => !coins[x] && !quotes[x]);
  if (plain.length) return [...new Set(plain)];
  const other = sides.find((x) => !coins[x]);
  return other ? [other] : [];
}

/**
 * The memecoins to link to SOL or USDC (arb-listen.mjs linkMemeQuotes), `max` at most: every coin
 * one of OUR pools is priced in first (`ours`: the owner's pairing coins, SOY for BRAINLET / SOY,
 * however few pools use them), then the rest by how many pools are priced in each (`uses`),
 * most first. Without this, a coin only our pools use fell under the cut of 80 on 11-09.
 */
export function quotesToLink(uses, ours, max) {
  const byUse = (a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0);
  const first = [...ours].filter((q) => uses.has(q)).sort(byUse);
  const rest = [...uses.keys()].filter((q) => !ours.has(q)).sort(byUse);
  return [...first, ...rest].slice(0, max);
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
 * A gap that only a fresh HTTP read closed (scripts/arb-listen.mjs recheckOpenGaps): the
 * websocket held a price the chain did not show when read again, so how long it was there, if
 * ever, is unknown. 11-07 08:05Z: a '$278 W gap' (3,357%) closed this way; both pools agreed
 * within 0.6% and neither traded. Counted apart, never as money.
 */
export const closedByFreshRead = (g) => g.closedBy === 'a fresh read';

/**
 * Stage 0's answer from its gaps (GapBook records, or the listener's JSON lines): how many paid
 * after every cost, how long they stayed, and the money a sender reaching each one REACT_MS after
 * it opened would have found there. A gap still open (no `ms`) counts as lasting until `now`. One
 * open past SUSPECT_MS, or closed only by a fresh read (closedByFreshRead), is counted apart,
 * never as money. A gap gone within the slot it opened in was never there to take.
 */
export function stage0Report(gaps, now) {
  const rows = gaps.map((g) => ({ ...g, stillOpen: g.ms === undefined, ms: g.ms ?? now - g.openedAt }));
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const misread = rows.filter((g) => g.ms < SUSPECT_MS && closedByFreshRead(g));
  const real = rows.filter((g) => g.ms < SUSPECT_MS && !closedByFreshRead(g));
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
    suspect: rows.length - real.length - misread.length,
    misread: misread.length,
    misreadUsdAtOpen: sum(misread, (g) => Math.max(0, g.firstNetUsd)),
    stillOpen: rows.filter((g) => g.stillOpen).length,
    topCoins: [...byCoin.values()].sort((a, b) => b.usdAt1s - a.usdAt1s || b.gaps - a.gaps).slice(0, 15),
  };
}

/**
 * The robot's outcomes in the engine's log (its `outcome` lines, scripts/arb-listen.mjs POST
 * /outcome), tallied: how many handovers the robot answered, by outcome word, with the median
 * time from the judgement to the robot's act; and the share that died before a trip could land
 * (stale, or a test run that found the gap gone: test-failed, test-checks, quote-short). `since`
 * (ms): only outcomes from then on. That share is the number the scanner report says decides
 * whether a faster feed is worth paying for.
 */
export const DIED_OUTCOMES = new Set(['stale', 'test-failed', 'test-checks', 'quote-short']);
export function outcomesFromLog(lines, since = 0) {
  const tally = new Outcomes(0);
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.event !== 'outcome') continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || at < since) continue;
    const o = outcomeOf(e);
    if (o) tally.add(o, at);
  }
  const c = tally.counts();
  const died = [...DIED_OUTCOMES].reduce((n, k) => n + (c.byOutcome[k] ?? 0), 0);
  const landed = (c.byOutcome.sent ?? 0) + (c.byOutcome.unsure ?? 0) + (c.byOutcome['not-sent'] ?? 0);
  return { ...c, died, diedShare: c.total ? died / c.total : null, wouldLand: landed };
}

/**
 * The gaps in the listener's log (its JSON lines, oldest first): each gap's last record, its
 * `close` when it closed, else its `open` (still open when the log ends). A gap is its route and
 * the time it opened. `since` (ms): only gaps that opened from then on. Lines that are not JSON
 * are skipped (a line cut short by a stop).
 */
export function gapsFromLog(lines, since = 0) {
  const byGap = new Map();
  let firstAt = null;
  let lastAt = null;
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e?.event !== 'open' && e?.event !== 'close') || typeof e.route !== 'string' || !Number.isFinite(e.openedAt)) continue;
    const at = Date.parse(e.at);
    if (Number.isFinite(at)) lastAt = Math.max(lastAt ?? at, at);
    if (e.openedAt < since) continue;
    firstAt = Math.min(firstAt ?? e.openedAt, e.openedAt);
    const k = `${e.route}@${e.openedAt}`;
    if (e.event === 'close' || !byGap.has(k)) byGap.set(k, e);
  }
  const gaps = [...byGap.values()].map(({ event, at: _at, ...g }) => (event === 'open' ? { ...g, ms: undefined } : g));
  return { gaps, firstAt, lastAt };
}
