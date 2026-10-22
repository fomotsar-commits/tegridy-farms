// Shared by every script of the range-pool deploy pack. Pinned values come from config.json, which
// stage.mjs writes from the repo when the pack is made; nothing here is typed from memory. No key
// file is ever opened here: an address is asked of the owner's own Solana tool.
//
// The Solana library comes from the release folder's own copy, the one the other owner packs use:
// C:\Users\jimbo\solana-launch-release-2026-09-26\rehearsal\node_modules (version checked below).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACK = path.resolve(HERE, '..', '..');
export class Stopped extends Error {}
export class Unread extends Error {}

const halt = (m) => { console.error(`STOPPED: ${m}. Nothing was read and nothing was sent.`); process.exit(2); };
const cfgPath = path.join(PACK, 'config.json');
if (!fs.existsSync(cfgPath)) halt(`${cfgPath} is missing: this folder is not a staged pack`);

// Every file of the folder is the one staged (SHA256SUMS), and no file was added beside them.
{
  const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const sums = path.join(PACK, 'SHA256SUMS');
  if (!fs.existsSync(sums)) halt('SHA256SUMS is missing from this folder');
  const listed = new Map(fs.readFileSync(sums, 'utf-8').trim().split('\n').map((l) => [l.slice(66), l.slice(0, 64)]));
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (p !== path.join(PACK, 'owner-run')) walk(p); } else if (p !== sums) found.push(path.relative(PACK, p).replace(/\\/g, '/')); } };
  walk(PACK);
  const bad = found.filter((f) => !listed.has(f)).map((f) => `${f} (not staged)`)
    .concat([...listed].filter(([f, h]) => !fs.existsSync(path.join(PACK, f)) || hash(path.join(PACK, f)) !== h).map(([f]) => `${f} (changed or missing)`));
  if (bad.length) halt(`this folder is not as it was staged: ${bad.join(', ')}. Ask a session`);
}
export const CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

let req;
try { req = createRequire(CFG.packages); req.resolve('@solana/web3.js'); } catch { halt(`the Solana library was not found beside ${CFG.packages}`); }
const web3 = req('@solana/web3.js');
if (req('@solana/web3.js/package.json').version !== CFG.web3Version
  || crypto.createHash('sha256').update(fs.readFileSync(req.resolve('@solana/web3.js'))).digest('hex') !== CFG.web3Sha256) {
  halt(`${CFG.packages} does not hold the @solana/web3.js ${CFG.web3Version} this pack was made and rehearsed with`);
}
export { web3 };
export const { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } = web3;

export const pk = (s) => (s instanceof PublicKey ? s : new PublicKey(s));
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const sol = (l) => `${(Number(l) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '')} SOL`;
export const num = (n) => BigInt(n).toLocaleString('en-US');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- arguments and addresses ---------------------------------------------------------------
export function args(argv = process.argv.slice(2)) {
  return {
    has: (f) => argv.includes(f),
    get: (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; },
    known(list) { for (const a of argv) if (a.startsWith('--') && !list.includes(a)) throw new Stopped(`unknown option ${a}. Options: ${list.join(' ')}`); },
  };
}
export function address(text, what) {
  try { return new PublicKey(text).toBase58(); } catch { throw new Stopped(`${what} "${text ?? ''}" is not a Solana address. Nothing was sent.`); }
}
/** The address of a key file, asked of the owner's tool (`solana address -k`, which prints nothing secret). */
export function addressOfKeyFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  const r = spawnSync(CFG.solanaExe, ['address', '-k', file], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return new PublicKey((r.stdout ?? '').trim()).toBase58(); } catch { return null; }
}
/** A key file the build tool wrote by itself (target\deploy\*-keypair.json) is never the program key. */
export const isBuildToolKey = (file) => /[\\/]target[\\/]deploy[\\/][^\\/]*-keypair\.json$/i.test(path.resolve(file));

// ---- reading a chain patiently: an unread is UNREAD, never a pass and never a fault ---------
export async function read(label, fn, tries = 7) {
  let wait = 800; let last = '';
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = String(e?.message ?? e).slice(0, 300); await sleep(wait); wait = Math.min(wait * 2, 15000); }
  }
  throw new Unread(`UNREAD: ${label} could not be read (${last})`);
}
export const connect = (rpc) => new Connection(rpc, { commitment: 'confirmed', disableRetryOnRateLimit: true });
/** Which chain. A folder runs on its one network only: the mainnet folder on mainnet, the devnet
 *  folder on devnet, a rehearsal folder on a LOCAL chain. The address books are read-only. */
const HOME = { mainnet: 'mainnet', devnet: 'devnet', rehearsal: 'local', key: null };
export async function cluster(conn, allow = ['mainnet', 'devnet', 'local']) {
  const genesis = await read("the chain's genesis hash", () => conn.getGenesisHash());
  const kind = genesis === CFG.genesis.mainnet ? 'mainnet' : genesis === CFG.genesis.devnet ? 'devnet' : genesis === CFG.genesis.testnet ? 'testnet' : 'local';
  if (HOME[CFG.kind] && kind !== HOME[CFG.kind]) throw new Stopped(`this folder is for ${HOME[CFG.kind].toUpperCase()} and ${conn.rpcEndpoint} is ${kind}. Nothing was sent`);
  if (!allow.includes(kind)) throw new Stopped(`${conn.rpcEndpoint} is ${kind}; this step runs on ${allow.join(' or ')} only. Nothing was sent`);
  const slot = await read('the current slot', () => conn.getSlot('confirmed'));
  const words = { mainnet: 'MAINNET (real money)', devnet: 'DEVNET (the practice network: no real money)', local: `a LOCAL rehearsal chain (genesis ${genesis})` }[kind];
  return { kind, genesis, slot, words };
}
export const rpcFor = (a) => a.get('--rpc') ?? CFG.rpc[HOME[CFG.kind]];
export const account = (conn, addr, label = `account ${addr}`) => read(label, () => conn.getAccountInfo(pk(addr), 'confirmed'));
export const balance = (conn, addr) => read(`the balance of ${addr}`, async () => BigInt(await conn.getBalance(pk(addr), 'confirmed')));
export const rent = (conn, bytes) => read(`the rent for ${bytes} bytes`, async () => BigInt(await conn.getMinimumBalanceForRentExemption(bytes, 'confirmed')));
export async function clock(conn) {
  const a = await account(conn, 'SysvarC1ock11111111111111111111111111111111', 'the network clock');
  return Number(Buffer.from(a.data).readBigInt64LE(32));
}

// ---- a report: every line is PASS, REFUSED or UNREAD; the exit code says which ---------------
export class Report {
  constructor(title) { this.lines = []; console.log(title); }
  pass(w) { this.lines.push({ s: 'pass', w }); console.log(`  PASS    : ${w}`); return true; }
  refuse(w) { this.lines.push({ s: 'refused', w }); console.log(`  REFUSED : ${w}`); return false; }
  unread(w) { this.lines.push({ s: 'unread', w }); console.log(`  UNREAD  : ${w}`); return false; }
  note(w) { console.log(`  note    : ${w}`); }
  check(ok, good, bad = good) { return ok ? this.pass(good) : this.refuse(bad); }
  get refused() { return this.lines.filter((l) => l.s === 'refused'); }
  get ok() { return this.lines.every((l) => l.s === 'pass'); }
  end(good, bad) {
    if (this.ok) { console.log(`\nRESULT: ${good}`); return 0; }
    if (this.refused.length) { console.log(`\nRESULT: REFUSED (${this.refused.length} line${this.refused.length > 1 ? 's' : ''}). ${bad}`); return 1; }
    console.log('\nRESULT: NOT KNOWN. Something could not be read. That is not a pass and not a fault. Run it again.');
    return 3;
  }
}
/** Runs a script body: exit 0 pass, 1 refused, 2 stopped before doing anything, 3 not known. Never process.exit mid-read. */
export async function main(fn) {
  try { process.exitCode = await fn(); } catch (e) {
    if (e instanceof Unread) { console.log(`\n${e.message}\nRESULT: NOT KNOWN. Something could not be read. That is not a pass and not a fault. Run it again.`); process.exitCode = 3; }
    else { console.error(`STOPPED: ${e?.message ?? e}`); process.exitCode = 2; }
  }
}

// ---- the program file ------------------------------------------------------------------------
export const BINARY = CFG.binary ? path.join(PACK, CFG.binary.file) : null; // none in the key folder
/** The one file to deploy: its length and sha256 are the pinned ones and it names our program id.
 *  The vault is not looked for here: the compiler folds a compared key into code, so its bytes need
 *  not appear (the rehearsal showed it). 4-verify-program.mjs proves the vault is the admin on chain. */
export function checkBinary(R) {
  const b = BINARY && fs.existsSync(BINARY) ? fs.readFileSync(BINARY) : null;
  if (!R.check(!!b && b.length === CFG.binary.bytes && sha256(b) === CFG.binary.sha256,
    `${CFG.binary.file}: ${num(CFG.binary.bytes)} bytes, sha256 ${CFG.binary.sha256} (${CFG.kind === 'mainnet' ? 'two separate builds of the same commit matched; CI builds it again after the deploy' : 'the build this folder was staged with'})`,
    `${CFG.binary.file} is missing or is NOT the reviewed build (${b ? `sha256 ${sha256(b)}, ${num(b.length)} bytes` : 'no such file'}). Do not upload anything`)) return null;
  R.check(b.indexOf(pk(CFG.programId).toBuffer()) >= 0, `the build names its own program id ${CFG.programId}`, `the build does NOT name the program id ${CFG.programId}: it was built for another id`);
  const deny = CFG.denyKeys.filter((k) => b.indexOf(pk(k).toBuffer()) >= 0 || b.indexOf(Buffer.from(k)) >= 0);
  R.check(deny.length === 0, `it holds none of the ${CFG.denyKeys.length} keys Raydium's code hard-codes`, `it holds a key Raydium's code hard-codes: ${deny.join(', ')}`);
  R.check(b.indexOf(pk(CFG.placeholder).toBuffer()) < 0, 'it does not hold the placeholder id', 'it still holds the placeholder id');
  return b;
}
export function strayPrograms() {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.so$/i.test(e.name) && path.resolve(p) !== path.resolve(BINARY)) out.push(path.relative(PACK, p)); } };
  walk(PACK);
  return out;
}

// ---- the upgradeable loader's accounts ------------------------------------------------------
export const PROGRAMDATA_HEADER = 45;
export const BUFFER_HEADER = 37;
export const programDataAddress = (program = CFG.programId) => PublicKey.findProgramAddressSync([pk(program).toBuffer()], pk(CFG.addr.loader))[0].toBase58();
/** Before a deploy, the program's address and its data address must hold nothing: the loader
 *  makes both with a plain create, which fails on an account that already holds any SOL. Anyone
 *  who knows the address can put SOL there, and then that address can never be deployed. */
export async function addressesFree(conn, R, program = CFG.programId, net = 'this network') {
  const data = programDataAddress(program);
  const [p, d] = await read('the program address and its data address', () => conn.getMultipleAccountsInfo([pk(program), pk(data)], 'confirmed'));
  R.check(!d, `its data address ${data} holds nothing on ${net}`, `its data address ${data} ALREADY holds ${sol(d?.lamports ?? 0)} on ${net}: someone put SOL there, and the loader can then never deploy this address. Do not upload. Ask a session: a new program key is needed`);
  return { program: p, data: d };
}
/** null if the program id has no account; otherwise what the loader says about it. */
export async function readProgram(conn, program = CFG.programId) {
  const p = await account(conn, program, `the program account ${program}`);
  if (!p) return null;
  const out = { exists: true, owner: p.owner.toBase58(), executable: p.executable, lamports: BigInt(p.lamports) };
  if (out.owner !== CFG.addr.loader || p.data.length !== 36 || Buffer.from(p.data).readUInt32LE(0) !== 2) return { ...out, foreign: true };
  out.programData = new PublicKey(p.data.subarray(4, 36)).toBase58();
  const d = await account(conn, out.programData, `the program's data account ${out.programData}`);
  if (!d) return { ...out, noData: true };
  const b = Buffer.from(d.data);
  return { ...out, dataBytes: b.length, dataLamports: BigInt(d.lamports), deploySlot: b.readBigUInt64LE(4), authority: b[12] === 1 ? new PublicKey(b.subarray(13, 45)).toBase58() : null, body: b.subarray(PROGRAMDATA_HEADER) };
}
export async function readBuffer(conn, addr) {
  const a = await account(conn, addr, `the buffer ${addr}`);
  if (!a) return null;
  const b = Buffer.from(a.data);
  if (a.owner.toBase58() !== CFG.addr.loader || b.length < BUFFER_HEADER || b.readUInt32LE(0) !== 1) return { foreign: true, owner: a.owner.toBase58() };
  return { bytes: b.length, lamports: BigInt(a.lamports), authority: b[4] === 1 ? new PublicKey(b.subarray(5, 37)).toBase58() : null, body: b.subarray(BUFFER_HEADER) };
}
/** The program's code as the chain holds it, compared byte for byte with the pinned build. */
export function sameAsBuild(body, build) {
  if (!body || body.length < build.length) return { same: false, why: `${body ? num(body.length) : 'no'} bytes of code, the build is ${num(build.length)}` };
  const code = body.subarray(0, build.length);
  const tail = body.subarray(build.length);
  if (!code.equals(build)) return { same: false, why: `its code hashes to ${sha256(code)}, not the build's ${sha256(build)}` };
  if (tail.some((x) => x !== 0)) return { same: false, why: 'it holds bytes after the build that are not zero' };
  return { same: true, why: `byte for byte the build (sha256 ${sha256(code)})` };
}

/** The devnet practice run, read from devnet itself: its throwaway program deployed byte for byte
 *  the devnet folder's build, at exact size, and handed to the vault's address. */
export async function devnetRunDone(R) {
  const d = CFG.devnetRun;
  if (!d) return;
  const conn = connect(d.rpc);
  const p = await readProgram(conn, d.programId);
  const code = p?.body?.subarray(0, d.bytes);
  const same = !!code && code.length === d.bytes && sha256(code) === d.sha256 && p.body.subarray(d.bytes).every((x) => x === 0);
  R.check(same && p.authority === CFG.addr.vault, `the devnet practice run is done: ${d.programId} on devnet is byte for byte its build, and the vault's address holds it`,
    `the devnet practice run is not done, or not as written (${d.programId} on devnet: ${!p ? 'not deployed' : !same ? 'not its build' : `authority ${p.authority ?? 'NONE'}`}). Do sitting 2 first, in ${d.folder}`);
}

/** The paying wallet also pays the pool pack's upgrade. Until that pack's Day 0 has parked its two
 *  buffers (or its upgrade is in), its SOL is in this wallet too, so it is set aside here. */
export async function poolPackReserve(conn, R) {
  const pp = CFG.poolPack;
  if (!pp) return 0n;
  const prog = await readProgram(conn, pp.program);
  if (prog?.body?.length >= pp.newBytes && sha256(prog.body.subarray(0, pp.newBytes)) === pp.newSha256) { R.note('the pool pack\'s upgrade is in: none of this wallet\'s SOL is for it'); return 0n; }
  const bufs = await Promise.all(pp.bufferKeyFiles.map(async (f) => { const a = addressOfKeyFile(f); return a ? readBuffer(conn, a) : null; }));
  const parked = bufs.filter((b) => b && !b.foreign && b.authority === CFG.addr.vault).length;
  if (parked === bufs.length) { R.note('the pool pack\'s two buffers are parked with the vault: none of this wallet\'s SOL is for it'); return 0n; }
  if (parked > 0 || bufs.some((b) => b)) { R.refuse('the pool pack is half way through its Day 0 (one of its buffers is up, not both): finish that first, then run this again'); return 0n; }
  R.note(`the pool pack's Day 0 has not run: ${sol(pp.peakLamports)} of this wallet is set aside for it`);
  return BigInt(pp.peakLamports);
}

// ---- the multisig ------------------------------------------------------------------------------
export async function readMultisig(conn) {
  const a = await account(conn, CFG.addr.multisig, 'the multisig');
  if (!a) return null;
  const d = Buffer.from(a.data);
  if (a.owner.toBase58() !== CFG.addr.squads || !d.subarray(0, 8).equals(Buffer.from(CFG.squads.multisigDisc, 'hex'))) return { foreign: true };
  let o = 94 + (d[94] ? 33 : 1) + 1;
  const n = d.readUInt32LE(o); o += 4;
  const members = [];
  for (let i = 0; i < n; i++) { members.push({ key: new PublicKey(d.subarray(o, o + 32)).toBase58(), mask: d[o + 32] }); o += 33; }
  return {
    configAuthority: new PublicKey(d.subarray(40, 72)).toBase58(), threshold: d.readUInt16LE(72), timeLock: d.readUInt32LE(74),
    transactionIndex: Number(d.readBigUInt64LE(78)), staleIndex: Number(d.readBigUInt64LE(86)), members,
  };
}
