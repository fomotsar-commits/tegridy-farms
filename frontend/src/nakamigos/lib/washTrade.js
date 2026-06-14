/**
 * Wash-trade / self-sale detection (F709).
 *
 * A "self-sale" is a sale where the same wallet sits on both sides of the
 * trade (buyer === seller). These do not represent genuine demand and can be
 * used to inflate volume, average price, and price history, so we exclude them
 * from those aggregations and badge them in the activity feed.
 *
 * This is a pure, additive filter over sale objects that are ALREADY fetched —
 * it never invents data. Detection is only possible when both party addresses
 * are present on the sale object; if either side is missing we return false
 * (we don't guess), so legitimate sales with partial data are never dropped.
 *
 * Sale objects come from two shapes in this app, both carrying full addresses:
 *   - Activity feed sales:      { fromFull, toFull }   (api.js / lib/eventFeed.js)
 *   - Token price-history sales: { from, to }          (fetchTokenSalesHistory)
 * We read fromFull/toFull first and fall back to from/to.
 */

/** A 0x-prefixed 40-hex-char EVM address, else null. */
function normalizeAddr(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(v) ? v : null;
}

/**
 * True when a sale is a self-sale (same wallet buys from itself).
 *
 * Requires both a valid seller and buyer address; truncated display strings
 * (e.g. "0xf46a...1234") are NOT treated as addresses, so a sale is only
 * flagged when full, comparable addresses are available on both sides.
 *
 * @param {object} sale
 * @returns {boolean}
 */
export function isSelfSale(sale) {
  if (!sale || typeof sale !== "object") return false;
  const seller = normalizeAddr(sale.fromFull) || normalizeAddr(sale.from);
  const buyer = normalizeAddr(sale.toFull) || normalizeAddr(sale.to);
  if (!seller || !buyer) return false;
  return seller === buyer;
}

/**
 * Drop self-sales from a list of sale objects. Non-sale activity rows (which
 * have no buyer/seller pairing, e.g. listings/bids) are left untouched.
 *
 * @template T
 * @param {T[]} sales
 * @returns {T[]}
 */
export function excludeSelfSales(sales) {
  if (!Array.isArray(sales)) return sales;
  return sales.filter((s) => !isSelfSale(s));
}
