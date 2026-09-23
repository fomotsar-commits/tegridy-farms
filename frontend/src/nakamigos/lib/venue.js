import { COLLECTIONS } from "../constants";

// The one rule for money on this venue. The money path is Seaport on Ethereum
// with ERC-721 ownerOf pre-flights, so a collection trades here only as an
// Ethereum ERC-721 the registry flags venueTrade, with a real address. Every
// money sink asks venueRefusal before it touches a wallet, and every surface
// reads canTradeOnVenue. Cancels move no value and stay open, except for an
// order on another chain: cancelRefusal.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_ID_RE = /^\d{1,10}$/;

export const NOT_VENUE_TRADEABLE = "not-venue-tradeable";

export function canTradeOnVenue(collection) {
  return !!collection
    && collection.venueTrade === true
    && collection.chain === "ethereum"
    && collection.standard === "erc721"
    && typeof collection.contract === "string"
    && ADDRESS_RE.test(collection.contract);
}

export const VENUE_COLLECTIONS = Object.freeze(Object.values(COLLECTIONS).filter(canTradeOnVenue));

const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");

/** The venue collection at this contract (any case), or null. */
export function venueCollectionByContract(address) {
  const a = lower(address);
  if (!a) return null;
  return VENUE_COLLECTIONS.find((c) => c.contract.toLowerCase() === a) || null;
}

/** The venue collection with this app slug or OpenSea slug, or null. */
export function venueCollectionBySlug(slug) {
  if (typeof slug !== "string" || !slug) return null;
  return VENUE_COLLECTIONS.find((c) => c.slug === slug || c.openseaSlug === slug) || null;
}

/** Any registry collection at this contract, on any chain. For refusal copy only. */
export function collectionByContractAnyChain(address) {
  const a = lower(address);
  if (!a) return null;
  return Object.values(COLLECTIONS).find((c) => lower(c.contract) === a) || null;
}

function collectionBySlugAnyChain(slug) {
  if (typeof slug !== "string" || !slug) return null;
  return Object.values(COLLECTIONS).find((c) => c.slug === slug || c.openseaSlug === slug) || null;
}

function refusalFor(collection) {
  return {
    error: NOT_VENUE_TRADEABLE,
    message: collection?.market?.name
      ? `${collection.name} trades on ${collection.market.name}, not on this venue.`
      : "This collection does not trade on this venue.",
  };
}

/** null when the contract trades here, else the `{ error, message }` a sink returns. */
export function venueRefusal(address) {
  if (venueCollectionByContract(address)) return null;
  return refusalFor(collectionByContractAnyChain(address));
}

/** The first refusal among several contracts (an empty list is refused too). */
export function venueRefusalForAll(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  if (list.length === 0) return refusalFor(null);
  for (const address of list) {
    const refusal = venueRefusal(address);
    if (refusal) return refusal;
  }
  return null;
}

/** Slug form, for the criteria offers that name a collection by slug. */
export function venueSlugRefusal(...slugs) {
  const given = slugs.filter((s) => s != null && s !== "");
  if (given.length === 0) return refusalFor(null);
  for (const slug of given) {
    if (!venueCollectionBySlug(slug)) return refusalFor(collectionBySlugAnyChain(slug));
  }
  return null;
}

/**
 * null unless a Seaport order moves an NFT of a registry collection on another
 * chain. Every cancel here is sent on Ethereum and cannot reach such an order,
 * so it is refused with the market to cancel on. Any other cancel stays open,
 * so a signed Ethereum order is never stranded.
 */
export function cancelRefusal(parameters) {
  const list = (v) => (Array.isArray(v) ? v : []);
  for (const item of [...list(parameters?.offer), ...list(parameters?.consideration)]) {
    const type = Number(item?.itemType);
    if (type < 2 || type > 5) continue;
    const c = collectionByContractAnyChain(item.token);
    if (c && c.chain !== "ethereum") {
      return {
        error: NOT_VENUE_TRADEABLE,
        message: `${c.name} orders live on ${chainLabel(c) || c.chain}, and this venue cancels only on Ethereum. Cancel it on ${c.market?.name || "its own market"}.`,
      };
    }
  }
  return null;
}

/** The same refusal, thrown, for sinks whose contract is to throw. */
export function venueRefusalError(refusal) {
  const err = new Error(refusal.message);
  err.code = refusal.error;
  return err;
}

/** The item's page on its home market, or null where none was verified or it cannot be bought. */
export function marketItemUrl(collection, id) {
  const template = collection?.market?.itemUrlTemplate;
  const tokenId = id == null ? "" : String(id);
  if (!template || !TOKEN_ID_RE.test(tokenId)) return null;
  if ((collection.burnedIds || []).some((b) => String(b) === tokenId)) return null;
  return template.replace("{id}", tokenId);
}

export function marketCollectionUrl(collection) {
  return collection?.market?.collectionUrl || null;
}

export function explorerAddressUrl(collection) {
  return collection?.explorer?.addressUrl || null;
}

// Where a collection's own description was read, so its words are never
// taken for the venue's. null for the venue's own copy.
const DESCRIPTION_SOURCES = {
  opensea: "Description from the collection's OpenSea page",
  metadata: "Description from the collection NFT's metadata (IPFS, linked on chain)",
};

export function descriptionSourceLabel(collection) {
  return DESCRIPTION_SOURCES[collection?.descriptionSource] || null;
}

const CHAIN_LABELS = { ethereum: "Ethereum", base: "Base", solana: "Solana" };
const STANDARD_LABELS = { erc721: "ERC-721", erc1155: "ERC-1155", spl: "Metaplex pNFT" };

export function chainLabel(collection) {
  return CHAIN_LABELS[collection?.chain] || null;
}

export function standardLabel(collection) {
  return STANDARD_LABELS[collection?.standard] || null;
}

/** "123 items", or "22 designs, 975 editions" for an ERC-1155; null when no read produced one. */
export function supplyLabel(collection) {
  const editions = collection?.editions;
  if (editions && Number.isFinite(editions.tokenIds) && Number.isFinite(editions.total)) {
    return `${editions.tokenIds.toLocaleString("en-US")} designs, ${editions.total.toLocaleString("en-US")} editions`;
  }
  const supply = collection?.supply;
  return Number.isFinite(supply) ? `${supply.toLocaleString("en-US")} items` : null;
}
