import { describe, it, expect } from 'vitest';
import {
  MIN_MIGRATION_RESERVE_LAMPORTS,
  checkLaunchEconomics,
  checkUpdateGlobal,
  type CurrentGlobalEconomics,
  type LaunchEconomicsParams,
} from './config';
import {
  continuityTarget,
  graduationPriceRatioBps,
  maxReachableRealSol,
  type CurveResult,
} from './math';

// Values below are the output of the REAL `curve.rs`, compiled on the host with
// `rustc --edition 2021` (its own suite: 23/23 green, re-run 2026-08-01) and
// captured directly — not computed by this port. The port itself is diffed against
// 4,071 generated vectors in math.test.ts; these state the same agreement as
// properties a reviewer can read without decoding a vector.
const V_SOL = 30_000_000_000n; // 30 SOL
const V_TOK = 1_073_000_000_000_000n;
const SUPPLY = 1_000_000_000_000_000n;

const unwrap = (r: CurveResult<bigint>): bigint => {
  if (!r.ok) throw new Error(`expected a value, got ${r.error}`);
  return r.value;
};

describe('config math — pinned against the real Rust', () => {
  it('maxReachableRealSol', () => {
    expect(unwrap(maxReachableRealSol(V_SOL, V_TOK, SUPPLY))).toBe(27_958_993_476n);
  });

  it('continuityTarget at the minimum migration reserve', () => {
    expect(unwrap(continuityTarget(V_SOL, V_TOK, SUPPLY, MIN_MIGRATION_RESERVE_LAMPORTS))).toBe(
      11_685_689_681n,
    );
  });

  it('a launch at its continuity target lists at ~the curve price', () => {
    expect(
      unwrap(
        graduationPriceRatioBps(V_SOL, V_TOK, SUPPLY, 11_685_689_681n, MIN_MIGRATION_RESERVE_LAMPORTS),
      ),
    ).toBe(9_999n);
  });

  it("reproduces this repo's original ~7x listing gap (30 vSOL against a 2 SOL target)", () => {
    // MIGRATE_DESIGN.md's "opened at ~14% of the curve's final price", exactly.
    expect(unwrap(graduationPriceRatioBps(V_SOL, V_TOK, SUPPLY, 2_000_000_000n, 250_000_000n))).toBe(
      1_398n,
    );
  });

  it('the migration reserve moves the ratio — ignoring it misprices every launch that uses one', () => {
    const withReserve = unwrap(
      graduationPriceRatioBps(V_SOL, V_TOK, SUPPLY, 2_000_000_000n, 250_000_000n),
    );
    const without = unwrap(graduationPriceRatioBps(V_SOL, V_TOK, SUPPLY, 2_000_000_000n, 0n));
    expect(withReserve).not.toBe(without);
    expect(without).toBe(1_395n);
  });

  it('a target past the curve ceiling is InsufficientLiquidity, not a number', () => {
    expect(graduationPriceRatioBps(V_SOL, V_TOK, SUPPLY, 85_000_000_000n, 0n)).toEqual({
      ok: false,
      error: 'InsufficientLiquidity',
    });
  });

  it('rejects degenerate books with ZeroAmount', () => {
    for (const r of [
      maxReachableRealSol(0n, V_TOK, SUPPLY),
      maxReachableRealSol(V_SOL, 0n, SUPPLY),
      maxReachableRealSol(V_SOL, V_TOK, 0n),
      continuityTarget(0n, V_TOK, SUPPLY, 0n),
    ]) {
      expect(r).toEqual({ ok: false, error: 'ZeroAmount' });
    }
  });

  // ⚠ THE BUG THIS CONSOLIDATION FOUND. `curve.rs` holds these two in `u128` and
  // guards every multiply with `checked_mul`; `bigint` has no ceiling, so the port
  // returned a confident number where the program returns `Overflow`. The operator
  // slice's own (now deleted) copy emulated the ceiling and was RIGHT; the core did
  // not and was WRONG. Verified against the compiled Rust before the fix:
  //   graduationPriceRatioBps(2^64−1, 2^64−1, 2^64−1, 2^63, 0)
  //     Rust  → Err(Overflow)      port → ok(13333)
  //   continuityTarget(2^64−1, 2^64−1, 2^64−1, 0)
  //     Rust  → Err(Overflow)      port → ok(7640891576956012808)
  it('emulates the u128 ceiling the Rust checks for, instead of returning a big number', () => {
    const MAX = (1n << 64n) - 1n;
    expect(graduationPriceRatioBps(MAX, MAX, MAX, MAX, MAX)).toEqual({
      ok: false,
      error: 'Overflow',
    });
    expect(graduationPriceRatioBps(MAX, MAX, MAX, 1n << 63n, 0n)).toEqual({
      ok: false,
      error: 'Overflow',
    });
    expect(continuityTarget(MAX, MAX, MAX, 0n)).toEqual({ ok: false, error: 'Overflow' });
  });

  it('still answers for a book that fits — the ceiling is a boundary, not a blanket refusal', () => {
    const MAX = (1n << 64n) - 1n;
    // Vs·(Vt+S) = 2^60·(2^65−2) ≈ 2^125, comfortably inside u128. Rust: Ok(477555723559750800).
    expect(unwrap(continuityTarget(1n << 60n, MAX, MAX, 0n))).toBe(477_555_723_559_750_800n);
  });
});

describe('checkLaunchEconomics — pre-flight for initialize_global', () => {
  const good: LaunchEconomicsParams = {
    tradeFeeBps: 100n,
    initialVirtualSol: V_SOL,
    initialVirtualToken: V_TOK,
    tokenTotalSupply: SUPPLY,
    graduationTargetLamports: 11_685_689_681n,
    migrationReserveLamports: MIN_MIGRATION_RESERVE_LAMPORTS,
    // No reserve: the book these numbers were pinned against. The reserve has its
    // own describe block below.
    platformReserveBps: 0n,
  };

  it('accepts a config the program would accept, and reports the diagnostics', () => {
    const r = checkLaunchEconomics(good);
    expect(r.problems).toEqual([]);
    expect(r.graduationPriceRatioBps).toBe(9_999n);
    expect(r.maxReachableRealSol).toBe(27_958_993_476n);
    expect(r.continuityTarget).toBe(11_685_689_681n);
  });

  it('rejects a fee above MAX_FEE_BPS', () => {
    expect(checkLaunchEconomics({ ...good, tradeFeeBps: 1_001n }).problems.join()).toMatch(
      /FeeTooHigh/,
    );
  });

  it('rejects a migration reserve below the rent floor', () => {
    const r = checkLaunchEconomics({ ...good, migrationReserveLamports: 0n });
    expect(r.problems.join()).toMatch(/MigrationReserveTooLow/);
  });

  it('rejects an unreachable target', () => {
    const r = checkLaunchEconomics({ ...good, graduationTargetLamports: 900_000_000_000n });
    expect(r.problems.join()).toMatch(/GraduationTargetUnreachable/);
  });

  it('rejects a config that would gap at listing — the ~7x drop guard', () => {
    const r = checkLaunchEconomics({ ...good, graduationTargetLamports: 2_000_000_000n });
    expect(r.problems.join()).toMatch(/GraduationPriceGap/);
    expect(r.graduationPriceRatioBps).toBe(1_395n);
  });

  it('rejects zero parameters', () => {
    const r = checkLaunchEconomics({ ...good, initialVirtualSol: 0n });
    expect(r.problems.join()).toMatch(/InvalidParameter/);
  });

  it('reports an uncomputable diagnostic as null, never as 0', () => {
    const r = checkLaunchEconomics({ ...good, initialVirtualToken: 0n });
    expect(r.maxReachableRealSol).toBeNull();
    expect(r.graduationPriceRatioBps).toBeNull();
    expect(r.continuityTarget).toBeNull();
  });
});

describe('checkUpdateGlobal — the guards update_global actually applies', () => {
  const current: CurrentGlobalEconomics = {
    tradeFeeBps: 100n,
    initialVirtualSol: V_SOL,
    initialVirtualToken: V_TOK,
    tokenTotalSupply: SUPPLY,
    graduationTargetLamports: 11_685_689_681n,
    migrationReserveLamports: MIN_MIGRATION_RESERVE_LAMPORTS,
    platformReserveBps: 0n,
  };

  // ⚠ THE DEFECT THIS EXISTS FOR. The operator harness gated its whole pre-flight
  // behind `target || reserve || virtual-sol`, so `--fee-bps` on its own reached no
  // ceiling check: `--fee-bps 5000` printed a complete transaction carrying
  // `tradeFeeBps: 5000` while lib.rs:288-291 requires `f <= MAX_FEE_BPS` (1000).
  it('catches an over-ceiling fee when the fee is the ONLY thing being changed', () => {
    const r = checkUpdateGlobal({ tradeFeeBps: 5_000n }, current);
    expect(r.problems.join()).toMatch(/FeeTooHigh/);
    // …and it did not need to run the economics block to notice.
    expect(r.economics).toBeNull();
  });

  it('catches it at the boundary, and only past the boundary', () => {
    expect(checkUpdateGlobal({ tradeFeeBps: 1_000n }, current).problems).toEqual([]);
    expect(checkUpdateGlobal({ tradeFeeBps: 1_001n }, current).problems.join()).toMatch(/FeeTooHigh/);
  });

  it('still catches it when other fields move too', () => {
    const r = checkUpdateGlobal(
      { tradeFeeBps: 5_000n, graduationTargetLamports: 11_685_689_681n },
      current,
    );
    expect(r.problems.join()).toMatch(/FeeTooHigh/);
    // Reported once, not twice — both branches can see the fee.
    expect(r.problems.filter((p) => p.includes('FeeTooHigh')).length).toBe(1);
  });

  it('accepts a legal fee-only change without inventing a problem', () => {
    expect(checkUpdateGlobal({ tradeFeeBps: 300n }, current).problems).toEqual([]);
  });

  it('does not run the economics block for an update that cannot move the economics', () => {
    // The program only calls `check_launch_economics` in the target/reserve/vsol
    // branch. Running it anyway would let a pre-existing config quirk refuse an
    // unrelated update the program would have accepted.
    expect(checkUpdateGlobal({}, current).economics).toBeNull();
    expect(checkUpdateGlobal({ tradeFeeBps: 100n }, current).economics).toBeNull();
  });

  it('resolves the post-update pair against chain state, not against the flags alone', () => {
    // Raising the target ALONE must still be validated against the CURRENT reserve —
    // both are raised by traders, so both count toward the curve ceiling.
    const r = checkUpdateGlobal({ graduationTargetLamports: 900_000_000_000n }, current);
    expect(r.problems.join()).toMatch(/GraduationTargetUnreachable/);
    expect(r.economics).not.toBeNull();
  });

  it('validates a virtual-SOL retune through the continuity band', () => {
    // `initial_virtual_sol` is settable HERE and nowhere else, and the continuity
    // target is proportional to it — so moving it without moving the target gaps.
    const r = checkUpdateGlobal({ newInitialVirtualSol: 60_000_000_000n }, current);
    expect(r.problems.join()).toMatch(/GraduationPriceGap/);
  });
});

// ── the platform reserve ─────────────────────────────────────────────────────
//
// 3.69% of every launch's supply is held back for the protocol. It sits in the
// curve's vault but is never sold on the curve and never goes into the pool, so
// every check has to be run against the CURVE supply. These fail if the checks
// quietly go back to using the whole supply.

describe('checkLaunchEconomics — the platform reserve', () => {
  const RESERVE_BPS = 369n;
  // Vt × (1 − 3.69%): the retune that keeps the SOL raise unchanged.
  const SCALED_V_TOK = 1_033_406_300_000_000n;
  const retuned: LaunchEconomicsParams = {
    tradeFeeBps: 100n,
    initialVirtualSol: V_SOL,
    initialVirtualToken: SCALED_V_TOK,
    tokenTotalSupply: SUPPLY,
    graduationTargetLamports: 11_685_689_681n,
    migrationReserveLamports: MIN_MIGRATION_RESERVE_LAMPORTS,
    platformReserveBps: RESERVE_BPS,
  };

  it('reports the split, and a retuned 3.69% config lists at the curve price', () => {
    const r = checkLaunchEconomics(retuned);
    expect(r.problems).toEqual([]);
    expect(r.curveTokenSupply).toBe(963_100_000_000_000n);
    expect(r.platformReserveTokens).toBe(36_900_000_000_000n);
    expect(r.graduationPriceRatioBps).toBe(9_999n);
    // Same target as with no reserve, to the lamport: the raise does not move.
    expect(r.continuityTarget).toBe(11_685_689_681n);
    expect(r.maxReachableRealSol).toBe(27_958_993_476n);
  });

  it('measures the listing ratio against the curve supply, not the whole supply', () => {
    // The same book with the reserve carved and Vt NOT retuned. Against the whole
    // supply this reads 9999; against what the curve actually sells it reads 10488,
    // 4.9% above the curve, and still inside the band.
    const r = checkLaunchEconomics({ ...retuned, initialVirtualToken: V_TOK });
    expect(r.graduationPriceRatioBps).toBe(10_488n);
    expect(r.continuityTarget).toBe(11_312_638_249n);
    expect(r.problems).toEqual([]);
  });

  it('catches a reserve large enough to gap the listing', () => {
    const r = checkLaunchEconomics({
      ...retuned,
      initialVirtualToken: V_TOK,
      platformReserveBps: 1_000n,
    });
    expect(r.graduationPriceRatioBps).toBe(11_498n);
    expect(r.problems.join()).toMatch(/GraduationPriceGap/);
  });

  it('measures reachability against the curve supply', () => {
    // 26 SOL is under the whole-supply ceiling (27.96) and over the 10%-reserve
    // curve ceiling (25.16), so only the curve-supply check refuses it.
    const target = 26_000_000_000n - MIN_MIGRATION_RESERVE_LAMPORTS;
    const book = { ...retuned, initialVirtualToken: V_TOK, graduationTargetLamports: target };
    const whole = checkLaunchEconomics({ ...book, platformReserveBps: 0n });
    expect(whole.problems.join()).not.toMatch(/GraduationTargetUnreachable/);
    const carved = checkLaunchEconomics({ ...book, platformReserveBps: 1_000n });
    expect(carved.maxReachableRealSol).toBe(25_163_094_128n);
    expect(carved.problems.join()).toMatch(/GraduationTargetUnreachable/);
  });

  it('caps the reserve at 10%, like the EVM launcher', () => {
    expect(checkLaunchEconomics({ ...retuned, platformReserveBps: 1_000n }).problems.join()).not.toMatch(
      /platform_reserve_bps/,
    );
    const over = checkLaunchEconomics({ ...retuned, platformReserveBps: 1_001n });
    expect(over.problems).toEqual([
      'InvalidParameter: platform_reserve_bps 1001 exceeds MAX_PLATFORM_RESERVE_BPS 1000',
    ]);
    // Nothing downstream can be computed without a curve supply: unknown, not zero.
    expect(over.curveTokenSupply).toBeNull();
    expect(over.platformReserveTokens).toBeNull();
    expect(over.graduationPriceRatioBps).toBeNull();
    expect(over.continuityTarget).toBeNull();
  });
});

describe('checkUpdateGlobal — the platform reserve', () => {
  const current: CurrentGlobalEconomics = {
    tradeFeeBps: 100n,
    initialVirtualSol: V_SOL,
    initialVirtualToken: V_TOK,
    tokenTotalSupply: SUPPLY,
    graduationTargetLamports: 11_685_689_681n,
    migrationReserveLamports: MIN_MIGRATION_RESERVE_LAMPORTS,
    platformReserveBps: 0n,
  };

  it('re-runs the economics check when the reserve is the ONLY thing changing', () => {
    // A reserve change moves the listing price. If it did not trigger the check, a
    // 10% reserve would sail through and every later launch would list 15% high.
    const r = checkUpdateGlobal({ newPlatformReserveBps: 1_000n }, current);
    expect(r.economics).not.toBeNull();
    expect(r.economics!.graduationPriceRatioBps).toBe(11_498n);
    expect(r.problems.join()).toMatch(/GraduationPriceGap/);
  });

  it('refuses a reserve above the cap on its own', () => {
    const r = checkUpdateGlobal({ newPlatformReserveBps: 1_001n }, current);
    expect(r.problems.join()).toMatch(/InvalidParameter: platform_reserve_bps 1001/);
  });

  it('carries the CURRENT reserve into an update that does not touch it', () => {
    // Retuning virtual SOL on a config that already holds 3.69% back must be judged
    // against the carved supply, not the whole one.
    const withReserve = { ...current, platformReserveBps: 369n };
    const r = checkUpdateGlobal({ newInitialVirtualSol: V_SOL }, withReserve);
    expect(r.economics!.graduationPriceRatioBps).toBe(10_488n);
    expect(r.economics!.platformReserveTokens).toBe(36_900_000_000_000n);
  });
});
