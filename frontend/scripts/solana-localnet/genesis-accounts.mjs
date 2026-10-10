#!/usr/bin/env node
// Genesis accounts for the /curve-launch browser e2e (playwright.solana.config.ts).
//
// WHAT THIS DOES. The local validator runs the EXACT mainnet binaries at their mainnet
// ids (start-validator.sh). Those binaries only accept `initialize_global` from the
// hard-coded deployer key, and cp-swap only accepts `create_amm_config` /
// `create_permission_pda` from its admin (the Squads vault). The e2e must need NO
// mainnet key, so instead of running those three instructions we write the accounts
// they would have written, byte for byte, and load them at genesis with `--account`.
//
// WHY THE BYTES CAN BE TRUSTED. An encoder checked only by our own decoder proves
// nothing: a shared bug agrees with itself. So before anything is written, the encoder
// is run on the field values the 2026-09-26 local rehearsal passed to the REAL
// instructions (rh.mjs, run 230: init_global, then update_global to the 75-SOL book and
// the vault as authority), and its output must equal, byte for byte, the accounts that
// rehearsal's ledger holds. Those dumps are in ./golden/*.rehearsal.json (read back from
// the rehearsal ledger with `solana account --output json-compact`). A layout,
// discriminator, bump or field-order mistake fails there and nothing is seeded.
//
// ./golden/vault.mainnet.json and ./golden/fee-ata.mainnet.json are read-only
// `getAccountInfo` dumps of the Squads vault GRMtSx… and its WSOL account 2sa31zce…
// (the cp-swap binary's create-pool-fee receiver) taken from mainnet by the rehearsal's
// standin.cjs. They are loaded as they are: the real balance, the real owner.
//
// ./golden/bayla-mint.mainnet.json is the same kind of read of the $BAYLA mint 7hmVkPX…pump
// (Token-2022, 408 B, read 2026-10-02 at slot 452541742). The stand-in seeded from it
// differs in ONE field: mainnet's mint authority is null, the stand-in's is a test key the
// harness holds (baylaMintAuthority), so the e2e can give makers $BAYLA for the plant.
//
// ./golden/usdc-mint.mainnet.json is the same kind of read of the USDC mint EPjFWdd5…Dt1v
// (classic token program, 82 B, 6 decimals, read 2026-10-03 at slot 453074668). Pools may
// pair a token with USDC, so the LP e2e needs USDC on the chain. The stand-in differs in
// ONE field: mainnet's mint authority is Circle's, the stand-in's is a test key the harness
// holds (usdcMintAuthority), so the e2e can give wallets USDC. Its freeze authority stays
// mainnet's: the token check says USDC's issuer can freeze, and nothing here can.
//
// The e2e GlobalConfig is the 1-SOL book the rehearsal initialised on the same binary
// (run 3111 step c, and run 230): 1% fee split 50/50, 3.69% platform reserve, target
// 1 SOL + 0.05 SOL migration reserve. The program itself accepted exactly these values
// through `initialize_global`, which runs its economics check; they differ from the
// mainnet book only in the virtual SOL and the target (a small target keeps the e2e fast).
//
// Usage (Node on Windows, from frontend/):
//   node scripts/solana-localnet/genesis-accounts.mjs [--out <dir>]
// Writes one `--account` JSON per account plus manifest.json into <dir>
// (default scripts/solana-localnet/.accounts, gitignored). Exit 1 on any mismatch.
//
// Needs the release artifacts (the .so files are not in the repo):
//   TEGRIDY_RELEASE_ARTIFACTS (default C:/Users/jimbo/solana-launch-release-2026-09-26/artifacts)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.join(HERE, 'golden');
export const DEFAULT_OUT_DIR = path.join(HERE, '.accounts');

export const LAUNCH_PROGRAM = new PublicKey('64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2');
export const CP_SWAP_PROGRAM = new PublicKey('EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT');
/** The Squads vault: fee recipient, AmmConfig protocol/fund owner. */
export const VAULT = new PublicKey('GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd');
/** The vault's WSOL account; the cp-swap binary's create_pool_fee receiver. */
export const FEE_ATA = new PublicKey('2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa');
/** `deployer::ID` in the tegridy-launch binary. Only its PUBLIC key is used here. */
export const DEPLOYER = new PublicKey('CqcVvaMvesrSKrUSbqBqr9mLjKLJuYqhaXg1gXpR41cg');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
/** $BAYLA, at its real address. The plant (island ruling 2) burns and moves it. */
export const BAYLA_MINT = new PublicKey('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');

/** USDC, at its real address: a coin a pool may pair a token with. */
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/**
 * The stand-in USDC mint's authority: a TEST key from a fixed phrase, like $BAYLA's. It can
 * mint only on a local validator: on mainnet the USDC mint authority is Circle's.
 */
export function usdcMintAuthority() {
  return Keypair.fromSeed(crypto.createHash('sha256').update('tegridy e2e: local stand-in USDC mint authority').digest());
}

/**
 * The stand-in $BAYLA mint's authority: a TEST key, derived from a fixed phrase so every
 * genesis is the same and no key file exists. It can mint only on a local validator: on
 * mainnet the $BAYLA mint authority is null, so this key controls nothing there.
 */
export function baylaMintAuthority() {
  return Keypair.fromSeed(crypto.createHash('sha256').update('tegridy e2e: local stand-in $BAYLA mint authority').digest());
}

/** artifacts/SHA256SUMS of the 2026-09-26 release, pinned here so a swapped file cannot pass. */
export const PINNED_SHA256 = Object.freeze({
  'cp_swap.mainnet.so': '88b98aa91559824c682f6e6c31906abf222d189ce7a45f16af117368b33db882',
  'tegridy_launch.mainnet.so': 'a3c41afaf9dce3ee5dd5d30061c09d8dfb0bf581ba8f39e1d24524dbb43d3f4d',
  'raydium_cp_swap.idl.json': '939bc040fa0f65b6639f07545be9d23fde0492e9b5fc3d90229a313b0fcf0262',
  'tegridy_launch.idl.json': 'cd9e173c666940f82222a2798dc1c5bc0cf30edf7b32450530e65aa523a3cb31',
});

/**
 * The COMMITTED pool IDL (solana/tegridy-amm/idl/raydium_cp_swap.json). It is one instruction
 * ahead of the release: the source has `create_lp_metadata` (it names a pool's share token),
 * and the binary on mainnet does not until the owner upgrades it. The release's own copy keeps
 * its pin above; src/lib/launcher/solana/write/idl.test.ts holds that this file with the one
 * instruction taken out is that copy, byte for byte.
 */
export const PINNED_REPO_CPSWAP_IDL_SHA256 = '1e8fd7928c0fce6788b880703a1cbfc932e808ab5acadfd5217eb637d739f736';

export function defaultArtifactsDir() {
  return process.env.TEGRIDY_RELEASE_ARTIFACTS || 'C:/Users/jimbo/solana-launch-release-2026-09-26/artifacts';
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Refuse unless every pinned release file in `dir` hashes to its pin AND SHA256SUMS
 * itself lists the same hashes. start-validator.sh repeats this for the .so files in WSL.
 */
export function verifyReleaseArtifacts(dir = defaultArtifactsDir()) {
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8');
  for (const [file, pin] of Object.entries(PINNED_SHA256)) {
    const listed = new RegExp(`^${pin}\\s+\\*?${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(sums);
    if (!listed) throw new Error(`SHA256SUMS in ${dir} does not list ${file} as ${pin}`);
    const actual = sha256(fs.readFileSync(path.join(dir, file)));
    if (actual !== pin) throw new Error(`${file} hashes to ${actual}, pinned ${pin}: refusing`);
  }
}

/** Where the IDLs may live: the repo copy (if set T has committed it), else the release. */
export function idlCandidates(artifactsDir = defaultArtifactsDir()) {
  const repoIdl = path.join(HERE, '..', '..', '..', 'solana', 'tegridy-amm', 'idl');
  return {
    launch: [path.join(repoIdl, 'tegridy_launch.json'), path.join(artifactsDir, 'tegridy_launch.idl.json')],
    cp: [path.join(repoIdl, 'raydium_cp_swap.json'), path.join(artifactsDir, 'raydium_cp_swap.idl.json')],
  };
}

/**
 * The two IDLs, from the first location that exists, each refused unless it hashes to
 * the pin for THAT location (the repo's pool IDL and the release's differ by one
 * instruction, see PINNED_REPO_CPSWAP_IDL_SHA256). Returns null when neither location has
 * them (a machine without the release and before the IDLs are committed); every caller
 * must treat that as "cannot check", never as a pass.
 */
export function loadVerifiedIdls(artifactsDir = defaultArtifactsDir()) {
  const c = idlCandidates(artifactsDir);
  const pick = (list, pins) => {
    const at = list.findIndex((f) => fs.existsSync(f));
    if (at < 0) return null;
    const file = list[at];
    const pin = pins[at];
    const raw = fs.readFileSync(file);
    const actual = sha256(raw);
    if (actual !== pin) throw new Error(`${file} hashes to ${actual}, pinned ${pin}: refusing`);
    return { file, idl: JSON.parse(raw.toString('utf8')) };
  };
  const l = pick(c.launch, [PINNED_SHA256['tegridy_launch.idl.json'], PINNED_SHA256['tegridy_launch.idl.json']]);
  const p = pick(c.cp, [PINNED_REPO_CPSWAP_IDL_SHA256, PINNED_SHA256['raydium_cp_swap.idl.json']]);
  if (!l || !p) return null;
  if (l.idl.address !== LAUNCH_PROGRAM.toBase58()) throw new Error(`launch IDL address ${l.idl.address}`);
  if (p.idl.address !== CP_SWAP_PROGRAM.toBase58()) throw new Error(`cp-swap IDL address ${p.idl.address}`);
  return { launchIdl: l.idl, cpIdl: p.idl, files: [l.file, p.file] };
}

/** For the CLI: the release must be present (the validator needs its .so files anyway). */
export function loadVerifiedArtifacts(dir = defaultArtifactsDir()) {
  verifyReleaseArtifacts(dir);
  const idls = loadVerifiedIdls(dir);
  if (!idls) throw new Error(`no IDLs found at ${JSON.stringify(idlCandidates(dir))}`);
  return { ...idls, dir };
}

// ── IDL-driven Borsh encoder ─────────────────────────────────────────────────
// Deliberately NOT the frontend's GLOBAL_CONFIG_LAYOUT: this reads the field list and
// the discriminator from the IDL the binary was built with, so it cannot share a
// layout mistake with the code under test.

function encodeField(type, value, where) {
  if (type === 'pubkey') {
    const k = value instanceof PublicKey ? value : new PublicKey(value);
    return k.toBuffer();
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new Error(`${where}: bool expected`);
    return Buffer.from([value ? 1 : 0]);
  }
  const ints = { u8: 1, u16: 2, u32: 4, u64: 8 };
  if (typeof type === 'string' && ints[type]) {
    const n = BigInt(value);
    const bytes = ints[type];
    if (n < 0n || n >= 1n << BigInt(bytes * 8)) throw new Error(`${where}: ${value} out of ${type} range`);
    const b = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
    return b;
  }
  if (type && typeof type === 'object' && Array.isArray(type.array)) {
    const [inner, len] = type.array;
    const arr = value ?? new Array(len).fill(inner === 'bool' ? false : 0n);
    if (!Array.isArray(arr) || arr.length !== len) throw new Error(`${where}: array of ${len} expected`);
    return Buffer.concat(arr.map((v, i) => encodeField(inner, v, `${where}[${i}]`)));
  }
  throw new Error(`${where}: IDL type ${JSON.stringify(type)} is not supported by this encoder`);
}

/**
 * Encode an Anchor account from its IDL definition: discriminator, then every field
 * in IDL order. Every non-padding field must be given; unknown keys are refused.
 */
export function encodeIdlAccount(idl, name, values) {
  const acct = idl.accounts.find((a) => a.name === name);
  const type = idl.types.find((t) => t.name === name);
  if (!acct || !type) throw new Error(`${name} is not an account in the ${idl.address} IDL`);
  const fields = type.type.fields;
  const known = new Set(fields.map((f) => f.name));
  for (const k of Object.keys(values)) if (!known.has(k)) throw new Error(`${name}: unknown field ${k}`);
  const parts = [Buffer.from(acct.discriminator)];
  for (const f of fields) {
    const has = Object.prototype.hasOwnProperty.call(values, f.name);
    if (!has && !/^padding\d*$/.test(f.name)) throw new Error(`${name}: field ${f.name} not given`);
    parts.push(encodeField(f.type, values[f.name], `${name}.${f.name}`));
  }
  return Buffer.concat(parts);
}

/** The default rent: (len + 128) * 3480 lamports/byte-year * 2 years. */
export function rentExempt(len) {
  return (len + 128) * 3480 * 2;
}

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program);

export function derived() {
  const [global, globalBump] = pda([Buffer.from('global')], LAUNCH_PROGRAM);
  const [migAuth] = pda([Buffer.from('migauth')], LAUNCH_PROGRAM);
  const [ammConfig, ammBump] = pda([Buffer.from('amm_config'), Buffer.from([0, 0])], CP_SWAP_PROGRAM);
  // Index 1 is BIG-endian u16 in the seed, like index 0: [0, 1].
  const [ammConfig1, ammBump1] = pda([Buffer.from('amm_config'), Buffer.from([0, 1])], CP_SWAP_PROGRAM);
  const [permission] = pda([Buffer.from('permission'), migAuth.toBuffer()], CP_SWAP_PROGRAM);
  return { global, globalBump, migAuth, ammConfig, ammBump, ammConfig1, ammBump1, permission };
}

// ── the values ───────────────────────────────────────────────────────────────

/** What the rehearsal ledger's GlobalConfig holds (run 230, after all its steps). */
export function rehearsalGlobalValues() {
  const d = derived();
  return {
    authority: VAULT, // handed to the vault in step (k)
    fee_recipient: VAULT,
    trade_fee_bps: 100n,
    creator_fee_share_bps: 5000n,
    initial_virtual_sol: 192_370_500_177n, // step (j): the 75-SOL book
    initial_virtual_token: 1_033_406_300_000_000n,
    token_total_supply: 1_000_000_000_000_000n,
    graduation_target_lamports: 74_999_999_999n, // step (j): its continuity target
    migration_reserve_lamports: 50_000_000n,
    cp_swap_program: CP_SWAP_PROGRAM,
    amm_config: d.ammConfig,
    paused: false,
    bump: d.globalBump,
    platform_reserve_bps: 369n,
  };
}

/** The e2e GlobalConfig: the 1-SOL book as `initialize_global` wrote it (step c). */
export function e2eGlobalValues() {
  return {
    ...rehearsalGlobalValues(),
    authority: DEPLOYER,
    initial_virtual_sol: 2_603_952_621n,
    graduation_target_lamports: 1_000_000_000n,
  };
}

/** AmmConfig index 0: 0.25% trade fee, 12% of it protocol, no fund/creator fee, free pool creation. */
export function ammConfigValues() {
  const d = derived();
  return {
    bump: d.ammBump,
    disable_create_pool: false,
    index: 0,
    trade_fee_rate: 2500n,
    protocol_fee_rate: 120_000n,
    fund_fee_rate: 0n,
    create_pool_fee: 0n,
    protocol_owner: VAULT,
    fund_owner: VAULT,
    creator_fee_rate: 0n,
  };
}

/**
 * AmmConfig index 1, the PUBLIC fee tier the owner decided on 2026-09-29: 1% trade fee,
 * 16% of it to the venue, no fund or creator fee, 0.15 SOL to open a pool (paid into the
 * vault's WSOL account 2sa31zce, which the binary fixes). The vault created it on mainnet
 * on 2026-10-01 (CapqvAA9…). The binary accepts create_amm_config only from the vault
 * GRMtSx…, whose key does not exist locally, so the account is written here, with the
 * same encoder the golden check proves against the rehearsal ledger, and its bytes must
 * equal mainnet's own (golden/amm-config-1.mainnet.json, mainnetConfigMismatches).
 * The site must still READ it: it never assumes the tier exists.
 */
export function ammConfig1Values() {
  const d = derived();
  return {
    ...ammConfigValues(),
    bump: d.ammBump1,
    index: 1,
    trade_fee_rate: 10_000n,
    protocol_fee_rate: 160_000n,
    fund_fee_rate: 0n,
    create_pool_fee: 150_000_000n,
    creator_fee_rate: 0n,
  };
}

/**
 * AmmConfig index 0 AS MAINNET HOLDS IT since the vault's fee proposals executed
 * (2026-10-01 ~06:09Z, chain-verified): the same tier with 20% of the trade fee to the
 * venue (was 12%) and a 0.05% creator fee. The rehearsal ledger (ammConfigValues) still
 * proves the encoder; this is what the e2e validator is seeded with.
 */
export function e2eAmmConfigValues() {
  return { ...ammConfigValues(), protocol_fee_rate: 200_000n, creator_fee_rate: 500n };
}

/**
 * The seeded fee tiers against MAINNET's own bytes (golden/amm-config-*.mainnet.json,
 * read with getAccountInfo from api.mainnet-beta.solana.com). The data must be identical
 * byte for byte; lamports and rent epoch are the local cluster's own. Returns problems.
 */
export function mainnetConfigMismatches({ cpIdl }) {
  const d = derived();
  const cases = [
    ['amm-config-1.mainnet.json', d.ammConfig1, ammConfig1Values()],
    ['amm-config-0.mainnet.json', d.ammConfig, e2eAmmConfigValues()],
  ];
  const problems = [];
  for (const [file, address, values] of cases) {
    const g = readGolden(file);
    const gBytes = Buffer.from(g.account.data[0], 'base64');
    const bytes = encodeIdlAccount(cpIdl, 'AmmConfig', values);
    if (g.pubkey !== address.toBase58()) problems.push(`${file}: golden is ${g.pubkey}, derived ${address.toBase58()}`);
    if (g.account.owner !== CP_SWAP_PROGRAM.toBase58()) problems.push(`${file}: golden owner ${g.account.owner}`);
    if (!gBytes.equals(bytes)) {
      const at = [...bytes].findIndex((b, i) => b !== gBytes[i]);
      problems.push(`${file}: the seeded bytes differ from mainnet's at byte ${at === -1 ? Math.min(bytes.length, gBytes.length) : at}`);
    }
  }
  return problems;
}

/** cp-swap Permission for the launch program's ["migauth"] PDA. */
export function permissionValues() {
  return { authority: derived().migAuth };
}

function accountJson(pubkey, owner, data, lamports = rentExempt(data.length)) {
  return {
    pubkey: pubkey.toBase58(),
    account: {
      lamports,
      data: [data.toString('base64'), 'base64'],
      owner: owner.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
}

export function readGolden(file) {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8'));
}

/**
 * The byte-for-byte check against the rehearsal ledger. Returns a list of problems;
 * empty means the encoder reproduces what the real instructions wrote.
 */
export function goldenMismatches({ launchIdl, cpIdl }) {
  const d = derived();
  const cases = [
    ['global.rehearsal.json', d.global, LAUNCH_PROGRAM, encodeIdlAccount(launchIdl, 'GlobalConfig', rehearsalGlobalValues())],
    ['amm-config.rehearsal.json', d.ammConfig, CP_SWAP_PROGRAM, encodeIdlAccount(cpIdl, 'AmmConfig', ammConfigValues())],
    ['permission.rehearsal.json', d.permission, CP_SWAP_PROGRAM, encodeIdlAccount(cpIdl, 'Permission', permissionValues())],
  ];
  const problems = [];
  for (const [file, address, owner, bytes] of cases) {
    const g = readGolden(file);
    const gBytes = Buffer.from(g.account.data[0], 'base64');
    if (g.pubkey !== address.toBase58()) problems.push(`${file}: golden is ${g.pubkey}, derived ${address.toBase58()}`);
    if (g.account.owner !== owner.toBase58()) problems.push(`${file}: golden owner ${g.account.owner}`);
    if (g.account.lamports !== rentExempt(gBytes.length)) problems.push(`${file}: golden lamports ${g.account.lamports} != rent ${rentExempt(gBytes.length)}`);
    if (!gBytes.equals(bytes)) {
      const at = [...bytes].findIndex((b, i) => b !== gBytes[i]);
      problems.push(`${file}: encoder output (${bytes.length} B) differs from the rehearsal ledger (${gBytes.length} B) at byte ${at === -1 ? Math.min(bytes.length, gBytes.length) : at}`);
    }
  }
  return problems;
}

/** Where a mint's authority lives: COption<Pubkey> = u32 tag (1 = some) + 32 bytes. */
export const MINT_AUTHORITY_BYTES = [0, 36];

/**
 * The stand-in $BAYLA mint: mainnet's bytes, lamports and owner, with ONLY the mint
 * authority changed from null to baylaMintAuthority(). Refuses a dump that is not the
 * $BAYLA mint as mainnet holds it (Token-2022, 6 decimals, no mint or freeze authority).
 */
export function baylaMintStandIn(golden = readGolden('bayla-mint.mainnet.json')) {
  const d = Buffer.from(golden.account.data[0], 'base64');
  if (golden.pubkey !== BAYLA_MINT.toBase58() || golden.account.owner !== TOKEN_2022_PROGRAM.toBase58()
    || d.length <= 165 || d[165] !== 1 || d[44] !== 6 || d[45] !== 1 || d.readUInt32LE(0) !== 0 || d.readUInt32LE(46) !== 0) {
    throw new Error('bayla-mint.mainnet.json is not the $BAYLA Token-2022 mint as mainnet holds it');
  }
  const out = Buffer.from(d);
  out.writeUInt32LE(1, 0);
  baylaMintAuthority().publicKey.toBuffer().copy(out, 4);
  return { pubkey: golden.pubkey, account: { ...golden.account, data: [out.toString('base64'), 'base64'], rentEpoch: 0 } };
}

/**
 * The stand-in USDC mint: mainnet's bytes, lamports and owner, with ONLY the mint authority
 * changed from Circle's to usdcMintAuthority(). Refuses a dump that is not the USDC mint as
 * mainnet holds it (classic token program, 82 bytes, 6 decimals, a mint authority and a
 * freeze authority both set).
 */
export function usdcMintStandIn(golden = readGolden('usdc-mint.mainnet.json')) {
  const d = Buffer.from(golden.account.data[0], 'base64');
  if (golden.pubkey !== USDC_MINT.toBase58() || golden.account.owner !== TOKEN_PROGRAM.toBase58()
    || d.length !== 82 || d[44] !== 6 || d[45] !== 1 || d.readUInt32LE(0) !== 1 || d.readUInt32LE(46) !== 1) {
    throw new Error('usdc-mint.mainnet.json is not the USDC mint as mainnet holds it');
  }
  const out = Buffer.from(d);
  usdcMintAuthority().publicKey.toBuffer().copy(out, 4);
  return { pubkey: golden.pubkey, account: { ...golden.account, data: [out.toString('base64'), 'base64'], rentEpoch: 0 } };
}

/** Everything the validator is started with, besides the programs. */
export function buildGenesisAccounts({ launchIdl, cpIdl }) {
  const d = derived();
  const vault = readGolden('vault.mainnet.json');
  const feeAta = readGolden('fee-ata.mainnet.json');
  if (vault.pubkey !== VAULT.toBase58() || vault.account.owner !== SYSTEM_PROGRAM.toBase58() || vault.account.data[0] !== '') {
    throw new Error('vault.mainnet.json is not the system-owned vault GRMtSx…');
  }
  const fa = Buffer.from(feeAta.account.data[0], 'base64');
  if (feeAta.pubkey !== FEE_ATA.toBase58() || feeAta.account.owner !== TOKEN_PROGRAM.toBase58() || fa.length !== 165
    || !new PublicKey(fa.subarray(0, 32)).equals(WSOL_MINT) || !new PublicKey(fa.subarray(32, 64)).equals(VAULT)) {
    throw new Error('fee-ata.mainnet.json is not the vault\'s WSOL token account 2sa31zce…');
  }
  return [
    { file: 'global.json', json: accountJson(d.global, LAUNCH_PROGRAM, encodeIdlAccount(launchIdl, 'GlobalConfig', e2eGlobalValues())) },
    { file: 'amm-config.json', json: accountJson(d.ammConfig, CP_SWAP_PROGRAM, encodeIdlAccount(cpIdl, 'AmmConfig', e2eAmmConfigValues())) },
    { file: 'amm-config-1.json', json: accountJson(d.ammConfig1, CP_SWAP_PROGRAM, encodeIdlAccount(cpIdl, 'AmmConfig', ammConfig1Values())) },
    { file: 'permission.json', json: accountJson(d.permission, CP_SWAP_PROGRAM, encodeIdlAccount(cpIdl, 'Permission', permissionValues())) },
    { file: 'vault.json', json: { pubkey: vault.pubkey, account: { ...vault.account, rentEpoch: 0 } } },
    { file: 'fee-ata.json', json: { pubkey: feeAta.pubkey, account: { ...feeAta.account, rentEpoch: 0 } } },
    { file: 'bayla-mint.json', json: baylaMintStandIn() },
    { file: 'usdc-mint.json', json: usdcMintStandIn() },
  ];
}

export function writeGenesisAccounts(outDir = DEFAULT_OUT_DIR, artifactsDir = defaultArtifactsDir()) {
  const art = loadVerifiedArtifacts(artifactsDir);
  const problems = goldenMismatches(art);
  if (problems.length) throw new Error(`REFUSING to seed: the encoder does not reproduce the rehearsal ledger:\n  ${problems.join('\n  ')}`);
  const mainnet = mainnetConfigMismatches(art);
  if (mainnet.length) throw new Error(`REFUSING to seed: the fee tiers are not mainnet's bytes:\n  ${mainnet.join('\n  ')}`);
  const accounts = buildGenesisAccounts(art);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { createdAt: new Date().toISOString(), artifactsDir: art.dir, pins: PINNED_SHA256, accounts: [] };
  for (const { file, json } of accounts) {
    const body = JSON.stringify(json);
    fs.writeFileSync(path.join(outDir, file), body);
    manifest.accounts.push({ file, pubkey: json.pubkey, owner: json.account.owner, lamports: json.account.lamports, space: json.account.space, dataSha256: sha256(Buffer.from(json.account.data[0], 'base64')) });
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? path.resolve(process.argv[i + 1]) : DEFAULT_OUT_DIR;
  try {
    const m = writeGenesisAccounts(out);
    console.log('golden check: the encoder reproduces the rehearsal ledger byte for byte (GlobalConfig, AmmConfig, Permission)');
    console.log('mainnet check: fee tiers 0 and 1 are seeded with mainnet\'s own bytes');
    for (const a of m.accounts) console.log(`  ${a.file.padEnd(16)} ${a.pubkey}  owner ${a.owner}  ${a.space} B  ${a.lamports} lamports`);
    console.log(`wrote ${m.accounts.length} accounts + manifest.json to ${out}`);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
