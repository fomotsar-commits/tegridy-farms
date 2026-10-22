// One rule for a share of each swap, for the position link (position.js) and the Range tab
// (src/lib/solana/clmm/feeText.ts, venueEarns.ts): what positions get rounds DOWN, and what
// is taken from them (the venue's cut, each wallet's) rounds UP, so neither reads in its own
// favour. A real share under 0.0001% is "<0.0001%", never "0%".

/**
 * `fee`: the swap's fee rate, per million of the swap. `share`: a party's share of that fee,
 * per million of the fee. `side`: "positions" (rounded down) or "deduction" (rounded up).
 * The share of the swap, as a percent to four decimals: 3333 ppm at 84% is "0.2799%".
 */
export function shareOfSwap(fee, share, side) {
  const v = (fee * share) / 1_000_000;
  if (!(v > 0)) return "0%";
  if (v < 1) return "<0.0001%";
  return `${(side === "positions" ? Math.floor(v) : Math.ceil(v)) / 10_000}%`;
}
