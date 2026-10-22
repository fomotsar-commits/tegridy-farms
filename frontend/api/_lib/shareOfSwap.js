// One rule for a share of each swap, shared with the Range tab (PR #915): what positions get
// rounds DOWN, and what is taken from them (the venue's cut, each wallet's) rounds UP, so
// neither reads in its own favour; a real share under 0.0001% is "<0.0001%", never "0%". On
// a pool whose fee can rise above its tier's rate, a figure is a floor or a range up to the
// pool's own ceiling. Inputs that are not real rates throw: unread never reads as 0%.

/** The most a swap's fee can be, base and dynamic together: MAX_FEE_RATE_NUMERATOR (pool_fee.rs; position.test.js holds them equal). */
export const MAX_FEE_RATE = 40_000;
// pool_fee.rs VOLATILITY_ACCUMULATOR_SCALE and DYNAMIC_FEE_CONTROL_DENOMINATOR.
const SCALE = 10_000n;
const CONTROL = 100_000n;

const rate = (n, what) => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new RangeError(`${what} must be a finite number at or above 0, not ${String(n)}`);
  return n;
};

/**
 * `fee`: the swap's fee rate, per million of the swap. `share`: a party's share of that fee,
 * per million of the fee. `side`: "positions" (rounded down) or "deduction" (rounded up).
 * The share of the swap, as a percent to four decimals: 3333 ppm at 84% is "0.2799%".
 */
export function shareOfSwap(fee, share, side) {
  rate(fee, "fee");
  rate(share, "share");
  if (side !== "positions" && side !== "deduction") throw new RangeError(`side must be "positions" or "deduction", not ${String(side)}`);
  const v = (fee * share) / 1_000_000;
  if (v === 0) return "0%";
  if (v < 1) return "<0.0001%";
  return `${(side === "positions" ? Math.floor(v) : Math.ceil(v)) / 10_000}%`;
}

/**
 * The most a pool's swap fee can be: its tier's rate plus the dynamic part at the pool's
 * highest volatility, ceil(control x (maxVolatility x tickSpacing)^2 / 1e13), the dynamic
 * part and the total each capped at the program's 4% (swap.rs get_total_fee_rate,
 * compute_dynamic_fee_rate). `dynamic` null (no dynamic fee): null.
 */
export function feeCeiling(tradeFeeRate, dynamic, tickSpacing) {
  rate(tradeFeeRate, "tradeFeeRate");
  if (dynamic === null) return null;
  const crossed = BigInt(rate(dynamic.maxVolatilityAccumulator, "maxVolatilityAccumulator")) * BigInt(rate(tickSpacing, "tickSpacing"));
  const den = CONTROL * SCALE * SCALE;
  const raw = (BigInt(rate(dynamic.dynamicFeeControl, "dynamicFeeControl")) * crossed * crossed + den - 1n) / den;
  const part = raw > BigInt(MAX_FEE_RATE) ? MAX_FEE_RATE : Number(raw);
  return Math.min(MAX_FEE_RATE, tradeFeeRate + part);
}

/**
 * A share of each swap, as text, on a pool whose highest fee is `ceiling` (feeCeiling, or null
 * for none). When the fee can rise above the tier's rate, the figure is a floor ("at least
 * X"), or on a 0% tier a range ("0% to X"); a wallet with no share gets "0%" either way.
 */
export function swapShareText(fee, share, side, ceiling) {
  const base = shareOfSwap(fee, share, side);
  if (share === 0 || ceiling === null || !(rate(ceiling, "ceiling") > fee)) return base;
  if (fee === 0) {
    const top = shareOfSwap(ceiling, share, side);
    return `0% to ${top === "<0.0001%" ? "under 0.0001%" : top}`;
  }
  return base === "<0.0001%" ? "more than 0%" : `at least ${base}`;
}
