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
// 3,815 generated vectors in math.test.ts; these state the same agreement as
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
