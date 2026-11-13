// Reading a collection offer: how many NFTs it bids for, and its price PER ITEM.
//
// Split out of api-offers.js, word for word, so a surface that only READS bids (the NFT
// lending market card, lib/gondi/lenderPitch.ts) can use the marketplace's own normaliser
// without loading api-offers.js and api.js behind it: wallet, Seaport signing and the rarity
// table, 227 KB on the wire when measured on the live Lend tab (2026-11-11). api-offers.js
// imports these back and still exports the two it always exported.

// Seaport item types that can carry the NFT leg of a criteria offer:
// 2/3 = ERC721/ERC1155, 4/5 = the *_WITH_CRITERIA variants a collection or
// trait offer actually uses.
export const NFT_ITEM_TYPES = new Set([2, 3, 4, 5]);

/**
 * How many NFTs a criteria offer is bidding for.
 *
 * A collection/trait offer for N items is a PARTIAL_OPEN order: the WETH offer
 * item holds N x price-per-item, and the NFT criteria consideration item holds
 * N, so each 1/N fill hands over one token for one unit price. Absent that
 * item the order is a single-item bid.
 */
export function collectionOfferQuantity(parameters) {
  for (const c of parameters?.consideration || []) {
    if (!NFT_ITEM_TYPES.has(Number(c?.itemType))) continue;
    const n = Number(c?.startAmount);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }
  return 1;
}

/**
 * Normalize one `offers/collection/{slug}` (or `/all`) entry to a PRICE PER ITEM.
 *
 * OpenSea's `price.value` is the whole-order total, so an N-item bid read
 * straight off it reports a bid N times higher than any single token could
 * actually be sold into. Every consumer — depth chart, best-bid tile, derived
 * trait bids — compares these against per-token ask prices, which is how a
 * 50-item bid ended up rendering above the floor and inverting the spread
 * (see DepthChart.computeSpread's "invalid" branch). Dividing at the source is
 * the fix; the panels then need no compensating filter of their own.
 *
 * The quantity is only knowable from `protocol_data.parameters`. When OpenSea
 * omits it there is nothing to divide by and the total is the best available
 * reading — `quantityKnown: false` marks that so a consumer can decline to
 * treat it as a verified unit price.
 */
export function normalizeCollectionOffer(o) {
  const params = o?.protocol_data?.parameters;
  const quantityKnown = !!params;
  const quantity = quantityKnown ? collectionOfferQuantity(params) : 1;
  const totalWei = params?.offer?.[0]?.startAmount || o?.price?.value || null;
  const totalEth = totalWei ? safePriceFromWei(totalWei) : null;
  return {
    price: totalEth != null ? totalEth / quantity : null,
    priceTotal: totalEth,
    quantity,
    quantityKnown,
    currency: o?.price?.currency,
    maker: params?.offerer,
    orderHash: o?.order_hash,
    criteria: o?.criteria,
  };
}

export function safePriceFromWei(wei) {
  try {
    if (!wei || wei === "0") return 0;
    return Number(BigInt(wei) / BigInt(1e12)) / 1e6;
  } catch {
    return 0;
  }
}
