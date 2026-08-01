// tegridy-launch — the pure layer: on-chain math, account layouts, phase rules.
//
// Our OWN Solana bonding curve (solana/tegridy-amm/programs/tegridy-launch),
// which graduates into our cp-swap fork. This module is a line-for-line
// restatement of what the program actually executes, transcribed from
// `curve.rs` / `state.rs` / `lib.rs` / `errors.rs`. The full interface contract
// is docs/OWN_CURVE_FRONTEND_CONTRACT.md; where this file and the program
// disagree, THE PROGRAM WINS and this file is the bug.
//
// Deliberately ZERO imports — no @solana/*, no SDK, not even a type-only one.
// Same doctrine as dbc.ts: the heavy client lives elsewhere, the math that
// costs users money lives here where it can be unit-tested without a wallet,
// an RPC, or a polyfill. The I/O seam is curveClient.ts.
//
// Three rules that this file exists to enforce, each of which this repo has
// shipped the violation of at least once:
//
//   1. BigInt everywhere. `virtual_token_reserves` is 1_073_000_000_000_000 in
//      the program's own tests; products of that with lamports leave float
//      precision immediately. There is no `number` arithmetic on chain values.
//   2. Rounding is asymmetric ON PURPOSE (curve.rs:19-29): tokens out round
//      DOWN, lamports out round DOWN, fees round UP. Every direction favours
//      the curve so order-slicing cannot grind value out of it. Flipping one
//      produces a quote the program will refuse — or silently beat.
//   3. "Could not read it" is never 0 and never a clean badge. Every decoder
//      returns an explicit `unreadable` variant; see AccountRead below.

// ---------------------------------------------------------------------------
// Program identity
// ---------------------------------------------------------------------------

/**
 * The program id `tegridy-launch` is compiled against (lib.rs:101).
 *
 * ⚠️ This is a PLACEHOLDER — lib.rs:97-100 says so in as many words. It is a
 * throwaway keypair generated only so the crate has a syntactically valid
 * base58 id, it corresponds to no key anybody holds, and it returns `null` on
 * mainnet-beta. It MUST be replaced with a dedicated keypair before any deploy.
 *
 * Nothing may assume this address is live. `probeProgram()` in curveClient.ts
 * is the only thing permitted to answer that question, and it answers it by
 * reading the chain.
 */
export const TEGRIDY_LAUNCH_PROGRAM_ID = '8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8';

/** PDA seed prefixes, raw ASCII with no null terminator (state.rs:4-21, 69). */
export const CURVE_SEEDS = {
  global: 'global',
  curve: 'curve',
  vault: 'vault',
  migrationAuthority: 'migauth',
  /**
   * ⚠️ `pool_state` is derived from THIS program, not from cp-swap's canonical
   * `["pool", amm_config, mint0, mint1]`. That is a security property, not a
   * preference (state.rs:50-69): cp-swap's `initialize` is permissionless, so
   * the canonical address is a public brick — anyone can occupy it for one
   * transaction's cost and permanently prevent a launch from graduating. A
   * client that derives the canonical address points users at the wrong pool.
   */
  pool: 'launchpool',
} as const;

// ---------------------------------------------------------------------------
// Constants (curve.rs:32, 37)
// ---------------------------------------------------------------------------

export const BPS_DENOMINATOR = 10_000n;
export const MAX_FEE_BPS = 1_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

const U64_MAX = 18_446_744_073_709_551_615n;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `LaunchError`, in declaration order (errors.rs:5-48). Anchor numbers
 * `#[error_code]` variants from 6000, so the index here IS the on-chain code
 * offset — `LAUNCH_ERROR_NAMES[n]` is error 6000+n.
 */
export const LAUNCH_ERROR_NAMES = [
  'Overflow',
  'InsufficientLiquidity',
  'ZeroAmount',
  'FeeTooHigh',
  'Paused',
  'AlreadyComplete',
  'NotReadyToGraduate',
  'SlippageExceeded',
  'Unauthorized',
  'InvalidParameter',
  'InsufficientRentExemptBalance',
  'MintHasFreezeAuthority',
  'NotDeployAuthority',
  'GraduationTargetUnreachable',
  'GraduationPriceGap',
  'AmmNotConfigured',
  'AmmMismatch',
  'MigrationReserveTooLow',
  'LpNotBurned',
  'AwaitingMigration',
] as const;

export type LaunchErrorName = (typeof LAUNCH_ERROR_NAMES)[number];

export const LAUNCH_ERROR_BASE = 6000;

/** Map an Anchor error code back to its name. Out-of-range → null, never a guess. */
export function launchErrorName(code: number): LaunchErrorName | null {
  const i = code - LAUNCH_ERROR_BASE;
  return (i >= 0 && i < LAUNCH_ERROR_NAMES.length ? LAUNCH_ERROR_NAMES[i] : null) ?? null;
}

/**
 * User-facing copy per error.
 *
 * Two entries here are load-bearing rather than cosmetic:
 *  - `AwaitingMigration` (6019) and `AlreadyComplete` (6005) must never read
 *    the same. An earlier program version returned AlreadyComplete for the
 *    fully-funded case, which told callers a curve had moved to an AMM pool
 *    when it had not; 6019 exists solely to separate them (lib.rs:476-479).
 *  - `Paused` (6004) says "buys" and not "trading", because sells are
 *    deliberately unpausable (lib.rs:563-564).
 */
export const LAUNCH_ERROR_COPY: Record<LaunchErrorName, string> = {
  Overflow: 'Arithmetic overflow — this is a bug, not something you did.',
  InsufficientLiquidity: 'The curve cannot fill a trade this size.',
  ZeroAmount: 'That amount resolves to zero — usually the fee eats a dust trade.',
  FeeTooHigh: 'The configured fee is above the protocol ceiling. Configuration bug, not a user action.',
  Paused: 'Buys are paused. Selling is still open — a pause never strands holders.',
  AlreadyComplete: 'This curve has graduated. Trade it on the AMM pool instead.',
  NotReadyToGraduate: 'The curve has not reached its graduation target yet.',
  SlippageExceeded: 'Price moved past your tolerance before the trade landed. Retry.',
  Unauthorized: 'Wrong signer for this instruction.',
  InvalidParameter: 'A supplied value is outside its permitted range.',
  InsufficientRentExemptBalance: "That sell is larger than the curve's rent floor allows.",
  MintHasFreezeAuthority: 'The mint still carries a freeze authority. It must be revoked before launch.',
  NotDeployAuthority: 'Operator-only instruction.',
  GraduationTargetUnreachable: 'Operator configuration: the target exceeds what this curve could ever hold.',
  GraduationPriceGap: 'Operator configuration: the launch would list far from its final curve price.',
  AmmNotConfigured: 'The graduation venue is not configured yet. Not a problem with this launch.',
  AmmMismatch: 'The supplied cp-swap program or AmmConfig does not match the configured one.',
  MigrationReserveTooLow: 'The curve cannot yet afford migration. Retryable — it is a stall, not a break.',
  LpNotBurned: 'Migration aborted rather than leave a false "liquidity locked" claim.',
  AwaitingMigration: 'Fully funded and waiting on migration. It has NOT graduated yet — sells still work.',
};

/** A quote that the program would reject, carrying the error it would reject with. */
export class CurveQuoteError extends Error {
  // Declared rather than a constructor parameter property: the app tsconfig
  // sets `erasableSyntaxOnly`, which forbids the shorthand.
  readonly code: LaunchErrorName;

  constructor(code: LaunchErrorName) {
    super(LAUNCH_ERROR_COPY[code]);
    this.name = 'CurveQuoteError';
    this.code = code;
  }
}

function requireU64(v: bigint, code: LaunchErrorName = 'InvalidParameter'): bigint {
  // The program's inputs are u64. TypeScript will happily hand us a negative or
  // an oversized BigInt from a parse; refuse it here rather than compute a
  // number the chain can never produce.
  if (v < 0n || v > U64_MAX) throw new CurveQuoteError(code);
  return v;
}

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

/**
 * Every account read is one of exactly three things, and they are kept apart in
 * the TYPE so a page cannot accidentally collapse them (the defect class behind
 * a scam pool rendering as "520607 ETH" and "Ownership renounced" printed from
 * a call that never returned). Mirrors tokenDossier.ts:1-19.
 */
export type AccountRead<T> =
  | { status: 'present'; value: T }
  /** Read succeeded; the account does not exist. A real finding. */
  | { status: 'absent' }
  /** The read failed, or returned something we cannot decode. NOT a finding. */
  | { status: 'unreadable'; reason: string };

/** `GlobalConfig` — state.rs:77-120, PDA ["global"], 186 bytes. */
export interface GlobalConfigState {
  authority: Uint8Array;
  feeRecipient: Uint8Array;
  tradeFeeBps: bigint;
  initialVirtualSol: bigint;
  initialVirtualToken: bigint;
  tokenTotalSupply: bigint;
  graduationTargetLamports: bigint;
  migrationReserveLamports: bigint;
  cpSwapProgram: Uint8Array;
  ammConfig: Uint8Array;
  paused: boolean;
  bump: number;
}

/** `BondingCurve` — state.rs:123-166, PDA ["curve", mint], 162 bytes. */
export interface BondingCurveState {
  mint: Uint8Array;
  creator: Uint8Array;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  /**
   * SNAPSHOT taken at create_launch (lib.rs:430-432). Quote with THIS, never
   * with `global.trade_fee_bps`: launch terms are frozen at creation precisely
   * so governance cannot retroactively rewrite a live launch's economics
   * (design note 1, lib.rs:18-21). The disagreement is silent — no revert, the
   * user simply gets a different number than the UI promised.
   */
  tradeFeeBps: bigint;
  graduationTargetLamports: bigint;
  migrationReserveLamports: bigint;
  complete: boolean;
  /** All-zero until migration writes it (state.rs:159-163). */
  pool: Uint8Array;
  bump: number;
}

export const GLOBAL_CONFIG_SIZE = 186;
export const BONDING_CURVE_SIZE = 162;

// sha256("account:<StructName>")[0..8] — Anchor's default derivation, computed
// rather than copied. Re-verify against target/idl/tegridy_launch.json the
// first time an `anchor build` artifact exists on a machine that can produce one.
const GLOBAL_CONFIG_DISCRIMINATOR = [149, 8, 156, 202, 160, 252, 176, 217];
const BONDING_CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];

function readU64(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true); // Anchor/borsh is little-endian
}

function discriminatorMatches(data: Uint8Array, expected: number[]): boolean {
  for (let i = 0; i < 8; i++) if (data[i] !== expected[i]) return false;
  return true;
}

/**
 * Decode an account by fixed byte offset.
 *
 * Both layouts are fixed-width, so this needs no borsh library — and more to
 * the point, there is NO committed IDL (`solana/tegridy-amm/.gitignore` ignores
 * `target/`), so a client that depends on an IDL artifact existing cannot run.
 *
 * A wrong size or a wrong discriminator is `unreadable`, never a zeroed struct:
 * decoding the wrong account into this shape would render fabricated reserves.
 */
function decodeAccount<T>(
  data: Uint8Array | null | undefined,
  expectedSize: number,
  expectedDiscriminator: number[],
  label: string,
  decode: (view: DataView, bytes: Uint8Array) => T,
): AccountRead<T> {
  if (data == null) return { status: 'absent' };
  if (data.length !== expectedSize) {
    return { status: 'unreadable', reason: `${label} is ${data.length} bytes, expected ${expectedSize}.` };
  }
  if (!discriminatorMatches(data, expectedDiscriminator)) {
    return { status: 'unreadable', reason: `${label} discriminator does not match — this is not a ${label} account.` };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { status: 'present', value: decode(view, data) };
}

export function decodeGlobalConfig(data: Uint8Array | null | undefined): AccountRead<GlobalConfigState> {
  return decodeAccount(data, GLOBAL_CONFIG_SIZE, GLOBAL_CONFIG_DISCRIMINATOR, 'GlobalConfig', (v, b) => ({
    authority: b.slice(8, 40),
    feeRecipient: b.slice(40, 72),
    tradeFeeBps: readU64(v, 72),
    initialVirtualSol: readU64(v, 80),
    initialVirtualToken: readU64(v, 88),
    tokenTotalSupply: readU64(v, 96),
    graduationTargetLamports: readU64(v, 104),
    migrationReserveLamports: readU64(v, 112),
    cpSwapProgram: b.slice(120, 152),
    ammConfig: b.slice(152, 184),
    // Length was verified as exactly GLOBAL_CONFIG_SIZE above, so these indices
    // are in range; the fallback only satisfies noUncheckedIndexedAccess.
    paused: b[184] !== 0,
    bump: b[185] ?? 0,
  }));
}

export function decodeBondingCurve(data: Uint8Array | null | undefined): AccountRead<BondingCurveState> {
  return decodeAccount(data, BONDING_CURVE_SIZE, BONDING_CURVE_DISCRIMINATOR, 'BondingCurve', (v, b) => ({
    mint: b.slice(8, 40),
    creator: b.slice(40, 72),
    virtualSolReserves: readU64(v, 72),
    virtualTokenReserves: readU64(v, 80),
    realSolReserves: readU64(v, 88),
    realTokenReserves: readU64(v, 96),
    tradeFeeBps: readU64(v, 104),
    graduationTargetLamports: readU64(v, 112),
    migrationReserveLamports: readU64(v, 120),
    complete: b[128] !== 0,
    pool: b.slice(129, 161),
    // See the note in decodeGlobalConfig — the length check above guarantees this.
    bump: b[161] ?? 0,
  }));
}

/**
 * True when a 32-byte pubkey is all zeroes.
 *
 * Two places this is a REAL state rather than a read failure, and must render
 * as such: `global.cp_swap_program` / `global.amm_config` are zero until a
 * cp-swap admin creates the AmmConfig after deploy (lib.rs:184-187), and
 * `curve.pool` is zero until migration. Neither is an address, and neither may
 * be printed as one.
 */
export function isZeroPubkey(key: Uint8Array): boolean {
  return key.every((b) => b === 0);
}

// ---------------------------------------------------------------------------
// Curve math — curve.rs
// ---------------------------------------------------------------------------

/**
 * Effective reserves: the pricing function sees virtual + real on BOTH legs
 * (state.rs:168-183). The invariant is constant product over these.
 */
export function effectiveSol(c: BondingCurveState): bigint {
  return c.virtualSolReserves + c.realSolReserves;
}

export function effectiveTokens(c: BondingCurveState): bigint {
  return c.virtualTokenReserves + c.realTokenReserves;
}

/**
 * Fee, rounded UP (`fee_up`, curve.rs:91-106).
 *
 * Up is the correct direction: rounding down would let a trader split one order
 * into many sub-fee-sized orders and pay nothing at all. Exactly-divisible is
 * NOT pushed to the next lamport — `feeUp(20000n, 100n) === 200n`.
 */
export function feeUp(amount: bigint, feeBps: bigint): bigint {
  if (feeBps > MAX_FEE_BPS) throw new CurveQuoteError('FeeTooHigh');
  if (feeBps === 0n) return 0n;
  requireU64(amount);
  const num = amount * feeBps;
  return (num + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR; // div_ceil
}

/**
 * The buy cap (`lamports_until_target`, curve.rs:216-240).
 *
 * Returns the GROSS lamports a buyer may still send — the remaining post-fee
 * room grossed back up so that after the fee is taken the curve lands exactly
 * on the ceiling. `null` means the curve is already fully funded, which the
 * program reports as AwaitingMigration and NOT as AlreadyComplete.
 *
 * Note this does not check MAX_FEE_BPS, only `>= BPS_DENOMINATOR`, exactly as
 * the Rust does — an over-ceiling fee is caught downstream by feeUp. The order
 * matters because it decides which error a caller sees.
 */
export function lamportsUntilTarget(realSolReserves: bigint, ceiling: bigint, feeBps: bigint): bigint | null {
  if (realSolReserves >= ceiling) return null;
  const remaining = ceiling - realSolReserves;
  if (feeBps >= BPS_DENOMINATOR) throw new CurveQuoteError('FeeTooHigh');
  const denom = BPS_DENOMINATOR - feeBps;
  return (remaining * BPS_DENOMINATOR + denom - 1n) / denom; // div_ceil
}

/**
 * The ceiling `buy` actually caps against: target PLUS the migration reserve,
 * never the target alone (lib.rs:466-469).
 *
 * Capping at the target made the reserve unraisable — buys stopped dead on the
 * target so the curve could never accumulate what migration costs, and
 * migration then failed for insufficient lamports. Caught by the CI rehearsal.
 * This is also the correct denominator for a progress bar: using the target
 * alone shows 100% while buys are still succeeding.
 */
export function raiseCeiling(c: BondingCurveState): bigint {
  return c.graduationTargetLamports + c.migrationReserveLamports;
}

export interface BuyQuote {
  /** What the wallet is ACTUALLY debited — `lamportsToCurve + feeLamports`. */
  cappedIn: bigint;
  feeLamports: bigint;
  lamportsToCurve: bigint;
  tokensOut: bigint;
  /**
   * True when the requested spend was clipped by the graduation ceiling. The
   * remainder is never taken and there is no refund transfer — the money simply
   * never leaves the wallet. A UI that shows "you will spend max_lamports_in"
   * is wrong on the last buy of EVERY launch.
   */
  capped: boolean;
}

/**
 * Quote a buy exactly as `buy` executes it (lib.rs:452-495 + curve.rs:112-161).
 *
 * `maxLamportsIn` is a CEILING, not a spend — see `capped` above.
 *
 * Order of checks is the program's order, because it decides which error the
 * user is shown. The one deliberate omission is the slippage check
 * (lib.rs:491), which sits between the reserve checks on chain: it cannot fire
 * here because a UI derives `min_tokens_out` FROM this quote's `tokensOut`.
 */
export function quoteBuy(c: BondingCurveState, maxLamportsIn: bigint): BuyQuote {
  requireU64(maxLamportsIn, 'ZeroAmount');
  if (c.complete) throw new CurveQuoteError('AlreadyComplete');

  const feeBps = c.tradeFeeBps; // SNAPSHOT, never global
  const limit = lamportsUntilTarget(c.realSolReserves, raiseCeiling(c), feeBps);
  if (limit === null) throw new CurveQuoteError('AwaitingMigration');

  const cappedIn = maxLamportsIn < limit ? maxLamportsIn : limit;
  if (cappedIn === 0n) throw new CurveQuoteError('ZeroAmount');

  const x = effectiveSol(c);
  const y = effectiveTokens(c);
  if (x === 0n || y === 0n) throw new CurveQuoteError('InsufficientLiquidity');

  const feeLamports = feeUp(cappedIn, feeBps);
  const lamportsToCurve = cappedIn - feeLamports;
  // A trade so small the fee eats all of it would mint zero tokens while still
  // charging — reject rather than silently take the fee for nothing.
  if (lamportsToCurve === 0n) throw new CurveQuoteError('ZeroAmount');

  // out = (y * dx) / (x + dx). Truncating division rounds DOWN, favouring the curve.
  const tokensOut = (y * lamportsToCurve) / (x + lamportsToCurve);
  if (tokensOut === 0n) throw new CurveQuoteError('ZeroAmount');
  // Two distinct reserve checks against two different quantities: curve.rs:152
  // compares against EFFECTIVE tokens, lib.rs:492 against REAL ones. Keep both.
  if (tokensOut >= y) throw new CurveQuoteError('InsufficientLiquidity');
  if (tokensOut > c.realTokenReserves) throw new CurveQuoteError('InsufficientLiquidity');

  return { cappedIn, feeLamports, lamportsToCurve, tokensOut, capped: cappedIn < maxLamportsIn };
}

export interface SellQuote {
  /** Pre-fee proceeds. This is the amount checked against real reserves and rent. */
  gross: bigint;
  feeLamports: bigint;
  /** What the seller actually receives. */
  lamportsOut: bigint;
}

/**
 * Quote a sell exactly as `sell` executes it (lib.rs:565-587 + curve.rs:164-204).
 *
 * `sell` is NOT gated on `global.paused` — a pause stops new money entering, it
 * must never strand holders (lib.rs:563-564). Callers must not disable selling
 * on a paused protocol.
 */
export function quoteSell(c: BondingCurveState, tokensIn: bigint): SellQuote {
  requireU64(tokensIn, 'ZeroAmount');
  if (c.complete) throw new CurveQuoteError('AlreadyComplete');
  if (tokensIn === 0n) throw new CurveQuoteError('ZeroAmount');

  const x = effectiveSol(c);
  const y = effectiveTokens(c);
  if (x === 0n || y === 0n) throw new CurveQuoteError('InsufficientLiquidity');

  // out = (x * dy) / (y + dy) — the mirror of the buy branch, also rounded DOWN.
  const gross = (x * tokensIn) / (y + tokensIn);
  if (gross === 0n) throw new CurveQuoteError('ZeroAmount');
  if (gross >= x) throw new CurveQuoteError('InsufficientLiquidity');

  const feeLamports = feeUp(gross, c.tradeFeeBps);
  const lamportsOut = gross - feeLamports;

  // The curve may only ever pay out REAL lamports. The virtual leg is pricing
  // fiction and is never redeemable (lib.rs:582-587).
  if (gross > c.realSolReserves) throw new CurveQuoteError('InsufficientLiquidity');

  return { gross, feeLamports, lamportsOut };
}

/**
 * The rent guard `sell` applies (lib.rs:605-614).
 *
 * Reads the curve PDA's ACTUAL lamport balance, not `real_sol_reserves` — the
 * PDA holds `rent_exempt + real_sol_reserves + anything anyone donated to it`,
 * and anyone can send lamports to a derivable address. A "max sell" that
 * ignores this quotes a trade the program refuses.
 */
export function violatesRentFloor(gross: bigint, curveAccountLamports: bigint, rentExemptLamports: bigint): boolean {
  return curveAccountLamports - gross < rentExemptLamports;
}

/**
 * The slippage floor to send as `min_tokens_out` / `min_lamports_out`.
 *
 * Rounded DOWN, so the floor is never above what the quote promised. This must
 * never be sent as 0 from a user surface: a quote is computed from an account
 * snapshot and is stale on arrival, and 0 accepts any fill at all.
 */
export function applySlippage(amount: bigint, toleranceBps: bigint): bigint {
  if (toleranceBps < 0n || toleranceBps >= BPS_DENOMINATOR) throw new CurveQuoteError('InvalidParameter');
  return (amount * (BPS_DENOMINATOR - toleranceBps)) / BPS_DENOMINATOR;
}

// ---------------------------------------------------------------------------
// Derived display numbers (§5.6 of the contract)
// ---------------------------------------------------------------------------

/** Fixed-point scale for `spotPriceScaled` — keeps sub-lamport precision in a BigInt. */
export const SPOT_SCALE = 1_000_000_000_000n;

/**
 * Spot price in lamports per token BASE UNIT, scaled by SPOT_SCALE.
 *
 * A display ratio, not a trade: any real trade moves it, so it must be labelled
 * "spot" and never presented as an executable price.
 */
export function spotPriceScaled(c: BondingCurveState): bigint | null {
  const y = effectiveTokens(c);
  if (y === 0n) return null;
  return (effectiveSol(c) * SPOT_SCALE) / y;
}

/**
 * Progress toward graduation, as a 0..1 ratio against `target + reserve`.
 *
 * The numerator is `real_sol_reserves`, the FIELD — not the PDA's lamport
 * balance, which also carries rent and any donated lamports (§3.3).
 */
export function graduationProgress(c: BondingCurveState): number {
  const ceiling = raiseCeiling(c);
  if (ceiling === 0n) return 0;
  const raised = c.realSolReserves > ceiling ? ceiling : c.realSolReserves;
  // Scale before dividing: the ratio is derived in BigInt and only becomes a
  // float at the last step, so a 1e15-magnitude numerator cannot lose the
  // fractional part on the way.
  return Number((raised * 1_000_000n) / ceiling) / 1_000_000;
}

/**
 * Format a lamport amount as SOL.
 *
 * Exact: the integer part comes from BigInt division and the fraction is padded
 * from the remainder, so nothing is routed through a float. Trailing zeros are
 * trimmed but a non-zero value never renders as "0" — it renders as "<0.0001",
 * because a real balance shown as zero is the bug this repo keeps re-shipping.
 */
export function formatSol(lamports: bigint, maxFractionDigits = 4): string {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = abs % LAMPORTS_PER_SOL;
  const digits = frac.toString().padStart(9, '0').slice(0, maxFractionDigits).replace(/0+$/, '');
  if (whole === 0n && digits === '' && frac > 0n) return `${neg ? '-' : ''}<0.${'0'.repeat(maxFractionDigits - 1)}1`;
  return `${neg ? '-' : ''}${whole.toString()}${digits ? `.${digits}` : ''}`;
}

/**
 * Format a raw base-unit amount using the mint's decimals.
 *
 * `decimals` is NOT stored on the curve and NOT constrained by the program —
 * the tests use 9 but nothing enforces it. Callers that could not read the mint
 * must pass `null` and get base units back with `isBaseUnits: true`, so the
 * page can say which one it is showing instead of silently assuming 9.
 */
export function formatTokenAmount(
  baseUnits: bigint,
  decimals: number | null,
  maxFractionDigits = 4,
): { text: string; isBaseUnits: boolean } {
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return { text: baseUnits.toString(), isBaseUnits: true };
  }
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  const frac = baseUnits % scale;
  const digits = frac.toString().padStart(decimals, '0').slice(0, maxFractionDigits).replace(/0+$/, '');
  return { text: `${whole.toLocaleString('en-US')}${digits ? `.${digits}` : ''}`, isBaseUnits: false };
}

/**
 * Parse a decimal string into base units, exactly.
 *
 * Returns null on anything that is not a plain non-negative decimal — no
 * silent coercion of `NaN` to 0, which would turn a typo into a real trade.
 */
export function parseDecimalToBaseUnits(input: string, decimals: number): bigint | null {
  const t = input.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [whole = '', frac = ''] = t.split('.');
  if (frac.length > decimals) return null; // more precision than the mint has
  const padded = frac.padEnd(decimals, '0');
  try {
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
  } catch {
    return null;
  }
}

/**
 * A cheap SHAPE check on a pasted mint address — base58 alphabet, plausible
 * length for a 32-byte key.
 *
 * Named "looksLike" on purpose: it says nothing about whether the key decodes
 * to 32 bytes, whether it is on the ed25519 curve, or whether anything exists
 * at it. It exists so the page can withhold a lookup for obvious typos without
 * claiming the address is real. The authoritative check is constructing a
 * PublicKey, which happens in the client.
 */
export function looksLikePubkey(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Phase classification (§7.1 of the contract)
// ---------------------------------------------------------------------------

export type ProgramProbe =
  | { status: 'deployed' }
  | { status: 'not-deployed' }
  | { status: 'unreadable'; reason: string };

export type LaunchPhase =
  /** The program id returns null on chain. Nothing downstream is meaningful. */
  | { kind: 'not-deployed' }
  /** A read failed. NOT a statement about the launch. */
  | { kind: 'unreadable'; reason: string }
  /** `global` does not exist — the protocol was never initialized. */
  | { kind: 'not-initialized' }
  /** No curve for this mint. Not "0 SOL raised" — there is nothing to have raised zero. */
  | { kind: 'pre-launch' }
  /** `complete` is set: liquidity has moved to the cp-swap pool. */
  | { kind: 'graduated' }
  /** Fully funded, buys revert with 6019, sells still work, anyone may migrate. */
  | { kind: 'awaiting-migration' }
  /** Target met but still raising the migration reserve. Buys AND sells work. */
  | { kind: 'at-target' }
  /** Bonding normally. */
  | { kind: 'trading' };

/**
 * Classify a launch. Evaluate top to bottom, FIRST MATCH WINS.
 *
 * The ordering is the whole point: an unreadable row must never fall through to
 * a later one, because every later row is a positive claim about the launch.
 * There is deliberately no "migrating" phase — migration is one atomic
 * instruction (lib.rs:693-1188) and a curve is either open or complete. A UI
 * may show "migrating…" only as local optimistic state while its own
 * transaction is in flight.
 */
export function classifyLaunchPhase(
  program: ProgramProbe,
  global: AccountRead<GlobalConfigState>,
  curve: AccountRead<BondingCurveState>,
): LaunchPhase {
  if (program.status === 'not-deployed') return { kind: 'not-deployed' };
  if (program.status === 'unreadable') return { kind: 'unreadable', reason: program.reason };

  if (global.status === 'unreadable') return { kind: 'unreadable', reason: global.reason };
  if (global.status === 'absent') return { kind: 'not-initialized' };

  if (curve.status === 'unreadable') return { kind: 'unreadable', reason: curve.reason };
  if (curve.status === 'absent') return { kind: 'pre-launch' };

  const c = curve.value;
  if (c.complete) return { kind: 'graduated' };
  if (c.realSolReserves >= raiseCeiling(c)) return { kind: 'awaiting-migration' };
  if (c.realSolReserves >= c.graduationTargetLamports) return { kind: 'at-target' };
  return { kind: 'trading' };
}

/** Phases in which the curve itself is the venue and a quote is meaningful. */
export function isTradablePhase(phase: LaunchPhase): boolean {
  return phase.kind === 'trading' || phase.kind === 'at-target' || phase.kind === 'awaiting-migration';
}

/**
 * Whether `buy` would be accepted right now, and why not if it would not.
 *
 * Kept separate from `sellBlockedReason` because the two are NOT symmetric:
 * a pause halts buys and leaves sells open, and a fully funded curve rejects
 * buys with AwaitingMigration while sells keep working.
 */
export function buyBlockedReason(phase: LaunchPhase, paused: boolean): LaunchErrorName | null {
  if (phase.kind === 'graduated') return 'AlreadyComplete';
  if (phase.kind === 'awaiting-migration') return 'AwaitingMigration';
  if (paused) return 'Paused';
  return null;
}

/** Sells are unpausable by design — only graduation stops them. */
export function sellBlockedReason(phase: LaunchPhase): LaunchErrorName | null {
  return phase.kind === 'graduated' ? 'AlreadyComplete' : null;
}

/**
 * Whether `migrate_to_amm` would pass its read-only preconditions right now
 * (lib.rs:695-743). Every input must be READ; nothing here may be assumed.
 *
 * This is a MOMENTARY claim. `sell` is unpausable, so a 1-lamport sell can flip
 * condition 5 between the read and the send — a known stall, documented in
 * MIGRATE_DESIGN.md:294-304. Migration is a retry-until-it-lands operation and
 * a failure must be presented as retryable, never as "this launch is broken".
 */
export function migrationBlockedReason(
  g: GlobalConfigState,
  c: BondingCurveState,
  curveAccountLamports: bigint,
  curveRentExemptLamports: bigint,
): LaunchErrorName | null {
  if (g.paused) return 'Paused';
  if (isZeroPubkey(g.cpSwapProgram) || isZeroPubkey(g.ammConfig)) return 'AmmNotConfigured';
  if (c.complete) return 'AlreadyComplete';
  if (c.realSolReserves < c.graduationTargetLamports) return 'NotReadyToGraduate';
  // Condition 5 is the binding one in practice, and it reads the PDA's ACTUAL
  // balance rather than the reserves field.
  if (curveAccountLamports - curveRentExemptLamports < raiseCeiling(c)) return 'MigrationReserveTooLow';
  return null;
}
