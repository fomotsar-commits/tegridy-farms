// `tegridy-launch` program identity, PDAs, account layouts and error codes.
//
// ⚠ THE PROGRAM IS NOT DEPLOYED. Not mainnet, not devnet. `PROGRAM_ID` below is
// the placeholder `declare_id!` the crate compiles against (lib.rs:97-101 says so
// in as many words) and it returns `null` on mainnet-beta. Nothing in this module
// asserts otherwise, and {@link isPlaceholderProgramId} exists so a surface can
// state it rather than imply a live market. See `read.ts` for the check that must
// run before anything else.
//
// There is NO committed IDL: `solana/tegridy-amm/.gitignore` ignores `target/`,
// and both on-chain test suites load the IDL from `../target/idl/…` at runtime,
// which only exists after `anchor build` — a build the Windows dev box cannot do
// (lib.rs:68-74). So the layouts here are encoded BY HAND from the program source
// and pinned by tests. Do not make this module depend on an IDL artifact.
//
// `Anchor.toml` also sets `[features] seeds = false`, so even a generated IDL
// would carry no PDA seed metadata and Anchor's JS client could not auto-derive
// anything. Every address is derived client-side, here.

import { PublicKey } from '@solana/web3.js';

// ── identity ─────────────────────────────────────────────────────────────────

/**
 * `declare_id!` — **DEPLOYED TO SOLANA MAINNET 2026-08-08**, slot 438055726, sig
 * `V7yjphDTzQDgPTH2bk5kSaMytN1T1DUgQaGnQcehzx8gyeU3c4EFiiT1Gdpo1vqQeGBT22D7wPBrZQgoHtcH3Pv`.
 * The on-chain bytecode's sha256 matches the CI artifact it was built from.
 */
export const PROGRAM_ID = new PublicKey('CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED');

/** The pre-deploy throwaway. Kept so the predicate below has something to compare against. */
export const PLACEHOLDER_PROGRAM_ID = new PublicKey('8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8');

/** The cp-swap fork a launch graduates into. Mainnet id — NOT yet deployed. */
export const CP_SWAP_PROGRAM_ID = new PublicKey('3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y');

/**
 * True while an id is still the throwaway the crate was written against.
 *
 * ⚠️ This compares against `PLACEHOLDER_PROGRAM_ID`, not `PROGRAM_ID`. It used to be
 * `id.equals(PROGRAM_ID)`, which was self-referential: called with its default
 * argument it could only ever return `true`, and once a real id was set it would
 * have reported the LIVE program as a placeholder. Harmless while the two were the
 * same value; actively wrong the moment they diverged, which is now.
 *
 * Still not sufficient on its own — an operator could set a real id and not have
 * deployed. The authoritative check remains `getAccountInfo(PROGRAM_ID)`.
 */
export function isPlaceholderProgramId(id: PublicKey = PROGRAM_ID): boolean {
  return id.equals(PLACEHOLDER_PROGRAM_ID);
}

/** Well-known addresses the instruction builders need. */
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * The all-zero pubkey. It is a legitimate VALUE in two places — `global.cp_swap_program` /
 * `global.amm_config` before the venue is configured (lib.rs:184-187), and
 * `curve.pool` before migration (state.rs:159-163) — so it must render as
 * "not set yet", never as an address and never as an error.
 */
export const DEFAULT_PUBKEY = SYSTEM_PROGRAM_ID;

/**
 * Token-2022 is NOT supported. Every token account in the program is typed
 * `Program<'info, Token>` / `anchor_spl::token::{Mint, TokenAccount}` — the legacy
 * program (lib.rs:1311, 1455, 1498). A Token-2022 mint fails account validation,
 * so a create-launch UI must reject one up front rather than let it revert.
 */
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// ── PDA seeds (state.rs:4-21, 69) ────────────────────────────────────────────

/**
 * ASCII seed → bytes. Every seed in the program is plain ASCII with no null
 * terminator (state.rs:4-21, 69).
 */
const seed = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

export const GLOBAL_SEED = seed('global');
export const CURVE_SEED = seed('curve');
export const VAULT_SEED = seed('vault');
export const MIGRATION_AUTH_SEED = seed('migauth');
/**
 * The pool seed — OURS, deliberately not cp-swap's canonical
 * `["pool", amm_config, mint0, mint1]`.
 *
 * That is a security property, not a preference (state.rs:50-69): cp-swap's
 * `initialize` is permissionless, so the canonical address can be OCCUPIED by
 * anyone for the price of one transaction, permanently preventing a launch from
 * graduating. A client that derives the canonical address points users at an
 * address a stranger may own.
 */
export const LAUNCH_POOL_SEED = seed('launchpool');

/** cp-swap's own seeds — pool.rs:6-8, oracle.rs:8, lib.rs:70. */
export const CP_AUTH_SEED = seed('vault_and_lp_mint_auth_seed');
export const CP_POOL_LP_MINT_SEED = seed('pool_lp_mint');
export const CP_POOL_VAULT_SEED = seed('pool_vault');
export const CP_OBSERVATION_SEED = seed('observation');
export const CP_AMM_CONFIG_SEED = seed('amm_config');

/**
 * ⚠ TESTING NOTE, not a runtime one. `findProgramAddressSync` hashes with
 * `@noble/hashes`, whose `Uint8Array` guard is realm-sensitive — under vitest's
 * jsdom environment web3.js's Node-realm `Buffer` fails `instanceof Uint8Array`,
 * every bump attempt throws, and the whole thing surfaces as "Unable to find a
 * viable program address nonce", which reads like a seed bug and is not one. Real
 * browsers use the `buffer` polyfill, which IS a subclass of the page's own
 * `Uint8Array`, so this is a jsdom artifact only. Test files that derive PDAs run
 * under `// @vitest-environment node`, matching `dbcClient.test.ts`.
 */
const pda = (seeds: Uint8Array[], programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

/** `["global"]` on tegridy-launch. Singleton protocol config. */
export function globalPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return pda([GLOBAL_SEED], programId);
}

/** `["curve", mint]` on tegridy-launch. */
export function curvePda(mint: PublicKey, programId: PublicKey = PROGRAM_ID): PublicKey {
  return pda([CURVE_SEED, mint.toBytes()], programId);
}

/** `["vault", mint]` on tegridy-launch — the curve's token account. */
export function curveVaultPda(mint: PublicKey, programId: PublicKey = PROGRAM_ID): PublicKey {
  return pda([VAULT_SEED, mint.toBytes()], programId);
}

/** `["migauth", mint]` on tegridy-launch — the data-less rent-payer/signer for migration. */
export function migrationAuthorityPda(mint: PublicKey, programId: PublicKey = PROGRAM_ID): PublicKey {
  return pda([MIGRATION_AUTH_SEED, mint.toBytes()], programId);
}

/**
 * `["launchpool", mint]` — on **tegridy-launch**, NOT on cp-swap.
 *
 * See {@link LAUNCH_POOL_SEED}. Every cp-swap-side account below hangs off
 * whatever `pool_state` cp-swap is handed, so getting this wrong poisons all of
 * them at once.
 */
export function poolStatePda(mint: PublicKey, programId: PublicKey = PROGRAM_ID): PublicKey {
  return pda([LAUNCH_POOL_SEED, mint.toBytes()], programId);
}

/** `["vault_and_lp_mint_auth_seed"]` on cp-swap. */
export function cpAmmAuthorityPda(cpSwapProgram: PublicKey = CP_SWAP_PROGRAM_ID): PublicKey {
  return pda([CP_AUTH_SEED], cpSwapProgram);
}

/** `["pool_lp_mint", pool_state]` on cp-swap. */
export function cpLpMintPda(poolState: PublicKey, cpSwapProgram: PublicKey = CP_SWAP_PROGRAM_ID): PublicKey {
  return pda([CP_POOL_LP_MINT_SEED, poolState.toBytes()], cpSwapProgram);
}

/** `["pool_vault", pool_state, mint]` on cp-swap. */
export function cpPoolVaultPda(
  poolState: PublicKey,
  mint: PublicKey,
  cpSwapProgram: PublicKey = CP_SWAP_PROGRAM_ID,
): PublicKey {
  return pda([CP_POOL_VAULT_SEED, poolState.toBytes(), mint.toBytes()], cpSwapProgram);
}

/** `["observation", pool_state]` on cp-swap. */
export function cpObservationPda(
  poolState: PublicKey,
  cpSwapProgram: PublicKey = CP_SWAP_PROGRAM_ID,
): PublicKey {
  return pda([CP_OBSERVATION_SEED, poolState.toBytes()], cpSwapProgram);
}

/** `["amm_config", be_u16(index)]` on cp-swap — note BIG-endian. */
export function cpAmmConfigPda(index: number, cpSwapProgram: PublicKey = CP_SWAP_PROGRAM_ID): PublicKey {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) {
    throw new RangeError(`amm_config index must be a u16, got ${index}`);
  }
  const be = Uint8Array.from([(index >> 8) & 0xff, index & 0xff]);
  return pda([CP_AMM_CONFIG_SEED, be], cpSwapProgram);
}

/**
 * Sort a mint pair the way cp-swap requires: `token_0_mint < token_1_mint` by RAW
 * PUBKEY BYTES (lib.rs:950-958, MIGRATE_DESIGN.md:88-92).
 *
 * Getting it backwards is a hard revert, and it is easy to get backwards because
 * base58 order is NOT byte order.
 */
export function sortMints(a: PublicKey, b: PublicKey): readonly [PublicKey, PublicKey] {
  const x = a.toBytes();
  const y = b.toBytes();
  for (let i = 0; i < 32; i++) {
    const xi = x[i]!;
    const yi = y[i]!;
    if (xi !== yi) return xi < yi ? [a, b] : [b, a];
  }
  return [a, b];
}

// ── Anchor discriminators ────────────────────────────────────────────────────

/**
 * `sha256("global:<snake_name>")[0..8]` for instructions,
 * `sha256("account:<Struct>")[0..8]` for accounts,
 * `sha256("event:<Event>")[0..8]` for events — Anchor's DEFAULT derivation.
 *
 * Computed offline and pinned as literals so this module needs no hash at
 * runtime; `program.test.ts` recomputes them from the names with WebCrypto and
 * fails if any drifts.
 *
 * ⚠ Anchor ≥0.30 embeds explicit discriminators in the IDL, so a future
 * `#[instruction(discriminator = …)]` override would silently diverge from these.
 * Re-verify against `target/idl/tegridy_launch.json` the first time a build exists.
 */
export const IX_DISCRIMINATOR = {
  initializeGlobal: Uint8Array.from([47, 225, 15, 112, 86, 51, 190, 231]),
  updateGlobal: Uint8Array.from([90, 152, 240, 21, 199, 38, 72, 20]),
  createLaunch: Uint8Array.from([239, 223, 255, 134, 39, 121, 127, 62]),
  buy: Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234]),
  sell: Uint8Array.from([51, 230, 133, 164, 1, 127, 131, 173]),
  migrateToAmm: Uint8Array.from([207, 82, 192, 145, 254, 207, 145, 223]),
  // sha256("global:set_curve_segments")[..8]. Derived with the same routine that
  // reproduces all six values above byte-for-byte, so it is checked, not guessed.
  setCurveSegments: Uint8Array.from([87, 209, 71, 218, 186, 34, 79, 1]),
} as const;

/**
 * cp-swap instructions. A SEPARATE program, so a separate table — Anchor namespaces
 * discriminators per program only by accident (both use `sha256("global:<name>")`),
 * and mixing them in one object invites sending a cp-swap instruction to
 * tegridy-launch, which would find no handler and fail obscurely.
 *
 * Derived with the routine that reproduces every `IX_DISCRIMINATOR` entry above
 * byte-for-byte.
 */
export const CP_SWAP_IX_DISCRIMINATOR = {
  createAmmConfig: Uint8Array.from([137, 52, 237, 212, 215, 117, 108, 104]),
  updateAmmConfig: Uint8Array.from([49, 60, 174, 136, 154, 28, 116, 200]),
} as const;

export const ACCOUNT_DISCRIMINATOR = {
  GlobalConfig: Uint8Array.from([149, 8, 156, 202, 160, 252, 176, 217]),
  BondingCurve: Uint8Array.from([23, 183, 248, 55, 96, 216, 172, 96]),
} as const;

export const EVENT_DISCRIMINATOR = {
  LaunchCreated: Uint8Array.from([59, 38, 190, 230, 33, 34, 89, 20]),
  Traded: Uint8Array.from([225, 202, 73, 175, 147, 43, 160, 150]),
  Graduated: Uint8Array.from([51, 241, 66, 50, 140, 245, 156, 192]),
} as const;

// ── errors (errors.rs:5-48) ──────────────────────────────────────────────────

/**
 * Anchor numbers `#[error_code]` variants from 6000 in DECLARATION order. A
 * simulated or failed transaction reports the number; this is how a UI turns it
 * back into something a person can act on.
 */
export const LAUNCH_ERROR_CODES = {
  6000: 'Overflow',
  6001: 'InsufficientLiquidity',
  6002: 'ZeroAmount',
  6003: 'FeeTooHigh',
  6004: 'Paused',
  6005: 'AlreadyComplete',
  6006: 'NotReadyToGraduate',
  6007: 'SlippageExceeded',
  6008: 'Unauthorized',
  6009: 'InvalidParameter',
  6010: 'InsufficientRentExemptBalance',
  6011: 'MintHasFreezeAuthority',
  6012: 'NotDeployAuthority',
  6013: 'GraduationTargetUnreachable',
  6014: 'GraduationPriceGap',
  6015: 'AmmNotConfigured',
  6016: 'AmmMismatch',
  6017: 'MigrationReserveTooLow',
  6018: 'LpNotBurned',
  6019: 'AwaitingMigration',
} as const;

export type LaunchErrorName = (typeof LAUNCH_ERROR_CODES)[keyof typeof LAUNCH_ERROR_CODES];

/**
 * Resolve an Anchor error number to its name, or `null` when it is not one of
 * ours (an SPL/system error, a compute exhaustion, an unknown).
 *
 * `null` is the honest answer there. Do not fall back to a generic in-house
 * message — mislabelling somebody else's failure as ours sends the user to the
 * wrong fix.
 */
export function launchErrorName(code: number): LaunchErrorName | null {
  return (LAUNCH_ERROR_CODES as Record<number, LaunchErrorName | undefined>)[code] ?? null;
}

/**
 * Two states that MUST NOT render the same.
 *
 * An earlier program version returned `AlreadyComplete` for the fully-funded
 * case, telling callers a curve had moved to an AMM pool when it had not
 * (lib.rs:476-479). `AwaitingMigration` exists solely to keep them apart.
 */
export const AWAITING_MIGRATION_CODE = 6019;
export const ALREADY_COMPLETE_CODE = 6005;

// ── account layouts ──────────────────────────────────────────────────────────
//
// Anchor accounts are `8-byte discriminator || borsh fields in declaration
// order`. Both structs here are fixed-width, so they decode by byte offset with
// a DataView and no borsh library. Every `u64` is little-endian and MUST be read
// as `bigint`: `token_total_supply` in the program's own tests is
// 1_000_000_000_000_000, far past `Number.MAX_SAFE_INTEGER`.

/**
 * `8 + InitSpace(715)`. state.rs:107-174.
 *
 * 715 = 186 for the fee/curve scalars + 529 for the segmented (Meteora-shaped)
 * curve — `sqrt_price_start_x64` (16) + `segment_count` (1) + `[Segment; 16]`
 * (16 x 32). This constant sat at 186 after the segmented fields were added to the
 * Rust struct, which made `decodeGlobalConfig` return `bad-length` for EVERY real
 * account: the live mainnet `global` is 723 bytes. Nothing caught it, because the
 * unit tests build their fixtures from this same constant — so the encoder and the
 * decoder agreed with each other and disagreed with the chain. Found by reading the
 * account back after `initialize_global` rather than trusting the send.
 */
export const GLOBAL_CONFIG_SIZE = 723;

/** `segmented.rs:MAX_SEGMENTS`. The array is fixed-width, so this bounds the count byte. */
export const MAX_SEGMENTS = 16;
/** `8 + InitSpace(154)`. state.rs:123-166. */
export const BONDING_CURVE_SIZE = 162;

/** `GlobalConfig`, state.rs:77-120. Describes FUTURE launches only — see {@link BondingCurve}. */
export interface GlobalConfig {
  /** Admin. Mainnet: the Squads multisig, threshold >= 2 (state.rs:80). */
  authority: PublicKey;
  feeRecipient: PublicKey;
  tradeFeeBps: bigint;
  /**
   * Share OF THE TRADE FEE paid to the token's creator, in bps. The SECOND field of
   * the struct — it was missing from this interface, so every field below it decoded
   * from the wrong offset (`initialVirtualSol` returned the creator share, and so on
   * down). Borsh is positional, so a missing field is a silent shift, not an error.
   */
  creatorFeeShareBps: bigint;
  initialVirtualSol: bigint;
  initialVirtualToken: bigint;
  /** Raw base units — divide by the MINT's decimals, which are not stored here. */
  tokenTotalSupply: bigint;
  /** EXCLUDES the migration reserve (state.rs:91-93). */
  graduationTargetLamports: bigint;
  migrationReserveLamports: bigint;
  /** May legitimately be all-zero: the venue is configured after deploy (lib.rs:184-187). */
  cpSwapProgram: PublicKey;
  /** May legitimately be all-zero, same reason. */
  ammConfig: PublicKey;
  /** Blocks buys and graduation. Sells stay open (state.rs:116-118). */
  paused: boolean;
  bump: number;
  /** Opening price of the segmented curve, Q64.64. Zero until `set_curve_segments`. */
  sqrtPriceStartX64: bigint;
  /** How many of the 16 segment slots are live. Zero => segmented mode unconfigured. */
  segmentCount: number;
  /** Exactly `segmentCount` entries; the unused tail slots are not returned. */
  segments: readonly { sqrtPriceUpperX64: bigint; liquidity: bigint }[];
}

/** `BondingCurve`, state.rs:123-166. One per launched token. */
export interface BondingCurve {
  mint: PublicKey;
  creator: PublicKey;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  /** The progress number. NOT the PDA's lamport balance — see `read.ts`. */
  realSolReserves: bigint;
  realTokenReserves: bigint;
  /**
   * Snapshotted at creation (lib.rs:430-432). QUOTE WITH THIS, never with
   * `GlobalConfig.tradeFeeBps` — a fee change must not rewrite a live launch's
   * terms, and a quote taken from the global disagrees with the program silently.
   */
  tradeFeeBps: bigint;
  /** Snapshotted, same reason. */
  graduationTargetLamports: bigint;
  /** Snapshotted, same reason. Buys are capped at target + THIS. */
  migrationReserveLamports: bigint;
  /** Terminal. Only `migrate_to_amm` writes it, in the same instruction that moves the liquidity. */
  complete: boolean;
  /** The cp-swap pool. All-zero until migration (state.rs:159-163). */
  pool: PublicKey;
  bump: number;
}

/** Why a decode returned nothing. Each renders differently; none of them is "zero". */
export type DecodeFailure =
  /** Account does not exist on chain. For a curve that means PRE-LAUNCH, not "0 raised". */
  | 'missing'
  /** Right length, wrong discriminator — the address holds some OTHER account. */
  | 'wrong-discriminator'
  /** Data is the wrong length for this layout. Layout drift, or not our account at all. */
  | 'bad-length'
  /** Right size and discriminator, but a field holds a value the program cannot write. */
  | 'malformed';

export type Decoded<T> = { ok: true; value: T } | { ok: false; reason: DecodeFailure };

function readU64(v: DataView, offset: number): bigint {
  return v.getBigUint64(offset, true); // little-endian
}

/**
 * Borsh `u128` — two little-endian `u64` halves, low first. `DataView` has no
 * `getBigUint128`, and the halves must be recombined rather than added as Numbers:
 * a Q64.64 sqrt price routinely exceeds 2^53.
 */
function readU128(v: DataView, offset: number): bigint {
  return v.getBigUint64(offset, true) | (v.getBigUint64(offset + 8, true) << 64n);
}

function readPubkey(bytes: Uint8Array, offset: number): PublicKey {
  return new PublicKey(bytes.subarray(offset, offset + 32));
}

/**
 * A borsh `bool` is one byte that the program only ever writes as 0 or 1.
 * Anything else means this is not the account we think it is, so it is surfaced
 * rather than coerced — `!!byte` would turn corrupt data into a confident `true`.
 */
function readBool(bytes: Uint8Array, offset: number): boolean | null {
  const b = bytes[offset];
  return b === 0 ? false : b === 1 ? true : null;
}

function checkDiscriminator(bytes: Uint8Array, want: Uint8Array): boolean {
  for (let i = 0; i < 8; i++) if (bytes[i] !== want[i]) return false;
  return true;
}

/** Decode a `GlobalConfig` account. Returns a REASON on failure, never a zeroed struct. */
export function decodeGlobalConfig(data: Uint8Array | null | undefined): Decoded<GlobalConfig> {
  if (!data) return { ok: false, reason: 'missing' };
  if (data.length !== GLOBAL_CONFIG_SIZE) return { ok: false, reason: 'bad-length' };
  if (!checkDiscriminator(data, ACCOUNT_DISCRIMINATOR.GlobalConfig)) {
    return { ok: false, reason: 'wrong-discriminator' };
  }
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Offsets are +8 from where they were: `creator_fee_share_bps` sits between
  // `trade_fee_bps` and `initial_virtual_sol` in the Rust struct (state.rs:117-125).
  const paused = readBool(data, 192);
  if (paused === null) return { ok: false, reason: 'malformed' };
  const segmentCount = data[210]!;
  // A count past the fixed 16 slots would read off the end of the segment array.
  // Refuse rather than return a truncated curve that quotes plausible-looking prices.
  if (segmentCount > MAX_SEGMENTS) return { ok: false, reason: 'malformed' };
  const segments = Array.from({ length: segmentCount }, (_, i) => ({
    sqrtPriceUpperX64: readU128(v, 211 + i * 32),
    liquidity: readU128(v, 211 + i * 32 + 16),
  }));
  return {
    ok: true,
    value: {
      authority: readPubkey(data, 8),
      feeRecipient: readPubkey(data, 40),
      tradeFeeBps: readU64(v, 72),
      creatorFeeShareBps: readU64(v, 80),
      initialVirtualSol: readU64(v, 88),
      initialVirtualToken: readU64(v, 96),
      tokenTotalSupply: readU64(v, 104),
      graduationTargetLamports: readU64(v, 112),
      migrationReserveLamports: readU64(v, 120),
      cpSwapProgram: readPubkey(data, 128),
      ammConfig: readPubkey(data, 160),
      paused,
      bump: data[193]!,
      sqrtPriceStartX64: readU128(v, 194),
      segmentCount,
      segments,
    },
  };
}

/** Decode a `BondingCurve` account. Returns a REASON on failure, never a zeroed struct. */
export function decodeBondingCurve(data: Uint8Array | null | undefined): Decoded<BondingCurve> {
  if (!data) return { ok: false, reason: 'missing' };
  if (data.length !== BONDING_CURVE_SIZE) return { ok: false, reason: 'bad-length' };
  if (!checkDiscriminator(data, ACCOUNT_DISCRIMINATOR.BondingCurve)) {
    return { ok: false, reason: 'wrong-discriminator' };
  }
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const complete = readBool(data, 128);
  if (complete === null) return { ok: false, reason: 'malformed' };
  return {
    ok: true,
    value: {
      mint: readPubkey(data, 8),
      creator: readPubkey(data, 40),
      virtualSolReserves: readU64(v, 72),
      virtualTokenReserves: readU64(v, 80),
      realSolReserves: readU64(v, 88),
      realTokenReserves: readU64(v, 96),
      tradeFeeBps: readU64(v, 104),
      graduationTargetLamports: readU64(v, 112),
      migrationReserveLamports: readU64(v, 120),
      complete,
      pool: readPubkey(data, 129),
      bump: data[161]!,
    },
  };
}

/** True for the all-zero pubkey — an unset value, not an address to display. */
export function isDefaultPubkey(k: PublicKey): boolean {
  return k.equals(DEFAULT_PUBKEY);
}

/**
 * Has the graduation venue been configured yet?
 *
 * Both zero is a REAL, EXPECTED state — the AmmConfig is created by a cp-swap
 * admin action after deploy (lib.rs:184-187). Render it as "graduation venue not
 * configured yet", never as an address of zeros and never as a read error.
 * `migrate_to_amm` returns `AmmNotConfigured` (6015) while this is false.
 */
export function isAmmConfigured(g: GlobalConfig): boolean {
  return !isDefaultPubkey(g.cpSwapProgram) && !isDefaultPubkey(g.ammConfig);
}
