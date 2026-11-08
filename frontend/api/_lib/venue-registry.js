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

// The Base ERC-721s whose OpenSea listings are bought here (the client's
// venueBuy collections), by OpenSea slug. api/opensea.js admits exactly two
// things for them: a GET of their best listings, and a Base listing fill
// whose answer moves only these contracts. They join no Ethereum allowlist:
// no offer, order, event or order-book route serves them.
export const BASE_BUY_SLUG_CONTRACTS = Object.freeze({
  bojungless: "0x36afee4fadc3b77ff5f1f9a040e264150afb979a",
  "seeds-from-the-memetic-garden": "0xb34bb1d81a4e5f9dca7360c3043ad50db2ea87f3",
});

export const BASE_BUY_SLUGS = new Set(Object.keys(BASE_BUY_SLUG_CONTRACTS));
export const BASE_BUY_CONTRACTS = new Set(Object.values(BASE_BUY_SLUG_CONTRACTS));

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
