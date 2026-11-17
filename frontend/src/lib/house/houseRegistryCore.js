// The venue's own trading wallets, as every surface reads them from houseRegistry.json.
//
// Pure: this file reads no file and imports nothing, so a plain Node script can use it as
// well as the site. The site's binding is houseRegistry.js, which imports the JSON through
// Vite. Plain Node refuses a JSON import that carries no `with { type: "json" }`, and the
// repo's lint (ecmaVersion 2023, `npm run lint` in CI) cannot parse that attribute yet, so a
// Node script reads the JSON itself and hands it to createHouseRegistry here
// (scripts/venue-volume.mjs does).
//
// Lenient by design: a malformed entry is skipped rather than thrown, so a typo in the list
// can never take the marketplace down. houseRegistry.test.js is the strict half: CI refuses
// an entry that is not exactly the shape the signer and the bot expect.

/** What a house wallet is called wherever a maker is shown. */
export const HOUSE_LABEL = "House";

// Matched before lowercasing, so "0X…" or a padded string is not taken for an address.
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `value` as a lowercase 0x + 40-hex address; null for anything else, untrimmed. */
export function evmAddress(value) {
  return typeof value === "string" && ADDRESS.test(value) ? value.toLowerCase() : null;
}

/** The registry's addresses, lowercase, each once, in the file's order. */
function addressesOf(json) {
  const list = json && typeof json === "object" && Array.isArray(json.wallets) ? json.wallets : [];
  const out = [];
  for (const entry of list) {
    const a = evmAddress(entry && typeof entry === "object" ? entry.address : null);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * The helpers over one registry object (the parsed houseRegistry.json).
 *
 * houseBidLabel names a house COLLECTION bid by what it still buys: "House · buys 2 (any
 * JBAC)". Without a whole count above zero or the collection's chip it says "House" alone,
 * never a number it does not know.
 */
export function createHouseRegistry(json) {
  const wallets = Object.freeze(addressesOf(json));
  const set = new Set(wallets);
  const isHouseWallet = (address) => {
    const a = evmAddress(address);
    return a !== null && set.has(a);
  };
  const houseLabel = (address) => (isHouseWallet(address) ? HOUSE_LABEL : null);
  const houseBidLabel = (address, { remaining, chip } = {}) => {
    if (!isHouseWallet(address)) return null;
    const n = typeof remaining === "number" || typeof remaining === "string" ? Number(remaining) : NaN;
    const ticker = typeof chip === "string" ? chip.trim() : "";
    return Number.isInteger(n) && n > 0 && ticker ? `${HOUSE_LABEL} · buys ${n} (any ${ticker})` : HOUSE_LABEL;
  };
  return Object.freeze({
    houseWallets: () => [...wallets],
    isHouseWallet,
    houseLabel,
    houseBidLabel,
  });
}
