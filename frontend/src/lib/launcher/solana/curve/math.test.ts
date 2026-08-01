import { describe, it, expect } from 'vitest';
import {
  BPS_DENOMINATOR,
  MAX_FEE_BPS,
  U64_MAX,
  feeUp,
  quoteBuy,
  quoteSell,
  lamportsUntilTarget,
  maxReachableRealSol,
  graduationPriceRatioBps,
  continuityTarget,
  isqrt,
  effectiveReserves,
  raiseCeiling,
  quoteBuyOnCurve,
  quoteSellOnCurve,
  type CurveResult,
  type CurveTerms,
} from './math';
import {
  FEE_UP_VECTORS,
  QUOTE_BUY_VECTORS,
  QUOTE_SELL_VECTORS,
  LAMPORTS_UNTIL_TARGET_VECTORS,
  MAX_REACHABLE_VECTORS,
  PRICE_RATIO_VECTORS,
  CONTINUITY_TARGET_VECTORS,
  type CurveVector,
} from './curveVectors.fixture';

// The program's own test constants (curve.rs:410-413, 675) so the hand-ported
// assertions below pin the same numbers as the Rust suite.
const SOL = 1_000_000_000n;
const V_SOL = 30n * SOL;
const V_TOK = 1_073_000_000_000_000n;
const SUPPLY = 1_000_000_000_000_000n;

/**
 * Replay a fixture through `fn` and assert an EXACT match — value or error name.
 *
 * `outputs` maps a success value to the same string list the Rust generator
 * emitted, so a shape mismatch fails as loudly as a wrong number.
 */
function differential<T>(
  name: string,
  vectors: readonly CurveVector[],
  fn: (args: readonly bigint[]) => CurveResult<T>,
  outputs: (v: T) => readonly string[],
): void {
  it(`${name}: matches curve.rs on all ${vectors.length} generated vectors`, () => {
    const mismatches: string[] = [];
    for (const [inputs, expected] of vectors) {
      const got = fn(inputs.map((s) => BigInt(s)));
      const actual = got.ok ? outputs(got.value) : got.error;
      const same =
        typeof expected === 'string'
          ? actual === expected
          : Array.isArray(actual) &&
            actual.length === expected.length &&
            expected.every((e, i) => actual[i] === e);
      if (!same) {
        mismatches.push(`(${inputs.join(',')}) → ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
      }
    }
    // Report a bounded sample: a rounding-direction bug fails thousands of rows
    // at once and an unbounded dump buries the diagnostic.
    expect(mismatches.slice(0, 5), `${mismatches.length}/${vectors.length} mismatched`).toEqual([]);
  });
}

describe('curve math — differential against the real curve.rs', () => {
  differential('feeUp', FEE_UP_VECTORS, ([a, f]) => feeUp(a!, f!), (v) => [v.toString()]);

  differential(
    'quoteBuy',
    QUOTE_BUY_VECTORS,
    ([s, t, l, f]) => quoteBuy(s!, t!, l!, f!),
    (q) => [q.feeLamports.toString(), q.lamportsToCurve.toString(), q.tokensOut.toString()],
  );

  differential(
    'quoteSell',
    QUOTE_SELL_VECTORS,
    ([s, t, i, f]) => quoteSell(s!, t!, i!, f!),
    (q) => [q.grossLamports.toString(), q.feeLamports.toString(), q.lamportsOut.toString()],
  );

  // `null` is Rust's `Ok(None)` and the generator wrote it as an EMPTY output
  // list — so this maps it to `[]`, keeping it distinct from every error row.
  differential(
    'lamportsUntilTarget',
    LAMPORTS_UNTIL_TARGET_VECTORS,
    ([r, t, f]) => lamportsUntilTarget(r!, t!, f!),
    (v) => (v === null ? [] : [v.toString()]),
  );

  differential(
    'maxReachableRealSol',
    MAX_REACHABLE_VECTORS,
    ([vs, vt, s]) => maxReachableRealSol(vs!, vt!, s!),
    (v) => [v.toString()],
  );

  differential(
    'graduationPriceRatioBps',
    PRICE_RATIO_VECTORS,
    ([vs, vt, s, t, r]) => graduationPriceRatioBps(vs!, vt!, s!, t!, r!),
    (v) => [v.toString()],
  );

  differential(
    'continuityTarget',
    CONTINUITY_TARGET_VECTORS,
    ([vs, vt, s, r]) => continuityTarget(vs!, vt!, s!, r!),
    (v) => [v.toString()],
  );
});

// The assertions below are hand-ported from `curve.rs`'s own `#[cfg(test)] mod
// tests` (23 tests, all green when run on the host this session). They overlap
// the fixture on purpose: the fixture proves agreement, these state the
// PROPERTIES in a form a reviewer can read without decoding a vector.
describe('curve math — the properties curve.rs pins', () => {
  const unwrap = <T,>(r: CurveResult<T>): T => {
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    return r.value;
  };

  it('buy returns tokens and charges the fee (curve.rs:416-422)', () => {
    const q = unwrap(quoteBuy(V_SOL, V_TOK, SOL, 100n));
    expect(q.feeLamports).toBe(SOL / 100n);
    expect(q.lamportsToCurve).toBe(SOL - q.feeLamports);
    expect(q.tokensOut).toBeGreaterThan(0n);
    expect(q.tokensOut).toBeLessThan(V_TOK);
  });

  it('zero fee sends everything to the curve (curve.rs:425-429)', () => {
    const q = unwrap(quoteBuy(V_SOL, V_TOK, SOL, 0n));
    expect(q.feeLamports).toBe(0n);
    expect(q.lamportsToCurve).toBe(SOL);
  });

  it('price rises as the curve fills (curve.rs:432-442)', () => {
    const first = unwrap(quoteBuy(V_SOL, V_TOK, SOL, 0n));
    const later = unwrap(quoteBuy(V_SOL + 10n * SOL, V_TOK - first.tokensOut, SOL, 0n));
    expect(later.tokensOut).toBeLessThan(first.tokensOut);
  });

  it('a round trip never profits (curve.rs:448-461)', () => {
    for (const spend of [SOL / 1000n, SOL, 5n * SOL, 25n * SOL]) {
      const buy = unwrap(quoteBuy(V_SOL, V_TOK, spend, 0n));
      const sell = unwrap(
        quoteSell(V_SOL + buy.lamportsToCurve, V_TOK - buy.tokensOut, buy.tokensOut, 0n),
      );
      expect(sell.lamportsOut).toBeLessThanOrEqual(spend);
    }
  });

  it('splitting a buy never beats one shot (curve.rs:466-485)', () => {
    const total = 10n * SOL;
    const oneShot = unwrap(quoteBuy(V_SOL, V_TOK, total, 0n)).tokensOut;
    let sol = V_SOL;
    let tok = V_TOK;
    let acc = 0n;
    for (let i = 0; i < 10; i++) {
      const q = unwrap(quoteBuy(sol, tok, total / 10n, 0n));
      sol += q.lamportsToCurve;
      tok -= q.tokensOut;
      acc += q.tokensOut;
    }
    expect(acc).toBeLessThanOrEqual(oneShot);
  });

  it('fees round UP so dust trades still pay (curve.rs:489-496)', () => {
    expect(unwrap(feeUp(1n, 1n))).toBe(1n);
    expect(unwrap(feeUp(0n, 100n))).toBe(0n);
    expect(unwrap(feeUp(10_000n, 100n))).toBe(100n);
    // Exactly divisible must NOT be pushed to the next lamport.
    expect(unwrap(feeUp(20_000n, 100n))).toBe(200n);
  });

  it('a fee above the ceiling is rejected (curve.rs:499-505)', () => {
    expect(feeUp(SOL, MAX_FEE_BPS + 1n)).toEqual({ ok: false, error: 'FeeTooHigh' });
    expect(quoteBuy(V_SOL, V_TOK, SOL, MAX_FEE_BPS + 1n)).toEqual({ ok: false, error: 'FeeTooHigh' });
  });

  it('zero and empty are rejected (curve.rs:508-519)', () => {
    expect(quoteBuy(V_SOL, V_TOK, 0n, 0n)).toEqual({ ok: false, error: 'ZeroAmount' });
    expect(quoteSell(V_SOL, V_TOK, 0n, 0n)).toEqual({ ok: false, error: 'ZeroAmount' });
    expect(quoteBuy(0n, V_TOK, SOL, 0n)).toEqual({ ok: false, error: 'InsufficientLiquidity' });
    expect(quoteSell(V_SOL, 0n, 1n, 0n)).toEqual({ ok: false, error: 'InsufficientLiquidity' });
  });

  it('a dust buy fully eaten by the fee reverts (curve.rs:524-529)', () => {
    expect(quoteBuy(V_SOL, V_TOK, 1n, 10_000n)).toEqual({ ok: false, error: 'FeeTooHigh' });
    expect(quoteBuy(V_SOL, V_TOK, 1n, MAX_FEE_BPS)).toEqual({ ok: false, error: 'ZeroAmount' });
  });

  it('the entire token reserve can never be taken (curve.rs:541-553)', () => {
    for (const reserves of [1_000n, 1_000_000n, V_TOK]) {
      for (const spend of [U64_MAX / 4n, U64_MAX / 2n]) {
        expect(unwrap(quoteBuy(V_SOL, reserves, spend, 0n)).tokensOut).toBeLessThan(reserves);
      }
    }
  });

  it('u64-scale reserves do not overflow (curve.rs:556-560)', () => {
    expect(quoteBuy(U64_MAX / 2n, U64_MAX / 2n, SOL, 0n).ok).toBe(true);
  });

  it('the target cap grosses up the fee (curve.rs:563-575)', () => {
    const gross = unwrap(lamportsUntilTarget(0n, 10n * SOL, 100n));
    expect(gross).not.toBeNull();
    expect(gross!).toBeGreaterThan(10n * SOL);
    expect(gross! - unwrap(feeUp(gross!, 100n))).toBeGreaterThanOrEqual(10n * SOL);
  });

  it('the target cap is null once reached (curve.rs:578-581)', () => {
    expect(unwrap(lamportsUntilTarget(10n * SOL, 10n * SOL, 100n))).toBeNull();
    expect(unwrap(lamportsUntilTarget(11n * SOL, 10n * SOL, 100n))).toBeNull();
  });

  it('max reachable SOL scales as the formula says (curve.rs:631-647)', () => {
    const vTok = 1_000_000_000_000n;
    const vSol = 10n * SOL;
    const supply = 2_000_000_000_000n;
    const a = unwrap(maxReachableRealSol(vSol, vTok, supply));
    expect(a).toBe(vSol * 2n);
    expect(unwrap(maxReachableRealSol(vSol * 2n, vTok, supply))).toBe(a * 2n);
    expect(unwrap(maxReachableRealSol(vSol, vTok * 2n, supply))).toBe(a / 2n);
  });

  it('max reachable SOL rejects degenerate input (curve.rs:650-663)', () => {
    expect(maxReachableRealSol(0n, V_TOK, 1n)).toEqual({ ok: false, error: 'ZeroAmount' });
    expect(maxReachableRealSol(V_SOL, 0n, 1n)).toEqual({ ok: false, error: 'ZeroAmount' });
    expect(maxReachableRealSol(V_SOL, V_TOK, 0n)).toEqual({ ok: false, error: 'ZeroAmount' });
  });

  it('sell mirrors the buy direction (curve.rs:666-671)', () => {
    const a = unwrap(quoteSell(V_SOL, V_TOK, 1_000_000_000n, 0n));
    const b = unwrap(quoteSell(V_SOL, V_TOK * 2n, 1_000_000_000n, 0n));
    expect(b.lamportsOut).toBeLessThan(a.lamportsOut);
  });

  it("the repo's original parameters gapped badly (curve.rs:684-687)", () => {
    const r = unwrap(graduationPriceRatioBps(30n * SOL, V_TOK, SUPPLY, 2n * SOL, SOL / 4n));
    expect(r).toBeLessThan(2_000n);
  });

  it('the continuity target lists at the curve price (curve.rs:690-704)', () => {
    for (const [vs, reserve] of [
      [30n * SOL, SOL / 2n],
      [5n * SOL, SOL / 4n],
      [100n * SOL, 0n],
      [7n * SOL, 3n * SOL],
    ] as const) {
      const t = unwrap(continuityTarget(vs, V_TOK, SUPPLY, reserve));
      const r = unwrap(graduationPriceRatioBps(vs, V_TOK, SUPPLY, t, reserve));
      expect(r).toBeGreaterThanOrEqual(9_900n);
      expect(r).toBeLessThanOrEqual(10_100n);
    }
  });

  it('the migration reserve moves the continuity target (curve.rs:710-717)', () => {
    const a = unwrap(continuityTarget(30n * SOL, V_TOK, SUPPLY, 0n));
    const b = unwrap(continuityTarget(30n * SOL, V_TOK, SUPPLY, 5n * SOL));
    expect(b).toBeLessThan(a);
    const r = unwrap(graduationPriceRatioBps(30n * SOL, V_TOK, SUPPLY, a, 5n * SOL));
    expect(r >= 9_500n && r <= 10_500n).toBe(false);
  });

  it('the ratio rises monotonically with the target (curve.rs:720-728)', () => {
    let prev = 0n;
    for (let mult = 1n; mult <= 10n; mult++) {
      const r = unwrap(graduationPriceRatioBps(30n * SOL, V_TOK, SUPPLY, mult * SOL, 0n));
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });

  it('the continuity target always sits under the reachable ceiling (curve.rs:731-739)', () => {
    for (const vs of [SOL, 5n * SOL, 30n * SOL, 500n * SOL]) {
      const t = unwrap(continuityTarget(vs, V_TOK, SUPPLY, 0n));
      expect(t).toBeLessThan(unwrap(maxReachableRealSol(vs, V_TOK, SUPPLY)));
    }
  });

  it('isqrt is exact on perfect squares and never overshoots (curve.rs:742-749)', () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 99n, 100n, 101n, 1n << 60n, 2n ** 128n - 1n]) {
      const r = isqrt(n);
      expect(r * r).toBeLessThanOrEqual(n);
      expect((r + 1n) * (r + 1n)).toBeGreaterThan(n);
    }
  });
});

// A `bigint` port cannot overflow the way Rust does, so the u64 ceilings the
// program enforces have to be re-imposed by hand. These are the branches that a
// naive transcription drops entirely — and it drops them SILENTLY, quoting a
// number the program would refuse to produce.
describe('curve math — u64 range, which bigint does not give for free', () => {
  it('lamportsUntilTarget overflows u64 rather than returning a bigger number', () => {
    // ceil(U64_MAX * 10000 / (10000 - 1000)) does not fit in a u64.
    expect(lamportsUntilTarget(0n, U64_MAX, 1_000n)).toEqual({ ok: false, error: 'Overflow' });
    // The same target at zero fee fits exactly.
    expect(lamportsUntilTarget(0n, U64_MAX, 0n)).toEqual({ ok: true, value: U64_MAX });
  });

  it('maxReachableRealSol overflows u64 rather than returning a bigger number', () => {
    expect(maxReachableRealSol(U64_MAX, 1n, U64_MAX)).toEqual({ ok: false, error: 'Overflow' });
  });

  it('inputs outside u64 are rejected, never clamped', () => {
    expect(feeUp(U64_MAX + 1n, 100n)).toEqual({ ok: false, error: 'Overflow' });
    expect(quoteBuy(V_SOL, V_TOK, -1n, 100n)).toEqual({ ok: false, error: 'Overflow' });
    expect(quoteSell(V_SOL, V_TOK, U64_MAX + 1n, 100n)).toEqual({ ok: false, error: 'Overflow' });
  });
});

// ── the parts of buy/sell that live in lib.rs ────────────────────────────────

const TERMS: CurveTerms = {
  virtualSolReserves: V_SOL,
  virtualTokenReserves: V_TOK,
  realSolReserves: 0n,
  realTokenReserves: SUPPLY,
  tradeFeeBps: 100n,
  graduationTargetLamports: 85n * SOL,
  migrationReserveLamports: SOL / 4n,
};

describe('effectiveReserves / raiseCeiling', () => {
  it('adds virtual and real on BOTH legs (state.rs:168-183)', () => {
    const e = effectiveReserves({ ...TERMS, realSolReserves: 7n * SOL, realTokenReserves: 5n });
    expect(e).toEqual({ ok: true, value: { sol: V_SOL + 7n * SOL, tokens: V_TOK + 5n } });
  });

  it('the raise ceiling is target PLUS reserve, not the target alone (lib.rs:466-469)', () => {
    expect(raiseCeiling(TERMS)).toEqual({ ok: true, value: 85n * SOL + SOL / 4n });
  });

  it('reports overflow rather than a wrapped sum', () => {
    expect(raiseCeiling({ ...TERMS, graduationTargetLamports: U64_MAX })).toEqual({
      ok: false,
      error: 'Overflow',
    });
    expect(effectiveReserves({ ...TERMS, realSolReserves: U64_MAX })).toEqual({
      ok: false,
      error: 'Overflow',
    });
  });
});

describe('quoteBuyOnCurve — the cap is the thing a UI gets wrong', () => {
  it('agrees with the bare quoteBuy when the cap does not bite', () => {
    const q = quoteBuyOnCurve(TERMS, SOL);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const bare = quoteBuy(V_SOL, V_TOK + SUPPLY, SOL, 100n);
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(q.value.tokensOut).toBe(bare.value.tokensOut);
    expect(q.value.lamportsIn).toBe(SOL);
    expect(q.value.capped).toBe(false);
  });

  it('caps the debit at target+reserve and says so — the last buy of every launch', () => {
    // One lamport of headroom left below the ceiling.
    const nearlyFull: CurveTerms = { ...TERMS, realSolReserves: 85n * SOL + SOL / 4n - 1n };
    const q = quoteBuyOnCurve(nearlyFull, 50n * SOL);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.value.capped).toBe(true);
    // Grossed up for the 1% fee: ceil(1 * 10000 / 9900) = 2 lamports sent.
    expect(q.value.lamportsIn).toBe(2n);
    expect(q.value.lamportsIn).toBeLessThan(50n * SOL);
    // And the debit is exactly what the two system transfers move (lib.rs:499-520).
    expect(q.value.feeLamports + q.value.lamportsToCurve).toBe(q.value.lamportsIn);
  });

  it('a fully funded curve is AwaitingMigration, never AlreadyComplete (lib.rs:476-479)', () => {
    const full: CurveTerms = { ...TERMS, realSolReserves: 85n * SOL + SOL / 4n };
    expect(quoteBuyOnCurve(full, SOL)).toEqual({ ok: false, error: 'AwaitingMigration' });
  });

  it('enforces the slippage floor (lib.rs:491)', () => {
    const q = quoteBuyOnCurve(TERMS, SOL);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(quoteBuyOnCurve(TERMS, SOL, q.value.tokensOut)).toMatchObject({ ok: true });
    expect(quoteBuyOnCurve(TERMS, SOL, q.value.tokensOut + 1n)).toEqual({
      ok: false,
      error: 'SlippageExceeded',
    });
  });

  it('refuses a quote larger than the REAL token reserve, not just the effective one (lib.rs:492-495)', () => {
    // Effective tokens stay large (virtual leg), but almost nothing is left to pay out.
    const drained: CurveTerms = { ...TERMS, realTokenReserves: 1n };
    const q = quoteBuyOnCurve(drained, SOL);
    expect(q).toEqual({ ok: false, error: 'InsufficientLiquidity' });
    // …and the bare curve quote, which only sees effective reserves, succeeds —
    // which is exactly why lib.rs keeps a second check.
    expect(quoteBuy(V_SOL, V_TOK + 1n, SOL, 100n).ok).toBe(true);
  });

  it('a zero request is ZeroAmount, an unsendable one is Overflow', () => {
    expect(quoteBuyOnCurve(TERMS, 0n)).toEqual({ ok: false, error: 'ZeroAmount' });
    expect(quoteBuyOnCurve(TERMS, U64_MAX + 1n)).toEqual({ ok: false, error: 'Overflow' });
  });
});

describe('quoteSellOnCurve', () => {
  const held: CurveTerms = {
    ...TERMS,
    realSolReserves: 10n * SOL,
    realTokenReserves: SUPPLY - 300_000_000_000_000n,
  };

  it('quotes net of fee and matches the bare quoteSell', () => {
    const q = quoteSellOnCurve(held, 1_000_000_000n);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const eff = effectiveReserves(held);
    expect(eff.ok).toBe(true);
    if (!eff.ok) return;
    expect(q.value).toEqual(
      (quoteSell(eff.value.sol, eff.value.tokens, 1_000_000_000n, 100n) as { ok: true; value: unknown }).value,
    );
    expect(q.value.lamportsOut).toBe(q.value.grossLamports - q.value.feeLamports);
  });

  it('refuses to pay out of the VIRTUAL leg (lib.rs:582-587)', () => {
    // A sell whose gross exceeds every real lamport the curve holds.
    const thin: CurveTerms = { ...held, realSolReserves: 1n };
    expect(quoteSellOnCurve(thin, 300_000_000_000_000n)).toEqual({
      ok: false,
      error: 'InsufficientLiquidity',
    });
  });

  it('applies the rent floor against the ACCOUNT balance, not realSolReserves (lib.rs:605-614)', () => {
    const q = quoteSellOnCurve(held, 1_000_000_000n);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const gross = q.value.grossLamports;
    const rentExempt = 2_018_400n;
    // Balance one lamport short of covering gross + rent → the program refuses.
    expect(
      quoteSellOnCurve(held, 1_000_000_000n, 0n, {
        curveAccountLamports: gross + rentExempt - 1n,
        rentExemptLamports: rentExempt,
      }),
    ).toEqual({ ok: false, error: 'InsufficientRentExemptBalance' });
    // Exactly covering it is allowed.
    expect(
      quoteSellOnCurve(held, 1_000_000_000n, 0n, {
        curveAccountLamports: gross + rentExempt,
        rentExemptLamports: rentExempt,
      }).ok,
    ).toBe(true);
  });

  it('enforces the slippage floor (lib.rs:578-581)', () => {
    const q = quoteSellOnCurve(held, 1_000_000_000n);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(quoteSellOnCurve(held, 1_000_000_000n, q.value.lamportsOut + 1n)).toEqual({
      ok: false,
      error: 'SlippageExceeded',
    });
  });

  it('quotes from the CURVE fee snapshot — a different global fee changes nothing', () => {
    // The whole point of the snapshot (lib.rs:430-432): this function is never
    // handed a GlobalConfig, so a fee change cannot leak into a live quote.
    const cheaper = quoteSellOnCurve({ ...held, tradeFeeBps: 25n }, 1_000_000_000n);
    const dearer = quoteSellOnCurve({ ...held, tradeFeeBps: 300n }, 1_000_000_000n);
    expect(cheaper.ok && dearer.ok).toBe(true);
    if (!cheaper.ok || !dearer.ok) return;
    expect(cheaper.value.grossLamports).toBe(dearer.value.grossLamports);
    expect(cheaper.value.feeLamports).toBeLessThan(dearer.value.feeLamports);
  });
});

describe('constants match curve.rs', () => {
  it('BPS_DENOMINATOR and MAX_FEE_BPS (curve.rs:32, 37)', () => {
    expect(BPS_DENOMINATOR).toBe(10_000n);
    expect(MAX_FEE_BPS).toBe(1_000n);
  });
});
