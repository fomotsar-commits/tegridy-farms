/**
 * Consistent ETH price formatting across the app.
 *
 * Rules:
 *  - null / undefined / NaN / Infinity  => fallback (default "—")
 *  - 0                                  => "0"
 *  - < 1,000                            => 4 decimal places  (e.g. "0.1234")
 *  - >= 1,000                           => comma-separated with 2 decimals (e.g. "1,234.50")
 */
export function formatPrice(value, { fallback = "\u2014", decimals = 4 } = {}) {
  if (value == null || !isFinite(value)) return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  if (n === 0) return "0";
  // Dust floor: a non-zero value below 0.0001 would round to "0.0000" via the
  // toFixed(4) path and read as exactly zero. Match Blur/OpenSea and show a
  // "less-than" marker so dust is distinguishable from a free/zero listing.
  if (Math.abs(n) < 0.0001) return n < 0 ? ">-0.0001" : "<0.0001";
  if (Math.abs(n) >= 1000) {
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return n.toFixed(decimals);
}
