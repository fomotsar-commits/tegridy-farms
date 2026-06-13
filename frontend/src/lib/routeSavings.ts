import { formatUnits } from 'viem';

/**
 * Trade route-savings math, extracted as a pure helper so it can be unit-tested
 * independently of the React tree (F226/F227/F235/F196).
 *
 * The aggregator quotes report `amountOut` in WEI; the on-chain (Tegridy /
 * Uniswap) outputs are already human token amounts. `aggOutUnits` normalizes
 * the aggregator legs to token units using the receive token's decimals so the
 * whole comparison is apples-to-apples (no 3.5e+25 wei vs 35.4M token mixing).
 */
export function aggOutUnits(amountOutWei: string, toDecimals: number): number {
  try {
    return parseFloat(formatUnits(BigInt(amountOutWei), toDecimals));
  } catch {
    return NaN;
  }
}

export interface RouteSavingsInput {
  /** Tegridy native-pool output in human token units (null when no pair / 0). */
  tegridyOutput: number | null;
  /** Uniswap V2 output in human token units (null when unavailable). */
  uniOutput: number | null;
  /** Aggregator quotes with WEI `amountOut`. */
  aggQuotes: { amountOut: string }[];
  /** Receive-token decimals, for normalizing the aggregator legs. */
  toDecimals: number;
}

export interface RouteSavingsResult {
  /** Best-vs-worst-credible-venue savings %, clamped to [0, 999]. */
  savingsPct: number;
  /** True when the Tegridy pool's quote is a degenerate-low (near-empty) outlier. */
  tegridyIsLowLiquidity: boolean;
}

// A venue more than this fraction below the median is treated as low-liquidity
// (excluded from the savings denominator, flagged in the UI).
const LOW_LIQ_FACTOR = 0.5;
// Hard cap so the displayed % can never render in exponential form.
const MAX_SAVINGS_PCT = 999;

/**
 * Compute the "Route Savings vs worst venue" percentage from the multi-venue
 * quote set, after:
 *  - normalizing aggregator WEI outputs to token units (F226/F227),
 *  - excluding degenerate-low (empty-pool) venues from the denominator (F235),
 *  - clamping the result so it can never render scientific notation (F226).
 */
export function computeRouteSavings(input: RouteSavingsInput): RouteSavingsResult {
  const { tegridyOutput, uniOutput, aggQuotes, toDecimals } = input;

  const outs: number[] = [
    tegridyOutput !== null && Number.isFinite(tegridyOutput) && tegridyOutput > 0 ? tegridyOutput : NaN,
    uniOutput !== null && Number.isFinite(uniOutput) && uniOutput > 0 ? uniOutput : NaN,
    ...aggQuotes.map((q) => aggOutUnits(q.amountOut, toDecimals)),
  ].filter((n) => Number.isFinite(n) && n > 0);

  if (outs.length < 2) {
    return { savingsPct: 0, tegridyIsLowLiquidity: false };
  }

  const sorted = [...outs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const lowLiqThreshold = median * LOW_LIQ_FACTOR;

  const tegridyIsLowLiquidity =
    tegridyOutput !== null &&
    Number.isFinite(tegridyOutput) &&
    tegridyOutput > 0 &&
    tegridyOutput < lowLiqThreshold;

  const credible = sorted.filter((n) => n >= lowLiqThreshold);
  if (credible.length < 2) {
    return { savingsPct: 0, tegridyIsLowLiquidity };
  }

  const best = credible[credible.length - 1]!;
  const worst = credible[0]!;
  const pct = worst > 0 ? ((best - worst) / worst) * 100 : 0;
  return { savingsPct: Math.min(pct, MAX_SAVINGS_PCT), tegridyIsLowLiquidity };
}
