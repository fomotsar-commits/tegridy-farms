import { chainLabel, standardLabel } from "../../lib/venue";

// The only tabs a view-only collection has.
export const EXTERNAL_TABS = new Set(["gallery", "about"]);

// Tabs that trade. Their unavailable state gives the trading reason; every
// other tab only says it is not available here.
export const MONEY_TABS = new Set(["listings", "deals", "sniper", "trade", "trades", "bids", "my-listings", "collection"]);

// The names the marketplace nav gives each tab.
export const TAB_LABELS = {
  gallery: "Gallery",
  about: "About",
  listings: "Floor",
  deals: "Deals",
  traits: "Traits",
  analytics: "Analytics",
  activity: "Activity",
  collection: "My NFTs",
  portfolio: "P&L",
  pro: "Pro",
  trades: "P2P Trades",
  sniper: "Sniper",
  trade: "Compare",
  watchlist: "Watchlist",
  favorites: "Favorites",
  bids: "Bids",
  "my-listings": "My Listings",
  alerts: "Alerts",
  chat: "Chat",
  history: "History",
  whales: "Whales",
  integrity: "Integrity",
};

export function explainerLine(collection) {
  return `${collection.name} lives on ${chainLabel(collection)}. Browse it here; it trades on ${collection.market.name}.`;
}

/** "an ERC-721", "a Metaplex pNFT". */
export function withArticle(label) {
  return `${/^[AEIOU]/i.test(label) ? "an" : "a"} ${label}`;
}

/** The unavailable state's two sentences; `reason` is null for a read tab. */
export function unavailableCopy(tab, collection) {
  const label = TAB_LABELS[tab] || tab;
  if (MONEY_TABS.has(tab)) {
    return {
      lead: `The ${label} tab is not offered for ${collection.name} here.`,
      reason: `${collection.name} is ${withArticle(standardLabel(collection))} collection on ${chainLabel(collection)}, and this venue trades Ethereum ERC-721 collections.`,
    };
  }
  return { lead: `The ${label} tab is not available for ${collection.name} here.`, reason: null };
}

/** The item's own name, or the collection's name and number when it has none. */
export function itemName(collection, item) {
  return item.name || (item.id != null ? `${collection.name} #${item.id}` : collection.name);
}

export function itemKey(item) {
  return item.mint || item.id;
}
