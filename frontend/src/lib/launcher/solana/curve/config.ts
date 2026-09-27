// Pre-flighting `initialize_global` / `update_global` locally.
//
// An operator should learn that the program will reject a config BEFORE a multisig
// ceremony, not afterwards as a bare error code. Every check below mirrors one the
// program actually performs, in the order lib.rs performs it.
//
// THE ARITHMETIC IS NOT HERE. `max_reachable_real_sol`,
// `graduation_price_ratio_bps` and `continuity_target` all come from `math.ts` —
// the single differentially-proven port of curve.rs. An earlier draft of this
// module carried its own copies; they were the same functions written twice, which
// is how the two drift.
//
// One thing that draft got RIGHT and the core did not: it emulated Rust's `u128`
// ceiling with a `checked_mul`, and the core did not. The core is fixed and the
// fixture now covers that branch — see `math.ts`'s `U128_MAX` and the fixture
// header. Recorded here because the lesson is the reason for consolidating, not an
// argument against it: two implementations meant one of them was right and nobody
// knew which.

import {
  BPS_DENOMINATOR,
  MAX_FEE_BPS,
  MAX_PLATFORM_RESERVE_BPS,
  PRICE_CONTINUITY_BAND_BPS,
  U64_MAX,
  continuityTarget,
  curveSupply,
  graduationPriceRatioBps,
  maxReachableRealSol,
  type CurveResult,
} from './math';

/**
 * `MIN_MIGRATION_RESERVE_LAMPORTS` (state.rs) — the measured floor for what
 * migration itself costs in rent and fees. Below it, a launch raises its target
 * and then cannot afford to graduate.
 */
export const MIN_MIGRATION_RESERVE_LAMPORTS = 42_156_720n;

/** The parameters `initialize_global` validates (lib.rs:188-248). */
export interface LaunchEconomicsParams {
  tradeFeeBps: bigint;
  initialVirtualSol: bigint;
  initialVirtualToken: bigint;
  tokenTotalSupply: bigint;
  graduationTargetLamports: bigint;
  migrationReserveLamports: bigint;
  /**
   * Share of each launch's supply held back for the protocol, in bps (cap 1000).
   * Required, with no default: it changes the listing price, so it has to be chosen.
   */
  platformReserveBps: bigint;
}

/**
 * Every diagnostic an operator needs before signing, plus every reason the program
 * would reject the config.
 *
 * `null` on a diagnostic means IT COULD NOT BE COMPUTED (degenerate or overflowing
 * inputs), never `0`. An empty `problems` array means the program's config guards
 * all pass; it is NOT a claim that the resulting economics are wise.
 */
export interface LaunchEconomicsReport {
  problems: string[];
  /**
   * The part of the supply the curve sells: `tokenTotalSupply` minus the platform
   * reserve. Every number below is computed against THIS, not the whole supply.
   */
  curveTokenSupply: bigint | null;
  /** Tokens each launch pays to the platform treasury inside create_launch; never sold, never pooled. */
  platformReserveTokens: bigint | null;
  maxReachableRealSol: bigint | null;
  graduationPriceRatioBps: bigint | null;
  /** The target that would list at exactly the curve price, for the same book. */
  continuityTarget: bigint | null;
}

/** `CurveResult` → `bigint | null`. A refusal is an unknown, never a zero. */
const orNull = (r: CurveResult<bigint>): bigint | null => (r.ok ? r.value : null);

/**
 * Pre-flight a config against every guard the program applies.
 *
 * Mirrors, in order: the fee ceiling, the non-zero parameter checks, then
 * `check_launch_economics` — the platform-reserve cap, the reachability check
 * against target PLUS reserve, the migration-reserve floor and the ±5%
 * listing-price band.
 *
 * ⚠ Reachability, the listing ratio and the continuity target are all taken
 * against the CURVE supply (total minus the platform reserve). The reserve goes to
 * the platform treasury when the launch is created, never trades on the curve and
 * never goes into the pool, so checking against the whole
 * supply passes a config that lists ~4.9% above the curve at a 3.69% reserve —
 * inside the band, so nothing would warn.
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

  // The program maps curve.rs's `ReserveTooHigh` to InvalidParameter.
  const split = curveSupply(p.tokenTotalSupply, p.platformReserveBps);
  if (!split.ok) {
    problems.push(
      split.error === 'ReserveTooHigh'
        ? `InvalidParameter: platform_reserve_bps ${p.platformReserveBps} exceeds MAX_PLATFORM_RESERVE_BPS ${MAX_PLATFORM_RESERVE_BPS}`
        : `${split.error}: the platform reserve could not be carved from token_total_supply`,
    );
  }
  // `null` when there is no curve supply to check against. The reason is already in
  // `problems`, so the checks below stay quiet rather than pile on.
  const curveTokens = split.ok ? split.value.curveTokens : null;

  const maxReachable =
    curveTokens === null
      ? null
      : orNull(maxReachableRealSol(p.initialVirtualSol, p.initialVirtualToken, curveTokens));
  const required = p.graduationTargetLamports + p.migrationReserveLamports;
  if (required > U64_MAX) {
    problems.push('Overflow: graduation_target + migration_reserve exceeds u64');
  } else if (curveTokens === null) {
    // reported above
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

  const ratio =
    curveTokens === null
      ? null
      : orNull(
          graduationPriceRatioBps(
            p.initialVirtualSol,
            p.initialVirtualToken,
            curveTokens,
            p.graduationTargetLamports,
            p.migrationReserveLamports,
          ),
        );
  const lo = BPS_DENOMINATOR - PRICE_CONTINUITY_BAND_BPS;
  const hi = BPS_DENOMINATOR + PRICE_CONTINUITY_BAND_BPS;
  if (curveTokens === null) {
    // reported above
  } else if (ratio === null) {
    problems.push('GraduationPriceGap: the listing/curve price ratio could not be computed');
  } else if (ratio < lo || ratio > hi) {
    problems.push(
      `GraduationPriceGap: lists at ${ratio} bps of the final curve price (must be ${lo}..=${hi})`,
    );
  }

  return {
    problems,
    curveTokenSupply: curveTokens,
    platformReserveTokens: split.ok ? split.value.reserveTokens : null,
    maxReachableRealSol: maxReachable,
    graduationPriceRatioBps: ratio,
    continuityTarget:
      curveTokens === null
        ? null
        : orNull(
            continuityTarget(
              p.initialVirtualSol,
              p.initialVirtualToken,
              curveTokens,
              p.migrationReserveLamports,
            ),
          ),
  };
}

// ── update_global ────────────────────────────────────────────────────────────

/**
 * The `update_global` arguments that can fail a guard. Every field is optional;
 * an omitted one encodes as `None` and the program leaves it untouched.
 */
export interface UpdateGlobalEconomics {
  tradeFeeBps?: bigint;
  graduationTargetLamports?: bigint;
  migrationReserveLamports?: bigint;
  newInitialVirtualSol?: bigint;
  newPlatformReserveBps?: bigint;
}

/**
 * The on-chain values an update is resolved against — the same seven fields
 * `initialize_global` validates, read back off `GlobalConfig`.
 *
 * A distinct name rather than a reuse of {@link LaunchEconomicsParams} at the call
 * site, because the two are semantically opposite: one is what the operator is
 * PROPOSING, the other is what the chain currently HOLDS, and swapping them at a
 * call site would validate the wrong thing while typechecking cleanly.
 */
export type CurrentGlobalEconomics = LaunchEconomicsParams;

export interface UpdateGlobalCheck {
  problems: string[];
  /**
   * The post-update economics report, or `null` when the update does not touch
   * target / reserve / virtual-SOL / platform reserve — because the program does
   * not run `check_launch_economics` in that case either, and running it anyway
   * could refuse an update the program would have accepted.
   */
  economics: LaunchEconomicsReport | null;
}

/**
 * Pre-flight `update_global` against every guard it applies (lib.rs:287-345).
 *
 * ⚠ THE FEE CEILING IS ITS OWN GUARD, AND IT IS UNCONDITIONAL. The program checks
 * `require!(f <= MAX_FEE_BPS)` inside the `trade_fee_bps` branch (lib.rs:288-291),
 * BEFORE and independently of the target/reserve/virtual-SOL block. The operator
 * harness used to fold the fee into that block's report, so `--fee-bps` on its own
 * ran no ceiling check at all: `--fee-bps 5000` printed a complete transaction
 * carrying `tradeFeeBps: 5000` that the program rejects on sight.
 *
 * Structured as two independent branches for exactly that reason — a guard that
 * fires only when an unrelated argument happens to be present is not a guard.
 */
export function checkUpdateGlobal(
  args: UpdateGlobalEconomics,
  current: CurrentGlobalEconomics,
): UpdateGlobalCheck {
  const problems: string[] = [];

  // Branch 1 — lib.rs:288-291. Unconditional on the fee being supplied at all.
  if (args.tradeFeeBps !== undefined && args.tradeFeeBps > MAX_FEE_BPS) {
    problems.push(`FeeTooHigh: trade_fee_bps ${args.tradeFeeBps} exceeds MAX_FEE_BPS ${MAX_FEE_BPS}`);
  }

  // Branch 2. Target, reserve, virtual-SOL and the platform reserve are validated
  // TOGETHER against the POST-update values, and only when one of them moves.
  //
  // The platform reserve belongs here even on its own: it changes the curve supply,
  // and the curve supply moves the listing price. A reserve-only update that skipped
  // this would let every later launch list outside the band.
  const touchesEconomics =
    args.graduationTargetLamports !== undefined ||
    args.migrationReserveLamports !== undefined ||
    args.newInitialVirtualSol !== undefined ||
    args.newPlatformReserveBps !== undefined;
  if (!touchesEconomics) return { problems, economics: null };

  const resolved: LaunchEconomicsParams = {
    tradeFeeBps: args.tradeFeeBps ?? current.tradeFeeBps,
    initialVirtualSol: args.newInitialVirtualSol ?? current.initialVirtualSol,
    // Neither is settable by `update_global` (lib.rs:276-285) — carried through so
    // the reachability and continuity checks see the real book.
    initialVirtualToken: current.initialVirtualToken,
    tokenTotalSupply: current.tokenTotalSupply,
    graduationTargetLamports: args.graduationTargetLamports ?? current.graduationTargetLamports,
    migrationReserveLamports: args.migrationReserveLamports ?? current.migrationReserveLamports,
    platformReserveBps: args.newPlatformReserveBps ?? current.platformReserveBps,
  };
  const economics = checkLaunchEconomics(resolved);
  // De-duplicate: `checkLaunchEconomics` reports the fee ceiling too, and branch 1
  // may already have said it.
  for (const p of economics.problems) {
    if (!problems.includes(p)) problems.push(p);
  }
  return { problems, economics };
}
