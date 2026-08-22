// Bonding-curve GEOMETRY for `tegridy-launch` — plot coordinates, nothing else.
//
// WHAT THIS PLOTS, AND WHAT IT REFUSES TO PLOT
//   The curve is a FUNCTION OF STATE — price at a given amount raised — so it is
//   always knowable from one account read. It is NOT a time series. There is no
//   indexer and no trade history, so a price-over-time chart could only be fabricated
//   (docs/OWN_CURVE_FRONTEND_CONTRACT.md §9 row 7). Nothing here produces one.
//   (This used to add "and the program is not deployed anywhere". It has been live on
//   mainnet since 2026-08-08 — which REMOVES a reason and changes nothing: with no
//   indexer there is still no history to plot, and `getProgramAccounts` is off the
//   /api/solrpc allowlist, so the browser cannot reconstruct one either.)
//
// THE ARITHMETIC IS NOT HERE. An earlier draft of this file restated
// `lamports_until_target` and the fee constants locally, with a TODO saying to
// consolidate when the quote module landed. It has landed: `math.ts` is the single
// port of curve.rs, proven differentially against 3,815 Rust-generated vectors,
// and this file imports from it. A plot that disagrees with the quote engine is a
// cosmetic bug rather than a money bug — but a second copy of the model is how the
// money bug arrives later, so there is one copy.
//
// What remains here is genuinely presentational: sampling the domain, normalising
// to 0..1 canvas coordinates, and deciding which landmarks must sit on the line.
//
// BigInt everywhere for on-chain quantities. `virtual_token_reserves` in the
// program's own tests is 1_073_000_000_000_000; products of that with lamports
// leave float precision immediately.

import { MAX_FEE_BPS, lamportsUntilTarget, type CurveTerms } from './math';

/** Fixed-point scale for the spot-price ratio. 1e-18 lamports/base-unit is the floor. */
const PRICE_SCALE = 10n ** 18n;
/**
 * Fixed-point scale for the normalized 0..1 plot coordinates and for `progress`.
 * 1e9 keeps `progress` accurate to ~7 significant figures when it is rendered as a
 * percentage; the numerator stays well inside exact `Number` range.
 */
const UNIT_SCALE = 1_000_000_000n;

const DEFAULT_SAMPLE_COUNT = 64;
const MIN_SAMPLE_COUNT = 2;
const MAX_SAMPLE_COUNT = 512;

/**
 * The curve fields this module needs.
 *
 * Structurally a {@link CurveTerms} plus `complete`, so a decoded `BondingCurve`
 * satisfies it directly and the same snapshot feeds both the quote engine and the
 * plot — there is no second shape to keep in step.
 *
 * Every field is a per-launch SNAPSHOT taken at `create_launch` (lib.rs:430-432).
 * Never populate these from `global`: `global` describes only FUTURE launches, and
 * a curve created before a fee change carries the old fee.
 */
export interface CurveSnapshot extends CurveTerms {
  /** Terminal; only `migrate_to_amm` sets it. */
  complete: boolean;
}

export interface CurvePoint {
  /** Real SOL on the curve at this point, in lamports. */
  raisedLamports: bigint;
  /** Effective (virtual + real) token reserves at this point, in base units. */
  effectiveTokens: bigint;
  /**
   * Spot price in lamports per token BASE UNIT — a display ratio, not a trade.
   * Any real trade moves it.
   */
  price: number;
  /** 0..1 across the plotted domain. */
  x: number;
  /** 0..1 of the plotted price range, 0 = lowest price. */
  y: number;
}

export interface CurveGeometry {
  /** Ascending by `raisedLamports`. Always contains `current`, `target` and `ceiling`. */
  points: CurvePoint[];
  /** Where the curve stands right now. */
  current: CurvePoint;
  /** `graduation_target_lamports` alone — target met, reserve still raising. */
  target: CurvePoint;
  /** target + migration reserve — fully funded, buys revert, sells still work. */
  ceiling: CurvePoint;
  /** `real_sol_reserves / (target + reserve)`, clamped to [0,1]. That denominator is what `buy` caps against. */
  progress: number;
  /**
   * Lamports a buyer must SEND to fill the curve (already fee-grossed), or `null`
   * when fully funded — which the program answers with `AwaitingMigration` (6019),
   * NOT `AlreadyComplete`.
   */
  lamportsUntilCeiling: bigint | null;
  /** True when reserves already exceed the ceiling, so the domain was widened to keep the marker on-canvas. */
  pastCeiling: boolean;
}

/**
 * Why a curve cannot be plotted. An enum rather than free text so the caller is
 * forced to say something specific — an unplottable curve must never fall through
 * to a flat line at zero.
 */
export type CurveUnplottableReason =
  /** Migration closed the curve; its reserves no longer describe a market. */
  | 'graduated'
  /** No virtual reserves to price against — nothing to draw. */
  | 'no-virtual-reserves'
  /** target + reserve is zero, so there is no progress denominator. */
  | 'no-graduation-target'
  /** Fee outside [0, MAX_FEE_BPS]: a config bug, not a user action (6003). */
  | 'fee-out-of-range'
  /**
   * `math.ts` refused the remaining-to-send figure for these terms — the same
   * arithmetic the program runs said no. Rather than plot a curve whose headline
   * number could not be computed, say so.
   */
  | 'arithmetic-refused';

export type CurveGeometryResult =
  | { ok: true; geometry: CurveGeometry }
  | { ok: false; reason: CurveUnplottableReason };

/**
 * Sample the curve into plot geometry.
 *
 * Model (curve.rs:5-17): constant product over EFFECTIVE reserves, both legs
 * `virtual + real` (state.rs:168-183). Taking `k` from the CURRENT snapshot means
 * the current position lies exactly on the plotted line by construction, and the
 * line is the curve a buyer would trade against right now.
 *
 *     x(r) = virtual_sol + r          (r = real SOL raised)
 *     y(r) = k / x(r)
 *     price(r) = x(r) / y(r) = x(r)^2 / k
 *
 * `real_sol_reserves` accumulates the POST-fee amount, so the fee never enters the
 * curve and does not belong in this shape. Integer truncation on real trades
 * always rounds in the curve's favour, so `k` drifts marginally upward over a
 * launch's life; the plot is redrawn from live state, so it tracks that drift.
 */
export function buildCurveGeometry(
  curve: CurveSnapshot,
  options: { sampleCount?: number } = {},
): CurveGeometryResult {
  // A graduated curve's reserves were gutted by migration — `real_sol_reserves` is
  // decremented by (target + reserve) and `real_token_reserves` zeroed
  // (lib.rs:1167-1178). Plotting from them would draw a wrong-shaped curve and
  // report a graduated launch as ~0% raised. The pre-graduation `k` cannot be
  // rebuilt from the curve alone (`token_total_supply` lives on `global`), so we
  // refuse rather than guess.
  if (curve.complete) return { ok: false, reason: 'graduated' };
  if (curve.tradeFeeBps < 0n || curve.tradeFeeBps > MAX_FEE_BPS) {
    return { ok: false, reason: 'fee-out-of-range' };
  }
  if (curve.virtualSolReserves <= 0n || curve.virtualTokenReserves <= 0n) {
    return { ok: false, reason: 'no-virtual-reserves' };
  }

  const ceilingRaised = curve.graduationTargetLamports + curve.migrationReserveLamports;
  if (ceilingRaised <= 0n) return { ok: false, reason: 'no-graduation-target' };

  const realSol = curve.realSolReserves > 0n ? curve.realSolReserves : 0n;
  const realToken = curve.realTokenReserves > 0n ? curve.realTokenReserves : 0n;
  const k = (curve.virtualSolReserves + realSol) * (curve.virtualTokenReserves + realToken);

  // THE one number on this chart that is also a quote: what a buyer must still
  // send. It comes from `math.ts`, and its failure is surfaced rather than
  // swallowed — a `catch` here would put a plot on screen whose headline stat
  // silently vanished.
  const remaining = lamportsUntilTarget(realSol, ceilingRaised, curve.tradeFeeBps);
  if (!remaining.ok) return { ok: false, reason: 'arithmetic-refused' };

  // A curve past its ceiling still has to render its own position, so widen the
  // domain rather than clamp the marker onto the edge and imply it is exactly there.
  const pastCeiling = realSol > ceilingRaised;
  const domainMax = pastCeiling ? realSol : ceilingRaised;

  const n = clampInt(options.sampleCount ?? DEFAULT_SAMPLE_COUNT, MIN_SAMPLE_COUNT, MAX_SAMPLE_COUNT);
  const raised = new Set<bigint>();
  for (let i = 0; i < n; i++) raised.add((domainMax * BigInt(i)) / BigInt(n - 1));
  // Force the three landmarks onto the polyline so their markers sit ON the line.
  raised.add(realSol);
  raised.add(curve.graduationTargetLamports);
  raised.add(ceilingRaised);
  const sorted = [...raised].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const scaledPrice = (r: bigint) => {
    const x = curve.virtualSolReserves + r;
    return (x * x * PRICE_SCALE) / k;
  };
  // price(r) is strictly increasing in r, so the ends of the sorted domain are the extremes.
  const lowScaled = scaledPrice(sorted[0]!);
  const highScaled = scaledPrice(sorted[sorted.length - 1]!);
  const spanScaled = highScaled - lowScaled;

  const points: CurvePoint[] = sorted.map((r) => {
    const x = curve.virtualSolReserves + r;
    const ps = scaledPrice(r);
    return {
      raisedLamports: r,
      effectiveTokens: k / x,
      price: Number(ps) / Number(PRICE_SCALE),
      x: unitRatio(r, domainMax),
      y: spanScaled > 0n ? unitRatio(ps - lowScaled, spanScaled) : 0,
    };
  });

  const at = (r: bigint) => points.find((p) => p.raisedLamports === r)!;
  const rawProgress = unitRatio(realSol, ceilingRaised);

  return {
    ok: true,
    geometry: {
      points,
      current: at(realSol),
      target: at(curve.graduationTargetLamports),
      ceiling: at(ceilingRaised),
      progress: rawProgress > 1 ? 1 : rawProgress,
      lamportsUntilCeiling: remaining.value,
      pastCeiling,
    },
  };
}

/** Fixed-point 0..1 ratio of two bigints, so no intermediate exceeds float range. */
function unitRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  return Number((numerator * UNIT_SCALE) / denominator) / Number(UNIT_SCALE);
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}
