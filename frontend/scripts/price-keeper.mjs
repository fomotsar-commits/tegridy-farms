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
 *
 * ─── COMMANDS ───────────────────────────────────────────────────────────────────
 *   status                     the keeper's address and what it holds
 *   pools                      every pool on the venue, and whether the keeper can trade it
 *   run [--once] [--live]      one pass, or keep watching (Ctrl+C stops)
 *   report                     what the keeper earned and spent, day by day, from its log
 *   wrap <SOL> [--send]        move SOL into the keeper's wrapped-SOL account
 *   withdraw <address> [--send]  unwrap, then send all USDC and all SOL but 0.01 to <address>
 */

import fs from 'node:fs';
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

async function main() {
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
    for (;;) {
      // Said once each time it changes.
      const hold = live ? holdReason() : null;
      if (hold !== held) log(hold ?? 'Sending again');
      held = hold;
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
        } catch (e) {
          log(`Pass stopped: ${e instanceof Error ? e.message : String(e)}`);
        }
        lastPass = Date.now();
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

  console.log('Commands: status | pools | run [--once] [--live] | report | wrap <SOL> [--send] | withdraw <address> [--send]. Settings: the top of scripts/price-keeper.mjs.');
}

main().catch((e) => {
  log(`Stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
