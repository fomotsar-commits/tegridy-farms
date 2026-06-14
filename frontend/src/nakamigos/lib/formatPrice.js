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

/**
 * Convert an ETH amount to a "≈ $X" USD string, given a live ETH/USD rate.
 *
 * Honesty rules — this NEVER fabricates a rate. It only formats; the rate must
 * be supplied by a real source (the Chainlink-backed PriceContext or the cached
 * CoinGecko feed in useEthUsd). When no rate is available the caller passes
 * null/0 and we return the fallback (default "" so nothing renders) — we never
 * invent a number.
 *
 *  - eth or rate null / NaN / Infinity / <= 0 rate  => fallback (no USD shown)
 *  - usd >= 1,000   => "$1,234" (no cents, comma-separated)
 *  - usd >= 1       => "$12.34" (2 decimals)
 *  - 0 < usd < 1    => "$0.42"  (2 decimals)
 *  - usd rounds to 0 but is non-zero (dust) => "<$0.01"
 *  - eth === 0      => "$0"
 *
 * @param {number} eth   ETH amount to convert
 * @param {number} rate  live ETH/USD price (USD per 1 ETH)
 * @param {{ prefix?: string, fallback?: string }} [opts]
 */
export function formatUsd(eth, rate, { prefix = "≈ ", fallback = "" } = {}) {
  if (eth == null || rate == null) return fallback;
  const e = Number(eth);
  const r = Number(rate);
  if (!isFinite(e) || !isFinite(r) || Number.isNaN(e) || Number.isNaN(r)) return fallback;
  // A non-positive rate is not a real price — never render USD off it.
  if (r <= 0) return fallback;
  const usd = e * r;
  if (usd === 0) return `${prefix}$0`;
  if (usd < 0) return fallback; // prices are non-negative on this surface
  // Dust: a tiny non-zero value that would round to $0.00 — show a "less-than"
  // marker so it reads as "small", not "free".
  if (usd < 0.005) return `${prefix}<$0.01`;
  if (usd >= 1000) {
    return `${prefix}$${Math.round(usd).toLocaleString("en-US")}`;
  }
  return `${prefix}$${usd.toFixed(2)}`;
}
