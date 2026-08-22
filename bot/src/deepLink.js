// Every link this bot hands back, and the rule that keeps them from lying.
//
// THE ARCHITECTURE IN ONE PARAGRAPH. A Telegram message cannot sign a transaction.
// Something has to, and the two ways to arrange that are: put a key where the bot
// can reach it, or send the user to a surface where their own wallet is. The first
// is what Trojan and Banana Gun did and how both were drained. This file is the
// second. Anything that moves value becomes a URL the user opens in a browser that
// already holds their wallet, and the bot's involvement ends at the link.
//
// THE RULE, enforced by `deepLink.test.js`: a link may only carry a query parameter
// the app actually READS. `/scan?token=…` is real — ScannerPage.tsx reads `token`.
// A `/swap?token=…` would not be: TradePage.tsx reads only `tab`, so that parameter
// would be silently dropped and the user would land on a swap for the wrong asset
// with the bot's message above it saying it had prepared the right one. The
// PARAM_READERS table below is the record of which is which, and adding a route
// means checking the page, not guessing.

/**
 * Routes this bot may link to, with the query keys the corresponding page parses.
 *
 * An empty array is a real entry and means "this route takes no parameters from
 * us". It is not the same as an absent entry, which means the route is not one we
 * link to at all.
 */
export const PARAM_READERS = Object.freeze({
  // AlertsPage → components/bot/TelegramLinkPanel.tsx reads `tglink`.
  "/alerts": ["tglink"],
  // ScannerPage.tsx: `params.get('token')`.
  "/scan": ["token"],
  // TradePage.tsx: `searchParams.get('tab')` and nothing else.
  "/swap": ["tab"],
  "/terminal": [],
  "/dashboard": [],
  "/farm": [],
});

/**
 * Build a link, or throw.
 *
 * Throwing rather than dropping the offending parameter is deliberate: a dropped
 * parameter produces a link that WORKS and goes somewhere slightly wrong, which is
 * the failure this whole module exists to prevent. A throw is caught by the command
 * router and surfaces as a plain "I cannot build that link", which is honest.
 */
export function buildAppLink(appOrigin, route, params = {}) {
  const readers = PARAM_READERS[route];
  if (!readers) throw new Error(`buildAppLink: ${route} is not a route this bot links to`);
  const url = new URL(appOrigin);
  url.pathname = route;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (!readers.includes(key)) {
      throw new Error(`buildAppLink: ${route} does not read "${key}", so a link carrying it would mislead`);
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Where a user takes a freshly minted link code. */
export function buildLinkUrl(appOrigin, code) {
  return buildAppLink(appOrigin, "/alerts", { tglink: code });
}

/**
 * Where a user goes to actually trade.
 *
 * Takes no token argument on purpose — see PARAM_READERS above. When the swap
 * surface grows a parameter for the asset, this signature grows with it and the
 * table records the change; until then the bot names the token in WORDS and lets
 * the user pick it on a page they can see.
 */
export function buildSwapUrl(appOrigin) {
  return buildAppLink(appOrigin, "/swap", { tab: "swap" });
}

export function buildScanUrl(appOrigin, token) {
  return buildAppLink(appOrigin, "/scan", { token });
}
