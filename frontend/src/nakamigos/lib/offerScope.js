// Which OpenSea bids buy ANY token of a collection. Shared by the marketplace's
// collection-offer reads (api-offers.js) and the NFT lending card (lib/gondi/lenderPitch.ts),
// so "best collection offer" means the same bid on both.

/**
 * Does this Seaport order buy ANY token of the collection? Only when the NFT it asks for is a
 * criteria item (ERC721/1155_WITH_CRITERIA, item types 4 and 5) with criteria 0. Item type 2
 * or 3 is an offer on ONE token; a non-zero criteria is a trait or token-list root.
 *
 * Measured 2026-11-09: OpenSea's `offers/collection/junglebay/all` returned 50 offers, every
 * one item type 2 (0.13 to 0.155 WETH on single JBACs, floor 0.0278): read as collection bids
 * they would have said "a buyer already bids 0.155". `offers/collection/junglebay` returned
 * the real ones (item type 4, criteria 0, best 0.0199).
 */
export function buysAnyTokenOrder(raw) {
  const items = raw?.protocol_data?.parameters?.consideration;
  if (!Array.isArray(items)) return false;
  const nft = items.find((c) => [2, 3, 4, 5].includes(Number(c?.itemType)));
  if (!nft) return false;
  return (Number(nft.itemType) === 4 || Number(nft.itemType) === 5) && String(nft.identifierOrCriteria) === "0";
}
