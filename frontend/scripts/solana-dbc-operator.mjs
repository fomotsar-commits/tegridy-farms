#!/usr/bin/env node
/**
 * Solana DBC launcher — OPERATOR SIGNING HARNESS.
 *
 * The out-of-band driver for `src/lib/launcher/solana/dbcClient.ts` (the hardened
 * signing wrapper). `dbcClient.ts` is complete but has ZERO callers by design — the
 * gated wizard page imports only the pure builder (`dbc.ts`), never the SDK. This
 * script is the *only* thing that pulls in the real @meteora SDK and actually builds
 * on-chain transactions. It runs OUT OF BAND (never in the browser bundle).
 *
 * ─── SAFETY / DOCTRINE (dbc.ts + squads.ts + README) ───────────────────────────
 *   • Secrets come from ENV/CLI ONLY. NOTHING is hardcoded or committed: the RPC
 *     URL, the payer keypair (loaded from a LOCAL file path), the Squads multisig +
 *     vault index, and the fee/curve params all arrive at runtime. Review this file
 *     before running — it only reads what you pass and builds/prints (or sends) a tx.
 *   • The partner fee authority MUST be a Squads v4 vault, never an EOA. This harness
 *     never takes a raw fee address: it DERIVES the canonical vault PDA from the
 *     multisig + vault index (squads.ts `deriveSquadsVaultPda`) and hands the wrapper
 *     the matching provenance, so the wrapper's on-chain `verifySquadsVault` check has
 *     exactly what it needs. A wrong multisig/index fails closed inside the wrapper.
 *   • DEFAULT is PRINT (partial-signed base64) for out-of-band Squads co-signing.
 *     `--send` is opt-in and only valid where the operator payer alone can complete
 *     the signature set (see the per-command notes below). A `claim` is signed by the
 *     VAULT (a Squads PDA) and therefore can never be `--send` by the operator.
 *
 * ─── GATE (expected throw) ─────────────────────────────────────────────────────
 * `SOLANA_LAUNCHER_ENABLED` is `false` in `dbc.ts`. Every wrapper entry point calls
 * `assertEnabled()` and THROWS immediately. Running this harness today is expected to
 * print a "Solana launcher is gated" error and exit non-zero — that is the gate doing
 * its job, and it proves the whole graph loads and drives the wrapper. Un-gating is a
 * separate, deliberate go-live step (flip the flag in dbc.ts AND configure a real
 * vault); this script deploys nothing and un-gates nothing.
 *
 * ─── WHY A CUSTOM LOADER (the module.register block below) ──────────────────────
 * `dbcClient.ts` and its imports are written for the Vite BUNDLER, so a raw Node
 * runtime trips over three bundler-isms. The inline loader neutralises all three with
 * zero extra dependencies (uses only Node 24's built-ins), so the run command is a
 * plain `node scripts/solana-dbc-operator.mjs …` — no tsx, no build step, no network:
 *   1. Extensionless relative imports (`./dbc`, `../../solana`) → append `.ts`.
 *   2. TypeScript syntax → `module.stripTypeScriptTypes` (files are erasable-only).
 *   3. `import.meta.env` (read by `src/lib/solana.ts` at load) is undefined under
 *      Node → rewritten to an empty-object shim (the operator path needs none of the
 *      VITE_* values), and `@coral-xyz/anchor`'s `BN` (a CJS default-only export under
 *      Node ESM) → rewritten to a default-import destructure.
 *
 * ─── RUN ───────────────────────────────────────────────────────────────────────
 *   Requires Node >= 23.6 (native TS type-strip + module.stripTypeScriptTypes).
 *   This repo is on Node 24. Run from the `frontend/` dir so node_modules resolve:
 *
 *     SOLANA_RPC_URL=https://your-keyed-rpc \
 *     OPERATOR_KEYPAIR=/abs/path/payer.json \
 *     SQUADS_MULTISIG=<multisig-base58> SQUADS_VAULT_INDEX=0 \
 *     node scripts/solana-dbc-operator.mjs create-config \
 *       --initial-market-cap 5000 --migration-market-cap 50000
 *
 *   Commands: create-config | launch | claim | derive-vault | help
 *   Global flags: --send (opt-in broadcast), --quote sol|usdc
 *   See `printHelp()` (or `node scripts/solana-dbc-operator.mjs help`) for the full
 *   per-command flag list, and solana/README.md for the end-to-end operator flow.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

// ─── Self-contained loader: make the bundler-targeted TS graph run under Node ───
//
// Registered as an inline data: URL module so this harness stays a single file. The
// hooks run in a worker; the source rewrites are evaluated back in the main context
// (that's why the import.meta.env shim references `globalThis`, set just below).
globalThis.__TEGRIDY_VITE_ENV__ = {};
const loaderSource = `
import { stripTypeScriptTypes } from 'node:module';

export async function resolve(specifier, context, nextResolve) {
  const relative = specifier[0] === '.';
  const hasExt = /\\.[cm]?[jt]sx?$/.test(specifier);
  if (relative && !hasExt) {
    try {
      return await nextResolve(specifier + '.ts', context);
    } catch {
      // fall through to the default resolver for the extensionless form
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);
  const result = await nextLoad(url, { ...context, format: 'module' });
  let source =
    typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  source = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url });
  // solana.ts reads import.meta.env at load; Node has no such object.
  source = source.replace(/import\\.meta\\.env/g, '(globalThis.__TEGRIDY_VITE_ENV__ || {})');
  // @coral-xyz/anchor exposes BN only on its CJS default under Node ESM.
  source = source.replace(
    /import\\s*\\{([^}]*)\\}\\s*from\\s*(['"]@coral-xyz\\/anchor['"]);?/g,
    "import __anchorNS from $2; const {$1} = __anchorNS;",
  );
  return { format: 'module', source, shortCircuit: true };
}
`;
register('data:text/javascript,' + encodeURIComponent(loaderSource), pathToFileURL('./').href);

// ─── Deferred imports (must come AFTER register so the loader is in the chain) ──
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOLANA_DIR = pathToFileURL(path.join(HERE, '..', 'src', 'lib', 'launcher', 'solana') + path.sep).href;

const web3 = await import('@solana/web3.js');
const { Connection, Keypair } = web3;
const dbc = await import(SOLANA_DIR + 'dbc.ts');
const squads = await import(SOLANA_DIR + 'squads.ts');
const dbcClient = await import(SOLANA_DIR + 'dbcClient.ts');
const meteora = await import('@meteora-ag/dynamic-bonding-curve-sdk');

// ─── Tiny CLI arg parser (flags + positionals; no dependency) ───────────────────
//
// Valueless (boolean) flags MUST be listed here so they never swallow the token that
// follows them. Without this, a boolean flag placed BEFORE the subcommand — e.g.
// `--send create-config …` — would greedily consume `create-config` as its value,
// leaving positional[0] empty so `main` silently falls through to `help`. Listing
// `--send` here makes the first positional (the subcommand) parse correctly no matter
// where the flag sits relative to it.
// SELF-CHECK: `node scripts/solana-dbc-operator.mjs --send derive-vault …` must run
// derive-vault (not help), i.e. parseArgs(['--send','derive-vault']).positional[0]
// === 'derive-vault' and flags.send === true.
const BOOLEAN_FLAGS = new Set(['send']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith('--')) {
        flags[key] = true; // boolean flag — never consumes the next token
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

function fail(msg) {
  console.error(`\n[operator] ERROR: ${msg}\n`);
  process.exit(1);
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

function requireNumberFlag(flags, name) {
  const raw = requireFlag(flags, name);
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${name} must be a finite number, got "${raw}"`);
  return n;
}

function optionalNumberFlag(flags, name, fallback) {
  const raw = flags[name];
  if (raw === undefined || raw === true) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${name} must be a finite number, got "${raw}"`);
  return n;
}

// ─── Keypair loading (mirrors create-fee-atas.mjs: CLI-array or base58 file) ─────
async function loadKeypair(envName) {
  const raw0 = requireEnv(envName);
  const kpPath = raw0.replace(/^~/, os.homedir());
  if (!fs.existsSync(kpPath)) fail(`${envName} keypair file not found: ${kpPath}`);
  const raw = fs.readFileSync(kpPath, 'utf8').trim();
  let secret;
  if (raw.startsWith('[')) {
    // Solana CLI format: JSON array of 64 bytes.
    secret = Uint8Array.from(JSON.parse(raw));
  } else {
    // Phantom "Export Private Key" base58 string saved to a file (never on the CLI).
    const bs58 = (await import('bs58')).default;
    secret = bs58.decode(raw);
  }
  return Keypair.fromSecretKey(secret);
}

// ─── Squads vault: derive the PDA + build the provenance the wrapper verifies ────
function resolveVault() {
  const multisig = requireEnv('SQUADS_MULTISIG');
  const idxRaw = requireEnv('SQUADS_VAULT_INDEX');
  const vaultIndex = Number(idxRaw);
  if (!Number.isInteger(vaultIndex) || vaultIndex < 0 || vaultIndex > 255) {
    fail(`SQUADS_VAULT_INDEX must be a u8 (0..255), got "${idxRaw}"`);
  }
  // Derive the canonical vault PDA so the on-chain address we set ALWAYS matches the
  // provenance the wrapper re-derives — no room for a typo'd address to slip through.
  const address = squads.deriveSquadsVaultPda(multisig, vaultIndex);
  const vault = dbc.asSquadsVault(address); // brand + shape gate
  const provenance = { [address]: { multisig, vaultIndex } };
  return { vault, address, multisig, vaultIndex, provenance };
}

function resolveQuoteMint(flags) {
  const q = (flags.quote ?? 'sol').toString().toLowerCase();
  if (q === 'sol') return dbc.SOL_MINT ?? 'So11111111111111111111111111111111111111112';
  if (q === 'usdc') return dbc.USDC_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  return fail(`--quote must be sol or usdc, got "${q}"`);
}

// A WalletSigner (dbcClient.WalletSigner shape) backed by a local Keypair. Only used
// with --send; in print mode we pass `undefined` so the wrapper returns the tx for
// out-of-band Squads co-signing.
function keypairSigner(kp) {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx) => {
      tx.partialSign(kp);
      return tx;
    },
  };
}

function emitTransaction(tx, sent, connection, label, extra) {
  if (extra) for (const [k, v] of Object.entries(extra)) console.log(`${k}: ${v}`);
  if (sent) return; // caller already sent + logged the signature
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  console.log(`\n── ${label}: partial-signed transaction (base64) ──`);
  console.log('Hand this to the Squads multisig co-signers / import it into a Squads proposal.');
  console.log('NOTE: it carries a recent blockhash and EXPIRES in ~60-90s of the fetch below —');
  console.log('co-sign + submit promptly, or re-run to refresh the blockhash.\n');
  console.log(b64);
}

async function maybeSend(connection, tx, flags, _signerKp) {
  if (!flags.send) return false;
  // The wrapper already partial-signed the ephemeral keypair(s) and (via keypairSigner)
  // the payer. Broadcast the fully-signed tx. This only completes when the operator
  // payer is a sufficient signer set (create-config / launch) — NOT for claims, where
  // the Squads vault is the required signer.
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  console.log(`\n✅ sent. signature: ${sig}`);
  return true;
}

// ─── Commands ───────────────────────────────────────────────────────────────────

async function cmdCreateConfig(flags) {
  const connection = new Connection(requireEnv('SOLANA_RPC_URL'), 'confirmed');
  const client = meteora.DynamicBondingCurveClient.create(connection, 'confirmed');
  const payer = await loadKeypair('OPERATOR_KEYPAIR');
  const { vault, address, multisig, vaultIndex, provenance } = resolveVault();
  const quoteMint = resolveQuoteMint(flags);

  // The config-key account is a fresh keypair that must sign createConfig once. The
  // wrapper partial-signs it, so the emitted tx already carries its signature; only
  // its PUBLIC key matters afterwards (record it for `launch`).
  const configKp = Keypair.generate();

  const partnerConfig = dbc.buildDbcPartnerConfig({
    feeClaimer: vault,
    config: configKp.publicKey.toBase58(),
    payer: payer.publicKey.toBase58(),
    quoteMint,
    initialMarketCap: requireNumberFlag(flags, 'initial-market-cap'),
    migrationMarketCap: requireNumberFlag(flags, 'migration-market-cap'),
    creatorTradingFeePercentage: optionalNumberFlag(flags, 'creator-fee-pct', undefined),
    totalTokenSupply: optionalNumberFlag(flags, 'total-supply', undefined),
    tokenBaseDecimal: optionalNumberFlag(flags, 'base-decimals', undefined),
    leftover: optionalNumberFlag(flags, 'leftover', undefined),
  });

  console.log('[operator] createConfig');
  console.log(`  multisig      : ${multisig}`);
  console.log(`  vaultIndex    : ${vaultIndex}`);
  console.log(`  vault (PDA)   : ${address}`);
  console.log(`  quoteMint     : ${quoteMint}`);
  console.log(`  feeSplit(bps) : meteora=${partnerConfig.feeSplit.meteoraBps} partner=${partnerConfig.feeSplit.partnerBps} creator=${partnerConfig.feeSplit.creatorBps}`);

  const signer = flags.send ? keypairSigner(payer) : undefined;
  const tx = await dbcClient.createPartnerConfig(client, partnerConfig, signer, configKp, provenance);

  const sent = await maybeSend(connection, tx, flags, payer);
  emitTransaction(tx, sent, connection, 'createConfig', {
    'CONFIG ADDRESS (use for launch)': configKp.publicKey.toBase58(),
  });
}

async function cmdLaunch(flags) {
  const connection = new Connection(requireEnv('SOLANA_RPC_URL'), 'confirmed');
  const client = meteora.DynamicBondingCurveClient.create(connection, 'confirmed');
  const payer = await loadKeypair('OPERATOR_KEYPAIR');

  const config = requireFlag(flags, 'config');
  const poolCreator = (flags['pool-creator'] && flags['pool-creator'] !== true)
    ? String(flags['pool-creator'])
    : payer.publicKey.toBase58();

  // Fresh base-mint keypair for the launched token; the wrapper partial-signs it.
  const baseMintKp = Keypair.generate();

  const launchParams = dbc.buildLaunchParams(
    {
      config,
      baseMint: baseMintKp.publicKey.toBase58(),
      poolCreator,
      payer: payer.publicKey.toBase58(),
    },
    {
      name: requireFlag(flags, 'name'),
      symbol: requireFlag(flags, 'symbol'),
      uri: requireFlag(flags, 'uri'),
    },
  );

  console.log('[operator] launch');
  console.log(`  config      : ${config}`);
  console.log(`  baseMint    : ${baseMintKp.publicKey.toBase58()}`);
  console.log(`  poolCreator : ${poolCreator}`);

  const signer = flags.send ? keypairSigner(payer) : undefined;
  const tx = await dbcClient.launchToken(client, launchParams, signer, baseMintKp);

  const sent = await maybeSend(connection, tx, flags, payer);
  emitTransaction(tx, sent, connection, 'launch', {
    'BASE MINT ADDRESS': baseMintKp.publicKey.toBase58(),
  });
}

async function cmdClaim(flags) {
  if (flags.send) {
    fail(
      '`claim` cannot be --send: the feeClaimer is the Squads VAULT PDA, which signs via a ' +
        'Squads proposal (invoke_signed), not a local key. Omit --send and co-sign the printed tx in Squads.',
    );
  }
  const connection = new Connection(requireEnv('SOLANA_RPC_URL'), 'confirmed');
  const client = meteora.DynamicBondingCurveClient.create(connection, 'confirmed');
  const payer = await loadKeypair('OPERATOR_KEYPAIR');
  const { vault, address, provenance } = resolveVault();

  const claimParams = dbc.claimPartnerFeesParams({
    feeClaimer: vault,
    receiver: vault, // fees land back in the same vault; never an EOA
    pool: requireFlag(flags, 'pool'),
    payer: payer.publicKey.toBase58(),
  });

  console.log('[operator] claim');
  console.log(`  pool          : ${claimParams.pool}`);
  console.log(`  feeClaimer    : ${address} (vault)`);
  console.log(`  receiver      : ${address} (vault)`);

  // signer=undefined → wrapper returns the unsent tx (the vault co-signs in Squads).
  const tx = await dbcClient.claimPartnerFees(client, claimParams, undefined, provenance);
  emitTransaction(tx, false, connection, 'claimPartnerFees', undefined);
}

function cmdDeriveVault() {
  // Pure helper (no RPC, no gate): print the vault PDA for a multisig + index so the
  // operator can fund it / configure it before go-live. Safe to run any time.
  const { address, multisig, vaultIndex } = resolveVault();
  console.log('[operator] derive-vault (pure — no RPC, no launch)');
  console.log(`  multisig   : ${multisig}`);
  console.log(`  vaultIndex : ${vaultIndex}`);
  console.log(`  vault PDA  : ${address}`);
  console.log(`  program id : ${squads.SQUADS_V4_PROGRAM_ID}`);
  console.log('');
  console.log('  ⚠️  THRESHOLD IS NOT VERIFIED HERE. The on-chain verifySquadsVault check');
  console.log('      proves owner + PDA binding ONLY — it does NOT check the multisig');
  console.log('      threshold or member set. A 1-of-1 Squads multisig (threshold=1) is a');
  console.log('      single-key drain of ALL Solana fees and would still pass every gate.');
  console.log('      HARD go-live requirement — verify with Squads tooling BEFORE using this');
  console.log('      address as feeClaimer:');
  console.log(`        • the account at ${multisig} is a Squads MULTISIG`);
  console.log('          (not a Proposal / VaultTransaction / other Squads account type), and');
  console.log('        • its threshold >= 2 over >= 2 distinct members.');
}

function printHelp() {
  console.log(`
Solana DBC launcher — operator signing harness

USAGE (run from frontend/):
  node scripts/solana-dbc-operator.mjs <command> [flags]

COMMANDS
  create-config   Build the reusable DBC partner config key (once per fee policy).
  launch          Launch a token against an existing config key.
  claim           Build the partner trading-fee claim (to the vault; print-only).
  derive-vault    Print the Squads v4 vault PDA for a multisig + index (pure).
  help            This message.

ENV (secrets — CLI/ENV only, never committed)
  SOLANA_RPC_URL        RPC endpoint (keyed URL recommended).            [create-config|launch|claim]
  OPERATOR_KEYPAIR      Path to the payer keypair (CLI-array or base58). [create-config|launch|claim]
  SQUADS_MULTISIG       Squads v4 multisig (config account) base58.      [create-config|claim|derive-vault]
  SQUADS_VAULT_INDEX    Vault index under that multisig (u8 0..255).     [create-config|claim|derive-vault]

GLOBAL FLAGS
  --send                Broadcast instead of printing (create-config/launch only).
  --quote sol|usdc      Quote mint (default sol).

create-config FLAGS
  --initial-market-cap <n>     (required) launch market cap, quote units.
  --migration-market-cap <n>   (required) graduation market cap, quote units.
  --creator-fee-pct <n>        creator's % of the non-protocol 80% (default 60).
  --total-supply <n>           total base supply (default 1e9).
  --base-decimals <6|7|8|9>    base-token decimals (default 6).
  --leftover <n>               undistributed base tokens (default 0).

launch FLAGS
  --config <base58>            (required) config key from create-config.
  --name <str> --symbol <str> --uri <str>   (required) token metadata.
  --pool-creator <base58>      pool creator (default = payer).

claim FLAGS
  --pool <base58>              (required) DBC pool to claim from.

NOTE: while SOLANA_LAUNCHER_ENABLED=false in dbc.ts, create-config/launch/claim THROW
at the wrapper's gate — expected. derive-vault + help run regardless.
`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] ?? 'help';
  switch (cmd) {
    case 'create-config':
      return cmdCreateConfig(flags);
    case 'launch':
      return cmdLaunch(flags);
    case 'claim':
      return cmdClaim(flags);
    case 'derive-vault':
      return cmdDeriveVault();
    case 'help':
    case '--help':
    case '-h':
      return printHelp();
    default:
      console.error(`[operator] unknown command "${cmd}"`);
      printHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  // The gate throw (SOLANA_LAUNCHER_ENABLED=false) lands here — expected today.
  console.error(`\n[operator] ${e?.message ?? e}\n`);
  process.exit(1);
});
