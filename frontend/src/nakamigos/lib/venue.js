import { COLLECTIONS } from "../constants";

// The one rule for money on this venue. The money path is Seaport with
// ERC-721 ownerOf pre-flights, so a collection trades here only as an Ethereum
// ERC-721 the registry flags venueTrade, with a real address. Every money sink
// asks venueRefusal before it touches a wallet, and every surface reads
// canTradeOnVenue. One exception: a Base ERC-721 flagged venueBuy trades here
// on Base, through Seaport 1.6 on Base: its OpenSea listings are bought, it is
// listed on the order book and bid on item by item (canBuyOnVenue,
// buyChainFor). Its cart, bundles, trades and collection offers stay refused.
// Cancels move no value and stay open, each sent on the order's own chain
// (cancelChainFor).

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

// The chains a fill is ever sent on, by registry chain name. Seaport and
// OpenSea's conduit sit at the same addresses on both (read on chain
// 2026-11-07: Seaport 1.6 on Base is Ethereum's bytecode with only the chain id
// and the domain separator built from it differing).
export const VENUE_CHAIN_IDS = Object.freeze({ ethereum: 1, base: 8453 });
const CHAIN_WALLET_LABELS = { ethereum: "Ethereum Mainnet", base: "Base" };
const EXPLORER_TX = { ethereum: "https://etherscan.io/tx/", base: "https://basescan.org/tx/" };

/**
 * A collection whose listings can be BOUGHT here: every venue collection, and
 * a Base ERC-721 the registry flags venueBuy. A venueBuy collection has the buy
 * of one OpenSea listing and nothing else: no listing, offer, cart or order book.
 */
export function canBuyOnVenue(collection) {
  if (canTradeOnVenue(collection)) return true;
  return !!collection
    && collection.venueBuy === true
    && collection.chain === "base"
    && collection.standard === "erc721"
    && typeof collection.contract === "string"
    && ADDRESS_RE.test(collection.contract);
}

const BUY_COLLECTIONS = Object.freeze(Object.values(COLLECTIONS).filter(canBuyOnVenue));

const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");

/**
 * The chain a buy of these NFT contracts settles on: `{ chain, chainId }`, or
 * the `{ error, message }` refusal. Every contract must be buyable here and all
 * must sit on ONE chain; an empty list is refused. The chain comes from the
 * registry, never from a market's answer.
 */
export function buyChainFor(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  if (list.length === 0) return refusalFor(null);
  let chain = null;
  for (const address of list) {
    const a = lower(address);
    const c = a ? BUY_COLLECTIONS.find((x) => x.contract.toLowerCase() === a) : null;
    if (!c) return refusalFor(collectionByContractAnyChain(address));
    if (chain && c.chain !== chain) {
      return { error: NOT_VENUE_TRADEABLE, message: "This order mixes NFTs from two chains. Nothing was sent." };
    }
    chain = c.chain;
  }
  return { chain, chainId: VENUE_CHAIN_IDS[chain] };
}

/** "Ethereum Mainnet", "Base": the network a wallet must be on for this chain. */
export function walletChainLabel(chain) {
  return CHAIN_WALLET_LABELS[chain] || null;
}

/** Where to look at a transaction on this chain. */
export function chainTxUrl(chain, hash) {
  const root = EXPLORER_TX[chain];
  return root && typeof hash === "string" ? `${root}${hash}` : null;
}

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
 * The chain a cancel of this Seaport order is sent on: `{ chain, chainId }`,
 * or the `{ error, message }` refusal. A Base buy collection's order is
 * cancelled on Base; an order on any other chain the venue does not trade on
 * is refused with the market to cancel on. Any other order (no registry NFT)
 * is cancelled on Ethereum, so a signed Ethereum order is never stranded.
 */
export function cancelChainFor(parameters) {
  const list = (v) => (Array.isArray(v) ? v : []);
  let chain = "ethereum";
  let seen = null;
  for (const item of [...list(parameters?.offer), ...list(parameters?.consideration)]) {
    const type = Number(item?.itemType);
    if (type < 2 || type > 5) continue;
    const c = collectionByContractAnyChain(item.token);
    if (!c || c.chain === "ethereum") continue;
    if (!canBuyOnVenue(c)) {
      return {
        error: NOT_VENUE_TRADEABLE,
        message: `${c.name} orders live on ${chainLabel(c) || c.chain}, and this venue cancels only on Ethereum and Base. Cancel it on ${c.market?.name || "its own market"}.`,
      };
    }
    if (seen && seen !== c.chain) {
      return { error: NOT_VENUE_TRADEABLE, message: "This order mixes NFTs from two chains. Nothing was sent." };
    }
    seen = c.chain;
    chain = c.chain;
  }
  return { chain, chainId: VENUE_CHAIN_IDS[chain] };
}

/**
 * null unless the order moves an NFT of a registry collection on a chain other
 * than Ethereum. For the sinks that cancel on Ethereum only (a P2P trade).
 */
export function ethereumCancelRefusal(parameters) {
  const list = (v) => (Array.isArray(v) ? v : []);
  for (const item of [...list(parameters?.offer), ...list(parameters?.consideration)]) {
    const type = Number(item?.itemType);
    if (type < 2 || type > 5) continue;
    const c = collectionByContractAnyChain(item.token);
    if (c && c.chain !== "ethereum") {
      return {
        error: NOT_VENUE_TRADEABLE,
        message: `${c.name} orders live on ${chainLabel(c) || c.chain}, and this venue cancels trades only on Ethereum. Cancel it on ${c.market?.name || "its own market"}.`,
      };
    }
  }
  return null;
}

/** null when a cancel of this order can be sent here, else the refusal. */
export function cancelRefusal(parameters) {
  const where = cancelChainFor(parameters);
  return where.error ? where : null;
}

/** Any collection traded here (Ethereum venue or Base buy) at this contract, or null. */
export function bookCollectionByContract(address) {
  const a = lower(address);
  if (!a) return null;
  return BUY_COLLECTIONS.find((c) => c.contract.toLowerCase() === a) || null;
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
// taken for the venue's, and whether it is an excerpt. A caption, and a short
// tag for tight spaces; both null for the venue's own copy.
const DESCRIPTION_SOURCES = {
  opensea: {
    label: "Description from the collection's OpenSea page",
    tag: "from its OpenSea page",
    "first-paragraph": { label: "First paragraph of the collection's OpenSea description", tag: "first paragraph of its OpenSea description" },
  },
  metadata: {
    label: "Description from the collection NFT's metadata (IPFS, linked on chain)",
    tag: "from its NFT metadata",
  },
};

function descriptionSource(collection) {
  const source = DESCRIPTION_SOURCES[collection?.descriptionSource];
  if (!source) return null;
  const excerpt = collection.descriptionExcerpt;
  return excerpt ? source[excerpt] || null : source;
}

export function descriptionSourceLabel(collection) {
  return descriptionSource(collection)?.label || null;
}

/** Lower case, for "(first paragraph of its OpenSea description)" or a card's tag. */
export function descriptionSourceTag(collection) {
  return descriptionSource(collection)?.tag || null;
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
