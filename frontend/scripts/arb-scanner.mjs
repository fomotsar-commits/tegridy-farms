#!/usr/bin/env node
/**
 * Arbitrage scanner, Solana (owner 2026-11-05: "build this scanner and fill it with arbs that
 * are actually the ones our bot would execute and try to find more"). A page on this computer
 * listing ONLY the round trips the price robot would really take, and a watch list.
 *
 *   1. Coins: our 20 pools' (program EKS4C6…) and those in GeckoTerminal's busiest pools.
 *   2. Every pool of each coin against SOL or USDC on six venues, found on chain (a one-coin
 *      getProgramAccounts on each program), not from a listing's first 30.
 *   3. Each coin's pools re-read in ONE getMultipleAccounts call: every price compared is from
 *      the same slot, with each pool's real fee and the depth at its price (lib/arb-chain.mjs).
 *   4. A trip that clears the robot's floor there is TEST-RUN as the robot would run it: one
 *      transaction from the robot's wallet, each outside leg built by Jupiter held to that
 *      venue's direct route, our pool's leg built here, the last leg's minimum = spent + floor,
 *      then a mainnet simulateTransaction judged on the balances it leaves (the robot's rule).
 *
 * Whether the robot takes a trip, its size and its floor come from the robot's OWN rule
 * (src/lib/solana/keeper/rule.ts), with the settings the RUNNING robot judges with: its cap,
 * floor, fee and Lighthouse proof, read from its gap screen every round (ARB_ROBOT_URL). The
 * robot sizes a trip through two outside pools by this scanner's size, so a scanner on other
 * numbers would hold those trips to its own cap. When the robot's page cannot be read, this
 * scanner's own environment stands in (KEEPER_MAX_TRADE_USD, KEEPER_MIN_PROFIT_USD,
 * KEEPER_PRIORITY_MICROLAMPORTS; past $25 only once its own Lighthouse proof passed at start),
 * and the page says so. Each test run ends with the robot's Lighthouse check (keeper/lighthouse.ts).
 *
 * READ-ONLY: it holds no key, signs nothing and sends nothing. A test run needs no signature.
 * One IP serves every script here (the robot too), so every reader is gated and backs off.
 *
 *   node scripts/arb-scanner.mjs           the page, http://127.0.0.1:8791 (Ctrl+C stops it)
 *   node scripts/arb-scanner.mjs --once    one pass, printed here
 *
 * Settings (environment): ARB_PORT (8791), ARB_RPC_URL (the public mainnet RPC),
 * ARB_LOG (a CSV of every test run; default <home>/.tegridy-arb/scanner/test-runs.csv), ARB_ROBOT_URL (the
 * robot's gap screen, http://127.0.0.1:8792/state.json; "off" judges with this scanner's own),
 * ARB_COINS_FILE (the arbitrage map's ranked coins, scripts/arb-map.mjs; none by default)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';

// The robot's TS modules run here as they do in scripts/price-keeper.mjs: its loader, registered
// before anything imports them.
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
const keeper = (name) => import(pathToFileURL(path.join(HERE, '..', 'src', 'lib', 'solana', 'keeper', name)).href);
const C = await import('./lib/arb-chain.mjs');
const R = await keeper('rule.ts');
const TS = await import(pathToFileURL(path.join(HERE, '..', 'src', 'lib', 'solana', 'lp', 'tokenSafety.ts')).href);
const LH = await keeper('lighthouse.ts');
const PORT = Number(process.env.ARB_PORT || 8791);
const RPC = process.env.ARB_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const LOG = process.env.ARB_LOG?.trim() || path.join(C.privateDir('scanner'), 'test-runs.csv');
const ROBOT_URL = process.env.ARB_ROBOT_URL?.trim() || 'http://127.0.0.1:8792/state.json';
const ONCE = process.argv.includes('--once');
const MAX_COINS = Number(process.env.ARB_MAX_COINS) || Infinity;
/** The arbitrage map's ranked coins (scripts/arb-map.mjs, arb-map-coins.json), scanned beside the listing's. */
const COINS_FILE = process.env.ARB_COINS_FILE?.trim() || '';
const RPC_GAP_MS = 700;
const JUP_GAP_MS = 3_000;
const GECKO_PAGES = 10;
const TRENDING_PAGES = 3;
const LISTED_POOLS = 25;
const UNIVERSE_MS = 15 * 60_000;
const REDISCOVER_MS = 2 * 60 * 60_000;
const PROOF_KEEP_MS = 3 * 60_000;
const PROVE_GAP_MS = Number(process.env.ARB_PROVE_GAP_MS) || 4_000;
const MIN_DEPTH_USD = 1_000;
const POOLS_PER_COIN = 10;
const QUIET_SLOTS = 9_000; // about an hour
/** The SOL/USDC pool that prices SOL and closes a trip priced in both coins: Orca SOL/USDC 0.04%. */
const BRIDGE = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const said = (e) => (e instanceof Error ? e.message : String(e));
// Coins' tickers and the services' answers reach the log: one line each (lib/arb-chain.mjs oneLine).
const log = (line) => console.log(`${new Date().toISOString()}  ${C.oneLine(line)}`);

/** A reader no sooner than `gap` after its last read, and `rest` after a refusal for speed. */
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

const rpcCall = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  if (r.status === 429) throw Object.assign(new Error(`RPC ${method} refused for speed`), { busy: true });
  if (!r.ok) throw new Error(`RPC ${method} answered ${r.status}`);
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(`RPC ${method}: ${String(j.error.message ?? j.error.code).slice(0, 160)}`), { busy: j.error.code === 429 });
  return j.result;
};
const rpc = gated(RPC_GAP_MS, 30_000, rpcCall);

const JUP = 'https://lite-api.jup.ag';
const jupiter = gated(JUP_GAP_MS, 60_000, async (p, body) => {
  const r = await fetch(`${JUP}${p}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) } : { signal: AbortSignal.timeout(20_000) });
  if (r.status === 429) throw Object.assign(new Error('Jupiter refused for speed'), { busy: true });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Jupiter ${p.split('?')[0]} answered ${r.status}${j?.errorCode || j?.error ? ` (${String(j.errorCode ?? j.error).slice(0, 80)})` : ''}`);
  return j;
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

/** Accounts in one call (≤ 100), all from one slot. */
async function many(keys) {
  const r = await rpc('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed' }]);
  return { slot: r.context.slot, accounts: r.value.map((a) => (a ? { owner: a.owner, lamports: a.lamports, data: Buffer.from(a.data[0], 'base64') } : null)) };
}
async function manyChunked(keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const part = keys.slice(i, i + 100);
    const { accounts } = await many(part);
    part.forEach((k, j) => out.set(k, accounts[j]));
  }
  return out;
}

// ─── state ─────────────────────────────────────────────────────────────────────────────
const S = {
  startedAt: Date.now(),
  coins: new Map(), // mint → { mint, symbol, decimals, program, problem, pools, foundAt, scannedAt, slot, trips }
  configs: new Map(),
  labels: null, // program id → Jupiter's venue name
  holds: new Map(), // coin mint → raw amount the robot holds
  usd: new Map([[C.USDC_MINT, 1]]),
  proofs: new Map(), // route → last test run
  ourPools: new Map(), // coin mint → our pools of it
  lastSlots: new Map(), // pool → { slot, at } of its last transaction
  slot: 0,
  note: 'starting…',
  stats: { scans: 0, paying: 0, tried: 0, passed: 0, payingRoutes: new Set(), passedRoutes: new Set(), misread: 0, otherPool: 0, quiet: 0 },
  misreads: new C.Misreads(),
  passes: [], // every passed test run: { at, symbol, mint, route, legs, inUsd, gainedUsd, robotTakes }
  quoteLinks: new Map(), // quote mint → its link pool, decoded (C.QUOTES)
  universeAt: 0,
  // The settings trips are judged with: the running robot's (readRobotRule), else `own`.
  settings: R.ruleSettingsFromEnv(process.env, false),
  // This scanner's own, from its environment; `lighthouseProven` is set once the proof below has run.
  own: R.ruleSettingsFromEnv(process.env, false),
  ruleFrom: { robot: false, why: 'not read yet', at: 0 },
  flashLoans: false,
  lighthouse: { proven: false, why: 'not run yet' },
};

/** The robot's start-up proof (keeper/lighthouse.ts), from its wallet: test runs only. */
async function proveLighthouseNow() {
  try {
    const owner = new PublicKey(C.ROBOT.wallet);
    const ata = getAssociatedTokenAddressSync(new PublicKey(C.SOL_MINT), owner, true);
    const held = await rpc('getTokenAccountBalance', [ata.toBase58(), { commitment: 'confirmed' }]);
    const why = await LH.proveLighthouse(ata, BigInt(held.value.amount), async (ix) => {
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] }).compileToV0Message());
      const r = await rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
      return r.value.err;
    });
    S.lighthouse = { proven: why === null, why };
  } catch (e) {
    S.lighthouse = { proven: false, why: `the proof could not run: ${said(e)}` };
  }
  S.own = { ...S.own, lighthouseProven: S.lighthouse.proven };
  log(S.lighthouse.proven ? `Lighthouse check PROVEN on mainnet: this scanner's own cap is $${R.capUsd(S.own)}` : `Lighthouse check not proven (${S.lighthouse.why}): this scanner's own cap is at most $${R.SAFE_CAP_USD}`);
}

/**
 * The rule the running robot judges with, from its own page (keeper/rule.ts robotRule): its cap,
 * floor, fee and Lighthouse proof. Read every round, so a robot restarted on new settings is
 * followed. When the page cannot be read, this scanner's own settings stand in, and the page says so.
 */
async function readRobotRule() {
  const { rule, why } = await C.robotSettings(ROBOT_URL, fetch);
  if (rule) {
    const { flashLoans, ...settings } = rule;
    if (!S.ruleFrom.robot || JSON.stringify(settings) !== JSON.stringify(S.settings)) log(`Judging with the robot's own settings (${ROBOT_URL}): cap $${R.capUsd(settings)} a trip, floor $${settings.minProfitUsd} + the network fee`);
    Object.assign(S, { settings, flashLoans, ruleFrom: { robot: true, why: null, at: Date.now() } });
    return;
  }
  if (S.ruleFrom.robot || S.ruleFrom.why !== why) log(`NOT the robot's settings: ${why}. This scanner's own stand in: cap $${R.capUsd(S.own)} a trip, floor $${S.own.minProfitUsd} + the network fee`);
  Object.assign(S, { settings: S.own, flashLoans: false, ruleFrom: { robot: false, why, at: Date.now() } });
}
const routeOf = (t) => t.legs.map((l) => l.pool).join('>');

async function readUniverse() {
  const ours = await rpc('getProgramAccounts', [C.DEXES.ours.program, { encoding: 'base64', commitment: 'confirmed', filters: [{ dataSize: C.DEXES.ours.size }] }]);
  const symbols = new Map();
  for (const o of ours) {
    const p = C.decodePool('ours', o.pubkey, Buffer.from(o.account.data[0], 'base64'));
    if (p) for (const m of [p.mintA, p.mintB]) if (!C.COINS[m] && m !== C.USDT_MINT) symbols.set(m, symbols.get(m) ?? null);
  }
  const lists = [
    ...Array.from({ length: GECKO_PAGES }, (_, i) => `pools?sort=h24_volume_usd_desc&page=${i + 1}`),
    ...Array.from({ length: TRENDING_PAGES }, (_, i) => `trending_pools?page=${i + 1}`),
  ];
  for (const [page, list] of lists.entries()) {
    try {
      const json = await gecko(`https://api.geckoterminal.com/api/v2/networks/solana/${list}`);
      for (const [m, s] of C.busyTokens(json)) if (!symbols.get(m)) symbols.set(m, s);
    } catch (e) {
      log(`GeckoTerminal page ${page} not read: ${said(e)}`);
    }
  }
  // The coins the arbitrage map ranked from the whole chain, when a file is given: addresses only,
  // each checked for shape (the file is written by another process).
  if (COINS_FILE) {
    try {
      const listed = JSON.parse(fs.readFileSync(COINS_FILE, 'utf8'));
      for (const m of Array.isArray(listed) ? listed : []) if (typeof m === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m) && !symbols.has(m)) symbols.set(m, null);
    } catch (e) {
      log(`Map coins not read (${COINS_FILE}): ${said(e)}`);
    }
  }
  const fresh = [...symbols.keys()].filter((m) => !S.coins.has(m));
  // Each new coin's mint (the token gate and decimals) and its claimed ticker, in batches.
  const meta = (m) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), new PublicKey(m).toBuffer()], METAPLEX)[0].toBase58();
  const accs = await manyChunked(fresh.flatMap((m) => [m, meta(m)]));
  for (const m of fresh) {
    // The robot's own gate (keeper/rule.ts), on the site's own read of the mint (lp/tokenSafety.ts).
    const raw = (k) => (accs.get(k) ? { address: k, ...accs.get(k) } : null);
    const safety = TS.classifyToken(m, raw(m), raw(meta(m)));
    const facts = safety.kind === 'read' ? safety.facts : null;
    const gate = { decimals: facts?.decimals ?? null, program: facts ? (facts.program === 'token-2022' ? C.TOKEN_2022_PROGRAM : C.TOKEN_PROGRAM) : null, problem: R.tokenGate(safety) };
    // The ticker the coin claims (untrusted: shown beside its whole address): the listing's, else
    // its own metadata's, Token-2022 or Metaplex, as the site reads it.
    const claimed = (safety.kind === 'read' ? safety.symbol?.trim().slice(0, 16) : null) || C.metadataSymbol(accs.get(meta(m))?.data);
    // Its supply: a PumpSwap pool's fee tier is the coin's market cap.
    const supply = accs.get(m)?.data?.length >= 44 ? accs.get(m).data.readBigUInt64LE(36) : null;
    S.coins.set(m, { mint: m, symbol: symbols.get(m) || claimed || '?', ...gate, supply, ours: false, pools: [], foundAt: 0, scannedAt: 0, slot: 0, trips: [] });
  }
  for (const o of ours) {
    const p = C.decodePool('ours', o.pubkey, Buffer.from(o.account.data[0], 'base64'));
    // The token: the side that is neither a start coin nor a pricing coin (BAYLA in BAYLA/SOL).
    const sides = p ? [p.mintA, p.mintB] : [];
    const m = sides.find((x) => !C.COINS[x] && !C.QUOTES[x]) ?? sides.find((x) => !C.COINS[x]);
    const c = m && S.coins.get(m);
    if (c) c.ours = true;
    if (m) S.ourPools.set(m, [...(S.ourPools.get(m) ?? []).filter((x) => x.address !== p.address), p]);
  }
  await readLinks();
  S.universeAt = Date.now();
  log(`${S.coins.size} coins (${ours.length} pools of ours), ${[...S.coins.values()].filter((c) => c.problem).length} refused by the token gate`);
}
/** Each pricing coin's link pool (C.QUOTES), decoded with its fee; a link not read leaves its coin's pools out. */
async function readLinks() {
  const want = Object.entries(C.QUOTES);
  const accs = await manyChunked(want.map(([, q]) => q.bridge));
  for (const [mint, q] of want) {
    const a = accs.get(q.bridge);
    const dex = a && C.dexOfProgram(a.owner);
    const pool = dex && C.decodePool(dex, q.bridge, a.data);
    if (!pool || ![pool.mintA, pool.mintB].includes(mint)) {
      S.quoteLinks.delete(mint);
      log(`${q.symbol}'s link pool ${q.bridge} not read: its pools are left out`);
      continue;
    }
    S.quoteLinks.set(mint, pool);
  }
  await readConfigs([...S.quoteLinks.values()]);
  // Each pricing coin's USD price now, so its pools' depth counts before the first scan.
  const vaults = await manyChunked([...S.quoteLinks.values()].flatMap((l) => (l.kind === 'band' ? [] : [l.vaultA, l.vaultB])));
  const amounts = new Map([...vaults].map(([k, a]) => [k, C.tokenAmount(a?.data)]));
  for (const [q, l] of S.quoteLinks) {
    const depth = C.depthOf(l, amounts);
    if (!depth) continue;
    const c = quoteOf(l, q);
    S.usd.set(q, (l.mintA === q ? depth.b / depth.a : depth.a / depth.b) * 10 ** (decimalsOf(q) - decimalsOf(c)) * (S.usd.get(c) ?? NaN));
  }
}

const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

const quoteOf = (p, mint) => (p.mintA === mint ? p.mintB : p.mintA);
const linkedQuote = (q) => Boolean(C.COINS[q] || (C.QUOTES[q] && S.quoteLinks.get(q)));
const decimalsOf = (m) => (C.COINS[m] ?? C.QUOTES[m]).decimals;

/**
 * Every pool of `coin` on the six venues and ours, priced in SOL, USDC, USDT or BAYLA, kept
 * when deep enough. Which pools exist comes from DexScreener's list of the coin's pools (one read;
 * the one-coin getProgramAccounts calls it replaces are refused by the public RPC, 11-06: 6 of
 * 64 coins looked up in 6.7 h); whose pool each is, and what it holds, from the chain.
 */
async function discover(coin) {
  const listed = C.poolsFromListing(await dexscreener(coin.mint), coin.mint, MIN_DEPTH_USD).slice(0, LISTED_POOLS);
  const accs = await manyChunked(listed.map((f) => f.address));
  const found = listed.map((f) => ({ address: f.address, account: accs.get(f.address) })).filter((f) => f.account && C.dexOfProgram(f.account.owner) && C.dexOfProgram(f.account.owner) !== 'ours');
  let pools = [...found.map((f) => C.decodePool(C.dexOfProgram(f.account.owner), f.address, f.account.data)).filter((p) => p && [p.mintA, p.mintB].includes(coin.mint) && linkedQuote(quoteOf(p, coin.mint))), ...(S.ourPools.get(coin.mint) ?? [])];
  await readConfigs(pools);
  pools = pools.map((p) => C.withFee(p, S.configs)).filter(Boolean);
  // Depth on the coin's side, at today's price: shallow outside pools are left out. Our own pools
  // are always kept, and first: the robot trades them however small.
  const vaults = await manyChunked(pools.flatMap((p) => (p.kind === 'band' ? [] : [p.vaultA, p.vaultB])));
  const amounts = new Map([...vaults].map(([k, a]) => [k, C.tokenAmount(a?.data)]));
  const deep = [];
  for (const p of pools) {
    const depth = C.depthOf(p, amounts);
    const coinMint = quoteOf(p, coin.mint);
    if (!depth || !linkedQuote(coinMint)) continue;
    const coinRaw = coinMint === p.mintA ? depth.a : depth.b;
    const usd = (coinRaw / 10 ** decimalsOf(coinMint)) * (S.usd.get(coinMint) ?? 0);
    if (usd >= MIN_DEPTH_USD || p.dex === 'ours') deep.push({ p, usd });
  }
  const ours = (x) => Number(x.p.dex === 'ours');
  coin.pools = deep.sort((a, b) => ours(b) - ours(a) || b.usd - a.usd).slice(0, POOLS_PER_COIN).map((x) => x.p);
  coin.foundAt = Date.now();
}

async function readConfigs(pools) {
  const want = [...new Set(pools.flatMap((p) => (p.dex === 'pumpswap' ? [C.PUMP_FEE_CONFIG] : p.config ? [p.config] : [])))].filter((k) => !S.configs.has(k));
  if (!want.length) return;
  const accs = await manyChunked(want);
  for (const k of want) {
    const a = accs.get(k);
    if (!a) continue;
    const dex = C.dexOfProgram(a.owner);
    if (k === C.PUMP_FEE_CONFIG) {
      const cfg = a.owner === C.PUMP_FEE_PROGRAM ? C.pumpFeeConfig(a.data) : null;
      if (cfg) S.configs.set(k, cfg);
      else log('PumpSwap fee tiers not read: its pools are left out');
      continue;
    }
    S.configs.set(k, dex === 'clmm' ? C.clmmConfigFee(a.data) : C.cpConfigFee(a.data));
  }
}

/** One coin's pools and the SOL/USDC bridge, read in one call (one slot), and its trips. */
async function scan(coin) {
  const links = [...new Set(coin.pools.map((p) => quoteOf(p, coin.mint)).filter((q) => C.QUOTES[q] && S.quoteLinks.get(q)))].map((q) => [q, S.quoteLinks.get(q)]);
  const accountsOf = (p) => (p.kind === 'band' ? [p.address] : [p.address, p.vaultA, p.vaultB]);
  const keys = [...new Set([BRIDGE, ...links.flatMap(([, l]) => accountsOf(l)), ...coin.pools.flatMap(accountsOf)])];
  const { slot, accounts } = await many(keys);
  const byKey = new Map(keys.map((k, i) => [k, accounts[i]]));
  const bridge = C.withFee(C.decodePool('whirlpool', BRIDGE, byKey.get(BRIDGE)?.data) ?? {}, S.configs);
  const bridgeDepth = bridge && C.depthOf(bridge, new Map());
  if (!bridgeDepth) throw new Error('the SOL/USDC pool was not read');
  S.usd.set(C.SOL_MINT, (bridgeDepth.b / bridgeDepth.a) * 1e3);
  const amounts = new Map(keys.map((k) => [k, C.tokenAmount(byKey.get(k)?.data)]));
  let pools = coin.pools.map((p) => C.withFee(C.decodePool(p.dex, p.address, byKey.get(p.address)?.data) ?? {}, S.configs)).filter((p) => p && p.mintA);
  const depths = new Map(pools.map((p) => [p.address, C.depthOf(p, amounts)]));
  // A PumpSwap pool's fee is its coin's market-cap tier, read at this slot's depth.
  pools = pools.map((p) => (p.dex === 'pumpswap' ? C.withFee(p, S.configs, { depth: depths.get(p.address), supply: p.mintA === coin.mint ? coin.supply : null }) : p)).filter(Boolean);
  // Each pricing coin's link, read in this slot, and its USD price from it.
  const quotes = new Map();
  for (const [q, l] of links) {
    const live = C.withFee(C.decodePool(l.dex, l.address, byKey.get(l.address)?.data) ?? {}, S.configs);
    const depth = live && live.mintA && C.depthOf(live, amounts);
    if (!depth) continue;
    const c = quoteOf(live, q);
    const coinPerQ = live.mintA === q ? depth.b / depth.a : depth.a / depth.b;
    S.usd.set(q, coinPerQ * 10 ** (decimalsOf(q) - decimalsOf(c)) * (S.usd.get(c) ?? NaN));
    quotes.set(q, { pool: live, depth });
    depths.set(live.address, depth);
  }
  const trips = C.tripsFor(pools, { token: coin.mint, decimals: coin.decimals, depths, usd: S.usd, holds: S.holds, bridge: { pool: bridge, depth: bridgeDepth }, quotes, settings: S.settings });
  coin.links = quotes;
  coin.slot = slot;
  coin.scannedAt = Date.now();
  coin.trips = trips.filter((t) => t.pays).slice(0, 6);
  coin.closest = trips.find((t) => t.pays) ?? C.nearestFirst(trips)[0] ?? null;
  coin.livePools = pools;
  coin.depths = depths;
  S.slot = Math.max(S.slot, slot);
  S.stats.scans++;
  for (const t of coin.trips) {
    const minute = Math.floor(Date.now() / 60_000);
    const k = `${routeOf(t)}@${minute}`;
    if (!S.stats.payingRoutes.has(k)) {
      S.stats.payingRoutes.add(k);
      S.stats.paying++;
    }
  }
}

async function readHoldings() {
  const owner = new PublicKey(C.ROBOT.wallet);
  const atas = Object.keys(C.COINS).map((m) => getAssociatedTokenAddressSync(new PublicKey(m), owner, true).toBase58());
  // The SOL/USDC pool in the same call: SOL's price is needed before any coin is looked up, or
  // every SOL pool counts as $0 deep and is left out (a fresh start found no pool at all).
  const { accounts } = await many([...atas, BRIDGE]);
  Object.keys(C.COINS).forEach((m, i) => S.holds.set(m, Number(C.tokenAmount(accounts[i]?.data) ?? 0n)));
  const bridge = C.withFee(C.decodePool('whirlpool', BRIDGE, accounts[atas.length]?.data) ?? {}, S.configs);
  const depth = bridge && C.depthOf(bridge, new Map());
  if (depth) S.usd.set(C.SOL_MINT, (depth.b / depth.a) * 1e3);
}

/** When each pool last traded (its newest transaction's slot), cached for five minutes. */
async function lastTradeSlot(pool) {
  const c = S.lastSlots.get(pool);
  if (c && Date.now() - c.at < 5 * 60_000) return c.slot;
  const r = await rpc('getSignaturesForAddress', [pool, { limit: 1, commitment: 'confirmed' }]);
  const slot = r?.[0]?.slot ?? 0;
  S.lastSlots.set(pool, { slot, at: Date.now() });
  return slot;
}

// ─── the test run ──────────────────────────────────────────────────────────────────────
const toIx = (w) => new TransactionInstruction({ programId: new PublicKey(w.programId), keys: w.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(w.data, 'base64') });
const SWAP_BASE_INPUT = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);

/** Our pool's swap (cp-swap swap_base_input, the robot's own leg; cpswap/ix.ts account order). */
function ourSwap(owner, pool, fromMint, amountIn, minOut) {
  const prog = new PublicKey(C.DEXES[pool.dex].program);
  const aIn = pool.mintA === fromMint;
  const [mIn, mOut] = aIn ? [pool.mintA, pool.mintB] : [pool.mintB, pool.mintA];
  const [vIn, vOut] = aIn ? [pool.vaultA, pool.vaultB] : [pool.vaultB, pool.vaultA];
  const [pIn, pOut] = aIn ? [pool.programA, pool.programB] : [pool.programB, pool.programA];
  const ata = (m, p) => getAssociatedTokenAddressSync(new PublicKey(m), owner, true, new PublicKey(p));
  const k = (x, w = false) => ({ pubkey: new PublicKey(x), isSigner: false, isWritable: w });
  const data = Buffer.alloc(24);
  SWAP_BASE_INPUT.copy(data, 0);
  data.writeBigUInt64LE(amountIn, 8);
  data.writeBigUInt64LE(minOut, 16);
  return new TransactionInstruction({
    programId: prog,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      k(PublicKey.findProgramAddressSync([Buffer.from('vault_and_lp_mint_auth_seed')], prog)[0]),
      k(pool.config), k(pool.address, true),
      { pubkey: ata(mIn, pIn), isSigner: false, isWritable: true }, { pubkey: ata(mOut, pOut), isSigner: false, isWritable: true },
      k(vIn, true), k(vOut, true), k(pIn), k(pOut), k(mIn), k(mOut), k(pool.observation, true),
    ],
    data,
  });
}

/**
 * Test-run `trip` as the robot would send it, from the robot's wallet, and judge the balances
 * it leaves by the robot's own rule. Returns { ok, why, gainedUsd, units }.
 */
async function prove(coin, trip) {
  const owner = new PublicKey(C.ROBOT.wallet);
  const start = trip.coin;
  const bounds = R.coinBounds(C.COINS[start], S.usd.get(start), S.usd.get(C.SOL_MINT), S.settings);
  if (typeof bounds === 'string') return { ok: false, why: bounds };
  const unit = bounds.unit;
  // The robot's floor, in the coin's base units: the network fee and the minimum profit.
  const floorRaw = bounds.floor;
  const inRaw = BigInt(trip.inRaw);
  const programOf = (m) => (m === coin.mint ? coin.program : C.QUOTES[m]?.program ?? C.TOKEN_PROGRAM);
  const ataOf = (m) => getAssociatedTokenAddressSync(new PublicKey(m), owner, true, new PublicKey(programOf(m)));
  if (!S.labels) S.labels = await jupiter('/swap/v1/program-id-to-label');
  const known = [...coin.livePools, ...[...(coin.links?.values() ?? [])].map((x) => x.pool)];
  const need = inRaw + floorRaw;
  // Every leg priced first (Jupiter's quotes, our pool's maths): a trip under the floor, or a
  // pool whose quote is well under its own figures (misread), stops before any swap is built.
  const plan = [];
  const jupiterPools = [];
  let amount = inRaw;
  for (let i = 0; i < trip.legs.length; i++) {
    const l = trip.legs[i];
    const last = i === trip.legs.length - 1;
    const pool = known.find((p) => p.address === l.pool) ?? null;
    const depth = coin.depths.get(l.pool);
    if (pool && pool.dex === 'ours') {
      // Our pool's leg, built here as the robot builds it: its maths on the scan's reserves.
      const d = C.legOf(pool, depth, l.from);
      const expect = BigInt(Math.floor(C.swapOut(d.rin, d.rout, d.fee, Number(amount))));
      if (last && expect < need) return { ok: false, why: `our pool pays back ${expect} for ${inRaw}: under the floor (${need})` };
      const min = last ? (C.minOutAt(expect, C.ROBOT.slippageBps) > need ? C.minOutAt(expect, C.ROBOT.slippageBps) : need) : C.minOutAt(expect, C.ROBOT.slippageBps);
      plan.push({ ours: pool, from: l.from, amount, min });
      amount = min;
      continue;
    }
    const label = S.labels[C.DEXES[l.dex].program];
    if (!label) return { ok: false, why: `Jupiter does not trade ${C.DEXES[l.dex].name}` };
    const qs = new URLSearchParams({ inputMint: l.from, outputMint: l.to, amount: amount.toString(), slippageBps: String(C.ROBOT.slippageBps), swapMode: 'ExactIn', onlyDirectRoutes: 'true', dexes: label, restrictIntermediateTokens: 'true', instructionVersion: 'V2' });
    let q;
    try {
      q = await jupiter(`/swap/v1/quote?${qs}`);
    } catch (e) {
      return { ok: false, why: said(e), jupiterPools };
    }
    const ammKey = q.routePlan?.[0]?.swapInfo?.ammKey ?? '?';
    jupiterPools.push(ammKey);
    const out = BigInt(q.outAmount);
    if (ammKey === l.pool && pool && depth) {
      const d = C.legOf(pool, depth, l.from);
      const figure = C.swapOut(d.rin, d.rout, d.fee, Number(amount));
      if (S.misreads.judge(l.pool, figure, out, Date.now())) {
        S.stats.misread++;
        return { ok: false, misread: true, why: `${C.DEXES[l.dex].name} pool ${l.pool} misread: Jupiter pays ${out}, its own figures said ${Math.floor(figure)}; left out of test runs for a while`, jupiterPools };
      }
    } else if (ammKey !== l.pool) S.stats.otherPool++;
    if (last) {
      const bps = C.lastSlippageBps(out, need);
      if (bps === null) return { ok: false, why: `Jupiter's quote pays back ${out} for ${inRaw}: under the floor (${need})`, quotedGainUsd: Number(out - inRaw) * unit, jupiterPools };
      q = { ...q, slippageBps: bps, otherAmountThreshold: C.minOutAt(out, bps).toString() };
    }
    plan.push({ quote: q });
    amount = BigInt(q.otherAmountThreshold);
  }
  const legs = [];
  const alts = new Set();
  for (const step of plan) {
    if (step.ours) {
      legs.push(ourSwap(owner, step.ours, step.from, step.amount, step.min));
      continue;
    }
    let si;
    try {
      si = await jupiter('/swap/v1/swap-instructions', { quoteResponse: step.quote, userPublicKey: owner.toBase58(), wrapAndUnwrapSol: false, useSharedAccounts: false, dynamicComputeUnitLimit: false });
    } catch (e) {
      return { ok: false, why: said(e), jupiterPools };
    }
    if (!si?.swapInstruction) return { ok: false, why: 'Jupiter built no swap', jupiterPools };
    legs.push(toIx(si.swapInstruction));
    for (const a of si.addressLookupTableAddresses ?? []) alts.add(a);
  }
  const tables = alts.size ? await many([...alts]) : { accounts: [] };
  const lookups = [...alts].map((k, i) => tables.accounts[i] && new AddressLookupTableAccount({ key: new PublicKey(k), state: AddressLookupTableAccount.deserialize(tables.accounts[i].data) })).filter(Boolean);
  // The start coin's account, then every coin held between swaps (the token, BAYLA, USDT, the other coin).
  const mints = [start, ...new Set(trip.legs.slice(1).map((l) => l.from).filter((m) => m !== start))];
  const atas = mints.map(ataOf);
  const watch = [...atas, owner].map((k) => k.toBase58());
  const before = await many(watch);
  const coinHeld = C.tokenAmount(before.accounts[0]?.data) ?? 0n;
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: R.MAX_TRIP_UNITS }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: S.settings.microLamports }),
    ...mints.map((m, i) => createAssociatedTokenAccountIdempotentInstruction(owner, atas[i], owner, new PublicKey(m), new PublicKey(programOf(m)))),
    ...legs,
    // The robot's last instruction: the coin account holds what it held plus the floor, or the trip is undone.
    LH.atLeastCheck(atas[0], coinHeld + floorRaw),
  ];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message(lookups));
  const sim = await rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } }]);
  const v = sim.value;
  if (v.err) return { ok: false, why: `the test run failed: ${JSON.stringify(v.err).slice(0, 120)}${v.logs?.length ? ` · ${String(v.logs[v.logs.length - 1]).slice(0, 140)}` : ''}`, units: v.unitsConsumed, jupiterPools, slot: sim.context.slot };
  const amt = (a) => C.tokenAmount(a ? Buffer.from(a.data[0], 'base64') : null) ?? 0n;
  const amtBefore = (a) => C.tokenAmount(a?.data) ?? 0n;
  const n = mints.length;
  const change = {
    coinBefore: amtBefore(before.accounts[0]), coinAfter: amt(v.accounts[0]),
    tokenBefore: 0n, tokenAfter: 0n, otherBefore: 0n, otherAfter: 0n,
    via: mints.slice(1).map((_, i) => ({ before: amtBefore(before.accounts[i + 1]), after: amt(v.accounts[i + 1]) })),
    lamportsBefore: BigInt(before.accounts[n]?.lamports ?? 0), lamportsAfter: BigInt(v.accounts[n]?.lamports ?? 0),
  };
  const gainedUsd = Number(change.coinAfter - change.coinBefore) * unit;
  const why = C.testRunProblem(change, floorRaw);
  return { ok: !why, why, gainedUsd, units: v.unitsConsumed, jupiterPools, slot: sim.context.slot };
}

/** The best paying trip not test-run lately, its pools checked for being alive first. */
async function proveNext() {
  const now = Date.now();
  const candidates = [...S.coins.values()].filter((c) => !c.problem && now - c.scannedAt < 2 * 60_000).flatMap((c) => c.trips.map((t) => ({ c, t })));
  candidates.sort((a, b) => b.t.netUsd - a.t.netUsd);
  for (const { c, t } of candidates) {
    const route = routeOf(t);
    const last = S.proofs.get(route);
    if (last && now - last.at < (last.ok ? 60_000 : PROOF_KEEP_MS)) continue;
    if (t.legs.some((l) => S.misreads.held(l.pool, now))) continue;
    for (const l of t.legs) if (l.pool !== BRIDGE) l.lastSlot = await lastTradeSlot(l.pool);
    const quiet = t.legs.some((l) => l.pool !== BRIDGE && S.slot - (l.lastSlot ?? 0) > QUIET_SLOTS);
    const r = quiet ? { ok: false, why: 'a pool has not traded in about an hour: its price is likely stale or its liquidity stuck', quiet: true } : await prove(c, t);
    if (quiet) S.stats.quiet++;
    else {
      S.stats.tried++;
      if (r.ok) {
        S.stats.passed++;
        S.stats.passedRoutes.add(route);
        S.passes.push({ at: Date.now(), symbol: c.symbol, mint: c.mint, route, venues: t.legs.map((l) => C.DEXES[l.dex]?.name ?? l.dex), inUsd: t.inUsd, gainedUsd: r.gainedUsd, robotTakes: t.robotTakes });
        if (S.passes.length > 500) S.passes.shift();
      }
    }
    S.proofs.set(route, { ...r, at: Date.now(), coin: c.mint, netUsd: t.netUsd, inUsd: t.inUsd });
    if (!quiet) fs.appendFile(LOG, `${new Date().toISOString()},${r.slot ?? ''},${c.mint},${c.symbol.replace(/[,\n]/g, ' ')},${route},${t.inUsd.toFixed(2)},${t.netUsd.toFixed(4)},${r.ok ? 'PASS' : 'fail'},${(r.gainedUsd ?? 0).toFixed(4)},"${String(r.why ?? '').replace(/"/g, "'")}"\n`, () => {});
    log(`test run ${c.symbol} ${c.mint} ${route}: ${r.ok ? `PASSES, gains $${r.gainedUsd?.toFixed(4)}` : `no: ${r.why}`}`);
    return;
  }
}

// ─── loops ─────────────────────────────────────────────────────────────────────────────
async function scanLoop() {
  for (;;) {
    try {
      // SOL's price first: the pricing coins' prices and every pool's depth are counted in it.
      await readHoldings();
      // The first coin list is waited for; later ones load beside the scan (13 GeckoTerminal pages,
      // with its refusals, take minutes).
      if (!S.universeAt) await readUniverse();
      else if (Date.now() - S.universeAt > UNIVERSE_MS && !S.refreshing) {
        S.refreshing = true;
        readUniverse().catch((e) => log(`coin list not refreshed: ${said(e)}`)).finally(() => (S.refreshing = false));
      }
      await readRobotRule();
      const coins = [...S.coins.values()].filter((c) => !c.problem && c.decimals !== null).sort((a, b) => Number(b.ours) - Number(a.ours)).slice(0, MAX_COINS);
      for (const c of coins) {
        try {
          if (Date.now() - c.foundAt > REDISCOVER_MS) {
            S.note = `looking up every pool of ${c.symbol}`;
            await discover(c);
          }
          if (c.pools.length >= 2) await scan(c);
        } catch (e) {
          log(`${c.symbol} ${c.mint}: ${said(e)}`);
        }
      }
      S.note = null;
      S.cycleAt = Date.now();
    } catch (e) {
      S.note = `not read: ${said(e)}`;
      log(S.note);
      await sleep(30_000);
    }
    if (ONCE) return;
  }
}

async function proveLoop() {
  for (;;) {
    await sleep(PROVE_GAP_MS);
    try {
      await proveNext();
    } catch (e) {
      log(`test run: ${said(e)}`);
    }
  }
}

function snapshot() {
  const coins = [...S.coins.values()];
  const rows = [];
  for (const c of coins) {
    for (const t of c.trips) {
      const proof = S.proofs.get(routeOf(t));
      rows.push({ mint: c.mint, symbol: c.symbol, ours: c.ours, slot: c.slot, scannedAt: c.scannedAt, ...t, legs: t.legs.map((l) => ({ ...l, venue: C.DEXES[l.dex]?.name ?? l.dex })), proof: proof ?? null });
    }
  }
  // Every fresh passed two-swap trip (ours or two outside pools: keeper/takes.ts reads both), not only the best 60.
  const take = C.takeRows(rows, Date.now(), PROOF_KEEP_MS);
  const watch = rows.filter((r) => !take.includes(r)).sort((a, b) => b.netUsd - a.netUsd).slice(0, 60);
  // Each coin's best trip that does NOT pay on its latest read (within 5 minutes), nearest to paying first.
  const closest = C.nearestFirst(
    coins
      .filter((c) => c.closest && !c.closest.pays && Date.now() - c.scannedAt < 5 * 60_000)
      .map((c) => ({ mint: c.mint, symbol: c.symbol, ours: c.ours, slot: c.slot, scannedAt: c.scannedAt, ...c.closest, legs: c.closest.legs.map((l) => ({ ...l, venue: C.DEXES[l.dex]?.name ?? l.dex })) })),
  ).slice(0, 20);
  const sol = S.usd.get(C.SOL_MINT);
  const floorOf = (m) => {
    const b = R.coinBounds(C.COINS[m], S.usd.get(m), sol, S.settings);
    return typeof b === 'string' ? null : b.floorUsd;
  };
  const hours = Math.max((Date.now() - S.startedAt) / 3_600_000, 1 / 60);
  return JSON.stringify({
    at: Date.now(),
    slot: S.slot,
    note: S.note,
    solUsd: S.usd.get(C.SOL_MINT) ?? null,
    holds: Object.fromEntries([...S.holds].map(([m, v]) => [C.COINS[m].symbol, v / 10 ** C.COINS[m].decimals])),
    holdsUsd: Object.fromEntries([...S.holds].map(([m, v]) => [C.COINS[m].symbol, (v / 10 ** C.COINS[m].decimals) * (S.usd.get(m) ?? 0)])),
    rule: {
      // Whose settings these are: the running robot's (read from its page), or this scanner's own.
      from: S.ruleFrom,
      capUsd: R.capUsd(S.settings),
      settingUsd: S.settings.maxTradeUsd,
      safeCapUsd: R.SAFE_CAP_USD,
      lighthouseProven: S.settings.lighthouseProven,
      minProfitUsd: S.settings.minProfitUsd,
      feeLamports: R.tripFeeLamports(S.settings.microLamports),
      floorUsd: { SOL: floorOf(C.SOL_MINT), USDC: floorOf(C.USDC_MINT) },
      flashLoans: S.flashLoans,
      lighthouse: S.lighthouse,
    },
    coins: coins.length,
    refused: coins.filter((c) => c.problem).map((c) => ({ mint: c.mint, symbol: c.symbol, problem: c.problem })),
    pools: coins.reduce((s, c) => s + c.pools.length, 0),
    looked: coins.filter((c) => c.foundAt).length,
    cycleAt: S.cycleAt ?? 0,
    stats: { scans: S.stats.scans, paying: S.stats.paying, tried: S.stats.tried, passed: S.stats.passed, routesPassed: S.stats.passedRoutes.size, misread: S.stats.misread, otherPool: S.stats.otherPool, quiet: S.stats.quiet, hours },
    misreads: S.misreads.list(Date.now()),
    passes: S.passes.slice(-50),
    take,
    watch,
    closest,
  });
}

await proveLighthouseNow();
await readRobotRule();

if (ONCE) {
  await scanLoop();
  for (let i = 0; i < 3; i++) await proveNext();
  const s = JSON.parse(snapshot());
  log(`${s.coins} coins, ${s.pools} pools; ${s.take.length} the robot would take, ${s.watch.length} to watch`);
  for (const r of [...s.take, ...s.watch].slice(0, 15)) log(`  ${r.symbol} ${r.mint}: ${r.legs.map((l) => `${l.venue} ${l.pool} (${(l.fee * 100).toFixed(2)}%)`).join(' → ')} · $${r.inUsd.toFixed(2)} in (held by the ${r.sizedBy}; the gap closes at $${r.gapInUsd.toFixed(2)}), est. ${r.netUsd >= 0 ? '+' : ''}$${r.netUsd.toFixed(4)} net, ROI ${r.roiPct.toFixed(2)}% · ${r.proof ? (r.proof.ok ? 'TEST RUN PASSES' : `test run: ${r.proof.why}`) : 'not test-run yet'}`);
  process.exit(0);
}

const page = fs.readFileSync(path.join(HERE, 'arb-scanner-page.html'), 'utf8');
const app = fs.readFileSync(path.join(HERE, 'arb-scanner-page.js'), 'utf8');
const css = fs.readFileSync(path.join(HERE, 'arb-scanner-page.css'), 'utf8');
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };

const server = http.createServer((req, res) => {
  // Only this computer, by its own names: a web page elsewhere that points a name of its own at
  // 127.0.0.1 is turned away.
  if (req.headers.host !== `127.0.0.1:${PORT}` && req.headers.host !== `localhost:${PORT}`) return res.writeHead(421, common).end();
  if (req.method !== 'GET') return res.writeHead(405, common).end();
  if (req.url === '/') return res.writeHead(200, { ...common, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp }).end(page);
  if (req.url === '/app.js') return res.writeHead(200, { ...common, 'content-type': 'text/javascript; charset=utf-8' }).end(app);
  if (req.url === '/app.css') return res.writeHead(200, { ...common, 'content-type': 'text/css; charset=utf-8' }).end(css);
  if (req.url === '/state.json') return res.writeHead(200, { ...common, 'content-type': 'application/json' }).end(snapshot());
  return res.writeHead(404, common).end();
});
server.on('error', (e) => {
  log(e.code === 'EADDRINUSE' ? `A scanner already runs at http://127.0.0.1:${PORT}: open that one (or set ARB_PORT)` : `Scanner stopped: ${said(e)}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  log(`Arbitrage scanner (Solana): http://127.0.0.1:${PORT}`);
  log(`  read-only, on this computer only; test runs logged to ${LOG}; Ctrl+C stops it`);
});
await Promise.all([scanLoop(), proveLoop()]);
