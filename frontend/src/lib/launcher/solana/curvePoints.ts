// Bonding-curve GEOMETRY for our own Solana launch program (`tegridy-launch`).
//
// PURE and dependency-free by design, mirroring ./dbc.ts: no Connection, no
// web3.js, no SDK, not even a type-only one. It takes an already-decoded
// `BondingCurve` snapshot and returns plot geometry, so the chart component
// carries zero runtime Solana weight and every number below is host-testable.
//
// WHAT THIS PLOTS, AND WHAT IT REFUSES TO PLOT
//   The curve is a FUNCTION OF STATE — price at a given amount raised — so it is
//   always knowable from one account read. It is NOT a time series. There is no
//   indexer, no trade history, and the program is not deployed anywhere, so a
//   price-over-time chart could only be fabricated (docs/OWN_CURVE_FRONTEND_CONTRACT.md
//   §9 row 7). Nothing here produces one.
//
// ⚠️ DUPLICATED MATH — CONSOLIDATE WHEN THE QUOTE MODULE LANDS.
//   The constant-product model and `lamportsUntilTarget` below are transcribed from
//   solana/tegridy-amm/programs/tegridy-launch/src/curve.rs (read 2026-08-01) and
//   docs/OWN_CURVE_FRONTEND_CONTRACT.md §5. The trade-quote module (buy/sell) is a
//   sibling workstream that was NOT committed when this was written, so the model
//   is restated here. When it lands, this file should import its helpers instead.
//   Nothing here quotes a trade — it only plots — so a drift is a cosmetic bug
//   rather than a money bug, but it is still a drift.
//
// BigInt everywhere for on-chain quantities. `virtual_token_reserves` in the
// program's own tests is 1_073_000_000_000_000; products of that with lamports
// leave float precision immediately (contract §5, "BigInt everywhere").

/** curve.rs:32. */
export const BPS_DENOMINATOR = 10_000n;
/** curve.rs:37 — hard ceiling on the trade fee, enforced at config time too. */
export const MAX_FEE_BPS = 1_000n;
/** Solana protocol constant. SOL is always 9 decimals; the LAUNCH MINT is not (§9 row 3). */
export const LAMPORTS_PER_SOL = 1_000_000_000n;

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
 * The fields of `BondingCurve` this module needs, decoded from the account
 * (contract §3.2, PDA `["curve", mint]`, 162 bytes).
 *
 * Every one is a per-launch SNAPSHOT taken at `create_launch` (lib.rs:430-432).
 * Never populate these from `global` — `global` describes only FUTURE launches
 * (contract §9 row 14), and a curve created before a fee change carries the old fee.
 */
export interface CurveSnapshot {
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  /** The progress number. NOT the curve PDA's lamport balance (contract §3.3). */
  realSolReserves: bigint;
  realTokenReserves: bigint;
  /** Per-launch snapshot. Quoting from `global.trade_fee_bps` disagrees silently. */
  tradeFeeBps: bigint;
  /** EXCLUDES the migration reserve (contract §3.1). */
  graduationTargetLamports: bigint;
  migrationReserveLamports: bigint;
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
   * Any real trade moves it (contract §5.6).
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
  /** `graduation_target_lamports` alone — target met, reserve still raising (contract §7.1 row 5). */
  target: CurvePoint;
  /** target + migration reserve — fully funded, buys revert, sells still work (row 4). */
  ceiling: CurvePoint;
  /** `real_sol_reserves / (target + reserve)`, clamped to [0,1]. That denominator is what `buy` caps against. */
  progress: number;
  /** Lamports a buyer must SEND to fill the curve (already fee-grossed), or null when fully funded. */
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
  /** Migration closed the curve; its reserves no longer describe a market (contract §7.2). */
  | 'graduated'
  /** No virtual reserves to price against — nothing to draw. */
  | 'no-virtual-reserves'
  /** target + reserve is zero, so there is no progress denominator. */
  | 'no-graduation-target'
  /** Fee outside [0, MAX_FEE_BPS]: a config bug, not a user action (contract §6, 6003). */
  | 'fee-out-of-range';

export type CurveGeometryResult =
  | { ok: true; geometry: CurveGeometry }
  | { ok: false; reason: CurveUnplottableReason };

/**
 * Port of `lamports_until_target` (curve.rs:216-240).
 *
 * `ceiling` is `graduation_target + migration_reserve` — the target PLUS the
 * reserve, which is what `buy` actually caps against (lib.rs:466-469). The
 * returned value is grossed up for the fee, so it is what a buyer must SEND,
 * not what lands on the curve.
 *
 * `null` = already fully funded. The program answers that case with
 * `AwaitingMigration` (6019), NOT `AlreadyComplete` (lib.rs:476-479).
 */
export function lamportsUntilTarget(realSolReserves: bigint, ceiling: bigint, feeBps: bigint): bigint | null {
  if (realSolReserves >= ceiling) return null;
  const remaining = ceiling - realSolReserves; // post-fee
  if (feeBps >= BPS_DENOMINATOR || feeBps < 0n) throw new RangeError('fee out of range');
  const denom = BPS_DENOMINATOR - feeBps;
  return (remaining * BPS_DENOMINATOR + denom - 1n) / denom; // div_ceil
}

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
 * `real_sol_reserves` accumulates the POST-fee amount, so the fee never enters
 * the curve and does not belong in this shape. Integer truncation on real trades
 * always rounds in the curve's favour, so `k` drifts marginally upward over a
 * launch's life; the plot is redrawn from live state, so it tracks that drift.
 */
export function buildCurveGeometry(
  curve: CurveSnapshot,
  options: { sampleCount?: number } = {},
): CurveGeometryResult {
  // A graduated curve's reserves were gutted by migration — `real_sol_reserves`
  // is decremented by (target + reserve) and `real_token_reserves` zeroed
  // (lib.rs:1167-1178). Plotting from them would draw a wrong-shaped curve and
  // report a graduated launch as ~0% raised. The pre-graduation `k` cannot be
  // rebuilt from the curve alone (`token_total_supply` lives on `global`), so we
  // refuse rather than guess.
  if (curve.complete) return { ok: false, reason: 'graduated' };
  if (curve.tradeFeeBps < 0n || curve.tradeFeeBps > MAX_FEE_BPS) return { ok: false, reason: 'fee-out-of-range' };
  if (curve.virtualSolReserves <= 0n || curve.virtualTokenReserves <= 0n) {
    return { ok: false, reason: 'no-virtual-reserves' };
  }

  const ceilingRaised = curve.graduationTargetLamports + curve.migrationReserveLamports;
  if (ceilingRaised <= 0n) return { ok: false, reason: 'no-graduation-target' };

  const realSol = curve.realSolReserves > 0n ? curve.realSolReserves : 0n;
  const realToken = curve.realTokenReserves > 0n ? curve.realTokenReserves : 0n;
  const k = (curve.virtualSolReserves + realSol) * (curve.virtualTokenReserves + realToken);

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
      lamportsUntilCeiling: lamportsUntilTarget(realSol, ceilingRaised, curve.tradeFeeBps),
      pastCeiling,
    },
  };
}

/** Lamports → a plain SOL string. Exact: no float ever touches the value. */
export function formatSol(lamports: bigint, decimalPlaces = 4): string {
  const dp = clampInt(decimalPlaces, 0, 9);
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = (abs / LAMPORTS_PER_SOL).toString();
  if (dp === 0) return `${negative ? '-' : ''}${whole}`;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').slice(0, dp);
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * Label the spot price WITHOUT assuming the launch mint's decimals.
 *
 * The program never stores decimals and never constrains them (contract §9 row 3),
 * so with no `tokenDecimals` read from the mint account the only honest unit is
 * raw base units. Never assume 9.
 */
export function spotPriceLabel(price: number, tokenDecimals?: number): { value: string; unit: string } {
  if (!Number.isFinite(price) || price < 0) return { value: '—', unit: 'unreadable' };
  if (tokenDecimals == null || !Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) {
    return { value: formatRatio(price), unit: 'lamports per base unit' };
  }
  const solPerToken = (price * 10 ** tokenDecimals) / Number(LAMPORTS_PER_SOL);
  return { value: formatRatio(solPerToken), unit: 'SOL per token' };
}

function formatRatio(v: number): string {
  if (v === 0) return '0';
  if (v < 0.000001 || v >= 1e9) return v.toExponential(3);
  const s = v.toPrecision(4);
  // Only strip trailing zeros from a FRACTION. Applying it to "1000" leaves "1",
  // i.e. a price understated by 1000x — the exact silent-wrong-number bug this
  // whole surface exists to avoid.
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
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
