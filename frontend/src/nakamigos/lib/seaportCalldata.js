// The NFT contracts a Seaport fulfilment call moves, read back from the
// calldata that is about to be signed. OpenSea's `orders` array beside it is
// advisory, and a key-named read of `input_data` can disagree with what the
// positional encoder wrote, so only the decoded call is trusted. Returns []
// when no NFT can be named, which every caller treats as a refusal.

const NFT_ITEM_TYPES = new Set([2, 3, 4, 5]);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const BASIC_ORDER_FUNCTIONS = new Set(["fulfillBasicOrder", "fulfillBasicOrder_efficient_6GL6yc"]);
// args[0] is ONE Order/AdvancedOrder here, and an array of them for the rest.
const SINGLE_ORDER_FUNCTIONS = new Set(["fulfillOrder", "fulfillAdvancedOrder"]);
const ORDER_ARRAY_FUNCTIONS = new Set([
  "fulfillAvailableOrders", "fulfillAvailableAdvancedOrders", "matchOrders", "matchAdvancedOrders",
]);

function isAddress(value) {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

// OrderParameters: (offerer, zone, offer[], consideration[], ...); each item
// starts (itemType, token, ...). Throws on any other shape.
function nftTokensOfParameters(parameters) {
  const tokens = [];
  for (const items of [parameters?.[2], parameters?.[3]]) {
    if (!items || typeof items === "string" || typeof items.length !== "number") throw new Error("not order parameters");
    for (const item of items) {
      if (!NFT_ITEM_TYPES.has(Number(item?.[0]))) continue;
      if (!isAddress(item[1])) throw new Error("NFT item without a token");
      tokens.push(item[1]);
    }
  }
  return tokens;
}

/**
 * @param {import("ethers").Interface} iface  built from the response's own signature
 * @param {string} fnName                      the allowlisted function name
 * @param {string} data                        the encoded calldata
 * @returns {string[]} NFT contracts the call moves ([] when none can be named)
 */
export function seaportCallNftTokens(iface, fnName, data) {
  try {
    const args = iface.decodeFunctionData(fnName, data);
    if (BASIC_ORDER_FUNCTIONS.has(fnName)) {
      // BasicOrderParameters: considerationToken is field 0, offerToken field 5,
      // basicOrderType field 8. Routes 0-3 sell the offered NFT for ETH or an
      // ERC-20; routes 4-5 hand the considered NFT over for an ERC-20.
      const p = args[0];
      const route = Math.floor(Number(p?.[8]) / 4);
      const token = route >= 0 && route <= 3 ? p[5] : route === 4 || route === 5 ? p[0] : null;
      return isAddress(token) ? [token] : [];
    }
    let orders;
    if (SINGLE_ORDER_FUNCTIONS.has(fnName)) orders = [args[0]];
    else if (ORDER_ARRAY_FUNCTIONS.has(fnName)) orders = Array.from(args[0] ?? []);
    else return [];
    const tokens = [];
    for (const order of orders) tokens.push(...nftTokensOfParameters(order?.[0]));
    return tokens;
  } catch {
    return [];
  }
}
