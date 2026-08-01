// `tegridy-launch` — program identity, deployment status, and protocol config.
//
// The honesty layer every other surface for OUR OWN bonding curve keys off. It
// answers exactly two questions and refuses to guess at either:
//
//   1. Is the program actually deployed on the cluster we are pointed at?
//   2. If so, what does its singleton `global` config say?
//
// ─── THE PROGRAM IS NOT DEPLOYED ──────────────────────────────────────────────
// `TEGRIDY_LAUNCH_PROGRAM_ID` is the PLACEHOLDER `declare_id!` from lib.rs:97-101 —
// a throwaway keypair that corresponds to no key anybody holds. Verified null on
// BOTH clusters on 2026-08-01: mainnet-beta slot 436,599,196 and devnet slot
// 480,487,191 both return `value: null` for `getAccountInfo`. Nothing here may
// imply a live market, and no surface built on it may render a price, a volume, a
// holder count, or a "0 SOL raised" — there is no market to have raised zero from.
//
// ─── THE THREE STATES THAT LOOK ALIKE ─────────────────────────────────────────
// Same doctrine as `tokenDossier.ts`, and for the same reason — this repo keeps
// re-learning it (a scam pool rendered as "520607 ETH"; "Ownership renounced"
// printed from an `owner()` call that never returned):
//
//   1. read it, answer is no   → a real negative finding
//   2. read it, answer is yes  → a real positive finding
//   3. could not read it       → NOT a finding about the protocol at all
//
// So every reader below returns an explicit `unreadable` variant. An RPC error is
// never `0`, never a green badge, never "not initialized".
//
// Two states in particular are REAL answers rather than failures, and collapsing
// either into an error would be its own lie:
//   • `global` absent            → the protocol has not been initialized yet.
//   • `cp_swap_program`/`amm_config` all-zero → the graduation venue is not
//     configured yet. lib.rs:184-187 says they MAY be zero at init because the
//     cp-swap AmmConfig is created by an admin action AFTER deploy.
//
// ─── NO IDL ───────────────────────────────────────────────────────────────────
// `solana/tegridy-amm/.gitignore` ignores `target/`, so no IDL artifact is
// committed and SBF cannot be built on the Windows dev box (lib.rs:68-74). The
// layout below is therefore decoded by FIXED BYTE OFFSET, discriminator-guarded,
// exactly as `squads.ts` reads a Squads `Multisig` threshold. Offsets come from
// `state.rs:77-120` field declaration order.
//
// Sources of truth, and the only authority for anything here:
//   solana/tegridy-amm/programs/tegridy-launch/src/{lib,state,curve}.rs
//   docs/OWN_CURVE_FRONTEND_CONTRACT.md

import { PublicKey, type Connection } from '@solana/web3.js';

// ─── Identity ────────────────────────────────────────────────────────────────

/**
 * PLACEHOLDER program id (lib.rs:101). MUST be replaced with a dedicated keypair
 * before any deploy, exactly as cp-swap's is. Because it will change, nothing here
 * hardcodes an address DERIVED from it — see `deriveGlobalConfigPda`.
 */
export const TEGRIDY_LAUNCH_PROGRAM_ID = '8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8';

/** PDA seed for the singleton protocol config (state.rs:4). */
export const GLOBAL_SEED = 'global';

/** `8 + GlobalConfig::INIT_SPACE(178)` (state.rs:77-120). */
export const GLOBAL_CONFIG_LEN = 186;

/** Anchor `sha256("account:GlobalConfig")[0..8]`. Computed, not copied. */
const GLOBAL_CONFIG_DISCRIMINATOR = Uint8Array.from([149, 8, 156, 202, 160, 252, 176, 217]);

/** `curve::MAX_FEE_BPS` (curve.rs:37) — the hard ceiling on the trade fee. */
export const MAX_FEE_BPS = 1_000n;
/** `curve::BPS_DENOMINATOR` (curve.rs:32). */
export const BPS_DENOMINATOR = 10_000n;
/** `curve::PRICE_CONTINUITY_BAND_BPS` (curve.rs:49) — ±5% listing-price band. */
export const PRICE_CONTINUITY_BAND_BPS = 500n;
/** `state::MIN_MIGRATION_RESERVE_LAMPORTS` (state.rs:48) — a FLOOR, not a sufficient value. */
export const MIN_MIGRATION_RESERVE_LAMPORTS = 42_156_720n;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

/**
 * Bound an RPC error string before it reaches a page.
 *
 * Deliberately a local copy rather than an import of `tokenDossier.clipMessage`:
 * that module pulls in viem and the whole EVM Doppler graph, and a Solana status
 * reader must not drag an EVM dependency chain behind it.
 */
function clip(s: string, max = 180): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function reasonOf(e: unknown): string {
  return clip(e instanceof Error ? e.message : String(e));
}

/**
 * Derive the singleton `global` PDA: `findProgramAddress(["global"], programId)`.
 *
 * Derived at call time and NEVER hardcoded. The program id above is a placeholder
 * that changes at deploy, and a baked-in address would then point at an account
 * belonging to nothing — the kind of stale constant that renders as real data.
 * Pure; no chain access. Throws on a malformed base58 program id.
 */
export function deriveGlobalConfigPda(programId: string = TEGRIDY_LAUNCH_PROGRAM_ID): string {
  const pid = new PublicKey((programId ?? '').trim());
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from(GLOBAL_SEED)], pid);
  return pda.toBase58();
}

// ─── GlobalConfig decode ─────────────────────────────────────────────────────

/** `GlobalConfig` (state.rs:77-120). All `u64` are `bigint` — they exceed `Number.MAX_SAFE_INTEGER` routinely. */
export interface GlobalConfig {
  /** Admin. Mainnet: the Squads multisig, threshold >= 2 (state.rs:80). */
  authority: string;
  feeRecipient: string;
  tradeFeeBps: bigint;
  initialVirtualSol: bigint;
  initialVirtualToken: bigint;
  tokenTotalSupply: bigint;
  /** EXCLUDES the migration reserve (state.rs:91-93). */
  graduationTargetLamports: bigint;
  migrationReserveLamports: bigint;
  /** May legitimately be all-zero — see `graduationVenue`. */
  cpSwapProgram: string;
  ammConfig: string;
  paused: boolean;
  bump: number;
}

/**
 * The result of decoding raw `global` account bytes.
 *
 * `malformed` is NOT the same as absent: it means an account exists at the PDA but
 * is not a `GlobalConfig`. That can only happen if the program id is wrong or the
 * layout changed, and reporting it as "not initialized" would send an operator
 * chasing the wrong thing.
 */
export type GlobalConfigDecode =
  | { kind: 'ok'; config: GlobalConfig }
  | { kind: 'malformed'; reason: string };

/**
 * Decode raw `global` bytes by fixed offset, guarded by the Anchor discriminator.
 *
 * FAIL-CLOSED BY CONSTRUCTION, matching `squads.readMultisigThreshold`: the
 * discriminator + exact-length checks guarantee we only ever read these offsets out
 * of an actual `GlobalConfig`. Anything else returns `malformed` rather than a
 * plausible-looking config assembled from unrelated bytes. Never throws; pure.
 */
export function decodeGlobalConfig(data: Uint8Array | null | undefined): GlobalConfigDecode {
  if (!data) return { kind: 'malformed', reason: 'account has no data' };
  // Exact length, not a minimum: GlobalConfig is fixed-width, so a different size is
  // a different account (or a different layout) and must not be offset-parsed.
  if (data.length !== GLOBAL_CONFIG_LEN) {
    return { kind: 'malformed', reason: `expected ${GLOBAL_CONFIG_LEN} bytes, got ${data.length}` };
  }
  for (let i = 0; i < GLOBAL_CONFIG_DISCRIMINATOR.length; i++) {
    if (data[i] !== GLOBAL_CONFIG_DISCRIMINATOR[i]) {
      return { kind: 'malformed', reason: 'not a GlobalConfig account (discriminator mismatch)' };
    }
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (off: number) => view.getBigUint64(off, true); // Anchor/borsh is little-endian
  const key = (off: number) => new PublicKey(data.subarray(off, off + 32)).toBase58();

  // Borsh encodes bool as exactly 0 or 1. Any other byte means this is not the
  // account we think it is — report it rather than coerce a garbage byte to `true`.
  // `getUint8` rather than `data[184]`: under noUncheckedIndexedAccess an index read
  // is `number | undefined`, and the length check above already proves both exist.
  const pausedByte = view.getUint8(184);
  if (pausedByte !== 0 && pausedByte !== 1) {
    return { kind: 'malformed', reason: `invalid bool byte for 'paused': ${pausedByte}` };
  }

  return {
    kind: 'ok',
    config: {
      authority: key(8),
      feeRecipient: key(40),
      tradeFeeBps: u64(72),
      initialVirtualSol: u64(80),
      initialVirtualToken: u64(88),
      tokenTotalSupply: u64(96),
      graduationTargetLamports: u64(104),
      migrationReserveLamports: u64(112),
      cpSwapProgram: key(120),
      ammConfig: key(152),
      paused: pausedByte === 1,
      bump: view.getUint8(185),
    },
  };
}

/**
 * Whether the graduation venue is set.
 *
 * `Pubkey::default()` (all-zero, base58 `111…1`) is an EXPECTED state, not a
 * failure: the cp-swap AmmConfig is created by an admin action after this program
 * is deployed, so `initialize_global` accepts zeros and `update_global` sets them
 * later (lib.rs:184-187, 347-367). Render `not-configured` as "graduation venue not
 * configured yet" — never as an address of zeros, and never as an error.
 *
 * While it is unset, `migrate_to_amm` refuses to run with `AmmNotConfigured` (6015).
 */
export type GraduationVenue =
  | { kind: 'configured'; cpSwapProgram: string; ammConfig: string }
  | { kind: 'not-configured' };

const DEFAULT_PUBKEY = PublicKey.default.toBase58();

export function graduationVenue(config: GlobalConfig): GraduationVenue {
  if (config.cpSwapProgram === DEFAULT_PUBKEY || config.ammConfig === DEFAULT_PUBKEY) {
    return { kind: 'not-configured' };
  }
  return { kind: 'configured', cpSwapProgram: config.cpSwapProgram, ammConfig: config.ammConfig };
}

// ─── Deployment status ───────────────────────────────────────────────────────

/**
 * Whether the program itself exists on the cluster being read.
 *
 * `not-a-program` is a distinct state on purpose. The program id is a public
 * address and anyone may transfer lamports to it, which makes `getAccountInfo`
 * return a NON-null, non-executable System account while the program is still not
 * deployed. Treating "account exists" as "deployed" would turn a stranger's dust
 * transfer into a live-protocol badge.
 */
export type ProgramDeployment =
  | { kind: 'deployed'; programId: string; owner: string; dataLen: number }
  | { kind: 'not-deployed'; programId: string }
  | { kind: 'not-a-program'; programId: string; owner: string }
  | { kind: 'unreadable'; programId: string; reason: string };

/** The subset of a web3.js `AccountInfo` this module reads. */
export interface RawAccount {
  executable: boolean;
  owner: { toBase58(): string };
  data: Uint8Array;
}

/** Pure classifier over an already-fetched account. Exported for unit testing. */
export function classifyProgramAccount(
  programId: string,
  info: RawAccount | null | undefined,
): ProgramDeployment {
  if (!info) return { kind: 'not-deployed', programId };
  if (!info.executable) {
    return { kind: 'not-a-program', programId, owner: info.owner.toBase58() };
  }
  return {
    kind: 'deployed',
    programId,
    owner: info.owner.toBase58(),
    dataLen: info.data?.length ?? 0,
  };
}

/** Reading the singleton `global` account. `not-initialized` is a real answer. */
export type GlobalConfigState =
  | { kind: 'initialized'; address: string; config: GlobalConfig }
  | { kind: 'not-initialized'; address: string }
  | { kind: 'malformed'; address: string; reason: string }
  | { kind: 'unreadable'; address: string; reason: string };

/**
 * The whole protocol-level answer, in the order the phase table requires.
 *
 * `global` is `null` when we DELIBERATELY DID NOT LOOK — because the program is
 * not deployed (or could not be read), so any statement about its config would be
 * a claim about a protocol that does not exist. That is different from
 * `not-initialized`, which is a real read of an absent account. Never collapse them.
 */
export interface LaunchProtocolStatus {
  program: ProgramDeployment;
  global: GlobalConfigState | null;
}

// ─── I/O — the only functions here that touch a connection ───────────────────

/**
 * Read the program account. The FIRST thing any client does; `not-deployed` stops
 * everything downstream rather than deriving PDAs and rendering their absence as data.
 */
export async function fetchProgramDeployment(
  connection: Pick<Connection, 'getAccountInfo'>,
  programId: string = TEGRIDY_LAUNCH_PROGRAM_ID,
): Promise<ProgramDeployment> {
  let pid: PublicKey;
  try {
    pid = new PublicKey((programId ?? '').trim());
  } catch (e) {
    return { kind: 'unreadable', programId, reason: `invalid program id: ${reasonOf(e)}` };
  }
  try {
    const info = await connection.getAccountInfo(pid);
    return classifyProgramAccount(programId, info as RawAccount | null);
  } catch (e) {
    return { kind: 'unreadable', programId, reason: reasonOf(e) };
  }
}

/**
 * Read the singleton `global` config.
 *
 * Callers must gate this on `fetchProgramDeployment` first — use
 * `fetchLaunchProtocolStatus` unless you have already done so. Called against a
 * cluster where the program is absent, the PDA is simply empty, and reporting that
 * as `not-initialized` states something about a protocol that is not there.
 */
export async function fetchGlobalConfig(
  connection: Pick<Connection, 'getAccountInfo'>,
  programId: string = TEGRIDY_LAUNCH_PROGRAM_ID,
): Promise<GlobalConfigState> {
  let address: string;
  try {
    address = deriveGlobalConfigPda(programId);
  } catch (e) {
    return { kind: 'unreadable', address: '', reason: `could not derive global PDA: ${reasonOf(e)}` };
  }
  try {
    const info = await connection.getAccountInfo(new PublicKey(address));
    if (!info) return { kind: 'not-initialized', address };
    const decoded = decodeGlobalConfig(info.data as Uint8Array);
    return decoded.kind === 'ok'
      ? { kind: 'initialized', address, config: decoded.config }
      : { kind: 'malformed', address, reason: decoded.reason };
  } catch (e) {
    return { kind: 'unreadable', address, reason: reasonOf(e) };
  }
}

/**
 * Deployment status plus config, short-circuited in the honest order.
 *
 * Two sequential reads rather than one `getMultipleAccounts`: the point is to NOT
 * look at `global` unless the program is really there, and a batched fetch would
 * have looked anyway.
 */
export async function fetchLaunchProtocolStatus(
  connection: Pick<Connection, 'getAccountInfo'>,
  programId: string = TEGRIDY_LAUNCH_PROGRAM_ID,
): Promise<LaunchProtocolStatus> {
  const program = await fetchProgramDeployment(connection, programId);
  if (program.kind !== 'deployed') return { program, global: null };
  return { program, global: await fetchGlobalConfig(connection, programId) };
}

// ─── Config validation math (operator-facing) ────────────────────────────────
//
// A line-by-line port of the three config-time functions in `curve.rs`, so an
// operator can pre-flight `initialize_global` / `update_global` locally instead of
// discovering a rejection as a bare error code after a multisig ceremony.
//
// VERIFIED DIFFERENTIALLY, not by eye: `curve.rs` was compiled on the host
// (`rustc --edition 2021`, its own suite 23/23 green) and driven over 50,009 cases —
// the fixtures curve.rs's own tests pin, degenerate/zero inputs, full-`u64`
// saturation, and 10,000 realistic launch books. This port matched on 50,009/50,009.
// See `tegridyLaunch.test.ts` for the pinned subset and the mutation record.
//
// `u128` intermediates really can overflow here, so the bounds are emulated rather
// than assumed — BigInt would silently produce a number Rust would have rejected.

/** Mirrors `curve::CurveError` (curve.rs:52-64). */
export type CurveErrorCode = 'Overflow' | 'InsufficientLiquidity' | 'ZeroAmount' | 'FeeTooHigh';

export class CurveConfigError extends Error {
  readonly code: CurveErrorCode;
  constructor(code: CurveErrorCode) {
    super(code);
    this.name = 'CurveConfigError';
    this.code = code;
  }
}

const mulU128 = (a: bigint, b: bigint): bigint => {
  const p = a * b;
  if (p > U128_MAX) throw new CurveConfigError('Overflow');
  return p;
};

const toU64 = (v: bigint): bigint => {
  if (v > U64_MAX) throw new CurveConfigError('Overflow');
  return v;
};

/**
 * `curve::isqrt_u128` (curve.rs:302-...) — Newton's method, floor(sqrt(n)).
 * Same seed (`n/2 + 1`) and loop as the Rust so the two cannot diverge.
 */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n / 2n + 1n;
  let y = (x + n / x) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * `curve::max_reachable_real_sol` (curve.rs:288-301) — the most real SOL a curve can
 * EVER hold, `V_s · S / V_t`. An EXCLUSIVE upper bound: `quote_buy` refuses to hand
 * out the entire token reserve, so the last fraction is unreachable.
 */
export function maxReachableRealSol(virtualSol: bigint, virtualToken: bigint, tokenSupply: bigint): bigint {
  if (virtualSol === 0n || virtualToken === 0n || tokenSupply === 0n) {
    throw new CurveConfigError('ZeroAmount');
  }
  return toU64(mulU128(virtualSol, tokenSupply) / virtualToken);
}

/**
 * `curve::graduation_price_ratio_bps` (curve.rs:322-366) — the ratio of a launch's
 * LISTING price to its final CURVE price, in bps. `10_000` = lists at exactly the
 * price its last curve buyer paid.
 *
 * The migration reserve counts: it is raised from traders on top of the target, so
 * the curve keeps selling tokens while it accrues, but only the target is deposited.
 */
export function graduationPriceRatioBps(
  virtualSol: bigint,
  virtualToken: bigint,
  tokenSupply: bigint,
  graduationTarget: bigint,
  migrationReserve: bigint,
): bigint {
  if (virtualSol === 0n || virtualToken === 0n || tokenSupply === 0n || graduationTarget === 0n) {
    throw new CurveConfigError('ZeroAmount');
  }
  const k = mulU128(virtualSol, virtualToken + tokenSupply); // k = Vs · (Vt + S)
  const x = virtualSol + graduationTarget + migrationReserve;
  const y = k / x;
  if (y < virtualToken) throw new CurveConfigError('InsufficientLiquidity'); // checked_sub
  const remaining = y - virtualToken;
  if (remaining === 0n) throw new CurveConfigError('InsufficientLiquidity');
  // pool/curve = [T / remaining] / [x / y] = T·y / (remaining·x)
  const num = mulU128(mulU128(graduationTarget, y), BPS_DENOMINATOR);
  const den = mulU128(remaining, x);
  return toU64(num / den);
}

/**
 * `curve::continuity_target` (curve.rs:376-404) — the graduation target that lists a
 * launch at exactly its final curve price: `sqrt(Vs·(Vt+S)·(Vs+R)/Vt) − Vs − R`.
 *
 * ADVISORY; `graduationPriceRatioBps` is the authoritative check. Operators need it
 * because the ±5% price band is only about ±0.7% in the target — nobody lands it by
 * picking a round number.
 */
export function continuityTarget(
  virtualSol: bigint,
  virtualToken: bigint,
  tokenSupply: bigint,
  migrationReserve: bigint,
): bigint {
  if (virtualSol === 0n || virtualToken === 0n || tokenSupply === 0n) {
    throw new CurveConfigError('ZeroAmount');
  }
  // Divide before the second multiply so large books do not overflow — as the Rust does.
  const scaled = mulU128(virtualSol, virtualToken + tokenSupply) / virtualToken;
  const inner = mulU128(scaled, virtualSol + migrationReserve);
  const root = isqrt(inner);
  const t = root - virtualSol - migrationReserve;
  if (t < 0n) throw new CurveConfigError('InsufficientLiquidity'); // checked_sub
  return toU64(t);
}

// ─── Instruction data encoding (operator-facing) ─────────────────────────────
//
// Hand-rolled because there is no committed IDL (see the header). Args are Borsh,
// appended after the 8-byte discriminator: `u64` little-endian, `Pubkey` 32 raw
// bytes, `bool` one byte, `Option<T>` = 0x00 for None or 0x01 followed by T.
//
// This lives here rather than in the operator harness so it is unit-testable — the
// same split as `dbc.ts` (pure builder) vs `solana-dbc-operator.mjs` (I/O). The
// ORDER of the `update_global` options is load-bearing and silent if wrong: the
// program would apply a value to a different field than the operator intended.

/** Anchor `sha256("global:initialize_global")[0..8]`. */
export const IX_INITIALIZE_GLOBAL = Uint8Array.from([47, 225, 15, 112, 86, 51, 190, 231]);
/** Anchor `sha256("global:update_global")[0..8]`. */
export const IX_UPDATE_GLOBAL = Uint8Array.from([90, 152, 240, 21, 199, 38, 72, 20]);

class ByteWriter {
  private readonly parts: Uint8Array[] = [];
  bytes(b: Uint8Array): this {
    this.parts.push(b);
    return this;
  }
  u64(v: bigint): this {
    if (v < 0n || v > U64_MAX) throw new RangeError(`value does not fit in u64: ${v}`);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    return this.bytes(b);
  }
  pubkey(k: string): this {
    return this.bytes(new PublicKey(k).toBytes());
  }
  optU64(v: bigint | undefined): this {
    return v === undefined ? this.bytes(Uint8Array.of(0)) : this.bytes(Uint8Array.of(1)).u64(v);
  }
  optPubkey(v: string | undefined): this {
    return v === undefined ? this.bytes(Uint8Array.of(0)) : this.bytes(Uint8Array.of(1)).pubkey(v);
  }
  optBool(v: boolean | undefined): this {
    return v === undefined ? this.bytes(Uint8Array.of(0)) : this.bytes(Uint8Array.of(1, v ? 1 : 0));
  }
  finish(): Uint8Array {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

/** `initialize_global` args, in declaration order (lib.rs:189-197). */
export interface InitializeGlobalArgs extends LaunchEconomicsParams {
  /** May be the zero pubkey — the AmmConfig is created after deploy (lib.rs:184-187). */
  cpSwapProgram: string;
  ammConfig: string;
}

/** Encode `initialize_global` instruction data. 120 bytes: 8 + 6×u64 + 2×Pubkey. */
export function encodeInitializeGlobalData(a: InitializeGlobalArgs): Uint8Array {
  return new ByteWriter()
    .bytes(IX_INITIALIZE_GLOBAL)
    .u64(a.tradeFeeBps)
    .u64(a.initialVirtualSol)
    .u64(a.initialVirtualToken)
    .u64(a.tokenTotalSupply)
    .u64(a.graduationTargetLamports)
    .u64(a.migrationReserveLamports)
    .pubkey(a.cpSwapProgram)
    .pubkey(a.ammConfig)
    .finish();
}

/**
 * `update_global` args, in declaration order (lib.rs:276-285). Every field is
 * optional; omitted fields encode as `None` and the program leaves them untouched.
 */
export interface UpdateGlobalArgs {
  tradeFeeBps?: bigint;
  graduationTargetLamports?: bigint;
  paused?: boolean;
  newAuthority?: string;
  newFeeRecipient?: string;
  migrationReserveLamports?: bigint;
  newCpSwapProgram?: string;
  newAmmConfig?: string;
  newInitialVirtualSol?: bigint;
}

/** Encode `update_global` instruction data. 17 bytes all-None, 178 all-Some. */
export function encodeUpdateGlobalData(a: UpdateGlobalArgs): Uint8Array {
  return new ByteWriter()
    .bytes(IX_UPDATE_GLOBAL)
    .optU64(a.tradeFeeBps)
    .optU64(a.graduationTargetLamports)
    .optBool(a.paused)
    .optPubkey(a.newAuthority)
    .optPubkey(a.newFeeRecipient)
    .optU64(a.migrationReserveLamports)
    .optPubkey(a.newCpSwapProgram)
    .optPubkey(a.newAmmConfig)
    .optU64(a.newInitialVirtualSol)
    .finish();
}

/** The parameters `initialize_global` validates (lib.rs:188-248). */
export interface LaunchEconomicsParams {
  tradeFeeBps: bigint;
  initialVirtualSol: bigint;
  initialVirtualToken: bigint;
  tokenTotalSupply: bigint;
  graduationTargetLamports: bigint;
  migrationReserveLamports: bigint;
}

/**
 * Every diagnostic an operator needs before signing, plus every reason the program
 * would reject the config — in the order lib.rs actually checks them.
 *
 * `null` on a diagnostic means IT COULD NOT BE COMPUTED (degenerate or overflowing
 * inputs), never `0`. An empty `problems` array means the program's config guards
 * all pass; it is not a claim that the resulting economics are wise.
 */
export interface LaunchEconomicsReport {
  problems: string[];
  maxReachableRealSol: bigint | null;
  graduationPriceRatioBps: bigint | null;
  /** The target that would list at exactly the curve price, for the same book. */
  continuityTarget: bigint | null;
}

const tryCompute = (f: () => bigint): bigint | null => {
  try {
    return f();
  } catch {
    return null;
  }
};

/**
 * Pre-flight `initialize_global` / `update_global` locally.
 *
 * Mirrors, in order: the fee ceiling (lib.rs:199), the non-zero parameter checks
 * (lib.rs:203-206), the reachability check against target PLUS reserve
 * (lib.rs:219-228), then `check_launch_economics` — the migration-reserve floor
 * (lib.rs:151-154) and the ±5% listing-price band (lib.rs:156-169).
 */
export function checkLaunchEconomics(p: LaunchEconomicsParams): LaunchEconomicsReport {
  const problems: string[] = [];

  if (p.tradeFeeBps > MAX_FEE_BPS) {
    problems.push(`FeeTooHigh: trade_fee_bps ${p.tradeFeeBps} exceeds MAX_FEE_BPS ${MAX_FEE_BPS}`);
  }
  if (p.initialVirtualSol === 0n) problems.push('InvalidParameter: initial_virtual_sol must be > 0');
  if (p.initialVirtualToken === 0n) problems.push('InvalidParameter: initial_virtual_token must be > 0');
  if (p.tokenTotalSupply === 0n) problems.push('InvalidParameter: token_total_supply must be > 0');
  if (p.graduationTargetLamports === 0n) {
    problems.push('InvalidParameter: graduation_target_lamports must be > 0');
  }

  const maxReachable = tryCompute(() =>
    maxReachableRealSol(p.initialVirtualSol, p.initialVirtualToken, p.tokenTotalSupply),
  );
  const required = p.graduationTargetLamports + p.migrationReserveLamports;
  if (required > U64_MAX) {
    problems.push('Overflow: graduation_target + migration_reserve exceeds u64');
  } else if (maxReachable === null) {
    problems.push('GraduationTargetUnreachable: the curve ceiling could not be computed for this book');
  } else if (required >= maxReachable) {
    problems.push(
      `GraduationTargetUnreachable: target + reserve ${required} >= curve ceiling ${maxReachable}`,
    );
  }

  if (p.migrationReserveLamports < MIN_MIGRATION_RESERVE_LAMPORTS) {
    problems.push(
      `MigrationReserveTooLow: ${p.migrationReserveLamports} < MIN_MIGRATION_RESERVE_LAMPORTS ${MIN_MIGRATION_RESERVE_LAMPORTS}`,
    );
  }

  const ratio = tryCompute(() =>
    graduationPriceRatioBps(
      p.initialVirtualSol,
      p.initialVirtualToken,
      p.tokenTotalSupply,
      p.graduationTargetLamports,
      p.migrationReserveLamports,
    ),
  );
  const lo = BPS_DENOMINATOR - PRICE_CONTINUITY_BAND_BPS;
  const hi = BPS_DENOMINATOR + PRICE_CONTINUITY_BAND_BPS;
  if (ratio === null) {
    problems.push('GraduationPriceGap: the listing/curve price ratio could not be computed');
  } else if (ratio < lo || ratio > hi) {
    problems.push(
      `GraduationPriceGap: lists at ${ratio} bps of the final curve price (must be ${lo}..=${hi})`,
    );
  }

  return {
    problems,
    maxReachableRealSol: maxReachable,
    graduationPriceRatioBps: ratio,
    continuityTarget: tryCompute(() =>
      continuityTarget(
        p.initialVirtualSol,
        p.initialVirtualToken,
        p.tokenTotalSupply,
        p.migrationReserveLamports,
      ),
    ),
  };
}
