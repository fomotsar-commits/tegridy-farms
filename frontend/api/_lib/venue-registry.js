// The one server-side list of collections this venue trades: the Ethereum
// ERC-721 subset of src/nakamigos/constants.js COLLECTIONS (api/ cannot import
// src/). slug === openseaSlug for every entry, so one map serves both names.
// Every route's allowlist reads this file; venue-registry.test.js holds it
// equal to the client's VENUE_COLLECTIONS.
export const VENUE_SLUG_CONTRACTS = Object.freeze({
  nakamigos: "0xd774557b647330c91bf44cfeab205095f7e6c367",
  gnssart: "0xa1de9f93c56c290c48849b1393b09eb616d55dbb",
  junglebay: "0xd37264c71e9af940e49795f0d3a8336afaafdda9",
  junglebaygoldcards: "0x6aa03f42c5366e2664c887eb2e90844ca00b92f3",
});

export const VENUE_SLUGS = new Set(Object.keys(VENUE_SLUG_CONTRACTS));
export const VENUE_CONTRACTS = new Set(Object.values(VENUE_SLUG_CONTRACTS));

// The Base ERC-721s that trade here on Base (the client's venueBuy
// collections), by OpenSea slug: their OpenSea listings are bought, and they
// are listed on the venue's order book and bid on, all through Seaport 1.6 on
// Base. They join no Ethereum allowlist: every route that serves them checks
// the chain (BOOK_CHAIN_IDS), never the request's word for it.
export const BASE_BUY_SLUG_CONTRACTS = Object.freeze({
  bojungless: "0x36afee4fadc3b77ff5f1f9a040e264150afb979a",
  "seeds-from-the-memetic-garden": "0xb34bb1d81a4e5f9dca7360c3043ad50db2ea87f3",
});

export const BASE_BUY_SLUGS = new Set(Object.keys(BASE_BUY_SLUG_CONTRACTS));
export const BASE_BUY_CONTRACTS = new Set(Object.values(BASE_BUY_SLUG_CONTRACTS));

// The chain each contract on the venue's order book settles on, by contract:
// the Ethereum venue collections on 1, the Base ones on 8453. A single listing,
// its cancel and its fill read the chain from here.
export const BOOK_CHAIN_IDS = Object.freeze(Object.fromEntries([
  ...[...VENUE_CONTRACTS].map((c) => [c, 1]),
  ...[...BASE_BUY_CONTRACTS].map((c) => [c, 8453]),
]));

/** The chain id a contract's orders settle on, or null when it is not on the book. */
export function bookChainId(contract) {
  if (typeof contract !== "string") return null;
  return BOOK_CHAIN_IDS[contract.toLowerCase()] ?? null;
}

/** The order-book contracts on one chain. */
export function bookContractsOn(chainId) {
  return Object.keys(BOOK_CHAIN_IDS).filter((c) => BOOK_CHAIN_IDS[c] === chainId);
}

// The Base OpenSea slugs, by chain name, for the routes that name a chain.
export const SLUG_CONTRACTS_BY_CHAIN = Object.freeze({
  ethereum: VENUE_SLUG_CONTRACTS,
  base: BASE_BUY_SLUG_CONTRACTS,
});

// OpenSea slugs of the view-only family collections. Readable for stats and
// items only (api/opensea.js): never offers, events or a POST, and their
// contracts join no Ethereum allowlist. The two Base buy slugs above are among
// them, and those two alone also have their listings read.
export const READ_ONLY_OPENSEA_SLUGS = new Set([
  "the-memes-by-junglebay-x-mfers-artists",
  "rare-towelie-cards",
  "seeds-from-the-memetic-garden",
  "bojungless",
]);
