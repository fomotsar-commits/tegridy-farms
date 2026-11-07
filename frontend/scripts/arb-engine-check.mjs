#!/usr/bin/env node
/**
 * The robot's own exact check of every trip the engine hands over, kept apart from the robot
 * (owner 2026-11-07: "count what survives the robot's own exact check"). Read-only: no key, no
 * signature, nothing sent. For each handover on the engine's /events it at once:
 *   - compares the engine's copy of every account the trip's legs name (its /accounts) with the
 *     chain's, read in one call: an account that differs while its pool has not traded is the
 *     engine's misread, not the market's move;
 *   - reads the legs as the robot does (lib/arb-legs.mjs routeLegReader, at 'confirmed') and
 *     quotes each leg on the engine's own input for it, and the whole trip chained;
 *   - counts the trip as surviving when the robot's chained amount still pays after the costs
 *     the engine counted (its gain less its net after every cost: fees, network fee, tip, floor).
 * The robot itself (KEEPER_ENGINE_URL) skips a trip that would open two new token accounts before
 * it quotes; this checks every trip regardless. One JSON line a handover.
 *
 *   node scripts/arb-engine-check.mjs [minutes]       follow the engine (forever by default)
 *   node scripts/arb-engine-check.mjs --report <file> [--since <ISO time>]
 *
 * Settings: ARB_ENGINE_URL (http://127.0.0.1:8798), ARB_CHECK_RPC_URL (public mainnet),
 * ARB_CHECK_LOG (one line a handover; default in the system's temp folder).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { PublicKey } from '@solana/web3.js';

const args = process.argv.slice(2);
// A leg the robot prices this far under the engine is a disagreement worth explaining.
const DIFF_PCT = 0.05;
if (args[0] === '--report') {
  report(args[1], args.includes('--since') ? Date.parse(args[args.indexOf('--since') + 1]) : 0);
  process.exit(0);
}

const loaderSource = `
import { stripTypeScriptTypes } from 'node:module';
export async function resolve(specifier, context, nextResolve) {
  const relative = specifier[0] === '.';
  const hasExt = /\\.[cm]?[jt]sx?$/.test(specifier);
  if (!relative || hasExt) return nextResolve(specifier, context);
  try {
    return await nextResolve(specifier + '.ts', context);
  } catch {
    return nextResolve(specifier + '.js', context);
  }
}
export async function load(url, context, nextLoad) {
  if (!/\\.tsx?$/.test(new URL(url).pathname)) return nextLoad(url, context);
  const r = await nextLoad(url, { ...context, format: 'module' });
  const src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
  return { ...r, format: 'module', source: 'import.meta.env ??= {};' + stripTypeScriptTypes(src, { mode: 'strip' }) };
}
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = await import(pathToFileURL(path.join(HERE, 'lib', 'arb-chain.mjs')).href);
const LEGS = await import(pathToFileURL(path.join(HERE, 'lib', 'arb-legs.mjs')).href);
const RAY = await import(pathToFileURL(path.join(HERE, 'lib', 'raydium-programs.mjs')).href);

const ENGINE = process.env.ARB_ENGINE_URL?.trim() || 'http://127.0.0.1:8798';
const RPC = process.env.ARB_CHECK_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const LOG = process.env.ARB_CHECK_LOG?.trim() || path.join(os.tmpdir(), 'arb-engine-check.jsonl');
const MINUTES = Number(args[0]) || Infinity;
const WALLET = new PublicKey(C.ROBOT.wallet);
const ids = { cpmm: RAY.RAYDIUM_CPMM, ammV4: RAY.RAYDIUM_AMM_V4, ammV4Authority: RAY.RAYDIUM_AMM_V4_AUTHORITY, clmm: RAY.RAYDIUM_CLMM };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(`${new Date().toISOString()}  ${line}`);
let last = 0;
async function rpc(method, params) {
  for (let tries = 0; ; tries++) {
    const wait = last + 250 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    if (r.status === 429 && tries < 4) {
      await sleep(2_000);
      continue;
    }
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${String(j.error.message ?? j.error.code).slice(0, 160)}`);
    return j.result;
  }
}
const sha = (b64) => (b64 ? createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16) : null);
const pctOf = (a, b) => (b > 0 ? (Number(a) / Number(b) - 1) * 100 : null);

/** The engine's copy of `keys` against the chain's, read at once. */
async function compare(keys) {
  const [held, chain] = await Promise.all([
    fetch(`${ENGINE}/accounts?k=${keys.join(',')}`, { signal: AbortSignal.timeout(5_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    rpc('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed' }]),
  ]);
  const differ = held ? keys.map((k, i) => ({ k, e: held.accounts[k], c: sha(chain.value[i]?.data?.[0]) })).filter((x) => !x.e || x.e.sha !== x.c).map((x) => ({ account: x.k, engineSlot: x.e?.slot ?? null, live: x.e?.live ?? null, unwatched: x.e?.unwatched ?? null })) : null;
  return { engineSlot: held?.slot ?? null, chainSlot: chain.context.slot, differ, data: chain.value };
}

async function check(rec, gotAt) {
  const keys = [...new Set(rec.legs.flatMap((l) => [l.pool, ...l.accounts]))].slice(0, 40);
  const first = await compare(keys);
  const vaults = [];
  for (const l of rec.legs) {
    const d = first.data[keys.indexOf(l.pool)]?.data?.[0];
    const p = d && C.decodePool(l.dex, l.pool, Buffer.from(d, 'base64'));
    if (p && p.kind === 'pair') vaults.push(p.vaultA, p.vaultB);
  }
  const second = vaults.length ? await compare(vaults) : null;
  const differ = first.differ && [...first.differ, ...(second?.differ ?? [])];
  const built = await LEGS.routeLegReader({ rpc, ids })(rec, WALLET, Math.floor(Date.now() / 1000));
  const row = { at: new Date().toISOString(), id: rec.id, route: rec.route, symbol: rec.symbol, coin: rec.coin, legs: rec.legs.length, dexes: rec.legs.map((l) => l.dex), gapPct: rec.gapPct, inRaw: rec.inRaw, engineOut: rec.outs.at(-1), engineNetUsd: rec.netAllUsd, engineSlot: rec.slot, gotMs: gotAt - rec.at, chainSlot: first.chainSlot, differ };
  if (typeof built === 'string') return { ...row, robot: built };
  // Each leg on the engine's own input for it, and the trip chained as the robot runs it.
  const ins = [BigInt(rec.inRaw), ...rec.outs.slice(0, -1).map(BigInt)];
  row.legQuotes = built.legs.map((l, i) => {
    const out = l.out(ins[i]);
    return { pool: l.pool, dex: l.dex, engineOut: rec.outs[i], robotOut: out === null ? null : String(out), diffPct: out === null ? null : pctOf(out, BigInt(rec.outs[i])) };
  });
  let flow = BigInt(rec.inRaw);
  for (const l of built.legs) flow = flow === null ? null : l.out(flow);
  row.robotOut = flow === null ? null : String(flow);
  row.readSlot = built.slot;
  const coin = C.COINS[rec.coin];
  const usd = rec.usd?.[rec.coin];
  if (flow !== null && coin && usd > 0) {
    // The robot's amount, less the costs the engine counted (its gain less its net after every cost).
    const gainUsd = (Number(flow - BigInt(rec.inRaw)) / 10 ** coin.decimals) * usd;
    row.robotNetUsd = gainUsd - (rec.gainUsd - rec.netAllUsd);
    row.survives = row.robotNetUsd > 0;
  }
  // A leg the robot prices under the engine: did its pool trade between the engine's slot and the robot's read?
  for (const q of row.legQuotes) {
    if (!(q.diffPct < -DIFF_PCT)) continue;
    const sigs = await rpc('getSignaturesForAddress', [q.pool, { limit: 10, commitment: 'confirmed' }]);
    q.tradedSince = sigs.some((s) => !s.err && s.slot > rec.slot && s.slot <= built.slot);
  }
  return row;
}

function report(file, since) {
  if (!file) {
    console.error('usage: node scripts/arb-engine-check.mjs --report <file> [--since <ISO time>]');
    process.exit(2);
  }
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter((r) => r && Date.parse(r.at) >= since);
  const quoted = rows.filter((r) => r.robotOut !== undefined && r.robotOut !== null);
  const survived = quoted.filter((r) => r.survives);
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const legs = quoted.flatMap((r) => r.legQuotes ?? []);
  const under = legs.filter((q) => q.diffPct < -DIFF_PCT);
  const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const hours = rows.length ? (Date.parse(rows.at(-1).at) - Date.parse(rows[0].at)) / 3_600_000 : 0;
  console.log(`Handovers checked: ${rows.length} over ${hours.toFixed(1)} h; quoted by the robot's own maths: ${quoted.length} (the rest: ${rows.length - quoted.length}, the robot's reader refused them).`);
  console.log(`Survived the robot's exact check (still paid after the engine's own costs): ${survived.length}, worth $${sum(survived, (r) => r.robotNetUsd).toFixed(2)} if every one had landed.`);
  for (const n of [2, 3]) {
    const xs = quoted.filter((r) => r.legs === n);
    const ok = xs.filter((r) => r.survives);
    if (xs.length) console.log(`  ${n} swaps: ${xs.length} quoted, ${ok.length} survived ($${sum(ok, (r) => r.robotNetUsd).toFixed(2)})`);
  }
  // The same gap handed over again and again (nobody else takes it) is ONE gap: a route's survivors
  // in a run, none more than RUN_GAP_MS after the one before and no failed check between, count
  // once, at their best (taking it closes it; it may form again later, a new run).
  const RUN_GAP_MS = 120_000;
  const runs = [];
  const byRoute = new Map();
  for (const r of quoted) byRoute.set(r.route, [...(byRoute.get(r.route) ?? []), r]);
  for (const xs of byRoute.values()) {
    let run = null;
    for (const r of xs) {
      const t = Date.parse(r.at);
      if (r.survives && run && t - run.last <= RUN_GAP_MS) {
        Object.assign(run, { last: t, best: Math.max(run.best, r.robotNetUsd), n: run.n + 1 });
        continue;
      }
      if (run) runs.push(run);
      run = r.survives ? { route: r.route, symbol: r.symbol, dexes: r.dexes, first: t, last: t, best: r.robotNetUsd, n: 1 } : null;
    }
    if (run) runs.push(run);
  }
  console.log(`As distinct gaps (a route's survivors in a run, none ${RUN_GAP_MS / 1000} s apart, taken once at their best): ${runs.length} on ${new Set(runs.map((x) => x.route)).size} routes, worth $${sum(runs, (x) => x.best).toFixed(2)}.`);
  for (const x of [...runs].sort((a, b) => b.best - a.best).slice(0, 8)) console.log(`  ${new Date(x.first).toISOString().slice(0, 19)}Z ${String(x.symbol).padEnd(12)} ${x.dexes.join(' > ').padEnd(30)} +$${x.best.toFixed(4)}, handed over ${x.n} times over ${((x.last - x.first) / 60_000).toFixed(1)} min`);
  console.log(`Legs: ${legs.length}; the robot priced ${under.length} more than ${DIFF_PCT}% under the engine (median ${median(under.map((q) => q.diffPct))?.toFixed(3) ?? '-'}%): ${under.filter((q) => q.tradedSince).length} of those pools traded between the engine's slot and the robot's read (the market moved), ${under.filter((q) => q.tradedSince === false).length} did not (the engine's copy was off).`);
  const differs = rows.filter((r) => r.differ?.length);
  console.log(`Handovers where an account the engine held differed from the chain's at once: ${differs.length} of ${rows.filter((r) => r.differ).length} compared; accounts not kept fresh by a subscription among them: ${differs.flatMap((r) => r.differ).filter((d) => d.live === false).length}.`);
  const best = [...survived].sort((a, b) => b.robotNetUsd - a.robotNetUsd).slice(0, 10);
  if (best.length) console.log('Best survivors:');
  for (const r of best) console.log(`  ${r.at.slice(0, 19)}Z ${String(r.symbol).padEnd(12)} ${r.dexes.join(' > ').padEnd(30)} +$${r.robotNetUsd.toFixed(4)} (engine said +$${r.engineNetUsd.toFixed(4)})`);
}

log(`following ${ENGINE}/events${Number.isFinite(MINUTES) ? ` for ${MINUTES} min` : ''}; one line a handover to ${LOG}; this process sends nothing`);
if (Number.isFinite(MINUTES)) setTimeout(() => process.exit(0), MINUTES * 60_000);
const queue = [];
let busy = false;
const lastByRoute = new Map();
async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const [rec, gotAt] = queue.shift();
    // A handover that waited behind others is checked anyway: its row says how late (gotMs, chainSlot).
    try {
      const row = await check(rec, gotAt);
      fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
      const lq = (row.legQuotes ?? []).map((q) => `${q.dex} ${q.diffPct === null ? 'no quote' : `${q.diffPct.toFixed(3)}%`}${q.tradedSince === undefined ? '' : q.tradedSince ? ' (traded since)' : ' (did not trade)'}`).join(', ');
      log(`${row.symbol} ${row.dexes.join('>')}: ${row.robot ?? `robot ${row.robotOut} vs engine ${row.engineOut}${row.survives === undefined ? '' : row.survives ? `, SURVIVES +$${row.robotNetUsd.toFixed(4)}` : `, dies ($${row.robotNetUsd.toFixed(4)})`}; legs ${lq}`}${row.differ?.length ? `; engine copy differed: ${row.differ.map((d) => `${d.account.slice(0, 6)}${d.live === false ? ' (not live)' : ''}`).join(', ')}` : ''}`);
    } catch (e) {
      log(`${rec.symbol}: ${e.message}`);
    }
  }
  busy = false;
}

async function follow() {
  for (;;) {
    try {
      const res = await fetch(`${ENGINE}/events`);
      const dec = new TextDecoder();
      let rest = '';
      for await (const chunk of res.body) {
        rest += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        for (;;) {
          const end = rest.indexOf('\n\n');
          if (end < 0) break;
          const block = rest.slice(0, end);
          rest = rest.slice(end + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          let rec = null;
          try {
            rec = data ? JSON.parse(data) : null;
          } catch {
            continue;
          }
          if (!rec?.legs || Date.now() - rec.at > 2_000) continue;
          // One check a route every 20 s: the same gap judged again says nothing new.
          if (Date.now() - (lastByRoute.get(rec.route) ?? 0) < 20_000) continue;
          lastByRoute.set(rec.route, Date.now());
          queue.push([rec, Date.now()]);
          drain();
        }
      }
    } catch (e) {
      log(`the engine's stream: ${e.message}`);
    }
    await sleep(5_000);
  }
}
await follow();
