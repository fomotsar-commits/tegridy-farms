#!/usr/bin/env node
/**
 * tegridy-launch — OPERATOR SIGNING HARNESS.
 *
 * The out-of-band driver for OUR OWN bonding curve's protocol-level instructions:
 * `initialize_global` and `update_global`, the two cp-swap admin steps graduation
 * needs (`create_amm_config`, `create_permission_pda`), and the two permissionless
 * post-launch calls (`migrate_to_amm`, `release_platform_reserve`). Read-only
 * commands need no key at all.
 * Mirrors `solana-dbc-operator.mjs` in shape and safety posture; the pure logic it
 * drives lives in `src/lib/launcher/solana/tegridyLaunch.ts` (unit-tested, and its
 * config math diffed against the real `curve.rs` over 50,009 cases).
 *
 * ─── ⛔ THERE IS NO PROGRAM TO DRIVE ───────────────────────────────────────────
 * `tegridy-launch` was deployed to mainnet 2026-08-08 at
 * `CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED` (slot 438,055,726),
 * `initialize_global` ran, and BOTH that id and the cp-swap fork
 * `3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y` were CLOSED on 2026-08-13. Their
 * ProgramData accounts return null with 0 lamports on two independent RPCs
 * (docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md). Solana never lets a closed program id
 * be redeployed, so both are permanently SPENT and every command here refuses them by
 * default — see `refuseSpentProgramId` below. A restart needs fresh keypairs, new
 * `declare_id!` values, and re-derivation of every PDA.
 *
 * This banner has been wrong in both directions: it read "not deployed" for four days
 * after the deploy, then "THE PROGRAM IS LIVE" for nine days after the close. A stale
 * banner is not a harmless comment either way — it tells an operator which refusals to
 * expect, so they stop reading the real one. The MECHANISM is what to trust: every
 * write command reads the chain first. But that read alone is NOT sufficient here, and
 * this is the trap that let the wrong banner survive — `solana program close` leaves
 * the program stub executable-FLAGGED, so `getAccountInfo` reports a program at both
 * spent ids and `requireDeployed` passes. Only the ProgramData account distinguishes a
 * live program from a spent one, which is why the id check below is a literal list and
 * not a chain read.
 *
 * `global` is stranded, not usable: it is still on chain holding rent under a program
 * that can never execute again, and nobody can close it.
 *
 * The graduation commands below never worked. cp-swap's AmmConfig was never created,
 * so `migrate_to_amm` failed AmmNotConfigured (6015) for the program's whole life, and
 * `create-amm-config` now has no cp-swap program to create it on.
 *
 * ─── SAFETY / DOCTRINE ─────────────────────────────────────────────────────────
 *   • Secrets come from ENV/CLI ONLY. Nothing is hardcoded or committed: the RPC URL
 *     and the operator keypair (a LOCAL file path) both arrive at runtime.
 *   • DEFAULT is PRINT (partial-signed base64) for out-of-band Squads co-signing.
 *     `--send` is opt-in. On mainnet `global.authority` is the Squads VAULT PDA
 *     (GRMtSx…, never the multisig account EVGSnRZ…, which cannot sign), so the local
 *     key is NOT a sufficient signer set and the authority pre-check below fails
 *     closed before anything is built.
 *   • The two PERMISSIONLESS commands (`migrate`, `release-reserve`) SIMULATE by
 *     default and send only with `--send`; they need a key only to send.
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
 *   0. generate FRESH program keypairs and patch `declare_id!` — the 2026-08-08 ids are
 *      spent and step 1 cannot be run against either of them  ← WHERE A RESTART BEGINS
 *   1. deploy the program under that keypair (not the placeholder, not a spent id)
 *   2. `init-global`      — AMM addresses may be zero; the AmmConfig need not exist
 *   3. `create-amm-config`  — cp-swap admin creates the AmmConfig
 *   4. `create-permission`  — cp-swap admin creates the Permission account for our
 *      program-wide migration authority `["migauth"]`. cp-swap's pool-creating
 *      instruction reads it from its payer, and that payer is the migration
 *      authority, so without it every graduation fails MigrationPermissionMissing
 *      (6021). The 2026-08-08 sequence had no such step at all.
 *   5. `update-global --cp-swap-program … --amm-config …`   ← the ONLY way to set them
 *   6. migration is possible (`migrate`, permissionless); until step 5 it fails
 *      AmmNotConfigured (6015)
 *   7. after each graduation, `release-reserve` (permissionless) sends that launch's
 *      platform reserve to the treasury's token account
 *
 * Steps 1 and 2 were done once, on 2026-08-08, and undone by the 2026-08-13 close.
 * Steps 3-7 have never run.
 *
 * There is no venue-shape step any more. `set-curve-segments` published the
 * Meteora-shaped curve for `create_launch --mode 1` to snapshot; segmented mode was
 * removed from the program, so the command, the mode flag and the curve are all
 * gone and every launch is constant-product.
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
 *     --fee-bps 100 --creator-fee-share-bps 5000 --platform-reserve-bps 369 \
 *     --virtual-sol 30000000000 --virtual-token 1033406300000000 \
 *     --supply 1000000000000000 --target 11685689681 --reserve 42156720 \
 *     --fee-recipient <base58>
 *
 * (`--virtual-token` there is 1,073,000,000,000,000 scaled by (1 - 3.69%), which keeps
 * the graduation target of the no-reserve book to the lamport. `check-config` prints
 * the recipe for any book.)
 *
 * Commands: status | derive | check-config | init-global | update-global |
 *           create-amm-config | create-permission | migrate | release-reserve | help
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactRpcUrl } from '../../scripts/lib/redact-url.mjs';
import { register } from 'node:module';
import {
  CP_SWAP_PERMISSION_LEN,
  createPermissionPdaIx,
  endsWithSomeU64,
  endsWithU64,
  graduationSplit,
  LISTING_GAP_TOLERANCE_BPS,
  listingGap,
  migratePayerFloat,
  optionalFlagValue,
  parsePlatformReserveBps,
  pct3,
  permissionAuthorityOf,
  scaledVirtualToken,
  simulatedErrorLabel,
  unsignableReason,
  updateNeedsListingGate,
} from './lib/tegridy-launch-ops.mjs';

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

const { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } = await import('@solana/web3.js');

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

// deployer::ID, per cfg arm of `mod deployer` in lib.rs. The devnet arm is a
// placeholder CI overwrites; the non-devnet arm is the restart's mainnet deployer
// (owner ruling 2026-09-25), which replaced the System Program sentinel on 2026-09-26.
// This used to name 8YVjjc… as the devnet arm, which it had stopped being.
const DEVNET_DEPLOYER_ID = 'EMQVYMPe2UffGAVNYK6ZveCFM2tHjc5DBiXGKYFE6DXA';
const MAINNET_DEPLOYER_ID = 'CqcVvaMvesrSKrUSbqBqr9mLjKLJuYqhaXg1gXpR41cg';
const SYSTEM_SENTINEL = '11111111111111111111111111111111';

// Blockhash is fetched at 'finalized' for durability; the expiry window below is
// measured against the 'confirmed' tip, which is where the cluster actually judges it.
const BLOCKHASH_COMMITMENT = 'finalized';

// ─── Arg parsing (mirrors solana-dbc-operator.mjs) ──────────────────────────────
//
// Valueless flags MUST be listed so they never swallow the token that follows them:
// `--send init-global …` would otherwise consume the subcommand as `--send`'s value
// and silently fall through to help.
const BOOLEAN_FLAGS = new Set(['send', 'pause', 'unpause', 'accept-listing-gap']);

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

/**
 * The value of an optional flag, or `undefined` when it was not passed. A flag
 * typed with no value fails (`optionalFlagValue`): on update-global it would
 * otherwise read as "leave unchanged" and drop out of an update that still goes.
 */
function optionalFlag(flags, name) {
  const r = optionalFlagValue(flags, name);
  if (!r.ok) fail(r.error);
  return r.value;
}

function optionalU64Flag(flags, name) {
  if (optionalFlag(flags, name) === undefined) return undefined;
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
  const raw = optionalFlag(flags, name);
  if (raw === undefined) return undefined;
  const s = raw.trim();
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

// The id used when `--program-id` is not given. This is `PROGRAM_ID` — the address the
// 2026-08-08 deploy went to — NOT the placeholder. It was previously named
// PLACEHOLDER_PROGRAM_ID and set to `L.PROGRAM_ID`, which made the two synonymous;
// once PROGRAM_ID was pointed at the deploy, `status` began labelling the real mainnet
// program "(PLACEHOLDER from lib.rs:101)". Same self-referential shape as the
// `isPlaceholderProgramId` bug in curve/program.ts, and it reads as reassuring in
// exactly the case where it is wrong.
//
// That address is now SPENT — see `SPENT_PROGRAM_IDS` — and on 2026-09-26 the default
// moved to the restart id (`REGISTERED_PROGRAM_ID`, owner ruling 2026-09-25), which is
// REGISTERED, NOT deployed. That is safe as a default for exactly the reason the spent
// one was: every write command reads the deployment first and refuses when nothing is
// there, and `status` says so. The frontend's own `PROGRAM_ID` stays the spent record
// until the deploy is proven; this harness is the tool that performs it.
const DEFAULT_PROGRAM_ID = L.REGISTERED_PROGRAM_ID.toBase58();
const PLACEHOLDER_PROGRAM_ID = L.PLACEHOLDER_PROGRAM_ID.toBase58();

/**
 * Program ids whose ProgramData was closed on mainnet 2026-08-13, verified null with 0
 * lamports on two independent RPCs (docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md).
 *
 * This is a literal list and not a chain read on purpose: `solana program close`
 * deletes the ProgramData account but leaves the 36-byte program stub
 * executable-FLAGGED, so `getAccountInfo` — and therefore `readDeployment` and
 * `requireDeployed` — reports `deployed` at both of these. The chain read that every
 * other refusal in this file rests on cannot see the difference; only reading the
 * ProgramData account can, and no command here does.
 *
 * ⚠ MAY ONLY GROW BY A REAL CLOSURE. Removing an entry asserts that a spent program id
 * became reusable, which Solana does not permit.
 */
// ⚠ HARDCODED BASE58, NOT DERIVED — and this is the whole point of the list.
//
// These were `L.PROGRAM_ID.toBase58()` and `L.CP_SWAP_PROGRAM_ID.toBase58()`, which
// made the refusal list track whatever the constants happened to be. The moment those
// constants are repointed at the fresh ids for a redeploy, that version INVERTS: it
// starts refusing the brand-new program you just deployed, and stops refusing the two
// ids that are actually spent. Exactly backwards, silently, on the one day it matters.
//
// A spent id is a fact about the chain, not about our source. It is written out.
const SPENT_PROGRAM_IDS = new Map([
  ['CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED', 'tegridy-launch, closed 2026-08-13'],
  ['3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y', 'the cp-swap fork, closed 2026-08-13'],
]);

/** Refuse before anything is built. A tx for a spent id can only ever fail on submit. */
function refuseSpentProgramId(pid, what) {
  const why = SPENT_PROGRAM_IDS.get(String(pid));
  if (!why) return;
  fail(
    `${pid} is a SPENT program id (${why}).\n` +
      `  Its ProgramData account is gone, so nothing can execute there and Solana will\n` +
      '  never allow a redeploy to this address. The program stub is still\n' +
      '  executable-flagged, so no chain read this harness makes can catch it — which is\n' +
      '  why this refusal is a literal id list and runs before the RPC.\n' +
      `  Building ${what} against it produces a transaction that cannot succeed.\n` +
      '  A restart needs a fresh program keypair, a new declare_id!, and re-derivation\n' +
      '  of every PDA — then pass the new address with --program-id.',
  );
}

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

/**
 * Render a `Deployment` honestly — an unreadable RPC is never "not deployed", and an
 * executable account at a spent id is never a running program. `deployed` is the
 * strongest thing an account read can say and it is not strong enough on its own: the
 * stub left behind by `solana program close` satisfies it exactly.
 */
function printDeployment(d, pid) {
  switch (d.kind) {
    case 'deployed':
      if (SPENT_PROGRAM_IDS.has(String(pid))) {
        console.log('  program      : ⛔ SPENT — the executable account here is the stub left by');
        console.log(`                 \`solana program close\` (${SPENT_PROGRAM_IDS.get(String(pid))}).`);
        console.log('                 Its ProgramData is gone: nothing can execute and nothing can');
        console.log('                 be redeployed to this address, ever.');
        return;
      }
      console.log('  program      : DEPLOYED (an executable account is at this address)');
      console.log('                 …which a closed program also satisfies. Read its ProgramData');
      console.log('                 account before treating this as a running program.');
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
  console.log(
    `    platform_reserve_bps  : ${c.platformReserveBps ?? '(not decoded — this client predates the field)'}` +
      (c.platformReserveBps !== undefined ? ` (${Number(c.platformReserveBps) / 100}% of each NEW launch's supply)` : ''),
  );
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
async function requireDeployed(connection, pid, what = 'this instruction') {
  // Before the RPC, because the RPC cannot answer this one: a closed program's stub
  // stays executable-flagged and every check below would pass.
  refuseSpentProgramId(pid, what);
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
        `  ${DEFAULT_PROGRAM_ID} is the restart id (registered 2026-09-26) — if it is the one\n` +
        '  you meant, it has not been deployed on this cluster yet.\n' +
        `  ${PLACEHOLDER_PROGRAM_ID} is the old throwaway and corresponds to no key anybody\n` +
        '  holds. If you passed --program-id, check it; otherwise check the RPC cluster.',
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
  // Default: the restart's cp-swap id (registered 2026-09-26; no program there yet) — the
  // one tegridy-launch's mainnet build pins as `cp_swap::ID`. Every caller reads the
  // deployment before building anything, so an undeployed default refuses by itself.
  return flags['cp-swap-program'] ? String(flags['cp-swap-program']).trim() : L.REGISTERED_CP_SWAP_PROGRAM_ID.toBase58();
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

/**
 * Refuse an address that can never sign, for a flag whose address must.
 *
 * Two flags need this. `--new-authority`: `update_global` is `has_one = authority`
 * with the authority as a `Signer`, so an authority that cannot sign locks `global`
 * for good (no pause, no fee change, no AMM addresses, no handover).
 * `--fee-recipient`: it receives the protocol's trade fees and migration residuals,
 * and it OWNS the token account every released platform reserve lands in, so only
 * a signer can ever spend any of it.
 *
 * The Squads MULTISIG account (EVGSnRZ…) is exactly the address to catch: owned by
 * the Squads program, with data, while Squads v4 signs as the VAULT PDA (GRMtSx…),
 * a different address. It is the 2026-08-08 `admin::ID` mistake in a new place. An
 * account that does not exist yet is allowed (a fresh wallet can still sign); one
 * that exists and is not System-owned is not (`unsignableReason`).
 */
async function refuseUnsignableAddress(connection, base58, flag, consequence) {
  let info;
  try {
    info = await connection.getAccountInfo(new PublicKey(base58));
  } catch (e) {
    fail(`could not read ${flag} ${base58} (${e?.message ?? e}). Refusing to use an address that was not checked.`);
  }
  const reason = unsignableReason(info, new PublicKey(SYSTEM_SENTINEL));
  if (reason) {
    fail(
      `${flag} ${base58} is ${reason}.\n` +
        `  Nothing can sign as a program-owned account, so ${consequence}.\n` +
        '  For Squads, pass the VAULT PDA (System-owned, 0 bytes), never the multisig account.',
    );
  }
}

const AUTHORITY_LOCKED = 'global would be locked forever';
const FEE_RECIPIENT_LOCKED =
  'every trade fee, migration residual and released platform reserve paid to it would be stuck';

/**
 * Refuse a book that lists away from the curve's final price (`listingGap`), unless
 * `--accept-listing-gap` says the gap is deliberate. The program cannot stop this:
 * its band is ±5%, and an untuned 3.69% reserve lists at +4.88%.
 */
function refuseListingGap(flags, ratioBps, recipe) {
  const gap = listingGap(ratioBps);
  if (!gap) return;
  if (flags['accept-listing-gap']) {
    console.log(`  ⚠ listing gap ACCEPTED by --accept-listing-gap: ${gap}`);
    return;
  }
  fail(
    `${gap}.\n` +
      '  The program accepts anything within ±5%, so it will not stop this: every launch would\n' +
      `  list its pool away from the price its last buyer paid. To fix it:\n${recipe}\n` +
      `  If the gap is deliberate, pass --accept-listing-gap. Nothing was built.`,
  );
}

// ─── Migration authority + cp-swap permission ───────────────────────────────────

/**
 * The program-wide migration authority, `["migauth"]` with NO mint (state.rs
 * `MIGRATION_AUTH_SEED`, and the `seeds = [MIGRATION_AUTH_SEED]` on `MigrateToAmm`).
 *
 * Taken from the curve core, then re-derived here from the bare seed and compared.
 * The core used to derive `["migauth", mint]`, which is not the address the program
 * checks — every migration it built would have failed its seeds constraint, and a
 * permission account created for it would have been for the wrong authority. A
 * permission account is admin-signed, so building one for a wrong address wastes a
 * ceremony and still leaves graduation blocked. The comparison makes that bug a
 * refusal here instead.
 */
function migrationAuthorityOf(pid) {
  const programKey = new PublicKey(pid);
  const fromCore = L.migrationAuthorityPda(programKey);
  const [bare] = PublicKey.findProgramAddressSync([L.MIGRATION_AUTH_SEED], programKey);
  if (!(fromCore instanceof PublicKey) || !fromCore.equals(bare)) {
    fail(
      'the curve core derives the migration authority differently from the program.\n' +
        `    program seeds ["migauth"] : ${bare.toBase58()}\n` +
        `    core returned            : ${fromCore?.toBase58?.() ?? String(fromCore)}\n` +
        '  The core must derive ["migauth"] with no mint. Refusing to build against the wrong authority.',
    );
  }
  return bare;
}

/**
 * Read cp-swap's `Permission` account for `authority`. `present` only when the
 * account is owned by cp-swap AND stores that authority; anything else at the
 * address is reported, never treated as usable.
 */
async function readPermission(connection, cpSwapId, authority) {
  const address = L.cpPermissionPda(authority, cpSwapId);
  let info;
  try {
    info = await connection.getAccountInfo(address);
  } catch (e) {
    return { kind: 'unreadable', address, detail: e?.message ?? String(e) };
  }
  if (!info) return { kind: 'absent', address };
  if (!info.owner.equals(cpSwapId)) return { kind: 'foreign', address, owner: info.owner.toBase58() };
  const stored = permissionAuthorityOf(info.data);
  if (!stored || !stored.equals(authority)) {
    return { kind: 'foreign', address, owner: `cp-swap, authority ${stored?.toBase58() ?? '(unreadable)'}` };
  }
  return { kind: 'present', address };
}

/**
 * The payer for a PERMISSIONLESS command. With `--send` it must be a local key.
 * Without it, `--payer <base58>` is enough to simulate: nothing is signed.
 */
async function payerFor(flags) {
  if (!flags.send) {
    const p = optionalPubkeyFlag(flags, 'payer');
    if (p) return { publicKey: new PublicKey(p), keypair: undefined };
  }
  const kp = await loadKeypair('OPERATOR_KEYPAIR');
  return { publicKey: kp.publicKey, keypair: kp };
}

/**
 * Simulate without sending. Signatures are not verified, so this needs no key; it
 * runs the real program against real state, which catches what a pre-flight read
 * cannot (account order, a constraint the harness does not mirror).
 */
async function simulate(connection, tx, label, { launchProgramId } = {}) {
  const sim = await connection.simulateTransaction(tx);
  const v = sim.value;
  console.log(`\n── ${label}: SIMULATION ONLY — nothing was sent ──`);
  // Named only when tegridy-launch itself raised the code: a cp-swap failure inside
  // migrate_to_amm comes back as the same Custom(6000+) range (simulatedErrorLabel).
  const custom = v.err?.InstructionError?.[1]?.Custom;
  const named = launchProgramId ? simulatedErrorLabel(custom, v.logs, launchProgramId, L.launchErrorName) : '';
  console.log(`  result        : ${v.err ? `FAILED ${JSON.stringify(v.err)}${named}` : 'ok'}`);
  if (typeof v.unitsConsumed === 'number') console.log(`  compute units : ${v.unitsConsumed}`);
  for (const line of v.logs ?? []) console.log(`    ${line}`);
  return v;
}

// ─── Commands ───────────────────────────────────────────────────────────────────

async function cmdStatus(flags) {
  const pid = programId(flags);
  const connection = connect();
  const status = await readProtocol(connection, pid);
  const globalAddress = globalPdaOf(pid);

  console.log('[operator] tegridy-launch status');
  console.log(`  cluster      : ${redactRpcUrl(connection.rpcEndpoint)}`);
  console.log(`  program id   : ${pid}${pid === PLACEHOLDER_PROGRAM_ID ? '  (the OLD placeholder — no key exists for it)' : ''}`);
  console.log(`  global PDA   : ${globalAddress}`);
  printDeployment(status.program, pid);
  printGlobal(status.global, globalAddress, status.program.kind);

  console.log('\n  outstanding steps:');
  if (SPENT_PROGRAM_IDS.has(pid)) {
    // Ahead of every other branch: `global` reads OK at the spent tegridy-launch id, so
    // the ladder below would otherwise print "none — the protocol is configured".
    console.log('    NONE OF THE STEPS BELOW APPLY — this program id is spent.');
    console.log('    A restart starts at step 0: fresh program keypairs, new declare_id!,');
    console.log('    re-derive every PDA, then re-run this with --program-id <new address>.');
    console.log('    Any `global` shown above is stranded state under a closed program.');
  } else if (status.program.kind === 'unreadable') {
    // A failed read is NOT a finding about the protocol. Naming a "next step" here
    // would turn an RPC outage into "go deploy the program" — the exact collapse of
    // "could not read" into "read it, answer is no" this repo keeps shipping.
    console.log('    UNKNOWN — the program account could not be read, so no step can be named.');
    console.log('    Fix the RPC and re-run. Nothing below was determined.');
  } else if (status.program.kind !== 'deployed') {
    console.log('    1. deploy the program under a real keypair   ← NEXT');
    console.log('    2. init-global');
    console.log('    3. cp-swap admin: create-amm-config');
    console.log('    4. cp-swap admin: create-permission');
    console.log('    5. update-global --cp-swap-program … --amm-config …');
  } else if (status.global?.kind === 'absent') {
    console.log('    2. init-global   ← NEXT  (AMM addresses may be left zero here)');
    console.log('    3. cp-swap admin: create-amm-config');
    console.log('    4. cp-swap admin: create-permission');
    console.log('    5. update-global --cp-swap-program … --amm-config …');
  } else if (status.global?.kind === 'ok') {
    if (!L.isAmmConfigured(status.global.value)) {
      console.log('    3. cp-swap admin: create-amm-config (if it does not exist)');
      console.log('    4. cp-swap admin: create-permission (if it does not exist)');
      console.log('    5. update-global --cp-swap-program … --amm-config …   ← NEXT');
    } else {
      // The AMM addresses are set, but graduation ALSO needs cp-swap's Permission
      // account for our migration authority, and nothing in `global` records it.
      // Read it rather than print "configured" over a missing account.
      const cpSwapId = status.global.value.cpSwapProgram;
      const perm = await readPermission(connection, cpSwapId, migrationAuthorityOf(pid));
      if (perm.kind === 'present') {
        console.log('    none — the protocol is configured and migration is possible.');
      } else if (perm.kind === 'absent') {
        console.log(`    4. cp-swap admin: create-permission --cp-swap-program ${cpSwapId.toBase58()}   ← NEXT`);
        console.log(`       ${perm.address.toBase58()} does not exist, so every migrate_to_amm`);
        console.log('       fails MigrationPermissionMissing (6021).');
      } else if (perm.kind === 'foreign') {
        console.log(`    ⚠ the permission address ${perm.address.toBase58()} holds something else (${perm.owner}).`);
        console.log('      Graduation cannot use it. Investigate before any launch fills.');
      } else {
        console.log(`    UNKNOWN — the permission account could not be read (${perm.detail}).`);
      }
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
  console.log(`  migauth    : ${migrationAuthorityOf(pid).toBase58()}   seeds ["migauth"] — one per program, no mint`);
  if (SPENT_PROGRAM_IDS.has(pid)) {
    console.log(`\n  ⛔ ${pid} is SPENT (${SPENT_PROGRAM_IDS.get(pid)}). These addresses`);
    console.log('     are where the rail used to derive; a restart re-derives all of them.');
  }
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

/**
 * `platform_reserve_bps` — the LAST argument to `initialize_global`: the share of
 * every launch's supply the protocol holds back (369 = 3.69%). Held in the curve's
 * own vault, never sold on the curve, never put in the pool, and released to the
 * treasury only after the launch graduates (`release-reserve`).
 *
 * No default, for the reason `--creator-fee-share-bps` has none: it is decided once
 * at `initialize_global`, snapshotted onto every launch, and a default would let the
 * share of supply the protocol takes be chosen by omission.
 */
function requirePlatformReserveBps(flags) {
  const r = parsePlatformReserveBps(flags['platform-reserve-bps'], { required: true, max: L.MAX_PLATFORM_RESERVE_BPS });
  if (!r.ok) fail(r.error);
  return r.value;
}

/**
 * Print where the supply goes, and the scaled `initial_virtual_token` recipe.
 *
 * Also the one check that the curve core actually priced the CURVE supply, not the
 * whole supply: the program runs every config check against `supply - reserve`
 * (the reserve is never sold and never pooled). A core that ignored the reserve
 * would pass a config the program rejects, or, worse, hide a listing gap. When its
 * ratio disagrees with the ratio for the curve supply, the disagreement is added to
 * `report.problems`, so `init-global` refuses.
 */
function printReserveSplit(params, report) {
  const S = params.tokenTotalSupply;
  const split = L.curveSupply(S, params.platformReserveBps);
  if (!split.ok) {
    report.problems.push(`platform reserve: ${split.error}`);
    return;
  }
  const { curveTokens, reserveTokens } = split.value;
  const vs = params.initialVirtualSol;
  const vt = params.initialVirtualToken;
  const T = params.graduationTargetLamports;
  const R = params.migrationReserveLamports;

  const expected = L.graduationPriceRatioBps(vs, vt, curveTokens, T, R);
  const expectedRatio = expected.ok ? expected.value : null;
  if (report.graduationPriceRatioBps !== expectedRatio) {
    report.problems.push(
      `the curve core priced ${report.graduationPriceRatioBps ?? 'nothing'} bps, but the program prices the ` +
        `curve supply (${curveTokens}) at ${expectedRatio ?? '(not computable)'} bps. The core is not applying ` +
        'the platform reserve; do not sign anything it pre-flighted.',
    );
  }

  if (reserveTokens === 0n) {
    console.log('\n  platform reserve       : none (0 bps) — the whole supply is on the curve');
  } else {
    console.log('\n  platform reserve       : ' +
      `${params.platformReserveBps} bps = ${reserveTokens} base units, held in the curve vault,`);
    console.log('                           never sold on the curve, never pooled, released to the');
    console.log('                           treasury ATA only after graduation (release-reserve)');
    console.log(`  curve supply           : ${curveTokens}  (supply - reserve; every check above uses this)`);
  }
  const g = graduationSplit({ supply: S, curveTokens, virtualSol: vs, virtualToken: vt, target: T, migrationReserve: R });
  if (g) {
    console.log(`  at graduation          : sold ${pct3(g.sold, S)} / LP ${pct3(g.lp, S)} / reserve ${pct3(g.reserve, S)} of supply`);
    if (g.reserve > 0n) {
      console.log(`                           reserve = ${pct3(g.reserve, g.lp)} of the pool's token side once released`);
    }
  } else {
    console.log('  at graduation          : (could not compute — the book cannot reach this target)');
  }

  if (reserveTokens === 0n) return;
  // The recipe. Scaling Vt with the carve keeps (Vt + S) / Vt, and with it the
  // continuity target, unchanged — so the SOL raise is what it was without a reserve.
  //
  // Printed only when it applies. A book that is already tuned for the reserve
  // would be scaled twice by an operator who followed an unconditional recipe.
  if (report.continuityTarget !== null && report.continuityTarget === T) {
    console.log('\n  Vt                     : already tuned for the reserve — the target IS this book\'s');
    console.log('                           continuity target on the curve supply. No rescaling.');
  } else {
    const scaled = scaledVirtualToken(vt, curveTokens, S);
    const before = L.continuityTarget(vs, vt, S, R);
    const after = L.continuityTarget(vs, scaled, curveTokens, R);
    const wasUnscaled = before.ok && before.value === T;
    console.log(
      wasUnscaled
        ? '\n  ⚠ scaled Vt recipe     : --target is the continuity target of this book WITHOUT a reserve.\n' +
            '                           To keep that target (and the SOL raise) with the reserve, pass'
        : '\n  scaled Vt recipe       : to carry a NO-reserve book over with its target unchanged, pass',
    );
    console.log(`                           --virtual-token ${scaled}   (= ${vt} x ${curveTokens} / ${S}, rounded down)`);
    console.log(
      `                           continuity target: ${before.ok ? before.value : '?'} without a reserve, ` +
        `${after.ok ? after.value : '?'} with the scaled Vt` +
        (before.ok && after.ok && before.value === after.value ? ' — identical' : ''),
    );
    if (!wasUnscaled) {
      console.log(`                           Or keep this Vt and move --target to ${report.continuityTarget ?? '?'} (above).`);
    }
  }
  console.log('                           Only initialize_global sets Vt. update_global cannot, so a later');
  console.log('                           reserve change must be absorbed by virtual SOL, target or reserve.');
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
    platformReserveBps: requirePlatformReserveBps(flags),
  };
  const report = L.checkLaunchEconomics(params);
  console.log('[operator] config pre-flight (pure — mirrors initialize_global)');
  console.log(`  max reachable real SOL : ${report.maxReachableRealSol ?? '(could not compute)'}`);
  console.log(`  lists at               : ${report.graduationPriceRatioBps ?? '(could not compute)'} bps of the final curve price`);
  console.log(`  continuity target      : ${report.continuityTarget ?? '(could not compute)'}${report.continuityTarget !== null ? ` (${sol(report.continuityTarget)})` : ''}`);
  console.log('                           ^ the target that lists at exactly the curve price');
  printReserveSplit(params, report);
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
  const status = await requireDeployed(connection, pid.toBase58(), 'initialize_global');

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
  // Same treatment, same reason: validated before the key, echoed because nothing
  // else says it out loud. It must also appear in the launch page's terms.
  const reserveBps = requirePlatformReserveBps(flags);
  console.log(`  platform reserve       : ${reserveBps} bps (${Number(reserveBps) / 100}% of every launch's supply, to the treasury after graduation)`);
  // A reserve moves the listing price, and the program's ±5% band accepts the move
  // an untuned book makes (10488 bps at 369). The pre-flight above only printed it.
  if (reserveBps > 0n) {
    const S = requireU64Flag(flags, 'supply');
    const split = L.curveSupply(S, reserveBps);
    const scaled = split.ok ? scaledVirtualToken(requireU64Flag(flags, 'virtual-token'), split.value.curveTokens, S) : null;
    refuseListingGap(
      flags,
      report.graduationPriceRatioBps,
      `    • if --target is this book's target WITHOUT a reserve, pass --virtual-token ${scaled ?? '?'}\n` +
        '      (Vt scaled by the reserve; only initialize_global can ever set it), or\n' +
        `    • keep --virtual-token and pass --target ${report.continuityTarget ?? '?'} (the continuity target on the curve supply).`,
    );
  }

  const feeRecipient = optionalPubkeyFlag(flags, 'fee-recipient');
  if (!feeRecipient) fail('missing required --fee-recipient <base58> (mainnet: the treasury Squads vault)');
  await refuseUnsignableAddress(connection, feeRecipient, '--fee-recipient', FEE_RECIPIENT_LOCKED);
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
    console.log(`      A mainnet build of this tree expects ${MAINNET_DEPLOYER_ID};`);
    console.log(`      a --features devnet build expects ${DEVNET_DEPLOYER_ID} unless CI patched it.`);
    console.log(`      A build from before 2026-09-26 embeds ${SYSTEM_SENTINEL} (the System`);
    console.log('      Program sentinel), which NOBODY can sign for.');
  } else if (bakedIn === true) {
    console.log('  deployer::ID        : ✅ this key is present in the deployed bytecode');
  } else {
    console.log('  deployer::ID        : (could not fetch bytecode to check — proceeding)');
  }
  if (cpSwapProgram === ZERO || ammConfig === ZERO) {
    console.log('  note: AMM addresses left zero — this is the NORMAL path (lib.rs:184-187).');
    console.log('        Set them afterwards with `update-global`; migration is blocked until then.');
  }

  const platformReserveBps = requirePlatformReserveBps(flags);
  const ix = L.initializeGlobalIx(
    // Accounts AND data from `curve/ix.ts`; the `global` PDA is derived inside it
    // from the same `programId`, so the address here cannot drift from the one the
    // encoder targets.
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
      platformReserveBps,
    },
    { programId: pid },
  );
  // The reserve is the LAST argument. Prove it reached the wire: an encoder that
  // does not know the field would drop it, the program would fail to deserialize,
  // and the ceremony would be spent on a transaction that could never land.
  if (!endsWithU64(ix.data, platformReserveBps)) {
    fail('the encoded initialize_global does not end with platform_reserve_bps — the curve core predates the field. Nothing was built.');
  }
  const tx = new Transaction().add(ix);
  await prepareAndSign(connection, tx, authority, flags.send ? payer : undefined);
  const sent = await maybeSend(connection, tx, flags);
  await emitTransaction(connection, tx, sent, 'initialize_global');
}

async function cmdUpdateGlobal(flags) {
  const pid = new PublicKey(programId(flags));
  const connection = connect();
  const status = await requireDeployed(connection, pid.toBase58(), 'update_global');

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
    // The eleventh and last Option. Optional here, unlike init-global: omitting it
    // is `None`, "leave unchanged". A value moves only FUTURE launches; each live
    // launch keeps the reserve amount it was created with.
    newPlatformReserveBps: (() => {
      const r = parsePlatformReserveBps(flags['platform-reserve-bps'], { required: false, max: L.MAX_PLATFORM_RESERVE_BPS });
      if (!r.ok) fail(r.error);
      return r.value;
    })(),
  };
  if (Object.values(args).every((v) => v === undefined)) {
    fail('nothing to update — pass at least one of --fee-bps --creator-fee-share-bps --target --reserve --virtual-sol\n  --platform-reserve-bps --pause/--unpause --new-authority --fee-recipient --cp-swap-program --amm-config');
  }
  if (args.newAuthority) await refuseUnsignableAddress(connection, args.newAuthority, '--new-authority', AUTHORITY_LOCKED);
  if (args.newFeeRecipient) {
    await refuseUnsignableAddress(connection, args.newFeeRecipient, '--fee-recipient', FEE_RECIPIENT_LOCKED);
  }

  // `has_one = authority` (lib.rs:1248). Check it against CHAIN state rather than
  // letting the ceremony end in Unauthorized (6008).
  const payer = await loadKeypair('OPERATOR_KEYPAIR');
  if (payer.publicKey.toBase58() !== current.authority.toBase58()) {
    fail(
      `the loaded key is not \`global.authority\`.\n` +
        `    loaded    : ${payer.publicKey.toBase58()}\n` +
        `    authority : ${current.authority.toBase58()}\n` +
        '  On mainnet the authority is the Squads VAULT PDA, so this is expected: build the\n' +
        '  instruction inside a Squads proposal rather than signing locally.',
    );
  }

  // EVERY guard `update_global` applies, in the shape the program applies them —
  // including the MAX_FEE_BPS ceiling, which is unconditional on `--fee-bps` being
  // supplied and used to be reachable only when an unrelated flag was also present.
  // The resolution lives in `curve/config.ts` so it is unit-tested rather than
  // asserted by this script's shape (config.test.ts).
  const check = L.checkUpdateGlobal(args, current);
  // A reserve-only change moves the listing price, so the program re-runs the
  // launch-economics check for it. If the pre-flight did not, it is not modelling
  // the program, and "no problems" below would mean nothing.
  if (args.newPlatformReserveBps !== undefined && !check.economics) {
    fail(
      'the curve core did not re-run the launch-economics check for a --platform-reserve-bps change,\n' +
        '  but the program does (the reserve changes the curve supply, and with it the listing price).\n' +
        '  The core predates the field. Nothing was built.',
    );
  }
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
  // A reserve change moves the listing price of every NEW launch, and the program's
  // ±5% band accepts most such moves (a tuned 369 book reads ~9550 at 0 and ~10170 at
  // 500). So does a target, reserve or virtual-SOL change on a book that carries a
  // reserve: `--target 11685689681` on a 369 book tuned by its target lists at 10488.
  // Vt cannot be changed here, so the fix is the target or the virtual SOL.
  if (
    updateNeedsListingGate({
      economics: check.economics,
      newPlatformReserveBps: args.newPlatformReserveBps,
      currentPlatformReserveBps: current.platformReserveBps,
    })
  ) {
    refuseListingGap(
      flags,
      check.economics.graduationPriceRatioBps,
      `    • pass --target ${check.economics.continuityTarget ?? '?'} in the same update (the continuity target\n` +
        "      for this book's reserve after the update), or retune --virtual-sol with check-config.",
    );
  }

  console.log('\n[operator] update_global');
  console.log(`  authority (signer) : ${payer.publicKey.toBase58()}`);
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined) console.log(`  ${k.padEnd(18)}: ${v}`);
  }

  if (args.newPlatformReserveBps !== undefined) {
    console.log('  note: initial_virtual_token cannot be changed by update_global, so this reserve');
    console.log('        change is absorbed by the book as it stands. The listed ratio above is the');
    console.log('        one every NEW launch gets; live launches keep their own snapshot.');
  }
  if (args.newFeeRecipient && args.newFeeRecipient !== current.feeRecipient.toBase58()) {
    console.log('  note: fee_recipient is read when a reserve is RELEASED, not when it is carved.');
    console.log('        Every graduated-but-unreleased reserve now goes to the new recipient.');
  }

  const ix = L.updateGlobalIx(
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
  );
  // The encoder writes `None` for any argument it does not recognise. For the last
  // Option that is silent: the program leaves the reserve alone and the operator
  // believes it changed. Check the value is what actually ended the data.
  if (args.newPlatformReserveBps !== undefined && !endsWithSomeU64(ix.data, args.newPlatformReserveBps)) {
    fail('the encoded update_global does not carry --platform-reserve-bps as its last Option — the curve core predates the field. Nothing was built.');
  }
  const tx = new Transaction().add(ix);
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
  //    an unreadable RPC is never "not deployed" — and the read below cannot see a
  //    closed program at all, so the spent-id refusal runs first.
  refuseSpentProgramId(cpSwapId.toBase58(), 'create_amm_config');
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
    console.log('[operator] create_pool_fee ceiling, read from the on-chain `global`');
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
    // The balance refusal above is thrown INSIDE this try. Without the re-throw it
    // was caught here, printed as a failed lookup, and the build went on.
    if (e instanceof OperatorError) throw e;
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
  console.log(`    create-permission --cp-swap-program ${cpSwapId.toBase58()}   (same admin key)`);
  console.log(`    update-global --cp-swap-program ${cpSwapId.toBase58()} --amm-config ${ammConfig.toBase58()}`);
  console.log('  Until then migrate_to_amm fails AmmNotConfigured (6015) or MigrationPermissionMissing (6021).');
}

// ─── create-permission (cp-swap) ────────────────────────────────────────────────

/**
 * cp-swap `create_permission_pda` for tegridy-launch's migration authority.
 *
 * Graduation calls cp-swap's `initialize_with_permission`, which requires an
 * existing `Permission` account at `["permission", payer]`, and the payer there is
 * our program-wide migration authority `["migauth"]`. Only cp-swap's compile-time
 * `admin::ID` can create that account (create_permission_pda.rs, `address =
 * crate::admin::ID`), and it pays the rent (`payer = owner`). Without it, every
 * `migrate_to_amm` fails MigrationPermissionMissing (6021) — after a launch has
 * already filled. One account for the whole program, created once.
 *
 * The same key can also CLOSE it (`close_permission_pda`), which blocks every
 * graduation until it is re-created. That power is part of what admin::ID is.
 */
async function cmdCreatePermission(flags) {
  const connection = connect();
  const cpSwapId = new PublicKey(cpSwapProgramId(flags));
  refuseSpentProgramId(cpSwapId.toBase58(), 'create_permission_pda');
  const cpDeployment = await L.readDeployment(connection, cpSwapId);
  if (cpDeployment.kind === 'unreadable') {
    fail(`could not read the cp-swap program account: ${cpDeployment.detail}\n  Refusing to build blind.`);
  }
  if (cpDeployment.kind !== 'deployed') {
    fail(`no cp-swap program is deployed at ${cpSwapId.toBase58()} (${cpDeployment.kind}).`);
  }

  // The authority is derived from the tegridy-launch id, so a typo'd --program-id
  // would create a permission for an address no program signs as. Read it first.
  const launchPid = programId(flags);
  const launch = await requireDeployed(connection, launchPid, 'create_permission_pda (for its migration authority)');
  if (launch.global?.kind === 'ok' && L.isAmmConfigured(launch.global.value)
      && !launch.global.value.cpSwapProgram.equals(cpSwapId)) {
    fail(
      `global.cp_swap_program is ${launch.global.value.cpSwapProgram.toBase58()}, not ${cpSwapId.toBase58()}.\n` +
        '  A permission on a cp-swap that tegridy-launch does not graduate into unblocks nothing.',
    );
  }
  const migAuth = migrationAuthorityOf(launchPid);
  const existing = await readPermission(connection, cpSwapId, migAuth);
  console.log('[operator] create_permission_pda');
  console.log(`  cp-swap program      : ${cpSwapId.toBase58()}`);
  console.log(`  tegridy-launch       : ${launchPid}`);
  console.log(`  migration authority  : ${migAuth.toBase58()}   seeds ["migauth"] (program-wide)`);
  console.log(`  permission PDA       : ${existing.address.toBase58()}   seeds ["permission", migration authority]`);
  if (existing.kind === 'present') {
    console.log('\n  ✅ it already exists and names this authority. Nothing to do.');
    return;
  }
  if (existing.kind === 'unreadable') fail(`could not read the permission address: ${existing.detail}`);
  if (existing.kind === 'foreign') {
    fail(`something else is at the permission address (${existing.owner}). \`init\` would fail; investigate first.`);
  }

  const payer = await loadKeypair('OPERATOR_KEYPAIR');
  const owner = payer.publicKey;
  console.log(`  owner (signer+payer) : ${owner.toBase58()}`);
  // Same bytecode check as create-amm-config: a key that is not in the binary
  // cannot be admin::ID, and this instruction would fail InvalidOwner.
  const bakedIn = await deployerIsBakedIntoProgram(connection, cpSwapId, owner);
  if (bakedIn === false) {
    fail(
      `this key does NOT appear in the deployed cp-swap bytecode, so it cannot be \`admin::ID\`.\n` +
        `    loaded : ${owner.toBase58()}\n` +
        '  `create_permission_pda` is gated on `address = crate::admin::ID` and would fail InvalidOwner.',
    );
  }
  console.log(bakedIn === true
    ? '  admin::ID            : ✅ this key is present in the deployed cp-swap bytecode'
    : '  admin::ID            : (could not fetch bytecode to check — proceeding, UNVERIFIED)');
  const payerCheck = await classifyPayer(connection, owner);
  if (!payerCheck.ok) fail(`the owner cannot pay for the Permission account: ${payerCheck.reason}`);
  try {
    const rent = BigInt(await connection.getMinimumBalanceForRentExemption(CP_SWAP_PERMISSION_LEN));
    console.log(`  rent for ${CP_SWAP_PERMISSION_LEN} bytes    : ${rent} (${sol(rent)})`);
    if (payerCheck.lamports < rent) {
      fail(`the owner holds ${payerCheck.lamports} lamports (${sol(payerCheck.lamports)}), below the ${rent} needed for rent plus fees.`);
    }
  } catch (e) {
    if (e instanceof OperatorError) throw e;
    console.log(`  rent                 : (lookup failed: ${e?.message ?? e}) — balance NOT checked`);
  }

  const tx = new Transaction().add(
    createPermissionPdaIx({ owner, permissionAuthority: migAuth, permission: existing.address }, cpSwapId),
  );
  await prepareAndSign(connection, tx, owner, flags.send ? payer : undefined);
  if (!flags.send) {
    const sim = await simulate(connection, tx, 'create_permission_pda');
    if (sim.err) fail('the simulation failed — nothing to co-sign. Read the logs above.');
  }
  const sent = await maybeSend(connection, tx, flags);
  await emitTransaction(connection, tx, sent, 'create_permission_pda');
  console.log('\n  ⚠ admin::ID can also CLOSE this account (close_permission_pda). Closing it blocks every');
  console.log('    graduation until it is re-created. `status` re-reads it.');
}

// ─── migrate (permissionless) ───────────────────────────────────────────────────

/**
 * `migrate_to_amm` for one launch. Permissionless: anyone may push a funded curve
 * into its pool, and the payer only fronts rent it gets back.
 *
 * Every precondition the program checks is read first, so a refusal is a sentence
 * here and not a 400k-CU failure. Simulates by default; `--send` broadcasts.
 */
async function cmdMigrate(flags) {
  const pid = programId(flags);
  const pidKey = new PublicKey(pid);
  const connection = connect();
  const status = await requireDeployed(connection, pid, 'migrate_to_amm');
  if (status.global?.kind !== 'ok') fail(`global is "${status.global?.kind}" — nothing can graduate before init-global.`);
  const g = status.global.value;
  const mint = new PublicKey(optionalPubkeyFlag(flags, 'mint') ?? fail('missing required --mint <base58>'));

  if (g.paused) fail('the protocol is PAUSED — migrate_to_amm fails Paused. (Sells stay open.)');
  if (!L.isAmmConfigured(g)) fail('the AMM is not configured — migrate_to_amm fails AmmNotConfigured (6015). Run update-global first.');
  const cpSwapId = g.cpSwapProgram;
  refuseSpentProgramId(cpSwapId.toBase58(), 'migrate_to_amm');

  const cr = await L.readCurve(connection, mint, pidKey);
  if (cr.kind === 'absent') fail(`no curve for ${mint.toBase58()} — this mint was never launched here.`);
  if (cr.kind !== 'ok') fail(`could not read the curve (${cr.kind}: ${cr.detail ?? cr.reason ?? '?'}).`);
  const c = cr.value.curve;
  if (c.complete) fail('this launch has already graduated. If its platform reserve is still held, run release-reserve.');
  // The program's gate is target PLUS reserve (the accounting quantity it debits).
  const need = c.graduationTargetLamports + c.migrationReserveLamports;
  if (c.realSolReserves < need) {
    fail(`not funded: real_sol_reserves ${c.realSolReserves} < target + reserve ${need} (${sol(need)}) — NotReadyToGraduate.`);
  }
  const curveRent = BigInt(await connection.getMinimumBalanceForRentExemption(L.BONDING_CURVE_SIZE));
  if (cr.value.lamports - curveRent < need) {
    fail(`the curve holds ${cr.value.lamports} lamports; after its rent floor ${curveRent} it cannot fund ${need} — MigrationReserveTooLow.`);
  }

  // The permission account is what nothing in `global` records. Read it.
  const migAuth = migrationAuthorityOf(pid);
  const perm = await readPermission(connection, cpSwapId, migAuth);
  if (perm.kind !== 'present') {
    fail(
      `cp-swap's permission account ${perm.address.toBase58()} is ${perm.kind}` +
        `${perm.kind === 'foreign' ? ` (${perm.owner})` : ''}${perm.kind === 'unreadable' ? ` (${perm.detail})` : ''}.\n` +
        '  migrate_to_amm would fail MigrationPermissionMissing (6021). cp-swap\'s admin must run\n' +
        `  create-permission --cp-swap-program ${cpSwapId.toBase58()} first.`,
    );
  }

  // cp-swap's create_pool_fee_reveiver::ID is a compile-time constant no account
  // records, so it is a flag — and it is checked to be what cp-swap will accept.
  const feeAcct = new PublicKey(
    optionalPubkeyFlag(flags, 'create-pool-fee-account') ??
      fail('missing required --create-pool-fee-account <base58> — cp-swap\'s create_pool_fee_reveiver::ID\n  (the non-devnet arm in programs/cp-swap/src/lib.rs), a WSOL token account.'),
  );
  const feeInfo = await connection.getAccountInfo(feeAcct);
  if (!feeInfo || !feeInfo.owner.equals(L.TOKEN_PROGRAM_ID) || feeInfo.data.length !== 165
      || !new PublicKey(feeInfo.data.subarray(0, 32)).equals(L.WSOL_MINT)) {
    fail(`--create-pool-fee-account ${feeAcct.toBase58()} is not a WSOL token account on this cluster; cp-swap would reject the pool.`);
  }

  const payer = await payerFor(flags);
  const payerCheck = await classifyPayer(connection, payer.publicKey);
  if (!payerCheck.ok) fail(`the payer cannot fund rent: ${payerCheck.reason}`);
  // The float, INCLUDING the seed top-up: the program tops the migration authority
  // up to minimum_balance(0) out of the payer's pocket before anything else moves.
  const [ataRent, zeroRent, authLamports, wsolAta, tokenAta, feeRecipientInfo] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(165).then(BigInt),
    connection.getMinimumBalanceForRentExemption(0).then(BigInt),
    connection.getBalance(migAuth).then(BigInt),
    connection.getAccountInfo(L.associatedTokenAddress(L.WSOL_MINT, migAuth)),
    connection.getAccountInfo(L.associatedTokenAddress(mint, migAuth)),
    connection.getAccountInfo(g.feeRecipient),
  ]);
  const float = migratePayerFloat({
    ataRent, zeroDataRent: zeroRent, authorityLamports: authLamports,
    existingAtas: (wsolAta ? 1 : 0) + (tokenAta ? 1 : 0),
  });

  console.log('[operator] migrate_to_amm');
  console.log(`  mint                 : ${mint.toBase58()}`);
  console.log(`  raised               : ${c.realSolReserves} (${sol(c.realSolReserves)}) of target + reserve ${need}`);
  console.log(`  pool gets            : ${c.graduationTargetLamports} lamports + ${c.realTokenReserves} tokens`);
  if (c.platformReserveTokens !== undefined) {
    console.log(`  stays in the vault   : ${c.platformReserveTokens} tokens (platform reserve — release-reserve after this)`);
  }
  console.log(`  migration authority  : ${migAuth.toBase58()} (holds ${authLamports})`);
  console.log(`  payer                : ${payer.publicKey.toBase58()} (holds ${payerCheck.lamports})`);
  console.log(`  payer float          : ${float.total} = ATAs ${float.atas} + seed top-up ${float.seedTopup} (refunded at the end), plus fees`);
  if (payerCheck.lamports < float.total) {
    fail(`the payer holds ${payerCheck.lamports} lamports, below the ${float.total} it must front.`);
  }
  // The unspent reserve is swept to fee_recipient. A credit that leaves an account
  // strictly between 0 and minimum_balance(0) is rejected, so a near-empty
  // recipient plus a small residual would revert the whole graduation.
  const frLamports = BigInt(feeRecipientInfo?.lamports ?? 0);
  if (frLamports < zeroRent) {
    console.log(`  ⚠ fee_recipient holds ${frLamports} lamports, below minimum_balance(0) = ${zeroRent}. A residual`);
    console.log('    smaller than that would leave it in the rejected rent band and revert this. Fund it first.');
  }

  const ix = L.migrateToAmmIx(
    {
      payer: payer.publicKey,
      creator: c.creator,
      feeRecipient: g.feeRecipient,
      launchMint: mint,
      ammConfig: g.ammConfig,
      createPoolFee: feeAcct,
      permission: perm.address,
    },
    { programId: pidKey, cpSwapProgram: cpSwapId },
  );
  // The builder derives the migration authority itself. It must be the one the
  // program checks; a stale per-mint derivation fails the seeds constraint.
  if (!ix.keys.some((k) => k.pubkey.equals(migAuth))) {
    fail('the built migrate_to_amm does not carry the program-wide migration authority — the curve core derives it wrong. Nothing was built.');
  }
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: L.MIGRATE_COMPUTE_UNITS }),
    ix,
  );
  await prepareAndSign(connection, tx, payer.publicKey, flags.send ? payer.keypair : undefined);
  if (!flags.send) {
    await simulate(connection, tx, 'migrate_to_amm', { launchProgramId: pid });
    console.log('\n  Dry run. Add --send (with OPERATOR_KEYPAIR) to broadcast.');
    return;
  }
  await maybeSend(connection, tx, flags);
  console.log('  NEXT: release-reserve --mint ' + mint.toBase58());
}

// ─── release-reserve (permissionless) ───────────────────────────────────────────

/**
 * `release_platform_reserve` for one graduated launch: moves the platform reserve
 * from the curve vault to `global.fee_recipient`'s token account, once.
 *
 * Permissionless, like migrate. The recipient is read from `global` at release
 * time, so it always goes to the treasury as configured NOW. Simulates by default.
 */
async function cmdReleaseReserve(flags) {
  const pid = programId(flags);
  const pidKey = new PublicKey(pid);
  const connection = connect();
  const status = await requireDeployed(connection, pid, 'release_platform_reserve');
  if (status.global?.kind !== 'ok') fail(`global is "${status.global?.kind}".`);
  const g = status.global.value;
  const mint = new PublicKey(optionalPubkeyFlag(flags, 'mint') ?? fail('missing required --mint <base58>'));

  const cr = await L.readCurve(connection, mint, pidKey);
  if (cr.kind === 'absent') fail(`no curve for ${mint.toBase58()} — this mint was never launched here.`);
  if (cr.kind !== 'ok') fail(`could not read the curve (${cr.kind}: ${cr.detail ?? cr.reason ?? '?'}).`);
  const c = cr.value.curve;
  if (c.platformReserveTokens === undefined || c.platformReserveReleased === undefined) {
    fail('the curve core does not decode the platform-reserve fields — it predates them. Nothing was built.');
  }
  if (!c.complete) {
    fail('this launch has not graduated. The reserve is released only after migrate — PlatformReserveLocked (6022).');
  }
  if (c.platformReserveReleased) {
    fail('this launch\'s reserve was already released — PlatformReserveAlreadyReleased (6023).');
  }
  const amount = c.platformReserveTokens;
  const vault = L.curveVaultPda(mint, pidKey);
  const recipientAta = L.associatedTokenAddress(mint, g.feeRecipient);
  const [vaultBal, ataInfo, ataRent] = await Promise.all([
    connection.getTokenAccountBalance(vault).then((r) => BigInt(r.value.amount)),
    connection.getAccountInfo(recipientAta),
    connection.getMinimumBalanceForRentExemption(165).then(BigInt),
  ]);
  if (vaultBal < amount) {
    fail(`the curve vault holds ${vaultBal}, less than the ${amount} reserve. Investigate before sending anything.`);
  }

  const payer = await payerFor(flags);
  const payerCheck = await classifyPayer(connection, payer.publicKey);
  if (!payerCheck.ok) fail(`the payer cannot fund rent: ${payerCheck.reason}`);
  const needs = ataInfo ? 0n : ataRent;

  console.log('[operator] release_platform_reserve');
  console.log(`  mint                 : ${mint.toBase58()}`);
  console.log(`  amount               : ${amount} base units${amount === 0n ? '  (none was carved; this only records the release)' : ''}`);
  console.log(`  recipient            : ${g.feeRecipient.toBase58()}  (global.fee_recipient, read NOW)`);
  console.log(`  recipient token acct : ${recipientAta.toBase58()}${ataInfo ? '' : `  (created by this call, ${ataRent} lamports from the payer)`}`);
  console.log(`  payer                : ${payer.publicKey.toBase58()} (holds ${payerCheck.lamports})`);
  if (payerCheck.lamports < needs) fail(`the payer holds ${payerCheck.lamports} lamports, below the ${needs} ATA rent it must pay.`);

  const ix = L.releasePlatformReserveIx(
    { payer: payer.publicKey, feeRecipient: g.feeRecipient, mint },
    { programId: pidKey },
  );
  // Whatever the builder derived, the tokens must land in the treasury's own ATA.
  if (!ix.keys.some((k) => k.pubkey.equals(recipientAta) && k.isWritable)
      || !ix.keys.some((k) => k.pubkey.equals(g.feeRecipient))) {
    fail('the built release_platform_reserve does not pay global.fee_recipient\'s token account. Nothing was built.');
  }
  const tx = new Transaction().add(ix);
  await prepareAndSign(connection, tx, payer.publicKey, flags.send ? payer.keypair : undefined);
  if (!flags.send) {
    await simulate(connection, tx, 'release_platform_reserve', { launchProgramId: pid });
    console.log('\n  Dry run. Add --send (with OPERATOR_KEYPAIR) to broadcast.');
    return;
  }
  await maybeSend(connection, tx, flags);
}

function printHelp() {
  console.log(`
tegridy-launch operator harness — protocol-level instructions for OUR OWN curve.

⛔ NO PROGRAM TO DRIVE. The rail ran on mainnet from 2026-08-08 until both program ids
were closed on 2026-08-13 — CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED (tegridy-launch)
and 3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y (cp-swap). A closed id is SPENT: nothing
executes there and nothing can be redeployed to it. Every command below refuses both by
name. Graduation never worked at all — cp-swap's AmmConfig was never created, so
\`migrate_to_amm\` failed AmmNotConfigured (6015) for the program's whole life.

A restart begins with fresh program keypairs and new \`declare_id!\` values, then
\`--program-id <new address>\` here. Write commands also read the chain first, but that
read cannot see a closure on its own: a closed program's stub stays executable-flagged.
Trust \`status\`, not this help text.

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
  create-permission  build cp-swap create_permission_pda for our migration authority
                     ["migauth"] (once per program; without it EVERY graduation fails
                     MigrationPermissionMissing, 6021)
  migrate            migrate_to_amm for --mint (permissionless; SIMULATES unless --send)
  release-reserve    release_platform_reserve for --mint (permissionless, after
                     graduation; SIMULATES unless --send)
  help

GLOBAL FLAGS
  --program-id <id>  override the tegridy-launch program id
  --send             broadcast instead of printing (or, for migrate/release-reserve,
                     instead of simulating). OPT-IN. Only completes when the local key
                     is a sufficient signer set — on mainnet global.authority is the
                     Squads VAULT PDA, so the authority pre-check fails closed.

CONFIG FLAGS (init-global / check-config; all values are RAW integers, not decimals)
  --fee-bps <n>          trade fee, <= 1000 (MAX_FEE_BPS)
  --creator-fee-share-bps <n>  REQUIRED, no default. Share OF THE FEE paid to the
                         token's creator, <= 10000. 5000 = 50%, the settled value.
  --platform-reserve-bps <n>  REQUIRED, no default. Share of every launch's SUPPLY held
                         back for the protocol, <= 1000 (10%). 369 = 3.69%. Held in the
                         curve vault, never sold or pooled, released to the treasury
                         only after graduation. check-config prints the split and the
                         scaled --virtual-token that keeps the graduation target.
  --virtual-sol <lamports>
  --virtual-token <base units>
  --supply <base units>
  --target <lamports>    graduation target — EXCLUDES the migration reserve
  --reserve <lamports>   migration reserve, >= 42156720 (MIN_MIGRATION_RESERVE_LAMPORTS)
  --fee-recipient <base58>  must be able to sign (the Squads VAULT, never the multisig
                         account): it owns every released reserve. A program-owned
                         address is refused, here and on update-global.
  --cp-swap-program <base58>   optional at init — zero is the NORMAL case
  --amm-config <base58>        optional at init — zero is the NORMAL case
  --accept-listing-gap   with a reserve, init-global REFUSES a book that lists more than
                         ${LISTING_GAP_TOLERANCE_BPS} bps from the final curve price (the program's own band is
                         ±5%, and an untuned 3.69% reserve lists at +4.88%). This flag
                         signs it anyway. Same gate on update-global, for a
                         --platform-reserve-bps change and for a --target, --reserve
                         or --virtual-sol change on a book that carries a reserve.

UPDATE FLAGS (update-global; pass only what changes)
  --fee-bps --target --reserve --virtual-sol --creator-fee-share-bps
  --platform-reserve-bps       NEW launches only; re-runs the economics check. There is
                               no --virtual-token here: update_global cannot change it.
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
                             (migration_reserve - MIN_MIGRATION_RESERVE), read on-chain.
  --creator-fee-rate <n>     pool-creator cut; distinct from global's creator split
  --cp-swap-program <id>     override the cp-swap program id

  The signer must be cp-swap's compile-time admin::ID AND be System-owned and funded —
  it is \`payer = owner\`. Both are checked before anything is signed. To see which keys
  a deployed binary actually carries:
    node ../scripts/verify-program-constants.mjs --deployed <cp-swap program id>
  That has nothing to read for the 2026-08-08 fork: closing it deleted the ProgramData
  account the bytecode lived in. It answers again only for a new deploy.

CREATE-PERMISSION FLAGS
  --cp-swap-program <id>     the cp-swap program (default: the restart id EKS4C6x…,
                             registered 2026-09-26; no program there yet)
  --program-id <id>          the tegridy-launch program whose ["migauth"] is authorised
  Same signer rule as create-amm-config: admin::ID, System-owned, funded.

MIGRATE / RELEASE-RESERVE FLAGS
  --mint <base58>            the launch
  --create-pool-fee-account <base58>   migrate only: cp-swap's create_pool_fee_reveiver::ID
                             (a WSOL token account; a compile-time constant, so a flag)
  --payer <base58>           simulate as this payer without loading a key (no --send)
  migrate sets a 400,000 compute-unit limit, and its payer fronts two ATA rents plus the
  migration authority's seed top-up to minimum_balance(0); all of it comes back.

ORDERING — the opposite of the obvious guess. NOTHING below is done: both 2026-08
program ids are closed, so every step restarts at 0 on fresh ids.
  0. fresh program keypairs + declare_id!   in SOURCE since 2026-09-26 (tegridy-launch
                                       64WBTe…, cp-swap EKS4C6x…) — no program there yet
  1. deploy under a real keypair
  2. init-global                       AMM addresses MAY be zero; no AmmConfig needed yet
  3. create-amm-config                 cp-swap admin creates the AmmConfig
  4. create-permission                 cp-swap admin authorises our migration authority
  5. update-global --cp-swap-program … --amm-config …
  6. migrate                           per launch, once it is funded
  7. release-reserve                   per launch, after it graduates

  \`initialize_global\` does NOT require an AmmConfig (lib.rs:184-187, 259-263), and
  \`update_global\` CAN set both AMM addresses (lib.rs:360-367). lib.rs:347-355 records
  what happened when it could not: migration was left permanently disabled.

EXAMPLES
  SOLANA_RPC_URL=… node scripts/tegridy-launch-operator.mjs status
  node scripts/tegridy-launch-operator.mjs check-config --fee-bps 100 \\
    --platform-reserve-bps 369 \\
    --virtual-sol 30000000000 --virtual-token 1033406300000000 \\
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
    case 'create-permission':
      return cmdCreatePermission(flags);
    case 'migrate':
      return cmdMigrate(flags);
    case 'release-reserve':
      return cmdReleaseReserve(flags);
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
