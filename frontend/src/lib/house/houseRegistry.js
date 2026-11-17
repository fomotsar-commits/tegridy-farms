// The site's reading of houseRegistry.json: the wallets the venue itself trades from.
//
// Every marketplace surface that shows a bid, offer or listing maker names these "House";
// the lending desk leaves their bids out of its numbers; the integrity panel keeps their
// trades apart from everyone else's. The list is empty until the owner names the house
// bidder's wallet, and with it empty nothing on any page changes.
//
// Plain JS, typed for TS callers by houseRegistry.d.ts, so the marketplace's .jsx and the
// lending desk's .ts read one list. Vite bundles the JSON; a plain Node script cannot import
// this file and uses houseRegistryCore.js instead (that file says why).
import REGISTRY from "./houseRegistry.json";
import { createHouseRegistry } from "./houseRegistryCore.js";

export { HOUSE_LABEL, createHouseRegistry } from "./houseRegistryCore.js";

const house = createHouseRegistry(REGISTRY);

/** The house wallets, lowercase. A new array on every call. */
export function houseWallets() {
  return house.houseWallets();
}

/** True for a registered house wallet in any letter case; false for anything not 0x + 40 hex. */
export function isHouseWallet(address) {
  return house.isHouseWallet(address);
}

/** "House" for a house wallet, else null. */
export function houseLabel(address) {
  return house.houseLabel(address);
}

/** "House · buys N (any TICKER)" for a house collection bid, "House" when N or the ticker is unknown, else null. */
export function houseBidLabel(address, bid) {
  return house.houseBidLabel(address, bid);
}
