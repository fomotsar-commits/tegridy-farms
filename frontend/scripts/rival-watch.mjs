#!/usr/bin/env node
/**
 * Who traded in our pools, and how (lib/rival-watch.mjs). Read-only: it holds no key and sends
 * nothing; it reads a public RPC slowly.
 *
 *   node scripts/rival-watch.mjs [--hours 24] [--out rival-watch.json]
 *       once: one line a payer (the robot, users, bots), biggest take first, and every row written.
 *
 *   node scripts/rival-watch.mjs --watch [--every 300] [--hours 24] [--state FILE] [--log FILE] [--rounds N]
 *       the sentinel: every --every seconds it reads what is new in our pools and SAYS, one line each:
 *         - a bot that traded past the guard (our program at the top level beside a loan, an
 *           aggregator or another exchange: Cn8LrZZn… did, 2026-11-14 05:57Z), and what its wallet gained
 *         - a trade from inside a bot's own program that LANDED (the guard off, or passed)
 *         - a wallet never seen before; one wallet making many plain swaps; the guard's refusals
 *       --state: what it remembers of every wallet (default rival-watch-state.json; a page can read it)
 *       --log:   one line a transaction (default rival-watch-log.jsonl)
 *       The first round reads the last --hours and only remembers them: it says nothing of wallets
 *       it meets then, except bots past the guard.
 *
 * RIVAL_WATCH_RPC_URL: the RPC it reads (default the public mainnet one, which the robot reads too:
 * for --watch name another, e.g. https://solana-rpc.publicnode.com, so the two never share an allowance).
 */
import fs from 'node:fs';
import { register } from 'node:module';
import { base58 } from '@scure/base';
import { RAYDIUM_PROGRAMS } from './lib/raydium-programs.mjs';
import { OUTSIDE_DEX_PROGRAMS } from './lib/outside-dexes.mjs';
import { KNOWN_WALLETS, alertsFor, foldSentinel, howCalled, kindOf, payerSolChange, refusedByGuard, summarize } from './lib/rival-watch.mjs';

// The robot's TS modules load through its loader (scripts/price-keeper.mjs, arb-scanner.mjs).
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
const { DEXES, ROBOT } = await import('./lib/arb-chain.mjs');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);
const HOURS = Number(arg('hours', 24));
const OUT = arg('out', 'rival-watch.json');
const RPC = process.env.RIVAL_WATCH_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const OURS = DEXES.ours.program;
const NAMES = { [ROBOT.wallet]: 'our robot', ...KNOWN_WALLETS };
const exchanges = new Set([...Object.values(DEXES).map((d) => d.program).filter((p) => p !== OURS), ...RAYDIUM_PROGRAMS, ...Object.values(OUTSIDE_DEX_PROGRAMS), 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4']);
const ctx = { ours: OURS, robot: ROBOT.wallet, exchanges, decode: (data) => base58.decode(data) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params, url = RPC) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      if (r.status === 429 && i < 20) {
        await sleep(3_000);
        continue;
      }
      const j = await r.json();
      if (j.error?.code === 429 && i < 20) {
        await sleep(5_000);
        continue;
      }
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    } catch (e) {
      if (i >= 5) throw e;
      await sleep(3_000);
    }
  }
}

/**
 * Our pools: every account of our program of a pool's size. Some public RPCs refuse this one call
 * (publicnode, 2026-11-14: "Indexed requests require a personal token"); then the public mainnet
 * RPC is asked, this call alone (once at the start, and once an hour under --watch).
 */
const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';
const ourPools = async () => {
  const params = [OURS, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: DEXES.ours.size }] }];
  const list = await rpc('getProgramAccounts', params).catch((e) => {
    if (RPC === MAINNET_RPC) throw e;
    return rpc('getProgramAccounts', params, MAINNET_RPC);
  });
  return list.map((a) => a.pubkey);
};

/** One transaction as the watch keeps it, or null when it did not reach our program. */
async function rowOf(signature, s) {
  const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  if (!tx) return null;
  const h = howCalled(tx, ctx);
  if (!h.how) return null;
  const k = kindOf(tx, ctx);
  return { signature, slot: s.slot, at: s.blockTime, payer: h.payer, how: h.how, kind: k.kind, did: k.did, via: k.via ?? h.via, ok: !tx.meta?.err, refusedByGuard: refusedByGuard(tx), lamports: payerSolChange(tx, h.payer) };
}

if (!has('watch')) {
  const since = Math.floor(Date.now() / 1000) - HOURS * 3600;
  const pools = await ourPools();
  const sigs = new Map();
  for (const pool of pools) {
    let before;
    for (let page = 0; page < 20; page++) {
      const got = await rpc('getSignaturesForAddress', [pool, { limit: 1000, ...(before ? { before } : {}) }]);
      for (const s of got) if ((s.blockTime ?? 0) >= since) sigs.set(s.signature, s);
      if (got.length < 1000 || (got.at(-1)?.blockTime ?? 0) < since) break;
      before = got.at(-1).signature;
    }
    await sleep(200);
  }
  const rows = [];
  for (const [signature, s] of sigs) {
    const row = await rowOf(signature, s);
    await sleep(250);
    if (row) rows.push(row);
  }
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), hours: HOURS, pools: pools.length, rows }, null, 1));
  console.log(`${new Date().toISOString()}  our ${pools.length} pools, last ${HOURS} h: ${rows.length} transactions reached them (${rows.filter((r) => r.ok).length} landed). SOL is each payer's wallet change (plain + wrapped, after fees), not its profit: a bot may keep its takings elsewhere.`);
  for (const s of summarize(rows)) {
    const name = NAMES[s.payer] ? `${NAMES[s.payer]} ${s.payer.slice(0, 8)}…` : s.payer;
    const how = Object.entries(s.how).map(([k, v]) => `${k} ${v}`).join(', ');
    const via = Object.keys(s.via).length ? ` via ${Object.entries(s.via).map(([k, v]) => `${k.slice(0, 8)}… ${v}`).join(', ')}` : '';
    console.log(`  ${name.padEnd(46)} landed ${String(s.landed).padStart(4)}  failed ${String(s.failed).padStart(4)}${s.refusedByGuard ? ` (guard refused ${s.refusedByGuard})` : ''}  ${(s.lamports / 1e9 >= 0 ? '+' : '') + (s.lamports / 1e9).toFixed(4)} SOL  [${how}]${via}`);
  }
} else {
  const EVERY = Math.max(60, Number(arg('every', 300))) * 1000;
  const STATE = arg('state', 'rival-watch-state.json');
  const LOG = arg('log', 'rival-watch-log.jsonl');
  const ROUNDS = Number(arg('rounds', 0));
  const say = (line, at = Date.now()) => console.log(`${new Date(at).toISOString()}  ${line}`);
  let state = { payers: {}, last: {}, alerts: [], rounds: 0 };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) };
  } catch (e) {
    if (e?.code !== 'ENOENT') say(`The state file was not read (${e instanceof Error ? e.message : String(e)}): starting from nothing`);
  }
  let pools = [];
  let poolsAt = 0;
  say(`Sentinel up: our pools read every ${EVERY / 1000} s from ${new URL(RPC).host}; ${Object.keys(state.payers).length} wallets remembered (${STATE}); read-only, no key`);
  for (let n = 0; !ROUNDS || n < ROUNDS; n++) {
    try {
      if (Date.now() - poolsAt > 3_600_000 || !pools.length) {
        pools = await ourPools();
        poolsAt = Date.now();
      }
      const first = state.rounds === 0;
      const since = Math.floor(Date.now() / 1000) - HOURS * 3600;
      const fresh = new Map();
      const last = { ...state.last };
      for (const pool of pools) {
        const mark = state.last[pool];
        let before;
        let newest = null;
        for (let page = 0; page < 5; page++) {
          const got = await rpc('getSignaturesForAddress', [pool, { limit: 1000, ...(before ? { before } : {}), ...(mark ? { until: mark.sig } : {}) }]);
          newest ??= got[0] ?? null;
          // Nothing older than the mark is taken twice (an RPC that has forgotten the mark answers with all it has).
          for (const s of got) if ((s.blockTime ?? 0) >= (mark ? mark.at : since)) fresh.set(s.signature, s);
          if (got.length < 1000 || (got.at(-1)?.blockTime ?? 0) < (mark ? mark.at : since)) break;
          before = got.at(-1).signature;
        }
        if (newest) last[pool] = { sig: newest.signature, at: newest.blockTime ?? 0 };
        await sleep(200);
      }
      const rows = [];
      for (const [signature, s] of [...fresh].sort((a, b) => a[1].slot - b[1].slot)) {
        const row = await rowOf(signature, s);
        await sleep(250);
        if (row) rows.push(row);
      }
      // The first round only remembers: every wallet is new then. A bot past the guard is said all the same.
      const alerts = alertsFor(first ? foldSentinel(state, rows) : state, rows, NAMES).filter((a) => !first || a.why === 'passed-guard' || a.why === 'inside-landed');
      // Each alert is said at the time of the last trade it speaks of.
      for (const a of alerts) say(a.text, a.at * 1000);
      state = { ...foldSentinel(state, rows), last, rounds: state.rounds + 1, at: new Date().toISOString(), pools: pools.length, alerts: [...alerts.map((a) => ({ ...a, at: new Date(a.at * 1000).toISOString() })), ...(state.alerts ?? [])].slice(0, 200) };
      if (rows.length) {
        const count = (k) => rows.filter((r) => r.kind === k).length;
        say(`${rows.length} new in our ${pools.length} pools${first ? ` (the last ${HOURS} h, remembered)` : ''}: robot ${count('robot')}, visitors ${count('user')}, liquidity ${count('lp')}, bots from inside ${count('bot-inside')} (the guard refused ${rows.filter((r) => r.refusedByGuard).length}), bots past the guard ${count('bot-beside')}`);
        fs.appendFileSync(LOG, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      }
      fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    } catch (e) {
      say(`Round not finished (${e instanceof Error ? e.message : String(e)}): trying again at the next`);
    }
    if (!ROUNDS || n < ROUNDS - 1) await sleep(EVERY);
  }
}
