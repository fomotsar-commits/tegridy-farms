/**
 * Trade valuation — transparent, oracle-free heuristics.
 *
 * estimateTokenValue mirrors the detail modal's FairValueBadge math exactly
 * (one formula everywhere, so the trade window never disagrees with the
 * modal): floor × a log-scaled rarity multiplier (~1× for commons up to
 * ~2.5×, hard-capped at 5× floor to avoid absurd estimates).
 */

/**
 * @param {object} p
 * @param {number} p.floor   collection floor in ETH
 * @param {number} [p.rank]  rarity rank (1 = rarest); omit → floor value
 * @param {number} [p.supply] collection supply (needed with rank)
 * @returns {number} estimated ETH value (0 when floor is unknown)
 */
export function estimateTokenValue({ floor, rank, supply }) {
  if (!Number.isFinite(floor) || floor <= 0) return 0;
  if (!Number.isFinite(rank) || rank <= 0 || !Number.isFinite(supply) || supply <= 0) {
    return floor;
  }
  const percentile = 1 - (rank - 1) / supply; // 0..1, higher = rarer
  const multiplier = 1 + (Math.log1p(percentile * 9) / Math.log(10)) * 1.5;
  return Math.min(floor * multiplier, floor * 5);
}

/**
 * Signed imbalance of a trade from one side's perspective:
 *   delta = (get - give) / give
 * -0.07 → "you're giving ≈7% more than you receive". Null when either side
 * is unknown or zero (no meter shown).
 */
export function tradeDelta(giveValue, getValue) {
  if (!Number.isFinite(giveValue) || !Number.isFinite(getValue)) return null;
  if (giveValue <= 0 || getValue <= 0) return null;
  return (getValue - giveValue) / giveValue;
}
