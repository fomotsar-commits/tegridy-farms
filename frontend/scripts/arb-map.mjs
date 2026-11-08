#!/usr/bin/env node
/**
 * The arbitrage map (owner 2026-11-06: "there is way more than 186 coins on solana… where is all
 * the arb on all of solana hiding"). Read-only; it never sends.
 *
 * Where the scanner (arb-scanner.mjs) starts from a listing's busiest 260 pools, this starts from
 * the chain: EVERY pool of Raydium CPMM, Raydium AMM v4, PumpSwap and our own venue (about 1.6
 * million), read program by program in 256 slices each (lib/arb-map.mjs), grouped by coin. The
 * coins with two or more pools are the candidates; their vaults are read (on a second RPC host,
 * so the robot's host is never crowded) and each coin's best round trip is judged by the robot's
 * own rule. What comes out is ranked by what the open gap holds, not by how busy the coin is.
 *
 *   node scripts/arb-map.mjs           lists (once a day), then re-reads depths every ARB_MAP_EVERY_MS
 *   node scripts/arb-map.mjs --once    one pass, printed here
 *
 * Settings (environment): ARB_MAP_RPC_URL (program scans; the public mainnet RPC is the only free
 * host that allows them), ARB_MAP_READ_RPC_URL (account reads; publicnode), ARB_MAP_DIR (cache and
 * output; <temp>/arb-map), ARB_MAP_SLICES ("0-255": which of each program's 256 slices to list),
 * ARB_MAP_GAP_MS (2000 between program scans), ARB_MAP_READ_GAP_MS (250 between account reads),
 * ARB_MAP_MIN_DEPTH_USD (500 a pool), ARB_MAP_TOP (40 rows kept), ARB_MAP_RELIST_H (24),
 * ARB_MAP_EVERY_MS (300000), and the robot's own KEEPER_MAX_TRADE_USD / KEEPER_MIN_PROFIT_USD.
 *
 * Output: <dir>/arb-map.json (the ranked rows and counts) and <dir>/arb-map-coins.json (the top
 * coins' addresses, for the scanner's ARB_COINS_FILE).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { redactRpcUrl } from '../../scripts/lib/redact-url.mjs';

// The robot's TS modules run here as they do in scripts/arb-scanner.mjs: its loader, registered
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
const C = await import('./lib/arb-chain.mjs');
const M = await import('./lib/arb-map.mjs');
const R = await import(pathToFileURL(path.join(HERE, '..', 'src', 'lib', 'solana', 'keeper', 'rule.ts')).href);

const env = (name, fallback) => process.env[name]?.trim() || fallback;
const num = (name, fallback) => {
  const raw = env(name, '');
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number, not "${raw}"`);
  return n;
};
const SCAN_RPC = env('ARB_MAP_RPC_URL', 'https://api.mainnet-beta.solana.com');
const READ_RPC = env('ARB_MAP_READ_RPC_URL', 'https://solana-rpc.publicnode.com');
const DIR = env('ARB_MAP_DIR', path.join(os.tmpdir(), 'arb-map'));
const [SLICE_FROM, SLICE_TO] = env('ARB_MAP_SLICES', '0-255').split('-').map(Number);
const GAP_MS = num('ARB_MAP_GAP_MS', 2_000);
const READ_GAP_MS = num('ARB_MAP_READ_GAP_MS', 250);
/** Accounts a read asks for at once: publicnode refuses more than 10 (403, measured 11-06); the public RPC takes 100. */
const READ_BATCH = num('ARB_MAP_READ_BATCH', READ_RPC.includes('publicnode') ? 10 : 100);
const MIN_DEPTH_USD = num('ARB_MAP_MIN_DEPTH_USD', 500);
const TOP = num('ARB_MAP_TOP', 40);
const RELIST_MS = num('ARB_MAP_RELIST_H', 24) * 3_600_000;
const EVERY_MS = num('ARB_MAP_EVERY_MS', 300_000);
const ONCE = process.argv.includes('--once');
const SETTINGS = R.ruleSettingsFromEnv(process.env, false);
/** The SOL/USDC pool that prices SOL and closes a trip priced in both coins: Orca SOL/USDC 0.04% (the scanner's). */
const BRIDGE = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const said = (e) => (e instanceof Error ? e.message : String(e));
const log = (line) => console.log(`${new Date().toISOString()}  ${line}`);

// Each host is called no sooner than its gap after its last call; a refusal, a dropped
// connection or a timeout rests 30 s and asks again (lib/arb-map.mjs).
const scan = M.rpcHost(SCAN_RPC, GAP_MS, { log });
const read = M.rpcHost(READ_RPC, READ_GAP_MS, { log });

const POOLS_DIR = path.join(DIR, 'pools');
const sliceFile = (s) => path.join(POOLS_DIR, `${s.dex}-${s.size}-${s.byte.toString(16).padStart(2, '0')}.json`);

// ─── 1. every pool, program by program ───────────────────────────────────────────────────
async function listPools() {
  await fs.mkdir(POOLS_DIR, { recursive: true });
  const want = M.slices().filter((s) => s.byte >= SLICE_FROM && s.byte <= SLICE_TO);
  let read = 0;
  let found = 0;
  let skipped = 0;
  for (const s of want) {
    const f = sliceFile(s);
    const st = await fs.stat(f).catch(() => null);
    if (st && Date.now() - st.mtimeMs < RELIST_MS) {
      skipped++;
      continue;
    }
    let got;
    try {
      got = await scan('getProgramAccounts', M.sliceParams(s.dex, s.size, s.byte));
    } catch (e) {
      log(`${s.dex} ${s.size} slice ${s.byte}: not read (${said(e)}); next run tries it again`);
      continue;
    }
    const pools = [];
    for (const a of got) {
      const p = M.poolFromSlice(s.dex, s.size, a.pubkey, a.account.data[0]);
      if (p && M.sidesOf(p)) pools.push(p);
    }
    await fs.writeFile(f, M.toJson({ at: Date.now(), dex: s.dex, size: s.size, byte: s.byte, pools }));
    read++;
    found += pools.length;
    if (read % 32 === 0) log(`listed ${read + skipped}/${want.length} slices: ${found} pools priced in SOL or USDC so far`);
  }
  log(`listing done: ${read} slices read, ${skipped} fresh from the last day, ${found} new pools`);
}

/** Every listed pool of a coin with two or more, from the cache: counted first, then kept. */
async function loadCandidates() {
  const files = (await fs.readdir(POOLS_DIR).catch(() => [])).filter((f) => f.endsWith('.json')).map((f) => path.join(POOLS_DIR, f));
  const counts = new Map();
  const byDex = {};
  const each = async (fn) => {
    for (const f of files) {
      const j = M.fromJson(await fs.readFile(f, 'utf8'));
      for (const p of j.pools) if (!p.stopped) fn(p, M.sidesOf(p).coin);
    }
  };
  await each((p, coin) => {
    counts.set(coin, (counts.get(coin) ?? 0) + 1);
    byDex[p.dex] = (byDex[p.dex] ?? 0) + 1;
  });
  const pools = [];
  await each((p, coin) => {
    if (counts.get(coin) >= 2) pools.push(p);
  });
  return { byDex, coins: counts.size, byCoin: M.candidates(pools), slices: files.length };
}

// ─── 2. depths, fees, prices ──────────────────────────────────────────────────────────────
/**
 * Accounts in calls of READ_BATCH, whole or a slice; address → { owner, data } or null (no such
 * account). A call the host would not answer even after its rests leaves its accounts out (unread
 * this pass, read again next pass) rather than losing the pass.
 */
async function accounts(keys, dataSlice) {
  const out = new Map();
  const want = [...new Set(keys)];
  for (let i = 0; i < want.length; i += READ_BATCH) {
    const part = want.slice(i, i + READ_BATCH);
    let r;
    try {
      r = await read('getMultipleAccounts', [part, { encoding: 'base64', commitment: 'confirmed', ...(dataSlice ? { dataSlice } : {}) }]);
    } catch (e) {
      log(`${part.length} accounts not read this pass (${said(e)})`);
      continue;
    }
    part.forEach((k, j) => out.set(k, r.value[j] ? { owner: r.value[j].owner, data: Buffer.from(r.value[j].data[0], 'base64') } : null));
    if (i > 0 && (i / READ_BATCH) % 200 === 0) log(`read ${i + part.length}/${want.length} accounts`);
  }
  return out;
}

const S = { listedAt: 0, candidates: null, deep: [], rows: [], counts: {}, usd: new Map([[C.USDC_MINT, 1]]), configs: new Map(), bridge: null };

/** SOL's price and the bridge pool, and the fee configs the candidates' pools point at. */
async function readLinks(pools) {
  const configs = [...new Set([...pools.filter((p) => p.config).map((p) => p.config), C.PUMP_FEE_CONFIG, BRIDGE])];
  const accs = await accounts(configs);
  for (const [k, a] of accs) {
    if (!a) continue;
    if (k === BRIDGE) {
      const pool = C.decodePool('whirlpool', k, a.data);
      const depth = pool && C.depthOf(pool, new Map());
      if (!pool || !depth) continue;
      const sol = (pool.mintA === C.SOL_MINT ? depth.b / depth.a : depth.a / depth.b) * 10 ** (9 - 6);
      S.usd.set(C.SOL_MINT, sol);
      S.bridge = { pool, depth };
    } else if (k === C.PUMP_FEE_CONFIG) S.configs.set(k, C.pumpFeeConfig(a.data));
    else S.configs.set(k, C.cpConfigFee(a.data));
  }
  if (!S.bridge) throw new Error('the SOL/USDC bridge pool was not read: nothing can be priced');
}

/**
 * One pass over `pools` (a coin's pools, all candidates or last pass's deep ones): vault amounts
 * and the coins' mints in one slice each, depth, the real fee, then the robot's rule per coin.
 */
async function pass(pools) {
  const mints = [...new Set(pools.map((p) => M.sidesOf(p).coin))];
  // Byte 36..72 of a mint holds its supply (36) and decimals (44); of a token account, its amount (64).
  const accs = await accounts([...pools.flatMap((p) => [p.vaultA, p.vaultB]), ...mints], { offset: 36, length: 36 });
  const amounts = new Map();
  for (const p of pools) for (const v of [p.vaultA, p.vaultB]) amounts.set(v, accs.get(v)?.data?.length >= 36 ? accs.get(v).data.readBigUInt64LE(28) : null);
  const decimals = new Map();
  const supply = new Map();
  for (const m of mints) {
    const d = accs.get(m)?.data;
    if (d?.length >= 36) {
      decimals.set(m, d[8]);
      supply.set(m, d.readBigUInt64LE(0));
    }
  }
  const depths = new Map();
  const priced = [];
  for (const p of pools) {
    const depth = C.depthOf(p, amounts);
    if (!depth) continue;
    const withFee = C.withFee(p, S.configs, { depth, supply: supply.get(M.sidesOf(p).coin) });
    if (!withFee) continue;
    depths.set(p.address, depth);
    if (M.depthUsd(withFee, depths, S.usd) >= MIN_DEPTH_USD) priced.push(withFee);
  }
  const byCoin = M.candidates(priced);
  const rows = M.rankCoins(byCoin, { decimals, depths, usd: S.usd, settings: SETTINGS, bridge: S.bridge });
  S.deep = [...byCoin.values()].flat();
  S.rows = rows.slice(0, TOP);
  S.counts = { ...S.counts, read: pools.length, deep: priced.length, coinsWithTwoDeep: byCoin.size, paying: rows.filter((r) => r.pays).length, solUsd: S.usd.get(C.SOL_MINT) };
  await nameRows();
  await writeOut();
  print();
}

/** The ticker each top coin claims in its Metaplex metadata (untrusted: shown beside its whole address). */
async function nameRows() {
  const meta = (m) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), new PublicKey(m).toBuffer()], METAPLEX)[0].toBase58();
  const accs = await accounts(S.rows.map((r) => meta(r.mint)));
  for (const r of S.rows) r.symbol = C.metadataSymbol(accs.get(meta(r.mint))?.data) ?? '?';
}

async function writeOut() {
  const out = { at: new Date().toISOString(), settings: SETTINGS, minDepthUsd: MIN_DEPTH_USD, counts: S.counts, rows: S.rows };
  await fs.writeFile(path.join(DIR, 'arb-map.json'), JSON.stringify(out, null, 1));
  await fs.writeFile(path.join(DIR, 'arb-map-coins.json'), JSON.stringify(S.rows.map((r) => r.mint)));
}

function print() {
  const c = S.counts;
  log(`${c.pools} pools listed (${Object.entries(c.byDex ?? {}).map(([d, n]) => `${d} ${n}`).join(', ')}) of ${c.coins} coins; ${c.candidates} coins with 2+ pools; ${c.read} pools read, ${c.deep} hold $${MIN_DEPTH_USD}+, ${c.coinsWithTwoDeep} coins with 2+ deep pools, ${c.paying} pay the robot's rule now (cap $${R.capUsd(SETTINGS)}, floor $${SETTINGS.minProfitUsd}); SOL $${c.solUsd?.toFixed(2)}`);
  const money = (v) => (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2);
  for (const [i, r] of S.rows.entries()) {
    const pools = r.pools.map((p) => `${p.dex} $${Math.round(p.depthUsd ?? 0)}`).join(' | ');
    log(`${String(i + 1).padStart(3)}. ${r.symbol.padEnd(10)} ${r.mint}  gap ${r.gapPct.toFixed(2).padStart(6)}%  cost ${r.costPct.toFixed(2)}%  open ${money(r.gapNetUsd).padStart(9)} on $${Math.round(r.gapInUsd)}  robot ${r.pays ? money(r.netUsd) + ' on $' + Math.round(r.inUsd) : 'no: ' + r.why}  [${pools}]`);
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────
await fs.mkdir(DIR, { recursive: true });
log(`arb map: scans ${redactRpcUrl(SCAN_RPC)} every ${GAP_MS} ms, reads ${redactRpcUrl(READ_RPC)} every ${READ_GAP_MS} ms, slices ${SLICE_FROM}-${SLICE_TO}, cache ${DIR}`);
for (;;) {
  // A round that fails (a host gone for minutes) is logged and tried again next round; a listing
  // round counts as done only once its first pass is, and its slices are cached, so a retry is cheap.
  try {
    if (Date.now() - S.listedAt > RELIST_MS) {
      await listPools();
      const { byDex, coins, byCoin, slices } = await loadCandidates();
      S.candidates = [...byCoin.values()].flat();
      S.counts = { slices, pools: Object.values(byDex).reduce((a, b) => a + b, 0), byDex, coins, candidates: byCoin.size };
      log(`${S.counts.pools} pools of ${coins} coins in ${slices} slices; ${byCoin.size} coins have 2+ pools (${S.candidates.length} pools): reading their depths`);
      await readLinks(S.candidates);
      await pass(S.candidates);
      S.listedAt = Date.now();
    } else {
      await pass(S.deep.length ? S.deep : S.candidates);
    }
  } catch (e) {
    if (ONCE) throw e;
    log(`this round not finished (${said(e)}); the next starts in ${EVERY_MS / 1000} s`);
  }
  if (ONCE) break;
  await sleep(EVERY_MS);
}
