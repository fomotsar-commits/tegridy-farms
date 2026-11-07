#!/usr/bin/env node
/**
 * Proof, read-only: the venue quotes (scripts/lib/arb-venues.mjs) against Jupiter's own direct
 * quote through the same pool, for SOL → USDC on one pool each of Orca, Raydium CLMM and Meteora
 * DLMM, at two sizes. It holds no key, signs nothing and sends nothing. The two quotes are read
 * seconds apart on busy pools, so a few units of drift is the pools moving, not the maths; a
 * difference past ARB_PROOF_TOLERANCE_BPS (default 5) fails the proof.
 *
 *   node scripts/arb-venues-proof.mjs            (ARB_RPC_URL: publicnode by default)
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

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
const V = await import(pathToFileURL(path.join(HERE, 'lib', 'arb-venues.mjs')).href);

const RPC = process.env.ARB_RPC_URL?.trim() || 'https://solana-rpc.publicnode.com';
const TOLERANCE_BPS = Number(process.env.ARB_PROOF_TOLERANCE_BPS || 5);
const SOL = C.SOL_MINT;
const USDC = C.USDC_MINT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(`${new Date().toISOString()}  ${line}`);

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const acc = new Map();
let slot = 0;
async function readAll(keys) {
  for (let i = 0; i < keys.length; i += 10) {
    const part = keys.slice(i, i + 10);
    const r = await rpc('getMultipleAccounts', [part, { encoding: 'base64', commitment: 'confirmed' }]);
    slot = Math.max(slot, r.context.slot);
    part.forEach((k, j) => acc.set(k, r.value[j] ? { data: Buffer.from(r.value[j].data[0], 'base64'), owner: r.value[j].owner } : null));
    await sleep(400);
  }
}
const data = (k) => acc.get(k)?.data ?? null;

async function jupiter(dex, amount) {
  const u = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL}&outputMint=${USDC}&amount=${amount}&slippageBps=50&onlyDirectRoutes=true&dexes=${encodeURIComponent(dex)}`;
  for (let t = 0; t < 6; t++) {
    const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
    const j = await r.json();
    if (r.status === 429) {
      log(`Jupiter refused for speed: resting 20 s`);
      await sleep(20_000);
      continue;
    }
    if (!r.ok) throw new Error(`Jupiter ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    const leg = j.routePlan?.[0]?.swapInfo;
    return { pool: leg?.ammKey, out: BigInt(leg?.outAmount ?? j.outAmount), slot: j.contextSlot, label: leg?.label };
  }
  throw new Error('Jupiter kept refusing');
}

/** Each venue's reference pool (the one Jupiter's direct SOL → USDC route used on 2026-11-07), and how it is quoted. */
const CASES = [
  { venue: 'Orca', dex: 'Whirlpool', pool: '83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d' },
  { venue: 'Raydium CLMM', dex: 'Raydium CLMM', pool: 'CYbD9RaToYMtWKA7QZyoLahnHdWq553Vm62Lh6qWtuxq' },
  { venue: 'Meteora DLMM', dex: 'Meteora DLMM', pool: 'HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR' },
];
const AMOUNTS = [100_000_000n, 2_000_000_000n];

let failed = 0;
for (const c of CASES) {
  await readAll([c.pool]);
  const a = acc.get(c.pool);
  if (!a) {
    log(`${c.venue}: pool ${c.pool} not found`);
    failed++;
    continue;
  }
  const dex = C.dexOfProgram(a.owner);
  const pool = C.decodePool(dex, c.pool, a.data);
  if (!pool) {
    log(`${c.venue}: pool ${c.pool} did not decode as ${dex}`);
    failed++;
    continue;
  }
  const aToB = pool.mintA === SOL;
  if (!aToB && pool.mintB !== SOL) {
    log(`${c.venue}: ${c.pool} is not a SOL pool`);
    failed++;
    continue;
  }
  let quote;
  let arrays = [];
  if (dex === 'whirlpool') {
    const w = V.whirlpoolState(a.data);
    arrays = V.orcaArraysNear(c.pool, w);
    await readAll(arrays.map((x) => x.address));
    const byStart = new Map(arrays.map((x) => [x.start, data(x.address) === null ? null : V.decodeOrcaTickArray(data(x.address))]));
    log(`${c.venue} ${c.pool}: tick ${w.tickCurrent} spacing ${w.tickSpacing} fee ${w.feeRate}/1e6${w.adaptive ? ' ADAPTIVE' : ''}; arrays ${arrays.map((x) => `${x.start}:${byStart.get(x.start) === null ? 'none' : byStart.get(x.start) ? (byStart.get(x.start).dynamic ? 'dynamic' : 'fixed') : 'undecoded'}`).join(' ')}`);
    quote = (amount) => V.orcaQuote(w, amount, aToB, (start) => byStart.get(start));
  } else if (dex === 'clmm') {
    const p = V.decodeClmmPool(c.pool, a.data);
    const extAddr = V.clmmExtensionAddress(c.pool);
    await readAll([p.ammConfig, extAddr]);
    const config = V.decodeClmmConfig(p.ammConfig, data(p.ammConfig));
    const ext = data(extAddr) ? V.decodeClmmExtension(extAddr, data(extAddr)) : null;
    arrays = V.clmmArraysNear(c.pool, p, ext);
    await readAll(arrays.map((x) => x.address));
    const byStart = new Map(arrays.map((x) => [x.start, data(x.address) ? V.decodeClmmArray(x.address, data(x.address)) : undefined]));
    log(`${c.venue} ${c.pool}: tick ${p.tickCurrent} spacing ${p.tickSpacing} fee ${config.tradeFeeRate}/1e6 ext ${ext ? 'yes' : 'none'}; arrays ${arrays.map((x) => `${x.start}:${byStart.get(x.start) ? 'ok' : 'missing'}`).join(' ')}`);
    quote = (amount) => V.clmmQuote(p, config, ext, amount, aToB, Math.floor(Date.now() / 1000), (start) => byStart.get(start));
  } else if (dex === 'dlmm') {
    const p = V.lbPairState(a.data);
    arrays = V.dlmmArraysNear(c.pool, p);
    await readAll(arrays.map((x) => x.address));
    const byIndex = new Map(arrays.map((x) => [x.index, data(x.address) === null ? null : V.decodeBinArray(data(x.address))]));
    log(`${c.venue} ${c.pool}: active ${p.activeId} step ${p.binStep} fee ${V.dlmmTotalFee(p)}/1e9 (base ${V.dlmmBaseFee(p)}); arrays ${arrays.map((x) => `${x.index}:${byIndex.get(x.index) === null ? 'none' : byIndex.get(x.index) ? 'ok' : 'undecoded'}`).join(' ')}`);
    quote = (amount) => V.dlmmQuote(p, amount, aToB, Date.now() / 1000, (index) => byIndex.get(index));
  } else {
    log(`${c.venue}: ${c.pool} is a ${dex} pool, not this proof's`);
    failed++;
    continue;
  }
  for (const amount of AMOUNTS) {
    const mine = quote(amount);
    let jup;
    try {
      jup = await jupiter(c.dex, amount);
    } catch (e) {
      log(`${c.venue}: Jupiter not read (${e.message}); mine: ${mine.out} for ${mine.used}${mine.needs !== null && mine.needs !== undefined ? ` (needs ${mine.needs})` : ''}`);
      failed++;
      continue;
    }
    const diffBps = jup.out > 0n ? Number(((mine.out - jup.out) * 1_000_000n) / jup.out) / 100 : NaN;
    const samePool = jup.pool === c.pool;
    // Jupiter picks the venue's best pool for the size; another pool's quote proves nothing either way.
    const ok = !samePool || (Math.abs(diffBps) <= TOLERANCE_BPS && mine.used === amount);
    if (!ok) failed++;
    log(`${!samePool ? 'SKIP' : ok ? 'OK  ' : 'FAIL'} ${c.venue} ${Number(amount) / 1e9} SOL: mine ${mine.out} (${mine.used === amount ? 'filled' : `only ${mine.used} placed`}${mine.needs !== null && mine.needs !== undefined ? `, needs ${mine.needs}` : ''}${mine.refused ? `, refused ${mine.refused}` : ''}) vs Jupiter ${jup.out} through ${jup.pool}${samePool ? '' : ' (another pool: not compared)'} = ${diffBps.toFixed(2)} bps; my slot ${slot}, Jupiter's ${jup.slot}`);
    await sleep(4_000);
  }
}
log(failed ? `${failed} comparison(s) failed` : 'every quote matched Jupiter through the same pool');
process.exit(failed ? 1 : 0);
