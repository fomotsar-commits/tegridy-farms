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
 * ─── THE PROGRAM IS LIVE ───────────────────────────────────────────────────────
 * DEPLOYED TO MAINNET 2026-08-08 at `CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED`
 * (slot 438,055,726) and `initialize_global` has already run. `PROGRAM_ID` in
 * `curve/program.ts` is that address and is what every command here defaults to.
 *
 * This header used to say the opposite, and said it for four days after the deploy.
 * It is left visible rather than quietly deleted because a stale "not deployed"
 * banner is not a harmless comment: it tells an operator that a refusal they are
 * looking at is expected, so they stop reading. What is still true is the MECHANISM —
 * every write command READS THE CHAIN FIRST and refuses to build against an address
 * that holds no program. That check is what makes this file's claims self-correcting;
 * the prose is not. Trust `status`, not this paragraph.
 *
 * Still outstanding, and the reason the graduation commands below exist: cp-swap's
 * AmmConfig does not exist, so `migrate_to_amm` fails AmmNotConfigured (6015).
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
 *   1. deploy the program under a REAL keypair (not the placeholder id)   ✅ 2026-08-08
 *   2. `init-global`      — AMM addresses may be zero; the AmmConfig need not exist  ✅
 *   3. `create-amm-config`  — cp-swap admin creates the AmmConfig         ← OUTSTANDING
 *   4. `update-global --cp-swap-program … --amm-config …`   ← the ONLY way to set them
 *   5. migration is possible; until step 4 `migrate_to_amm` fails AmmNotConfigured (6015)
 *
 * `set-curve-segments` is orthogonal to all of that: it publishes the Meteora-shaped
 * curve so `create_launch --mode 1` has a shape to snapshot. Launches in the default
 * ConstantProduct mode do not need it.
 *
 * `status` prints exactly which of these steps is outstanding.
 *
 * ─── WHERE THE LOGIC LIVES ─────────────────────────────────────────────────────
 * `src/lib/launcher/solana/curve/` and nowhere else. This harness once imported a
 * `tegridyLaunch.ts` that carried its OWN transcription of curve.rs, its own account
 * decoder and its own Borsh encoders — a fourth copy of the same money math, next to
 * the page's, the chart's and the client's. It is deleted; every symbol below comes
 * from the one differentially-proven core.
 *
 * This file keeps only what a CLI is for: flags, chain pre-flight, refusals and
 * output. It builds no arithmetic of its own.
 *
 * ─── WHY A CUSTOM LOADER ───────────────────────────────────────────────────────
 * The core is written for the Vite bundler; the inline loader below strips
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
 *     --fee-bps 100 --creator-fee-share-bps 4800 \
 *     --virtual-sol 30000000000 --virtual-token 1073000000000000 \
 *     --supply 1000000000000000 --target 11685689681 --reserve 42156720 \
 *     --fee-recipient <base58>
 *
 * Commands: status | derive | check-config | init-global | update-global |
 *           create-amm-config | set-curve-segments | help
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
const CURVE = path.join(HERE, '..', 'src', 'lib', 'launcher', 'solana', 'curve');
const mod = (name) => import(pathToFileURL(path.join(CURVE, `${name}.ts`)).href);

const { Connection, Keypair, PublicKey, Transaction } = await import('@solana/web3.js');

// The specific modules, not `index.ts`: the barrel also re-exports `rpc.ts`, which
// pulls the browser transport (and `frontend/src/lib/solana.ts` behind it) into a
// process that has a real `Connection` and no business with `/api/solrpc`.
const L = {
  ...(await mod('program')),
  ...(await mod('ix')),
  ...(await mod('read')),
  ...(await mod('config')),
  ...(await mod('math')),
};

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

// The id used when `--program-id` is not given. This is `PROGRAM_ID` — the address we
// actually deployed to — NOT the placeholder. It was previously named
// PLACEHOLDER_PROGRAM_ID and set to `L.PROGRAM_ID`, which made the two synonymous;
// once PROGRAM_ID was pointed at the live deploy, `status` began labelling the REAL
// mainnet program "(PLACEHOLDER from lib.rs:101)". Same self-referential shape as the
// `isPlaceholderProgramId` bug in curve/program.ts, and it reads as reassuring in
// exactly the case where it is wrong.
const DEFAULT_PROGRAM_ID = L.PROGRAM_ID.toBase58();
const PLACEHOLDER_PROGRAM_ID = L.PLACEHOLDER_PROGRAM_ID.toBase58();

function programId(flags) {
  return flags['program-id'] ? String(flags['program-id']).trim() : DEFAULT_PROGRAM_ID;
}

/**
 * Is `key` present in the deployed program's bytecode?
 *
 * `deployer::ID` is a `pubkey!` constant baked in at build time, so no account holds
 * it and no RPC exposes it. But a 32-byte pubkey constant is stored literally in the
 * program's read-only data, so fetching the executable and searching for those bytes
 * answers the question the operator actually has: "will this key pass the gate?"
 *
 * Returns `null` when the bytecode could not be fetched — an inconclusive check must
 * not read as a pass. A `true` is strong evidence but not proof: it says the bytes
 * appear somewhere, not that they appear at `deployer::ID`. A `false` IS conclusive —
 * a constant that is not in the binary cannot be the one the gate compares against.
 */
async function deployerIsBakedIntoProgram(connection, programPubkey, key) {
  try {
    const info = await connection.getAccountInfo(programPubkey);
    if (!info) return null;
    // A BPFLoaderUpgradeable program account is a 36-byte pointer to a separate
    // ProgramData account; the bytecode lives there, 45 bytes in. Anything else is a
    // v2 program whose account holds the ELF directly.
    let elf = info.data;
    if (info.data.length === 36) {
      const dataAddr = new PublicKey(info.data.subarray(4, 36));
      const pd = await connection.getAccountInfo(dataAddr);
      if (!pd) return null;
      elf = pd.data.subarray(45);
    }
    return Buffer.from(elf).includes(Buffer.from(key.toBytes()));
  } catch {
    return null;
  }
}

/** `globalPda` takes a `PublicKey`; every call site here has a base58 string. */
function globalPdaOf(pid) {
  return L.globalPda(new PublicKey(pid)).toBase58();
}

function connect() {
  return new Connection(requireEnv('SOLANA_RPC_URL'), 'confirmed');
}

/**
 * Read deployment + global in the honest order, using the core's readers.
 *
 * `global` stays `null` when we DELIBERATELY DID NOT LOOK — because the program is
 * not deployed, or could not be read — which is different from `absent`, a real read
 * of a missing account. Never collapse them: one is a fact about the protocol, the
 * other is a fact about our connection.
 */
async function readProtocol(connection, pid) {
  const programKey = new PublicKey(pid);
  const program = await L.readDeployment(connection, programKey);
  if (program.kind !== 'deployed') return { program, global: null };
  return { program, global: await L.readGlobal(connection, programKey) };
}

/** Render a `Deployment` honestly — an unreadable RPC is never "not deployed". */
function printDeployment(d) {
  switch (d.kind) {
    case 'deployed':
      console.log('  program      : DEPLOYED (an executable account is at this address)');
      return;
    case 'not-deployed':
      console.log('  program      : NOT DEPLOYED — no account at this address');
      return;
    case 'not-a-program':
      console.log(`  program      : ACCOUNT EXISTS BUT IS NOT EXECUTABLE (owner ${d.owner})`);
      console.log('                 someone funded the address; the program is still not deployed');
      return;
    default:
      console.log(`  program      : COULD NOT READ — ${d.detail}`);
      console.log('                 this is NOT a statement that the program is absent');
  }
}

function printGlobal(g, address, programKind) {
  if (!g) {
    console.log(
      programKind === 'unreadable'
        ? '  global       : not read — the program account could not be read, so nothing is known'
        : '  global       : not read — there is no program at this address to be configured',
    );
    return;
  }
  switch (g.kind) {
    case 'absent':
      console.log(`  global       : NOT INITIALIZED (${address}) — run \`init-global\``);
      return;
    case 'undecodable':
      // An account EXISTS at the PDA and is not a GlobalConfig. Reporting that as
      // "not initialized" would send an operator chasing the wrong thing.
      console.log(`  global       : MALFORMED at ${address} — ${g.reason}`);
      return;
    case 'unreadable':
      console.log(`  global       : COULD NOT READ — ${g.detail}`);
      return;
    default:
      break;
  }
  const c = g.value;
  const ammConfigured = L.isAmmConfigured(c);
  console.log(`  global       : INITIALIZED (${address})`);
  console.log(`    authority             : ${c.authority.toBase58()}`);
  console.log(`    fee_recipient         : ${c.feeRecipient.toBase58()}`);
  console.log(`    trade_fee_bps         : ${c.tradeFeeBps}`);
  console.log(
    `    creator_fee_share_bps : ${c.creatorFeeShareBps}` +
      ` (creator ${Number(c.creatorFeeShareBps) / 100}% / protocol ${(10_000 - Number(c.creatorFeeShareBps)) / 100}% of the fee)`,
  );
  console.log(`    initial_virtual_sol   : ${c.initialVirtualSol} (${sol(c.initialVirtualSol)})`);
  console.log(`    initial_virtual_token : ${c.initialVirtualToken}`);
  console.log(`    token_total_supply    : ${c.tokenTotalSupply}`);
  console.log(`    graduation_target     : ${c.graduationTargetLamports} (${sol(c.graduationTargetLamports)})`);
  console.log(`    migration_reserve     : ${c.migrationReserveLamports} (${sol(c.migrationReserveLamports)})`);
  console.log(`    paused                : ${c.paused}${c.paused ? '  (buys blocked; SELLS STAY OPEN)' : ''}`);
  if (ammConfigured) {
    console.log(`    cp_swap_program       : ${c.cpSwapProgram.toBase58()}`);
    console.log(`    amm_config            : ${c.ammConfig.toBase58()}`);
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
// Both instructions — account lists AND the hand-rolled Borsh data — come from
// `curve/ix.ts`, where they are unit-tested byte by byte. Borsh with no IDL is
// exactly the surface that fails silently, and the failure is not an error: it is
// the program applying a value to a DIFFERENT field than the operator intended. It
// must not sit in an untested script, and there must not be two copies of it.

// ─── Shared pre-flight ──────────────────────────────────────────────────────────

/**
 * Read the chain before building anything. Refuses on any state where the
 * instruction cannot succeed, so a failure is a sentence here rather than an Anchor
 * error code after a multisig ceremony.
 */
async function requireDeployed(connection, pid) {
  const status = await readProtocol(connection, pid);
  if (status.program.kind === 'unreadable') {
    fail(`could not read the program account: ${status.program.detail}\n  Refusing to build blind — this is NOT proof the program is absent.`);
  }
  if (status.program.kind === 'not-a-program') {
    fail(
      `an account exists at ${pid} but it is NOT executable (owner ${status.program.owner}).\n` +
        '  Someone funded the address; the program is still not deployed. Refusing to build.',
    );
  }
  if (status.program.kind !== 'deployed') {
    fail(
      `no program is deployed at ${pid}.\n` +
        `  The live mainnet id is ${DEFAULT_PROGRAM_ID} (deployed 2026-08-08).\n` +
        `  ${PLACEHOLDER_PROGRAM_ID} is the throwaway from lib.rs:114 and corresponds to no key\n` +
        '  anybody holds. If you passed --program-id, check it; otherwise check the RPC cluster.',
    );
  }
  return status;
}

// ─── cp-swap pre-flight ─────────────────────────────────────────────────────────

/** `FEE_RATE_DENOMINATOR_VALUE` — cp-swap curve/fees.rs:3. Rates are per MILLION, not bps. */
const FEE_RATE_DENOMINATOR = 1_000_000n;

/** `AmmConfig::LEN` — states/config.rs:34, `8+1+1+2+4*8+32*2+8+8*15`. Used for the rent quote. */
const AMM_CONFIG_LEN = 236;

function cpSwapProgramId(flags) {
  return flags['cp-swap-program'] ? String(flags['cp-swap-program']).trim() : L.CP_SWAP_PROGRAM_ID.toBase58();
}

/**
 * Is `owner` an account the System Program can debit?
 *
 * `CreateAmmConfig` has `payer = owner` (create_config.rs:23), so the owner is not just
 * a signer — the System Program must be able to move lamports out of it to fund the
 * AmmConfig. It can only do that for an account it OWNS, with no data.
 *
 * This is the check whose absence cost a program upgrade. The Squads MULTISIG account
 * fails it twice over: it is owned by the Squads program and carries 495 bytes. Squads
 * v4 also signs CPIs as the VAULT, so nothing can ever produce a signature for the
 * multisig account in the first place. Both facts were available on 2026-08-08 and
 * neither was checked.
 */
async function classifyPayer(connection, pubkey) {
  const info = await connection.getAccountInfo(pubkey);
  if (!info) return { ok: false, reason: 'the account does not exist on this cluster (0 lamports, never funded)' };
  if (info.executable) return { ok: false, reason: 'the account is EXECUTABLE — a program cannot sign or be debited' };
  if (!info.owner.equals(new PublicKey(SYSTEM_SENTINEL))) {
    return {
      ok: false,
      reason:
        `the account is owned by ${info.owner.toBase58()}, not the System Program, and carries ` +
        `${info.data.length} bytes of data.\n` +
        '    The System Program can only debit an account it owns with no data, and `CreateAmmConfig`\n' +
        '    has `payer = owner`. A Squads MULTISIG account looks exactly like this — that is the\n' +
        '    2026-08-08 mistake. Use the Squads VAULT PDA (system-owned, 0 bytes) or a plain wallet.',
    };
  }
  if (info.data.length !== 0) {
    return { ok: false, reason: `the account is System-owned but carries ${info.data.length} bytes of data — the System Program cannot debit it` };
  }
  return { ok: true, lamports: BigInt(info.lamports) };
}

// ─── Commands ───────────────────────────────────────────────────────────────────

async function cmdStatus(flags) {
  const pid = programId(flags);
  const connection = connect();
  const status = await readProtocol(connection, pid);
  const globalAddress = globalPdaOf(pid);

  console.log('[operator] tegridy-launch status');
  console.log(`  cluster      : ${connection.rpcEndpoint.replace(/\?.*$/, '')}`);
  console.log(`  program id   : ${pid}${pid === PLACEHOLDER_PROGRAM_ID ? '  (PLACEHOLDER from lib.rs:101)' : ''}`);
  console.log(`  global PDA   : ${globalAddress}`);
  printDeployment(status.program);
  printGlobal(status.global, globalAddress, status.program.kind);

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
  } else if (status.global?.kind === 'absent') {
    console.log('    2. init-global   ← NEXT  (AMM addresses may be left zero here)');
    console.log('    3. cp-swap admin creates the AmmConfig');
    console.log('    4. update-global --cp-swap-program … --amm-config …');
  } else if (status.global?.kind === 'ok') {
    if (!L.isAmmConfigured(status.global.value)) {
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
  console.log(`  global PDA : ${globalPdaOf(pid)}   seeds ["global"]`);
  console.log('\n  Pure derivation — no chain access, so this says NOTHING about what is deployed.');
}

/**
 * `creator_fee_share_bps` — the SECOND argument to `initialize_global`, and the one
 * this harness silently omitted until 2026-08-08. Borsh is positional with no field
 * names on the wire, so leaving it out did not fail: every later argument shifted one
 * slot earlier and `initial_virtual_sol` (30 SOL) would have been read as the creator
 * share. That is a total misconfiguration of the curve that REVERTS NOTHING and reads
 * back as a successfully initialized singleton.
 *
 * There is deliberately NO default. The split of trading revenue between the protocol
 * and the token's creator is an economic decision, `global` is a singleton that
 * `initialize_global` runs against exactly once, and a default here would let the
 * most consequential number in the config be chosen by omission.
 */
function requireCreatorFeeShareBps(flags) {
  const v = requireU64Flag(flags, 'creator-fee-share-bps');
  // Mirrors lib.rs:383-386. It is a share OF THE FEE, so 100% is the natural bound:
  // above it the creator is paid more than the trade actually charged.
  if (v > 10_000n) {
    fail(`--creator-fee-share-bps is ${v}, above the 10000 (=100%) ceiling the program enforces.`);
  }
  return v;
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

  if (status.global?.kind === 'ok') {
    fail(
      'global is ALREADY initialized — it is a singleton PDA and `initialize_global` runs exactly once.\n' +
        '  Use `update-global` to change parameters (including the AMM addresses).',
    );
  }
  if (status.global?.kind !== 'absent') {
    fail(`refusing to build: global is in state "${status.global?.kind}". Resolve it first.`);
  }

  // Economics pre-flight BEFORE any key is touched.
  const report = cmdCheckConfig(flags);
  if (report.problems.length > 0) fail('config rejected by the pre-flight above — nothing was built.');
  // Validated HERE, before the key is loaded, so a bad value costs nothing. Echoed
  // because it is the one number an operator cannot read back off the help text.
  const creatorFeeShareBps = requireCreatorFeeShareBps(flags);
  console.log(
    `  creator fee share      : ${creatorFeeShareBps} bps ` +
      `(creator ${Number(creatorFeeShareBps) / 100}% / protocol ${(10_000 - Number(creatorFeeShareBps)) / 100}% of each trade fee)`,
  );

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
  // `deployer::ID` is a compile-time constant, so it cannot be read from an account.
  // It CAN be read out of the bytecode, though — it is 32 raw bytes sitting in the
  // program's rodata — and `solana program dump` gives us exactly that. This checks
  // the key against the binary that is actually deployed rather than against a
  // hardcoded guess, which is the only version of this check that survives a rebuild.
  const bakedIn = await deployerIsBakedIntoProgram(connection, pid, authority);
  if (bakedIn === false) {
    console.log('  ⚠️  This key does NOT appear in the deployed bytecode, so it is almost');
    console.log('      certainly not `deployer::ID`. `initialize_global` is gated on');
    console.log('      `address = deployer::ID` (lib.rs:1226); expect NotDeployAuthority (6012).');
    console.log(`      A --features devnet build expects ${DEVNET_DEPLOYER_ID}; an unpatched`);
    console.log(`      mainnet build embeds ${SYSTEM_SENTINEL} (the System Program`);
    console.log('      sentinel), which NOBODY can sign for.');
  } else if (bakedIn === true) {
    console.log('  deployer::ID        : ✅ this key is present in the deployed bytecode');
  } else {
    console.log('  deployer::ID        : (could not fetch bytecode to check — proceeding)');
  }
  if (cpSwapProgram === ZERO || ammConfig === ZERO) {
    console.log('  note: AMM addresses left zero — this is the NORMAL path (lib.rs:184-187).');
    console.log('        Set them afterwards with `update-global`; migration is blocked until then.');
  }

  const tx = new Transaction().add(
    // Accounts AND data from `curve/ix.ts`; the `global` PDA is derived inside it
    // from the same `programId`, so the address here cannot drift from the one the
    // encoder targets.
    L.initializeGlobalIx(
      { authority, feeRecipient: new PublicKey(feeRecipient) },
      {
        tradeFeeBps: requireU64Flag(flags, 'fee-bps'),
        creatorFeeShareBps: requireCreatorFeeShareBps(flags),
        initialVirtualSol: requireU64Flag(flags, 'virtual-sol'),
        initialVirtualToken: requireU64Flag(flags, 'virtual-token'),
        tokenTotalSupply: requireU64Flag(flags, 'supply'),
        graduationTargetLamports: requireU64Flag(flags, 'target'),
        migrationReserveLamports: requireU64Flag(flags, 'reserve'),
        cpSwapProgram: new PublicKey(cpSwapProgram),
        ammConfig: new PublicKey(ammConfig),
      },
      { programId: pid },
    ),
  );
  await prepareAndSign(connection, tx, authority, flags.send ? payer : undefined);
  const sent = await maybeSend(connection, tx, flags);
  await emitTransaction(connection, tx, sent, 'initialize_global');
}

async function cmdUpdateGlobal(flags) {
  const pid = new PublicKey(programId(flags));
  const connection = connect();
  const status = await requireDeployed(connection, pid.toBase58());

  if (status.global?.kind !== 'ok') {
    fail(
      `global is "${status.global?.kind}" — \`update_global\` requires an initialized config.\n` +
        '  Run `init-global` first.',
    );
  }
  const current = status.global.value;

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
    // The tenth Option. Unlike `init-global` this one has no bound check of its own
    // because the program enforces `<= 10000` on the update path too — but a value
    // over it fails the whole ceremony, so reject it here rather than after signing.
    newCreatorFeeShareBps: (() => {
      const v = optionalU64Flag(flags, 'creator-fee-share-bps');
      if (v !== undefined && v > 10_000n) {
        fail(`--creator-fee-share-bps is ${v}, above the 10000 (=100%) ceiling the program enforces.`);
      }
      return v;
    })(),
  };
  if (Object.values(args).every((v) => v === undefined)) {
    fail('nothing to update — pass at least one of --fee-bps --creator-fee-share-bps --target --reserve --virtual-sol\n  --pause/--unpause --new-authority --fee-recipient --cp-swap-program --amm-config');
  }

  // `has_one = authority` (lib.rs:1248). Check it against CHAIN state rather than
  // letting the ceremony end in Unauthorized (6008).
  const payer = await loadKeypair('OPERATOR_KEYPAIR');
  if (payer.publicKey.toBase58() !== current.authority.toBase58()) {
    fail(
      `the loaded key is not \`global.authority\`.\n` +
        `    loaded    : ${payer.publicKey.toBase58()}\n` +
        `    authority : ${current.authority.toBase58()}\n` +
        '  On mainnet the authority is the Squads multisig, so this is expected: build the\n' +
        '  instruction inside a Squads proposal rather than signing locally.',
    );
  }

  // EVERY guard `update_global` applies, in the shape the program applies them —
  // including the MAX_FEE_BPS ceiling, which is unconditional on `--fee-bps` being
  // supplied and used to be reachable only when an unrelated flag was also present.
  // The resolution lives in `curve/config.ts` so it is unit-tested rather than
  // asserted by this script's shape (config.test.ts).
  const check = L.checkUpdateGlobal(args, current);
  if (check.economics) {
    console.log('[operator] post-update economics pre-flight');
    console.log(`  lists at          : ${check.economics.graduationPriceRatioBps ?? '(could not compute)'} bps of the final curve price`);
    console.log(`  continuity target : ${check.economics.continuityTarget ?? '(could not compute)'}`);
  }
  if (check.problems.length > 0) {
    console.log('[operator] the program would REJECT this update:');
    for (const p of check.problems) console.log(`     • ${p}`);
    fail('the program would reject this update — nothing was built.');
  }

  console.log('\n[operator] update_global');
  console.log(`  authority (signer) : ${payer.publicKey.toBase58()}`);
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined) console.log(`  ${k.padEnd(18)}: ${v}`);
  }

  const tx = new Transaction().add(
    L.updateGlobalIx(
      { authority: payer.publicKey },
      {
        ...args,
        // `ix.ts` types the address options as `PublicKey`; the flags parse to
        // base58. `undefined` stays `undefined` — that is `None`, "leave unchanged".
        newAuthority: args.newAuthority ? new PublicKey(args.newAuthority) : undefined,
        newFeeRecipient: args.newFeeRecipient ? new PublicKey(args.newFeeRecipient) : undefined,
        newCpSwapProgram: args.newCpSwapProgram ? new PublicKey(args.newCpSwapProgram) : undefined,
        newAmmConfig: args.newAmmConfig ? new PublicKey(args.newAmmConfig) : undefined,
      },
      { programId: pid },
    ),
  );
  await prepareAndSign(connection, tx, payer.publicKey, flags.send ? payer : undefined);
  const sent = await maybeSend(connection, tx, flags);
  await emitTransaction(connection, tx, sent, 'update_global');
}

// ─── create-amm-config (cp-swap) ────────────────────────────────────────────────

/**
 * cp-swap `create_amm_config` — the graduated pool's fee schedule.
 *
 * This is step 3 of the ordering above and the ONE outstanding blocker on graduation.
 * MAINNET_RUNBOOK §5 said "tooling that does not exist yet"; this is that tooling.
 *
 * ⚠️ THE PROGRAM VALIDATES NOTHING HERE. `create_amm_config` (create_config.rs:32-53)
 * assigns all six numbers straight onto the account with no `require!` of any kind.
 * `update_config` DOES assert (update_config.rs:42-59), and it asserts each new value
 * against the STORED counterpart — so a config created outside those bounds cannot
 * necessarily be brought back inside them afterwards, and `assert!` panics rather than
 * returning an error, aborting the whole transaction. The AmmConfig is a PDA seeded by
 * index, so a botched index is BURNED: you cannot re-create it, only pick a new index.
 * Every bound below is therefore checked HERE, before anything is signed.
 */
async function cmdCreateAmmConfig(flags) {
  const connection = connect();
  const cpSwapId = new PublicKey(cpSwapProgramId(flags));

  // 1. Is cp-swap actually there? Same honesty rules as the tegridy-launch check:
  //    an unreadable RPC is never "not deployed".
  const cpDeployment = await L.readDeployment(connection, cpSwapId);
  if (cpDeployment.kind === 'unreadable') {
    fail(`could not read the cp-swap program account: ${cpDeployment.detail}\n  Refusing to build blind.`);
  }
  if (cpDeployment.kind !== 'deployed') {
    fail(`no cp-swap program is deployed at ${cpSwapId.toBase58()} (${cpDeployment.kind}). Nothing to configure.`);
  }

  const index = Number(requireFlag(flags, 'index'));
  if (!Number.isInteger(index) || index < 0 || index > 0xff_ff) {
    fail(`--index must be a u16 (0..65535), got "${flags.index}". It is a PDA seed and therefore permanent.`);
  }
  const params = {
    index,
    tradeFeeRate: requireU64Flag(flags, 'trade-fee-rate'),
    protocolFeeRate: requireU64Flag(flags, 'protocol-fee-rate'),
    fundFeeRate: requireU64Flag(flags, 'fund-fee-rate'),
    createPoolFee: requireU64Flag(flags, 'create-pool-fee'),
    creatorFeeRate: requireU64Flag(flags, 'creator-fee-rate'),
  };

  // 2. The bounds update_config will hold you to for the rest of the config's life.
  const problems = [];
  if (params.protocolFeeRate > FEE_RATE_DENOMINATOR) problems.push(`protocol_fee_rate ${params.protocolFeeRate} > ${FEE_RATE_DENOMINATOR}`);
  if (params.fundFeeRate > FEE_RATE_DENOMINATOR) problems.push(`fund_fee_rate ${params.fundFeeRate} > ${FEE_RATE_DENOMINATOR}`);
  if (params.protocolFeeRate + params.fundFeeRate > FEE_RATE_DENOMINATOR) {
    problems.push(`protocol_fee_rate + fund_fee_rate = ${params.protocolFeeRate + params.fundFeeRate} > ${FEE_RATE_DENOMINATOR}`);
  }
  // STRICTLY less than — update_config.rs:48 and :59 use `<`, not `<=`.
  if (params.tradeFeeRate + params.creatorFeeRate >= FEE_RATE_DENOMINATOR) {
    problems.push(`trade_fee_rate + creator_fee_rate = ${params.tradeFeeRate + params.creatorFeeRate} must be STRICTLY < ${FEE_RATE_DENOMINATOR}`);
  }

  // 3. The create_pool_fee ceiling. This one is not cp-swap's rule at all — it is
  //    tegridy-launch's, and it is the expensive one. Migration pays this flat fee out
  //    of `global.migration_reserve_lamports`, and the reserve is SNAPSHOTTED onto every
  //    curve at creation. Set the fee above what the reserve can cover and every launch
  //    that already exists becomes permanently unmigratable — discovered at the finish
  //    line, with the pool half-built.
  const launchPid = programId(flags);
  const launch = await readProtocol(connection, launchPid);
  if (params.createPoolFee > 0n) {
    if (launch.global?.kind !== 'ok') {
      fail(
        `--create-pool-fee is ${params.createPoolFee}, but tegridy-launch's \`global\` is "${launch.global?.kind ?? 'not read'}",\n` +
          '  so the ceiling (migration_reserve - MIN_MIGRATION_RESERVE_LAMPORTS) cannot be established.\n' +
          '  Refusing to guess: too high and EVERY existing launch becomes permanently unmigratable.\n' +
          '  Fix the RPC / program id and re-run, or pass --create-pool-fee 0.',
      );
    }
    const reserve = launch.global.value.migrationReserveLamports;
    const ceiling = reserve - L.MIN_MIGRATION_RESERVE_LAMPORTS;
    console.log('[operator] create_pool_fee ceiling, from the LIVE global');
    console.log(`  migration_reserve            : ${reserve} (${sol(reserve)})`);
    console.log(`  - MIN_MIGRATION_RESERVE      : ${L.MIN_MIGRATION_RESERVE_LAMPORTS} (account rent migration must still pay)`);
    console.log(`  = ceiling                    : ${ceiling} (${sol(ceiling)})`);
    console.log(`  requested create_pool_fee    : ${params.createPoolFee} (${sol(params.createPoolFee)})`);
    if (params.createPoolFee > ceiling) {
      problems.push(
        `create_pool_fee ${params.createPoolFee} exceeds the ceiling ${ceiling}. Migration could not pay it, and because ` +
          'the reserve is snapshotted at creation, every launch made before this change would become permanently unmigratable.',
      );
    }
  }

  if (problems.length > 0) {
    console.log('\n[operator] REFUSING to build — these would be baked into a PDA that cannot be re-created:');
    for (const p of problems) console.log(`     • ${p}`);
    fail('parameters rejected by the pre-flight above — nothing was built.');
  }

  // 4. One-shot: the AmmConfig is `init`, so a second create at the same index reverts.
  const ammConfig = L.cpAmmConfigPda(index, cpSwapId);
  const existing = await connection.getAccountInfo(ammConfig);
  if (existing) {
    fail(
      `AmmConfig index ${index} ALREADY EXISTS at ${ammConfig.toBase58()} (${existing.data.length} bytes).\n` +
        '  `create_amm_config` is `init`; it can only run once per index. Use cp-swap `update_config`\n' +
        '  to change rates, or pick a different --index (the index is a PDA seed, so a new index is a\n' +
        '  genuinely different config and `global.amm_config` would have to be repointed at it).',
    );
  }

  // 5. The signer. Everything above is free; this is where a key is touched.
  const payer = await loadKeypair('OPERATOR_KEYPAIR');
  const owner = payer.publicKey;

  console.log('\n[operator] create_amm_config');
  console.log(`  cp-swap program     : ${cpSwapId.toBase58()}`);
  console.log(`  amm_config PDA      : ${ammConfig.toBase58()}   seeds ["amm_config", be_u16(${index})]`);
  console.log(`  owner (signer+payer): ${owner.toBase58()}`);

  // 6. `address = crate::admin::ID` (create_config.rs:12). A compile-time constant: no
  //    account holds it and no RPC exposes it, so the ONLY way to check it is to search
  //    the deployed bytecode for the raw 32 bytes. `scripts/verify-program-constants.mjs`
  //    does the full roster; this is the single-key version of the same check.
  //
  //    A FALSE here is conclusive and fatal — a key that is not in the binary cannot be
  //    what the gate compares against — so this refuses rather than warns. The
  //    2026-08-08 attempt failed at exactly this gate after a Squads ceremony.
  const bakedIn = await deployerIsBakedIntoProgram(connection, cpSwapId, owner);
  if (bakedIn === false) {
    fail(
      `this key does NOT appear anywhere in the deployed cp-swap bytecode, so it cannot be \`admin::ID\`.\n` +
        `    loaded : ${owner.toBase58()}\n` +
        '  `create_amm_config` is gated on `address = crate::admin::ID` (create_config.rs:12) and would\n' +
        '  fail with InvalidOwner. admin::ID is a compile-time constant — it CANNOT be changed by any\n' +
        '  transaction, only by a program upgrade.\n' +
        '  Run `node ../scripts/verify-program-constants.mjs --deployed ' + cpSwapId.toBase58() + '`\n' +
        '  to see which keys the live binary actually carries.',
    );
  }
  console.log(bakedIn === true
    ? '  admin::ID           : ✅ this key is present in the deployed cp-swap bytecode'
    : '  admin::ID           : (could not fetch bytecode to check — proceeding, UNVERIFIED)');

  // 7. Can the System Program actually debit it? Signing is necessary, not sufficient.
  const payerCheck = await classifyPayer(connection, owner);
  if (!payerCheck.ok) fail(`the owner cannot pay for the AmmConfig: ${payerCheck.reason}`);
  let rent = 0n;
  try {
    rent = BigInt(await connection.getMinimumBalanceForRentExemption(AMM_CONFIG_LEN));
    console.log(`  rent for ${AMM_CONFIG_LEN} bytes  : ${rent} (${sol(rent)})`);
    if (payerCheck.lamports < rent) {
      fail(`the owner holds ${payerCheck.lamports} lamports (${sol(payerCheck.lamports)}), below the ${rent} needed for rent plus fees.`);
    }
  } catch (e) {
    console.log(`  rent                : (lookup failed: ${e?.message ?? e}) — balance NOT checked`);
  }

  console.log(`  trade_fee_rate      : ${params.tradeFeeRate} (${Number(params.tradeFeeRate) / 10_000}% of volume)`);
  console.log(`  protocol_fee_rate   : ${params.protocolFeeRate} (${Number(params.protocolFeeRate) / 10_000}% OF THE TRADE FEE)`);
  console.log(`  fund_fee_rate       : ${params.fundFeeRate}`);
  console.log(`  create_pool_fee     : ${params.createPoolFee} (${sol(params.createPoolFee)}, flat, per pool)`);
  console.log(`  creator_fee_rate    : ${params.creatorFeeRate}`);
  console.log('');
  console.log('  NOTE: this sets protocol_owner = fund_owner = the signer above. Moving fee collection');
  console.log('        to a distinct treasury afterwards is cp-swap `update_config` params 3 and 4.');

  const tx = new Transaction().add(L.createAmmConfigIx({ owner }, params, { cpSwapProgram: cpSwapId }));
  await prepareAndSign(connection, tx, owner, flags.send ? payer : undefined);
  const sent = await maybeSend(connection, tx, flags);
  await emitTransaction(connection, tx, sent, 'create_amm_config');

  console.log('\n  NEXT: this config is inert until tegridy-launch knows about it. Run');
  console.log(`    update-global --cp-swap-program ${cpSwapId.toBase58()} --amm-config ${ammConfig.toBase58()}`);
  console.log('  Until then migrate_to_amm still fails AmmNotConfigured (6015).');
}

// ─── set-curve-segments ─────────────────────────────────────────────────────────

/**
 * Read the segmented curve's shape from a JSON file.
 *
 * A file rather than flags: this is up to 16 pairs of u128s, and a Q64.64 sqrt price
 * mistyped on a command line is not a smaller price, it is a completely different one
 * that the curve would then quote against without complaint. A file can be diffed,
 * reviewed and re-used across a dry run and the real ceremony.
 *
 * Numbers are read as STRINGS. JSON numbers are IEEE doubles: 2^64 and up silently
 * lose precision, and every value here is past that.
 */
function readSegmentsFile(path) {
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    return fail(`could not read --segments-file ${path}: ${e?.message ?? e}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return fail(`--segments-file ${path} is not valid JSON: ${e?.message ?? e}`);
  }
  const u128 = (v, label) => {
    if (typeof v === 'number') {
      fail(`${label} is a JSON number. Quote it as a string — values above 2^53 lose precision as doubles, silently.`);
    }
    if (typeof v !== 'string' || !/^\d+$/.test(v)) fail(`${label} must be a decimal string of digits, got ${JSON.stringify(v)}`);
    return BigInt(v);
  };
  if (!Array.isArray(doc?.segments)) fail(`--segments-file ${path} must be { "sqrtPriceStartX64": "…", "segments": [ … ] }`);
  return {
    sqrtPriceStartX64: u128(doc.sqrtPriceStartX64, 'sqrtPriceStartX64'),
    segments: doc.segments.map((s, i) => ({
      sqrtPriceUpperX64: u128(s?.sqrtPriceUpperX64, `segments[${i}].sqrtPriceUpperX64`),
      liquidity: u128(s?.liquidity, `segments[${i}].liquidity`),
    })),
  };
}

/**
 * `set_curve_segments` — publish the Meteora-shaped curve.
 *
 * The operator publishes ONE shape for the whole venue; creators pick a MODE, not a
 * curve. Re-runnable: the program validates the entire table before writing, so a
 * rejected table cannot leave a half-updated config behind.
 *
 * The checks below mirror the STRUCTURAL half of `segmented::validate_segments`
 * (segmented.rs:145-173) — count, strict ascent, non-zero liquidity. The PRICE-RANGE
 * half (MIN/MAX_SQRT_PRICE_X64 from the vendored tick math) is deliberately NOT copied
 * here: those are two more magic constants that would become a second source of truth
 * for the same rule, and the failure mode of getting them wrong is refusing a table the
 * program would have accepted. The program stays the authority; this catches the
 * mistakes that are obvious from the table alone, before a multisig ceremony.
 */
async function cmdSetCurveSegments(flags) {
  const pid = new PublicKey(programId(flags));
  const connection = connect();
  const status = await requireDeployed(connection, pid.toBase58());
  if (status.global?.kind !== 'ok') {
    fail(`global is "${status.global?.kind}" — \`set_curve_segments\` needs an initialized config. Run \`init-global\` first.`);
  }
  const current = status.global.value;

  const { sqrtPriceStartX64, segments } = readSegmentsFile(requireFlag(flags, 'segments-file'));

  const problems = [];
  if (segments.length === 0) problems.push('the table is empty — BadSegmentCount');
  if (segments.length > L.MAX_SEGMENTS) problems.push(`${segments.length} segments, above MAX_SEGMENTS ${L.MAX_SEGMENTS} — BadSegmentCount`);
  let prev = sqrtPriceStartX64;
  segments.forEach((s, i) => {
    if (s.liquidity === 0n) problems.push(`segments[${i}].liquidity is 0 — BadSegments`);
    if (s.sqrtPriceUpperX64 <= prev) {
      problems.push(
        `segments[${i}].sqrtPriceUpperX64 (${s.sqrtPriceUpperX64}) is not STRICTLY above the previous bound (${prev}) — BadSegments. ` +
          'Equal bounds are a zero-width segment that can never be crossed; descending bounds walk the wrong way.',
      );
    }
    prev = s.sqrtPriceUpperX64;
  });

  console.log('[operator] set_curve_segments');
  console.log(`  program            : ${pid.toBase58()}`);
  console.log(`  sqrt_price_start   : ${sqrtPriceStartX64}  (Q64.64)`);
  console.log(`  segments           : ${segments.length}`);
  segments.forEach((s, i) => console.log(`    [${String(i).padStart(2)}] upper ${s.sqrtPriceUpperX64}   liquidity ${s.liquidity}`));
  if (current.segmentCount > 0) {
    console.log(`  REPLACES the live table of ${current.segmentCount} segment(s), start ${current.sqrtPriceStartX64}.`);
    console.log('  Live curves are unaffected — every launch snapshots its terms at creation. This');
    console.log('  changes the shape FUTURE segmented launches are created from.');
  }
  if (problems.length > 0) {
    console.log('\n  ❌ the program would REJECT this table:');
    for (const p of problems) console.log(`     • ${p}`);
    fail('table rejected by the pre-flight above — nothing was built.');
  }
  console.log('  ✅ structural checks pass. The program additionally range-checks every price');
  console.log('     against MIN/MAX_SQRT_PRICE_X64 and liquidity against MAX_SEGMENT_LIQUIDITY');
  console.log('     (segmented.rs:145-173); those bounds are NOT duplicated here.');

  // `has_one = authority` (lib.rs:1613-1621). Checked against CHAIN state.
  const payer = await loadKeypair('OPERATOR_KEYPAIR');
  if (payer.publicKey.toBase58() !== current.authority.toBase58()) {
    fail(
      'the loaded key is not `global.authority`.\n' +
        `    loaded    : ${payer.publicKey.toBase58()}\n` +
        `    authority : ${current.authority.toBase58()}\n` +
        '  Build the instruction inside a Squads proposal rather than signing locally.',
    );
  }

  const tx = new Transaction().add(
    // ⚠️ Account order here is authority-then-global, the REVERSE of update_global.
    // Both are `has_one = authority`, so swapping them does not fail a signer check —
    // it hands the program a Signer where it expects the config account. `curve/ix.ts`
    // owns that ordering and is unit-tested on it; this file must not re-state it.
    L.setCurveSegmentsIx({ authority: payer.publicKey }, { sqrtPriceStartX64, segments }, { programId: pid }),
  );
  await prepareAndSign(connection, tx, payer.publicKey, flags.send ? payer : undefined);
  const sent = await maybeSend(connection, tx, flags);
  await emitTransaction(connection, tx, sent, 'set_curve_segments');

  console.log('\n  AFTER it lands, read it back with `status` — the send succeeding is not evidence the');
  console.log('  table decoded the way you meant. That is how GLOBAL_CONFIG_SIZE was found to be wrong.');
}

function printHelp() {
  console.log(`
tegridy-launch operator harness — protocol-level instructions for OUR OWN curve.

LIVE ON MAINNET since 2026-08-08 (CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED), and
\`initialize_global\` has run. Outstanding: cp-swap's AmmConfig does not exist, so
\`migrate_to_amm\` fails AmmNotConfigured (6015). \`create-amm-config\` is that step.
Every write command reads the chain first and refuses to build against an address with
no program — trust \`status\`, not this help text.

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
  create-amm-config  build cp-swap create_amm_config  (once per index — the PDA is one-shot)
  set-curve-segments build set_curve_segments  (the Meteora-shaped curve; re-runnable)
  help

GLOBAL FLAGS
  --program-id <id>  override the tegridy-launch program id
  --send             broadcast instead of printing. OPT-IN. Only completes when the
                     local key is a sufficient signer set — on mainnet the authority
                     is a Squads multisig, so the authority pre-check fails closed.

CONFIG FLAGS (init-global / check-config; all values are RAW integers, not decimals)
  --fee-bps <n>          trade fee, <= 1000 (MAX_FEE_BPS)
  --creator-fee-share-bps <n>  REQUIRED, no default. Share OF THE FEE paid to the
                         token's creator, <= 10000. 4800 = 48% (Meteora parity).
  --virtual-sol <lamports>
  --virtual-token <base units>
  --supply <base units>
  --target <lamports>    graduation target — EXCLUDES the migration reserve
  --reserve <lamports>   migration reserve, >= 42156720 (MIN_MIGRATION_RESERVE_LAMPORTS)
  --fee-recipient <base58>
  --cp-swap-program <base58>   optional at init — zero is the NORMAL case
  --amm-config <base58>        optional at init — zero is the NORMAL case

UPDATE FLAGS (update-global; pass only what changes)
  --fee-bps --target --reserve --virtual-sol --creator-fee-share-bps
  --pause | --unpause          pause blocks BUYS and migration; SELLS STAY OPEN
  --new-authority <base58>     --fee-recipient <base58>
  --cp-swap-program <base58>   --amm-config <base58>

CREATE-AMM-CONFIG FLAGS (cp-swap; every *_rate is out of 1,000,000, NOT basis points)
  --index <u16>              PERMANENT — it is a PDA seed, so a wrong index is burned
  --trade-fee-rate <n>       total swap fee. 2500 = 0.25%
  --protocol-fee-rate <n>    our share OF THE TRADE FEE. 120000 = 12% of the fee
  --fund-fee-rate <n>        second treasury share of the fee
  --create-pool-fee <lamports>  flat, charged once per pool, paid out of the migrating
                             curve's migration_reserve. Bounded by
                             (migration_reserve - MIN_MIGRATION_RESERVE), read LIVE.
  --creator-fee-rate <n>     pool-creator cut; distinct from global's creator split
  --cp-swap-program <id>     override the cp-swap program id

  The signer must be cp-swap's compile-time admin::ID AND be System-owned and funded —
  it is \`payer = owner\`. Both are checked before anything is signed. To see which keys
  the deployed binary actually carries:
    node ../scripts/verify-program-constants.mjs --deployed <cp-swap program id>

SET-CURVE-SEGMENTS FLAGS
  --segments-file <path>     JSON: { "sqrtPriceStartX64": "…", "segments": [
                             { "sqrtPriceUpperX64": "…", "liquidity": "…" }, … ] }
                             All values are decimal STRINGS — a JSON number above 2^53
                             loses precision silently, and a wrong Q64.64 sqrt price is
                             not a smaller price, it is a different curve.

ORDERING — the opposite of the obvious guess
  1. deploy under a real keypair                                        ✅ 2026-08-08
  2. init-global                       AMM addresses MAY be zero; no AmmConfig needed yet  ✅
  3. create-amm-config                 cp-swap admin creates the AmmConfig   ← OUTSTANDING
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
    case 'create-amm-config':
      return cmdCreateAmmConfig(flags);
    case 'set-curve-segments':
      return cmdSetCurveSegments(flags);
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
