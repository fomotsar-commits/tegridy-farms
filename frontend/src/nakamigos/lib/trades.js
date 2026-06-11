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
 * EIP-5792 atomic batch: approvals + fulfill in ONE wallet confirmation.
 * Production-real in MetaMask (user-consented EIP-7702 smart-account
 * upgrade) and other 5792 wallets; returns null when unsupported so the
 * caller falls back to the sequential path. Rethrows user rejection (4001)
 * so the fallback doesn't re-prompt someone who just said no.
 *
 * @param {object} provider ethers BrowserProvider
 * @param {string} from
 * @param {Array<{to:string,data:string,value?:string}>} calls
 * @returns {Promise<{hash:string|null}|null>}
 */
async function tryAtomicBatch(provider, from, calls) {
  let supported = false;
  try {
    const caps = await provider.send("wallet_getCapabilities", [from, ["0x1"]]);
    const atomic = caps?.["0x1"]?.atomic?.status;
    supported = atomic === "supported" || atomic === "ready";
  } catch {
    return null; // wallet doesn't speak 5792 at all
  }
  if (!supported) return null;

  let id;
  try {
    const ret = await provider.send("wallet_sendCalls", [{
      version: "2.0.0",
      chainId: "0x1",
      from,
      atomicRequired: true,
      calls,
    }]);
    id = typeof ret === "string" ? ret : ret?.id;
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED" || err?.error?.code === 4001) {
      throw Object.assign(new Error("Batch cancelled by user"), { code: "rejected" });
    }
    return null; // capability advertised but call failed — use fallback
  }
  if (!id) return null;

  // Poll for confirmation (~3 min ceiling). 200 = confirmed per EIP-5792.
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    let st;
    try {
      st = await provider.send("wallet_getCallsStatus", [id]);
    } catch { continue; }
    const code = typeof st?.status === "number" ? st.status : null;
    if (code === 200) {
      const receipts = st.receipts || [];
      const failed = receipts.some(r => r && (r.status === "0x0" || r.status === 0));
      if (failed) throw Object.assign(new Error("Batch reverted on-chain"), { code: "reverted" });
      return { hash: receipts.length ? receipts[receipts.length - 1].transactionHash : null };
    }
    if (code != null && code >= 400) {
      throw Object.assign(new Error("Batch failed in wallet"), { code: "reverted" });
    }
  }
  throw Object.assign(new Error("Batch confirmation timed out"), { code: "timeout" });
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

  // A `get` entry with `any: true` is a WILDCARD slot — Seaport criteria item
  // (itemType 4) with identifierOrCriteria 0 = "any token from this
  // collection". The acceptor picks the concrete token at fulfillment via a
  // CriteriaResolver with an empty proof (same mechanism OpenSea collection
  // offers settle with). Mixed wildcard+specific is allowed by the protocol;
  // the trade-board flow uses all-wildcard considerations.
  const consideration = get.map(({ contract, tokenId, any }) => ({
    itemType: any ? 4 : 2, // ERC721_WITH_CRITERIA : ERC721
    token: contract,
    identifierOrCriteria: any ? "0" : String(tokenId),
    startAmount: "1",
    endAmount: "1",
    recipient: maker, // every leg pays the maker; specific items also ownership-gate the taker
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
export async function createTradeOffer({ give, get, taker, wethTopupEth = "0", ethTopupEth = "0", expirationHours = 72, counterOf = null, open = false }) {
  const ctx = await getMainnetSigner();
  if (ctx.error) return ctx;
  const { ethers, provider, signer, address: maker } = ctx;

  try {
    if (open) {
      // Trade-board post: no taker; v1 requires every requested slot to be a
      // wildcard ("any token from collection") so there's no specific-token
      // owner to pin or verify.
      if (!Array.isArray(get) || !get.every((g) => g.any)) {
        return { error: "invalid-open", message: "Open trades request collections, not specific tokens" };
      }
    } else {
      if (!taker || typeof taker !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(taker)) {
        return { error: "invalid-taker", message: "Counterparty wallet address is invalid" };
      }
      if (taker.toLowerCase() === maker) {
        return { error: "self-trade", message: "You cannot send a trade to yourself" };
      }
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

    const takerTag = open ? "open" : taker.toLowerCase();
    const authMessage = `Create trade for ${maker} | Taker: ${takerTag} | Hash: ${seaportOrderHash} | StartTime: ${now} | EndTime: ${endTime}`;
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
        taker: open ? null : taker.toLowerCase(),
        open: !!open,
        counterOf: open ? null : counterOf,
      },
    });
    return { success: true, trade: data.trade };
  } catch (err) {
    console.error("Create trade error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to create trade" };
  }
}

/** Executed-trade feed for one collection (public). Mapped for the activity surface. */
export async function fetchTradeFeed(contract) {
  try {
    const res = await fetch(`/api/orderbook?action=trade-query&role=feed&contract=${contract}&limit=25`);
    if (!res.ok) return [];
    const { trades } = await res.json();
    return (trades || []).map((t) => {
      const firstOffered = (t.offered || [])[0];
      const firstRequested = (t.requested || [])[0];
      const label = `#${firstOffered?.tokenId ?? "?"} ⇄ ${firstRequested?.any ? "any" : `#${firstRequested?.tokenId ?? "?"}`}${(t.offered || []).length + (t.requested || []).length > 2 ? " +" : ""}`;
      let priceEth = null;
      try {
        const wei = BigInt(t.eth_topup_wei || "0") + BigInt(t.weth_topup_wei || "0");
        priceEth = wei > 0n ? Number(wei / 10n ** 12n) / 1e6 : null;
      } catch { /* malformed */ }
      return {
        type: "trade",
        token: { id: firstOffered?.tokenId ?? "", name: label },
        price: priceEth,
        from: t.offerer ? `${t.offerer.slice(0, 6)}...${t.offerer.slice(-4)}` : null,
        fromFull: t.offerer || null,
        to: t.target_owner ? `${t.target_owner.slice(0, 6)}...${t.target_owner.slice(-4)}` : "board",
        toFull: t.target_owner || null,
        time: new Date(t.updated_at || t.created_at).getTime(),
        marketplace: "p2p",
        hash: t.accepted_tx || null,
      };
    });
  } catch {
    return [];
  }
}

/** Query trades. role: "incoming" (taker) | "outgoing" (maker) | "board" (public open trades — no wallet needed). */
export async function fetchTrades({ wallet, role = "incoming", status = "active" }) {
  if (!wallet && role !== "board") return { trades: [] };
  const params = new URLSearchParams({
    action: "trade-query",
    ...(wallet ? { wallet: wallet.toLowerCase() } : {}),
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

    // Taker's NFTs that leave their wallet (every consideration ERC721)
    const takerItems = params.consideration
      .filter(i => Number(i.itemType) === 2)
      .map(i => ({ contract: i.token, tokenId: i.identifierOrCriteria }));

    // Which collections still need conduit approval (read-only checks)
    const approvalAbi = [
      "function isApprovedForAll(address,address) view returns (bool)",
      "function setApprovalForAll(address,bool)",
    ];
    const missingApprovals = [];
    for (const contract of [...new Set(takerItems.map(i => i.contract.toLowerCase()))]) {
      const nft = new ethers.Contract(contract, approvalAbi, provider);
      const ok = await nft.isApprovedForAll(takerAddress, CONDUIT_ADDRESS).catch(() => false);
      if (!ok) missingApprovals.push(contract);
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

    // ── Execution ──
    // Preferred: ONE confirmation via EIP-5792 atomic batch (approvals +
    // fulfill). Falls back to the classic sequential path when the wallet
    // doesn't support it (or no approvals are missing — then it's a single
    // tx either way).
    let txHash = null;
    let batchDone = false;
    if (missingApprovals.length > 0) {
      const approvalIface = new ethers.Interface(approvalAbi);
      const fulfillData = seaport.interface.encodeFunctionData("fulfillOrder", [
        { parameters: orderStruct, signature: trade.signature },
        CONDUIT_KEY,
      ]);
      const calls = [
        ...missingApprovals.map(contract => ({
          to: contract,
          data: approvalIface.encodeFunctionData("setApprovalForAll", [CONDUIT_ADDRESS, true]),
        })),
        {
          to: trade.protocol_address || SEAPORT_ADDRESS,
          data: fulfillData,
          ...(totalWei > 0n ? { value: "0x" + totalWei.toString(16) } : {}),
        },
      ];
      try {
        const batched = await tryAtomicBatch(provider, takerAddress, calls);
        if (batched) { batchDone = true; txHash = batched.hash; }
      } catch (err) {
        if (err.code === "rejected") return { error: "rejected", message: "Trade cancelled by user" };
        if (err.code === "reverted") return { error: "reverted", message: "Trade batch reverted on-chain" };
        if (err.code === "timeout") return { error: "timeout", message: "Wallet did not confirm the batch — check your wallet activity" };
        throw err;
      }
    }

    if (!batchDone) {
      // Sequential path: approve missing collections, then fulfill.
      try {
        await ensureCollectionApprovals(ethers, signer, takerAddress, takerItems);
      } catch (err) {
        if (err.code === 4001 || err.code === "ACTION_REJECTED") return { error: "rejected", message: "Approval cancelled" };
        return { error: "approval-failed", message: err.message };
      }
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
      txHash = tx.hash;
    }

    // Notify backend (retried, same signature — no extra wallet prompt).
    // The batch path's last receipt IS the atomic tx containing the
    // OrderFulfilled event, so the server-side receipt check holds.
    if (txHash) {
      const ts = Math.floor(Date.now() / 1000);
      const fillMessage = `Fill trade ${trade.id} tx ${txHash} | Chain: 1 | Time: ${ts}`;
      const fillSignature = await signer.signMessage(fillMessage);
      try {
        await postOrderbook({
          action: "trade-fill",
          tradeId: trade.id,
          txHash,
          signature: fillSignature,
          timestamp: ts,
        });
      } catch {
        console.warn("Trade fill notify failed; on-chain trade succeeded:", txHash);
      }
    }

    return { success: true, hash: txHash };
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

/**
 * Pure builder for the Seaport CriteriaResolvers of an open trade. Exported
 * for unit tests. `selections` maps consideration INDEX → chosen tokenId.
 * Every itemType-4 (wildcard) slot needs exactly one selection; the empty
 * criteriaProof is the protocol's "criteria root 0 = any token" form — the
 * same mechanism collection offers settle with.
 *
 * @returns {Array<{orderIndex:number, side:number, index:number, identifier:string, criteriaProof:string[]}>}
 */
export function buildCriteriaResolvers(parameters, selections = {}) {
  const resolvers = [];
  const usedTokens = new Set();
  (parameters.consideration || []).forEach((item, index) => {
    if (Number(item.itemType) !== 4) return;
    const chosen = selections[index];
    if (chosen == null || !/^\d{1,10}$/.test(String(chosen))) {
      throw new Error(`Slot ${index} needs a token selection`);
    }
    const key = `${(item.token || "").toLowerCase()}:${chosen}`;
    if (usedTokens.has(key)) {
      throw new Error(`Token #${chosen} selected for more than one slot`);
    }
    usedTokens.add(key);
    resolvers.push({
      orderIndex: 0,
      side: 1, // CONSIDERATION
      index,
      identifier: String(chosen),
      criteriaProof: [], // identifierOrCriteria 0 = wildcard → empty proof
    });
  });
  return resolvers;
}

/**
 * Accept an OPEN (trade-board) offer: the acceptor picks which of their own
 * tokens fill each wildcard slot, then fulfills via fulfillAdvancedOrder
 * with criteria resolvers. Same pre-flight battery and 5792 batch path as
 * acceptTrade.
 *
 * @param {object} trade       row from trade-query (parameters + signature)
 * @param {object} selections  consideration index → tokenId the acceptor gives
 */
export async function acceptOpenTrade(trade, selections) {
  const ctx = await getMainnetSigner();
  if (ctx.error) return ctx;
  const { ethers, provider, signer, address: acceptor } = ctx;

  try {
    const params = trade.parameters;
    if (!params || !trade.signature) {
      return { error: "invalid-trade", message: "Trade is missing its signed order" };
    }
    if (params.offerer?.toLowerCase() === acceptor) {
      return { error: "self-trade", message: "You posted this trade — cancel it instead" };
    }
    if (params.endTime && parseInt(params.endTime) * 1000 <= Date.now()) {
      return { error: "expired", message: "This trade offer has expired" };
    }

    let resolvers;
    try {
      resolvers = buildCriteriaResolvers(params, selections);
    } catch (err) {
      return { error: "invalid-selection", message: err.message };
    }
    if (resolvers.length === 0) {
      return { error: "invalid-trade", message: "This is not an open trade — accept it from your inbox" };
    }

    // Pre-flight 1: Seaport order status
    if (trade.seaport_order_hash) {
      try {
        const statusAbi = ["function getOrderStatus(bytes32) view returns (bool,bool,uint256,uint256)"];
        const seaportRead = new ethers.Contract(trade.protocol_address || SEAPORT_ADDRESS, statusAbi, provider);
        const [, isCancelled, totalFilled] = await seaportRead.getOrderStatus(trade.seaport_order_hash);
        if (isCancelled) return { error: "cancelled", message: "The maker cancelled this trade on-chain" };
        if (totalFilled > 0n) return { error: "filled", message: "Someone already accepted this trade" };
      } catch { /* best-effort */ }
    }

    const erc721Abi = ["function ownerOf(uint256) view returns (address)"];

    // Pre-flight 2: maker still owns every offered NFT
    for (const item of params.offer) {
      if (Number(item.itemType) !== 2) continue;
      try {
        const owner = await new ethers.Contract(item.token, erc721Abi, provider).ownerOf(item.identifierOrCriteria);
        if (owner.toLowerCase() !== params.offerer.toLowerCase()) {
          return { error: "stale", message: "The maker no longer owns their items — trade is stale" };
        }
      } catch {
        return { error: "stale", message: "Could not verify the maker still owns their items" };
      }
    }

    // Pre-flight 3: the acceptor owns every selected token
    const givingItems = [];
    for (const r of resolvers) {
      const slot = params.consideration[r.index];
      try {
        const owner = await new ethers.Contract(slot.token, erc721Abi, provider).ownerOf(r.identifier);
        if (owner.toLowerCase() !== acceptor) {
          return { error: "not-owner", message: `You don't own #${r.identifier} in that collection` };
        }
      } catch {
        return { error: "not-owner", message: `Token #${r.identifier} could not be verified` };
      }
      givingItems.push({ contract: slot.token, tokenId: r.identifier });
    }

    // Approvals for the collections the acceptor's tokens leave from
    const approvalAbi = [
      "function isApprovedForAll(address,address) view returns (bool)",
      "function setApprovalForAll(address,bool)",
    ];
    const missingApprovals = [];
    for (const contract of [...new Set(givingItems.map(i => i.contract.toLowerCase()))]) {
      const nft = new ethers.Contract(contract, approvalAbi, provider);
      const ok = await nft.isApprovedForAll(acceptor, CONDUIT_ADDRESS).catch(() => false);
      if (!ok) missingApprovals.push(contract);
    }

    const totalWei = params.consideration.reduce(
      (sum, item) => Number(item.itemType) === 0 ? sum + BigInt(item.startAmount || "0") : sum,
      0n
    );

    const advancedAbi = [
      "function fulfillAdvancedOrder(((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, uint120 numerator, uint120 denominator, bytes signature, bytes extraData) advancedOrder, (uint256 orderIndex, uint8 side, uint256 index, uint256 identifier, bytes32[] criteriaProof)[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool fulfilled)",
    ];
    const seaport = new ethers.Contract(trade.protocol_address || SEAPORT_ADDRESS, advancedAbi, signer);

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
    const advancedOrder = {
      parameters: orderStruct,
      numerator: 1n,
      denominator: 1n,
      signature: trade.signature,
      extraData: "0x",
    };
    const resolverStructs = resolvers.map(r => ({
      orderIndex: BigInt(r.orderIndex),
      side: r.side,
      index: BigInt(r.index),
      identifier: BigInt(r.identifier),
      criteriaProof: r.criteriaProof,
    }));
    const fulfillArgs = [advancedOrder, resolverStructs, CONDUIT_KEY, ZERO /* recipient 0 = fulfiller */];

    let txHash = null;
    let batchDone = false;
    if (missingApprovals.length > 0) {
      const approvalIface = new ethers.Interface(approvalAbi);
      const calls = [
        ...missingApprovals.map(contract => ({
          to: contract,
          data: approvalIface.encodeFunctionData("setApprovalForAll", [CONDUIT_ADDRESS, true]),
        })),
        {
          to: trade.protocol_address || SEAPORT_ADDRESS,
          data: seaport.interface.encodeFunctionData("fulfillAdvancedOrder", fulfillArgs),
          ...(totalWei > 0n ? { value: "0x" + totalWei.toString(16) } : {}),
        },
      ];
      try {
        const batched = await tryAtomicBatch(provider, acceptor, calls);
        if (batched) { batchDone = true; txHash = batched.hash; }
      } catch (err) {
        if (err.code === "rejected") return { error: "rejected", message: "Trade cancelled by user" };
        if (err.code === "reverted") return { error: "reverted", message: "Trade batch reverted on-chain" };
        if (err.code === "timeout") return { error: "timeout", message: "Wallet did not confirm the batch — check your wallet activity" };
        throw err;
      }
    }

    if (!batchDone) {
      try {
        await ensureCollectionApprovals(ethers, signer, acceptor, givingItems);
      } catch (err) {
        if (err.code === 4001 || err.code === "ACTION_REJECTED") return { error: "rejected", message: "Approval cancelled" };
        return { error: "approval-failed", message: err.message };
      }
      const tx = await seaport.fulfillAdvancedOrder(...fulfillArgs, { value: totalWei });
      const receipt = await tx.wait();
      if (!receipt || receipt.status === 0) {
        return { error: "reverted", message: "Trade transaction reverted on-chain" };
      }
      txHash = tx.hash;
    }

    if (txHash) {
      const ts = Math.floor(Date.now() / 1000);
      const fillMessage = `Fill trade ${trade.id} tx ${txHash} | Chain: 1 | Time: ${ts}`;
      const fillSignature = await signer.signMessage(fillMessage);
      try {
        await postOrderbook({
          action: "trade-fill",
          tradeId: trade.id,
          txHash,
          signature: fillSignature,
          timestamp: ts,
        });
      } catch {
        console.warn("Trade fill notify failed; on-chain trade succeeded:", txHash);
      }
    }

    return { success: true, hash: txHash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Trade cancelled by user" };
    }
    if (err.message?.includes("insufficient funds")) {
      return { error: "insufficient", message: "Insufficient ETH for the trade payment" };
    }
    console.error("Accept open trade error:", err);
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
