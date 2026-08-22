// Reading `tegridy-launch` state, and classifying what came back.
//
// THIS IS A TRUST SURFACE. Three things look alike and must stay strictly apart —
// in types, not just in copy (the pattern is `tokenDossier.ts:1-19`, and the
// reason is that this repo keeps collapsing them: a scam pool rendered as
// "520607 ETH"; a "+10% NFT boost" banner no contract paid; "Ownership renounced"
// printed from an `owner()` call that never returned):
//
//   1. read it, answer is NO      — a real negative finding
//   2. read it, answer is YES     — a real positive finding
//   3. COULD NOT READ IT          — not a finding about the launch at all
//
// So nothing below returns a number on failure. There is no `?? 0`, no
// `catch { return 0 }`, no default-to-clean-badge. An RPC error is an RPC error.
//
// `readLaunch` checks deployment FIRST and stops there when the answer is no — it does
// not go on to derive PDAs and render their absence as data. That order is the point
// and it does not depend on what is deployed today: this comment has asserted "NOT
// DEPLOYED" and then "IS deployed", and each was believed for days after it stopped
// being true, which is the whole argument for the check living in code and not prose.
//
// ⚠ A CLOSED PROGRAM STILL READS AS EXECUTABLE, and that is the fourth lookalike.
// `solana program close` deletes the ProgramData account and leaves the 36-byte
// program stub in place, still executable-flagged — so `getAccountInfo` alone answers
// "a program is here" for an id that can never execute again. Both of this repo's
// mainnet ids are in exactly that state (closed 2026-08-13,
// docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md). `readDeployment` therefore follows the
// stub's pointer to ProgramData; a `deployed` verdict from it now means the bytecode
// account was READ, not that a flag was set.

import { PublicKey } from '@solana/web3.js';
import {
  BONDING_CURVE_SIZE,
  GLOBAL_CONFIG_SIZE,
  PROGRAM_ID,
  curvePda,
  decodeBondingCurve,
  decodeGlobalConfig,
  globalPda,
  isAmmConfigured,
  type BondingCurve,
  type DecodeFailure,
  type GlobalConfig,
} from './program';
import {
  effectiveReserves,
  lamportsUntilTarget,
  raiseCeiling,
  type CurveErrorCode,
  type CurveTerms,
} from './math';

// ── the RPC surface this module needs ────────────────────────────────────────

/** What `getAccountInfo` gives us. Extra fields are ignored. */
export interface AccountSnapshot {
  data: Uint8Array;
  /** The account's ACTUAL lamport balance — not the same as `real_sol_reserves`. */
  lamports: number;
  owner: PublicKey;
  /** Set by `Connection`; optional so a test fixture need not supply it. */
  executable?: boolean;
}

/**
 * The slice of web3.js's `Connection` used here. A real `Connection` satisfies it
 * structurally, and a test can supply a plain object — no network, no mocking of
 * a class.
 *
 * Every method on it is on the `/api/solrpc` proxy's allowlist
 * (frontend/api/solrpc.js:34-47). `getProgramAccounts` is NOT and never will be —
 * it is excluded as an unbounded scan — so **launches cannot be enumerated from
 * the browser at all**. Any "all launches" list is really a curated list and must
 * say so.
 */
export interface CurveRpc {
  getAccountInfo(address: PublicKey): Promise<AccountSnapshot | null>;
  getMinimumBalanceForRentExemption(dataLength: number): Promise<number>;
}

// ── results ──────────────────────────────────────────────────────────────────

/**
 * Why a read produced nothing. `unreadable` is the one that matters: it is a
 * statement about OUR connection, not about the launch, and it must never be
 * rendered as a finding.
 */
export type ReadFailure =
  | { kind: 'unreadable'; detail: string }
  | { kind: 'absent' }
  | { kind: 'undecodable'; reason: DecodeFailure };

export type Read<T> = { kind: 'ok'; value: T } | ReadFailure;

/**
 * Bound an RPC error before it reaches a page — the same reason
 * `tokenDossier.clipMessage` exists: a transport error can carry an entire
 * request body, and the leading sentence is the whole diagnostic value.
 */
export function clipDetail(e: unknown, max = 180): string {
  const s = e instanceof Error ? e.message : String(e);
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return 'the RPC call failed with no message';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Narrower than `Read<T>`: a raw fetch cannot fail to DECODE, only to arrive. */
type Fetched =
  | { kind: 'ok'; value: AccountSnapshot }
  | { kind: 'unreadable'; detail: string }
  | { kind: 'absent' };

async function fetchAccount(rpc: CurveRpc, address: PublicKey): Promise<Fetched> {
  try {
    const info = await rpc.getAccountInfo(address);
    return info ? { kind: 'ok', value: info } : { kind: 'absent' };
  } catch (e) {
    return { kind: 'unreadable', detail: clipDetail(e) };
  }
}

// ── program deployment ───────────────────────────────────────────────────────

/**
 * Is the program actually on this cluster?
 *
 * This is the first thing any surface calls, and anything other than `deployed` is
 * where it STOPS. Deriving PDAs afterwards and rendering their absence produces a
 * page that looks like an empty market instead of a program that is not there.
 */
export type Deployment =
  /** The stub is executable AND its ProgramData account was read. */
  | { kind: 'deployed'; executable: true }
  /**
   * An account EXISTS at the program id and it is not executable.
   *
   * Its own state, never folded into either neighbour. A program id is a public
   * address and anyone may transfer lamports to it, which makes `getAccountInfo`
   * return a non-null System-owned account while the program is still not there.
   * Calling that `deployed` turns a stranger's dust transfer into a live-protocol
   * badge; calling it `not-deployed` throws away the fact that something is
   * squatting the address.
   */
  | { kind: 'not-a-program'; owner: string }
  /**
   * The program was deployed under the upgradeable loader and then CLOSED. The
   * stub survives and is still executable-flagged; its ProgramData account is
   * gone, so there is no bytecode and the id can never hold a program again.
   *
   * Also its own state, and for a stronger reason than `not-a-program`: it is the
   * one that `getAccountInfo` gets ACTIVELY WRONG rather than merely
   * under-determines. `not-deployed` would understate it (a fresh id is a valid
   * deploy target; this one is spent forever) and `deployed` is the failure this
   * whole check exists to stop.
   */
  | { kind: 'closed'; programDataAddress: string }
  | { kind: 'not-deployed' }
  | { kind: 'unreadable'; detail: string };

/**
 * `BPFLoaderUpgradeab1e11111111111111111111111`. Programs under any OTHER loader
 * carry their bytecode in the program account itself and have no ProgramData, so
 * the second read below applies to this loader only.
 */
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);

/** A `Program` stub: `u32 enum(2) | 32-byte ProgramData address`. */
const PROGRAM_STUB_LEN = 36;
const PROGRAM_STUB_ENUM = 2;

export async function readDeployment(
  rpc: CurveRpc,
  programId: PublicKey = PROGRAM_ID,
): Promise<Deployment> {
  const r = await fetchAccount(rpc, programId);
  if (r.kind === 'unreadable') return r;
  if (r.kind === 'absent') return { kind: 'not-deployed' };
  // `executable` is OPTIONAL on `AccountSnapshot` so a fixture need not supply it,
  // and a missing flag must not read as `false` — that would report a real program
  // as a squatter. Absent means "the transport did not tell us", which is a read
  // failure about our own call, not a finding about the account.
  if (r.value.executable === undefined) {
    return { kind: 'unreadable', detail: 'the RPC response carried no `executable` flag for the program account' };
  }
  if (!r.value.executable) {
    return { kind: 'not-a-program', owner: r.value.owner.toBase58() };
  }
  // Under any loader but the upgradeable one there is no second account: the
  // bytecode is in the program account we just read, and the flag settles it.
  if (!r.value.owner.equals(BPF_LOADER_UPGRADEABLE_ID)) {
    return { kind: 'deployed', executable: true };
  }

  // ── the executable flag is not the answer here ────────────────────────────
  // Follow the stub's pointer. Anything that stops us reading ProgramData is
  // `unreadable`, never `deployed`: "we could not confirm the bytecode" and "the
  // bytecode is there" are the two answers this function most needs apart.
  const stub = r.value.data;
  if (stub.length < PROGRAM_STUB_LEN) {
    return {
      kind: 'unreadable',
      detail: `the program account is ${stub.length} bytes; an upgradeable program stub is ${PROGRAM_STUB_LEN}, so its ProgramData address could not be read`,
    };
  }
  const tag = new DataView(stub.buffer, stub.byteOffset, stub.byteLength).getUint32(0, true);
  if (tag !== PROGRAM_STUB_ENUM) {
    return {
      kind: 'unreadable',
      detail: `the program account's loader-state tag is ${tag}, not ${PROGRAM_STUB_ENUM} (Program), so its ProgramData address could not be read`,
    };
  }
  const programData = new PublicKey(stub.slice(4, PROGRAM_STUB_LEN));

  const pd = await fetchAccount(rpc, programData);
  if (pd.kind === 'unreadable') {
    return {
      kind: 'unreadable',
      detail: `the program stub was read but its ProgramData account ${programData.toBase58()} was not: ${pd.detail}`,
    };
  }
  if (pd.kind === 'absent') return { kind: 'closed', programDataAddress: programData.toBase58() };
  // `solana program close` zeroes the ProgramData account's lamports on the way to
  // deleting it. A surviving zero-lamport account is rent-exempt-failing and about
  // to be reaped, so it is not bytecode anyone can execute either.
  if (pd.value.lamports === 0) {
    return { kind: 'closed', programDataAddress: programData.toBase58() };
  }
  return { kind: 'deployed', executable: true };
}

// ── accounts ─────────────────────────────────────────────────────────────────

/**
 * Read `GlobalConfig`.
 *
 * `absent` is NOT an error: in a non-devnet build `deployer::ID` is the System
 * sentinel, so `initialize_global` cannot succeed and `global` legitimately does
 * not exist until an operator sets a real key and rebuilds (lib.rs:128-129).
 * Render it as "protocol not initialized", which is not a statement about any
 * launch.
 */
export async function readGlobal(
  rpc: CurveRpc,
  programId: PublicKey = PROGRAM_ID,
): Promise<Read<GlobalConfig>> {
  const r = await fetchAccount(rpc, globalPda(programId));
  if (r.kind !== 'ok') return r;
  const d = decodeGlobalConfig(r.value.data);
  return d.ok ? { kind: 'ok', value: d.value } : { kind: 'undecodable', reason: d.reason };
}

/** A curve, together with the things that only its ACCOUNT (not its fields) can tell us. */
export interface CurveAccount {
  address: PublicKey;
  curve: BondingCurve;
  /**
   * The PDA's actual lamport balance: `rent_exempt(BONDING_CURVE_SIZE) +
   * real_sol_reserves + anything anyone donated` (anyone can send lamports to a
   * derivable address).
   *
   * ⚠ Use `curve.realSolReserves` for progress and "SOL raised". Use THIS for the
   * migration budget check and the sell rent floor. They are not interchangeable
   * and this repo has the scars to prove it.
   */
  lamports: bigint;
}

/**
 * Read a launch's `BondingCurve`.
 *
 * `absent` means PRE-LAUNCH — this mint has no curve. It does NOT mean "0 SOL
 * raised", and rendering it as a zero invents a market that was never opened.
 */
export async function readCurve(
  rpc: CurveRpc,
  mint: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): Promise<Read<CurveAccount>> {
  const address = curvePda(mint, programId);
  const r = await fetchAccount(rpc, address);
  if (r.kind !== 'ok') return r;
  const d = decodeBondingCurve(r.value.data);
  if (!d.ok) return { kind: 'undecodable', reason: d.reason };
  return {
    kind: 'ok',
    value: { address, curve: d.value, lamports: BigInt(r.value.lamports) },
  };
}

/**
 * Rent floors for the two account sizes, read from the cluster rather than
 * hardcoded — the rent rate is a cluster parameter, not a constant of ours.
 * `null` on failure, because a guessed rent floor turns into a wrong "max sell".
 */
export async function readRentFloors(
  rpc: CurveRpc,
): Promise<{ global: bigint; curve: bigint } | null> {
  try {
    const [g, c] = await Promise.all([
      rpc.getMinimumBalanceForRentExemption(GLOBAL_CONFIG_SIZE),
      rpc.getMinimumBalanceForRentExemption(BONDING_CURVE_SIZE),
    ]);
    return { global: BigInt(g), curve: BigInt(c) };
  } catch {
    return null;
  }
}

// ── phase ────────────────────────────────────────────────────────────────────

/**
 * The five phases a launch can be in, plus the two ways we can fail to know.
 *
 * Evaluated top to bottom by {@link classifyLaunch}; first match wins. Note there
 * is deliberately NO "migrating" phase: migration is one atomic instruction
 * (lib.rs:693-1188, and lib.rs:32-38 explains that splitting it was a total-loss
 * bug), so a curve is either open or `complete` and nothing in between exists on
 * chain. A UI may show "migrating…" only as local optimistic state while its own
 * transaction is in flight.
 */
export type LaunchPhase =
  /** The program is not on this cluster. Say so plainly and stop. */
  | { kind: 'not-deployed' }
  /**
   * Something occupies the program id but is not a program. Neither "deployed"
   * nor "nothing here" — say what was actually found (see {@link Deployment}).
   */
  | { kind: 'not-a-program'; owner: string }
  /**
   * The program was closed. Distinct from `not-deployed` in the direction that
   * matters to a reader: the rail RAN here and is gone permanently, rather than
   * having not started yet. Copy must not imply it is coming back at this id.
   */
  | { kind: 'closed'; programDataAddress: string }
  /** A read failed or timed out. Say the read failed. NEVER fall through to a later phase. */
  | { kind: 'unreadable'; detail: string }
  /**
   * The `global` account does not exist. Not an error about this launch — in a
   * non-devnet build `initialize_global` cannot even be called (lib.rs:128-129).
   * An `global` that exists but does not DECODE is `unreadable`, not this.
   */
  | { kind: 'protocol-not-initialized' }
  /** No curve at this mint. Not "0 SOL raised". */
  | { kind: 'pre-launch' }
  /** `complete === true`. Trading happens on `pool` now. */
  | { kind: 'graduated'; pool: PublicKey }
  /**
   * Fully funded, NOT graduated. Buys revert with `AwaitingMigration` (6019);
   * **sells still work**; anyone may call `migrate_to_amm`.
   */
  | { kind: 'awaiting-migration' }
  /**
   * Target met, still raising the migration reserve. Buys AND sells both work.
   * Do NOT offer a migrate button here: it passes `NotReadyToGraduate` but will
   * almost certainly fail the lamport-budget check (lib.rs:737-743).
   */
  | { kind: 'at-target' }
  /** Bonding. Show progress against `target + reserve`. */
  | { kind: 'trading' };

/** A launch as far as we could establish it. `paused` overlays the trading phases. */
export interface LaunchState {
  phase: LaunchPhase;
  /**
   * `global.paused`. Buys and migration are halted; **SELLS ARE NOT** — `sell` is
   * deliberately ungated (lib.rs:563-564). A paused UI must keep sell available
   * and say so, never grey it out.
   *
   * `null` when `global` could not be read — which is not the same as `false`.
   */
  paused: boolean | null;
  /** Whether a graduation venue is configured at all (lib.rs:184-187). `null` if unknown. */
  ammConfigured: boolean | null;
  global: GlobalConfig | null;
  curve: CurveAccount | null;
}

/** Classify already-fetched state. Pure, so the phase table is testable without a network. */
export function classifyLaunch(
  deployment: Deployment,
  global: Read<GlobalConfig>,
  curve: Read<CurveAccount>,
): LaunchState {
  const bare = { paused: null, ammConfigured: null, global: null, curve: null } as const;

  if (deployment.kind === 'unreadable') {
    return { ...bare, phase: { kind: 'unreadable', detail: deployment.detail } };
  }
  if (deployment.kind === 'not-deployed') return { ...bare, phase: { kind: 'not-deployed' } };
  if (deployment.kind === 'not-a-program') {
    return { ...bare, phase: { kind: 'not-a-program', owner: deployment.owner } };
  }
  if (deployment.kind === 'closed') {
    return { ...bare, phase: { kind: 'closed', programDataAddress: deployment.programDataAddress } };
  }

  if (global.kind === 'unreadable') {
    return { ...bare, phase: { kind: 'unreadable', detail: global.detail } };
  }
  if (global.kind === 'absent') return { ...bare, phase: { kind: 'protocol-not-initialized' } };
  if (global.kind === 'undecodable') {
    // The account EXISTS and we cannot read it. Calling that "not initialized"
    // would state something false about the protocol; it is a read failure.
    return { ...bare, phase: { kind: 'unreadable', detail: `global account is ${global.reason}` } };
  }

  const g = global.value;
  const overlay = {
    paused: g.paused,
    ammConfigured: isAmmConfigured(g),
    global: g,
  };

  if (curve.kind === 'unreadable') {
    return { ...overlay, curve: null, phase: { kind: 'unreadable', detail: curve.detail } };
  }
  if (curve.kind === 'absent') return { ...overlay, curve: null, phase: { kind: 'pre-launch' } };
  if (curve.kind === 'undecodable') {
    // Something is at the curve address but it is not a BondingCurve. That is a
    // failure to read this launch, not evidence that the launch is anything.
    return {
      ...overlay,
      curve: null,
      phase: { kind: 'unreadable', detail: `curve account is ${curve.reason}` },
    };
  }

  const c = curve.value.curve;
  const ceiling = raiseCeiling(c);
  const phase: LaunchPhase = c.complete
    ? { kind: 'graduated', pool: c.pool }
    : !ceiling.ok
      ? { kind: 'unreadable', detail: `curve terms overflow a u64 (${ceiling.error})` }
      : c.realSolReserves >= ceiling.value
        ? { kind: 'awaiting-migration' }
        : c.realSolReserves >= c.graduationTargetLamports
          ? { kind: 'at-target' }
          : { kind: 'trading' };

  return { ...overlay, curve: curve.value, phase };
}

/**
 * Fetch and classify a launch in one call — the entry point a page uses.
 *
 * Order matters: deployment first, and a `not-deployed` or `unreadable` answer
 * short-circuits so no PDA is ever derived against a program that is not there.
 */
export async function readLaunch(
  rpc: CurveRpc,
  mint: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): Promise<LaunchState> {
  const deployment = await readDeployment(rpc, programId);
  if (deployment.kind !== 'deployed') {
    return classifyLaunch(deployment, { kind: 'absent' }, { kind: 'absent' });
  }
  const [global, curve] = await Promise.all([
    readGlobal(rpc, programId),
    readCurve(rpc, mint, programId),
  ]);
  return classifyLaunch(deployment, global, curve);
}

// ── derived display numbers ──────────────────────────────────────────────────

/**
 * The numbers a UI wants, all of them derivable from the curve alone.
 *
 * Deliberately absent: price in USD, market cap, FDV, holder count, 24h volume,
 * trade history. NONE of them are in program state — there is no oracle and no
 * indexer, and `getProgramAccounts` is blocked by the proxy allowlist. Inventing
 * one here is how it ends up on a page as fact.
 */
export interface CurveProgress {
  /** Lamports actually raised: `real_sol_reserves`, the FIELD. */
  raisedLamports: bigint;
  /**
   * `graduation_target + migration_reserve` — what `buy` actually caps against
   * (lib.rs:466-469). Using `graduation_target` alone shows 100% while buys still
   * succeed.
   */
  ceilingLamports: bigint;
  /**
   * `raised / ceiling` in bps, clamped to 10_000. Integer bps, not a float ratio.
   * `null` when there is no ratio to take (a zero ceiling, which
   * `initialize_global` rejects but which a decoder must not assume away).
   */
  progressBps: number | null;
  /**
   * What a buyer must SEND to finish the raise — already grossed up for the fee,
   * so it is what they must send, not what lands.
   *
   * Three outcomes, kept apart on purpose: an amount · `fully-funded`, which is
   * `AwaitingMigration` and is NOT graduated · `unknown`, which is an arithmetic
   * failure and says nothing about the launch.
   */
  remainingToSend:
    | { kind: 'amount'; lamports: bigint }
    | { kind: 'fully-funded' }
    | { kind: 'unknown'; error: CurveErrorCode };
  /**
   * Tokens sold so far, in raw base units. Needs `token_total_supply` from
   * `global` — the curve does not carry it — so it is `null` without one.
   * Divide by the MINT's decimals, which are not stored on either account.
   */
  tokensSold: bigint | null;
  /**
   * Spot price as an exact lamports-per-base-unit fraction
   * (`effective_sol / effective_tokens`). Returned as a numerator/denominator
   * pair rather than a number: any division here would round, and this is a
   * DISPLAY ratio, not a trade — every real trade moves it.
   */
  spot: { numerator: bigint; denominator: bigint } | null;
}

export function curveProgress(c: CurveTerms, tokenTotalSupply?: bigint): CurveProgress | null {
  const ceiling = raiseCeiling(c);
  if (!ceiling.ok) return null;
  const remaining = lamportsUntilTarget(c.realSolReserves, ceiling.value, c.tradeFeeBps);
  const eff = effectiveReserves(c);

  const progressBps =
    ceiling.value === 0n
      ? null
      : Number(
          c.realSolReserves >= ceiling.value
            ? 10_000n
            : (c.realSolReserves * 10_000n) / ceiling.value,
        );

  return {
    raisedLamports: c.realSolReserves,
    ceilingLamports: ceiling.value,
    progressBps,
    remainingToSend: !remaining.ok
      ? { kind: 'unknown', error: remaining.error }
      : remaining.value === null
        ? { kind: 'fully-funded' }
        : { kind: 'amount', lamports: remaining.value },
    tokensSold:
      tokenTotalSupply !== undefined && tokenTotalSupply >= c.realTokenReserves
        ? tokenTotalSupply - c.realTokenReserves
        : null,
    spot: eff.ok && eff.value.tokens > 0n
      ? { numerator: eff.value.sol, denominator: eff.value.tokens }
      : null,
  };
}

/**
 * Can `migrate_to_amm` succeed right now?
 *
 * Every condition is read-only and comes from lib.rs:695-743. Condition 5 is the
 * binding one in practice and it reads the PDA's ACTUAL lamport balance, not
 * `real_sol_reserves`.
 *
 * ⚠ "eligible now" is a MOMENTARY claim, and it is not a promise. A 1-lamport
 * `sell` front-run flips it on an exactly-funded curve, and `sell` is unpausable
 * by design (MIGRATE_DESIGN.md:294-304). That is a stall, not a brick: present a
 * failed migration as RETRYABLE, never as "this launch is broken".
 */
export type MigrationEligibility =
  | { eligible: true }
  | { eligible: false; blockedBy: 'paused' | 'amm-not-configured' | 'already-complete' | 'below-target' | 'reserve-too-low' }
  | { eligible: null; detail: string };

export function migrationEligibility(
  global: GlobalConfig,
  curve: CurveAccount,
  curveRentExemptLamports: bigint | null,
): MigrationEligibility {
  if (global.paused) return { eligible: false, blockedBy: 'paused' };
  if (!isAmmConfigured(global)) return { eligible: false, blockedBy: 'amm-not-configured' };

  const c = curve.curve;
  if (c.complete) return { eligible: false, blockedBy: 'already-complete' };
  if (c.realSolReserves < c.graduationTargetLamports) {
    return { eligible: false, blockedBy: 'below-target' };
  }
  // Without the rent floor there is no honest answer — a guess here is the
  // difference between offering a button that works and one that always fails.
  if (curveRentExemptLamports === null) {
    return { eligible: null, detail: 'the curve account rent floor could not be read' };
  }
  const budget = curve.lamports - curveRentExemptLamports;
  const needed = c.graduationTargetLamports + c.migrationReserveLamports;
  return budget >= needed ? { eligible: true } : { eligible: false, blockedBy: 'reserve-too-low' };
}
