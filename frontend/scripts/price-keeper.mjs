#!/usr/bin/env node
/**
 * price-keeper — keeps the venue's pool prices in line with Jupiter's.
 *
 * Every pass it reads every pool, and where a pool's price is far enough from Jupiter's for a
 * round trip to pay, it makes ONE transaction with two swaps: buy the coin where it is cheap,
 * sell it where it is dear. The last swap's minimum out is at least what the first spent plus
 * a profit floor, so the chain refuses any round trip that would lose coin; a refused one
 * costs the network fee only. Every round trip is test-run first, and is sent only when the
 * test run shows the keeper's coin grew by the floor. The logic, and every check made on what
 * Jupiter returns before it is signed, is src/lib/solana/keeper/ (unit-tested).
 *
 * Who earns: the keeper takes the gap, which comes out of that pool's LPs (whoever trades
 * first takes it); the venue takes its usual share of our pool's fee on the keeper's swap.
 * Jupiter's leg pays the fee of whichever pool Jupiter routes through. Raydium's is excluded,
 * and a route that touches one refused, unless KEEPER_ALLOW_RAYDIUM says yes.
 *
 * ─── SAFETY ─────────────────────────────────────────────────────────────────────
 *   • DRY RUN BY DEFAULT. `run` test-runs and logs; it sends only with `--live`.
 *     `wrap` and `withdraw` test-run unless given `--send`.
 *   • Its OWN wallet, holding a small float: never the vault, never a personal wallet.
 *     The key is a LOCAL file (KEEPER_KEYPAIR), read only when something is sent. Make one:
 *       node scripts/make-operator-keypair.mjs <path>
 *   • Its OWN Jupiter key (JUPITER_API_KEY), never the site's: the site's one request a
 *     second is shared by every visitor. Without one, Jupiter's keyless host, while it lasts.
 *   • SOL is held WRAPPED, in the keeper's own account (`wrap`), so a round trip neither
 *     wraps nor unwraps.
 *
 * ─── SETTINGS (environment) ─────────────────────────────────────────────────────
 *   KEEPER_KEYPAIR          path to the keeper's key file (needed to send)
 *   KEEPER_WALLET           the keeper's address, for a dry run without the key
 *   KEEPER_RPC_URL          Solana RPC (default: the public mainnet one)
 *   JUPITER_API_KEY         the keeper's own Jupiter key
 *   KEEPER_SITE             where the pool list is read (default https://memetics.finance)
 *   KEEPER_MAX_TRADE_USD    largest round trip (default 25)
 *   KEEPER_MIN_PROFIT_USD   least gain a round trip must make (default 0.01)
 *   KEEPER_INTERVAL_SEC     seconds between full passes when nothing moves (default 60)
 *   KEEPER_CHECK_SEC        seconds between quick checks of every pool and price (default 10);
 *                           a change starts a full pass at once
 *   KEEPER_DUST_MIN_USD     leftover tokens worth this much are sold for SOL (default 1)
 *   KEEPER_DUST_EVERY_MIN   minutes between leftover sales (default 60)
 *   KEEPER_MAX_DAILY_SOL    most SOL the keeper may spend on fees and new accounts in a UTC
 *                           day; past it, it only test-runs until the next day (default 0.05)
 *   KEEPER_LOG_DIR          where the earnings log and the stop file live (default: the key
 *                           file's folder)
 *   KEEPER_STOP_FILE        while this file (or the same name with .txt) exists, nothing is
 *                           sent, checked at every send (default <KEEPER_LOG_DIR>/price-keeper-STOP)
 *   KEEPER_PRIORITY_MICROLAMPORTS  priority fee per compute unit (default 10000)
 *   KEEPER_ALLOW_RAYDIUM    yes = Jupiter's leg may go through Raydium (default no; the owner
 *                           allowed it for the keeper 2026-10-31, for coins only Raydium trades)
 *   KEEPER_PAY_SETUP        yes = open a coin's account on its first trip even when that trip
 *                           does not earn the ~0.0015 SOL rent back (default no)
 *   KEEPER_DASHBOARD_PORT   the dashboard's port on this computer (default 8790)
 *
 * ─── COMMANDS ───────────────────────────────────────────────────────────────────
 *   status                     the keeper's address and what it holds
 *   pools                      every pool on the venue, and whether the keeper can trade it
 *   run [--once] [--live]      one pass, or keep watching (Ctrl+C stops)
 *   report                     what the keeper earned and spent, day by day, from its log
 *   dashboard                  a page on this computer (http://127.0.0.1:8790) showing what the
 *                              keeper holds and what it made, read from the chain; read-only
 *   wrap <SOL> [--send]        move SOL into the keeper's wrapped-SOL account
 *   withdraw <address> [--send]  unwrap, then send all USDC and all SOL but 0.01 to <address>
 */

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { redactRpcUrl } from '../../scripts/lib/redact-url.mjs';

// ─── Make the bundler-targeted TS modules run under Node (tegridy-launch-operator.mjs's
// loader, plus an empty `import.meta.env` for the modules that read Vite's settings) ───
const loaderSource = `
import { stripTypeScriptTypes } from 'node:module';

export async function resolve(specifier, context, nextResolve) {
  const relative = specifier[0] === '.';
  const hasExt = /\\.[cm]?[jt]sx?$/.test(specifier);
  if (!relative || hasExt) return nextResolve(specifier, context);
  // As the bundler does: a .ts module, else a .js one (launchMetadata/validate.js).
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
const lib = (rel) => import(pathToFileURL(path.join(HERE, '..', 'src', 'lib', ...rel.split('/'))).href);

const { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
const spl = await import('@solana/spl-token');
const { runCycle, poolCoverage, fingerprint, sellDust, DEFAULT_SETTINGS } = await lib('solana/keeper/cycle.ts');
const { readActivity, results, byDay, madeSol, expectedHoldings } = await lib('solana/keeper/history.ts');
const { REGISTERED_PROGRAM_ID } = await lib('solana/cpswap/program.ts');
const { QUOTE_COINS } = await lib('solana/lp/quotes.ts');
const { PRICE_IDS_MAX } = await lib('solana/lp/poolList.ts');
const { jupiterApi } = await lib('solana/keeper/jupiterApi.ts');
const { DEFAULT_LIMITS } = await lib('solana/keeper/plan.ts');
const { pollConfirm } = await lib('solana/confirm.ts');

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const KEEP_LAMPORTS = 10_000_000n; // what `withdraw` leaves behind for fees and rent

const env = process.env;
const RPC = env.KEEPER_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const SITE = env.KEEPER_SITE?.trim() || 'https://memetics.finance';
const num = (name, fallback) => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, not "${raw}"`);
  return n;
};
const yes = (name) => {
  const raw = env[name]?.trim().toLowerCase() ?? '';
  if (raw === '' || raw === 'no' || raw === 'false' || raw === '0') return false;
  if (raw === 'yes' || raw === 'true' || raw === '1') return true;
  throw new Error(`${name} must be yes or no, not "${raw}"`);
};

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const args = rest.filter((a) => !a.startsWith('--'));
const log = (line) => console.log(`${new Date().toISOString()}  ${line}`);

const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!r.ok) throw new Error(`${method}: the RPC answered ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
};
const conn = new Connection(RPC, 'confirmed');

function loadKey() {
  const file = env.KEEPER_KEYPAIR?.trim();
  if (!file) throw new Error('KEEPER_KEYPAIR is not set: name the keeper’s key file to send');
  // Never echo a parse error: it quotes the start of the file, which is the secret.
  let bytes;
  try {
    bytes = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('the key file could not be read as a list of 64 numbers (make one with scripts/make-operator-keypair.mjs)');
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
    throw new Error('the key file is not a list of 64 numbers (make one with scripts/make-operator-keypair.mjs)');
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

/** The keeper's address: from its key file when there is one, else KEEPER_WALLET. */
function keeperAddress(key) {
  if (key) return key.publicKey;
  if (env.KEEPER_KEYPAIR?.trim()) return loadKey().publicKey;
  if (env.KEEPER_WALLET?.trim()) return new PublicKey(env.KEEPER_WALLET.trim());
  throw new Error('set KEEPER_KEYPAIR (or KEEPER_WALLET for a dry run)');
}

async function sendSigned(tx, key) {
  tx.sign([key]);
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const { outcome } = await pollConfirm(conn, signature, 60_000);
  return { signature, outcome };
}

/** Test-run `instructions` from the keeper; with --send, sign and send them. */
async function once(owner, instructions, key) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message());
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    log(`Test run refused: ${JSON.stringify(sim.value.err)}`);
    for (const l of (sim.value.logs ?? []).slice(-6)) log(`  ${l}`);
    process.exitCode = 1;
    return;
  }
  if (!key) return log('Test run passed. Nothing sent: add --send to send it.');
  const r = await sendSigned(tx, key);
  log(`Sent ${r.signature}: ${r.outcome}`);
}

/** What the keeper holds. A failed read throws; only an account that does not exist reads as 0. */
async function holdings(owner) {
  const [wsolAta, usdcAta] = [WSOL, USDC].map((m) => spl.getAssociatedTokenAddressSync(m, owner, true));
  const [o, w, u] = await conn.getMultipleAccountsInfo([owner, wsolAta, usdcAta], 'confirmed');
  const amount = (a) => (a ? spl.unpackAccount(PublicKey.default, a).amount : 0n);
  return { sol: BigInt(o?.lamports ?? 0), wsol: amount(w), usdc: amount(u), wsolAta, usdcAta, wsolLamports: BigInt(w?.lamports ?? 0), hasWsol: !!w };
}

/**
 * Where `withdraw` may send: a wallet. An address the chain holds as anything else (a token
 * account, a multisig's own account rather than its vault, a program) could never move what
 * it is sent, so it is refused. An address with no account yet must be a normal wallet key.
 */
async function withdrawTarget(to) {
  const a = await conn.getAccountInfo(to, 'confirmed');
  if (a ? !a.owner.equals(SystemProgram.programId) : !PublicKey.isOnCurve(to.toBytes())) {
    throw new Error(`${to.toBase58()} is not a wallet (${a ? `the chain holds it as an account of ${a.owner.toBase58()}` : 'no account, and not a wallet key'}): nothing sent`);
  }
}

const fmt = (raw, decimals) => (Number(raw) / 10 ** decimals).toFixed(Math.min(decimals, 6));

// ─── The earnings log: one line per sent trip. Only addresses, coin names the keeper sets
// itself, numbers and words: nothing a token chose (its claimed name) is written, so the file
// opens safely anywhere, a spreadsheet included. ───
const LOG_DIR = env.KEEPER_LOG_DIR?.trim() || (env.KEEPER_KEYPAIR?.trim() ? path.dirname(env.KEEPER_KEYPAIR.trim()) : process.cwd());
const TRADES = path.join(LOG_DIR, 'price-keeper-trades.csv');
const STOP_FILE = env.KEEPER_STOP_FILE?.trim() || path.join(LOG_DIR, 'price-keeper-STOP');
const HEADER = 'time,kind,coin,coin_in,gained,sol_spent,outcome,signature,pool';

function writeTrip(r) {
  const n = (v, d) => (v === null ? '' : fmt(v, d));
  const pool = r.pool.replace(/[^1-9A-HJ-NP-Za-km-z >-]/g, '');
  const line = [r.at, r.kind, r.coin.symbol, fmt(r.coinIn, r.coin.decimals), n(r.gained, r.coin.decimals), n(r.lamportsSpent, 9), r.outcome, r.signature, pool].join(',');
  if (!fs.existsSync(TRADES)) fs.writeFileSync(TRADES, HEADER + '\n');
  fs.appendFileSync(TRADES, line + '\n');
}

/** The log's trips. A figure that does not read as a number (a hand edit) reads as none. */
function readTrips() {
  if (!fs.existsSync(TRADES)) return [];
  const [, ...rows] = fs.readFileSync(TRADES, 'utf8').trim().split(/\r?\n/);
  const figure = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return rows.filter(Boolean).map((row) => {
    const [time, kind, coin, coinIn, gained, solSpent, outcome] = row.split(',');
    return { day: String(time).slice(0, 10), kind, coin, coinIn: figure(coinIn), gained: figure(gained), solSpent: figure(solSpent), outcome };
  });
}

const today = () => new Date().toISOString().slice(0, 10);

/** The stop file, under its own name or the name Windows Explorer gives a new text file. */
const stopped = () => {
  try {
    return fs.existsSync(STOP_FILE) || fs.existsSync(`${STOP_FILE}.txt`);
  } catch {
    return true; // a folder that cannot be read is no proof the owner did not ask to stop
  }
};

// ─── The dashboard: a read-only page on this computer only. What the keeper holds and what
// it made, read from the chain, set beside the robot's own status file. ───
const STATUS = path.join(LOG_DIR, 'price-keeper-status.json');
const HISTORY = path.join(LOG_DIR, 'price-keeper-history.json');
const HISTORY_VERSION = 1;
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
/** Coin accounts whose history is read, at most: anyone can open coin accounts in the keeper's name. */
const MAX_TRACKED = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const said = (e) => (e instanceof Error ? e.message : String(e));

/** A read the public RPC turned away for speed is tried again, slower. */
async function rpcPatient(method, params) {
  for (let i = 0; ; i++) {
    try {
      return await rpc(method, params);
    } catch (e) {
      if (i >= 5 || !/429|too many/i.test(said(e))) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

/** The history read so far, kept beside the log so a restart reads only what is new. */
function loadHistory(owner) {
  try {
    const j = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
    if (j.version === HISTORY_VERSION && j.owner === owner) {
      const big = (a) => ({ ...a, fee: BigInt(a.fee), sol: BigInt(a.sol), deposits: BigInt(a.deposits), tokens: a.tokens.map((t) => ({ ...t, change: BigInt(t.change) })) });
      return { newest: j.newest ?? {}, skipped: new Set(j.skipped ?? []), acts: new Map(j.activities.map((a) => [a.signature, big(a)])) };
    }
  } catch {
    // none yet, or unreadable: read from the chain again
  }
  return { newest: {}, skipped: new Set(), acts: new Map() };
}

function saveHistory(owner, h) {
  try {
    const text = JSON.stringify({ version: HISTORY_VERSION, owner, newest: h.newest, skipped: [...h.skipped], activities: [...h.acts.values()] }, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    fs.writeFileSync(`${HISTORY}.tmp`, text);
    fs.renameSync(`${HISTORY}.tmp`, HISTORY);
  } catch {
    // a copy only: the chain is read again next time
  }
}

/** Every transaction of `address` since the last one read, oldest first, into `h`. False when a transaction is not served yet. */
async function readNew(address, h, readOne) {
  const sigs = [];
  for (let before; ; ) {
    const page = await rpcPatient('getSignaturesForAddress', [address, { limit: 1000, until: h.newest[address], before, commitment: 'confirmed' }]);
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  for (const { signature } of sigs.reverse()) {
    if (!h.acts.has(signature) && !h.skipped.has(signature)) {
      const tx = await rpcPatient('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (!tx) return false;
      const a = readOne(tx);
      if (a) h.acts.set(signature, a);
      else h.skipped.add(signature);
      await sleep(400);
    }
    h.newest[address] = signature;
  }
  return true;
}

/** The keeper's wallet and every coin account it has, and the latest slot they were read at. */
async function walletNow(owner) {
  const bal = await rpcPatient('getBalance', [owner, { commitment: 'confirmed' }]);
  let slot = bal.context.slot;
  const accounts = [];
  for (const programId of TOKEN_PROGRAMS) {
    const r = await rpcPatient('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    slot = Math.max(slot, r.context.slot);
    for (const a of r.value) {
      const info = a.account.data.parsed.info;
      accounts.push({ address: a.pubkey, mint: info.mint, amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals, lamports: BigInt(a.account.lamports) });
    }
  }
  return { lamports: BigInt(bal.value), accounts, slot };
}

async function dashboard() {
  const owner = keeperAddress().toBase58();
  const port = num('KEEPER_DASHBOARD_PORT', 8790);
  const page = fs.readFileSync(path.join(HERE, 'price-keeper-dashboard.html'), 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('the dashboard page has no script');
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  const jupiter = jupiterApi({ key: env.JUPITER_API_KEY });
  const indexFetch = (input, init) => fetch(new URL(String(input), SITE), init);
  const venueProgram = REGISTERED_PROGRAM_ID.toBase58();
  const fixed = new Map(QUOTE_COINS.map((q) => [q.mint, q.symbol]));
  const history = loadHistory(owner);
  let venue = { rows: [], at: 0, note: 'not read yet' };
  let prices = { usd: {}, at: 0, note: 'not read yet' };

  const symbolOf = (mint) => fixed.get(mint) ?? venue.rows.find((r) => r.tokenMint === mint)?.symbol ?? null;
  const onVenue = (mint) => fixed.has(mint) || venue.rows.some((r) => r.tokenMint === mint);
  const ui = (raw, decimals) => Number(raw) / 10 ** decimals;
  const coin = (mint, raw, decimals) => {
    const amount = ui(raw, decimals);
    const price = onVenue(mint) ? prices.usd[mint] : undefined;
    return { mint, symbol: symbolOf(mint), onVenue: onVenue(mint), amount, usd: price === undefined ? null : amount * price };
  };
  const coins = (list) => list.map((t) => coin(t.mint, t.change, t.decimals));
  const solUsd = () => prices.usd[WSOL.toBase58()] ?? null;
  const netUsd = (r) => {
    const sol = solUsd();
    if (sol === null) return null;
    const left = coins(r.madeTokens).reduce((sum, c) => sum + (c.usd ?? 0), 0);
    return ui(r.madeSol - r.fees - r.deposits, 9) * sol + left;
  };
  const resultsOut = (r) => ({
    trades: r.trades,
    refused: r.refused,
    sales: r.sales,
    madeSol: ui(r.madeSol, 9),
    leftovers: coins(r.madeTokens),
    fees: ui(r.fees, 9),
    deposits: ui(r.deposits, 9),
    netUsd: netUsd(r),
    unpriced: coins(r.madeTokens).filter((c) => c.usd === null).length,
  });

  async function build() {
    if (Date.now() - venue.at > 10 * 60_000) {
      const rows = await poolCoverage({ rpc, indexFetch }).catch((e) => said(e));
      venue = typeof rows === 'string' ? { ...venue, at: Date.now(), note: `pools not read: ${rows}` } : { rows, at: Date.now(), note: null };
    }
    const pools = new Set(venue.rows.map((r) => r.pool));
    const readOne = (tx) => readActivity(tx, owner, venueProgram, pools);
    // Twice at most: a trade landing between the wallet read and the history read shows as a
    // difference that the second read explains.
    let wallet;
    let historyNote = null;
    let check;
    for (let round = 0; round < 2; round++) {
      wallet = await walletNow(owner);
      const known = (a) => onVenue(a.mint) ? 0 : 1;
      const tracked = [...wallet.accounts].sort((a, b) => known(a) - known(b)).slice(0, MAX_TRACKED);
      historyNote = null;
      for (const address of [owner, ...tracked.map((a) => a.address)]) {
        if (!(await readNew(address, history, readOne))) historyNote = 'the newest transactions are not served yet: read again in a moment';
      }
      saveHistory(owner, history);
      if (wallet.accounts.length > MAX_TRACKED) historyNote = `only ${MAX_TRACKED} of ${wallet.accounts.length} coin accounts are followed (strangers can open them)`;
      const expected = expectedHoldings([...history.acts.values()], wallet.slot);
      const lines = [];
      const heldSol = wallet.lamports + wallet.accounts.reduce((sum, a) => sum + a.lamports, 0n);
      if (expected.sol !== heldSol) lines.push(`SOL: the history explains ${fmt(expected.sol, 9)}, the wallet holds ${fmt(heldSol, 9)}`);
      for (const a of tracked) {
        if (a.mint === WSOL.toBase58()) continue;
        const want = expected.tokens.get(a.mint) ?? 0n;
        if (want !== a.amount) lines.push(`${symbolOf(a.mint) ?? '?'} (${a.mint}): the history explains ${fmt(want, a.decimals)}, the wallet holds ${fmt(a.amount, a.decimals)}`);
      }
      check = { ok: lines.length === 0, lines, slot: wallet.slot };
      if (check.ok) break;
    }
    if (Date.now() - prices.at > 60_000) {
      const mints = [...new Set([WSOL.toBase58(), USDC.toBase58(), ...wallet.accounts.map((a) => a.mint), ...[...history.acts.values()].flatMap((a) => a.tokens.map((t) => t.mint))])].filter(onVenue);
      try {
        const usd = {};
        for (let i = 0; i < mints.length; i += PRICE_IDS_MAX) Object.assign(usd, await jupiter.prices(mints.slice(i, i + PRICE_IDS_MAX)));
        prices = { usd, at: Date.now(), note: null };
      } catch (e) {
        prices = { ...prices, at: Date.now(), note: `Jupiter prices not read: ${said(e)}` };
      }
    }

    let robot = null;
    let robotNote = null;
    try {
      robot = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
    } catch (e) {
      robotNote = fs.existsSync(STATUS) ? `status not read: ${said(e)}` : 'no status yet';
    }
    const acts = [...history.acts.values()].sort((a, b) => b.slot - a.slot);
    const wsol = wallet.accounts.find((a) => a.mint === WSOL.toBase58());
    const held = wallet.accounts.filter((a) => a.mint !== WSOL.toBase58() && a.amount > 0n).map((a) => coin(a.mint, a.amount, a.decimals));
    const solPlain = ui(wallet.lamports, 9);
    const solWrapped = ui(wsol?.amount ?? 0n, 9);
    const rent = wallet.accounts.reduce((sum, a) => sum + a.lamports, 0n) - (wsol?.amount ?? 0n);
    const sol = solUsd();
    const r = results(acts);
    const nameOfPool = (pool) => venue.rows.find((v) => v.pool === pool);
    return {
      builtAt: Date.now(),
      wallet: owner,
      rpc: redactRpcUrl(RPC),
      solUsd: sol,
      notes: [venue.note, prices.note, historyNote].filter(Boolean),
      robot,
      robotNote,
      stopped: stopped(),
      stopFile: STOP_FILE,
      holdings: {
        solPlain,
        solWrapped,
        rentSol: ui(rent, 9),
        rentAccounts: wallet.accounts.length,
        coins: held,
        worthUsd: sol === null ? null : (solPlain + solWrapped + ui(rent, 9)) * sol + held.reduce((sum, c) => sum + (c.usd ?? 0), 0),
        unvalued: held.filter((c) => c.usd === null).length,
      },
      results: {
        ...resultsOut(r),
        putIn: { sol: ui(r.putInSol, 9), coins: coins(r.putInTokens) },
        takenOut: { sol: ui(r.takenOutSol, 9), coins: coins(r.takenOutTokens) },
      },
      days: byDay(acts).map((d) => ({ day: d.day, ...resultsOut(d.results) })),
      recent: acts.slice(0, 50).map((a) => ({
        signature: a.signature,
        at: a.at,
        kind: a.kind,
        ok: a.ok,
        sol: ui(a.kind === 'trade' || a.kind === 'sale' ? madeSol(a) : a.sol, 9),
        fee: ui(a.fee, 9),
        deposits: ui(a.deposits, 9),
        coins: coins(a.tokens),
        pools: a.pools.map((pool) => ({ pool, symbol: nameOfPool(pool)?.symbol ?? null, token: nameOfPool(pool)?.tokenMint ?? null, quote: nameOfPool(pool)?.quote.symbol ?? null })),
        from: a.from,
      })),
      check,
    };
  }

  let state = null;
  let building = null;
  const current = async () => {
    if (!building && (!state || Date.now() - state.builtAt > 30_000)) {
      building = build()
        .then((s) => (state = s))
        .catch((e) => (state = { ...(state ?? {}), builtAt: Date.now(), error: said(e) }))
        .finally(() => (building = null));
    }
    if (!state) await building;
    return state;
  };

  const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
  const server = http.createServer(async (req, res) => {
    // Only this computer, by its own names: a web page elsewhere that points a name of its
    // own at 127.0.0.1 is turned away.
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return res.writeHead(421, common).end();
    if (req.method !== 'GET') return res.writeHead(405, common).end();
    if (req.url === '/') return res.writeHead(200, { ...common, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp }).end(page);
    if (req.url === '/state.json') {
      const body = JSON.stringify(await current());
      return res.writeHead(200, { ...common, 'content-type': 'application/json' }).end(body);
    }
    return res.writeHead(404, common).end();
  });
  server.on('error', (e) => {
    log(e.code === 'EADDRINUSE' ? `A dashboard already runs at http://127.0.0.1:${port}: open that one (or set KEEPER_DASHBOARD_PORT)` : `Dashboard stopped: ${said(e)}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    log(`Dashboard for ${owner}: http://127.0.0.1:${port}`);
    log('  read-only, on this computer only; Ctrl+C stops it (the robot keeps running)');
  });
  current();
  await new Promise(() => {});
}

async function main() {
  if (cmd === 'dashboard') return dashboard();

  if (cmd === 'status') {
    const owner = keeperAddress();
    const h = await holdings(owner);
    log(`Keeper ${owner.toBase58()} on ${redactRpcUrl(RPC)}`);
    log(`  SOL ${fmt(h.sol, 9)} (fees and rent) · wrapped SOL ${fmt(h.wsol, 9)} · USDC ${fmt(h.usdc, 6)}`);
    return;
  }

  if (cmd === 'pools') {
    const rows = await poolCoverage({ rpc, indexFetch: (input, init) => fetch(new URL(String(input), SITE), init) });
    if (typeof rows === 'string') throw new Error(`pools not read: ${rows}`);
    const can = rows.filter((r) => r.problem === null);
    log(`${rows.length} pools on the venue; the keeper can trade ${can.length}`);
    for (const r of rows) {
      const also = r.problem === null && r.siblings ? ` (also traded against our ${r.siblings} other pool${r.siblings > 1 ? 's' : ''} of this pair)` : '';
      log(`  ${r.problem === null ? 'yes' : 'NO '}  ${r.name}  ${r.pool}${r.problem ? `: ${r.problem}` : ''}${also}`);
    }
    return;
  }

  if (cmd === 'report') {
    const trips = readTrips();
    if (!trips.length) return log(`No trips logged yet (${TRADES})`);
    for (const day of [...new Set(trips.map((t) => t.day))].sort()) {
      const of = trips.filter((t) => t.day === day);
      const done = of.filter((t) => t.outcome === 'confirmed');
      const gained = (coin) => done.filter((t) => t.coin === coin).reduce((sum, t) => sum + (t.gained ?? 0), 0);
      const spent = of.reduce((sum, t) => sum + (t.solSpent ?? 0), 0);
      log(`${day}: ${done.length} of ${of.length} sent trips confirmed · gained ${gained('SOL').toFixed(6)} SOL and ${gained('USDC').toFixed(6)} USDC · spent ${spent.toFixed(6)} SOL on fees and new accounts`);
    }
    return;
  }

  if (cmd === 'run') {
    const live = flag('--live');
    const key = live ? loadKey() : null;
    const owner = keeperAddress(key);
    const settings = {
      ...DEFAULT_LIMITS,
      ...DEFAULT_SETTINGS,
      maxTradeUsd: num('KEEPER_MAX_TRADE_USD', DEFAULT_LIMITS.maxTradeUsd),
      minProfitUsd: num('KEEPER_MIN_PROFIT_USD', DEFAULT_LIMITS.minProfitUsd),
      microLamports: num('KEEPER_PRIORITY_MICROLAMPORTS', DEFAULT_SETTINGS.microLamports),
      allowRaydium: yes('KEEPER_ALLOW_RAYDIUM'),
      payNewAccountRent: yes('KEEPER_PAY_SETUP'),
    };
    settings.dustMinUsd = num('KEEPER_DUST_MIN_USD', DEFAULT_SETTINGS.dustMinUsd);
    const intervalMs = num('KEEPER_INTERVAL_SEC', 60) * 1000;
    const checkMs = num('KEEPER_CHECK_SEC', 10) * 1000;
    const dustMs = num('KEEPER_DUST_EVERY_MIN', 60) * 60_000;
    const maxDailySol = num('KEEPER_MAX_DAILY_SOL', 0.05);
    // The day's SOL spent on fees and new accounts, kept here: a log that cannot be written or
    // read (open in a spreadsheet, a missing folder) never switches the cap off. Seeded from the
    // log when it can be read.
    const spent = { day: today(), sol: 0 };
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      spent.sol = readTrips().filter((t) => t.day === spent.day).reduce((sum, t) => sum + (t.solSpent ?? 0), 0);
    } catch (e) {
      log(`Earnings log not read (${e instanceof Error ? e.message : String(e)}): today's spending starts at 0`);
    }
    const spentToday = () => {
      if (spent.day !== today()) Object.assign(spent, { day: today(), sol: 0 });
      return spent.sol;
    };
    /** Why nothing may be sent right now, or null. */
    const holdReason = () => (stopped() ? `paused: ${STOP_FILE} exists` : spentToday() >= maxDailySol ? `paused until tomorrow (UTC): ${maxDailySol} SOL spent today` : null);
    // Asked again at every send, not only between passes: a stop or the cap holds at once.
    const send = async (tx) => {
      const hold = holdReason();
      if (hold) throw new Error(hold);
      return sendSigned(tx, key);
    };
    const record = (r) => {
      spentToday();
      spent.sol += r.lamportsSpent === null ? 0 : Number(r.lamportsSpent) / 1e9;
      try {
        writeTrip(r);
      } catch (e) {
        log(`Earnings log not written (${e instanceof Error ? e.message : String(e)}): the trip still counts towards today's cap`);
      }
    };
    const io = {
      rpc,
      jupiter: jupiterApi({ key: env.JUPITER_API_KEY }),
      owner,
      indexFetch: (input, init) => fetch(new URL(String(input), SITE), init),
      send: undefined,
      record,
      log,
    };
    log(`Keeper ${owner.toBase58()}, ${live ? 'LIVE: round trips that pass their test run are SENT' : 'dry run: nothing is sent'}`);
    log(`  RPC ${redactRpcUrl(RPC)} · Jupiter ${env.JUPITER_API_KEY?.trim() ? 'own key' : 'keyless'} · up to $${settings.maxTradeUsd} a trip · floor $${settings.minProfitUsd}`);
    log(`  Raydium ${settings.allowRaydium ? 'ALLOWED' : 'refused'} · new coin accounts ${settings.payNewAccountRent ? 'opened on any paying trip' : 'opened only when the trip earns the rent back'}`);
    log(`  quick check every ${checkMs / 1000} s · full pass at least every ${intervalMs / 1000} s · at most ${maxDailySol} SOL a day on fees and new accounts`);
    log(`  earnings log ${TRADES} · to pause sending, create ${STOP_FILE}`);
    let watch = null;
    let seen = null;
    let lastPass = 0;
    let lastDust = 0;
    let held = null;
    // What the dashboard shows of a live robot: a file it rewrites every round. One that cannot
    // be written only leaves the dashboard saying the robot has not been seen.
    let passSeen = null;
    const beat = () => {
      if (!live) return;
      try {
        fs.writeFileSync(STATUS, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, hold: held, pass: passSeen, spentTodaySol: spentToday(), maxDailySol, checkSec: checkMs / 1000, intervalSec: intervalMs / 1000 }));
      } catch {
        // never the robot's business
      }
    };
    for (;;) {
      // Said once each time it changes.
      const hold = live ? holdReason() : null;
      if (hold !== held) log(hold ?? 'Sending again');
      held = hold;
      beat();
      io.send = live && !hold ? send : undefined;
      // The quick check's reading is taken BEFORE a pass: a move during the pass shows as a
      // change at the next check, never as the starting point.
      let now = null;
      if (watch) {
        try {
          now = await fingerprint(io, watch);
        } catch (e) {
          log(`Quick check not read: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!watch || Date.now() - lastPass >= intervalMs || (now !== null && now !== seen)) {
        seen = now;
        try {
          const r = await runCycle(io, settings);
          watch = r.watch;
          log(`Pass done: ${r.pools} pools, ${r.gaps} gaps, ${r.sent} sent`);
          passSeen = { at: new Date().toISOString(), pools: r.pools, gaps: r.gaps, sent: r.sent };
        } catch (e) {
          log(`Pass stopped: ${e instanceof Error ? e.message : String(e)}`);
          passSeen = { at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
        }
        lastPass = Date.now();
        beat();
      }
      if (Date.now() - lastDust >= dustMs) {
        lastDust = Date.now();
        await sellDust(io, settings).catch((e) => log(`Leftover sale stopped: ${e instanceof Error ? e.message : String(e)}`));
      }
      if (flag('--once')) return;
      await new Promise((r) => setTimeout(r, checkMs));
    }
  }

  if (cmd === 'wrap') {
    const sol = Number(args[0]);
    if (!(sol > 0)) throw new Error('wrap <SOL>: say how much SOL to wrap');
    const key = flag('--send') ? loadKey() : null;
    const owner = keeperAddress(key);
    const ata = spl.getAssociatedTokenAddressSync(WSOL, owner, true);
    const lamports = BigInt(Math.round(sol * 1e9));
    log(`Wrapping ${fmt(lamports, 9)} SOL into ${ata.toBase58()}`);
    return once(owner, [
      spl.createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, WSOL),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
      spl.createSyncNativeInstruction(ata),
    ], key);
  }

  if (cmd === 'withdraw') {
    if (!args[0]) throw new Error('withdraw <address>: say where the money goes');
    const to = new PublicKey(args[0]);
    await withdrawTarget(to);
    const key = flag('--send') ? loadKey() : null;
    const owner = keeperAddress(key);
    const h = await holdings(owner);
    const ixs = [];
    // Closing the wrapped-SOL account turns all of it, rent included, back into plain SOL.
    if (h.hasWsol) ixs.push(spl.createCloseAccountInstruction(h.wsolAta, owner, owner));
    if (h.usdc > 0n) {
      const toAta = spl.getAssociatedTokenAddressSync(USDC, to, true);
      ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(owner, toAta, to, USDC));
      ixs.push(spl.createTransferCheckedInstruction(h.usdcAta, USDC, toAta, owner, h.usdc, 6));
    }
    const sol = h.sol + h.wsolLamports - KEEP_LAMPORTS;
    if (sol > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: to, lamports: sol }));
    if (!ixs.length) return log('Nothing to withdraw.');
    log(`Withdrawing to ${to.toBase58()}: USDC ${fmt(h.usdc, 6)} · SOL ${fmt(sol > 0n ? sol : 0n, 9)} (keeps ${fmt(KEEP_LAMPORTS, 9)} SOL for fees)`);
    return once(owner, ixs, key);
  }

  console.log('Commands: status | pools | run [--once] [--live] | report | dashboard | wrap <SOL> [--send] | withdraw <address> [--send]. Settings: the top of scripts/price-keeper.mjs.');
}

main().catch((e) => {
  log(`Stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
