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
 * The exact ETH amount of a wei string, every digit kept: "18990000000000000"
 * is "0.01899". null for anything that is not a plain wei string.
 */
export function exactEth(priceWei) {
  if (typeof priceWei !== "string" || !/^\d{1,40}$/.test(priceWei)) return null;
  const wei = BigInt(priceWei);
  const unit = 10n ** 18n;
  const frac = (wei % unit).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${wei / unit}.${frac}` : `${wei / unit}`;
}

// One step of the shown price: 0.000001 ETH.
const SHOWN_STEP_WEI = 10n ** 12n;

/**
 * A wei amount as shown to someone who will pay it: exact up to six decimals,
 * otherwise rounded UP to six (84939999999999000 wei, 0.084939999999999, shows
 * 0.08494). Never less than the wei, at most 0.000001 ETH more. Rounding to the
 * nearest would show 0.084943 for 0.08494349, less than is paid, so it is a
 * ceiling. null for anything that is not a plain wei string.
 */
export function shownEth(priceWei) {
  if (exactEth(priceWei) == null) return null;
  const wei = BigInt(priceWei);
  const up = ((wei + SHOWN_STEP_WEI - 1n) / SHOWN_STEP_WEI) * SHOWN_STEP_WEI;
  return exactEth(up.toString());
}

/**
 * A listing's price as the buyer is shown it. Never a figure below what the
 * wallet asks for (formatPrice rounds to 4 decimals: 0.018949 reads 0.0189), so
 * it is read from the listing's wei whenever it carries one: exact up to six
 * decimals, rounded up past that (shownEth). Both OpenSea's
 * `price.current.value` and the order book's `price_wei` are the buyer's total.
 */
export function formatListingPrice(listing, opts) {
  return shownEth(listing?.priceWei) ?? formatPrice(listing?.price, opts);
}

/** "0.084939999999999 ETH exactly" when the shown price was rounded, for a tooltip; else undefined. */
export function listingPriceTitle(listing) {
  const exact = exactEth(listing?.priceWei);
  return exact != null && exact !== shownEth(listing.priceWei) ? `${exact} ETH exactly` : undefined;
}

/**
 * The exact total of several listings, from their wei, or null when any one
 * of them has no wei (the caller then shows its own figure).
 */
export function listingsTotalWei(listings) {
  let total = 0n;
  for (const l of Array.isArray(listings) ? listings : []) {
    if (exactEth(l?.priceWei) == null) return null;
    total += BigInt(l.priceWei);
  }
  return total;
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
