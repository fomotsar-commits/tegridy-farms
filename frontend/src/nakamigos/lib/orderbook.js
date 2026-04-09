/**
 * Native Orderbook Client SDK — interact with our own order storage.
 * Creates Seaport-compatible signed orders at 0.5% fee (vs OpenSea's 2.5%).
 * Pattern from Blur's native orderbook and Reservoir's open protocol.
 *
 * Orders are standard Seaport v1.5 orders that can be fulfilled by
 * calling Seaport.fulfillOrder() directly — no marketplace dependency.
 */

import { SEAPORT_ADDRESS, SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, CONDUIT_KEY, CONDUIT_ADDRESS, PLATFORM_FEE_RECIPIENT, PLATFORM_FEE_BPS } from "../constants";
import { getProvider } from "../api";

const ORDERBOOK_API = "/api/orderbook";

// ═══ FETCH NATIVE LISTINGS ═══
// Query active native listings for a given contract address.

export async function fetchNativeListings(contract, { sort = "price_eth", limit = 50 } = {}) {
  if (!contract) return { orders: [], count: 0 };
  const params = new URLSearchParams({
    action: "query",
    contract,
    sort,
    limit: String(limit),
    status: "active",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${ORDERBOOK_API}?${params}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { orders: [], count: 0, error: err.error || "Failed to fetch" };
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") return { orders: [], count: 0, error: "Request timed out" };
    return { orders: [], count: 0, error: e.message };
  }
}

// ═══ FULFILL NATIVE ORDER ═══
// Buy an NFT from a native orderbook listing by calling Seaport directly.
// The order was signed with EIP-712 for Seaport v1.5, so we can fulfillOrder on-chain.

export async function fulfillNativeOrder(order) {
  const ethProvider = getProvider();
  if (!ethProvider) return { error: "no-wallet", message: "No wallet found" };

  try {
    const { ethers } = await import("ethers");
    const provider = new ethers.BrowserProvider(ethProvider);
    const signer = await provider.getSigner();
    const buyerAddress = await signer.getAddress();

    // Reconstruct the Seaport order from stored parameters + signature
    const params = order.parameters;
    if (!params || !order.signature) {
      return { error: "invalid-order", message: "Order missing parameters or signature" };
    }

    // Calculate total payment (sum of all consideration amounts)
    const totalWei = params.consideration.reduce(
      (sum, item) => sum + BigInt(item.startAmount || "0"),
      0n
    );

    // Build the Seaport fulfillOrder calldata
    const seaportAbi = [
      "function fulfillOrder((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)",
    ];
    const seaport = new ethers.Contract(
      order.protocol_address || SEAPORT_ADDRESS,
      seaportAbi,
      signer
    );

    const orderStruct = {
      offerer: params.offerer,
      zone: params.zone || "0x0000000000000000000000000000000000000000",
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
      endTime: BigInt(params.endTime),
      zoneHash: params.zoneHash || "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: BigInt(params.salt || "0"),
      conduitKey: params.conduitKey || CONDUIT_KEY,
      totalOriginalConsiderationItems: params.totalOriginalConsiderationItems || params.consideration.length,
    };

    // Send the fulfillOrder transaction
    const tx = await seaport.fulfillOrder(
      orderStruct,
      "0x0000000000000000000000000000000000000000000000000000000000000000", // no conduit for buyer
      { value: totalWei }
    );

    const receipt = await tx.wait();

    // Mark order as filled in our backend
    const fillMessage = `Fill order ${order.order_hash} tx ${tx.hash}`;
    const fillSignature = await signer.signMessage(fillMessage);

    const fillController = new AbortController();
    const fillTimeout = setTimeout(() => fillController.abort(), 30000);
    try {
      await fetch(ORDERBOOK_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: fillController.signal,
        body: JSON.stringify({
          action: "fill",
          orderHash: order.order_hash,
          txHash: tx.hash,
          signature: fillSignature,
        }),
      });
      clearTimeout(fillTimeout);
    } catch {
      clearTimeout(fillTimeout);
      // Non-critical: on-chain fill succeeded even if backend update fails
      console.warn("Failed to update orderbook backend after fill, tx:", tx.hash);
    }

    return { success: true, hash: tx.hash, tx, receipt };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Transaction cancelled by user" };
    }
    if (err.message?.includes("insufficient funds")) {
      return { error: "insufficient", message: "Insufficient ETH balance" };
    }
    console.error("Native order fulfillment error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Transaction failed" };
  }
}

// ═══ CREATE NATIVE LISTING ═══
// List an NFT on our orderbook at 0.5% fee (vs OpenSea 2.5%)

export async function createNativeListing({ contract, tokenId, priceEth, expirationHours = 168 }) {
  const ethProvider = getProvider();
  if (!ethProvider) return { error: "no-wallet", message: "No wallet found" };

  try {
    const { ethers } = await import("ethers");
    const provider = new ethers.BrowserProvider(ethProvider);
    const signer = await provider.getSigner();
    const sellerAddress = await signer.getAddress();

    // Check NFT approval for Seaport conduit (battle-tested pattern from OpenSea/Blur)
    const nftContract = new ethers.Contract(contract, [
      "function isApprovedForAll(address,address) view returns (bool)",
      "function setApprovalForAll(address,bool)",
    ], signer);

    const isApproved = await nftContract.isApprovedForAll(sellerAddress, CONDUIT_ADDRESS);
    if (!isApproved) {
      const approveTx = await nftContract.setApprovalForAll(CONDUIT_ADDRESS, true);
      await approveTx.wait();
    }

    const priceWei = ethers.parseEther(String(priceEth));
    const now = Math.floor(Date.now() / 1000);
    const endTime = now + expirationHours * 3600;

    // Platform fee: 0.5% of price
    const platformFee = (priceWei * BigInt(PLATFORM_FEE_BPS)) / 10000n;
    const sellerReceives = priceWei - platformFee;

    const orderParameters = {
      offerer: sellerAddress,
      zone: "0x0000000000000000000000000000000000000000", // No zone initially — add after audit
      offer: [{
        itemType: 2, // ERC721
        token: contract,
        identifierOrCriteria: String(tokenId),
        startAmount: "1",
        endAmount: "1",
      }],
      consideration: [
        {
          itemType: 0, // NATIVE ETH
          token: "0x0000000000000000000000000000000000000000",
          identifierOrCriteria: "0",
          startAmount: sellerReceives.toString(),
          endAmount: sellerReceives.toString(),
          recipient: sellerAddress,
        },
        {
          itemType: 0,
          token: "0x0000000000000000000000000000000000000000",
          identifierOrCriteria: "0",
          startAmount: platformFee.toString(),
          endAmount: platformFee.toString(),
          recipient: PLATFORM_FEE_RECIPIENT,
        },
      ],
      orderType: 0, // FULL_OPEN
      startTime: String(now),
      endTime: String(endTime),
      zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: ethers.hexlify(ethers.randomBytes(32)),
      conduitKey: CONDUIT_KEY,
      totalOriginalConsiderationItems: 2,
    };

    // Get counter from Seaport
    const seaport = new ethers.Contract(SEAPORT_ADDRESS, [
      "function getCounter(address) view returns (uint256)",
    ], provider);
    const counter = await seaport.getCounter(sellerAddress);

    // Sign EIP-712 (Seaport order signature for on-chain fulfillment)
    const signData = { ...orderParameters, counter: counter.toString() };
    const seaportSignature = await signer.signTypedData(SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, signData);

    // Sign auth message to prove wallet ownership to the orderbook API.
    // MUST match the server-side verification message in api/orderbook.js exactly.
    // NOTE: The server extracts priceWei from consideration[0].startAmount, which
    // is sellerReceives (price minus platform fee), not the gross priceWei.
    const authMessage = `Create order for ${sellerAddress.toLowerCase()} | Contract: ${contract.toLowerCase()} | Price: ${sellerReceives.toString()} | StartTime: ${now} | EndTime: ${endTime}`;
    const authSignature = await signer.signMessage(authMessage);

    // Submit to our orderbook
    const createController = new AbortController();
    const createTimeout = setTimeout(() => createController.abort(), 30000);
    let res;
    try {
      res = await fetch(ORDERBOOK_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: createController.signal,
        body: JSON.stringify({
          action: "create",
          order: {
            parameters: orderParameters,
            signature: authSignature,
            seaportSignature,
            protocol_address: SEAPORT_ADDRESS,
          },
        }),
      });
      clearTimeout(createTimeout);
    } catch (fetchErr) {
      clearTimeout(createTimeout);
      if (fetchErr.name === "AbortError") return { error: "timeout", message: "Order submission timed out" };
      throw fetchErr;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { error: "post-failed", message: err.error || "Failed to submit order" };
    }

    let result;
    try { result = await res.json(); } catch { return { error: "post-failed", message: "Invalid response from orderbook" }; }
    return { success: true, orderHash: result.orderHash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Listing cancelled by user" };
    }
    console.error("Native listing error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to create listing" };
  }
}
