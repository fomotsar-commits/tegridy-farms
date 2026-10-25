#!/usr/bin/env node
// The price keeper, WEEK 1: WATCH ONLY.
//
// Every interval it reads our BAYLA pools and pump.fun's BAYLA price, works out
// whether a correction would pay and how much it would make, and writes one line
// per pool to keeper/log/watch-<UTC date>.jsonl. It alerts the owner when a pool is
// 3% or more off, when the outside price jumps, when it cannot read for 10 minutes,
// when a fee tier stops paying the agreed split (venue to our vault, island to its
// Workshop), and when a pool is re-pointed. Once a day
// it sends the summary.
//
// It holds no key. It signs nothing and sends nothing: its RPC client refuses every
// method that writes (rpc.js), and test/watchOnly.test.mjs fails if any file it runs
// gains one of the known ways to sign or send.
//
//   node keeper/src/watch.js          watch until stopped (Ctrl+C)
//   node keeper/src/watch.js --once   one look, printed, nothing logged

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as C from './config.js';
import { makeRpc } from './rpc.js';
import { readPool } from './pool.js';
import { makeJupiter, venueNames, checkForcedRoute, checkHop } from './jupiter.js';
import { outsideFacts, judgePool } from './opportunity.js';
import { sizeCheck } from './sizecheck.js';
import { makeAlerter, makeGate } from './alert.js';
import { summarize, describe, readLogs } from './report.js';
import { clean } from './http.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const errText = (e) => clean(e instanceof Error ? e.message : String(e));
const OWN_POOLS = C.POOLS.map((p) => p.address);

/** Outside quotes, each one checked to have come through the route it asked for. */
export function makeQuoter(jupiter, names) {
  const forced = async (inputMint, outputMint, amount) => {
    const r = await jupiter.quote({ inputMint, outputMint, amount, dexes: [names.pump] });
    checkForcedRoute(r.steps, names);
    return r.out;
  };
  const hop = async (inputMint, outputMint, amount) => {
    const r = await jupiter.quote({ inputMint, outputMint, amount, excludeDexes: names.raydium });
    checkHop(r.steps, names, OWN_POOLS);
    return r.out;
  };
  return {
    pumpBuy: (lamports) => forced(C.SOL_MINT, C.BAYLA_MINT, lamports),
    pumpSell: (units) => forced(C.BAYLA_MINT, C.SOL_MINT, units),
    solToUsdc: (lamports) => hop(C.SOL_MINT, C.USDC_MINT, lamports),
    usdcToSol: (units) => hop(C.USDC_MINT, C.SOL_MINT, units),
  };
}

const COSTS = { baseFee: C.BASE_FEE_LAMPORTS, tip: C.TIP_LAMPORTS, minProfit: C.MIN_PROFIT_LAMPORTS };

/**
 * One look at every pool. Never throws: what it cannot read, it records as unread,
 * and an unread pool is never a pool with no gap. The fee-owner check needs only
 * the chain, so it is made and recorded even when Jupiter fails.
 */
export async function cycle(ctx) {
  const t = new Date(ctx.now()).toISOString();
  const rows = [];
  const money = new Map(); // pool name -> { leak, feeOwners }
  let bigMove = false;
  const unread = (pool, what, e) => ({
    t,
    pool: pool.name,
    coin: pool.coinSymbol,
    unread: true,
    what,
    detail: errText(e),
    ...(e?.code === 'REPOINTED' ? { repointed: true } : {}),
    ...(money.get(pool.name) ?? {}),
    ...(bigMove ? { bigMove } : {}),
  });

  const snaps = new Map();
  for (const pool of C.POOLS) {
    try {
      const snap = await readPool(ctx.rpc, pool.address, ctx.poolCache);
      snaps.set(pool.name, snap);
      // The agreed split: the venue's share to the vault, the island's share to its Workshop.
      const leak = snap.protocolOwner !== C.VENUE_VAULT || snap.fundOwner !== C.ISLAND_WORKSHOP;
      money.set(pool.name, { leak, ...(leak ? { feeOwners: { protocol: snap.protocolOwner, fund: snap.fundOwner } } : {}) });
    } catch (e) {
      rows.push(unread(pool, 'our pool', e));
    }
  }
  const watched = C.POOLS.filter((p) => snaps.has(p.name));
  if (watched.length === 0) return rows;

  if (!ctx.names || ctx.now() - ctx.namesAt > 86_400_000) {
    try {
      ctx.names = venueNames(await ctx.jupiter.labels());
      ctx.namesAt = ctx.now();
    } catch (e) {
      if (!ctx.names) {
        for (const pool of watched) rows.push(unread(pool, 'Jupiter’s venue list', e));
        return rows;
      }
    }
  }
  const quote = makeQuoter(ctx.jupiter, ctx.names);

  const first = snaps.get(watched[0].name);
  const tokenDecimals = first.mint0 === C.BAYLA_MINT ? first.decimals0 : first.decimals1;
  const probe = {};
  try {
    const b0 = await quote.pumpBuy(C.PROBE_LAMPORTS);
    const s0 = await quote.pumpSell(b0);
    probe.pumpBuy = { a: Number(C.PROBE_LAMPORTS), out: Number(b0) };
    probe.pumpSell = { a: Number(b0), out: Number(s0) };
  } catch (e) {
    for (const pool of watched) rows.push(unread(pool, 'BAYLA’s outside price', e));
    return rows;
  }
  let usdcError = null;
  const usdcPool = watched.find((p) => p.coinSymbol === 'USDC');
  let usdcDecimals = 6;
  if (usdcPool) {
    const s = snaps.get(usdcPool.name);
    usdcDecimals = s.mint0 === usdcPool.coin ? s.decimals0 : s.decimals1;
    try {
      const u0 = await quote.solToUsdc(C.SOL_USDC_PROBE_LAMPORTS);
      const s1 = await quote.usdcToSol(u0);
      probe.solToUsdc = { a: Number(C.SOL_USDC_PROBE_LAMPORTS), out: Number(u0) };
      probe.usdcToSol = { a: Number(u0), out: Number(s1) };
    } catch (e) {
      usdcError = e;
    }
  }
  let facts;
  try {
    facts = outsideFacts({ tokenDecimals, usdcDecimals, ...probe });
  } catch (e) {
    for (const pool of watched) rows.push(unread(pool, 'BAYLA’s outside price', e));
    return rows;
  }

  // A jump in the outside price: the live keeper pauses AND alerts, never skips quietly.
  ctx.history.push({ at: ctx.now(), mid: facts.pumpMid });
  while (ctx.history.length && ctx.now() - ctx.history[0].at > C.BIG_MOVE_WINDOW_MS) ctx.history.shift();
  bigMove = ctx.history.some((h) => Math.abs(facts.pumpMid / h.mid - 1) * 100 > C.BIG_MOVE_PCT);

  for (const pool of watched) {
    if (pool.coinSymbol === 'USDC' && (usdcError || !facts.solUsdcMid)) {
      rows.push(unread(pool, 'SOL’s price in USDC', usdcError ?? 'not read'));
      continue;
    }
    const snap = snaps.get(pool.name);
    let rec;
    try {
      rec = await judgePool({ pool, snap, facts, probe, quote, costs: COSTS });
    } catch (e) {
      rows.push(unread(pool, 'the correction size', e));
      continue;
    }
    rec = { t, coin: pool.coinSymbol, ...rec, ...money.get(pool.name), bigMove };
    if (bigMove && rec.wouldTrade) {
      // The live keeper would be paused here, so this look's profit is not counted.
      rec.wouldTrade = false;
      rec.paused = true;
      rec.reason = `paused: pump.fun's price moved more than ${C.BIG_MOVE_PCT}% within a minute (it would have made ${rec.confirmedProfit.toFixed(6)} ${pool.coinSymbol})`;
    }
    if (rec.wouldTrade) {
      if (ctx.env.jupiterApiKey && ctx.env.taker) {
        try {
          rec.size = await sizeCheck({ jupiter: ctx.jupiter, rpc: ctx.rpc, names: ctx.names, pool, snap, record: rec, taker: ctx.env.taker, ownPools: OWN_POOLS });
        } catch (e) {
          rec.size = { unread: errText(e) };
        }
      } else {
        rec.size = { notChecked: 'needs JUPITER_API_KEY and KEEPER_TAKER' };
      }
    }
    rows.push(rec);
  }
  return rows;
}

const fmt = (n) => (n >= 0.01 ? n.toFixed(4) : n.toExponential(4));

/** How far our price is from pump.fun's, said against pump.fun's price. */
export function sideOf(r) {
  const ratio = r.ourPrice / r.outsidePrice;
  return ratio <= 1
    ? `${((1 - ratio) * 100).toFixed(2)}% cheaper here than on pump.fun`
    : `${((ratio - 1) * 100).toFixed(2)}% dearer here than on pump.fun`;
}

export function line(r) {
  const flags = `${r.leak ? '  ** FEE OWNERS ARE NOT THE AGREED SPLIT **' : ''}${r.repointed ? '  ** POOL RE-POINTED **' : ''}${r.bigMove ? '  [pump.fun price jumped]' : ''}`;
  if (r.unread) return `${r.pool.padEnd(10)} UNREAD (${r.what}): ${r.detail}${flags}`;
  const g = `${r.gapPct >= 0 ? '+' : ''}${r.gapPct.toFixed(2)}%`;
  let s = `${r.pool.padEnd(10)} ours ${fmt(r.ourPrice)}  pump.fun ${fmt(r.outsidePrice)} ${r.coin}  gap ${g}  (a fix pays beyond ${r.breakEvenPct.toFixed(2)}%)`;
  if (r.wouldTrade) {
    const how = r.direction === 'buy-here-sell-outside' ? 'buy here, sell on pump.fun' : 'buy on pump.fun, sell here';
    s += `  -> WOULD FIX: ${how}, ${r.sizeIn} ${r.coin} in, makes ${r.confirmedProfit.toFixed(6)} ${r.coin}${r.capped ? ' (size cap: more fixes would follow)' : ''}`;
  } else if (r.direction) {
    s += `  -> no fix: ${r.reason}`;
  }
  if (r.size) {
    s += typeof r.size.bytes === 'number'
      ? `  [one transaction: ${r.size.bytes}/1232 bytes, ${r.size.accounts} accounts, ${r.size.fits && r.size.accountsOk ? 'fits' : 'DOES NOT FIT'}${r.size.upperBound ? `, upper bound (${r.size.standIns} stand-in account(s))` : ''}]`
      : `  [size ${r.size.unread ? `check failed: ${r.size.unread}` : `not checked: ${r.size.notChecked}`}]`;
  }
  return s + flags;
}

/** Decide which alerts this look earns, and send them. Money and jumps come first, even on an unread look. */
export async function alertsFor(rows, ctx) {
  for (const r of rows) {
    if (r.leak && ctx.gate(`leak:${r.pool}`)) {
      await ctx.alert(`MONEY: ${r.pool}'s fee tier no longer pays the agreed split, the venue's share to our vault and the island's to its Workshop (protocol owner ${r.feeOwners.protocol}, fund owner ${r.feeOwners.fund}).`);
    }
    if (r.repointed && ctx.gate(`repoint:${r.pool}`)) {
      await ctx.alert(`MONEY: ${r.pool} now names a different fee tier or vault than when the keeper started. Nothing of ours can do that. It stays unread until the keeper is restarted on purpose.`);
    }
    if (r.bigMove && ctx.gate('bigmove')) {
      await ctx.alert(`BAYLA's price on pump.fun moved more than ${C.BIG_MOVE_PCT}% within a minute. A live keeper would pause here and wait for you.`);
    }
    if (r.unread) {
      ctx.unreadSince[r.pool] ??= ctx.now();
      if (ctx.now() - ctx.unreadSince[r.pool] >= C.UNREAD_ALERT_MS && ctx.gate(`unread:${r.pool}`)) {
        await ctx.alert(`${r.pool}: the keeper has not been able to read for ${Math.round((ctx.now() - ctx.unreadSince[r.pool]) / 60_000)} minutes (${r.what}: ${r.detail}). Unread is not "no gap".`);
      }
      continue;
    }
    delete ctx.unreadSince[r.pool];
    if (Math.abs(r.gapPct) >= C.ALERT_GAP_PCT && ctx.gate(`gap:${r.pool}`, r.gapPct, 1)) {
      const fix = r.wouldTrade ? ` A correction would make about ${r.confirmedProfit.toFixed(6)} ${r.coin}.` : ` No correction counted: ${r.reason}.`;
      await ctx.alert(`${r.pool}: BAYLA is ${sideOf(r)} (a fix pays beyond a ${r.breakEvenPct.toFixed(2)}% gap).${fix}`);
    }
    if (r.size && typeof r.size.bytes === 'number' && !(r.size.fits && r.size.accountsOk) && ctx.gate(`size:${r.pool}`)) {
      const caveat = r.size.upperBound ? ` That is an upper bound (${r.size.standIns} account(s) counted as stand-ins, up to ${32 * r.size.standIns} bytes too high), so it MAY not fit.` : '';
      await ctx.alert(`${r.pool}: a correction measured ${r.size.bytes} of 1232 bytes and ${r.size.accounts} accounts.${caveat} If it really does not fit, going live needs a lookup table you create and sign.`);
    }
  }
}

function makeLog(dir) {
  mkdirSync(dir, { recursive: true });
  const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
  return (rows) => {
    for (const r of rows) {
      const file = join(dir, `watch-${r.t.slice(0, 10)}.jsonl`);
      appendFileSync(file, JSON.stringify(r, replacer) + '\n');
    }
  };
}

export function makeContext({ env, now = () => Date.now(), fetchImpl = fetch, jupiterGapMs, print } = {}) {
  const gateWith = makeGate({ cooldownMs: C.ALERT_COOLDOWN_MS, now });
  return {
    env,
    now,
    rpc: makeRpc(env.rpcUrl, { fetchImpl }),
    jupiter: makeJupiter({ apiKey: env.jupiterApiKey, fetchImpl, minGapMs: jupiterGapMs }),
    alert: makeAlerter({ token: env.telegramToken, chat: env.telegramChat, fetchImpl, print }),
    gate: gateWith,
    poolCache: new Map(),
    names: null,
    namesAt: 0,
    history: [],
    unreadSince: {},
    day: new Date(now()).toISOString().slice(0, 10),
  };
}

async function main() {
  const env = C.readEnv();
  const once = process.argv.includes('--once');
  const ctx = makeContext({ env });
  const logDir = env.logDir || join(HERE, '..', 'log');
  const log = once ? () => {} : makeLog(logDir);

  console.log('Price keeper, WATCH ONLY: it holds no key and signs or sends nothing.');
  console.log(`Watching ${C.POOLS.map((p) => p.name).join(' and ')} against pump.fun${once ? ', once' : ` every ${env.intervalMs / 1000} s; log in ${logDir}`}.`);
  console.log(`Jupiter: ${env.jupiterApiKey ? 'with your key' : 'keyless'}. Size check: ${env.jupiterApiKey && env.taker ? 'on' : 'off (needs JUPITER_API_KEY and KEEPER_TAKER)'}. Alerts: ${env.telegramToken && env.telegramChat ? 'Telegram and this window' : 'this window only'}.`);

  let stopping = false;
  let wake = null;
  let timer = null;
  const stop = () => {
    if (!stopping) console.log('Stopping after this look…');
    stopping = true;
    clearTimeout(timer);
    wake?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    while (!stopping) {
      const started = ctx.now();
      let rows = [];
      try {
        rows = await cycle(ctx);
      } catch (e) {
        console.log(`a look failed outright: ${errText(e)}`);
      }
      for (const r of rows) console.log(`${r.t.slice(11, 19)}  ${line(r)}`);
      try {
        log(rows);
      } catch (e) {
        // A full disk or a locked file must not end the watch: say so and carry on.
        if (ctx.gate('log')) await ctx.alert(`The keeper could not write its log (${errText(e)}). It is still watching.`);
      }
      if (once) break;
      await alertsFor(rows, ctx);

      const today = new Date(ctx.now()).toISOString().slice(0, 10);
      if (today !== ctx.day) {
        try {
          const day = readLogs(logDir, { day: ctx.day });
          if (day.length) await ctx.alert(`Keeper day ${ctx.day} (watch only):\n${describe(summarize(day))}`);
        } catch (e) {
          await ctx.alert(`The keeper could not read its log for the daily summary (${errText(e)}). It is still watching.`);
        }
        ctx.day = today;
      }

      if (stopping) break;
      const wait = Math.max(1_000, env.intervalMs - (ctx.now() - started));
      await new Promise((r) => {
        wake = r;
        timer = setTimeout(r, wait);
      });
    }
  } catch (e) {
    await ctx.alert(`The keeper has STOPPED: ${errText(e)}`).catch(() => {});
    throw e;
  }
  console.log('Stopped.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`keeper stopped: ${errText(e)}`);
    process.exit(1);
  });
}
