/**
 * How far a constant-product share falls behind holding both sides when the price moves
 * by a factor r, in percent: 100 * (1 - 2*sqrt(r) / (1 + r)). A pure ratio, display only:
 * no money passes through it, and the amounts do not change it. Symmetric in r and 1/r,
 * so "doubles or halves" is one number.
 */
export function impermanentLossPct(r: number): number {
  return 100 * (1 - (2 * Math.sqrt(r)) / (1 + r));
}

/** The percent as the sentence prints it: one decimal, a trailing .0 dropped ("5.7%", "20%"), as feeRateText does. */
export function impermanentLossPctText(r: number): string {
  return `${Number(impermanentLossPct(r).toFixed(1))}%`;
}

/** The Add panel says the impermanent-loss sentence. The owner's "no" is this one line (DESIGN section 5, call 2). */
export const IL_LINE_SHOWN = true;
