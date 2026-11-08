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
 *   node scripts/arb-listen.mjs        counts at http://127.0.0.1:8799/state.json; Ctrl+C stops it
 *
 * Settings (environment): ARB_LISTEN_PORT (8799), ARB_RPC_URL (public mainnet), ARB_WS_URL (the
 * RPC's, as ws), ARB_ROBOT_URL (http://127.0.0.1:8792/state.json), ARB_LISTEN_LOG (each gap, JSON
 * lines; default <home>/.tegridy-arb/listen/gaps.jsonl), ARB_MAX_COINS, ARB_LISTEN_COMMITMENT (confirmed).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

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
const R = await import(pathToFileURL(path.join(HERE, '..', 'src', 'lib', 'solana', 'keeper', 'rule.ts')).href);
const TS = await import(pathToFileURL(path.join(HERE, '..', 'src', 'lib', 'solana', 'lp', 'tokenSafety.ts')).href);

const PORT = Number(process.env.ARB_LISTEN_PORT || 8799);
const RPC = process.env.ARB_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const WS = process.env.ARB_WS_URL?.trim() || RPC.replace(/^http/i, 'ws');
const ROBOT_URL = process.env.ARB_ROBOT_URL?.trim() || 'http://127.0.0.1:8792/state.json';
const LOG = process.env.ARB_LISTEN_LOG?.trim() || path.join(C.privateDir('listen'), 'gaps.jsonl');
const COMMITMENT = process.env.ARB_LISTEN_COMMITMENT?.trim() || 'confirmed';
const MAX_COINS = Number(process.env.ARB_MAX_COINS) || Infinity;
// Gentler than the scanner's 0.7 s: the robot reads the same public RPC from this IP.
const RPC_GAP_MS = 1_500;
const GECKO_PAGES = 5;
const TRENDING_PAGES = 2;
const LISTED_POOLS = 12;
const POOLS_PER_COIN = 10;
const MIN_DEPTH_USD = 1_000;
const BRIDGE = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
// One swap moves two vaults in one slot; their updates arrive apart. A coin is judged once both are in.
const JUDGE_AFTER_MS = 250;
// The public websocket closes a socket (1013, "try again later") that asks for ~100 accounts in
// 6 s (walked 11-06: 446 asked at 25 a second, closed at 99 every time). Each socket takes fewer,
// slower. It also refused a 5th socket from this IP (1006 at once): 4 × 80 accounts is what it gave.
const SUBSCRIBE_GAP_MS = 150;
const ACCOUNTS_PER_SOCKET = 80;
const KEEP_ALIVE_MS = 25_000;
const RULE_EVERY_MS = 5 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const said = (e) => (e instanceof Error ? e.message : String(e));
// A websocket's answer and a coin's ticker reach the log: one line each, nothing else (lib/arb-chain.mjs oneLine).
const log = (line) => console.log(`${new Date().toISOString()}  ${C.oneLine(line)}`);

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
const rpc = gated(RPC_GAP_MS, 30_000, async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  if (r.status === 429) throw Object.assign(new Error(`RPC ${method} refused for speed`), { busy: true });
  if (!r.ok) throw new Error(`RPC ${method} answered ${r.status}`);
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(`RPC ${method}: ${String(j.error.message ?? j.error.code).slice(0, 160)}`), { busy: j.error.code === 429 });
  return j.result;
});
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
  book: new L.GapBook(),
  stats: { notes: 0, judged: 0, subscribed: 0, refusedSubs: 0, opens: 0, reconnects: 0, slot: 0, readyAt: 0 },
  note: 'starting…',
};
const owner = new PublicKey(C.ROBOT.wallet);
const ATAS = Object.keys(C.COINS).map((m) => [m, getAssociatedTokenAddressSync(new PublicKey(m), owner, true).toBase58()]);

/** Accounts in chunks of 100, each chunk from one slot; kept as the newest seen. */
async function readAll(keys) {
  for (let i = 0; i < keys.length; i += 100) {
    const part = keys.slice(i, i + 100);
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
  return depth ? { pool: bridge, depth } : null;
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

/** The coins and their pools, as the scanner finds them (arb-scanner.mjs readUniverse, discover). */
async function discover() {
  await readAll([...ATAS.map(([, a]) => a), BRIDGE]);
  await readRule();
  const ours = await rpc('getProgramAccounts', [C.DEXES.ours.program, { encoding: 'base64', commitment: COMMITMENT, filters: [{ dataSize: C.DEXES.ours.size }] }]);
  const ourPools = new Map();
  const symbols = new Map();
  for (const o of ours) {
    const p = C.decodePool('ours', o.pubkey, Buffer.from(o.account.data[0], 'base64'));
    if (!p) continue;
    const m = [p.mintA, p.mintB].find((x) => !C.COINS[x] && !C.QUOTES[x]) ?? [p.mintA, p.mintB].find((x) => !C.COINS[x]);
    if (!m) continue;
    symbols.set(m, null);
    ourPools.set(m, [...(ourPools.get(m) ?? []), p]);
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
  // Each coin: the robot's token gate on its mint, then its listed pools.
  const listed = new Map();
  for (const m of mints) {
    const a = S.acc.get(m);
    const safety = TS.classifyToken(m, a?.data ? { address: m, owner: a.owner, data: a.data, lamports: 0 } : null, null);
    const facts = safety.kind === 'read' ? safety.facts : null;
    if (R.tokenGate(safety) || !facts) continue;
    S.note = `pools of ${m}`;
    let json = [];
    try {
      json = await dexscreener(m);
    } catch (e) {
      log(`DexScreener ${m}: ${said(e)}`);
    }
    const listedSym = (Array.isArray(json) ? json : []).map((p) => (p?.baseToken?.address === m ? p.baseToken.symbol : p?.quoteToken?.address === m ? p.quoteToken.symbol : null)).find(Boolean);
    const supply = a.data.length >= 44 ? a.data.readBigUInt64LE(36) : null;
    S.coins.set(m, { mint: m, symbol: String(symbols.get(m) || listedSym || safety.symbol || '?').slice(0, 16), decimals: facts.decimals, supply, pools: [], links: [] });
    listed.set(m, C.poolsFromListing(json, m, MIN_DEPTH_USD).slice(0, LISTED_POOLS).map((f) => f.address));
  }
  await readAll([...new Set([...listed.values()].flat())]);
  const candidates = new Map();
  for (const [m, addrs] of listed) {
    const found = addrs.map((k) => ({ k, a: S.acc.get(k) })).filter(({ a }) => a?.data && C.dexOfProgram(a.owner) && C.dexOfProgram(a.owner) !== 'ours');
    const pools = [...found.map(({ k, a }) => C.decodePool(C.dexOfProgram(a.owner), k, a.data)).filter((p) => p && [p.mintA, p.mintB].includes(m) && linkedQuote(quoteOf(p, m))), ...(ourPools.get(m) ?? [])];
    candidates.set(m, pools);
  }
  await readConfigs([...candidates.values()].flat());
  const withFees = new Map([...candidates].map(([m, ps]) => [m, ps.map((p) => C.withFee(p, S.configs)).filter(Boolean)]));
  await readAll([...new Set([...withFees.values()].flat().flatMap(L.accountsOf))]);
  for (const [m, pools] of withFees) {
    const deep = [];
    for (const p of pools) {
      const depth = C.depthOf(p, amounts);
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

function judge(coin) {
  if (!coin) return;
  const bridge = solPrice();
  if (!bridge) return;
  let pools = coin.pools.map((p) => C.withFee(C.decodePool(p.dex, p.address, dataOf(p.address)) ?? {}, S.configs)).filter((p) => p && p.mintA);
  const depths = new Map(pools.map((p) => [p.address, C.depthOf(p, amounts)]));
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
  const trips = C.tripsFor(pools, { token: coin.mint, decimals: coin.decimals, depths, usd: S.usd, holds, bridge, quotes, settings: S.settings });
  const slot = Math.max(...[...coin.pools, ...coin.links].flatMap(L.accountsOf).map((k) => S.acc.get(k)?.slot ?? 0));
  S.stats.judged++;
  const { opened, closed } = S.book.seen(coin.mint, trips, slot, Date.now());
  for (const g of opened) {
    S.stats.opens++;
    log(`OPEN  ${coin.symbol} ${coin.mint} slot ${slot}: ${g.venues} gap ${g.gapPct.toFixed(2)}%, $${g.bestInUsd.toFixed(2)} in, +$${g.bestNetUsd.toFixed(4)} net${g.direct ? ' (direct legs)' : ''}${g.rough ? ' (rough depth)' : ''}`);
    fs.appendFile(LOG, `${JSON.stringify({ event: 'open', at: new Date().toISOString(), symbol: coin.symbol, ...g })}\n`, () => {});
  }
  for (const g of closed) {
    log(`CLOSE ${coin.symbol} ${coin.mint} slot ${slot}: ${g.venues} open ${(g.ms / 1000).toFixed(1)} s, ${g.slots} slots, best +$${g.bestNetUsd.toFixed(4)}`);
    fs.appendFile(LOG, `${JSON.stringify({ event: 'close', at: new Date().toISOString(), symbol: coin.symbol, ...g })}\n`, () => {});
  }
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

function snapshot() {
  const now = Date.now();
  const hours = S.stats.readyAt ? (now - S.stats.readyAt) / 3_600_000 : 0;
  const openNow = [...S.book.open.values()].map((g) => ({ ...g, symbol: S.coins.get(g.coin)?.symbol, ageMs: now - g.openedAt })).sort((a, b) => b.bestNetUsd - a.bestNetUsd).slice(0, 40);
  return JSON.stringify({
    at: now, note: S.note, listeningHours: hours, ruleFrom: S.ruleFrom, rule: { ...S.settings, capUsd: R.capUsd(S.settings), flashLoans: S.flashLoans },
    solUsd: S.usd.get(C.SOL_MINT) ?? null, coins: S.coins.size, pools: [...S.coins.values()].reduce((s, c) => s + c.pools.length, 0),
    poolsByVenue: Object.fromEntries(Object.keys(C.DEXES).map((d) => [C.DEXES[d].name, [...S.coins.values()].reduce((s, c) => s + c.pools.filter((p) => p.dex === d).length, 0)])),
    stats: S.stats, gaps: S.book.done.length + S.book.open.size,
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
const watched = [...new Set([BRIDGE, ...ATAS.map(([, a]) => a), ...S.coinsOf.keys()])];
log(`${S.coins.size} coins with 2+ pools, ${[...S.coins.values()].reduce((s, c) => s + c.pools.length, 0)} pools, ${watched.length} accounts to watch; judging with ${S.ruleFrom}: cap $${R.capUsd(S.settings)}, floor $${S.settings.minProfitUsd} + the network fee${S.flashLoans ? ', SOL loans on' : ''}`);
for (let i = 0; i * ACCOUNTS_PER_SOCKET < watched.length; i++) {
  listen(watched.slice(i * ACCOUNTS_PER_SOCKET, (i + 1) * ACCOUNTS_PER_SOCKET), i + 1);
  await sleep(ACCOUNTS_PER_SOCKET * SUBSCRIBE_GAP_MS + 2_000);
}
setInterval(() => readRule().catch(() => {}), RULE_EVERY_MS);
