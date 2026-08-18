// Bid/ask book maths for the order-book panel. Pure — no React, no network.
//
// Bids arrive already normalized to price-per-item (api-offers
// `normalizeCollectionOffer`), so this side no longer drops bids that sit above
// the best ask. That drop existed to hide one symptom of the un-normalized
// feed — an N-item collection bid read as an N-times-too-high unit bid — and it
// paid for that by deleting real multi-quantity depth from the chart. With the
// price fixed at the source there is nothing left to compensate for.
//
// A book that genuinely crosses is still possible (an aggressive bid nobody has
// taken yet, or an ask on the native rail an OpenSea bid cannot reach). That is
// a fact about the market, so it is reported as `crossed` and the spread is
// withheld, rather than rendered as a negative percentage or papered over by
// deleting the bid.

function positivePrices(rows, pick) {
  const out = [];
  for (const row of rows || []) {
    const p = pick(row);
    if (p != null && Number.isFinite(p) && p > 0) out.push(p);
  }
  return out;
}

/**
 * @param {Array} listings - ask side; each row has a per-token `price` in ETH
 * @param {Array} collectionOffers - bid side; each row has a per-item `price` in ETH
 * @returns {{ askPrices: number[], bidPrices: number[], bestAsk: number|null,
 *            bestBid: number|null, spread: number|null, spreadPct: number|null,
 *            crossed: boolean }}
 *          askPrices ascending, bidPrices descending. `spread`/`spreadPct` are
 *          null unless both sides exist AND the book is not crossed.
 */
export function computeBookSides(listings = [], collectionOffers = []) {
  const askPrices = positivePrices(listings, (l) => l?.price).sort((a, b) => a - b);
  const bidPrices = positivePrices(collectionOffers, (o) => o?.price).sort((a, b) => b - a);

  const bestAsk = askPrices.length > 0 ? askPrices[0] : null;
  const bestBid = bidPrices.length > 0 ? bidPrices[0] : null;
  const crossed = bestAsk != null && bestBid != null && bestBid >= bestAsk;

  const spread = bestAsk != null && bestBid != null && !crossed ? bestAsk - bestBid : null;
  const spreadPct = spread != null && bestAsk > 0 ? (spread / bestAsk) * 100 : null;

  return { askPrices, bidPrices, bestAsk, bestBid, spread, spreadPct, crossed };
}
