import { parseEther, formatEther } from "viem";
import { CONTRACT, COLLECTION_SLUG, COLLECTIONS, SEAPORT_ADDRESS, SEAPORT_DOMAIN, CONDUIT_ADDRESS, PLATFORM_FEE_BPS, SEAPORT_ADDRESSES_BY_CHAIN, WETH_BY_CHAIN, PLATFORM_FEE_RECIPIENTS, BID_VENUE_FEE_ENABLED, openseaRequiredBidFees } from "./constants";
import { getActiveWalletProvider, assertSameWallet, SEAPORT_FULFILLMENT_FUNCTIONS, fulfillCallRefusal } from "./api";
import { getWethBalance, getWethAllowance, wrapEth, approveWeth } from "./lib/weth";
import { openseaGet as rawOpenseaGet, openseaPost as rawOpenseaPost, ApiError } from "./lib/proxy";
import { cancelSeaportOrder, cancelSeaportOrderGasless, GASLESS_CANCEL_DONE } from "./lib/seaportCancel";
import { buysAnyTokenOrder } from "./lib/offerScope";
import { collectionOfferQuantity, normalizeCollectionOffer, safePriceFromWei, feeBpsOf } from "./lib/offerNormalize";
import { cancelChainFor, venueCollectionByContract, venueCollectionBySlug, venueRefusal, venueRefusalError, venueSlugRefusal, buyChainFor, bookCollectionByContract, VENUE_CHAIN_IDS } from "./lib/venue";
import {
  SEAPORT_16_ADDRESS, roundUnitPriceDown, validateBuildResponse, buildBidParameters, typedDataFor,
  wethApprovalTarget, isSeaport16SignedZoneOrder,
} from "./lib/seaportOffer";
import { seaportCallNftTokens } from "./lib/seaportCalldata";
import { acceptTradeRefusal, decodeSeaportTrade } from "./lib/seaportTrade";
import { waitForTxOutcome, txOutcomeResult } from "./lib/txOutcome";

// AUDIT FIX M-8 (frontend chain guard): assertOnExpectedChain blocks any
// on-chain action when the wallet is connected to a chain != SEAPORT_DOMAIN.chainId.
// Pre-fix, a user on Sepolia/Base/Arbitrum who clicked "Make Offer" would have
// `wrapEth(needed)` and `approveWeth(priceWei)` execute on the WRONG chain
// (real testnet/L2 ETH burned), then sign a chain-1 EIP-712 offer that the
// orderbook can't fulfill. Now every offer/cancel/accept entrypoint refuses
// up-front with a typed error before any tx hits the wallet.
// `want` is the chain the order lives on (registry): Ethereum unless a Base
// buy collection's order says Base.
async function assertOnExpectedChain(browserProvider, want = Number(SEAPORT_DOMAIN.chainId)) {
  try {
    const network = await browserProvider.getNetwork();
    const got = Number(network.chainId);
    if (got !== want) {
      return { error: "wrong-chain", chainId: want, message: `Connected to chain ${got}; expected chain ${want}` };
    }
  } catch {
    return { error: "no-network", message: "Could not read wallet chain" };
  }
  return null;
}

// ═══ OPENSEA RETRY WITH EXPONENTIAL BACKOFF ═══
// OpenSea is heavily rate-limited; retry on 429, 5xx, and network failures.
async function withRetry(fn, { maxRetries = 3, baseDelay = 1500, maxDelay = 30000, signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Bail out early if the caller has been cancelled (e.g. component unmount)
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (attempt >= maxRetries) break;
      const isApiError = err instanceof ApiError;
      const isNetworkError = err instanceof TypeError;
      const isRetryable = isNetworkError || (isApiError && err.isRetryable);
      if (!isRetryable) break;
      let delay;
      if (isApiError && err.retryAfter) {
        delay = Math.min(err.retryAfter * 1000, maxDelay);
      } else {
        delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 500, maxDelay);
      }
      // Abort-aware delay: resolve immediately if signal fires during wait
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
  throw lastError;
}

function openseaGet(path, params = {}, { signal } = {}) {
  return withRetry(() => rawOpenseaGet(path, params), { maxRetries: 3, signal });
}

function openseaPost(path, body) {
  return withRetry(() => rawOpenseaPost(path, body), { maxRetries: 2 });
}

// Reserve 0.005 ETH for gas costs (approve + sign transactions)
const GAS_BUFFER_WEI = parseEther("0.005");

// ═══ FETCH OFFERS (all via proxy — no API keys in browser) ═══

// THE PER-TOKEN OFFER LADDER HAS NO REPLACEMENT, AND PRETENDING OTHERWISE COSTS MORE.
//
// This asked `orders/ethereum/seaport/offers` for every bid on ONE token. That
// route is POST-only upstream since 2026-09-05. Everything I could find as a
// substitute was measured and rejected:
//   offers/collection/{slug}/nfts/{id}/all  -> 404 upstream (route absent)
//   offers/collection/{slug}/nfts/{id}/best -> 200, but ONE offer, not a ladder
//   offers/collection/{slug}/all + a token filter -> the filter is IGNORED:
//       token_ids=, token_id= and asset_contract_address=&token_ids= each
//       returned the identical 20 rows across 10 distinct token ids
//
// The only way to rebuild a real ladder is to page the WHOLE collection and filter
// client-side — and BidManager calls this once per owned NFT on a 30/min budget,
// so that trades a broken panel for a rate-limit outage across every OpenSea read
// that still works. That is a worse product, not a better one.
//
// SO IT RETURNS THE TOP OF THE LADDER, NOT AN EMPTY ONE AND NOT A THROW.
// `offers/collection/{slug}/nfts/{id}/best` still works, and it answers the two
// questions the panel actually asks: is there ANY offer on this token, and what is
// the best one. An empty result from it is a real "nobody has bid", which is why
// this must not throw — `offerBookOutageHonesty.test.jsx` pins that a genuinely
// empty book still renders "No Offers Yet" and NOT the outage copy, and throwing
// here would have collapsed those two states back together in the other direction.
//
// WHAT IS LOST: the second-best bid and below. The panel shows one row where it
// used to show a ladder. That is a real reduction and it is not disguised.
//
// TO RESTORE THE LADDER: it needs an order source we control (the indexer), or an
// OpenSea route that filters by token. Do not restore it by paging the collection.
//
// The route is the CONTRACT's own collection: a contract the venue does not trade
// is refused, never read as Nakamigos.
async function fetchTokenOffersOrThrow(tokenId, contract = CONTRACT) {
  const collection = bookCollectionByContract(contract);
  if (!collection) throw venueRefusalError(venueRefusal(contract));
  // The one token-scoped read OpenSea still serves. It answers BOTH questions the
  // panel needs: whether any offer exists at all, and what the top one is.
  const best = await fetchBestOfferOrThrow(tokenId, collection.openseaSlug);
  return best ? [best] : [];
}

export async function fetchTokenOffers(tokenId, contract = CONTRACT) {
  try {
    return await fetchTokenOffersOrThrow(tokenId, contract);
  } catch (err) {
    console.warn("Fetch token offers failed:", err.message);
    return [];
  }
}

async function fetchBestOfferOrThrow(tokenId, slug = COLLECTION_SLUG, { openseaSlug } = {}) {
  const osSlug = openseaSlug || slug;
  const data = await openseaGet(`offers/collection/${osSlug}/nfts/${tokenId}/best`);
  if (!data.price) return null;
  const endSec = parseInt(data.protocol_data?.parameters?.endTime);
  const nftItem = (data.protocol_data?.parameters?.consideration || []).find(c => Number(c.itemType) >= 2);
  return {
    price: safePriceFromWei(data.price.value),
    currency: data.price.currency,
    maker: data.protocol_data?.parameters?.offerer,
    orderHash: data.order_hash,
    protocolAddress: data.protocol_address || SEAPORT_ADDRESS,
    tokenContract: nftItem?.token || null,
    // The bid's own fee lines as bps of its offer (null when unknown), for the
    // seller's net-proceeds preview: offerNormalize.feeBpsOf.
    feeBps: feeBpsOf(data.protocol_data?.parameters),
    // THE TOKEN WE ASKED ABOUT — never `nftItem.identifierOrCriteria`.
    //
    // On a criteria offer (itemType 4/5) that field is the MERKLE ROOT of every
    // token the bid covers, not a token id: the live trait offer measured on
    // 2026-09-09 carried 1957256797975633146717778987413593388746698729618...
    // there while covering ~900 real ids. Reading it as a token id would hand
    // `acceptOffer` a number that is not an NFT, and the fill would name the
    // wrong asset. This route is token-scoped, so the id it was queried FOR is
    // the id that fills the offer, and that is the honest source.
    tokenId: String(tokenId),
    expiry: Number.isFinite(endSec) ? new Date(endSec * 1000) : null,
  };
}

export async function fetchBestOffer(tokenId, slug = COLLECTION_SLUG, { openseaSlug } = {}) {
  try {
    return await fetchBestOfferOrThrow(tokenId, slug, { openseaSlug });
  } catch (err) {
    console.warn("Fetch best offer failed:", err.message);
    return null;
  }
}

/**
 * The offer book for one token, with the outage kept distinguishable from an
 * empty book: `unavailable` is true when the read failed, so a caller with
 * nothing to show says so instead of claiming zero offers. ONE request answers
 * both questions (is there any offer, and which is best), on the collection the
 * contract names. A contract outside the venue is not read at all: unavailable.
 */
export async function fetchTokenOfferBook(tokenId, { contract = CONTRACT } = {}) {
  const collection = bookCollectionByContract(contract);
  if (!collection) return { offers: [], bestOffer: null, unavailable: true };
  try {
    const best = await fetchBestOfferOrThrow(tokenId, collection.openseaSlug);
    return { offers: best ? [best] : [], bestOffer: best, unavailable: false };
  } catch (err) {
    console.warn("Fetch token offer book failed:", err?.message);
    return { offers: [], bestOffer: null, unavailable: true };
  }
}

// Moved to lib/offerNormalize.js (no wallet or Seaport code beside them, so a surface that only
// reads bids does not pull this whole file); exported from here as before.
export { collectionOfferQuantity, normalizeCollectionOffer };

// The bids that buy ANY token of the collection: the best-collection-offer tile,
// the order book and the depth chart. `offers/collection/{slug}/all` is NOT that
// list, it mixes in offers on single tokens and on token lists. Read live
// 2026-11-10, its first page held no collection-wide bid at all for JBAC or GNSS
// (50 single-token offers each, 0.079 to 0.155 and 0.05 to 0.15 WETH against
// floors of 0.0279 and 0.0109), and for Nakamigos 48 token-list bids at 3.0 to
// 3.5 WETH against a 0.08 floor. `offers/collection/{slug}` holds the
// collection-wide ones (best per item: JBAC 0.0209, GNSS 0.0082, NAKA 0.0758).
// The lending card reads the same route through the same filter.
export async function fetchCollectionOffers(slug = COLLECTION_SLUG, { openseaSlug, signal } = {}) {
  const osSlug = openseaSlug || slug;
  try {
    const data = await openseaGet(`offers/collection/${osSlug}`, {}, { signal });
    return (data.offers || []).filter(buysAnyTokenOrder).map(normalizeCollectionOffer);
  } catch (err) {
    console.warn("Fetch collection offers failed:", err.message);
    return [];
  }
}

// The mixed feed, for the trait panels only: deriveTraitOffers keeps its trait
// rows and drops the single-token and token-list ones.
export async function fetchAllCollectionOffers(slug = COLLECTION_SLUG, { openseaSlug, signal } = {}) {
  const osSlug = openseaSlug || slug;
  try {
    const data = await openseaGet(`offers/collection/${osSlug}/all`, {}, { signal });
    return (data.offers || []).map(normalizeCollectionOffer);
  } catch (err) {
    console.warn("Fetch all collection offers failed:", err.message);
    return [];
  }
}

// SELF-AUDIT 2026-05-27, resolved 2026-06-09: OpenSea's dedicated
// `offers/collection/{slug}/traits` endpoint 400s on every `mode` value we
// tried and has no public spec. But `offers/collection/{slug}/all` includes
// criteria offers, and trait offers carry `criteria.trait = { type, value }` —
// so the per-trait best bid is derived from that one read.
// Input: normalized offers from fetchAllCollectionOffers (price in ETH).
// Output: { [traitType]: { [traitValue]: { priceEth, count } } }
export function deriveTraitOffers(collectionOffers = []) {
  const map = {};
  for (const o of collectionOffers) {
    const trait = o?.criteria?.trait;
    if (!trait?.type || trait.value == null || !(o.price > 0)) continue;
    const byValue = map[trait.type] || (map[trait.type] = {});
    const slot = byValue[trait.value] || (byValue[trait.value] = { priceEth: 0, count: 0 });
    slot.count += 1;
    if (o.price > slot.priceEth) slot.priceEth = o.price;
  }
  return map;
}

function normalizeOffer(order) {
  const params = order.protocol_data?.parameters;
  const offer = params?.offer?.[0];
  // PRICE PER ITEM, not per order. An N-item bid holds N x the unit price in its
  // offer item, so reading startAmount raw reports a bid N times higher than any
  // single token could be sold into — the bug normalizeCollectionOffer's docblock
  // already describes ("a 50-item bid ended up rendering above the floor and
  // inverting the spread"). That fix landed in ONE normalizer and not this one.
  //
  // SEVERITY, RE-MEASURED — this is NOT defensive any more.
  //
  // The 2026-09-05 note here said a quantity > 1 could not be reproduced on this
  // route (50 of 50 rows itemType 2, quantity 1) and called the divide purely
  // defensive. Re-measured 2026-09-09 on the same read,
  // `offers/collection/nakamigos/all&limit=50`: itemType {2: 43, 4: 7} and
  // quantities {1: 46, 5: 3, 9: 1} — FOUR of fifty rows are multi-item bids.
  // Undivided, a 9-item bid renders at 9x its true per-token price and sorts to
  // the top of the seller's book. The divide below is correcting live rows, so
  // do not relax it back to a no-op on the strength of the older sample.
  //
  // Reuses the exported collectionOfferQuantity rather than a second copy.
  const quantity = collectionOfferQuantity(params);
  const rawOfferWei = offer?.startAmount || "0";
  let priceWei = rawOfferWei;
  try {
    if (quantity > 1) priceWei = (BigInt(rawOfferWei) / BigInt(quantity)).toString();
  } catch { /* malformed amount — fall back to the raw value */ }
  // In a Seaport offer (bid), the NFT is in consideration[0] (what the offerer wants to receive)
  const nftItem = params?.consideration?.find(c => c.itemType >= 2); // ERC721 or ERC1155
  // F666: surface the ERC20 (itemType 1) consideration total — OpenSea fee +
  // platform fee + any royalty the collection encoded into the order. The seller
  // nets the gross offer minus this, so the net-proceeds preview can show the
  // EXACT residual (royalty-inclusive) rather than an estimate. Display-only;
  // nothing here feeds fulfillment. Left null (not "0") when no ERC20 items are
  // present so a malformed/empty consideration falls back to the honest fee
  // estimate instead of claiming a zero-fee net.
  let feeSumWei = 0n;
  let sawFeeItem = false;
  for (const c of params?.consideration || []) {
    if (Number(c?.itemType) !== 1) continue;
    try { feeSumWei += BigInt(c.startAmount || "0"); sawFeeItem = true; } catch { /* skip malformed amount */ }
  }
  // The fee is per ORDER for the same reason the price is; leaving it undivided
  // would subtract an N-item fee from a 1-item price in NetProceeds.
  const feeWei = sawFeeItem
    ? (quantity > 1 ? (feeSumWei / BigInt(quantity)).toString() : feeSumWei.toString())
    : null;
  return {
    price: safePriceFromWei(priceWei),
    priceWei,
    feeWei,
    feeBps: feeBpsOf(params),
    // The WHOLE order's payment, what it can still pull through the conduit, and
    // its token: the WETH approval budget sums these (placeBid).
    offerWei: rawOfferWei,
    offerToken: offer?.token || null,
    maker: params?.offerer,
    orderHash: order.order_hash,
    tokenId: nftItem?.identifierOrCriteria ? String(nftItem.identifierOrCriteria) : null,
    tokenContract: nftItem?.token || null,
    expiry: (() => { const s = parseInt(params?.endTime); return Number.isFinite(s) ? new Date(s * 1000) : null; })(),
    protocolAddress: order.protocol_address,
    cancelled: order.cancelled || false,
    finalized: order.finalized || false,
  };
}

// ═══ CREATE OFFERS ═══
//
// EVERY BID IS SEAPORT 1.6 WITH OPENSEA'S SIGNEDZONE, built by lib/seaportOffer.js.
//
// Until 2026-11-16 none of these worked. The collection and trait builds were
// refused (400, no `protocol_address`), their post went to `criteria_offers` (404,
// gone), and a bid on one NFT was signed for Seaport 1.5 with no zone, a format
// OpenSea stopped taking in April 2024, so a bidder paid the wrap and approval gas
// before being refused. The order of every step below is the fix as much as the
// format is:
//   1. everything that needs no wallet (price on the tick, quantity, fees, expiry);
//   2. the wallet, its chain, and that it is the account on screen;
//   3. the token exists (a bid on one NFT), or OpenSea's build is held to the bid;
//   4. the whole order is built from pinned values, and the counter read;
//   5. only then any gas: wrap what is missing, one approval for every live bid;
//   6. sign for Seaport 1.6, post.

// The most WETH ever approved in one call; lib/weth.js approveWeth refuses more.
const MAX_WETH_APPROVAL_WEI = 100n * 10n ** 18n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// A bid names one token. ownerOf reverts for an id that does not exist, and a
// bid on one would wrap and approve for an order nobody can ever fill, so it
// is asked first. An unanswered read refuses too: nothing is funded unconfirmed.
async function tokenExistenceRefusal(ethers, contract, tokenId, readProvider = null) {
  try {
    const { getReadProvider } = await import("./lib/rpcProvider");
    const nft = new ethers.Contract(contract, ["function ownerOf(uint256) view returns (address)"], readProvider || await getReadProvider());
    await nft.ownerOf(String(tokenId));
    return null;
  } catch (err) {
    if (err?.code === "CALL_EXCEPTION") {
      return { error: "no-such-token", message: `Token #${tokenId} does not exist in this collection, so there is nothing to bid on.` };
    }
    return { error: "token-unverified", message: `Could not confirm that token #${tokenId} exists right now. Nothing was funded; try again.` };
  }
}

/**
 * The unit price a bid is signed at: rounded DOWN to the 0.00001 WETH tick
 * (lib/seaportOffer PRICE_TICK_WEI), never up, or a refusal. On the tick every
 * fee is exact and divides by the quantity, which a partial fill needs.
 */
function bidUnitPrice(priceEth) {
  let wei = null;
  try { wei = parseEther(String(priceEth ?? "").trim()); } catch { /* not a decimal number */ }
  if (wei == null || wei <= 0n) return { error: "bad-price", message: "Enter a price above zero." };
  const unit = roundUnitPriceDown(wei);
  if (unit <= 0n) return { error: "price-too-small", message: "Bids go in steps of 0.00001 WETH, so this one is too small." };
  return { unit };
}

/**
 * The fee lines a bid carries, each a share of the whole offer: every fee OpenSea
 * REQUIRES for the collection (constants.js OPENSEA_REQUIRED_BID_FEES, pinned so
 * no API answer decides where a bidder's WETH goes), then the venue's line only
 * while BID_VENUE_FEE_ENABLED is on. That one switch covers every bid; it replaced
 * the old criteria-only switch, and it stays off until a test bid proves OpenSea
 * takes a third-party line AND a simulated fill pays it (FEE_LEAK_LEDGER L-2).
 * A collection whose required fees are not pinned is refused before any wallet call.
 */
function bidFeeLines(collection, chainId) {
  const required = openseaRequiredBidFees(collection);
  if (!required) {
    return { error: "fees-unknown", message: `${collection?.name || "This collection"}'s OpenSea fees are not known here, so nothing was funded or signed.` };
  }
  const lines = required.map(({ recipient, bps }) => ({ recipient, bps }));
  const venue = PLATFORM_FEE_RECIPIENTS[chainId];
  if (BID_VENUE_FEE_ENABLED && PLATFORM_FEE_BPS > 0 && venue && venue !== ZERO_ADDRESS) {
    lines.push({ recipient: venue, bps: PLATFORM_FEE_BPS });
  }
  return { lines };
}

/**
 * The WETH each of this wallet's live bids can still pull through the conduit,
 * on every collection bid on here on this chain, read with fetchMyOffers' own
 * reads. null when ANY read fails, so the caller cannot mistake an outage for
 * "no other bids" and cut the allowance the older bids rely on.
 */
async function liveBidTotals(wallet, chain, chainId) {
  const weth = String(WETH_BY_CHAIN[chainId] || "").toLowerCase();
  const books = Object.values(COLLECTIONS).filter((c) => c.chain === chain && bookCollectionByContract(c.contract));
  try {
    const totals = [];
    for (const c of books) {
      for (const o of await fetchMyOffersOrThrow(wallet, c.contract)) {
        // The whole order (not the per-item price): a partly filled multi-item
        // bid is counted in full, which can only over-cover it, never under.
        if (String(o.offerToken || "").toLowerCase() === weth && /^\d+$/.test(String(o.offerWei))) totals.push(BigInt(o.offerWei));
      }
    }
    return totals;
  } catch (err) {
    console.warn("Open bid read failed; the WETH approval is only raised:", err?.message);
    return null;
  }
}

/**
 * Wrap what the bid is missing, then make the conduit's WETH allowance cover
 * every live bid at once. Returns null when funded, else the typed refusal.
 *
 * ONE BUDGET FOR ALL LIVE BIDS (lib/seaportOffer wethApprovalTarget): `approve`
 * SETS the allowance, so approving only this bid's price (the old code) cut the
 * allowance under every older bid and they silently stopped filling. Now the
 * target is the sum of the live bids plus this one, approved once, capped at
 * 100 WETH. When the open bids cannot be read the allowance is raised by this
 * bid's total instead, never lowered below what it was.
 */
async function fundBid({ buyerAddress, browserProvider, chain, chainId, bidTotal }) {
  // Step 1: Check WETH balance and wrap if needed (reserve gas buffer)
  const wethBal = await getWethBalance(buyerAddress, chainId);
  if (wethBal < bidTotal) {
    const ethBal = await browserProvider.getBalance(buyerAddress);
    const needed = bidTotal - wethBal;
    if (ethBal < needed + GAS_BUFFER_WEI) {
      return { error: "insufficient", message: `Need ${formatEther(needed + GAS_BUFFER_WEI)} more ETH (includes gas buffer)` };
    }
    // Typed errors so a wrap failure doesn't surface as a generic
    // "Failed to create offer" — the user needs to know which tx died.
    try {
      await wrapEth(needed, chainId);
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") {
        return { error: "rejected", message: "ETH wrap cancelled by user" };
      }
      // Unconfirmed or replaced is not "failed": pass the notice through.
      if (err.notice) return err.notice;
      return { error: "wrap-failed", message: `Wrapping ${formatEther(needed)} ETH to WETH failed: ${err.shortMessage || err.message || "transaction failed"}` };
    }
  }

  // Step 2: one allowance for every live bid
  const allowance = await getWethAllowance(buyerAddress, chainId);
  if (allowance >= MAX_WETH_APPROVAL_WEI) return null; // nothing more can be approved here
  const liveOfferTotals = await liveBidTotals(buyerAddress, chain, chainId);
  const { approve } = wethApprovalTarget({ allowance, liveOfferTotals, bidTotal, cap: MAX_WETH_APPROVAL_WEI });
  if (approve == null) return null;
  try {
    await approveWeth(approve, chainId);
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "WETH approval cancelled by user" };
    }
    if (err.notice) return err.notice;
    return { error: "approve-failed", message: `WETH approval failed: ${err.shortMessage || err.message || "transaction failed"}` };
  }
  return null;
}

const POST_REFUSED = {
  item: "OpenSea rejected the offer",
  collection: "OpenSea rejected the collection offer",
  trait: "OpenSea rejected the trait offer",
};

/** The one bid flow behind createItemOffer, createCollectionOffer and createTraitOffer. */
async function placeBid({ kind, collection, chain, chainId, tokenId, quantity, priceEth, expirationHours, criteria }) {
  // ── 1. Everything that needs no wallet ──
  const price = bidUnitPrice(priceEth);
  if (price.error) return price;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || (kind === "item" && quantity !== 1)) {
    return { error: "bad-quantity", message: "A bid is for a whole number of NFTs, and a bid on one NFT is for 1." };
  }
  const bidTotal = price.unit * BigInt(quantity);
  if (bidTotal > MAX_WETH_APPROVAL_WEI) {
    return { error: "too-large", message: "A bid above 100 WETH in total is not made here." };
  }
  const fees = bidFeeLines(collection, chainId);
  if (fees.error) return fees;
  const hours = Number(expirationHours);
  if (!Number.isFinite(hours) || hours <= 0) return { error: "bad-expiry", message: "Pick how long the bid lasts." };
  const lifetimeSec = Math.round(hours * 3600);

  // ── 2. The wallet ──
  // AUDIT FIX 2026-08-06 [wallet-provider]: resolve the provider from the ACTIVE
  // wagmi connector, not the fixed rdns priority walk — see getActiveWalletProvider().
  const { provider, address: connectedAddress } = await getActiveWalletProvider();
  if (!provider) return { error: "no-wallet", message: "No wallet connected" };

  try {
    const { ethers } = await import("ethers");
    const browserProvider = new ethers.BrowserProvider(provider);
    // AUDIT FIX M-8: refuse if wallet is on the wrong chain BEFORE any tx
    // hits the wallet (wrapEth / approveWeth would otherwise burn ETH on the
    // wrong chain and produce a signature for an order nobody can fill).
    const _chainErr = await assertOnExpectedChain(browserProvider, chainId);
    if (_chainErr) return _chainErr;
    const signer = await browserProvider.getSigner();
    const buyerAddress = await signer.getAddress();
    // The offerer signs the order AND funds it (wrap + approve + WETH). Refuse
    // before any of that if the signing wallet is not the connected account.
    const _walletErr = assertSameWallet(buyerAddress, connectedAddress);
    if (_walletErr) return _walletErr;

    // ── 3. The NFT side, before anything costs gas ──
    let build;
    if (kind === "item") {
      // A Base token is read on Base: the wallet, checked above to be there.
      const _tokenErr = await tokenExistenceRefusal(ethers, collection.contract, tokenId, chainId === 1 ? null : browserProvider);
      if (_tokenErr) return _tokenErr;
    } else {
      // OpenSea builds the NFT line of a collection or trait bid. Asked with the
      // two fields its spec requires (a build without `protocol_address` is a
      // 400), and held to the collection, this wallet and the quantity.
      let buildData;
      try {
        buildData = await openseaPost("offers/build", {
          offerer: buyerAddress,
          quantity,
          criteria,
          protocol_address: SEAPORT_16_ADDRESS,
          offer_protection_enabled: true,
        });
      } catch (err) {
        console.error("Build offer failed:", err.message);
        return { error: "build-failed", message: kind === "trait" ? "Could not build trait offer" : "Could not build collection offer" };
      }
      build = buildData?.partialParameters;
      if (!build || !Array.isArray(build.consideration)) {
        return { error: "build-failed", message: "OpenSea returned incomplete offer parameters" };
      }
      const _buildErr = validateBuildResponse(build, { collectionContract: collection.contract, offerer: buyerAddress, kind, quantity });
      if (_buildErr) return _buildErr;
    }

    // ── 4. The whole order, from pinned values, and the counter it is signed at ──
    const now = Math.floor(Date.now() / 1000);
    const parameters = buildBidParameters({
      chainId,
      offerer: buyerAddress,
      kind,
      collectionContract: collection.contract,
      tokenId,
      quantity,
      unitPriceWei: price.unit,
      feeLines: fees.lines,
      build,
      startTime: now,
      endTime: now + lifetimeSec,
      salt: ethers.hexlify(ethers.randomBytes(32)),
    });
    const seaport = new ethers.Contract(SEAPORT_16_ADDRESS, ["function getCounter(address) view returns (uint256)"], browserProvider);
    const counter = await seaport.getCounter(buyerAddress);

    // ── 5. Only now any gas ──
    const _fundErr = await fundBid({ buyerAddress, browserProvider, chain, chainId, bidTotal });
    if (_fundErr) return _fundErr;

    // ── 6. Sign for Seaport 1.6, post to the route OpenSea's spec names ──
    const typed = typedDataFor(parameters, counter, chainId);
    const signature = await signer.signTypedData(typed.domain, typed.types, typed.message);
    // Both posts carry the counter inside `parameters` (OpenAPI SeaportParameters).
    const posted = { ...parameters, counter: counter.toString() };
    let result;
    try {
      result = kind === "item"
        // post_offer: an item offer, on the NFT's own chain.
        ? await openseaPost(`orders/${chain}/seaport/offers`, { parameters: posted, signature, protocol_address: SEAPORT_16_ADDRESS })
        // post_criteria_offer_v2: a collection or trait offer.
        : await openseaPost("offers", { criteria, protocol_address: SEAPORT_16_ADDRESS, protocol_data: { parameters: posted, signature } });
    } catch (err) {
      console.error("OpenSea offer POST failed:", err.message);
      return { error: "post-failed", message: POST_REFUSED[kind] };
    }
    return { success: true, orderHash: result?.order_hash || result?.order?.order_hash || null };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Offer cancelled by user" };
    }
    // A wrap or approval that is unconfirmed or replaced is not "failed".
    if (err.notice) return err.notice;
    console.error("Create offer error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to create offer" };
  }
}

// An item offer is made on the chain its NFT lives on (registry): an Ethereum
// venue collection on Ethereum, a Base buy collection on Base, each with that
// chain's WETH, on Seaport 1.6 (the same address on both), posted to OpenSea's
// book there.
export async function createItemOffer({ tokenId, priceEth, expirationHours = 168, contract = CONTRACT }) {
  const book = buyChainFor([contract]);
  if (book.error) return book;
  return placeBid({
    kind: "item",
    collection: bookCollectionByContract(contract),
    chain: book.chain,
    chainId: book.chainId,
    tokenId,
    quantity: 1,
    priceEth,
    expirationHours,
  });
}

// ═══ CREATE COLLECTION OFFER ═══

export async function createCollectionOffer({ priceEth, expirationHours = 168, slug = COLLECTION_SLUG, openseaSlug, quantity = 1 }) {
  const refusal = venueSlugRefusal(openseaSlug || slug, slug);
  if (refusal) return refusal;
  const osSlug = openseaSlug || slug;
  const collection = venueCollectionBySlug(osSlug);
  return placeBid({
    kind: "collection",
    collection,
    chain: collection.chain,
    chainId: VENUE_CHAIN_IDS[collection.chain],
    quantity,
    priceEth,
    expirationHours,
    criteria: { collection: { slug: osSlug } },
  });
}

// ═══ CREATE TRAIT OFFER ═══

export async function createTraitOffer({ traitType, traitValue, priceEth, expirationHours = 168, slug = COLLECTION_SLUG, openseaSlug, quantity = 1 }) {
  const refusal = venueSlugRefusal(openseaSlug || slug, slug);
  if (refusal) return refusal;
  const osSlug = openseaSlug || slug;
  const collection = venueCollectionBySlug(osSlug);
  return placeBid({
    kind: "trait",
    collection,
    chain: collection.chain,
    chainId: VENUE_CHAIN_IDS[collection.chain],
    quantity,
    priceEth,
    expirationHours,
    // `traits`, the array OpenSea's SDK sends (`trait` is deprecated in its spec).
    criteria: { collection: { slug: osSlug }, traits: [{ type: String(traitType), value: String(traitValue) }] },
  });
}

// ═══ THE COLLECTION-SCOPED v2 READS THAT REPLACED THE SEAPORT ORDER ROUTES ═══
//
// OpenSea made `orders/{chain}/seaport/{listings,offers}` POST-only (verified
// 2026-09-05: OPTIONS -> 200 "allow: POST,OPTIONS", GET -> 405). The five GET
// call sites that used them returned 502 forever. The replacements are the
// collection-scoped routes, and `maker` IS a real server-side filter on them —
// three-leg proof, run against prod:
//   listings/collection/nakamigos/all?maker=<a lister>  -> 1 row,  1 offerer
//   listings/collection/nakamigos/all?maker=0x…0001     -> 0 rows
//   listings/collection/nakamigos/all (control)         -> 20 rows, 11 offerers
// (the same shape holds for offers/collection/{slug}/all).
//
// TWO TRAPS THAT A NAIVE REPOINT WALKS STRAIGHT INTO, both measured:
//
//  1. THE CURSOR PARAM IS `next`, NOT `cursor`. Passing `cursor` is silently
//     IGNORED — page 2 comes back with page 1's first order_hash, so the old
//     loop would re-read page one until MAX_MY_PAGES and call it pagination.
//
//  2. THESE ROWS HAVE NO `cancelled` / `finalized`. They carry `status`
//     ("ACTIVE"). The old filter is `!o.cancelled && !o.finalized`, and on a row
//     where both are `undefined` that is `true && true` — EVERY order passes,
//     dead ones included, on the screen where an owner clicks Accept.
//     `isLiveOrder` below reads whichever shape it is handed.

/** Cursor-paginate a collection-scoped v2 route filtered to one maker. */
async function fetchPagesByMaker(path, wallet, { limit = 50, maxPages = MAX_MY_PAGES } = {}) {
  const rows = [];
  let next = null;
  for (let page = 0; page < maxPages; page++) {
    const params = { maker: wallet, limit };
    if (next) params.next = next;                   // NOT `cursor` — see trap 1
    const data = await openseaGet(path, params);
    const batch = data.offers || data.listings || data.orders || [];
    rows.push(...batch);
    if (!data.next || batch.length === 0) break;
    next = data.next;
  }
  return rows;
}

/**
 * Is this order still fillable? Understands BOTH row shapes deliberately:
 * the legacy `cancelled`/`finalized` booleans and the v2 `status` string.
 *
 * Fails CLOSED on an unrecognised status — a dead order rendered as live is a
 * seller paying gas to accept something that no longer exists, which is exactly
 * the failure `acceptOffer`'s ordering fix was written to stop paying for.
 */
function isLiveOrder(order, nowSecs) {
  if (typeof order?.status === "string") {
    if (order.status.toUpperCase() !== "ACTIVE") return false;
  } else if (order?.cancelled || order?.finalized) {
    return false;
  }
  const endSec = parseInt(order?.protocol_data?.parameters?.endTime);
  return !Number.isFinite(endSec) || endSec > nowSecs;
}

// ═══ FETCH MY OFFERS (outgoing bids) ═══
// Paginates through all pages using cursor to avoid truncation at 20 results.
const MAX_MY_PAGES = 10; // Safety cap: 10 pages * 50 = up to 500 orders

// Read on the CONTRACT's own collection. A contract the venue does not trade is
// refused (thrown), not answered with an empty list the read never produced.
//
// This form THROWS when the read fails. The WETH approval budget (placeBid) must
// tell "no other live bids" from "could not ask": reading an outage as an empty
// book would approve only the new bid and cut the allowance every older bid needs.
async function fetchMyOffersOrThrow(wallet, contract = CONTRACT) {
  const collection = bookCollectionByContract(contract);
  if (!collection) throw venueRefusalError(venueRefusal(contract));
  const allOrders = await fetchPagesByMaker(`offers/collection/${collection.openseaSlug}/all`, wallet);
  const now = Math.floor(Date.now() / 1000);
  return allOrders
    .filter(o => isLiveOrder(o, now))
    .map(normalizeOffer);
}

export async function fetchMyOffers(wallet, contract = CONTRACT) {
  const collection = bookCollectionByContract(contract);
  if (!collection) throw venueRefusalError(venueRefusal(contract));
  try {
    return await fetchMyOffersOrThrow(wallet, contract);
  } catch (err) {
    console.warn("Fetch my offers failed:", err.message);
    return [];
  }
}

// ═══ FETCH MY LISTINGS ═══
// Paginates through all pages using cursor to avoid truncation at 20 results.
//
// Returns `{ listings, fallback }`, NOT a bare array. This used to `return []`
// on failure, which made an OpenSea outage indistinguishable from "this wallet
// has nothing listed" — the caller rendered both as no listings at all, so a
// seller whose listings were merely unreachable was told they had none. That is
// the same conflation `fetchTopHolders` carries `fallback: true` to prevent
// (api.js:638, "'zero sales' and 'we couldn't ask' must not render as the same
// claim"), applied here to the seller's own listings.
//
// `fallback: true` means WE COULD NOT ASK. `listings: []` with `fallback: false`
// means genuinely nothing listed. Callers must branch on the two separately.
// Read on the CONTRACT's own collection; one the venue does not trade is not asked.
export async function fetchMyListings(wallet, contract = CONTRACT) {
  const collection = venueCollectionByContract(contract);
  if (!collection) return { listings: [], fallback: true };
  try {
    const allOrders = await fetchPagesByMaker(`listings/collection/${collection.openseaSlug}/all`, wallet);
    const now = Math.floor(Date.now() / 1000);
    const listings = allOrders
      .filter(o => isLiveOrder(o, now))
      .map(o => {
        const params = o.protocol_data?.parameters;
        const offerItem = params?.offer?.[0];
        const tokenId = offerItem?.identifierOrCriteria;
        // Price is in the consideration (what seller receives + fees)
        const totalWei = (params?.consideration || []).reduce(
          (sum, c) => sum + BigInt(c.startAmount || "0"), 0n
        );
        const endSec = parseInt(params?.endTime);
        return {
          orderHash: o.order_hash,
          tokenId,
          price: safePriceFromWei(totalWei.toString()),
          expiry: Number.isFinite(endSec) ? new Date(endSec * 1000) : null,
          protocolAddress: o.protocol_address,
          rawOrder: o,
        };
      });
    return { listings, fallback: false };
  } catch (err) {
    console.warn("Fetch my listings failed:", err.message);
    return { listings: [], fallback: true };
  }
}

// ═══ CANCEL ORDER (listings or bids) ═══

export async function cancelOrder(order) {
  const params = order?.rawOrder?.protocol_data?.parameters || order?.protocol_data?.parameters;
  // Cancelled on the order's own chain (lib/venue.js): a Base order on Base.
  const where = cancelChainFor(params);
  if (where.error) return where;
  // AUDIT FIX 2026-08-06 [wallet-provider]: active connector, not the rdns walk.
  const { provider, address: connectedAddress } = await getActiveWalletProvider();
  if (!provider) return { error: "no-wallet", message: "No wallet connected" };

  try {
    const { ethers } = await import("ethers");
    const browserProvider = new ethers.BrowserProvider(provider);
    // AUDIT FIX M-8: refuse cancel on the wrong chain.
    const _chainErr = await assertOnExpectedChain(browserProvider, where.chainId);
    if (_chainErr) return _chainErr;
    const signer = await browserProvider.getSigner();
    // Only the offerer can cancel. Signing from a different wallet burns gas on
    // a cancel that marks nothing and reports success.
    const signerAddress = await signer.getAddress();
    const _walletErr = assertSameWallet(signerAddress, connectedAddress);
    if (_walletErr) return _walletErr;

    if (!params) return { error: "failed", message: "Missing order parameters" };

    // The Seaport the order was SIGNED against (why it matters: the F630 note at
    // the on-chain cancel below).
    const orderProtocolAddress =
      order.rawOrder?.protocol_address || order.protocol_address || order.protocolAddress || null;

    // ── A Seaport 1.6 SignedZone order (every bid made here): OpenSea's gasless
    // cancel first (lib/seaportCancel.js cancelSeaportOrderGasless). It costs
    // nothing, and OpenSea stops approving fills at once, except a fill it
    // approved in the last 5 minutes, which the message says. If OpenSea refuses
    // it (a very new order may need an on-chain cancel), cannot be reached, or
    // the order hash is not this order's, the on-chain cancel below runs as
    // before. A Seaport 1.5 or zone-less order always takes the on-chain cancel.
    if (isSeaport16SignedZoneOrder(params, orderProtocolAddress)
      && String(params.offerer || "").toLowerCase() === String(signerAddress).toLowerCase()) {
      const orderHash = order.orderHash || order.order_hash || order.rawOrder?.order_hash || null;
      let off = null;
      try {
        off = await cancelSeaportOrderGasless({ ethers, signer, params, orderHash, chainId: where.chainId, post: openseaPost });
      } catch (err) {
        // The wallet said no to the cancel signature: that is the answer, not a
        // reason to ask for an on-chain cancel the user did not agree to either.
        if (err.code === 4001 || err.code === "ACTION_REJECTED") {
          return { error: "rejected", message: "Transaction cancelled" };
        }
        console.warn("Gasless cancel failed; cancelling on chain:", err?.message);
      }
      if (off?.ok) {
        return { success: true, gasless: true, message: GASLESS_CANCEL_DONE, lastSignatureValidUntil: off.lastSignatureValidUntil };
      }
      if (off) console.warn("Gasless cancel not confirmed; cancelling on chain:", off.reason);
    }

    // F630: cancel via the shared helper — reads the offerer's live counter and
    // rebuilds OrderComponents so cancel() targets the REAL order hash (the old
    // inline ABI put totalOriginalConsiderationItems in the counter slot and
    // cancelled a phantom order while the real one stayed fillable).
    // Cancel on the Seaport the order was actually SIGNED against, not on whichever
    // version this constant happens to name.
    //
    // `cancelSeaportOrder` documents that "every caller passes a server-supplied
    // protocol_address" and pins it at the sink — but this call site handed it the
    // hardcoded default, and the pin cannot catch that, because the default IS an
    // allowlisted address. So an order created on a different Seaport version had its
    // cancel sent to this one, where that order hash does not exist: `cancel()` marks
    // an unknown hash without reverting, the tx succeeds, this returns
    // `{ success: true }` — and the real order stays fillable. The user is told their
    // listing is cancelled while it can still be bought.
    //
    // Passing null keeps the documented default for an order that genuinely carries no
    // protocol address; an address outside the allowlist still fails closed at the sink.
    const tx = await cancelSeaportOrder({ ethers, signer, params, seaportAddress: orderProtocolAddress });
    const done = await waitForTxOutcome(tx);
    if (done.kind !== "success") {
      return txOutcomeResult(done, {
        reverted: { error: "reverted", message: "The cancel reverted on-chain. The order is still live." },
        ifLanded: "the order is already cancelled and a second cancel only costs gas.",
      });
    }
    return { success: true, hash: done.hash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Transaction cancelled" };
    }
    console.error("Cancel order error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to cancel order" };
  }
}

// ═══ ACCEPT OFFER (for token owners) ═══

const OFFER_GONE_MESSAGE = "This bid just changed or ended.";
// The statuses api/opensea.js forwards from OpenSea as a permanent refusal
// (PERMANENT_UPSTREAM_STATUSES), less 405, which is about the route, not the order.
const ORDER_GONE_STATUSES = new Set([400, 404, 410, 422]);

/** True when OpenSea itself refused to build a fill: the order is gone or invalid. */
function isOrderGoneRefusal(err) {
  return ORDER_GONE_STATUSES.has(Number(err?.status)) && /upstream-rejected/.test(String(err?.message || ""));
}

export async function acceptOffer(offer) {
  // The NFT a seller hands over is the offer's own contract. One that does not
  // trade here, or no contract at all, is refused before any wallet call. Its
  // chain (registry) is the chain the accept is built and sent on.
  const book = buyChainFor([offer?.tokenContract]);
  if (book.error) return book;
  // AUDIT FIX 2026-08-06 [wallet-provider]: active connector, not the rdns walk.
  const { provider, address: connectedAddress } = await getActiveWalletProvider();
  if (!provider) return { error: "no-wallet", message: "No wallet connected" };

  try {
    const { ethers } = await import("ethers");
    const browserProvider = new ethers.BrowserProvider(provider);
    // AUDIT FIX D-FE-M1: chain-guard BEFORE any tx hits the wallet. Pre-fix,
    // a seller on the wrong chain (Sepolia / Base / etc.) would still proceed
    // through setApprovalForAll on a phantom Conduit address — burning gas
    // AND leaving a setApprovalForAll(true) on whatever contract collides
    // with CONDUIT_ADDRESS on that chain. Mirrors createItemOffer / cancelOrder
    // which already gate on assertOnExpectedChain.
    const _chainErr = await assertOnExpectedChain(browserProvider, book.chainId);
    if (_chainErr) return _chainErr;
    const signer = await browserProvider.getSigner();
    const sellerAddress = await signer.getAddress();
    // The seller signs setApprovalForAll AND delivers the NFT. If the signing
    // wallet is not the connected account, the approval lands on the wrong
    // wallet and the fill reverts (or hands the NFT over from the wrong one).
    const _walletErr = assertSameWallet(sellerAddress, connectedAddress);
    if (_walletErr) return _walletErr;

    // Get fulfillment data from OpenSea — via proxy
    //
    // `consideration` NAMES THE TOKEN THAT FILLS A CRITERIA OFFER.
    //
    // A criteria offer (ERC721_WITH_CRITERIA, itemType 4 — a collection or trait
    // bid) does not name a token: its consideration item holds a merkle root over
    // every id the bid covers. Without a `consideration` field this POST has no
    // way to know which of those the seller is handing over, so it cannot build
    // the criteria resolver, and it rejects the request outright.
    //
    // MEASURED 2026-09-09 against live orders, real token owners as fulfiller,
    // protocol seaport1.6. All four cells, the field the only variable:
    //   criteria offer (itemType 4), without -> HTTP 400, upstream rejected
    //   criteria offer (itemType 4), with    -> HTTP 200, matchAdvancedOrders
    //   exact-token offer (itemType 2), without -> HTTP 200
    //   exact-token offer (itemType 2), with    -> HTTP 200
    // `matchAdvancedOrders` is already in SEAPORT_FULFILLMENT_FUNCTIONS, so the
    // signature gate below admits the criteria fill rather than aborting it.
    //
    // This retires the note that used to sit further down claiming the field
    // "needs a real fill to verify — it cannot be confirmed read-only". It can:
    // `offers/fulfillment_data` only BUILDS calldata, it signs and sends nothing,
    // so the whole matrix above cost nothing and settled it.
    const nftContract = offer.tokenContract;
    // Sent whenever the token is known, not only for criteria orders. The bottom
    // two rows of that matrix are why: on an exact-token offer the field merely
    // restates what the order already pins and is accepted just the same. So this
    // does NOT branch on itemType — which is just as well, because the itemType
    // does not survive onto the normalized offer this receives.
    const fillTokenId = offer.tokenId == null ? null : String(offer.tokenId);
    let data;
    try {
      data = await openseaPost("offers/fulfillment_data", {
        offer: {
          hash: offer.orderHash,
          chain: book.chain,
          protocol_address: offer.protocolAddress || SEAPORT_ADDRESSES_BY_CHAIN[book.chainId],
        },
        fulfiller: { address: sellerAddress },
        ...(fillTokenId
          ? { consideration: { asset_contract_address: nftContract, token_id: fillTokenId } }
          : {}),
      });
    } catch (err) {
      // NO STALE ACCEPT. OpenSea will not build a fill for an order that is not
      // there to fill any more (cancelled, filled, expired, re-priced into a new
      // order, or never existed): it answers 4xx, which the proxy forwards as
      // `upstream-rejected`. The seller is told plainly and nothing is approved
      // or sent. Anything else (a 5xx, a timeout) stays the retryable message.
      if (isOrderGoneRefusal(err)) return { error: "offer-gone", message: OFFER_GONE_MESSAGE };
      return { error: "failed", message: "Could not get fulfillment data" };
    }
    const txData = data.fulfillment_data?.transaction;
    if (!txData?.to) {
      return { error: "failed", message: "Invalid fulfillment data" };
    }

    // Validate the transaction target is a known Seaport contract
    const knownSeaportAddresses = new Set([
      "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", // Seaport 1.5
      "0x0000000000000068f116a894984e2db1123eb395", // Seaport 1.6
    ]);
    if (!knownSeaportAddresses.has(txData.to.toLowerCase())) {
      return { error: "failed", message: "Unexpected transaction target — aborting for safety" };
    }

    // Same defense as fulfillSeaportOrder: target is pinned to Seaport, and
    // the function signature from the API response must be a known
    // fulfillment entrypoint before we encode calldata from it.
    const fnName = String(txData.function || "").split("(")[0].trim();
    if (!SEAPORT_FULFILLMENT_FUNCTIONS.has(fnName)) {
      return { error: "failed", message: "Unexpected fulfillment function — aborting for safety" };
    }

    // ── APPROVAL GOES LAST, AFTER EVERYTHING FREE HAS PASSED ────────────────
    //
    // This block used to sit ABOVE the fulfillment_data POST, so a seller paid
    // for a real setApprovalForAll and only then discovered the fill could not
    // be built — "Could not get fulfillment data", gas already spent, nothing
    // received. It is the same defect D-FE-M1 fixed for the wrong-chain case
    // (see the chain-guard comment above, which fixed it by moving the CHECK
    // before the tx); this moves the TX after the checks, for the same reason.
    //
    // It is not hypothetical and it is not rare. Measured 2026-09-05 against
    // the live collection: `offers/collection/nakamigos/nfts/{id}/best` returns
    // an ERC721_WITH_CRITERIA order (itemType 4) for 10 of 12 sampled tokens,
    // and that POST used to omit the `consideration` field that tells OpenSea
    // WHICH token fills a criteria offer — so the failure landed on the majority
    // of tokens, on the one screen where an owner is accepting money. That field
    // is now supplied at the POST above, which is what makes those fills work at
    // all; this ordering is still what makes a fill that DOES fail cost nothing.
    //
    // Everything above this line is a read or a validation. Nothing above it
    // can cost the seller gas.

    // Encode calldata using ABI parameter names to avoid
    // depending on Object.values() insertion order from the API.
    function toPositional(val) {
      if (val === null || val === undefined) return val;
      if (typeof val === "string" || typeof val === "bigint" || typeof val === "number" || typeof val === "boolean") return val;
      if (Array.isArray(val)) return val.map(toPositional);
      if (typeof val === "object") return Object.values(val).map(toPositional);
      return val;
    }

    const iface = new ethers.Interface([`function ${txData.function}`]);
    const fnFragment = iface.getFunction(fnName);

    let inputValues;
    if (fnFragment && fnFragment.inputs.every(p => p.name && p.name in txData.input_data)) {
      inputValues = fnFragment.inputs.map(p => toPositional(txData.input_data[p.name]));
    } else {
      inputValues = Object.values(txData.input_data).map(toPositional);
    }
    const encoded = iface.encodeFunctionData(fnName, inputValues);

    // The NFT handed over is read back from the calldata that will be signed.
    // It must trade here and be the offer's own contract. Encoding is free, so
    // this runs before the approval below.
    const nftRefusal = fulfillCallRefusal(seaportCallNftTokens(iface, fnName, encoded), [nftContract], book.chain);
    if (nftRefusal) return nftRefusal;
    // ...and so is the rest of what it commits the seller to: no ETH out, only
    // this one token handed over, every payment on the seller's side to the seller.
    const fillValue = BigInt(txData.value || 0);
    const tradeRefusal = acceptTradeRefusal(decodeSeaportTrade(iface, fnName, encoded), {
      seller: sellerAddress,
      nftContract,
      tokenId: fillTokenId,
      txValue: fillValue,
    });
    if (tradeRefusal) return tradeRefusal;

    const erc721ABI = [
      "function isApprovedForAll(address,address) view returns (bool)",
      "function setApprovalForAll(address,bool)",
    ];
    const nft = new ethers.Contract(nftContract, erc721ABI, signer);
    const isApproved = await nft.isApprovedForAll(sellerAddress, CONDUIT_ADDRESS);
    if (!isApproved) {
      const approveTx = await nft.setApprovalForAll(CONDUIT_ADDRESS, true);
      // The fill is only sent once the approval is known to be in place.
      const approved = await waitForTxOutcome(approveTx);
      if (approved.kind !== "success") {
        return txOutcomeResult(approved, {
          reverted: { error: "approval-failed", message: "NFT approval transaction reverted" },
          ifLanded: "the approval is already in place and a second one only costs gas.",
        });
      }
    }

    const tx = await signer.sendTransaction({
      to: txData.to,
      value: fillValue,
      data: encoded,
    });

    // Wait for on-chain confirmation before reporting success
    const done = await waitForTxOutcome(tx);
    if (done.kind !== "success") {
      return txOutcomeResult(done, {
        reverted: { error: "failed", message: "Transaction reverted on-chain" },
        ifLanded: "the NFT is already sold and accepting the offer again will not go through.",
      });
    }

    return { success: true, hash: done.hash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Transaction cancelled" };
    }
    console.error("Accept offer error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to accept offer" };
  }
}
