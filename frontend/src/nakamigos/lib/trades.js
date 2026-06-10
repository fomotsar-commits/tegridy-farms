/**
 * P2P Trade SDK — Seaport-settled "trade window" swaps between two wallets.
 *
 * A trade is ONE signed Seaport order (no custom escrow contract — the only
 * on-chain surface is canonical Seaport + the OpenSea conduit; lesson from
 * the Dec-2023 NFT Trader approval exploit):
 *
 *   offer (maker gives):        their NFTs (itemType 2) + optional WETH
 *                               sweetener (itemType 1). Seaport cannot pull
 *                               native ETH from a maker, so the maker-side
 *                               cash leg MUST be WETH.
 *   consideration (maker gets): the requested NFTs, recipient = maker, plus
 *                               optional native ETH (itemType 0) from the
 *                               taker, recipient = maker, paid as msg.value.
 *
 * Counterparty restriction is OWNERSHIP-GATED: only the owner of every
 * requested NFT can fulfill. The named taker stored alongside the order is a
 * soft pin enforced by the API and UI (same semantics as OpenSea Deals).
 *
 * orderType is 0 (FULL_OPEN). 2 is FULL_RESTRICTED — with a zero zone such
 * orders revert at fulfillment (validateOrder staticcall to an empty address
 * cannot return the magic value).
 */

import { SEAPORT_ADDRESS, SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, CONDUIT_KEY, CONDUIT_ADDRESS, WETH } from "../constants";
import { getProvider } from "../api";
import { getWethBalance, getWethAllowance, approveWeth, wrapEth } from "./weth";

const ORDERBOOK_API = "/api/orderbook";
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

// Hard caps mirrored server-side: enough for real trades, small enough that
// the signed payload stays well under the API's 10KB body cap.
export const MAX_ITEMS_PER_SIDE = 6;

async function withRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function postOrderbook(body, timeoutMs = 30000) {
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(ORDERBOOK_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `Orderbook ${res.status}`);
        err.status = res.status;
        // 4xx are permanent — don't burn retries on them
        if (res.status >= 400 && res.status < 500) { err.permanent = true; }
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  });
}

async function getMainnetSigner() {
  const ethProvider = getProvider();
  if (!ethProvider) return { error: "no-wallet", message: "No wallet found" };
  const { ethers } = await import("ethers");
  const provider = new ethers.BrowserProvider(ethProvider);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== Number(SEAPORT_DOMAIN.chainId)) {
    return { error: "wrong-chain", message: "Switch to Ethereum Mainnet to trade" };
  }
  const signer = await provider.getSigner();
  return { ethers, provider, signer, address: (await signer.getAddress()).toLowerCase() };
}

// Approve every distinct collection in `items` for the Seaport conduit.
// Same check-then-set-then-reverify pattern as createNativeListing.
async function ensureCollectionApprovals(ethers, signer, owner, items) {
  const contracts = [...new Set(items.map(i => i.contract.toLowerCase()))];
  for (const contract of contracts) {
    const nft = new ethers.Contract(contract, [
      "function isApprovedForAll(address,address) view returns (bool)",
      "function setApprovalForAll(address,bool)",
    ], signer);
    const approved = await nft.isApprovedForAll(owner, CONDUIT_ADDRESS);
    if (approved) continue;
    const tx = await nft.setApprovalForAll(CONDUIT_ADDRESS, true);
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      throw Object.assign(new Error("Collection approval reverted"), { code: "approval-failed" });
    }
    const stillApproved = await nft.isApprovedForAll(owner, CONDUIT_ADDRESS);
    if (!stillApproved) {
      throw Object.assign(new Error("Collection approval did not take effect"), { code: "approval-failed" });
    }
  }
}

/**
 * Pure builder for the Seaport OrderParameters of a trade. Exported for unit
 * tests — no wallet, no network.
 *
 * @param {object} p
 * @param {string} p.maker      lowercase maker address
 * @param {Array<{contract:string,tokenId:string}>} p.give  maker's NFTs
 * @param {Array<{contract:string,tokenId:string}>} p.get   requested NFTs
 * @param {string} p.wethTopupWei  maker WETH sweetener ("0" for none)
 * @param {string} p.ethTopupWei   taker native ETH to maker ("0" for none)
 * @param {number} p.startTime  unix seconds
 * @param {number} p.endTime    unix seconds
 * @param {string} p.salt       0x-prefixed 32-byte hex
 */
export function buildTradeOrderParameters({ maker, give, get, wethTopupWei = "0", ethTopupWei = "0", startTime, endTime, salt }) {
  if (!Array.isArray(give) || give.length === 0) throw new Error("Trade must give at least one NFT");
  if (!Array.isArray(get) || get.length === 0) throw new Error("Trade must request at least one NFT");
  if (give.length > MAX_ITEMS_PER_SIDE || get.length > MAX_ITEMS_PER_SIDE) {
    throw new Error(`Max ${MAX_ITEMS_PER_SIDE} NFTs per side`);
  }

  const offer = give.map(({ contract, tokenId }) => ({
    itemType: 2, // ERC721
    token: contract,
    identifierOrCriteria: String(tokenId),
    startAmount: "1",
    endAmount: "1",
  }));
  if (BigInt(wethTopupWei) > 0n) {
    offer.push({
      itemType: 1, // ERC20 — maker-side cash must be WETH (Seaport can't pull native ETH)
      token: WETH,
      identifierOrCriteria: "0",
      startAmount: String(wethTopupWei),
      endAmount: String(wethTopupWei),
    });
  }

  const consideration = get.map(({ contract, tokenId }) => ({
    itemType: 2,
    token: contract,
    identifierOrCriteria: String(tokenId),
    startAmount: "1",
    endAmount: "1",
    recipient: maker, // ownership-gating: only the owner of these exact NFTs can fulfill
  }));
  if (BigInt(ethTopupWei) > 0n) {
    consideration.push({
      itemType: 0, // native ETH from the taker, supplied as msg.value
      token: ZERO,
      identifierOrCriteria: "0",
      startAmount: String(ethTopupWei),
      endAmount: String(ethTopupWei),
      recipient: maker,
    });
  }

  return {
    offerer: maker,
    zone: ZERO,
    offer,
    consideration,
    orderType: 0, // FULL_OPEN — see header note; restricted + zero zone is unfulfillable
    startTime: String(startTime),
    endTime: String(endTime),
    zoneHash: ZERO_HASH,
    salt,
    conduitKey: CONDUIT_KEY,
    totalOriginalConsiderationItems: consideration.length,
  };
}

/**
 * Build, sign, and submit a trade offer.
 * @returns {Promise<{success?:true, trade?:object, error?:string, message?:string}>}
 */
export async function createTradeOffer({ give, get, taker, wethTopupEth = "0", ethTopupEth = "0", expirationHours = 72, counterOf = null }) {
  const ctx = await getMainnetSigner();
  if (ctx.error) return ctx;
  const { ethers, provider, signer, address: maker } = ctx;

  try {
    if (!taker || typeof taker !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(taker)) {
      return { error: "invalid-taker", message: "Counterparty wallet address is invalid" };
    }
    if (taker.toLowerCase() === maker) {
      return { error: "self-trade", message: "You cannot send a trade to yourself" };
    }

    const wethTopupWei = ethers.parseEther(String(wethTopupEth || "0")).toString();
    const ethTopupWei = ethers.parseEther(String(ethTopupEth || "0")).toString();

    // Maker-side WETH sweetener: wrap + approve up front so fulfillment can't
    // fail on allowance. Typed errors per leg (same UX rule as createItemOffer).
    if (BigInt(wethTopupWei) > 0n) {
      const bal = await getWethBalance(maker);
      if (bal < BigInt(wethTopupWei)) {
        const needed = BigInt(wethTopupWei) - bal;
        try {
          await wrapEth(needed);
        } catch (err) {
          if (err.code === 4001 || err.code === "ACTION_REJECTED") return { error: "rejected", message: "ETH wrap cancelled" };
          return { error: "wrap-failed", message: `Wrapping ETH for the sweetener failed: ${err.shortMessage || err.message}` };
        }
      }
      const allowance = await getWethAllowance(maker);
      if (allowance < BigInt(wethTopupWei)) {
        try {
          await approveWeth(BigInt(wethTopupWei));
        } catch (err) {
          if (err.code === 4001 || err.code === "ACTION_REJECTED") return { error: "rejected", message: "WETH approval cancelled" };
          return { error: "approve-failed", message: `WETH approval failed: ${err.shortMessage || err.message}` };
        }
      }
    }

    try {
      await ensureCollectionApprovals(ethers, signer, maker, give);
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") return { error: "rejected", message: "Approval cancelled" };
      return { error: "approval-failed", message: err.message };
    }

    const now = Math.floor(Date.now() / 1000);
    const endTime = now + expirationHours * 3600;
    const parameters = buildTradeOrderParameters({
      maker, give, get, wethTopupWei, ethTopupWei,
      startTime: now, endTime,
      salt: ethers.hexlify(ethers.randomBytes(32)),
    });

    const seaport = new ethers.Contract(SEAPORT_ADDRESS, [
      "function getCounter(address) view returns (uint256)",
    ], provider);
    const counter = await seaport.getCounter(maker);

    const signData = { ...parameters, counter: counter.toString() };
    let seaportSignature;
    try {
      seaportSignature = await signer.signTypedData(SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, signData);
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") return { error: "rejected", message: "Trade signature cancelled" };
      throw err;
    }

    // Canonical struct-hash (the OrderFulfilled event value) — same derivation
    // createNativeListing uses; binds the auth message to the exact order.
    const seaportOrderHash = ethers.TypedDataEncoder
      .from(SEAPORT_ORDER_TYPES)
      .hash(signData)
      .toLowerCase();

    const authMessage = `Create trade for ${maker} | Taker: ${taker.toLowerCase()} | Hash: ${seaportOrderHash} | StartTime: ${now} | EndTime: ${endTime}`;
    let authSignature;
    try {
      authSignature = await signer.signMessage(authMessage);
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") return { error: "rejected", message: "Authorization signature cancelled" };
      throw err;
    }

    const data = await postOrderbook({
      action: "trade-create",
      trade: {
        parameters,
        seaportSignature,
        authSignature,
        seaportOrderHash,
        seaportCounter: counter.toString(),
        taker: taker.toLowerCase(),
        counterOf,
      },
    });
    return { success: true, trade: data.trade };
  } catch (err) {
    console.error("Create trade error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to create trade" };
  }
}

/** Query trades for a wallet. role: "incoming" (taker) | "outgoing" (maker). */
export async function fetchTrades({ wallet, role = "incoming", status = "active" }) {
  if (!wallet) return { trades: [] };
  const params = new URLSearchParams({
    action: "trade-query",
    wallet: wallet.toLowerCase(),
    role,
    status,
  });
  try {
    const res = await fetch(`${ORDERBOOK_API}?${params}`);
    if (!res.ok) return { trades: [], error: `Query failed (${res.status})` };
    return await res.json();
  } catch (e) {
    return { trades: [], error: e.message };
  }
}

/**
 * Accept (fulfill) an incoming trade. Runs the full pre-flight battery:
 * chain guard, Seaport order status, and a LIVE ownership re-check of the
 * maker's offered NFTs so the taker fails fast on stale offers instead of
 * burning gas (just-in-time item swaps are the classic trade-window scam).
 */
export async function acceptTrade(trade) {
  const ctx = await getMainnetSigner();
  if (ctx.error) return ctx;
  const { ethers, provider, signer, address: takerAddress } = ctx;

  try {
    const params = trade.parameters;
    if (!params || !trade.signature) {
      return { error: "invalid-trade", message: "Trade is missing its signed order" };
    }
    if (trade.target_owner && trade.target_owner.toLowerCase() !== takerAddress) {
      return { error: "not-your-trade", message: "This trade was sent to a different wallet" };
    }
    if (params.endTime && parseInt(params.endTime) * 1000 <= Date.now()) {
      return { error: "expired", message: "This trade offer has expired" };
    }

    // Pre-flight 1: Seaport order status (cancelled / already filled)
    if (trade.seaport_order_hash) {
      try {
        const statusAbi = ["function getOrderStatus(bytes32) view returns (bool,bool,uint256,uint256)"];
        const seaportRead = new ethers.Contract(trade.protocol_address || SEAPORT_ADDRESS, statusAbi, provider);
        const [, isCancelled, totalFilled] = await seaportRead.getOrderStatus(trade.seaport_order_hash);
        if (isCancelled) return { error: "cancelled", message: "The maker cancelled this trade on-chain" };
        if (totalFilled > 0n) return { error: "filled", message: "This trade was already executed" };
      } catch { /* best-effort — Seaport enforces on-chain regardless */ }
    }

    // Pre-flight 2: maker still owns every offered NFT (live ownerOf reads)
    const erc721Abi = ["function ownerOf(uint256) view returns (address)"];
    for (const item of params.offer) {
      if (Number(item.itemType) !== 2) continue;
      try {
        const owner = await new ethers.Contract(item.token, erc721Abi, provider).ownerOf(item.identifierOrCriteria);
        if (owner.toLowerCase() !== params.offerer.toLowerCase()) {
          return { error: "stale", message: `The maker no longer owns ${item.token.slice(0, 8)}… #${item.identifierOrCriteria} — trade is stale` };
        }
      } catch {
        return { error: "stale", message: "Could not verify the maker still owns their items" };
      }
    }

    // Approvals for the taker's NFTs (every consideration ERC721 leaves the taker)
    const takerItems = params.consideration
      .filter(i => Number(i.itemType) === 2)
      .map(i => ({ contract: i.token, tokenId: i.identifierOrCriteria }));
    try {
      await ensureCollectionApprovals(ethers, signer, takerAddress, takerItems);
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") return { error: "rejected", message: "Approval cancelled" };
      return { error: "approval-failed", message: err.message };
    }

    // Native ETH the taker owes = sum of itemType 0 consideration
    const totalWei = params.consideration.reduce(
      (sum, item) => Number(item.itemType) === 0 ? sum + BigInt(item.startAmount || "0") : sum,
      0n
    );

    const seaportAbi = [
      "function fulfillOrder(((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)",
    ];
    const seaport = new ethers.Contract(trade.protocol_address || SEAPORT_ADDRESS, seaportAbi, signer);

    const orderStruct = {
      offerer: params.offerer,
      zone: params.zone || ZERO,
      offer: params.offer.map(item => ({
        itemType: item.itemType,
        token: item.token,
        identifierOrCriteria: BigInt(item.identifierOrCriteria || "0"),
        startAmount: BigInt(item.startAmount || "0"),
        endAmount: BigInt(item.endAmount || "0"),
      })),
      consideration: params.consideration.map(item => ({
        itemType: item.itemType,
        token: item.token,
        identifierOrCriteria: BigInt(item.identifierOrCriteria || "0"),
        startAmount: BigInt(item.startAmount || "0"),
        endAmount: BigInt(item.endAmount || "0"),
        recipient: item.recipient,
      })),
      orderType: params.orderType || 0,
      startTime: BigInt(params.startTime || "0"),
      endTime: BigInt(params.endTime || "0"),
      zoneHash: params.zoneHash || ZERO_HASH,
      salt: BigInt(params.salt || "0"),
      conduitKey: params.conduitKey || CONDUIT_KEY,
      totalOriginalConsiderationItems: params.totalOriginalConsiderationItems || params.consideration.length,
    };

    // The taker fulfills WITH the conduit key so their NFT transfers route
    // through the conduit they just approved.
    const tx = await seaport.fulfillOrder(
      { parameters: orderStruct, signature: trade.signature },
      CONDUIT_KEY,
      { value: totalWei }
    );
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      return { error: "reverted", message: "Trade transaction reverted on-chain" };
    }

    // Notify backend (retried, same signature — no extra wallet prompt)
    const ts = Math.floor(Date.now() / 1000);
    const fillMessage = `Fill trade ${trade.id} tx ${tx.hash} | Chain: 1 | Time: ${ts}`;
    const fillSignature = await signer.signMessage(fillMessage);
    try {
      await postOrderbook({
        action: "trade-fill",
        tradeId: trade.id,
        txHash: tx.hash,
        signature: fillSignature,
        timestamp: ts,
      });
    } catch {
      console.warn("Trade fill notify failed; on-chain trade succeeded:", tx.hash);
    }

    return { success: true, hash: tx.hash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Trade cancelled by user" };
    }
    if (err.message?.includes("insufficient funds")) {
      return { error: "insufficient", message: "Insufficient ETH for the trade payment" };
    }
    console.error("Accept trade error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Trade failed" };
  }
}

/** Decline (taker) or cancel (maker) a trade — signed, time-bound status update. */
export async function updateTradeStatus(trade, action /* "trade-decline" | "trade-cancel" */) {
  const ctx = await getMainnetSigner();
  if (ctx.error) return ctx;
  const { signer } = ctx;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const verb = action === "trade-decline" ? "Decline" : "Cancel";
    const message = `${verb} trade ${trade.id} | Chain: 1 | Time: ${ts}`;
    let signature;
    try {
      signature = await signer.signMessage(message);
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") return { error: "rejected", message: "Signature cancelled" };
      throw err;
    }
    await postOrderbook({ action, tradeId: trade.id, signature, timestamp: ts });
    return { success: true };
  } catch (err) {
    return { error: "failed", message: err.shortMessage || err.message || "Update failed" };
  }
}

/**
 * NOTE on maker cancellation: updateTradeStatus only flips the DB row. The
 * signed Seaport order itself stays valid until expiry — a maker who wants a
 * HARD cancel must also revoke on-chain (Seaport `cancel` or
 * `incrementCounter`). The UI offers this as "Cancel on-chain" for makers;
 * acceptTrade's DB check + the taker-side UI respect the soft cancel.
 */
export async function cancelTradeOnChain(trade) {
  const ctx = await getMainnetSigner();
  if (ctx.error) return ctx;
  const { ethers, signer, address } = ctx;
  try {
    if (trade.offerer && trade.offerer.toLowerCase() !== address) {
      return { error: "not-maker", message: "Only the trade creator can cancel on-chain" };
    }
    const params = trade.parameters;
    const seaport = new ethers.Contract(trade.protocol_address || SEAPORT_ADDRESS, [
      "function getCounter(address) view returns (uint256)",
      "function cancel((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter)[] orders) returns (bool)",
    ], signer);
    const counter = await seaport.getCounter(address);
    const components = {
      offerer: params.offerer,
      zone: params.zone || ZERO,
      offer: params.offer.map(i => ({ itemType: i.itemType, token: i.token, identifierOrCriteria: BigInt(i.identifierOrCriteria || "0"), startAmount: BigInt(i.startAmount || "0"), endAmount: BigInt(i.endAmount || "0") })),
      consideration: params.consideration.map(i => ({ itemType: i.itemType, token: i.token, identifierOrCriteria: BigInt(i.identifierOrCriteria || "0"), startAmount: BigInt(i.startAmount || "0"), endAmount: BigInt(i.endAmount || "0"), recipient: i.recipient })),
      orderType: params.orderType || 0,
      startTime: BigInt(params.startTime || "0"),
      endTime: BigInt(params.endTime || "0"),
      zoneHash: params.zoneHash || ZERO_HASH,
      salt: BigInt(params.salt || "0"),
      conduitKey: params.conduitKey || CONDUIT_KEY,
      counter,
    };
    const tx = await seaport.cancel([components]);
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) return { error: "reverted", message: "On-chain cancel reverted" };
    return { success: true, hash: tx.hash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") return { error: "rejected", message: "Cancel cancelled by user" };
    return { error: "failed", message: err.shortMessage || err.message || "On-chain cancel failed" };
  }
}
