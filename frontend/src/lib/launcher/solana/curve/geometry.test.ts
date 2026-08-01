import { describe, it, expect } from 'vitest';
import { buildCurveGeometry, type CurveSnapshot } from './geometry';
import { BPS_DENOMINATOR, MAX_FEE_BPS, lamportsUntilTarget } from './math';
import { formatSol as formatSolRaw, spotPriceLabel } from './format';

// The chart renders SOL fixed-width so its stat columns line up. `formatSol` is a
// single implementation with `fixed` as a setting — see format.ts — so this local
// alias is a presentation choice, not a second formatter.
const formatSol = (lamports: bigint, decimalPlaces = 4) =>
  formatSolRaw(lamports, decimalPlaces, { fixed: true });

/**
 * `lamportsUntilTarget` returns a `CurveResult` in the core (curve.rs returns a
 * `Result`), where the geometry module's former private copy threw. These helpers
 * keep the assertions below reading the same while pointing at the one port.
 */
const untilTarget = (real: bigint, ceiling: bigint, fee: bigint): bigint | null => {
  const r = lamportsUntilTarget(real, ceiling, fee);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

// The program's OWN test parameters, so the geometry is exercised at the
// magnitudes it will actually see rather than at invented round numbers.
// solana/tegridy-amm/tests/tegridy-launch-constraints.test.ts:56-68.
const ONE_SOL = 1_000_000_000n;
const V_SOL = 30_000_000_000n; // 30 SOL
const V_TOK = 1_073_000_000_000_000n;
const SUPPLY = 1_000_000_000_000_000n;
const FEE_BPS = 100n;
const GRAD_TARGET = 11_544_610_844n;
const MIGRATION_RESERVE = 500_000_000n;
const CEILING = GRAD_TARGET + MIGRATION_RESERVE;

/** k at launch, before any trade. */
const K0 = V_SOL * (V_TOK + SUPPLY);

/**
 * A curve that has raised `raised` lamports, with the token leg placed on the
 * invariant rather than picked out of the air.
 */
function curveAtRaised(raised: bigint, overrides: Partial<CurveSnapshot> = {}): CurveSnapshot {
  const effectiveTokens = K0 / (V_SOL + raised);
  return {
    virtualSolReserves: V_SOL,
    virtualTokenReserves: V_TOK,
    realSolReserves: raised,
    realTokenReserves: effectiveTokens > V_TOK ? effectiveTokens - V_TOK : 0n,
    tradeFeeBps: FEE_BPS,
    graduationTargetLamports: GRAD_TARGET,
    migrationReserveLamports: MIGRATION_RESERVE,
    complete: false,
    ...overrides,
  };
}

function unwrap(c: CurveSnapshot, options?: { sampleCount?: number }) {
  const res = buildCurveGeometry(c, options);
  if (!res.ok) throw new Error(`expected plottable curve, got ${res.reason}`);
  return res.geometry;
}

describe('buildCurveGeometry — shape', () => {
  it('plots a fresh curve from zero reserves without inventing anything', () => {
    const g = unwrap(curveAtRaised(0n));

    expect(g.current.raisedLamports).toBe(0n);
    expect(g.current.x).toBe(0);
    expect(g.current.y).toBe(0);
    expect(g.progress).toBe(0);
    expect(g.pastCeiling).toBe(false);
    // At r = 0 the effective token leg is exactly virtual + total supply — no drift.
    expect(g.current.effectiveTokens).toBe(V_TOK + SUPPLY);
  });

  it('holds the constant product at every sampled point', () => {
    const g = unwrap(curveAtRaised(4_000_000_000n));
    const k = (V_SOL + 4_000_000_000n) * (V_TOK + (K0 / (V_SOL + 4_000_000_000n) - V_TOK));

    for (const p of g.points) {
      const x = V_SOL + p.raisedLamports;
      // y is floored, so x*y lands within one x of k — never above it.
      const product = x * p.effectiveTokens;
      expect(product).toBeLessThanOrEqual(k);
      expect(product).toBeGreaterThan(k - x);
    }
  });

  it('agrees with an independent float computation of x / y', () => {
    const g = unwrap(curveAtRaised(2_500_000_000n));
    for (const p of g.points) {
      const x = Number(V_SOL + p.raisedLamports);
      const independent = x / Number(p.effectiveTokens);
      expect(p.price / independent).toBeCloseTo(1, 9);
    }
  });

  it('is strictly increasing in price and in amount raised, with no NaN', () => {
    const g = unwrap(curveAtRaised(1_000_000_000n));
    for (let i = 1; i < g.points.length; i++) {
      const prev = g.points[i - 1]!;
      const cur = g.points[i]!;
      expect(cur.raisedLamports > prev.raisedLamports).toBe(true);
      expect(cur.price).toBeGreaterThan(prev.price);
      expect(cur.y).toBeGreaterThanOrEqual(prev.y);
      expect(Number.isFinite(cur.price)).toBe(true);
      expect(Number.isFinite(cur.x)).toBe(true);
      expect(Number.isFinite(cur.y)).toBe(true);
    }
    expect(g.points[0]!.y).toBe(0);
    expect(g.points[g.points.length - 1]!.y).toBeCloseTo(1, 5);
  });

  it('puts the current, target and ceiling markers ON the plotted line', () => {
    const g = unwrap(curveAtRaised(3_000_000_000n));
    // Identity, not equality: a marker that is merely near the polyline is a marker
    // drawn off the curve.
    expect(g.points).toContain(g.current);
    expect(g.points).toContain(g.target);
    expect(g.points).toContain(g.ceiling);
    expect(g.target.raisedLamports).toBe(GRAD_TARGET);
    expect(g.ceiling.raisedLamports).toBe(CEILING);
    expect(g.ceiling.x).toBe(1);
  });

  it('separates the target from the ceiling — the reserve is still being raised between them', () => {
    const g = unwrap(curveAtRaised(0n));
    expect(g.target.raisedLamports).toBeLessThan(g.ceiling.raisedLamports);
    expect(g.target.x).toBeLessThan(g.ceiling.x);
  });
});

describe('buildCurveGeometry — progress and remaining', () => {
  it('measures progress against target + reserve, not the target alone', () => {
    const g = unwrap(curveAtRaised(GRAD_TARGET));
    // Using GRAD_TARGET alone as the denominator would read 100% here while buys
    // still succeed (contract §5.6).
    expect(g.progress).toBeLessThan(1);
    expect(g.progress).toBeCloseTo(Number(GRAD_TARGET) / Number(CEILING), 8);
    expect(g.lamportsUntilCeiling).not.toBeNull();
  });

  it('grosses the remaining amount up for the fee — it is what a buyer must SEND', () => {
    const g = unwrap(curveAtRaised(GRAD_TARGET));
    const remaining = CEILING - GRAD_TARGET;
    expect(g.lamportsUntilCeiling).toBe(untilTarget(GRAD_TARGET, CEILING, FEE_BPS));
    // Strictly more than the bare shortfall, because the fee comes off the top.
    expect(g.lamportsUntilCeiling! > remaining).toBe(true);
  });

  it('reports a fully funded curve as complete-to-ceiling, awaiting migration', () => {
    const g = unwrap(curveAtRaised(CEILING));
    expect(g.progress).toBe(1);
    expect(g.lamportsUntilCeiling).toBeNull();
    expect(g.current.raisedLamports).toBe(CEILING);
    expect(g.current.x).toBe(1);
    expect(g.pastCeiling).toBe(false);
  });

  it('keeps a past-ceiling curve on canvas instead of clamping the marker onto the edge', () => {
    const beyond = CEILING + 2_000_000_000n;
    const g = unwrap(curveAtRaised(beyond));
    expect(g.pastCeiling).toBe(true);
    expect(g.progress).toBe(1); // clamped for display
    expect(g.current.raisedLamports).toBe(beyond);
    expect(g.current.x).toBe(1);
    // The ceiling is now inside the domain, so it renders as a line the curve passed.
    expect(g.ceiling.x).toBeLessThan(1);
    expect(g.lamportsUntilCeiling).toBeNull();
  });
});

describe('buildCurveGeometry — degenerate states render as unknown, never as zero', () => {
  it('refuses a graduated curve rather than reporting its gutted reserves as ~0% raised', () => {
    // migrate_to_amm zeroes real_token_reserves and subtracts (target + reserve)
    // from real_sol_reserves (lib.rs:1167-1178). Plotted naively that is a
    // graduated launch showing no progress.
    const graduated: CurveSnapshot = {
      ...curveAtRaised(CEILING),
      realSolReserves: 0n,
      realTokenReserves: 0n,
      complete: true,
    };
    const res = buildCurveGeometry(graduated);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('graduated');
  });

  it('refuses a curve with no virtual SOL reserve', () => {
    const res = buildCurveGeometry(curveAtRaised(0n, { virtualSolReserves: 0n }));
    expect(res.ok === false && res.reason).toBe('no-virtual-reserves');
  });

  it('refuses a curve with no virtual token reserve', () => {
    const res = buildCurveGeometry(curveAtRaised(0n, { virtualTokenReserves: 0n }));
    expect(res.ok === false && res.reason).toBe('no-virtual-reserves');
  });

  it('refuses a curve with no graduation target — there is no progress denominator', () => {
    const res = buildCurveGeometry(
      curveAtRaised(0n, { graduationTargetLamports: 0n, migrationReserveLamports: 0n }),
    );
    expect(res.ok === false && res.reason).toBe('no-graduation-target');
  });

  it('refuses a fee outside the program ceiling instead of drawing a curve nobody can trade', () => {
    expect(buildCurveGeometry(curveAtRaised(0n, { tradeFeeBps: MAX_FEE_BPS + 1n })).ok).toBe(false);
    const res = buildCurveGeometry(curveAtRaised(0n, { tradeFeeBps: MAX_FEE_BPS + 1n }));
    expect(res.ok === false && res.reason).toBe('fee-out-of-range');
    expect(buildCurveGeometry(curveAtRaised(0n, { tradeFeeBps: -1n })).ok).toBe(false);
  });

  it('accepts a zero fee and the fee ceiling exactly', () => {
    expect(buildCurveGeometry(curveAtRaised(0n, { tradeFeeBps: 0n })).ok).toBe(true);
    expect(buildCurveGeometry(curveAtRaised(0n, { tradeFeeBps: MAX_FEE_BPS })).ok).toBe(true);
  });

  it('survives a zero migration reserve — target and ceiling collapse to one point', () => {
    const g = unwrap(curveAtRaised(0n, { migrationReserveLamports: 0n }));
    expect(g.target).toBe(g.ceiling);
    expect(g.ceiling.raisedLamports).toBe(GRAD_TARGET);
  });
});

describe('buildCurveGeometry — sampling', () => {
  it('clamps a nonsense sample count instead of dividing by zero', () => {
    for (const sampleCount of [1, 0, -5, Number.NaN]) {
      const g = unwrap(curveAtRaised(1_000_000_000n), { sampleCount });
      expect(g.points.length).toBeGreaterThanOrEqual(2);
      for (const p of g.points) expect(Number.isFinite(p.x)).toBe(true);
    }
  });

  it('caps the sample count so a hostile prop cannot allocate unboundedly', () => {
    const g = unwrap(curveAtRaised(1_000_000_000n), { sampleCount: 100_000 });
    // 512 samples + at most three landmark insertions.
    expect(g.points.length).toBeLessThanOrEqual(515);
  });

  it('still carries all three landmarks at the minimum sample count', () => {
    const g = unwrap(curveAtRaised(1_000_000_000n), { sampleCount: 2 });
    expect(g.points).toContain(g.current);
    expect(g.points).toContain(g.target);
    expect(g.points).toContain(g.ceiling);
  });
});

// These pin the properties the CHART depends on. The function itself is proven
// against 370 Rust-generated vectors in math.test.ts; this is the second reader of
// the one port, not a second port.
describe('lamportsUntilTarget — as the chart consumes it', () => {
  it('returns null once the ceiling is reached — that is AwaitingMigration, not AlreadyComplete', () => {
    expect(untilTarget(CEILING, CEILING, FEE_BPS)).toBeNull();
    expect(untilTarget(CEILING + 1n, CEILING, FEE_BPS)).toBeNull();
  });

  it('rounds the gross-up UP, so the returned amount always clears the shortfall', () => {
    // 1 lamport short at 1% => ceil(1 * 10000 / 9900) = 2, not 1.
    expect(untilTarget(CEILING - 1n, CEILING, 100n)).toBe(2n);
    // Zero fee is a pass-through.
    expect(untilTarget(0n, 1_000n, 0n)).toBe(1_000n);
  });

  it('never returns less than the bare shortfall for any fee in range', () => {
    for (const fee of [0n, 1n, 25n, 100n, 300n, MAX_FEE_BPS]) {
      const gross = untilTarget(0n, CEILING, fee)!;
      expect(gross >= CEILING).toBe(true);
      // And the post-fee remainder still covers the shortfall: gross - ceil(gross*fee/1e4) >= CEILING.
      const feeTaken = (gross * fee + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
      expect(gross - feeTaken >= CEILING).toBe(true);
    }
  });

  it('refuses rather than silently answering for an impossible fee', () => {
    expect(lamportsUntilTarget(0n, CEILING, BPS_DENOMINATOR)).toEqual({
      ok: false,
      error: 'FeeTooHigh',
    });
    // Negative is not representable on chain at all — the program would never have
    // received it, so it is an Overflow, not a fee judgement.
    expect(lamportsUntilTarget(0n, CEILING, -1n)).toEqual({ ok: false, error: 'Overflow' });
  });

  it('a curve the arithmetic refuses is not plotted at all', () => {
    // A fee outside [0, MAX_FEE_BPS] is caught earlier by its own reason; this is
    // the branch where `lamportsUntilTarget` itself says no. The chart must render
    // a refusal, never a plot with a blank headline stat.
    const res = buildCurveGeometry(
      curveAtRaised(0n, { graduationTargetLamports: 2n ** 64n - 1n, migrationReserveLamports: 2n ** 64n - 1n }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('arithmetic-refused');
  });
});

describe('formatSol', () => {
  it('formats exactly, without float rounding', () => {
    expect(formatSol(GRAD_TARGET)).toBe('11.5446');
    expect(formatSol(0n)).toBe('0.0000');
    expect(formatSol(1n, 9)).toBe('0.000000001');
    expect(formatSol(ONE_SOL)).toBe('1.0000');
  });

  it('truncates rather than rounds, so a displayed amount is never overstated', () => {
    // 0.99999999 SOL must not display as 1.0000.
    expect(formatSol(999_999_990n, 4)).toBe('0.9999');
  });

  it('handles a negative delta', () => {
    expect(formatSol(-ONE_SOL, 2)).toBe('-1.00');
  });

  // The chart's own former copy of formatSol lacked this floor and rendered a
  // single lamport as "0.0000" — a real balance shown as zero. Consolidating on
  // the one implementation brought the floor with it, in fixed mode too.
  it('never renders a non-zero balance as zero, even padded', () => {
    expect(formatSol(1n)).toBe('<0.0001');
    expect(formatSol(99_999n)).toBe('<0.0001');
    // A true zero is still a plain zero — the floor is for values that exist.
    expect(formatSol(0n)).toBe('0.0000');
  });
});

describe('spotPriceLabel', () => {
  it('never assumes 9 decimals — with no mint read it reports base units', () => {
    const label = spotPriceLabel(0.0000145);
    expect(label.unit).toBe('lamports per base unit');
    expect(label.value).not.toBe('0');
  });

  it('converts to SOL per token only when decimals were actually read', () => {
    // 1e-5 lamports per base unit at 6 decimals = 10 lamports per token = 1e-8 SOL.
    const label = spotPriceLabel(1e-5, 6);
    expect(label.unit).toBe('SOL per token');
    expect(Number(label.value)).toBeCloseTo(1e-8, 15);
  });

  it('rejects a nonsense decimals value rather than mis-scaling the price', () => {
    expect(spotPriceLabel(1e-5, 9.5).unit).toBe('lamports per base unit');
    expect(spotPriceLabel(1e-5, -1).unit).toBe('lamports per base unit');
    expect(spotPriceLabel(1e-5, 99).unit).toBe('lamports per base unit');
  });

  it('never strips significant trailing zeros off a whole number', () => {
    // "1000".replace(/\.?0+$/, '') === "1" — a price understated by 1000x.
    expect(Number(spotPriceLabel(1000).value)).toBe(1000);
    expect(Number(spotPriceLabel(10).value)).toBe(10);
    expect(Number(spotPriceLabel(1.5).value)).toBe(1.5);
    expect(Number(spotPriceLabel(0.018).value)).toBeCloseTo(0.018, 9);
  });

  it('renders an unreadable price as unreadable, not as zero', () => {
    expect(spotPriceLabel(Number.NaN)).toEqual({ value: '—', unit: 'unreadable' });
    expect(spotPriceLabel(Number.POSITIVE_INFINITY).unit).toBe('unreadable');
  });
});
