import { parseEther, formatEther } from "viem";
import { CONTRACT, COLLECTION_SLUG, WETH, SEAPORT_ADDRESS, SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, CONDUIT_KEY, CONDUIT_ADDRESS, OPENSEA_FEE_RECIPIENT, OPENSEA_FEE_BPS, PLATFORM_FEE_RECIPIENT, PLATFORM_FEE_BPS } from "./constants";
import { getProvider, SEAPORT_FULFILLMENT_FUNCTIONS } from "./api";
import { getWethBalance, getWethAllowance, wrapEth, approveWeth } from "./lib/weth";
import { openseaGet as rawOpenseaGet, openseaPost as rawOpenseaPost, ApiError } from "./lib/proxy";
import { cancelSeaportOrder } from "./lib/seaportCancel";

// AUDIT FIX M-8 (frontend chain guard): assertOnExpectedChain blocks any
// on-chain action when the wallet is connected to a chain != SEAPORT_DOMAIN.chainId.
// Pre-fix, a user on Sepolia/Base/Arbitrum who clicked "Make Offer" would have
// `wrapEth(needed)` and `approveWeth(priceWei)` execute on the WRONG chain
// (real testnet/L2 ETH burned), then sign a chain-1 EIP-712 offer that the
// orderbook can't fulfill. Now every offer/cancel/accept entrypoint refuses
// up-front with a typed error before any tx hits the wallet.
async function assertOnExpectedChain(browserProvider) {
  try {
    const network = await browserProvider.getNetwork();
    const got = Number(network.chainId);
    const want = Number(SEAPORT_DOMAIN.chainId);
    if (got !== want) {
      return { error: "wrong-chain", message: `Connected to chain ${got}; expected chain ${want}` };
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

export async function fetchTokenOffers(tokenId, contract = CONTRACT) {
  try {
    const data = await openseaGet("orders/ethereum/seaport/offers", {
      asset_contract_address: contract,
      token_ids: tokenId,
      order_by: "eth_price",
      order_direction: "desc",
    });
    return (data.orders || []).map(normalizeOffer);
  } catch (err) {
    console.warn("Fetch token offers failed:", err.message);
    return [];
  }
}

export async function fetchBestOffer(tokenId, slug = COLLECTION_SLUG, { openseaSlug } = {}) {
  const osSlug = openseaSlug || slug;
  try {
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
      expiry: Number.isFinite(endSec) ? new Date(endSec * 1000) : null,
    };
  } catch (err) {
    console.warn("Fetch best offer failed:", err.message);
    return null;
  }
}

export async function fetchCollectionOffers(slug = COLLECTION_SLUG, { openseaSlug, signal } = {}) {
  const osSlug = openseaSlug || slug;
  try {
    const data = await openseaGet(`offers/collection/${osSlug}/all`, {}, { signal });
    return (data.offers || []).map(o => ({
      price: o.price?.value ? safePriceFromWei(o.price.value) : null,
      currency: o.price?.currency,
      maker: o.protocol_data?.parameters?.offerer,
      orderHash: o.order_hash,
      quantity: o.protocol_data?.parameters?.offer?.[0]?.startAmount || "1",
      criteria: o.criteria,
    }));
  } catch (err) {
    console.warn("Fetch collection offers failed:", err.message);
    return [];
  }
}

// SELF-AUDIT 2026-05-27, resolved 2026-06-09: OpenSea's dedicated
// `offers/collection/{slug}/traits` endpoint 400s on every `mode` value we
// tried and has no public spec. But `offers/collection/{slug}/all` (already
// fetched for the collection-offers panel) includes criteria offers, and
// trait offers carry `criteria.trait = { type, value }` — so the per-trait
// best bid is derived from data the app already has. Zero extra requests
// against OpenSea's rate limit.
// Input: normalized offers from fetchCollectionOffers (price in ETH).
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

function safePriceFromWei(wei) {
  try {
    if (!wei || wei === "0") return 0;
    return Number(BigInt(wei) / BigInt(1e12)) / 1e6;
  } catch {
    return 0;
  }
}

function normalizeOffer(order) {
  const params = order.protocol_data?.parameters;
  const offer = params?.offer?.[0];
  const priceWei = offer?.startAmount || "0";
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
  const feeWei = sawFeeItem ? feeSumWei.toString() : null;
  return {
    price: safePriceFromWei(priceWei),
    priceWei,
    feeWei,
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

export async function createItemOffer({ tokenId, priceEth, expirationHours = 168, contract = CONTRACT }) {
  const provider = getProvider();
  if (!provider) return { error: "no-wallet" };

  try {
    const { ethers } = await import("ethers");
    const browserProvider = new ethers.BrowserProvider(provider);
    // AUDIT FIX M-8: refuse if wallet is on the wrong chain BEFORE any tx
    // hits the wallet (wrapEth / approveWeth would otherwise burn ETH on the
    // wrong chain and produce a chain-1 EIP-712 sig the orderbook can't fill).
    const _chainErr = await assertOnExpectedChain(browserProvider);
    if (_chainErr) return _chainErr;
    const signer = await browserProvider.getSigner();
    const buyerAddress = await signer.getAddress();

    const priceWei = parseEther(String(priceEth));

    // Step 1: Check WETH balance and wrap if needed (reserve gas buffer)
    const wethBal = await getWethBalance(buyerAddress);
    if (wethBal < priceWei) {
      const ethBal = await browserProvider.getBalance(buyerAddress);
      const needed = priceWei - wethBal;
      if (ethBal < needed + GAS_BUFFER_WEI) {
        return { error: "insufficient", message: `Need ${formatEther(needed + GAS_BUFFER_WEI)} more ETH (includes gas buffer)` };
      }
      // Wrap ETH -> WETH (leave gas buffer for approve + sign)
      // Typed errors so a wrap failure doesn't surface as a generic
      // "Failed to create offer" — the user needs to know which tx died.
      try {
        await wrapEth(needed);
      } catch (err) {
        if (err.code === 4001 || err.code === "ACTION_REJECTED") {
          return { error: "rejected", message: "ETH wrap cancelled by user" };
        }
        return { error: "wrap-failed", message: `Wrapping ${formatEther(needed)} ETH to WETH failed: ${err.shortMessage || err.message || "transaction failed"}` };
      }
    }

    // Step 2: Check WETH allowance for conduit
    const allowance = await getWethAllowance(buyerAddress);
    if (allowance < priceWei) {
      try {
        await approveWeth(priceWei);
      } catch (err) {
        if (err.code === 4001 || err.code === "ACTION_REJECTED") {
          return { error: "rejected", message: "WETH approval cancelled by user" };
        }
        return { error: "approve-failed", message: `WETH approval failed: ${err.shortMessage || err.message || "transaction failed"}` };
      }
    }

    // Step 3: Build the offer order
    const now = Math.floor(Date.now() / 1000);
    const endTime = now + expirationHours * 3600;

    // Calculate fees
    const osFeeAmount = (priceWei * BigInt(OPENSEA_FEE_BPS)) / 10000n;
    const platformFeeAmount = (priceWei * BigInt(PLATFORM_FEE_BPS)) / 10000n;

    const consideration = [
      {
        itemType: 2, // ERC721
        token: contract,
        identifierOrCriteria: String(tokenId),
        startAmount: "1",
        endAmount: "1",
        recipient: buyerAddress,
      },
      {
        itemType: 1, // ERC20 (WETH) - OpenSea fee
        token: WETH,
        identifierOrCriteria: "0",
        startAmount: osFeeAmount.toString(),
        endAmount: osFeeAmount.toString(),
        recipient: OPENSEA_FEE_RECIPIENT,
      },
    ];

    // Add platform fee if recipient is set (non-zero address)
    if (PLATFORM_FEE_BPS > 0 && PLATFORM_FEE_RECIPIENT !== "0x0000000000000000000000000000000000000000") {
      consideration.push({
        itemType: 1, // ERC20 (WETH) - Platform fee
        token: WETH,
        identifierOrCriteria: "0",
        startAmount: platformFeeAmount.toString(),
        endAmount: platformFeeAmount.toString(),
        recipient: PLATFORM_FEE_RECIPIENT,
      });
    }

    const orderParameters = {
      offerer: buyerAddress,
      zone: "0x0000000000000000000000000000000000000000",
      offer: [{
        itemType: 1, // ERC20 (WETH)
        token: WETH,
        identifierOrCriteria: "0",
        startAmount: priceWei.toString(),
        endAmount: priceWei.toString(),
      }],
      consideration,
      orderType: 0, // FULL_OPEN
      startTime: String(now),
      endTime: String(endTime),
      zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: ethers.hexlify(ethers.randomBytes(32)),
      conduitKey: CONDUIT_KEY,
      totalOriginalConsiderationItems: consideration.length,
    };

    // Step 4: Get the counter from Seaport contract
    const seaportABI = ["function getCounter(address) view returns (uint256)"];
    const seaport = new ethers.Contract(SEAPORT_ADDRESS, seaportABI, browserProvider);
    const counter = await seaport.getCounter(buyerAddress);

    // Step 5: Sign EIP-712 (using shared domain + types from constants)
    const signData = { ...orderParameters, counter: counter.toString() };
    const signature = await signer.signTypedData(SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, signData);

    // Step 6: POST to OpenSea (via proxy)
    let result;
    try {
      result = await openseaPost("orders/ethereum/seaport/offers", {
        parameters: { ...orderParameters, totalOriginalConsiderationItems: orderParameters.consideration.length },
        signature,
        protocol_address: SEAPORT_ADDRESS,
      });
    } catch (err) {
      console.error("OpenSea offer POST failed:", err.message);
      return { error: "post-failed", message: "OpenSea rejected the offer" };
    }
    return { success: true, orderHash: result.order?.order_hash || result.order_hash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Offer cancelled by user" };
    }
    console.error("Create offer error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to create offer" };
  }
}

// ═══ CREATE COLLECTION OFFER ═══

export async function createCollectionOffer({ priceEth, expirationHours = 168, slug = COLLECTION_SLUG, openseaSlug }) {
  const osSlug = openseaSlug || slug;
  const provider = getProvider();
  if (!provider) return { error: "no-wallet" };

  try {
    const { ethers } = await import("ethers");
    const browserProvider = new ethers.BrowserProvider(provider);
    // AUDIT FIX M-8: refuse if wallet is on the wrong chain BEFORE any tx
    // hits the wallet (wrapEth / approveWeth would otherwise burn ETH on the
    // wrong chain and produce a chain-1 EIP-712 sig the orderbook can't fill).
    const _chainErr = await assertOnExpectedChain(browserProvider);
    if (_chainErr) return _chainErr;
    const signer = await browserProvider.getSigner();
    const buyerAddress = await signer.getAddress();
    const priceWei = parseEther(String(priceEth));

    // Step 1: WETH balance & approval (reserve gas buffer)
    const wethBal = await getWethBalance(buyerAddress);
    if (wethBal < priceWei) {
      const ethBal = await browserProvider.getBalance(buyerAddress);
      const needed = priceWei - wethBal;
      if (ethBal < needed + GAS_BUFFER_WEI) {
        return { error: "insufficient", message: `Need ${formatEther(needed + GAS_BUFFER_WEI)} more ETH (includes gas buffer)` };
      }
      await wrapEth(needed);
    }

    const allowance = await getWethAllowance(buyerAddress);
    if (allowance < priceWei) {
      await approveWeth(priceWei);
    }

    // Step 2: Build offer via OpenSea (collection-wide, no trait) — via proxy
    let buildData;
    try {
      buildData = await openseaPost("offers/build", {
        offerer: buyerAddress,
        quantity: 1,
        criteria: {
          collection: { slug: osSlug },
        },
      });
    } catch (err) {
      console.error("Build collection offer failed:", err.message);
      return { error: "build-failed", message: "Could not build collection offer" };
    }
    const partial = buildData.partialParameters;
    if (!partial || !partial.consideration) {
      return { error: "build-failed", message: "OpenSea returned incomplete offer parameters" };
    }

    // Step 3: Build order parameters
    const now = Math.floor(Date.now() / 1000);
    const endTime = now + expirationHours * 3600;

    const orderParameters = {
      offerer: buyerAddress,
      zone: partial.zone,
      offer: [{
        itemType: 1,
        token: WETH,
        identifierOrCriteria: "0",
        startAmount: priceWei.toString(),
        endAmount: priceWei.toString(),
      }],
      consideration: partial.consideration.map(c => ({
        ...c,
        startAmount: c.startAmount || "0",
        endAmount: c.endAmount || "0",
      })),
      orderType: partial.orderType || 2,
      startTime: String(now),
      endTime: String(endTime),
      zoneHash: partial.zoneHash,
      salt: ethers.hexlify(ethers.randomBytes(32)),
      conduitKey: partial.conduitKey || CONDUIT_KEY,
      totalOriginalConsiderationItems: partial.consideration.length,
    };

    // Step 4: Get counter & sign EIP-712
    const seaportABI = ["function getCounter(address) view returns (uint256)"];
    const seaport = new ethers.Contract(SEAPORT_ADDRESS, seaportABI, browserProvider);
    const counter = await seaport.getCounter(buyerAddress);

    const signData = { ...orderParameters, counter: counter.toString() };
    const signature = await signer.signTypedData(SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, signData);

    // Step 5: POST criteria offer (collection-wide) — via proxy
    try {
      await openseaPost("criteria_offers", {
        parameters: orderParameters,
        signature,
        protocol_address: SEAPORT_ADDRESS,
        criteria: {
          collection: { slug: osSlug },
        },
      });
    } catch (err) {
      console.error("OpenSea collection offer POST failed:", err.message);
      return { error: "post-failed", message: "OpenSea rejected the collection offer" };
    }

    return { success: true };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Offer cancelled by user" };
    }
    console.error("Create collection offer error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to create collection offer" };
  }
}

// ═══ CREATE TRAIT OFFER ═══

export async function createTraitOffer({ traitType, traitValue, priceEth, expirationHours = 168, slug = COLLECTION_SLUG, openseaSlug }) {
  const osSlug = openseaSlug || slug;
  const provider = getProvider();
  if (!provider) return { error: "no-wallet" };

  try {
    const { ethers } = await import("ethers");
    const browserProvider = new ethers.BrowserProvider(provider);
    // AUDIT FIX M-8: refuse if wallet is on the wrong chain BEFORE any tx
    // hits the wallet (wrapEth / approveWeth would otherwise burn ETH on the
    // wrong chain and produce a chain-1 EIP-712 sig the orderbook can't fill).
    const _chainErr = await assertOnExpectedChain(browserProvider);
    if (_chainErr) return _chainErr;
    const signer = await browserProvider.getSigner();
    const buyerAddress = await signer.getAddress();
    const priceWei = parseEther(String(priceEth));

    // Step 1: WETH balance & approval (reserve gas buffer)
    const wethBal = await getWethBalance(buyerAddress);
    if (wethBal < priceWei) {
      const ethBal = await browserProvider.getBalance(buyerAddress);
      const needed = priceWei - wethBal;
      if (ethBal < needed + GAS_BUFFER_WEI) {
        return { error: "insufficient", message: `Need ${formatEther(needed + GAS_BUFFER_WEI)} more ETH (includes gas buffer)` };
      }
      await wrapEth(needed);
    }

    const allowance = await getWethAllowance(buyerAddress);
    if (allowance < priceWei) {
      await approveWeth(priceWei);
    }

    // Step 2: Call OpenSea's build_offer endpoint via proxy
    let buildData;
    try {
      buildData = await openseaPost("offers/build", {
        offerer: buyerAddress,
        quantity: 1,
        criteria: {
          collection: { slug: osSlug },
          trait: { type: traitType, value: traitValue },
        },
      });
    } catch (err) {
      console.error("Build offer failed:", err.message);
      return { error: "build-failed", message: "Could not build trait offer" };
    }
    const partial = buildData.partialParameters;
    if (!partial || !partial.consideration) {
      return { error: "build-failed", message: "OpenSea returned incomplete offer parameters" };
    }

    // Step 3: Merge partial params with our offer
    const now = Math.floor(Date.now() / 1000);
    const endTime = now + expirationHours * 3600;

    const orderParameters = {
      offerer: buyerAddress,
      zone: partial.zone,
      offer: [{
        itemType: 1,
        token: WETH,
        identifierOrCriteria: "0",
        startAmount: priceWei.toString(),
        endAmount: priceWei.toString(),
      }],
      consideration: partial.consideration.map(c => ({
        ...c,
        startAmount: c.startAmount || "0",
        endAmount: c.endAmount || "0",
      })),
      orderType: partial.orderType || 2,
      startTime: String(now),
      endTime: String(endTime),
      zoneHash: partial.zoneHash,
      salt: ethers.hexlify(ethers.randomBytes(32)),
      conduitKey: partial.conduitKey || CONDUIT_KEY,
      totalOriginalConsiderationItems: partial.consideration.length,
    };

    // Step 4: Get counter & sign
    const seaportABI = ["function getCounter(address) view returns (uint256)"];
    const seaport = new ethers.Contract(SEAPORT_ADDRESS, seaportABI, browserProvider);
    const counter = await seaport.getCounter(buyerAddress);

    const signData = { ...orderParameters, counter: counter.toString() };
    const signature = await signer.signTypedData(SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, signData);

    // Step 5: POST criteria offer — via proxy
    try {
      await openseaPost("criteria_offers", {
        parameters: orderParameters,
        signature,
        protocol_address: SEAPORT_ADDRESS,
        criteria: {
          collection: { slug: osSlug },
          trait: { type: traitType, value: traitValue },
        },
      });
    } catch (err) {
      console.error("OpenSea criteria offer POST failed:", err.message);
      return { error: "post-failed", message: "OpenSea rejected the trait offer" };
    }

    return { success: true };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Offer cancelled by user" };
    }
    console.error("Create trait offer error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to create trait offer" };
  }
}

// ═══ FETCH MY OFFERS (outgoing bids) ═══
// Paginates through all pages using cursor to avoid truncation at 20 results.
const MAX_MY_PAGES = 10; // Safety cap: 10 pages * 50 = up to 500 orders

export async function fetchMyOffers(wallet, contract = CONTRACT) {
  try {
    const allOrders = [];
    let cursor = null;

    for (let page = 0; page < MAX_MY_PAGES; page++) {
      const params = {
        maker: wallet,
        asset_contract_address: contract,
        order_by: "created_date",
        order_direction: "desc",
        limit: 50,
      };
      if (cursor) params.cursor = cursor;

      const data = await openseaGet("orders/ethereum/seaport/offers", params);
      const orders = data.orders || [];
      allOrders.push(...orders);

      if (!data.next || orders.length === 0) break;
      cursor = data.next;
    }

    const now = Math.floor(Date.now() / 1000);
    return allOrders
      .filter(o => !o.cancelled && !o.finalized)
      .filter(o => {
        const endSec = parseInt(o.protocol_data?.parameters?.endTime);
        return !Number.isFinite(endSec) || endSec > now;
      })
      .map(normalizeOffer);
  } catch (err) {
    console.warn("Fetch my offers failed:", err.message);
    return [];
  }
}

// ═══ FETCH MY LISTINGS ═══
// Paginates through all pages using cursor to avoid truncation at 20 results.

export async function fetchMyListings(wallet, contract = CONTRACT) {
  try {
    const allOrders = [];
    let cursor = null;

    for (let page = 0; page < MAX_MY_PAGES; page++) {
      const params = {
        maker: wallet,
        asset_contract_address: contract,
        order_by: "created_date",
        order_direction: "desc",
        limit: 50,
      };
      if (cursor) params.cursor = cursor;

      const data = await openseaGet("orders/ethereum/seaport/listings", params);
      const orders = data.orders || [];
      allOrders.push(...orders);

      if (!data.next || orders.length === 0) break;
      cursor = data.next;
    }

    const now = Math.floor(Date.now() / 1000);
    return allOrders
      .filter(o => !o.cancelled && !o.finalized)
      .filter(o => {
        const endSec = parseInt(o.protocol_data?.parameters?.endTime);
        return !Number.isFinite(endSec) || endSec > now;
      })
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
  } catch (err) {
    console.warn("Fetch my listings failed:", err.message);
    return [];
  }
}

// ═══ CANCEL ORDER (listings or bids) ═══

export async function cancelOrder(order) {
  const provider = getProvider();
  if (!provider) return { error: "no-wallet" };

  try {
    const { ethers } = await import("ethers");
    const browserProvider = new ethers.BrowserProvider(provider);
    // AUDIT FIX M-8: refuse cancel on the wrong chain.
    const _chainErr = await assertOnExpectedChain(browserProvider);
    if (_chainErr) return _chainErr;
    const signer = await browserProvider.getSigner();

    const params = order.rawOrder?.protocol_data?.parameters || order.protocol_data?.parameters;
    if (!params) return { error: "failed", message: "Missing order parameters" };

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
    const orderProtocolAddress =
      order.rawOrder?.protocol_address || order.protocol_address || order.protocolAddress || null;
    const tx = await cancelSeaportOrder({ ethers, signer, params, seaportAddress: orderProtocolAddress });
    await tx.wait();
    return { success: true, hash: tx.hash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Transaction cancelled" };
    }
    console.error("Cancel order error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to cancel order" };
  }
}

// ═══ ACCEPT OFFER (for token owners) ═══

export async function acceptOffer(offer) {
  const provider = getProvider();
  if (!provider) return { error: "no-wallet" };

  try {
    const { ethers } = await import("ethers");
    const browserProvider = new ethers.BrowserProvider(provider);
    // AUDIT FIX D-FE-M1: chain-guard BEFORE any tx hits the wallet. Pre-fix,
    // a seller on the wrong chain (Sepolia / Base / etc.) would still proceed
    // through setApprovalForAll on a phantom Conduit address — burning gas
    // AND leaving a setApprovalForAll(true) on whatever contract collides
    // with CONDUIT_ADDRESS on that chain. Mirrors createItemOffer / cancelOrder
    // which already gate on assertOnExpectedChain.
    const _chainErr = await assertOnExpectedChain(browserProvider);
    if (_chainErr) return _chainErr;
    const signer = await browserProvider.getSigner();
    const sellerAddress = await signer.getAddress();

    // Check NFT approval for conduit (required to transfer the NFT to the buyer)
    const nftContract = offer.tokenContract || CONTRACT;
    const erc721ABI = [
      "function isApprovedForAll(address,address) view returns (bool)",
      "function setApprovalForAll(address,bool)",
    ];
    const nft = new ethers.Contract(nftContract, erc721ABI, signer);
    const isApproved = await nft.isApprovedForAll(sellerAddress, CONDUIT_ADDRESS);
    if (!isApproved) {
      const approveTx = await nft.setApprovalForAll(CONDUIT_ADDRESS, true);
      await approveTx.wait();
    }

    // Get fulfillment data from OpenSea — via proxy
    let data;
    try {
      data = await openseaPost("offers/fulfillment_data", {
        offer: {
          hash: offer.orderHash,
          chain: "ethereum",
          protocol_address: offer.protocolAddress || SEAPORT_ADDRESS,
        },
        fulfiller: { address: sellerAddress },
      });
    } catch {
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

    const tx = await signer.sendTransaction({
      to: txData.to,
      value: BigInt(txData.value || 0),
      data: encoded,
    });

    // Wait for on-chain confirmation before reporting success
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      return { error: "failed", message: "Transaction reverted on-chain" };
    }

    return { success: true, hash: tx.hash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Transaction cancelled" };
    }
    console.error("Accept offer error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to accept offer" };
  }
}
