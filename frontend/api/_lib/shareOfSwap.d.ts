/** The most a swap's fee can be (per million): the program's MAX_FEE_RATE_NUMERATOR. */
export const MAX_FEE_RATE: number;
/** A party's share of each swap, as text: positions rounded down, deductions rounded up (shareOfSwap.js). */
export function shareOfSwap(fee: number, share: number, side: 'positions' | 'deduction'): string;
/** The most a pool's swap fee can be (per million), or null when it has no dynamic fee. */
export function feeCeiling(tradeFeeRate: number, dynamic: { dynamicFeeControl: number; maxVolatilityAccumulator: number } | null, tickSpacing: number): number | null;
/** A share of each swap, as text, on a pool whose highest fee is `ceiling` (null: no dynamic fee). */
export function swapShareText(fee: number, share: number, side: 'positions' | 'deduction', ceiling: number | null): string;
