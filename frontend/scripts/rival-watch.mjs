#!/usr/bin/env node
/**
 * Who traded in our pools over the last hours, and how (lib/rival-watch.mjs). Read-only: it holds
 * no key and sends nothing; it reads the public RPC slowly.
 *
 *   node scripts/rival-watch.mjs [--hours 24] [--out rival-watch.json]
 *
 * Prints one line a payer (the robot, users, bots), biggest take first, and writes every row.
 * After the guard (proposal #33) is on, a bot that still trades our pools shows as 'beside' (our
 * swap as its own instruction next to another exchange's) or 'direct'; one still trying from its
 * own program shows its failures as refused by the guard.
 */
import fs from 'node:fs';
import { register } from 'node:module';
import { RAYDIUM_PROGRAMS } from './lib/raydium-programs.mjs';
import { OUTSIDE_DEX_PROGRAMS } from './lib/outside-dexes.mjs';
import { howCalled, payerSolChange, refusedByGuard, summarize } from './lib/rival-watch.mjs';

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
const HOURS = Number(arg('hours', 24));
const OUT = arg('out', 'rival-watch.json');
const RPC = process.env.RIVAL_WATCH_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const OURS = DEXES.ours.program;
const KNOWN = { [ROBOT.wallet]: 'our robot', GLiCiNEnku3pQsmkVkRvnDLbfUN9BWbsrPDWLdPaADng: 'GLiCi (rival)', moodt1QXNtbmiheUJr9EGfch7h5mTxcWqCLyzXxWNu6: 'moodt1 (rival)' };
const exchanges = new Set([...Object.values(DEXES).map((d) => d.program).filter((p) => p !== OURS), ...RAYDIUM_PROGRAMS, ...Object.values(OUTSIDE_DEX_PROGRAMS), 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
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

const since = Math.floor(Date.now() / 1000) - HOURS * 3600;
const pools = (await rpc('getProgramAccounts', [OURS, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: DEXES.ours.size }] }])).map((a) => a.pubkey);
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
  const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  await sleep(250);
  if (!tx) continue;
  const h = howCalled(tx, { ours: OURS, robot: ROBOT.wallet, exchanges });
  if (!h.how) continue;
  rows.push({ signature, slot: s.slot, at: s.blockTime, payer: h.payer, how: h.how, via: h.via, ok: !tx.meta?.err, refusedByGuard: refusedByGuard(tx), lamports: payerSolChange(tx, h.payer) });
}
fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), hours: HOURS, pools: pools.length, rows }, null, 1));
console.log(`${new Date().toISOString()}  our ${pools.length} pools, last ${HOURS} h: ${rows.length} transactions reached them (${rows.filter((r) => r.ok).length} landed). SOL is each payer's wallet change (plain + wrapped, after fees), not its profit: a bot may keep its takings elsewhere.`);
for (const s of summarize(rows)) {
  const name = KNOWN[s.payer] ?? s.payer;
  const how = Object.entries(s.how).map(([k, v]) => `${k} ${v}`).join(', ');
  const via = Object.keys(s.via).length ? ` via ${Object.entries(s.via).map(([k, v]) => `${k.slice(0, 8)}… ${v}`).join(', ')}` : '';
  console.log(`  ${name.padEnd(46)} landed ${String(s.landed).padStart(4)}  failed ${String(s.failed).padStart(4)}${s.refusedByGuard ? ` (guard refused ${s.refusedByGuard})` : ''}  ${(s.lamports / 1e9 >= 0 ? '+' : '') + (s.lamports / 1e9).toFixed(4)} SOL  [${how}]${via}`);
}
