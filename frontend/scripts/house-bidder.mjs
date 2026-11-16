#!/usr/bin/env node
/**
 * house-bidder — the venue's disclosed house bidder for Jungle Bay Ape Club (and later GNSS Art).
 *
 * It keeps one fully funded, honestly priced collection bid at a time on OpenSea (Seaport 1.6,
 * behind OpenSea's SignedZone), for one or two NFTs, under fair value. Fair value comes from
 * wash-filtered real sales and aged listings (the data layer, scripts/house-bidder/data/); the
 * bid never looks at other people's bids. Every signature comes from the separate signer
 * (tools/house-signer), which holds the key and signs only orders that match its pins.
 * Plain-English guide: scripts/house-bidder/README.md.
 *
 * ─── SAFETY ─────────────────────────────────────────────────────────────────────
 *   • SHADOW BY DEFAULT. `shadow` reads the real market and plans real bids, and never
 *     contacts the signer: nothing is signed, posted or sent. Only `run --live` bids.
 *   • The bot never holds the key and never builds a transaction. It asks the signer.
 *   • STOP file in the keys folder: nothing new is signed or posted; the running bot
 *     cancels every bid and, if a 5-minute tail is open, kills on chain before it exits.
 *   • Bids end on their own within 30 minutes: if this computer dies, so do the bids.
 *
 * ─── COMMANDS ───────────────────────────────────────────────────────────────────
 *   status                       what the bot is doing, and whether it may go live
 *   shadow [--fresh]             plan with real data, sign nothing (the default)
 *   run --live                   bid for real (refuses unless every check passes)
 *   stop                         write the STOP file (the running bot cancels and exits)
 *   report [--month YYYY-MM] [--shadow]   the month's figures from the ledger
 *   backtest [--days 30] [--data <dir>]   replay saved sales through the planner and breakers
 *   canary --confirm --price <ETH>        one quantity-1 JBAC bid for 30 minutes, then cancel
 *   kill                         write STOP, then the signer's on-chain kill
 *   board [--port 8796]          a read-only page on this computer showing status.json
 *
 *   Every command takes --keys <dir> (default C:\Users\jimbo\evm-keys\house-bidder; never OneDrive).
 *   After a halt, a person restarts with --ack-halt.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_KEYS_DIR, isOneDrivePath } from './house-bidder/brain/config.mjs';
import { parseEth, roundDownToTick, utcMonth } from './house-bidder/brain/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Each command and the options it takes. Anything else is refused, never ignored. */
const COMMAND_FLAGS = Object.freeze({
  status: ['--keys', '--pipe'],
  shadow: ['--keys', '--fresh', '--ack-halt', '--verbose'],
  run: ['--keys', '--live', '--ack-halt', '--pipe', '--verbose'],
  stop: ['--keys'],
  report: ['--keys', '--month', '--shadow'],
  backtest: ['--keys', '--days', '--data'],
  canary: ['--keys', '--confirm', '--price', '--pipe', '--hold-min', '--verbose'],
  kill: ['--keys', '--pipe'],
  board: ['--keys', '--port'],
  help: [],
});
const VALUE_FLAGS = new Set(['--keys', '--month', '--days', '--data', '--price', '--port', '--pipe', '--hold-min']);

/**
 * The command line, checked. Returns { cmd, opts }; throws UsageError with a plain sentence.
 * @param {string[]} argv  process.argv.slice(2)
 */
export function parseArgs(argv) {
  const args = [...argv];
  let cmd = 'shadow';
  if (args.length && !args[0].startsWith('--')) cmd = args.shift();
  if (!(cmd in COMMAND_FLAGS)) throw new UsageError(`"${cmd}" is not a command. Commands: ${Object.keys(COMMAND_FLAGS).join(', ')}`);
  const opts = { keys: DEFAULT_KEYS_DIR };
  while (args.length) {
    const a = args.shift();
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (!flag.startsWith('--')) throw new UsageError(`unexpected "${a}"`);
    if (!COMMAND_FLAGS[cmd].includes(flag)) throw new UsageError(`${cmd} does not take ${flag}`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (VALUE_FLAGS.has(flag)) {
      const v = inline ?? args.shift();
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      opts[key] = v;
    } else {
      if (inline !== undefined) throw new UsageError(`${flag} takes no value`);
      opts[key] = true;
    }
  }

  if (isOneDrivePath(opts.keys)) throw new UsageError(`the keys folder ${opts.keys} is inside OneDrive, which can roll a file back: use a folder outside it`);
  if (cmd === 'run' && opts.live !== true) throw new UsageError('`run` bids for real only with --live. To plan without bidding, use `shadow`');
  if (cmd === 'canary') {
    if (opts.confirm !== true) throw new UsageError('`canary` places a real bid: say --confirm');
    if (opts.price === undefined) throw new UsageError('`canary` needs --price <ETH>, the bid for one JBAC');
    let wei;
    try {
      wei = parseEth(opts.price);
    } catch (e) {
      throw new UsageError(e.message);
    }
    // Prices go DOWN to the 0.00001 ETH tick, never up.
    opts.priceWei = roundDownToTick(wei);
    if (opts.priceWei <= 0n) throw new UsageError('--price rounds down to 0 at the 0.00001 ETH tick');
    opts.holdMin = opts.holdMin === undefined ? 0 : Number(opts.holdMin);
    if (!Number.isInteger(opts.holdMin) || opts.holdMin < 0 || opts.holdMin > 25) throw new UsageError('--hold-min must be whole minutes from 0 to 25 (the bid ends at 30)');
  }
  if (cmd === 'report') {
    if (opts.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) throw new UsageError('--month must look like 2026-11');
  }
  if (cmd === 'backtest') {
    opts.days = opts.days === undefined ? 30 : Number(opts.days);
    if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 90) throw new UsageError('--days must be a whole number from 1 to 90');
  }
  if (cmd === 'board') {
    opts.port = opts.port === undefined ? undefined : Number(opts.port);
    if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535)) throw new UsageError('--port must be a whole number from 1024 to 65535');
  }
  return { cmd, opts };
}

const log = (line) => console.log(`${new Date().toISOString()}  ${line}`);

// ─── wiring: the real modules, loaded only when a command needs them ─────────────────────────
const mod = (rel) => import(pathToFileURL(path.join(HERE, 'house-bidder', ...rel.split('/'))).href);

/** The data layer (BUILD-SPEC 2.4). It arrives on its own branch; say so plainly when it is not here. */
async function loadDataLayer() {
  const files = ['opensea.mjs', 'stream.mjs', 'chain.mjs', 'tape.mjs', 'fairValue.mjs'];
  for (const f of files) {
    if (!fs.existsSync(path.join(HERE, 'house-bidder', 'data', f))) throw new Error(`the data layer is not in this checkout (scripts/house-bidder/data/${f} is missing)`);
  }
  const [opensea, stream, chain, tape, fair] = await Promise.all(files.map((f) => mod(`data/${f}`)));
  return { createOpenSeaClient: opensea.createOpenSeaClient, createStream: stream.createStream, createChain: chain.createChain, buildTape: tape.buildTape, fairValue: fair.fairValue };
}

async function wireData(config, { slugs, verbose = false }) {
  const { ZERO_ADDRESS, COLLECTIONS } = await mod('brain/constants.mjs');
  const { levelLogger } = await mod('exec/logAdapter.mjs');
  const d = await loadDataLayer();
  const apiKey = config.openseaApiKey();
  // The data layer logs by level; levelLogger keeps each message (passing `log` itself printed
  // only the level). Debug lines, one per OpenSea call, show only with --verbose.
  const dataLog = levelLogger(log, { verbose });
  const opensea = d.createOpenSeaClient({ apiKey, log: dataLog });
  const stream = d.createStream({ apiKey, slugs, log: dataLog });
  const chain = d.createChain({ httpUrls: config.rpcHttp, wsUrl: config.rpcWs, house: config.house ?? ZERO_ADDRESS, contracts: { junglebay: COLLECTIONS.junglebay.address, gnssart: COLLECTIONS.gnssart.address }, log: dataLog });
  return { opensea, stream, chain, buildTape: d.buildTape, fairValue: d.fairValue };
}

/** Seaport 1.6 getOrderHash over eth_call, through the bot's own RPC list (read-only). */
async function orderHashReader(config) {
  const { createPublicClient, fallback, http } = await import('viem');
  const { mainnet } = await import('viem/chains');
  const { seaportOrderHash } = await mod('exec/verify.mjs');
  const client = createPublicClient({ chain: mainnet, transport: fallback(config.rpcHttp.map((u) => http(u, { timeout: 10_000 }))) });
  return seaportOrderHash(async ({ to, data }) => (await client.call({ to, data })).data);
}

function readSignerOrders(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn last line
    }
  }
  return out;
}

/** One bot per keys folder: a second copy would act on the same orders. */
function takeLock(keysDir) {
  const lock = path.join(keysDir, 'bot.lock');
  let pid = null;
  try {
    pid = Number(fs.readFileSync(lock, 'utf8').trim());
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    let alive = true;
    try {
      process.kill(pid, 0); // signal 0 only asks whether the process exists
    } catch (e) {
      alive = e.code !== 'ESRCH';
    }
    if (alive) throw new Error(`another house-bidder (pid ${pid}) is running on ${keysDir}: stop it first (Stop-Process -Id ${pid})`);
  }
  fs.writeFileSync(lock, `${process.pid}\n`);
  const release = () => {
    try {
      if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lock);
    } catch {
      // gone already
    }
  };
  process.on('exit', release);
  return release;
}

async function signerClient(opts) {
  const { createSignerClient, DEFAULT_PIPE } = await mod('exec/signerClient.mjs');
  return createSignerClient({ path: opts.pipe ?? DEFAULT_PIPE, log });
}

async function loadFor(mode, opts, signer = null) {
  const { loadConfig, realGit } = await mod('brain/config.mjs');
  return loadConfig({ mode, keysDir: opts.keys, frontendDir: path.join(HERE, '..'), scriptPath: fileURLToPath(import.meta.url), git: realGit(path.join(HERE, '..')), signer });
}

// ─── commands ────────────────────────────────────────────────────────────────────────────────
async function cmdRun(opts, mode) {
  const live = mode === 'live';
  fs.mkdirSync(opts.keys, { recursive: true });
  const release = takeLock(opts.keys);
  const signer = live ? await signerClient(opts) : null;
  const config = await loadFor(mode, opts, signer);
  const { withParams } = await mod('brain/params.mjs');
  const { createExposure } = await mod('brain/exposure.mjs');
  const { createRisk } = await mod('brain/risk.mjs');
  const { counterpartySets } = await mod('brain/monitor.mjs');
  const { stopPresent } = await mod('brain/config.mjs');
  const { createLedger } = await mod('exec/ledger.mjs');
  const { createExecutor, createShadowExecutor } = await mod('exec/executor.mjs');
  const { createLoop } = await mod('exec/loop.mjs');
  const params = withParams();
  const slugs = Object.keys(config.policy.collections).filter((s) => !live || config.policy.collections[s].enabled);
  const data = await wireData(config, { slugs, verbose: opts.verbose === true });
  const now = Date.now;
  const ledger = createLedger({ paths: config.paths, now, shadow: !live });
  const exposure = createExposure();
  const risk = createRisk({ params, now });
  const stopRequested = () => stopPresent(fs, opts.keys);
  const common = { house: config.house, policy: config.policy, params, opensea: data.opensea, exposure, risk, ledger, stopRequested, now, log };
  const executor = live ? createExecutor({ ...common, signer, getOrderHash: await orderHashReader(config) }) : createShadowExecutor(common);
  const sets = counterpartySets({ insiders: config.insiders, houseWallets: config.houseWallets, house: config.house, fundingWallet: config.policy.fundingWallet });
  const loop = createLoop({
    mode,
    config,
    params,
    data,
    executor,
    exposure,
    risk,
    ledger,
    sets,
    stopRequested,
    readSignerOrders: () => readSignerOrders(config.paths.signerOrders),
    now,
    log,
    onExit: () => {
      release();
      signer?.close();
      process.exit(0);
    },
  });
  // The STOP file wakes the loop the moment it appears (and every tick checks it anyway).
  try {
    fs.watch(opts.keys, (_e, name) => {
      if (name === 'STOP' || name === 'STOP.txt') loop.tick();
    });
  } catch {
    log('the keys folder cannot be watched: STOP is still checked every tick and before every signature');
  }
  process.on('SIGINT', () => {
    log('Stopped by Ctrl+C. Live bids end on their own within 30 minutes; to cancel them now, run `stop` while the bot runs.');
    loop.stop();
    release();
    signer?.close();
    process.exit(0);
  });
  log(`${live ? 'LIVE' : 'SHADOW'} house bidder for ${slugs.join(', ')}; ${JSON.stringify(config.describe())}`);
  await loop.start({ ackHalt: opts.ackHalt === true, fresh: opts.fresh === true });
}

async function cmdStatus(opts) {
  const { loadConfig, ConfigRefusal } = await mod('brain/config.mjs');
  const statusFile = path.join(opts.keys, 'status.json');
  try {
    const s = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    console.log(JSON.stringify(s, null, 2));
  } catch {
    console.log(`No status yet in ${opts.keys} (the bot has not run a tick here).`);
  }
  try {
    const c = await loadConfig({ mode: 'status', keysDir: opts.keys, frontendDir: path.join(HERE, '..') });
    console.log(JSON.stringify(c.describe(), null, 2));
  } catch (e) {
    console.log(e instanceof ConfigRefusal ? `Settings problems:\n${e.message}` : `Settings not read: ${e.message}`);
  }
  // Whether a live start would pass, with the signer asked for real (hello only).
  let signer = null;
  try {
    signer = await signerClient(opts);
    await loadFor('live', opts, signer);
    console.log('Live checks: all pass.');
  } catch (e) {
    console.log(e instanceof ConfigRefusal ? `Live checks that do not pass yet:\n${e.message}` : `Live checks not run: ${e.message}`);
  } finally {
    signer?.close();
  }
}

function cmdStop(opts) {
  fs.mkdirSync(opts.keys, { recursive: true });
  fs.writeFileSync(path.join(opts.keys, 'STOP'), `STOP written ${new Date().toISOString()}\n`);
  console.log(`STOP written in ${opts.keys}.`);
  console.log('A running bot cancels every bid at once (it watches for this file), kills on chain if a 5-minute tail is open, and exits.');
  console.log('Nothing new is signed or posted while the file is there. To bid again: delete STOP, then start the bot.');
}

async function cmdKill(opts) {
  cmdStop(opts);
  const signer = await signerClient(opts);
  try {
    log('Asking the signer to kill: WETH approval to zero, Seaport counter bump, NFT approvals off. This waits for each to be mined.');
    const r = await signer.kill();
    if (r.ok !== true) console.log(`The signer refused the kill (${r.field ?? '?'}): ${r.reason ?? 'no reason given'}`);
    else console.log(`Kill done: ${JSON.stringify(r.txs ?? r.hashes ?? r)}`);
  } catch (e) {
    console.log(`The signer did not answer (${e.message}). Run its own kill, which asks for the password: node tools/house-signer/src/cli.mjs kill --keys "${opts.keys}"`);
    process.exitCode = 1;
  } finally {
    signer.close();
  }
}

async function cmdReport(opts) {
  const { readLedger } = await mod('exec/ledger.mjs');
  const { monthlyReport, reportText } = await mod('brain/report.mjs');
  const entries = readLedger(fs, path.join(opts.keys, 'ledger.jsonl'));
  const month = opts.month ?? utcMonth(Date.now());
  console.log(reportText(monthlyReport(entries, { month, shadow: opts.shadow === true, nowMs: Date.now() })));
}

/**
 * Saved files for each slug from a folder: <slug>/<what>*.json or <slug>-<what>*.json (what =
 * sales or listings), as a list or under items / sales / listings / asset_events.
 */
export function loadSaved(dir, slugs, what) {
  const out = {};
  for (const slug of slugs) {
    const candidates = [];
    const sub = path.join(dir, slug);
    if (fs.existsSync(sub)) for (const f of fs.readdirSync(sub).sort()) if (f.startsWith(what) && f.endsWith('.json')) candidates.push(path.join(sub, f));
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) if (f.startsWith(`${slug}-${what}`) && f.endsWith('.json')) candidates.push(path.join(dir, f));
    if (!candidates.length) continue;
    const j = JSON.parse(fs.readFileSync(candidates[0], 'utf8'));
    out[slug] = Array.isArray(j) ? j : j.items ?? j.sales ?? j.listings ?? j.asset_events ?? [];
  }
  return out;
}

async function cmdBacktest(opts) {
  const { validatePolicy, validateInsiders } = await mod('brain/config.mjs');
  const { runBacktest } = await mod('brain/backtest.mjs');
  const { withParams } = await mod('brain/params.mjs');
  const { eth } = await mod('brain/util.mjs');
  const { counterpartySets } = await mod('brain/monitor.mjs');
  const d = await loadDataLayer();
  let rawPolicy;
  try {
    rawPolicy = JSON.parse(fs.readFileSync(path.join(opts.keys, 'policy.json'), 'utf8'));
  } catch {
    rawPolicy = JSON.parse(fs.readFileSync(path.join(HERE, 'house-bidder', 'exec', 'policy.example.json'), 'utf8'));
    log('no policy.json in the keys folder: using policy.example.json');
  }
  const { policy, problems } = validatePolicy(rawPolicy, { mode: 'shadow' });
  if (problems.length) throw new Error(problems.map((p) => p.reason).join('\n'));
  let insiders = { wallets: [], contracts: [] };
  try {
    insiders = validateInsiders(JSON.parse(fs.readFileSync(path.join(opts.keys, 'insiders.json'), 'utf8'))).insiders;
  } catch {
    // the built-in list still applies
  }
  const sets = counterpartySets({ insiders, house: policy.house, fundingWallet: policy.fundingWallet });
  const dir = opts.data ?? path.join(HERE, 'house-bidder', '__fixtures__');
  const sales = loadSaved(dir, Object.keys(policy.collections), 'sales');
  if (!Object.keys(sales).length) throw new Error(`no saved sales found in ${dir} (looked for <slug>/sales*.json and <slug>-sales*.json)`);
  const listings = loadSaved(dir, Object.keys(policy.collections), 'listings');
  const endSec = Math.max(...Object.values(sales).flat().map((s) => Number(s.time ?? s.event_timestamp ?? 0)));
  const r = runBacktest({ sales, listings, policy, params: withParams(), buildTape: d.buildTape, fairValue: d.fairValue, days: opts.days, endSec, insiderWallets: [...sets.people], houseWallets: [...sets.house] });
  console.log(`Backtest, ${opts.days} days to ${new Date(endSec * 1000).toISOString()} (${r.note})`);
  for (const [slug, c] of Object.entries(r.collections)) {
    console.log(`  ${slug}: ${c.sales} sales, ${c.posts} bids over ${c.hoursBidding.toFixed(0)} h, bought ${c.units} for ${eth(c.costWei)} ETH, holds ${c.held} worth ${eth(c.markWei)} after OpenSea's 1% (P&L ${eth(c.pnlWei)} ETH)`);
    console.log(`    breaker trips: ${Object.entries(c.trips).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}${c.integrity.length ? `; insider sales into the bid: ${c.integrity.length}` : ''}`);
  }
}

async function cmdCanary(opts) {
  fs.mkdirSync(opts.keys, { recursive: true });
  const release = takeLock(opts.keys);
  const signer = await signerClient(opts);
  try {
    const config = await loadFor('live', opts, signer);
    const { withParams } = await mod('brain/params.mjs');
    const { createExposure } = await mod('brain/exposure.mjs');
    const { createRisk, restoreRisk } = await mod('brain/risk.mjs');
    const { stopPresent } = await mod('brain/config.mjs');
    const { createLedger } = await mod('exec/ledger.mjs');
    const { createExecutor } = await mod('exec/executor.mjs');
    const { eth } = await mod('brain/util.mjs');
    const c = config.policy.collections.junglebay;
    if (!c?.enabled) throw new Error('the canary bids on JBAC: junglebay must be enabled in policy.json');
    if (opts.priceWei > c.maxUnitPriceWei) throw new Error(`--price is over junglebay's maxUnitPriceWei (${eth(c.maxUnitPriceWei)} ETH)`);
    const params = withParams({ bidLifetimeSec: 30 * 60 });
    const data = await wireData(config, { slugs: ['junglebay'], verbose: opts.verbose === true });
    const now = Date.now;
    const ledger = createLedger({ paths: config.paths, now });
    const entries = ledger.read();
    const risk = createRisk({ params, now });
    risk.restore(restoreRisk(entries, { nowMs: now(), params }));
    if (risk.halted()) throw new Error(`the bot is halted (${risk.halted().reason}): a person clears it with run --live --ack-halt first`);
    const exposure = createExposure();
    const executor = createExecutor({ house: config.house, policy: config.policy, params, opensea: data.opensea, signer, getOrderHash: await orderHashReader(config), exposure, risk, ledger, stopRequested: () => stopPresent(fs, opts.keys), now, log });
    executor.restoreBooks(entries);
    const snapshot = await data.chain.snapshot();
    exposure.setCounter(snapshot.house.counter);
    // A fresh REST read is what lifts the start-up data gap.
    const started = now();
    await data.opensea.bestListings('junglebay', { limit: 5 });
    risk.noteRestRead({ ok: true, startedAt: started });
    ledger.append('canary', { unitPriceWei: opts.priceWei, holdMin: opts.holdMin });
    log(`Canary: one JBAC bid at ${eth(opts.priceWei)} WETH, quantity 1, ending in 30 minutes.`);
    const r = await executor.post({ slug: 'junglebay', unitPriceWei: opts.priceWei, qty: 1, binding: 'canary', edgeBps: null }, { snapshot, heldBySlug: { junglebay: 0, gnssart: 0 } });
    if (!r.posted) throw new Error(`the canary bid was not posted: ${r.why}${r.detail ? ` (${r.detail})` : ''}`);
    log(`Posted ${r.orderHash}. Checking OpenSea lists it...`);
    let seen = false;
    for (let i = 0; i < 12 && !seen; i++) {
      await new Promise((ok) => setTimeout(ok, 10_000));
      try {
        seen = (await data.opensea.accountOffers(config.house)).some((o) => String(o.orderHash).toLowerCase() === r.orderHash.toLowerCase());
      } catch (e) {
        log(`house offers not read: ${e.message}`);
      }
    }
    log(seen ? 'OpenSea lists the canary bid: the order shape is accepted.' : 'OpenSea did not list the canary bid within 2 minutes.');
    if (opts.holdMin) await new Promise((ok) => setTimeout(ok, opts.holdMin * 60_000));
    const cancel = await executor.cancel(r.orderHash, 'stop');
    log(`Cancel: ${JSON.stringify(cancel)}`);
    const left = executor.tailLeft(r.orderHash);
    if (left) {
      log(`OpenSea issued a fill signature before the cancel: the bid can still be filled for ${left} s. Waiting it out.`);
      await new Promise((ok) => setTimeout(ok, (left + 5) * 1000));
    }
    log('Canary done.');
  } finally {
    signer.close();
    release();
  }
}

async function cmdBoard(opts) {
  const { serveBoard, DEFAULT_BOARD_PORT } = await mod('exec/board.mjs');
  serveBoard({ statusPath: path.join(opts.keys, 'status.json'), port: opts.port ?? DEFAULT_BOARD_PORT, log });
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\nRun "node scripts/house-bidder.mjs help" for the commands.`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  const { cmd, opts } = parsed;
  if (cmd === 'help') return console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  if (cmd === 'shadow') return cmdRun(opts, 'shadow');
  if (cmd === 'run') return cmdRun(opts, 'live');
  if (cmd === 'status') return cmdStatus(opts);
  if (cmd === 'stop') return cmdStop(opts);
  if (cmd === 'kill') return cmdKill(opts);
  if (cmd === 'report') return cmdReport(opts);
  if (cmd === 'backtest') return cmdBacktest(opts);
  if (cmd === 'canary') return cmdCanary(opts);
  if (cmd === 'board') return cmdBoard(opts);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    const lines = e?.refusals ? e.refusals.map((r) => `  - ${r.reason}`).join('\n') : e?.message ?? String(e);
    console.error(e?.refusals ? `Not starting:\n${lines}` : `Stopped: ${lines}`);
    process.exitCode = 1;
  });
}
