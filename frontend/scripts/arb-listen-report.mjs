#!/usr/bin/env node
/**
 * Stage 0's answer from the listener's gap log (scripts/arb-listen.mjs ARB_LISTEN_LOG, JSON
 * lines), in plain words: how many gaps paid after every cost a send pays, how many were still
 * there 1 s and 3 s after they opened (a home PC on a public websocket reacts in about 1 to 3 s),
 * and the money a sender reaching them then would have found. Reads a file; sends nothing.
 *
 *   node scripts/arb-listen-report.mjs <gaps.jsonl> [--since <ISO time>] [--json]
 */
import fs from 'node:fs';
import { register } from 'node:module';

// The robot's TS modules load through its loader (scripts/arb-listen.mjs, price-keeper.mjs).
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

const L = await import('./lib/arb-listen.mjs');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--since');
if (!file) {
  console.error('usage: node scripts/arb-listen-report.mjs <gaps.jsonl> [--since <ISO time>] [--json]');
  process.exit(2);
}
const since = args.includes('--since') ? Date.parse(args[args.indexOf('--since') + 1]) : 0;
if (Number.isNaN(since)) throw new Error('--since takes an ISO time, e.g. 2026-11-07T04:00:00Z');

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const { gaps, firstAt, lastAt } = L.gapsFromLog(lines, since);
const now = lastAt ?? Date.now();
const r = L.stage0Report(gaps, now);
if (args.includes('--json')) {
  console.log(JSON.stringify({ file, since: since || null, firstAt, lastAt, ...r }, null, 1));
  process.exit(0);
}
const hours = firstAt && lastAt ? (lastAt - firstAt) / 3_600_000 : 0;
const usd = (v) => `$${v.toFixed(2)}`;
console.log(`Gap log ${file}: ${hours.toFixed(1)} h of gaps (first ${firstAt ? new Date(firstAt).toISOString() : '-'}, last ${lastAt ? new Date(lastAt).toISOString() : '-'}).`);
console.log(`${r.gaps} gaps paid after every cost (pool fees, transfer fees, network fee, a Jito tip, the robot's floor).`);
console.log(`  ${r.goneBeforeReach} were gone within 1 s (${r.sameSlot} within the slot they opened in): no home PC wins those.`);
console.log(`  ${r.reach[1000].gaps} were still there at 1 s, worth ${usd(r.reach[1000].usd)} to whoever took them then.`);
console.log(`  ${r.reach[3000].gaps} were still there at 3 s, worth ${usd(r.reach[3000].usd)}.`);
console.log(`  Taken the instant each opened (only a co-located bot could): ${usd(r.usdIfEveryOneTakenAtOpen)}.`);
console.log(`  ${r.suspect} stayed open past 10 minutes and are counted as misreads, not money; ${r.stillOpen} were still open at the end.`);
if (r.topCoins.length) {
  console.log('Coins, most money at 1 s first:');
  for (const c of r.topCoins) console.log(`  ${String(c.symbol ?? '?').padEnd(12)} ${c.coin}  ${c.gaps} gaps, ${c.reached1s} still there at 1 s, ${usd(c.usdAt1s)}, best ${usd(c.bestNetUsd)}`);
}
