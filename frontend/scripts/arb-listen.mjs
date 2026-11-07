#!/usr/bin/env node
/**
 * Real-time arbitrage engine, stage 1: LISTEN ONLY (owner 2026-11-06: watch the pools live and
 * build the outside swaps ourselves, so a gap is test-run and sent within about a second, with no
 * Jupiter in the loop). It holds no key, signs nothing and sends nothing.
 *
 *   1. The coins and pools the scanner reads (scripts/arb-scanner.mjs): our pools' coins and
 *      GeckoTerminal's busiest, each coin's pools from DexScreener's list, owned and decoded on
 *      chain (lib/arb-chain.mjs), at least $1,000 deep, 10 a coin at most.
 *   2. One websocket: an accountSubscribe on every account that moves a price (a pool, its two
 *      vaults), the SOL/USDC pool and the robot's two coin accounts. Once subscribed, everything is
 *      read once more, so nothing that changed while subscribing is missed.
 *   3. On every change, that coin's trips are judged again by the robot's own rule (keeper/rule.ts,
 *      through arb-chain.mjs tripsFor), with the running robot's settings (its page, ARB_ROBOT_URL).
 *      Each gap that clears the floor is logged when it opens and when it closes, with its slots.
 *
 *
 * Stage 0 (owner 2026-11-07: "real arbs in real time … that are actually profitable"), with
 * ARB_MAP_FILE: the coins and pools come from the chain-wide map (scripts/arb-map.mjs: every coin
 * with two or more deep Raydium CPMM / AMM v4 / PumpSwap / our pools), not a listing's busiest; a
 * gap counts only when it pays after EVERY cost a send pays (both pools' fees, a Token-2022
 * transfer fee on each hop, the network fee, the Jito tip a race needs, the robot's floor:
 * lib/arb-listen.mjs afterCosts); each gap is logged with what a sender reaching it 1 s and 3 s
 * after it opened would have found; a gap still open after ARB_RECHECK_MS is read afresh over
 * HTTP (a missed websocket update closes it there). state.json's `stage0` is the day's answer.
 *
 * The concentrated and bin venues (Orca, Raydium CLMM, Meteora DLMM; owner 2026-11-07: "where
 * the volume already is") are priced to the unit by lib/arb-venues.mjs from their tick or bin
 * arrays, read at discovery (the arrays near the price) and on demand when a quote reaches past
 * them; a bin array is watched (it changes with every swap), a tick array re-read now and then.
 * A band or bin pool with no quote (an Orca pool on an adaptive fee tier, an array not read yet)
 * is left out of that judgement and counted (`venues` in state.json).
 *
 *   node scripts/arb-listen.mjs        counts at http://127.0.0.1:8799/state.json; Ctrl+C stops it
 *
 * Settings (environment): ARB_LISTEN_PORT (8799), ARB_RPC_URL (public mainnet), ARB_WS_URL (the
 * RPC's, as ws), ARB_ROBOT_URL (http://127.0.0.1:8792/state.json), ARB_LISTEN_LOG (each gap, JSON
 * lines; default in the system's temp folder), ARB_MAX_COINS, ARB_LISTEN_COMMITMENT (confirmed),
 * ARB_MAP_FILE (the map's arb-map.json: Stage 0), ARB_SCAN_RPC_URL (the one program-wide read
 * of our own pools, which publicnode refuses: the public mainnet RPC), ARB_RPC_GAP_MS (1500 between reads),
 * ARB_READ_BATCH (accounts a read: 100, publicnode 10), ARB_WS_PER_SOCKET (80),
 * ARB_MIN_DEPTH_USD (1000 a pool), ARB_RECHECK_MS (5000), ARB_POOL_REREAD_MS (120000).
 *
 * The public mainnet websocket gives ~4 sockets × 80 accounts an IP and the robot uses it: point
 * ARB_RPC_URL and ARB_WS_URL at publicnode (measured 11-07: ~300 subscriptions a socket, updates
 * within a few ms of mainnet's) so this never crowds the robot.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { redactRpcUrl } from '../../scripts/lib/redact-url.mjs';

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = await import('./lib/arb-chain.mjs');
const L = await import('./lib/arb-listen.mjs');
const V = await import('./lib/arb-venues.mjs');
const R = await import(pathToFileURL(path.join(HERE, '..', 'src', 'lib', 'solana', 'keeper', 'rule.ts')).href);
const TS = await import(pathToFileURL(path.join(HERE, '..', 'src', 'lib', 'solana', 'lp', 'tokenSafety.ts')).href);
const TF = await import(pathToFileURL(path.join(HERE, '..', 'src', 'lib', 'solana', 'lp', 'transferFee.ts')).href);

const PORT = Number(process.env.ARB_LISTEN_PORT || 8799);
const RPC = process.env.ARB_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const SCAN_RPC = process.env.ARB_SCAN_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const WS = process.env.ARB_WS_URL?.trim() || RPC.replace(/^http/i, 'ws');
const ROBOT_URL = process.env.ARB_ROBOT_URL?.trim() || 'http://127.0.0.1:8792/state.json';
const LOG = process.env.ARB_LISTEN_LOG?.trim() || path.join(os.tmpdir(), 'arb-listen-gaps.jsonl');
const COMMITMENT = process.env.ARB_LISTEN_COMMITMENT?.trim() || 'confirmed';
const MAX_COINS = Number(process.env.ARB_MAX_COINS) || Infinity;
const MAP_FILE = process.env.ARB_MAP_FILE?.trim() || null;
const numEnv = (name, fallback) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, not "${raw}"`);
  return n;
};
// Gentler than the scanner's 0.7 s: the robot reads the same public RPC from this IP.
const RPC_GAP_MS = numEnv('ARB_RPC_GAP_MS', 1_500);
// publicnode refuses more than 10 accounts a getMultipleAccounts (403, 11-06); the public RPC takes 100.
const READ_BATCH = numEnv('ARB_READ_BATCH', RPC.includes('publicnode') ? 10 : 100);
const RECHECK_MS = numEnv('ARB_RECHECK_MS', 5_000);
const POOL_REREAD_MS = numEnv('ARB_POOL_REREAD_MS', 120_000);
const GECKO_PAGES = 5;
const TRENDING_PAGES = 2;
const LISTED_POOLS = 12;
const POOLS_PER_COIN = 10;
const MIN_DEPTH_USD = numEnv('ARB_MIN_DEPTH_USD', 1_000);
const BRIDGE = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
// One swap moves two vaults in one slot; their updates arrive apart. A coin is judged once both are in.
const JUDGE_AFTER_MS = 250;
// The public websocket closes a socket (1013, "try again later") that asks for ~100 accounts in
// 6 s (walked 11-06: 446 asked at 25 a second, closed at 99 every time). Each socket takes fewer,
// slower. It also refused a 5th socket from this IP (1006 at once): 4 × 80 accounts is what it gave.
const SUBSCRIBE_GAP_MS = 150;
const ACCOUNTS_PER_SOCKET = numEnv('ARB_WS_PER_SOCKET', 80);
const KEEP_ALIVE_MS = 25_000;
const RULE_EVERY_MS = 5 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const said = (e) => (e instanceof Error ? e.message : String(e));
const log = (line) => console.log(`${new Date().toISOString()}  ${line}`);

function gated(gap, rest, read) {
  let next = 0;
  return async (...args) => {
    for (let tries = 0; ; tries++) {
      const wait = next - Date.now();
      next = Math.max(Date.now(), next) + gap;
      if (wait > 0) await sleep(wait);
      try {
        return await read(...args);
      } catch (e) {
        if (!e.busy || tries >= 2) throw e;
        log(`${e.message}: resting ${rest / 1000} s`);
        next = Date.now() + rest;
      }
    }
  };
}
const callRpc = (url) => async (method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  if (r.status === 429) throw Object.assign(new Error(`RPC ${method} refused for speed`), { busy: true });
  if (!r.ok) throw new Error(`RPC ${method} answered ${r.status}`);
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(`RPC ${method}: ${String(j.error.message ?? j.error.code).slice(0, 160)}`), { busy: j.error.code === 429 });
  return j.result;
};
const rpc = gated(RPC_GAP_MS, 30_000, callRpc(RPC));
// The one program-wide read (our own pools): the public mainnet RPC takes it, publicnode does not.
const scanRpc = gated(RPC_GAP_MS, 30_000, callRpc(SCAN_RPC));
const dexscreener = gated(400, 60_000, async (mint) => {
  const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 429) throw Object.assign(new Error('DexScreener refused for speed'), { busy: true });
  if (!r.ok) throw new Error(`DexScreener answered ${r.status}`);
  return r.json();
});
const gecko = gated(7_000, 60_000, async (url) => {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (r.status === 429) throw Object.assign(new Error('GeckoTerminal refused for speed'), { busy: true });
  if (!r.ok) throw new Error(`GeckoTerminal answered ${r.status}`);
  return r.json();
});

const S = {
  startedAt: Date.now(),
  coins: new Map(), // mint → { mint, symbol, decimals, supply, pools, links }
  configs: new Map(),
  quoteLinks: new Map(),
  usd: new Map([[C.USDC_MINT, 1]]),
  holds: new Map(),
  acc: new Map(), // address → { data, slot }: the newest seen
  coinsOf: new Map(),
  settings: R.ruleSettingsFromEnv(process.env, false),
  flashLoans: false,
  ruleFrom: 'not read yet',
  // A gap: a trip that pays after every cost a send pays (lib/arb-listen.mjs afterCosts).
  book: new L.GapBook({ pays: (t) => t.paysAll, net: (t) => t.netAllUsd }),
  stats: { notes: 0, judged: 0, subscribed: 0, refusedSubs: 0, opens: 0, reconnects: 0, slot: 0, readyAt: 0, rechecks: 0, closedByRecheck: 0, poolRereads: 0, arrayReads: 0, needs: 0, staleBins: 0, unpriced: 0, judgeMs: 0, judgeMaxMs: 0 },
  bridgePool: null,
  note: 'starting…',
};
const owner = new PublicKey(C.ROBOT.wallet);
const ATAS = Object.keys(C.COINS).map((m) => [m, getAssociatedTokenAddressSync(new PublicKey(m), owner, true).toBase58()]);

/** Accounts in chunks of READ_BATCH, each chunk from one slot; kept as the newest seen. */
async function readAll(keys) {
  for (let i = 0; i < keys.length; i += READ_BATCH) {
    const part = keys.slice(i, i + READ_BATCH);
    const r = await rpc('getMultipleAccounts', [part, { encoding: 'base64', commitment: COMMITMENT }]);
    part.forEach((k, j) => keep(k, r.value[j] ? Buffer.from(r.value[j].data[0], 'base64') : null, r.context.slot, r.value[j]?.owner));
  }
}
function keep(k, data, slot, owner) {
  const was = S.acc.get(k);
  if (was && was.slot > slot) return false;
  S.acc.set(k, { data, slot, owner: owner ?? was?.owner });
  S.stats.slot = Math.max(S.stats.slot, slot);
  return true;
}
const dataOf = (k) => S.acc.get(k)?.data ?? null;
const amounts = { get: (k) => C.tokenAmount(dataOf(k)) };
// ─── the band and bin venues (lib/arb-venues.mjs) ─────────────────────────────────────
const decoded = new Map(); // address → { slot, view }: an account decoded once a version
function decodedOf(k, decode) {
  const a = S.acc.get(k);
  if (!a?.data) return null;
  const was = decoded.get(k);
  if (was && was.slot === a.slot) return was.view;
  const view = decode(a.data) ?? null;
  decoded.set(k, { slot: a.slot, view });
  return view;
}

/**
 * The accounts a band or bin pool's quote reads beyond its own, from its account as last read:
 * the tick or bin arrays near its price, and a Raydium CLMM pool's fee config and far-band map.
 * Read in rounds (a CLMM pool's arrays depend on its map): see `readVenueAccounts`.
 */
function venueAccounts(p) {
  const d = dataOf(p.address);
  if (!d) return [];
  if (p.dex === 'whirlpool') {
    const w = V.whirlpoolState(d);
    if (!w) return [];
    const arrays = V.orcaArraysNear(p.address, w).map((x) => x.address);
    return w.adaptive ? [V.orcaOracleAddress(p.address), ...arrays] : arrays;
  }
  if (p.dex === 'clmm') {
    const pool = V.decodeClmmPool(p.address, d);
    if (!pool) return [];
    const extK = V.clmmExtensionAddress(p.address);
    const ext = dataOf(extK) ? V.decodeClmmExtension(extK, dataOf(extK)) : null;
    return [pool.ammConfig, extK, ...V.clmmArraysNear(p.address, pool, ext).map((x) => x.address)];
  }
  if (p.dex === 'dlmm') {
    const s = V.lbPairState(d);
    return s ? V.dlmmArraysNear(p.address, s).map((x) => x.address) : [];
  }
  return [];
}

/** The venue accounts of `pools` read, in rounds until nothing new is wanted; each pool keeps its list in `arrays`. */
async function readVenueAccounts(pools) {
  const venue = pools.filter((p) => p && p.kind !== 'pair');
  for (let round = 0; round < 3; round++) {
    const want = [...new Set(venue.flatMap(venueAccounts))].filter((k) => !S.acc.has(k));
    if (!want.length) break;
    await readAll(want);
  }
  for (const p of venue) {
    p.arrays = venueAccounts(p);
    if (p.dex === 'whirlpool' && p.adaptive) p.oracle = V.orcaOracleAddress(p.address);
  }
}

/** A bin pool's depth: what its read bin arrays hold, and its price at the active bin (lib/arb-chain.mjs depthOf). */
const binsOf = (p) => {
  const arrays = (p.arrays ?? []).map((k) => decodedOf(k, V.decodeBinArray)).filter((a) => a && a.lbPair === p.address);
  if (!arrays.length) return null;
  const s = decodedOf(p.address, V.lbPairState);
  const price = s && V.dlmmPrice(s.activeId, s.binStep);
  return { ...V.dlmmDepth(arrays), spot: price ? Number(price) / 2 ** 64 : 0 };
};

/**
 * An exact quote (raw in → raw out) for a band or bin pool from the accounts held, or null when
 * it cannot be priced now. An array a walk reaches and the listener never read goes into `needs`
 * (address → pool), read right after the judgement. A bin pool whose active bin array is older
 * than its own account is stale (every swap through it changes both): not priced until re-read.
 */
function exactQuote(p, fromMint, needs) {
  const d = dataOf(p.address);
  if (!d) return null;
  const aToB = p.mintA === fromMint;
  const want = (k) => {
    if (!S.acc.has(k)) needs.set(k, p.address);
  };
  if (p.dex === 'whirlpool') {
    const w = V.whirlpoolState(d);
    if (!w) return null;
    let oracle = null;
    if (w.adaptive) {
      const k = V.orcaOracleAddress(p.address);
      if (!S.acc.has(k)) {
        want(k);
        return null;
      }
      oracle = decodedOf(k, V.decodeOrcaOracle);
      if (!oracle) return null;
    }
    const now = Date.now() / 1000;
    const array = (start) => {
      const k = V.orcaArrayAddress(p.address, start);
      const a = S.acc.get(k);
      if (a === undefined) {
        want(k);
        return undefined;
      }
      return a.data ? decodedOf(k, V.decodeOrcaTickArray) : null;
    };
    return (x) => Number(V.orcaQuote(w, BigInt(Math.floor(x)), aToB, array, oracle, now).out);
  }
  if (p.dex === 'damm') {
    const s = decodedOf(p.address, V.dammState);
    if (!s) return null;
    const when = { now: Date.now() / 1000, slot: S.stats.slot };
    return (x) => Number(V.dammQuote(s, BigInt(Math.floor(x)), aToB, when).out);
  }
  if (p.dex === 'clmm') {
    const pool = decodedOf(p.address, (data) => V.decodeClmmPool(p.address, data));
    const cfg = pool && decodedOf(pool.ammConfig, (data) => V.decodeClmmConfig(pool.ammConfig, data));
    if (!pool || !cfg) return null;
    const extK = V.clmmExtensionAddress(p.address);
    const ext = decodedOf(extK, (data) => V.decodeClmmExtension(extK, data));
    const band = (start) => {
      const k = V.clmmArrayAddress(p.address, start);
      if (!S.acc.has(k)) want(k);
      return decodedOf(k, (data) => V.decodeClmmArray(k, data)) ?? undefined;
    };
    const now = Math.floor(Date.now() / 1000);
    return (x) => Number(V.clmmQuote(pool, cfg, ext, BigInt(Math.floor(x)), aToB, now, band).out);
  }
  if (p.dex === 'dlmm') {
    const s = decodedOf(p.address, V.lbPairState);
    if (!s || s.status !== 0) return null;
    const activeK = V.dlmmArrayAddress(p.address, V.dlmmArrayIndex(s.activeId));
    const active = S.acc.get(activeK);
    if (!active) {
      want(activeK);
      return null;
    }
    if (active.data && active.slot < S.acc.get(p.address).slot) {
      S.stats.staleBins++;
      needs.set(activeK, p.address);
      return null;
    }
    const array = (index) => {
      const k = V.dlmmArrayAddress(p.address, index);
      const a = S.acc.get(k);
      if (a === undefined) {
        want(k);
        return undefined;
      }
      return a.data ? decodedOf(k, V.decodeBinArray) : null;
    };
    const now = Date.now() / 1000;
    return (x) => Number(V.dlmmQuote(s, BigInt(Math.floor(x)), aToB, now, array).out);
  }
  return null;
}

const pendingReads = new Map(); // address → true while a read is out
/** Arrays a judgement reached for and had not: read once, kept on their pools, and the coin judged again. */
function readSoon(needs, mint) {
  const fresh = [...needs].filter(([k]) => !pendingReads.has(k));
  if (!fresh.length) return;
  for (const [k] of fresh) pendingReads.set(k, true);
  S.stats.arrayReads += fresh.length;
  readAll(fresh.map(([k]) => k))
    .then(() => {
      const coin = S.coins.get(mint);
      const pools = [...(coin?.pools ?? []), ...(S.bridgePool ? [S.bridgePool] : [])];
      for (const [k, poolAddress] of fresh) {
        const p = pools.find((x) => x.address === poolAddress);
        if (p && S.acc.get(k)?.data) p.arrays = [...new Set([...(p.arrays ?? []), k])].slice(-12);
      }
      if (coin) judgeSoon(mint);
    })
    .catch((e) => log(`reading arrays for ${mint}: ${said(e)}`))
    .finally(() => fresh.forEach(([k]) => pendingReads.delete(k)));
}

const quoteOf = (p, mint) => (p.mintA === mint ? p.mintB : p.mintA);
const decimalsOf = (m) => (C.COINS[m] ?? C.QUOTES[m]).decimals;
const linkedQuote = (q) => Boolean(C.COINS[q] || (C.QUOTES[q] && S.quoteLinks.get(q)));

async function readRule() {
  const { rule, why } = await C.robotSettings(ROBOT_URL, fetch);
  if (rule) {
    const { flashLoans, ...settings } = rule;
    Object.assign(S, { settings, flashLoans, ruleFrom: 'the running robot' });
  } else S.ruleFrom = `this listener's own (${why})`;
}

function solPrice() {
  const bridge = C.withFee(C.decodePool('whirlpool', BRIDGE, dataOf(BRIDGE)) ?? {}, S.configs);
  const depth = bridge && C.depthOf(bridge, new Map());
  if (depth) S.usd.set(C.SOL_MINT, (depth.b / depth.a) * 1e3);
  return depth ? { pool: { ...bridge, arrays: S.bridgePool?.arrays ?? [] }, depth } : null;
}

async function readConfigs(pools) {
  const want = [...new Set(pools.flatMap((p) => (p.dex === 'pumpswap' ? [C.PUMP_FEE_CONFIG] : p.config ? [p.config] : [])))].filter((k) => !S.configs.has(k));
  if (!want.length) return;
  await readAll(want);
  for (const k of want) {
    const a = S.acc.get(k);
    if (!a?.data) continue;
    if (k === C.PUMP_FEE_CONFIG) {
      const cfg = a.owner === C.PUMP_FEE_PROGRAM ? C.pumpFeeConfig(a.data) : null;
      if (cfg) S.configs.set(k, cfg);
      continue;
    }
    S.configs.set(k, C.dexOfProgram(a.owner) === 'clmm' ? C.clmmConfigFee(a.data) : C.cpConfigFee(a.data));
  }
}

/** The robot's coin accounts and rule, the SOL/USDC bridge, and the pricing coins' link pools and prices. */
async function readBasics() {
  await readAll([...ATAS.map(([, a]) => a), BRIDGE]);
  S.bridgePool = C.decodePool('whirlpool', BRIDGE, dataOf(BRIDGE));
  if (S.bridgePool) await readVenueAccounts([S.bridgePool]);
  await readRule();
  // The pricing coins' link pools (BAYLA through our BAYLA/SOL, USDT through Raydium USDT/USDC).
  const linkKeys = Object.values(C.QUOTES).map((q) => q.bridge);
  await readAll(linkKeys);
  for (const [mint, q] of Object.entries(C.QUOTES)) {
    const a = S.acc.get(q.bridge);
    const dex = a?.data && C.dexOfProgram(a.owner);
    const pool = dex && C.decodePool(dex, q.bridge, a.data);
    if (pool && [pool.mintA, pool.mintB].includes(mint)) S.quoteLinks.set(mint, pool);
  }
  await readConfigs([...S.quoteLinks.values()]);
  await readAll([...S.quoteLinks.values()].flatMap((l) => (l.kind === 'band' ? [] : [l.vaultA, l.vaultB])));
  solPrice();
  for (const [q, l] of S.quoteLinks) {
    const depth = C.depthOf(l, amounts);
    if (depth) S.usd.set(q, (l.mintA === q ? depth.b / depth.a : depth.a / depth.b) * 10 ** (decimalsOf(q) - decimalsOf(quoteOf(l, q))) * (S.usd.get(quoteOf(l, q)) ?? NaN));
  }
}

/**
 * A coin the robot's token gate lets through (its mint already read), kept with its decimals,
 * supply and transfer fee rate (`cut`, 0 without one: the larger of its two settings while a
 * change is pending, lp/transferFee.ts feeNow); false when the gate refuses it.
 */
function admit(m, symbolHint) {
  const a = S.acc.get(m);
  const safety = TS.classifyToken(m, a?.data ? { address: m, owner: a.owner, data: a.data, lamports: 0 } : null, null);
  const facts = safety.kind === 'read' ? safety.facts : null;
  if (R.tokenGate(safety) || !facts) return false;
  const fee = TF.feeNow(facts.transferFee ?? null, null);
  const cut = fee && fee.maximumFee > 0n ? fee.basisPoints / 10_000 : 0;
  const supply = a.data.length >= 44 ? a.data.readBigUInt64LE(36) : null;
  S.coins.set(m, { mint: m, symbol: String(symbolHint || safety.symbol || '?').slice(0, 16), decimals: facts.decimals, supply, cut, pools: [], links: [] });
  return true;
}

/** The coins and their pools, as the scanner finds them (arb-scanner.mjs readUniverse, discover): mint → pool addresses. */
async function listFromMarkets() {
  const ours = await scanRpc('getProgramAccounts', [C.DEXES.ours.program, { encoding: 'base64', commitment: COMMITMENT, filters: [{ dataSize: C.DEXES.ours.size }] }]);
  const ourPools = new Map();
  const symbols = new Map();
  for (const o of ours) {
    const p = C.decodePool('ours', o.pubkey, Buffer.from(o.account.data[0], 'base64'));
    if (!p) continue;
    const m = [p.mintA, p.mintB].find((x) => !C.COINS[x] && !C.QUOTES[x]) ?? [p.mintA, p.mintB].find((x) => !C.COINS[x]);
    if (!m) continue;
    symbols.set(m, null);
    ourPools.set(m, [...(ourPools.get(m) ?? []), o.pubkey]);
  }
  const lists = [...Array.from({ length: GECKO_PAGES }, (_, i) => `pools?sort=h24_volume_usd_desc&page=${i + 1}`), ...Array.from({ length: TRENDING_PAGES }, (_, i) => `trending_pools?page=${i + 1}`)];
  for (const list of lists) {
    S.note = `coin list: ${list}`;
    try {
      for (const [m, s] of C.busyTokens(await gecko(`https://api.geckoterminal.com/api/v2/networks/solana/${list}`))) if (!symbols.get(m)) symbols.set(m, s);
    } catch (e) {
      log(`GeckoTerminal ${list} not read: ${said(e)}`);
    }
  }
  const mints = [...symbols.keys()].slice(0, MAX_COINS);
  await readAll(mints);
  // Each coin: the robot's token gate on its mint, then its listed pools.
  const listed = new Map();
  for (const m of mints) {
    if (!admit(m, symbols.get(m))) continue;
    S.note = `pools of ${m}`;
    let json = [];
    try {
      json = await dexscreener(m);
    } catch (e) {
      log(`DexScreener ${m}: ${said(e)}`);
    }
    const listedSym = (Array.isArray(json) ? json : []).map((p) => (p?.baseToken?.address === m ? p.baseToken.symbol : p?.quoteToken?.address === m ? p.quoteToken.symbol : null)).find(Boolean);
    if (!symbols.get(m) && listedSym) S.coins.get(m).symbol = String(listedSym).slice(0, 16);
    listed.set(m, [...C.poolsFromListing(json, m, MIN_DEPTH_USD).slice(0, LISTED_POOLS).map((f) => f.address), ...(ourPools.get(m) ?? [])]);
  }
  return listed;
}

/** Stage 0: the chain-wide map's coins and pools (lib/arb-listen.mjs coinsFromMap): mint → pool addresses. */
async function listFromMap() {
  S.note = `the map: ${MAP_FILE}`;
  const rows = L.coinsFromMap(JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')), { max: MAX_COINS });
  await readAll(rows.map((r) => r.mint));
  const listed = new Map();
  for (const r of rows) if (admit(r.mint, r.symbol)) listed.set(r.mint, r.pools.map((p) => p.address));
  log(`the map gives ${rows.length} coins with 2+ deep pools the robot can price; ${listed.size} pass the robot's token gate`);
  return listed;
}

/** The coins and their pools: listed, owned and decoded on chain, at least MIN_DEPTH_USD deep, POOLS_PER_COIN a coin at most. */
async function discover() {
  await readBasics();
  const listed = MAP_FILE ? await listFromMap() : await listFromMarkets();
  await readAll([...new Set([...listed.values()].flat())]);
  const candidates = new Map();
  for (const [m, addrs] of listed) {
    const found = [...new Set(addrs)].map((k) => ({ k, a: S.acc.get(k) })).filter(({ a }) => a?.data && C.dexOfProgram(a.owner));
    // From the map, only what its owner proves is a venue priced to the unit, whatever the row says.
    candidates.set(m, found.map(({ k, a }) => C.decodePool(C.dexOfProgram(a.owner), k, a.data)).filter((p) => p && (!MAP_FILE || L.DIRECT_DEXES.has(p.dex)) && [p.mintA, p.mintB].includes(m) && linkedQuote(quoteOf(p, m))));
  }
  await readConfigs([...candidates.values()].flat());
  const withFees = new Map([...candidates].map(([m, ps]) => [m, ps.map((p) => C.withFee(p, S.configs)).filter(Boolean)]));
  S.note = 'reading the band and bin pools’ arrays';
  await readVenueAccounts([...withFees.values()].flat());
  S.note = 'reading the pools’ vaults';
  await readAll([...new Set([...withFees.values()].flat().flatMap(L.accountsOf))]);
  for (const [m, pools] of withFees) {
    const deep = [];
    for (const p of pools) {
      const depth = C.depthOf(p, amounts, binsOf);
      const q = quoteOf(p, m);
      if (!depth || !linkedQuote(q)) continue;
      const usd = ((q === p.mintA ? depth.a : depth.b) / 10 ** decimalsOf(q)) * (S.usd.get(q) ?? 0);
      if (usd >= MIN_DEPTH_USD || p.dex === 'ours') deep.push({ p, usd });
    }
    const coin = S.coins.get(m);
    coin.pools = deep.sort((a, b) => Number(b.p.dex === 'ours') - Number(a.p.dex === 'ours') || b.usd - a.usd).slice(0, POOLS_PER_COIN).map((x) => x.p);
    coin.links = [...new Set(coin.pools.map((p) => quoteOf(p, m)).filter((q) => C.QUOTES[q] && S.quoteLinks.get(q)))].map((q) => S.quoteLinks.get(q));
    if (coin.pools.length < 2) S.coins.delete(m);
  }
  for (const m of [...S.coins.keys()]) if (!withFees.has(m)) S.coins.delete(m);
  S.coinsOf = L.coinsByAccount([...S.coins.values()]);
}

// ─── judging ───────────────────────────────────────────────────────────────────────────
const due = new Map(); // coin → timer
function judgeSoon(mint) {
  if (due.has(mint)) return;
  due.set(mint, setTimeout(() => {
    due.delete(mint);
    try {
      judge(S.coins.get(mint));
    } catch (e) {
      log(`judging ${mint}: ${said(e)}`);
    }
  }, JUDGE_AFTER_MS));
}

/** `closedBy`: what judged it ('a change' the websocket sent, or 'a fresh read' over HTTP). Timed: judgeMs, judgeMaxMs. */
function judge(coin, closedBy = 'a change') {
  const t0 = performance.now();
  try {
    return judgeNow(coin, closedBy);
  } finally {
    const ms = performance.now() - t0;
    S.stats.judgeMs += ms;
    if (ms > S.stats.judgeMaxMs) S.stats.judgeMaxMs = ms;
  }
}

function judgeNow(coin, closedBy) {
  if (!coin) return;
  const bridge = solPrice();
  if (!bridge) return;
  let pools = coin.pools.map((p) => {
    const fresh = C.withFee(C.decodePool(p.dex, p.address, dataOf(p.address)) ?? {}, S.configs);
    if (!fresh || !fresh.mintA) return null;
    // A DAMM v2 pool's fee follows its schedule: the fee now, for the screen at zero size.
    if (fresh.dex === 'damm') {
      const s = decodedOf(p.address, V.dammState);
      const f = s && V.dammFee(s, { now: Date.now() / 1000, slot: S.stats.slot });
      if (typeof f === 'bigint') fresh.fee = Number(f) / 1e9;
    }
    return { ...fresh, arrays: p.arrays ?? [], ...(p.oracle ? { oracle: p.oracle } : {}) };
  }).filter(Boolean);
  const depths = new Map(pools.map((p) => [p.address, C.depthOf(p, amounts, binsOf)]));
  const needs = new Map();
  const exact = (p, from) => {
    const q = exactQuote(p, from, needs);
    if (!q && p.kind !== 'pair') S.stats.unpriced++;
    return q;
  };
  pools = pools.map((p) => (p.dex === 'pumpswap' ? C.withFee(p, S.configs, { depth: depths.get(p.address), supply: p.mintA === coin.mint ? coin.supply : null }) : p)).filter(Boolean);
  const quotes = new Map();
  for (const l of coin.links) {
    const q = C.QUOTES[l.mintA] ? l.mintA : l.mintB;
    const live = C.withFee(C.decodePool(l.dex, l.address, dataOf(l.address)) ?? {}, S.configs);
    const depth = live && live.mintA && C.depthOf(live, amounts);
    if (!depth) continue;
    const c = quoteOf(live, q);
    S.usd.set(q, (live.mintA === q ? depth.b / depth.a : depth.a / depth.b) * 10 ** (decimalsOf(q) - decimalsOf(c)) * (S.usd.get(c) ?? NaN));
    quotes.set(q, { pool: live, depth });
    depths.set(live.address, depth);
  }
  // With loans on, the robot borrows SOL past its float (keeper/flashLoan.ts): SOL trips are held by the cap only.
  const holds = new Map(ATAS.filter(([m]) => !(S.flashLoans && m === C.SOL_MINT)).map(([m, a]) => [m, Number(C.tokenAmount(dataOf(a)) ?? 0n)]));
  const trips = C.tripsFor(pools, { token: coin.mint, decimals: coin.decimals, depths, usd: S.usd, holds, bridge, quotes, settings: S.settings, tokenCut: coin.cut, exact });
  if (needs.size) {
    S.stats.needs += needs.size;
    readSoon(needs, coin.mint);
  }
  const solUsd = S.usd.get(C.SOL_MINT);
  for (const t of trips) Object.assign(t, L.afterCosts(t, solUsd));
  const slot = Math.max(...[...coin.pools, ...coin.links].flatMap(L.accountsOf).map((k) => S.acc.get(k)?.slot ?? 0));
  S.stats.judged++;
  const { opened, closed } = S.book.seen(coin.mint, trips, slot, Date.now());
  for (const g of opened) {
    S.stats.opens++;
    g.symbol = coin.symbol;
    log(`OPEN  ${coin.symbol} ${coin.mint} slot ${slot}: ${g.venues} gap ${g.gapPct.toFixed(2)}%, $${g.firstInUsd.toFixed(2)} in, +$${g.firstNetUsd.toFixed(4)} after every cost (tip $${g.tipUsd.toFixed(4)})${g.transferFeePct ? `, transfer fee ${g.transferFeePct}%` : ''}${g.direct ? '' : ' (not all direct legs)'}${g.rough ? ' (rough depth)' : ''} [${g.route}]`);
    fs.appendFile(LOG, `${JSON.stringify({ event: 'open', at: new Date().toISOString(), ...g })}\n`, () => {});
  }
  for (const g of closed) {
    g.closedBy = closedBy;
    if (closedBy !== 'a change') S.stats.closedByRecheck++;
    const at = (ms) => (g.ms >= ms ? `+$${g.netBy[ms].toFixed(4)}` : 'gone');
    log(`CLOSE ${coin.symbol} ${coin.mint} slot ${slot}: ${g.venues} open ${(g.ms / 1000).toFixed(1)} s, ${g.slots} slots; at 1 s ${at(1_000)}, at 3 s ${at(3_000)}, best +$${g.bestNetUsd.toFixed(4)}; closed by ${closedBy}`);
    fs.appendFile(LOG, `${JSON.stringify({ event: 'close', at: new Date().toISOString(), ...g })}\n`, () => {});
  }
}

/**
 * A gap still open RECHECK_MS after it opened: its coin's pools read afresh over HTTP and judged
 * again, once a gap. A websocket that missed a change (a dropped notification, a quiet socket)
 * would hold a gap open that is not there; this closes it, 'by a fresh read'.
 */
const rechecking = new Set();
async function recheckOpenGaps() {
  const now = Date.now();
  for (const g of S.book.open.values()) {
    if (g.recheckedAt || now - g.openedAt < RECHECK_MS || rechecking.has(g.coin)) continue;
    const coin = S.coins.get(g.coin);
    if (!coin) continue;
    rechecking.add(g.coin);
    for (const x of S.book.open.values()) if (x.coin === g.coin) x.recheckedAt = now;
    S.stats.rechecks++;
    readAll([...new Set([...coin.pools, ...coin.links].flatMap(L.accountsOf))])
      .then(() => judge(coin, 'a fresh read'))
      .catch((e) => log(`fresh read of ${coin.symbol} ${coin.mint}: ${said(e)}`))
      .finally(() => rechecking.delete(g.coin));
  }
}

/**
 * Every account a pool prices by that is not watched (lib/arb-listen.mjs watchedOf), read again: a
 * pair pool's own account (its owed fees), a band pool's tick arrays, a CLMM pool's fee config and
 * far-band map, and the bridge's.
 */
async function rereadPools() {
  const pools = [...[...S.coins.values()].flatMap((c) => [...c.pools, ...c.links]), ...(S.bridgePool ? [S.bridgePool] : [])];
  const keys = [...new Set(pools.flatMap((p) => L.accountsOf(p).filter((k) => !L.watchedOf(p).includes(k))))];
  if (!keys.length) return;
  await readAll(keys);
  S.stats.poolRereads++;
}

// ─── the websocket ─────────────────────────────────────────────────────────────────────
function listen(accounts, n) {
  let socket = null;
  const open = () => {
    const s = new WebSocket(WS);
    socket = s;
    const asked = new Map();
    const subs = new Map();
    let beat = null;
    s.onopen = async () => {
      log(`websocket ${n} open: subscribing to ${accounts.length} accounts`);
      for (const [i, a] of accounts.entries()) {
        if (socket !== s) return;
        asked.set(i + 1, a);
        s.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'accountSubscribe', params: [a, { encoding: 'base64', commitment: COMMITMENT }] }));
        await sleep(SUBSCRIBE_GAP_MS);
      }
      beat = setInterval(() => socket === s && s.send(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' })), KEEP_ALIVE_MS);
      await sleep(3_000);
      // Anything that changed while subscribing: read once more, then judge every coin.
      S.note = 'reading every watched account once more';
      try {
        await readAll(accounts);
      } catch (e) {
        log(`re-read after subscribing: ${said(e)}`);
      }
      S.note = null;
      S.stats.readyAt ||= Date.now();
      log(`websocket ${n} listening: ${subs.size} of ${accounts.length} subscriptions taken; judging its coins once`);
      for (const m of new Set(accounts.flatMap((a) => [...(S.coinsOf.get(a) ?? [])]))) judgeSoon(m);
    };
    s.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.method === 'accountNotification') {
        const a = subs.get(m.params?.subscription);
        const v = m.params?.result;
        if (!a || !v) return;
        S.stats.notes++;
        if (!keep(a, v.value ? Buffer.from(v.value.data[0], 'base64') : null, v.context.slot, v.value?.owner)) return;
        for (const c of S.coinsOf.get(a) ?? []) judgeSoon(c);
        return;
      }
      if (typeof m.id === 'number' && m.id > 0 && asked.has(m.id)) {
        if (typeof m.result === 'number') {
          subs.set(m.result, asked.get(m.id));
          S.stats.subscribed++;
        } else if (m.error) {
          S.stats.refusedSubs++;
          if (S.stats.refusedSubs <= 3) log(`subscription refused: ${String(m.error.message ?? m.error.code).slice(0, 120)}`);
        }
      }
    };
    s.onerror = () => {};
    s.onclose = (ev) => {
      if (beat) clearInterval(beat);
      if (socket !== s) return;
      S.stats.reconnects++;
      S.stats.subscribed -= subs.size;
      log(`websocket ${n} closed (${ev?.code ?? '?'}) with ${subs.size} subscriptions: opening again in 5 s`);
      setTimeout(open, 5_000);
    };
  };
  open();
}

/** The band and bin pools: how many are priced to the unit now, and how many are not, and why. */
function venuesNow() {
  const out = { priced: {}, adaptive: 0, noOracle: 0, noArrays: 0, stopped: 0 };
  for (const c of S.coins.values()) {
    for (const p of c.pools) {
      if (p.kind === 'pair') continue;
      const name = C.DEXES[p.dex]?.name ?? p.dex;
      if (p.stopped) out.stopped++;
      else if (p.oracle && !S.acc.get(p.oracle)?.data) out.noOracle++;
      else if (p.dex !== 'damm' && !(p.arrays ?? []).some((k) => S.acc.get(k)?.data)) out.noArrays++;
      else {
        out.priced[name] = (out.priced[name] ?? 0) + 1;
        if (p.oracle) out.adaptive++;
      }
    }
  }
  return out;
}

function snapshot() {
  const now = Date.now();
  const hours = S.stats.readyAt ? (now - S.stats.readyAt) / 3_600_000 : 0;
  const openNow = [...S.book.open.values()].map((g) => ({ ...g, symbol: S.coins.get(g.coin)?.symbol, ageMs: now - g.openedAt })).sort((a, b) => b.bestNetUsd - a.bestNetUsd).slice(0, 40);
  return JSON.stringify({
    at: now, note: S.note, listeningHours: hours, ruleFrom: S.ruleFrom, rule: { ...S.settings, capUsd: R.capUsd(S.settings), flashLoans: S.flashLoans },
    solUsd: S.usd.get(C.SOL_MINT) ?? null, coins: S.coins.size, pools: [...S.coins.values()].reduce((s, c) => s + c.pools.length, 0),
    poolsByVenue: Object.fromEntries(Object.keys(C.DEXES).map((d) => [C.DEXES[d].name, [...S.coins.values()].reduce((s, c) => s + c.pools.filter((p) => p.dex === d).length, 0)])),
    venues: venuesNow(),
    stats: S.stats, gaps: S.book.done.length + S.book.open.size,
    stage0: L.stage0Report([...S.book.done, ...S.book.open.values()], now),
    transferFeeCoins: [...S.coins.values()].filter((c) => c.cut > 0).map((c) => ({ mint: c.mint, symbol: c.symbol, pct: c.cut * 100 })),
    byRoute: S.book.counts(now), byVenue: S.book.counts(now, L.byEachVenue), openNow,
  });
}

const server = http.createServer((req, res) => {
  if (req.headers.host !== `127.0.0.1:${PORT}` && req.headers.host !== `localhost:${PORT}`) return res.writeHead(421).end();
  if (req.method !== 'GET') return res.writeHead(405).end();
  if (req.url === '/state.json') return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(snapshot());
  return res.writeHead(404).end();
});
server.on('error', (e) => {
  log(e.code === 'EADDRINUSE' ? `Port ${PORT} is taken: set ARB_LISTEN_PORT` : `stopped: ${said(e)}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => log(`Listen-only engine: http://127.0.0.1:${PORT}/state.json; gaps logged to ${LOG}; sends nothing`));

await discover();
const watched = [...new Set([BRIDGE, ...ATAS.map(([, a]) => a), ...[...S.coins.values()].flatMap((c) => [...c.pools, ...c.links]).flatMap(L.watchedOf)])];
log(`${S.coins.size} coins with 2+ pools, ${[...S.coins.values()].reduce((s, c) => s + c.pools.length, 0)} pools, ${watched.length} accounts to watch on ${redactRpcUrl(WS)}; judging with ${S.ruleFrom}: cap $${R.capUsd(S.settings)}, floor $${S.settings.minProfitUsd} + the network fee + a Jito tip (the larger of 20,000 lamports and 30% of the gain)${S.flashLoans ? ', SOL loans on' : ''}`);
for (let i = 0; i * ACCOUNTS_PER_SOCKET < watched.length; i++) {
  listen(watched.slice(i * ACCOUNTS_PER_SOCKET, (i + 1) * ACCOUNTS_PER_SOCKET), i + 1);
  await sleep(ACCOUNTS_PER_SOCKET * SUBSCRIBE_GAP_MS + 2_000);
}
setInterval(() => readRule().catch(() => {}), RULE_EVERY_MS);
setInterval(() => recheckOpenGaps().catch((e) => log(`fresh reads: ${said(e)}`)), 1_000);
setInterval(() => rereadPools().catch((e) => log(`pool re-read: ${said(e)}`)), POOL_REREAD_MS);
