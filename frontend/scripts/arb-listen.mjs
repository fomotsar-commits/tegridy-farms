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
 * The engine (owner 2026-11-07: "build it"; reports/Building the best Solana arb scanner.md):
 * both coin sets at once (ARB_COINS=both: the map's coins on the x·y = k venues AND the busiest
 * coins on every venue), and every trip that pays after every cost is HANDED to the robot the
 * moment it is judged: a record on the event stream at /events (lib/arb-listen.mjs handoverOf:
 * the route, each leg's pool, venue, direction and the accounts its exact quote walked, the size
 * and what each leg pays at it, the prices judged at) that stands HANDOVER_TTL_MS. The robot
 * (KEEPER_ENGINE_URL, keeper/engine.ts) builds every swap itself from its own read of the pools,
 * test-runs the trip and sends it under every rule it has, then posts what it did to /outcome,
 * so state.json's `outcomes` says how many handovers died before a trip could land: the one
 * number the report says decides whether a faster feed is worth paying for. This process still
 * holds no key and sends nothing itself.
 *
 *   node scripts/arb-listen.mjs        counts at http://127.0.0.1:8799/state.json; Ctrl+C stops it
 *                                      handovers at /handover.json and /events; POST /outcome
 *
 * Settings (environment): ARB_LISTEN_PORT (8799), ARB_RPC_URL (public mainnet), ARB_WS_URL (the
 * RPC's, as ws), ARB_ROBOT_URL (http://127.0.0.1:8792/state.json), ARB_LISTEN_LOG (each gap, JSON
 * lines; default in the system's temp folder), ARB_MAX_COINS, ARB_LISTEN_COMMITMENT (confirmed),
 * ARB_MAP_FILE (the map's arb-map.json: Stage 0), ARB_COINS (map | markets | both: both when a map
 * file is given, else markets), ARB_SCAN_RPC_URL (the one program-wide read
 * of our own pools, which publicnode refuses: the public mainnet RPC), ARB_RPC_GAP_MS (1500 between reads),
 * ARB_READ_BATCH (accounts a read: 100, publicnode 10), ARB_WS_PER_SOCKET (80),
 * ARB_MIN_DEPTH_USD (1000 a pool), ARB_RECHECK_MS (5000), ARB_POOL_REREAD_MS (120000),
 * ARB_MEME_PAIRS (on: a coin's pools priced in another memecoin, GRR/BOBO, are traded through
 * that memecoin's deepest SOL or USDC pool, SOL → BOBO → GRR → SOL; "off" leaves them out),
 * ARB_MEME_QUOTES (80: the most memecoins linked so), ARB_VERIFY_MS (1500: a paying trip counts,
 * and is handed over, only once every account of its pools was read over HTTP this recently;
 * ARB_VERIFY_RPC_URL, the public mainnet RPC by default, reads them in one call).
 *
 * The public mainnet websocket gives ~4 sockets × 80 accounts an IP and the robot uses it: point
 * ARB_RPC_URL and ARB_WS_URL at publicnode (measured 11-07: ~300 subscriptions a socket, updates
 * within a few ms of mainnet's) so this never crowds the robot.
 */
import { createHash } from 'node:crypto';
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
const COINS_MODE = process.env.ARB_COINS?.trim().toLowerCase() || (MAP_FILE ? 'both' : 'markets');
if (!['map', 'markets', 'both'].includes(COINS_MODE)) throw new Error(`ARB_COINS must be map, markets or both, not "${COINS_MODE}"`);
if (COINS_MODE !== 'markets' && !MAP_FILE) throw new Error(`ARB_COINS=${COINS_MODE} needs ARB_MAP_FILE`);
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
const MEME_PAIRS = !/^(off|no|false|0)$/i.test(process.env.ARB_MEME_PAIRS?.trim() ?? '');
const MEME_QUOTES_MAX = numEnv('ARB_MEME_QUOTES', 80);
const VERIFY_MS = numEnv('ARB_VERIFY_MS', 1_500);
const VERIFY_RPC = process.env.ARB_VERIFY_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
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

/** A read that failed on the wire (a reset, a timeout, no answer): tried again, up to three times, a few seconds apart. */
const transient = (e) => e?.name === 'TimeoutError' || /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(`${e?.message} ${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`);
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
        if (e.busy && tries < 2) {
          log(`${e.message}: resting ${rest / 1000} s`);
          next = Date.now() + rest;
          continue;
        }
        if (transient(e) && tries < 3) {
          log(`${e.message} (${e?.cause?.code ?? 'the wire'}): trying again in 5 s`);
          next = Date.now() + 5_000;
          continue;
        }
        throw e;
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
// A paying trip's accounts, read in ONE call (100 at most) so they are one snapshot: the public RPC takes 100 a call, publicnode 10.
const verifyRpc = gated(300, 10_000, callRpc(VERIFY_RPC));
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
  quoteLinks: new Map(), // pricing coin → the pool linking it to SOL or USDC
  memeQuotes: new Map(), // memecoin other coins are priced in → { symbol, decimals, program }
  usd: new Map([[C.USDC_MINT, 1]]),
  holds: new Map(),
  acc: new Map(), // address → { data, slot }: the newest seen
  coinsOf: new Map(),
  settings: R.ruleSettingsFromEnv(process.env, false),
  flashLoans: false,
  ruleFrom: 'not read yet',
  // A gap: a trip that pays after every cost a send pays (lib/arb-listen.mjs afterCosts).
  book: new L.GapBook({ pays: (t) => t.paysAll, net: (t) => t.netAllUsd }),
  // The handovers (lib/arb-listen.mjs handoverOf), the newest a route; and what the robot said it did with them.
  handover: new Map(),
  outcomes: new L.Outcomes(),
  // Watched accounts not being watched right now: a socket closed and is subscribing again, or
  // the host refused the subscription. A pool with one is judged (the gap book keeps its record)
  // but not handed over: its state here may be stale.
  unwatched: new Set(),
  // Accounts a subscription keeps fresh: taken, and read afresh after it was (a change since is sent).
  live: new Set(),
  // address → when it was last read over HTTP (ms): what a paying trip is verified by.
  readAt: new Map(),
  stats: { notes: 0, judged: 0, subscribed: 0, refusedSubs: 0, opens: 0, reconnects: 0, slot: 0, readyAt: 0, rechecks: 0, closedByRecheck: 0, poolRereads: 0, arrayReads: 0, needs: 0, staleBins: 0, unpriced: 0, judgeMs: 0, judgeMaxMs: 0, handovers: 0, notHanded: 0, notHandedUnwatched: 0, verifyReads: 0, unverified: 0, verifiedPaying: 0 },
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
    const at = Date.now();
    for (const k of part) S.readAt.set(k, at);
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
    const poolSlot = S.acc.get(p.address).slot;
    const array = (index) => {
      const k = V.dlmmArrayAddress(p.address, index);
      const a = S.acc.get(k);
      if (a === undefined) {
        want(k);
        return undefined;
      }
      // An array no subscription keeps fresh (read on demand), read before the pool last changed:
      // the swap that changed the pool may have changed it too (11-07: Baton's pool priced a bin
      // low, 1.0% over the robot's quote). Read again before it prices anything.
      if (!S.live.has(k) && a.slot < poolSlot) {
        S.stats.staleBins++;
        needs.set(k, p.address);
        return undefined;
      }
      return a.data ? decodedOf(k, V.decodeBinArray) : null;
    };
    const now = Date.now() / 1000;
    // A walk that reached an array not read (or stale) is no quote: never a part-filled amount.
    return (x) => {
      const q = V.dlmmQuote(s, BigInt(Math.floor(x)), aToB, now, array);
      return q.needs === null && q.used === BigInt(Math.floor(x)) ? Number(q.out) : 0;
    };
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
      const pools = [...(coin?.pools ?? []), ...(coin?.links ?? []), ...(S.bridgePool ? [S.bridgePool] : [])];
      for (const [k, poolAddress] of fresh) {
        const p = pools.find((x) => x.address === poolAddress);
        if (p && S.acc.get(k)?.data) {
          p.arrays = [...new Set([...(p.arrays ?? []), k])].slice(-12);
          if (p.kind === 'bins') watchLater(k);
        }
      }
      if (coin) judgeSoon(mint);
    })
    .catch((e) => log(`reading arrays for ${mint}: ${said(e)}`))
    .finally(() => fresh.forEach(([k]) => pendingReads.delete(k)));
}

/** A paying trip's accounts read over HTTP in one call (one snapshot), then its coin judged again; once a coin at a time. */
const verifying = new Set();
function verifySoon(coin, keys) {
  if (verifying.has(coin.mint)) return;
  verifying.add(coin.mint);
  S.stats.verifyReads++;
  const want = keys.slice(0, 100);
  verifyRpc('getMultipleAccounts', [want, { encoding: 'base64', commitment: COMMITMENT }])
    .then((r) => {
      if (!Array.isArray(r?.value) || r.value.length !== want.length) return;
      const at = Date.now();
      want.forEach((k, j) => {
        keep(k, r.value[j] ? Buffer.from(r.value[j].data[0], 'base64') : null, r.context.slot, r.value[j]?.owner);
        // Read now: verified even when the copy here was already as new (keep refused an older one).
        S.readAt.set(k, at);
      });
      judge(coin, 'a verify read');
    })
    .catch((e) => log(`verify read of ${coin.symbol} ${coin.mint}: ${said(e)}`))
    .finally(() => verifying.delete(coin.mint));
}

const quoteOf = (p, mint) => (p.mintA === mint ? p.mintB : p.mintA);
/** A pricing coin's figures: SOL and USDC, the fixed pricing coins (C.QUOTES), or a memecoin other coins are priced in. */
const quoteMeta = (m) => C.COINS[m] ?? C.QUOTES[m] ?? S.memeQuotes.get(m) ?? null;
const decimalsOf = (m) => quoteMeta(m).decimals;
const linkedQuote = (q) => Boolean(C.COINS[q] || (quoteMeta(q) && S.quoteLinks.get(q)));
/** A mint's supply from its account (read), or null. */
const supplyOf = (m) => {
  const d = S.acc.get(m)?.data;
  return d && d.length >= 44 ? d.readBigUInt64LE(36) : null;
};
/** B per A, raw, at zero size: a bin pool's active bin, else the depth's ratio. */
const perA = (depth) => depth.spot ?? depth.b / depth.a;

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
  // A coin both sources list keeps the first ticker it was given.
  const was = S.coins.get(m);
  S.coins.set(m, { mint: m, symbol: String(symbolHint || was?.symbol || safety.symbol || '?').slice(0, 16), decimals: facts.decimals, supply, cut, pools: [], links: [] });
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

/**
 * Stage 0: the chain-wide map's coins and pools (lib/arb-listen.mjs coinsFromMap): mint → pool
 * addresses. The map holds only pools priced in SOL or USDC; with ARB_MEME_PAIRS each coin's
 * listing adds its pools priced in another memecoin (one DexScreener read a coin).
 */
async function listFromMap() {
  S.note = `the map: ${MAP_FILE}`;
  const rows = L.coinsFromMap(JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')), { max: MAX_COINS });
  await readAll(rows.map((r) => r.mint));
  const listed = new Map();
  let memePools = 0;
  for (const r of rows) {
    if (!admit(r.mint, r.symbol)) continue;
    const addrs = r.pools.map((p) => p.address);
    if (MEME_PAIRS) {
      S.note = `memecoin pairs of ${r.mint}`;
      try {
        const meme = C.poolsFromListing(await dexscreener(r.mint), r.mint, MIN_DEPTH_USD).filter((f) => !C.COINS[f.other] && f.other !== r.mint).slice(0, LISTED_POOLS);
        memePools += meme.length;
        addrs.push(...meme.map((f) => f.address));
      } catch (e) {
        log(`DexScreener ${r.mint}: ${said(e)}`);
      }
    }
    listed.set(r.mint, addrs);
  }
  log(`the map gives ${rows.length} coins with 2+ deep pools the robot can price; ${listed.size} pass the robot's token gate${MEME_PAIRS ? `; their listings add ${memePools} pools priced in another coin` : ''}`);
  return listed;
}

/**
 * Memecoins other coins are priced in (a GRR/BOBO pool prices GRR in BOBO; owner 2026-11-07:
 * "exotic pairs of memecoins"), each linked to SOL or USDC by its deepest pool there, as BAYLA is
 * by our BAYLA/SOL pool, so SOL → BOBO → GRR → SOL is one trip of three swaps (lib/arb-chain.mjs
 * tripsFor). A memecoin the robot's token gate refuses, or one with a transfer fee (not counted on
 * a link's hop), is not linked; nor one with no SOL or USDC pool MIN_DEPTH_USD deep. The most-used
 * MEME_QUOTES_MAX at most. Its SOL and USDC pools are those found when it is a coin here, else its
 * listing's (one DexScreener read).
 */
async function linkMemeQuotes(withFees) {
  const uses = new Map();
  for (const [m, ps] of withFees) {
    for (const p of ps) {
      const q = quoteOf(p, m);
      if (!C.COINS[q] && !C.QUOTES[q]) uses.set(q, (uses.get(q) ?? 0) + 1);
    }
  }
  const wanted = [...uses].sort((a, b) => b[1] - a[1]).slice(0, MEME_QUOTES_MAX).map(([q]) => q);
  if (!wanted.length) return;
  S.note = `linking ${wanted.length} memecoins other coins are priced in`;
  await readAll(wanted);
  const options = new Map();
  for (const q of wanted) {
    const a = S.acc.get(q);
    const safety = TS.classifyToken(q, a?.data ? { address: q, owner: a.owner, data: a.data, lamports: 0 } : null, null);
    const facts = safety.kind === 'read' ? safety.facts : null;
    if (R.tokenGate(safety) || !facts) continue;
    const fee = TF.feeNow(facts.transferFee ?? null, null);
    if (fee && fee.maximumFee > 0n && fee.basisPoints > 0) continue;
    let addrs = (withFees.get(q) ?? []).filter((p) => C.COINS[quoteOf(p, q)]).map((p) => p.address);
    let symbol = S.coins.get(q)?.symbol ?? null;
    if (!addrs.length) {
      try {
        const json = await dexscreener(q);
        addrs = C.poolsFromListing(json, q, MIN_DEPTH_USD).filter((f) => C.COINS[f.other]).slice(0, 4).map((f) => f.address);
        symbol ??= (Array.isArray(json) ? json : []).map((x) => (x?.baseToken?.address === q ? x.baseToken.symbol : x?.quoteToken?.address === q ? x.quoteToken.symbol : null)).find(Boolean) ?? null;
      } catch (e) {
        log(`DexScreener ${q}: ${said(e)}`);
      }
    }
    if (addrs.length) options.set(q, { decimals: facts.decimals, program: a.owner, symbol: String(symbol || safety.symbol || q.slice(0, 6)).slice(0, 16), addrs });
  }
  await readAll([...new Set([...options.values()].flatMap((o) => o.addrs))]);
  const decoded = new Map();
  for (const k of new Set([...options.values()].flatMap((o) => o.addrs))) {
    const a = S.acc.get(k);
    const dex = a?.data && C.dexOfProgram(a.owner);
    const p = dex && C.decodePool(dex, k, a.data);
    if (p && !p.stopped) decoded.set(k, p);
  }
  await readConfigs([...decoded.values()]);
  const priced = new Map([...decoded].map(([k, p]) => [k, C.withFee(p, S.configs)]).filter(([, p]) => p));
  await readVenueAccounts([...priced.values()]);
  await readAll([...new Set([...priced.values()].flatMap(L.accountsOf))]);
  for (const [q, o] of options) {
    let best = null;
    for (const k of o.addrs) {
      const p = priced.get(k);
      const c = p && [p.mintA, p.mintB].includes(q) ? quoteOf(p, q) : null;
      if (!c || !C.COINS[c]) continue;
      const depth = C.depthOf(p, amounts, binsOf);
      if (!depth || depth.rough) continue;
      const usd = ((c === p.mintA ? depth.a : depth.b) / 10 ** C.COINS[c].decimals) * (S.usd.get(c) ?? 0);
      if (usd >= MIN_DEPTH_USD && !(best?.usd >= usd)) best = { p, depth, c, usd };
    }
    if (!best) continue;
    const { p, depth, c } = best;
    S.memeQuotes.set(q, { symbol: o.symbol, decimals: o.decimals, program: o.program });
    S.quoteLinks.set(q, p);
    S.usd.set(q, (p.mintA === q ? perA(depth) : 1 / perA(depth)) * 10 ** (o.decimals - C.COINS[c].decimals) * S.usd.get(c));
  }
  log(`memecoins other coins are priced in: ${S.memeQuotes.size} of ${wanted.length} linked to SOL or USDC (${[...S.memeQuotes.values()].slice(0, 20).map((x) => x.symbol).join(', ')}${S.memeQuotes.size > 20 ? ', …' : ''})`);
}

/**
 * The coins and their pools: listed, owned and decoded on chain, at least MIN_DEPTH_USD deep,
 * POOLS_PER_COIN a coin at most. ARB_COINS says which lists: the map's (Stage 0), the markets'
 * (our pools' coins and the busiest), or both at once, a coin on both keeping every pool either names.
 */
async function discover() {
  await readBasics();
  const listed = new Map();
  const add = (m, addrs) => listed.set(m, [...new Set([...(listed.get(m) ?? []), ...addrs])]);
  if (COINS_MODE !== 'markets') for (const [m, addrs] of await listFromMap()) add(m, addrs);
  if (COINS_MODE !== 'map') for (const [m, addrs] of await listFromMarkets()) add(m, addrs);
  await readAll([...new Set([...listed.values()].flat())]);
  const candidates = new Map();
  for (const [m, addrs] of listed) {
    const found = [...new Set(addrs)].map((k) => ({ k, a: S.acc.get(k) })).filter(({ a }) => a?.data && C.dexOfProgram(a.owner));
    // Whatever a list says, a pool is what its owner on chain proves it is; every venue here is priced to the unit.
    const pricedIn = (q) => linkedQuote(q) || (MEME_PAIRS && q !== m && !C.COINS[q] && !C.QUOTES[q]);
    candidates.set(m, found.map(({ k, a }) => C.decodePool(C.dexOfProgram(a.owner), k, a.data)).filter((p) => p && [p.mintA, p.mintB].includes(m) && pricedIn(quoteOf(p, m))));
  }
  await readConfigs([...candidates.values()].flat());
  const withFees = new Map([...candidates].map(([m, ps]) => [m, ps.map((p) => C.withFee(p, S.configs)).filter(Boolean)]));
  if (MEME_PAIRS) await linkMemeQuotes(withFees);
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
    coin.links = [...new Set(coin.pools.map((p) => quoteOf(p, m)).filter((q) => !C.COINS[q] && S.quoteLinks.get(q)))].map((q) => S.quoteLinks.get(q));
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
    // A link pairs its pricing coin with SOL or USDC.
    const q = C.COINS[l.mintA] ? l.mintB : l.mintA;
    const decoded = C.decodePool(l.dex, l.address, dataOf(l.address));
    const read = decoded && { ...decoded, arrays: l.arrays ?? [] };
    const live = read && C.withFee(read, S.configs, read.dex === 'pumpswap' ? { depth: C.depthOf(read, amounts), supply: read.mintA === q ? supplyOf(q) : null } : undefined);
    const depth = live && live.mintA && C.depthOf(live, amounts, binsOf);
    if (!depth) continue;
    const c = quoteOf(live, q);
    S.usd.set(q, (live.mintA === q ? perA(depth) : 1 / perA(depth)) * 10 ** (decimalsOf(q) - decimalsOf(c)) * (S.usd.get(c) ?? NaN));
    quotes.set(q, { pool: live, depth, decimals: decimalsOf(q) });
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
  const now = Date.now();
  // A gap on the websocket's word alone is not one: measured 11-07, publicnode delivered none of
  // the changes to five quiet memecoin pools in two minutes (Solana's own socket: 10) and closes
  // every socket every few minutes, so a pool's copy here can be minutes old. A trip that pays
  // counts, and is handed over, only once every account its pools hold was read over HTTP within
  // VERIFY_MS; one that was not has them read now, in one call, and its coin judged again. A gap
  // already open stays open while it is checked.
  const judgedPools = [...pools, ...coin.links, ...(bridge ? [bridge.pool] : [])];
  const byAddress = new Map(judgedPools.map((p) => [p.address, p]));
  const accountsOfTrip = (t) => [...new Set(t.legs.flatMap((l) => (byAddress.has(l.pool) ? L.accountsOf(byAddress.get(l.pool)) : [l.pool])))];
  const toVerify = new Set();
  for (const t of trips) {
    if (!t.paysAll) continue;
    const keys = accountsOfTrip(t);
    if (keys.every((k) => now - (S.readAt.get(k) ?? 0) <= VERIFY_MS)) {
      S.stats.verifiedPaying++;
      continue;
    }
    t.unverified = true;
    S.stats.unverified++;
    for (const k of keys) toVerify.add(k);
  }
  if (toVerify.size) verifySoon(coin, [...toVerify]);
  const openHere = new Set([...S.book.open.values()].filter((g) => g.coin === coin.mint).map((g) => g.route));
  const forBook = trips.filter((t) => !(t.unverified && !openHere.has(L.routeOf(t))));
  const { opened, closed } = S.book.seen(coin.mint, forBook, slot, now);
  handOver(coin, trips.filter((t) => !t.unverified), judgedPools, slot, now);
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

// ─── handing over to the robot ───────────────────────────────────────────────────────
const sseListeners = new Set();
/** A mint's token program: the robot's coins' and the pricing coins' are known, a coin's is its mint account's owner. */
const programOf = (m) => (C.COINS[m] ? C.TOKEN_PROGRAM : (quoteMeta(m)?.program ?? S.acc.get(m)?.owner ?? null));
/** The handovers still standing, best first. */
const standingHandovers = (now) => [...S.handover.values()].filter((r) => L.handoverStands(r, now)).sort((a, b) => b.netAllUsd - a.netAllUsd);

/**
 * Every trip of this judgement that pays after every cost, handed to the robot: a record kept
 * here (the newest a route, for /handover.json) and written to every open /events stream at
 * once. `pools` are the coin's pools as judged (with the arrays each exact quote read).
 */
function handOver(coin, trips, pools, slot, now) {
  const byAddress = new Map(pools.map((p) => [p.address, p]));
  let any = false;
  for (const t of trips) {
    // Only verified trips come here (judgeNow): every account of their pools read over HTTP within
    // VERIFY_MS, so a pool whose socket is resubscribing, or whose subscription was refused, is
    // handed over too (f3671dc62 held those back: 1-2 minutes in every ~10 on publicnode).
    if (!t.paysAll || t.unverified) continue;
    const rec = L.handoverOf(t, { coin, slot, now, usd: S.usd, programOf, arraysOf: (pool) => byAddress.get(pool)?.arrays ?? [] });
    if (!rec) {
      S.stats.notHanded++;
      continue;
    }
    S.handover.set(rec.route, rec);
    S.stats.handovers++;
    any = true;
    const g = S.book.open.get(rec.route);
    if (g) g.handed = (g.handed ?? 0) + 1;
    const body = `event: handover\ndata: ${JSON.stringify(rec)}\n\n`;
    for (const res of sseListeners) res.write(body);
  }
  if (any && S.handover.size > 500) for (const [route, r] of S.handover) if (!L.handoverStands(r, now)) S.handover.delete(route);
}

/** An /events stream: the handovers standing now, then each new one as it is judged; a comment every 15 s keeps it open. */
function serveEvents(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 1000\n\n');
  for (const rec of standingHandovers(Date.now())) res.write(`event: handover\ndata: ${JSON.stringify(rec)}\n\n`);
  sseListeners.add(res);
  const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(beat);
    sseListeners.delete(res);
  });
}

/** POST /outcome: what the robot did with a handover (lib/arb-listen.mjs outcomeOf), from this computer only. */
function takeOutcome(req, res) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 4_096) req.destroy();
  });
  req.on('end', () => {
    let o = null;
    try {
      o = L.outcomeOf(JSON.parse(body));
    } catch {
      // said below
    }
    if (!o) return res.writeHead(400).end();
    S.outcomes.add(o, Date.now());
    fs.appendFile(LOG, `${JSON.stringify({ event: 'outcome', at: new Date().toISOString(), ...o })}\n`, () => {});
    log(`ROBOT ${o.outcome}${o.ms === null ? '' : ` ${o.ms} ms after the judgement`}: ${o.route}${o.note ? ` (${o.note})` : ''}`);
    return res.writeHead(204).end();
  });
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
  // What no subscription watches: a pair pool's own account, the tick arrays, and any account whose subscription was refused.
  const keys = [...new Set([...pools.flatMap((p) => L.accountsOf(p).filter((k) => !L.watchedOf(p).includes(k))), ...S.unwatched])];
  if (!keys.length) return;
  await readAll(keys);
  S.stats.poolRereads++;
}

// ─── the websocket ─────────────────────────────────────────────────────────────────────
/**
 * One websocket watching `accounts` (an array that `add` may grow later): subscribed one by one,
 * read afresh once all are taken, and only then live (S.live) and handed over; reopened 5 s after
 * it closes, every account unwatched (and not live) until it is listening again.
 */
function listen(accounts, n) {
  let socket = null;
  let ready = false;
  let asked = new Map();
  const open = () => {
    const s = new WebSocket(WS);
    socket = s;
    ready = false;
    asked = new Map();
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
      // Read afresh and subscribed: watched again. A refused one stays unwatched until a later socket takes it.
      for (const a of subs.values()) {
        S.unwatched.delete(a);
        S.live.add(a);
      }
      ready = socket === s;
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
          const a = asked.get(m.id);
          subs.set(m.result, a);
          S.stats.subscribed++;
          // Taken after the socket was listening (an array found later): live once read afresh.
          if (ready) {
            readAll([a])
              .then(() => {
                if (socket === s) S.live.add(a);
              })
              .catch((e) => log(`reading ${a} after subscribing: ${said(e)}`));
          }
        } else if (m.error) {
          S.stats.refusedSubs++;
          S.unwatched.add(asked.get(m.id));
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
      ready = false;
      for (const a of accounts) {
        S.unwatched.add(a);
        S.live.delete(a);
      }
      log(`websocket ${n} closed (${ev?.code ?? '?'}) with ${subs.size} subscriptions: opening again in 5 s`);
      setTimeout(open, 5_000);
    };
  };
  open();
  return {
    size: () => accounts.length,
    /** One more account, subscribed now when the socket is listening, else with the rest when it opens. */
    add(k) {
      accounts.push(k);
      if (!ready || socket?.readyState !== WebSocket.OPEN) return;
      asked.set(accounts.length, k);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: accounts.length, method: 'accountSubscribe', params: [k, { encoding: 'base64', commitment: COMMITMENT }] }));
    },
  };
}

// Bin arrays found after the start (a price walked past those read then): watched on a socket of
// their own, opened once the others are; found before it opens, they wait in `later`.
const later = [];
const watchedAtStart = new Set();
let spare = null;
function watchLater(k) {
  if (watchedAtStart.has(k) || later.includes(k) || later.length >= ACCOUNTS_PER_SOCKET) return;
  if (spare) spare.add(k);
  else later.push(k);
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
    memeQuotes: [...S.memeQuotes].map(([mint, q]) => ({ mint, symbol: q.symbol, usd: S.usd.get(mint) ?? null, link: S.quoteLinks.get(mint)?.address, venue: C.DEXES[S.quoteLinks.get(mint)?.dex]?.name, pricedIn: [...S.coins.values()].filter((c) => c.links.some((l) => l === S.quoteLinks.get(mint))).length })),
    poolsByVenue: Object.fromEntries(Object.keys(C.DEXES).map((d) => [C.DEXES[d].name, [...S.coins.values()].reduce((s, c) => s + c.pools.filter((p) => p.dex === d).length, 0)])),
    venues: venuesNow(),
    stats: S.stats, gaps: S.book.done.length + S.book.open.size, unwatched: S.unwatched.size,
    handover: standingHandovers(now), outcomes: S.outcomes.counts(), robotSaid: S.outcomes.latest.slice(0, 20),
    stage0: L.stage0Report([...S.book.done, ...S.book.open.values()], now),
    transferFeeCoins: [...S.coins.values()].filter((c) => c.cut > 0).map((c) => ({ mint: c.mint, symbol: c.symbol, pct: c.cut * 100 })),
    byRoute: S.book.counts(now), byVenue: S.book.counts(now, L.byEachVenue), openNow,
  });
}

const server = http.createServer((req, res) => {
  if (req.headers.host !== `127.0.0.1:${PORT}` && req.headers.host !== `localhost:${PORT}`) return res.writeHead(421).end();
  if (req.method === 'POST' && req.url === '/outcome') return takeOutcome(req, res);
  if (req.method !== 'GET') return res.writeHead(405).end();
  if (req.url === '/state.json') return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(snapshot());
  if (req.url === '/handover.json') return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ at: Date.now(), handover: standingHandovers(Date.now()) }));
  if (req.url === '/events') return serveEvents(req, res);
  // What this process holds for some accounts (?k=a,b,…; 40 at most): each one's slot, whether a
  // subscription keeps it fresh, and a hash of its data, to compare with the chain's.
  if (req.url.startsWith('/accounts?')) {
    const keys = (new URL(req.url, 'http://x').searchParams.get('k') ?? '').split(',').filter((k) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(k)).slice(0, 40);
    const body = Object.fromEntries(keys.map((k) => {
      const a = S.acc.get(k);
      return [k, a ? { slot: a.slot, live: S.live.has(k), unwatched: S.unwatched.has(k), sha: a.data ? createHash('sha256').update(a.data).digest('hex').slice(0, 16) : null } : null];
    }));
    return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ at: Date.now(), slot: S.stats.slot, accounts: body }));
  }
  return res.writeHead(404).end();
});
server.on('error', (e) => {
  log(e.code === 'EADDRINUSE' ? `Port ${PORT} is taken: set ARB_LISTEN_PORT` : `stopped: ${said(e)}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => log(`Engine: http://127.0.0.1:${PORT}/state.json; handovers for the robot at /events (standing ${L.HANDOVER_TTL_MS} ms each); gaps logged to ${LOG}; coins from ${COINS_MODE === 'both' ? 'the map and the markets' : COINS_MODE === 'map' ? 'the map' : 'the markets'}; this process sends nothing`));

try {
  await discover();
} catch (e) {
  log(`stopped while finding the coins and pools: ${said(e)}`);
  process.exit(1);
}
const watched = [...new Set([BRIDGE, ...ATAS.map(([, a]) => a), ...[...S.coins.values()].flatMap((c) => [...c.pools, ...c.links]).flatMap(L.watchedOf)])];
// Nothing is handed over until its socket is listening and has read its accounts afresh.
S.unwatched = new Set(watched);
log(`${S.coins.size} coins with 2+ pools, ${[...S.coins.values()].reduce((s, c) => s + c.pools.length, 0)} pools, ${watched.length} accounts to watch on ${redactRpcUrl(WS)}; judging with ${S.ruleFrom}: cap $${R.capUsd(S.settings)}, floor $${S.settings.minProfitUsd} + the network fee + a Jito tip (the larger of 20,000 lamports and 30% of the gain)${S.flashLoans ? ', SOL loans on' : ''}`);
for (const k of watched) watchedAtStart.add(k);
let sockets = 0;
for (let i = 0; i * ACCOUNTS_PER_SOCKET < watched.length; i++) {
  listen(watched.slice(i * ACCOUNTS_PER_SOCKET, (i + 1) * ACCOUNTS_PER_SOCKET), ++sockets);
  await sleep(ACCOUNTS_PER_SOCKET * SUBSCRIBE_GAP_MS + 2_000);
}
spare = listen(later, ++sockets);
setInterval(() => readRule().catch(() => {}), RULE_EVERY_MS);
setInterval(() => recheckOpenGaps().catch((e) => log(`fresh reads: ${said(e)}`)), 1_000);
setInterval(() => rereadPools().catch((e) => log(`pool re-read: ${said(e)}`)), POOL_REREAD_MS);
