#!/usr/bin/env node
/**
 * tegridy-launch — OPERATOR SIGNING HARNESS.
 *
 * The out-of-band driver for OUR OWN bonding curve's protocol-level instructions:
 * `initialize_global` and `update_global`. Read-only commands need no key at all.
 * Mirrors `solana-dbc-operator.mjs` in shape and safety posture; the pure logic it
 * drives lives in `src/lib/launcher/solana/tegridyLaunch.ts` (unit-tested, and its
 * config math diffed against the real `curve.rs` over 50,009 cases).
 *
 * ─── THE PROGRAM IS NOT DEPLOYED ───────────────────────────────────────────────
 * `declare_id!` in lib.rs:101 is a PLACEHOLDER keypair nobody holds. Verified null
 * on BOTH clusters on 2026-08-01 (mainnet-beta slot 436,599,196; devnet slot
 * 480,487,191). Every write command therefore READS THE CHAIN FIRST and refuses to
 * build a transaction against an address that holds no program — a tx to a
 * nonexistent program cannot succeed, and a Squads ceremony built on one is wasted.
 * Pass `--program-id` once a real deploy exists.
 *
 * ─── SAFETY / DOCTRINE ─────────────────────────────────────────────────────────
 *   • Secrets come from ENV/CLI ONLY. Nothing is hardcoded or committed: the RPC URL
 *     and the operator keypair (a LOCAL file path) both arrive at runtime.
 *   • DEFAULT is PRINT (partial-signed base64) for out-of-band Squads co-signing.
 *     `--send` is opt-in. On mainnet `global.authority` is the Squads multisig, so
 *     the local key is NOT a sufficient signer set and the authority pre-check below
 *     fails closed before anything is built.
 *   • Every guard the program enforces is ALSO checked here, against state read from
 *     chain, so an operator gets a sentence instead of a bare Anchor code (6000+)
 *     after a multisig ceremony.
 *
 * ─── THE ORDERING, WHICH IS THE OPPOSITE OF THE OBVIOUS GUESS ──────────────────
 * `initialize_global` does NOT require the cp-swap AmmConfig to exist. lib.rs:184-187
 * and lib.rs:259-263 say `cp_swap_program`/`amm_config` MAY both be zero at init,
 * precisely because the AmmConfig is created by a cp-swap admin action AFTER this
 * program is deployed. `global` is a singleton PDA, so `initialize_global` runs
 * exactly once — which is why `update_global` CAN set both (lib.rs:360-367). The
 * comment at lib.rs:347-355 records what happened when it could not: migration was
 * left PERMANENTLY disabled, fixable only by a program upgrade, and CI missed it
 * because the tests pass real values at initialization.
 *
 * So the real sequence is:
 *   1. deploy the program under a REAL keypair (not the placeholder id)
 *   2. `init-global`      — AMM addresses may be zero; the AmmConfig need not exist
 *   3. cp-swap admin creates the AmmConfig
 *   4. `update-global --cp-swap-program … --amm-config …`   ← the ONLY way to set them
 *   5. migration is possible; until step 4 `migrate_to_amm` fails AmmNotConfigured (6015)
 *
 * `status` prints exactly which of these steps is outstanding.
 *
 * ─── WHY A CUSTOM LOADER ───────────────────────────────────────────────────────
 * `tegridyLaunch.ts` is written for the Vite bundler; the inline loader below strips
 * TypeScript types so a plain `node scripts/…` run works with no build step and no
 * extra dependency (Node >= 23.6). Same trick as solana-dbc-operator.mjs, minus the
 * shims that file needs for imports this one does not have.
 *
 * ─── RUN ───────────────────────────────────────────────────────────────────────
 * From the `frontend/` dir so node_modules resolve:
 *
 *   SOLANA_RPC_URL=https://your-keyed-rpc \
 *   node scripts/tegridy-launch-operator.mjs status
 *
 *   SOLANA_RPC_URL=… OPERATOR_KEYPAIR=/abs/path/authority.json \
 *   node scripts/tegridy-launch-operator.mjs init-global \
 *     --fee-bps 100 --virtual-sol 30000000000 --virtual-token 1073000000000000 \
 *     --supply 1000000000000000 --target 11685689681 --reserve 42156720 \
 *     --fee-recipient <base58>
 *
 * Commands: status | derive | check-config | init-global | update-global | help
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

// ─── Self-contained loader: make the bundler-targeted TS module run under Node ───
const loaderSource = `
import { stripTypeScriptTypes } from 'node:module';

export async function resolve(specifier, context, nextResolve) {
  const relative = specifier[0] === '.';
  const hasExt = /\\.[cm]?[jt]sx?$/.test(specifier);
  if (relative && !hasExt) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!/\\.tsx?$/.test(new URL(url).pathname)) return nextLoad(url, context);
  const r = await nextLoad(url, { ...context, format: 'module' });
  const src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
  return { ...r, format: 'module', source: stripTypeScriptTypes(src, { mode: 'strip' }) };
}
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = pathToFileURL(path.join(HERE, '..', 'src', 'lib', 'launcher', 'solana', 'tegridyLaunch.ts')).href;

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = await import('@solana/web3.js');
const L = await import(LIB);

// ─── Program constants (verified against lib.rs / state.rs, not copied blind) ────

// deployer::ID under `--features devnet` (lib.rs:126-127). A NON-devnet build embeds
// the System Program sentinel instead (lib.rs:128-129), which nobody can sign for.
const DEVNET_DEPLOYER_ID = '8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8';
const SYSTEM_SENTINEL = '11111111111111111111111111111111';

// Blockhash is fetched at 'finalized' for durability; the expiry window below is
// measured against the 'confirmed' tip, which is where the cluster actually judges it.
const BLOCKHASH_COMMITMENT = 'finalized';

// ─── Arg parsing (mirrors solana-dbc-operator.mjs) ──────────────────────────────
//
// Valueless flags MUST be listed so they never swallow the token that follows them:
// `--send init-global …` would otherwise consume the subcommand as `--send`'s value
// and silently fall through to help.
const BOOLEAN_FLAGS = new Set(['send', 'pause', 'unpause']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/**
 * Abort with an operator-readable message.
 *
 * THROWS rather than calling `process.exit()`. Every write command has an in-flight
 * RPC socket by the time it can fail, and exiting hard underneath undici aborts the
 * process with a native libuv assertion ("UV_HANDLE_CLOSING", src/win/async.c) and
 * an exit code of 127 — so a clean, expected refusal looked like a crash and could
 * not be distinguished from one by exit code. Unwinding lets Node close its handles
 * and `main` set a real exit code.
 */
class OperatorError extends Error {}

function fail(msg) {
  throw new OperatorError(msg);
}

function requireEnv(name) {
  const v = (process.env[name] ?? '').trim();
  if (!v) fail(`missing required env ${name}`);
  return v;
}

function requireFlag(flags, name) {
  const v = flags[name];
  if (v === undefined || v === true) fail(`missing required --${name} <value>`);
  return String(v);
}

/** u64 flags are parsed as BigInt — these values exceed Number.MAX_SAFE_INTEGER. */
function requireU64Flag(flags, name) {
  const raw = requireFlag(flags, name);
  if (!/^\d+$/.test(raw)) fail(`--${name} must be a non-negative integer (lamports/base units), got "${raw}"`);
  const v = BigInt(raw);
  if (v > (1n << 64n) - 1n) fail(`--${name} exceeds u64`);
  return v;
}

function optionalU64Flag(flags, name) {
  const raw = flags[name];
  if (raw === undefined || raw === true) return undefined;
  return requireU64Flag(flags, name);
}

/**
 * Parse a pubkey flag into a NORMALISED base58 string (what the encoders take),
 * rejecting `Pubkey::default()` where the program does. lib.rs:361/365/375/379
 * reject the zero key for cp_swap_program, amm_config, authority and fee_recipient —
 * a zero would brick the protocol or surface later as `AmmNotConfigured` and read
 * like a setup mistake.
 */
function optionalPubkeyFlag(flags, name, { rejectZero = true } = {}) {
  const raw = flags[name];
  if (raw === undefined || raw === true) return undefined;
  const s = String(raw).trim();
  let pk;
  try {
    pk = new PublicKey(s);
  } catch {
    return fail(`--${name} is not a valid base58 pubkey: "${s}"`);
  }
  if (rejectZero && pk.equals(PublicKey.default)) {
    fail(`--${name} may not be the zero pubkey — the program rejects it (InvalidParameter, 6009)`);
  }
  return pk.toBase58();
}

// ─── Keypair loading (mirrors solana-dbc-operator.mjs) ──────────────────────────
async function loadKeypair(envName) {
  const raw0 = requireEnv(envName);
  const kpPath = raw0.replace(/^~/, os.homedir());
  if (!fs.existsSync(kpPath)) fail(`${envName} keypair file not found: ${kpPath}`);
  const raw = fs.readFileSync(kpPath, 'utf8').trim();
  let secret;
  if (raw.startsWith('[')) {
    secret = Uint8Array.from(JSON.parse(raw)); // Solana CLI format
  } else {
    const bs58 = (await import('bs58')).default; // Phantom export saved to a file
    secret = bs58.decode(raw);
  }
  return Keypair.fromSecretKey(secret);
}

// ─── Formatting ─────────────────────────────────────────────────────────────────

/** Exact lamports → SOL. Integer/fraction split — never a float. */
function sol(lamports) {
  const n = BigInt(lamports);
  const whole = n / 1_000_000_000n;
  const frac = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} SOL`;
}

function programId(flags) {
  return flags['program-id'] ? String(flags['program-id']).trim() : L.TEGRIDY_LAUNCH_PROGRAM_ID;
}

function connect() {
  return new Connection(requireEnv('SOLANA_RPC_URL'), 'confirmed');
}

/** Render a `ProgramDeployment` honestly — an unreadable RPC is never "not deployed". */
function printDeployment(d) {
  switch (d.kind) {
    case 'deployed':
      console.log(`  program      : DEPLOYED (owner ${d.owner}, ${d.dataLen} bytes)`);
      return;
    case 'not-deployed':
      console.log('  program      : NOT DEPLOYED — no account at this address');
      return;
    case 'not-a-program':
      console.log(`  program      : ACCOUNT EXISTS BUT IS NOT EXECUTABLE (owner ${d.owner})`);
      console.log('                 someone funded the address; the program is still not deployed');
      return;
    default:
      console.log(`  program      : COULD NOT READ — ${d.reason}`);
      console.log('                 this is NOT a statement that the program is absent');
  }
}

function printGlobal(g, programKind) {
  if (!g) {
    console.log(
      programKind === 'unreadable'
        ? '  global       : not read — the program account could not be read, so nothing is known'
        : '  global       : not read — there is no program at this address to be configured',
    );
    return;
  }
  switch (g.kind) {
    case 'not-initialized':
      console.log(`  global       : NOT INITIALIZED (${g.address}) — run \`init-global\``);
      return;
    case 'malformed':
      console.log(`  global       : MALFORMED at ${g.address} — ${g.reason}`);
      return;
    case 'unreadable':
      console.log(`  global       : COULD NOT READ — ${g.reason}`);
      return;
    default:
      break;
  }
  const c = g.config;
  const venue = L.graduationVenue(c);
  console.log(`  global       : INITIALIZED (${g.address})`);
  console.log(`    authority             : ${c.authority}`);
  console.log(`    fee_recipient         : ${c.feeRecipient}`);
  console.log(`    trade_fee_bps         : ${c.tradeFeeBps}`);
  console.log(`    initial_virtual_sol   : ${c.initialVirtualSol} (${sol(c.initialVirtualSol)})`);
  console.log(`    initial_virtual_token : ${c.initialVirtualToken}`);
  console.log(`    token_total_supply    : ${c.tokenTotalSupply}`);
  console.log(`    graduation_target     : ${c.graduationTargetLamports} (${sol(c.graduationTargetLamports)})`);
  console.log(`    migration_reserve     : ${c.migrationReserveLamports} (${sol(c.migrationReserveLamports)})`);
  console.log(`    paused                : ${c.paused}${c.paused ? '  (buys blocked; SELLS STAY OPEN)' : ''}`);
  if (venue.kind === 'configured') {
    console.log(`    cp_swap_program       : ${venue.cpSwapProgram}`);
    console.log(`    amm_config            : ${venue.ammConfig}`);
  } else {
    console.log('    graduation venue      : NOT CONFIGURED YET');
    console.log('                            migrate_to_amm fails AmmNotConfigured (6015) until');
    console.log('                            `update-global --cp-swap-program … --amm-config …`');
  }
}

// ─── Transaction stamping (reused from dbcClient.prepareAndSign) ────────────────

/**
 * Stamp feePayer + recentBlockhash + lastValidBlockHeight, then partial-sign.
 * Refuses to hand back a transaction that cannot be signed or sent — an unstamped
 * tx is the failure mode that left the DBC harness unable to build one for months.
 */
async function prepareAndSign(connection, tx, payer, signWith) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(BLOCKHASH_COMMITMENT);
  if (typeof blockhash !== 'string' || blockhash.trim().length === 0) {
    fail('getLatestBlockhash returned no blockhash — refusing to emit a transaction that cannot be sent');
  }
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  if (signWith) tx.partialSign(signWith);
  return tx;
}

async function printValidityWindow(connection, tx) {
  console.log(`  feePayer            : ${tx.feePayer?.toBase58?.() ?? tx.feePayer}`);
  console.log(`  blockhash           : ${tx.recentBlockhash}`);
  console.log(`  lastValidBlockHeight: ${tx.lastValidBlockHeight ?? '(unknown)'}`);
  if (typeof tx.lastValidBlockHeight !== 'number') return;
  try {
    // Measured against the CONFIRMED tip, not 'finalized': the cluster expires a tx
    // against the processed tip, and 'finalized' lags it by ~32 slots — an
    // over-estimate, the one direction an operator must never be misled in.
    const now = await connection.getBlockHeight('confirmed');
    const slots = tx.lastValidBlockHeight - now;
    console.log(`  expires in          : ~${slots} slots (~${Math.round(slots * 0.4)}s from now)`);
  } catch (e) {
    console.log(`  expires in          : (block-height lookup failed: ${e?.message ?? e})`);
  }
}

async function emitTransaction(connection, tx, sent, label) {
  if (sent) return;
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  console.log(`\n── ${label}: partial-signed transaction (base64) ──`);
  await printValidityWindow(connection, tx);
  console.log('');
  console.log('  • Imported into a SQUADS PROPOSAL (the intended path on mainnet): Squads stores');
  console.log('    the INSTRUCTIONS; the later vaultTransactionExecute carries its own fresh');
  console.log('    blockhash, so the window above does NOT apply.');
  console.log('  • Co-signed and broadcast AS THIS RAW TX: the window above DOES apply —');
  console.log('    submit before it lapses, or re-run this command to re-stamp a blockhash.\n');
  console.log(b64);
}

async function maybeSend(connection, tx, flags) {
  if (!flags.send) return false;
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(
    { signature: sig, blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight },
    'confirmed',
  );
  console.log(`\n✅ sent. signature: ${sig}`);
  return true;
}

// ─── Instructions ───────────────────────────────────────────────────────────────
//
// The DATA encoders live in tegridyLaunch.ts (unit-tested there) — hand-rolled Borsh
// with no IDL is exactly the surface that fails silently, so it must not sit in an
// untested script. Only the ACCOUNT lists live here.

/** `initialize_global` accounts, in declaration order (lib.rs:1222-1240). */
function ixInitializeGlobal({ pid, authority, feeRecipient, globalPda, args }) {
  return new TransactionInstruction({
    programId: pid,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true }, // pays rent for `global`
      { pubkey: feeRecipient, isSigner: false, isWritable: false },
      { pubkey: globalPda, isSigner: false, isWritable: true }, // `init`
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(L.encodeInitializeGlobalData(args)),
  });
}

/** `update_global` accounts, in declaration order (lib.rs:1242-1252). */
function ixUpdateGlobal({ pid, globalPda, authority, args }) {
  return new TransactionInstruction({
    programId: pid,
    keys: [
      { pubkey: globalPda, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(L.encodeUpdateGlobalData(args)),
  });
}

// ─── Shared pre-flight ──────────────────────────────────────────────────────────

/**
 * Read the chain before building anything. Refuses on any state where the
 * instruction cannot succeed, so a failure is a sentence here rather than an Anchor
 * error code after a multisig ceremony.
 */
async function requireDeployed(connection, pid) {
  const status = await L.fetchLaunchProtocolStatus(connection, pid);
  if (status.program.kind === 'unreadable') {
    fail(`could not read the program account: ${status.program.reason}\n  Refusing to build blind — this is NOT proof the program is absent.`);
  }
  if (status.program.kind !== 'deployed') {
    fail(
      `no program is deployed at ${pid}.\n` +
        '  The id in lib.rs:101 is a PLACEHOLDER that corresponds to no key anybody holds\n' +
        '  (verified null on mainnet-beta AND devnet, 2026-08-01). Deploy under a real\n' +
        '  keypair first, then pass --program-id <deployed-id>.',
    );
  }
  return status;
}

// ─── Commands ───────────────────────────────────────────────────────────────────

async function cmdStatus(flags) {
  const pid = programId(flags);
  const connection = connect();
  const status = await L.fetchLaunchProtocolStatus(connection, pid);

  console.log('[operator] tegridy-launch status');
  console.log(`  cluster      : ${connection.rpcEndpoint.replace(/\?.*$/, '')}`);
  console.log(`  program id   : ${pid}${pid === L.TEGRIDY_LAUNCH_PROGRAM_ID ? '  (PLACEHOLDER from lib.rs:101)' : ''}`);
  console.log(`  global PDA   : ${L.deriveGlobalConfigPda(pid)}`);
  printDeployment(status.program);
  printGlobal(status.global, status.program.kind);

  console.log('\n  outstanding steps:');
  if (status.program.kind === 'unreadable') {
    // A failed read is NOT a finding about the protocol. Naming a "next step" here
    // would turn an RPC outage into "go deploy the program" — the exact collapse of
    // "could not read" into "read it, answer is no" this repo keeps shipping.
    console.log('    UNKNOWN — the program account could not be read, so no step can be named.');
    console.log('    Fix the RPC and re-run. Nothing below was determined.');
  } else if (status.program.kind !== 'deployed') {
    console.log('    1. deploy the program under a real keypair   ← NEXT');
    console.log('    2. init-global');
    console.log('    3. cp-swap admin creates the AmmConfig');
    console.log('    4. update-global --cp-swap-program … --amm-config …');
  } else if (status.global?.kind === 'not-initialized') {
    console.log('    2. init-global   ← NEXT  (AMM addresses may be left zero here)');
    console.log('    3. cp-swap admin creates the AmmConfig');
    console.log('    4. update-global --cp-swap-program … --amm-config …');
  } else if (status.global?.kind === 'initialized') {
    if (L.graduationVenue(status.global.config).kind === 'not-configured') {
      console.log('    3. cp-swap admin creates the AmmConfig (if it does not exist)');
      console.log('    4. update-global --cp-swap-program … --amm-config …   ← NEXT');
    } else {
      console.log('    none — the protocol is configured and migration is possible.');
    }
  } else {
    console.log('    (indeterminate — resolve the global read above first)');
  }
}

function cmdDerive(flags) {
  const pid = programId(flags);
  console.log('[operator] derived addresses');
  console.log(`  program id : ${pid}`);
  console.log(`  global PDA : ${L.deriveGlobalConfigPda(pid)}   seeds ["global"]`);
  console.log('\n  Pure derivation — no chain access, so this says NOTHING about what is deployed.');
}

/** Pure pre-flight of the economics, with no RPC and no key. */
function cmdCheckConfig(flags) {
  const params = {
    tradeFeeBps: requireU64Flag(flags, 'fee-bps'),
    initialVirtualSol: requireU64Flag(flags, 'virtual-sol'),
    initialVirtualToken: requireU64Flag(flags, 'virtual-token'),
    tokenTotalSupply: requireU64Flag(flags, 'supply'),
    graduationTargetLamports: requireU64Flag(flags, 'target'),
    migrationReserveLamports: requireU64Flag(flags, 'reserve'),
  };
  const report = L.checkLaunchEconomics(params);
  console.log('[operator] config pre-flight (pure — mirrors lib.rs:199-248)');
  console.log(`  max reachable real SOL : ${report.maxReachableRealSol ?? '(could not compute)'}`);
  console.log(`  lists at               : ${report.graduationPriceRatioBps ?? '(could not compute)'} bps of the final curve price`);
  console.log(`  continuity target      : ${report.continuityTarget ?? '(could not compute)'}${report.continuityTarget !== null ? ` (${sol(report.continuityTarget)})` : ''}`);
  console.log('                           ^ the target that lists at exactly the curve price');
  if (report.problems.length === 0) {
    console.log('\n  ✅ the program\'s config guards all pass. (Not a claim that the economics are wise.)');
    return report;
  }
  console.log('\n  ❌ the program would REJECT this config:');
  for (const p of report.problems) console.log(`     • ${p}`);
  return report;
}

async function cmdInitGlobal(flags) {
  const pid = new PublicKey(programId(flags));
  const connection = connect();
  const status = await requireDeployed(connection, pid.toBase58());

  if (status.global?.kind === 'initialized') {
    fail(
      'global is ALREADY initialized — it is a singleton PDA and `initialize_global` runs exactly once.\n' +
        '  Use `update-global` to change parameters (including the AMM addresses).',
    );
  }
  if (status.global?.kind !== 'not-initialized') {
    fail(`refusing to build: global is in state "${status.global?.kind}". Resolve it first.`);
  }

  // Economics pre-flight BEFORE any key is touched.
  const report = cmdCheckConfig(flags);
  if (report.problems.length > 0) fail('config rejected by the pre-flight above — nothing was built.');

  const feeRecipient = optionalPubkeyFlag(flags, 'fee-recipient');
  if (!feeRecipient) fail('missing required --fee-recipient <base58> (mainnet: the treasury Squads vault)');
  // Zero is LEGAL here and is the normal case — the AmmConfig does not exist yet.
  const ZERO = PublicKey.default.toBase58();
  const cpSwapProgram = optionalPubkeyFlag(flags, 'cp-swap-program', { rejectZero: false }) ?? ZERO;
  const ammConfig = optionalPubkeyFlag(flags, 'amm-config', { rejectZero: false }) ?? ZERO;

  const payer = await loadKeypair('OPERATOR_KEYPAIR');
  const authority = payer.publicKey;

  // `address = deployer::ID` (lib.rs:1226) — a hardcoded gate, and its value depends
  // on how the deployed binary was BUILT, which cannot be read from chain.
  console.log('\n[operator] initialize_global');
  console.log(`  authority (signer)  : ${authority.toBase58()}`);
  if (authority.toBase58() !== DEVNET_DEPLOYER_ID) {
    console.log('  ⚠️  This key is NOT the devnet deployer::ID. `initialize_global` is gated on');
    console.log(`      \`address = deployer::ID\` (lib.rs:1226). A --features devnet build expects`);
    console.log(`      ${DEVNET_DEPLOYER_ID};`);
    console.log(`      a NON-devnet build embeds ${SYSTEM_SENTINEL}`);
    console.log('      (the System Program sentinel), which NOBODY can sign for — so a mainnet');
    console.log('      binary cannot be initialized until an operator sets a real key and rebuilds.');
    console.log('      Expect NotDeployAuthority (6012) unless you know this binary matches.');
  }
  if (cpSwapProgram === ZERO || ammConfig === ZERO) {
    console.log('  note: AMM addresses left zero — this is the NORMAL path (lib.rs:184-187).');
    console.log('        Set them afterwards with `update-global`; migration is blocked until then.');
  }

  const tx = new Transaction().add(
    ixInitializeGlobal({
      pid,
      authority,
      feeRecipient: new PublicKey(feeRecipient),
      globalPda: new PublicKey(L.deriveGlobalConfigPda(pid.toBase58())),
      args: {
        tradeFeeBps: requireU64Flag(flags, 'fee-bps'),
        initialVirtualSol: requireU64Flag(flags, 'virtual-sol'),
        initialVirtualToken: requireU64Flag(flags, 'virtual-token'),
        tokenTotalSupply: requireU64Flag(flags, 'supply'),
        graduationTargetLamports: requireU64Flag(flags, 'target'),
        migrationReserveLamports: requireU64Flag(flags, 'reserve'),
        cpSwapProgram,
        ammConfig,
      },
    }),
  );
  await prepareAndSign(connection, tx, authority, flags.send ? payer : undefined);
  const sent = await maybeSend(connection, tx, flags);
  await emitTransaction(connection, tx, sent, 'initialize_global');
}

async function cmdUpdateGlobal(flags) {
  const pid = new PublicKey(programId(flags));
  const connection = connect();
  const status = await requireDeployed(connection, pid.toBase58());

  if (status.global?.kind !== 'initialized') {
    fail(
      `global is "${status.global?.kind}" — \`update_global\` requires an initialized config.\n` +
        '  Run `init-global` first.',
    );
  }
  const current = status.global.config;

  if (flags.pause && flags.unpause) fail('--pause and --unpause are mutually exclusive');
  const args = {
    tradeFeeBps: optionalU64Flag(flags, 'fee-bps'),
    graduationTargetLamports: optionalU64Flag(flags, 'target'),
    paused: flags.pause ? true : flags.unpause ? false : undefined,
    newAuthority: optionalPubkeyFlag(flags, 'new-authority'),
    newFeeRecipient: optionalPubkeyFlag(flags, 'fee-recipient'),
    migrationReserveLamports: optionalU64Flag(flags, 'reserve'),
    newCpSwapProgram: optionalPubkeyFlag(flags, 'cp-swap-program'),
    newAmmConfig: optionalPubkeyFlag(flags, 'amm-config'),
    newInitialVirtualSol: optionalU64Flag(flags, 'virtual-sol'),
  };
  if (Object.values(args).every((v) => v === undefined)) {
    fail('nothing to update — pass at least one of --fee-bps --target --reserve --virtual-sol\n  --pause/--unpause --new-authority --fee-recipient --cp-swap-program --amm-config');
  }

  // `has_one = authority` (lib.rs:1248). Check it against CHAIN state rather than
  // letting the ceremony end in Unauthorized (6008).
  const payer = await loadKeypair('OPERATOR_KEYPAIR');
  if (payer.publicKey.toBase58() !== current.authority) {
    fail(
      `the loaded key is not \`global.authority\`.\n` +
        `    loaded    : ${payer.publicKey.toBase58()}\n` +
        `    authority : ${current.authority}\n` +
        '  On mainnet the authority is the Squads multisig, so this is expected: build the\n' +
        '  instruction inside a Squads proposal rather than signing locally.',
    );
  }

  // The economics are validated TOGETHER whenever any of the three moves
  // (lib.rs:308-345), against the POST-update values — mirror that resolution here.
  if (args.graduationTargetLamports !== undefined || args.migrationReserveLamports !== undefined || args.newInitialVirtualSol !== undefined) {
    const report = L.checkLaunchEconomics({
      tradeFeeBps: args.tradeFeeBps ?? current.tradeFeeBps,
      initialVirtualSol: args.newInitialVirtualSol ?? current.initialVirtualSol,
      initialVirtualToken: current.initialVirtualToken, // not settable by update_global
      tokenTotalSupply: current.tokenTotalSupply, // not settable by update_global
      graduationTargetLamports: args.graduationTargetLamports ?? current.graduationTargetLamports,
      migrationReserveLamports: args.migrationReserveLamports ?? current.migrationReserveLamports,
    });
    console.log('[operator] post-update economics pre-flight');
    console.log(`  lists at          : ${report.graduationPriceRatioBps ?? '(could not compute)'} bps of the final curve price`);
    console.log(`  continuity target : ${report.continuityTarget ?? '(could not compute)'}`);
    if (report.problems.length > 0) {
      for (const p of report.problems) console.log(`     • ${p}`);
      fail('the program would reject this update — nothing was built.');
    }
  }

  console.log('\n[operator] update_global');
  console.log(`  authority (signer) : ${payer.publicKey.toBase58()}`);
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined) console.log(`  ${k.padEnd(18)}: ${v}`);
  }

  const tx = new Transaction().add(
    ixUpdateGlobal({
      pid,
      globalPda: new PublicKey(status.global.address),
      authority: payer.publicKey,
      args,
    }),
  );
  await prepareAndSign(connection, tx, payer.publicKey, flags.send ? payer : undefined);
  const sent = await maybeSend(connection, tx, flags);
  await emitTransaction(connection, tx, sent, 'update_global');
}

function printHelp() {
  console.log(`
tegridy-launch operator harness — protocol-level instructions for OUR OWN curve.

⚠️  THE PROGRAM IS NOT DEPLOYED ANYWHERE. The id in lib.rs:101 is a placeholder that
    returns null on mainnet-beta AND devnet (verified 2026-08-01). Every write command
    reads the chain first and refuses to build against an address with no program.

ENV
  SOLANA_RPC_URL     required by every command that touches the chain
  OPERATOR_KEYPAIR   path to a Solana CLI JSON array, or a base58 secret in a file
                     (write commands only; never passed on the command line)

COMMANDS
  status             read-only: what is deployed, what global says, what step is next
  derive             print the global PDA for a program id (pure, no RPC)
  check-config       pure economics pre-flight; no RPC, no key
  init-global        build initialize_global   (runs exactly once — global is a singleton)
  update-global      build update_global       (the ONLY way to set the AMM addresses)
  help

GLOBAL FLAGS
  --program-id <id>  override the placeholder program id (use this after a real deploy)
  --send             broadcast instead of printing. OPT-IN. Only completes when the
                     local key is a sufficient signer set — on mainnet the authority
                     is a Squads multisig, so the authority pre-check fails closed.

CONFIG FLAGS (init-global / check-config; all values are RAW integers, not decimals)
  --fee-bps <n>          trade fee, <= 1000 (MAX_FEE_BPS)
  --virtual-sol <lamports>
  --virtual-token <base units>
  --supply <base units>
  --target <lamports>    graduation target — EXCLUDES the migration reserve
  --reserve <lamports>   migration reserve, >= 42156720 (MIN_MIGRATION_RESERVE_LAMPORTS)
  --fee-recipient <base58>
  --cp-swap-program <base58>   optional at init — zero is the NORMAL case
  --amm-config <base58>        optional at init — zero is the NORMAL case

UPDATE FLAGS (update-global; pass only what changes)
  --fee-bps --target --reserve --virtual-sol
  --pause | --unpause          pause blocks BUYS and migration; SELLS STAY OPEN
  --new-authority <base58>     --fee-recipient <base58>
  --cp-swap-program <base58>   --amm-config <base58>

ORDERING — the opposite of the obvious guess
  1. deploy under a real keypair
  2. init-global                       AMM addresses MAY be zero; no AmmConfig needed yet
  3. cp-swap admin creates the AmmConfig
  4. update-global --cp-swap-program … --amm-config …
  5. migration possible

  \`initialize_global\` does NOT require an AmmConfig (lib.rs:184-187, 259-263), and
  \`update_global\` CAN set both AMM addresses (lib.rs:360-367). lib.rs:347-355 records
  what happened when it could not: migration was left permanently disabled.

EXAMPLES
  SOLANA_RPC_URL=… node scripts/tegridy-launch-operator.mjs status
  node scripts/tegridy-launch-operator.mjs check-config --fee-bps 100 \\
    --virtual-sol 30000000000 --virtual-token 1073000000000000 \\
    --supply 1000000000000000 --target 11685689681 --reserve 42156720
`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] ?? 'help';
  switch (cmd) {
    case 'status':
      return cmdStatus(flags);
    case 'derive':
      return cmdDerive(flags);
    case 'check-config':
      return void cmdCheckConfig(flags);
    case 'init-global':
      return cmdInitGlobal(flags);
    case 'update-global':
      return cmdUpdateGlobal(flags);
    case 'help':
    case '--help':
    case '-h':
      return printHelp();
    default:
      console.error(`[operator] unknown command "${cmd}"`);
      printHelp();
      process.exitCode = 1;
      return;
  }
}

main().catch((e) => {
  // An OperatorError is an EXPECTED refusal (a guard fired) — print the sentence, not
  // a stack. Anything else is a genuine fault and the stack is the diagnostic.
  console.error(e instanceof OperatorError ? `\n[operator] ERROR: ${e.message}\n` : `\n[operator] ${e?.stack ?? e?.message ?? e}\n`);
  process.exitCode = 1;
});
