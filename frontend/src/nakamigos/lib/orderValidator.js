/**
 * 3-Layer Order Validation System
 *
 * Layer 1: Free client-side checks (expiry, freshness)
 * Layer 2: Cheap RPC calls via ethers (order status, NFT ownership, approvals)
 * Layer 3: Definitive eth_call simulation (staticCall to simulate fulfillment)
 *
 * Main entry: validateOrderFillability(provider, order, fulfillerAddress)
 */

import { SEAPORT_ADDRESS, CONDUIT_ADDRESS } from "../constants";

// ═══ LAYER 1 — Free, client-side checks ═══

/**
 * Check if the order has expired by comparing endTime to now.
 * @param {object} order - listing object with orderData.parameters.endTime (unix seconds)
 * @returns {{ valid: boolean, reason?: string }}
 */
export function checkOrderExpiry(order) {
  const endTime = order?.orderData?.parameters?.endTime;
  if (!endTime) {
    // No endTime means the order might be perpetual or data is missing
    return { valid: true, warning: "No expiry data available" };
  }
  const endMs = parseInt(endTime, 10) * 1000;
  if (isNaN(endMs)) {
    return { valid: true, warning: "Could not parse expiry time" };
  }
  if (Date.now() > endMs) {
    return { valid: false, reason: "Order has expired" };
  }
  return { valid: true };
}

/**
 * Flag orders that may be stale (older than 7 days) or expiring soon (within 1 hour).
 * @param {object} order - listing object with orderData.parameters.startTime / endTime
 * @returns {{ fresh: boolean, hint?: string, severity: "green"|"yellow"|"red" }}
 */
export function getOrderFreshnessHint(order) {
  const params = order?.orderData?.parameters;
  if (!params) {
    return { fresh: true, severity: "yellow", hint: "Order data incomplete" };
  }

  const now = Date.now();
  const endTime = params.endTime ? parseInt(params.endTime, 10) * 1000 : null;
  const startTime = params.startTime ? parseInt(params.startTime, 10) * 1000 : null;

  // Check if expiring within 1 hour
  if (endTime && !isNaN(endTime)) {
    const timeLeft = endTime - now;
    if (timeLeft < 0) {
      return { fresh: false, severity: "red", hint: "Order has expired" };
    }
    if (timeLeft < 3600000) {
      const mins = Math.floor(timeLeft / 60000);
      return { fresh: false, severity: "yellow", hint: `Expires in ${mins} minute${mins !== 1 ? "s" : ""}` };
    }
  }

  // Check if older than 7 days
  if (startTime && !isNaN(startTime)) {
    const age = now - startTime;
    if (age > 7 * 24 * 3600000) {
      const days = Math.floor(age / (24 * 3600000));
      return { fresh: false, severity: "yellow", hint: `Listed ${days} day${days !== 1 ? "s" : ""} ago` };
    }
  }

  return { fresh: true, severity: "green" };
}

// ═══ LAYER 2 — Cheap RPC checks (batched) ═══

// Minimal ABIs for on-chain reads
const SEAPORT_ABI = [
  "function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)",
];

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
];

/**
 * Check on-chain order status via Seaport.getOrderStatus()
 * @param {object} ethersProvider - ethers.BrowserProvider instance
 * @param {string} orderHash - the order hash
 * @returns {{ valid: boolean, reason?: string, details?: object }}
 */
export async function checkOrderStatus(ethersProvider, orderHash) {
  if (!orderHash) {
    return { valid: false, reason: "No order hash available" };
  }
  try {
    const { ethers } = await import("ethers");
    const seaport = new ethers.Contract(SEAPORT_ADDRESS, SEAPORT_ABI, ethersProvider);
    const [isValidated, isCancelled, totalFilled, totalSize] = await seaport.getOrderStatus(orderHash);

    if (isCancelled) {
      return { valid: false, reason: "Order has been cancelled" };
    }
    if (totalSize > 0n && totalFilled >= totalSize) {
      return { valid: false, reason: "Order has already been filled" };
    }

    return { valid: true, details: { isValidated, isCancelled, totalFilled, totalSize } };
  } catch (err) {
    // RPC error -- don't block the purchase, just warn
    return { valid: true, warning: `Could not verify order status: ${err.message}` };
  }
}

/**
 * Check if the expected owner still owns the NFT.
 * @param {object} ethersProvider - ethers.BrowserProvider instance
 * @param {string} contractAddress - NFT contract address
 * @param {string} tokenId - token ID
 * @param {string} expectedOwner - expected current owner address
 * @returns {{ valid: boolean, reason?: string }}
 */
export async function checkNftOwnership(ethersProvider, contractAddress, tokenId, expectedOwner) {
  if (!contractAddress || !tokenId || !expectedOwner) {
    return { valid: true, warning: "Incomplete data for ownership check" };
  }
  try {
    const { ethers } = await import("ethers");
    const nftContract = new ethers.Contract(contractAddress, ERC721_ABI, ethersProvider);
    const currentOwner = await nftContract.ownerOf(tokenId);
    if (currentOwner.toLowerCase() !== expectedOwner.toLowerCase()) {
      return { valid: false, reason: "Seller no longer owns this NFT" };
    }
    return { valid: true };
  } catch (err) {
    return { valid: true, warning: `Could not verify NFT ownership: ${err.message}` };
  }
}

/**
 * Check if the seller has approved the Seaport conduit to transfer the NFT.
 * @param {object} ethersProvider - ethers.BrowserProvider instance
 * @param {string} contractAddress - NFT contract address
 * @param {string} tokenId - token ID (unused for isApprovedForAll, but kept for API symmetry)
 * @param {string} owner - the seller/owner address
 * @returns {{ valid: boolean, reason?: string }}
 */
export async function checkApproval(ethersProvider, contractAddress, tokenId, owner) {
  if (!contractAddress || !owner) {
    return { valid: true, warning: "Incomplete data for approval check" };
  }
  try {
    const { ethers } = await import("ethers");
    const nftContract = new ethers.Contract(contractAddress, ERC721_ABI, ethersProvider);
    const approved = await nftContract.isApprovedForAll(owner, CONDUIT_ADDRESS);
    if (!approved) {
      return { valid: false, reason: "Seller has revoked marketplace approval" };
    }
    return { valid: true };
  } catch (err) {
    return { valid: true, warning: `Could not verify approval: ${err.message}` };
  }
}

/**
 * Run all Layer 2 checks in parallel using Promise.all.
 * @param {object} ethersProvider - ethers.BrowserProvider instance
 * @param {object} order - listing object
 * @returns {{ valid: boolean, reason?: string, warnings: string[] }}
 */
export async function runLayer2Checks(ethersProvider, order) {
  const params = order?.orderData?.parameters;
  const contractAddress = params?.offer?.[0]?.token;
  const tokenId = params?.offer?.[0]?.identifierOrCriteria;
  const seller = params?.offerer;
  const orderHash = order?.orderHash;

  const checks = await Promise.all([
    checkOrderStatus(ethersProvider, orderHash),
    checkNftOwnership(ethersProvider, contractAddress, tokenId, seller),
    checkApproval(ethersProvider, contractAddress, tokenId, seller),
  ]);

  const warnings = [];
  for (const check of checks) {
    if (!check.valid) {
      return { valid: false, reason: check.reason, warnings };
    }
    if (check.warning) {
      warnings.push(check.warning);
    }
  }

  return { valid: true, warnings };
}

// ═══ LAYER 3 — Definitive eth_call simulation ═══

// Known revert reason patterns
const REVERT_PATTERNS = [
  { pattern: /InvalidTime/i, message: "Order timing is invalid (expired or not yet active)" },
  { pattern: /OrderIsCancelled/i, message: "This order has been cancelled" },
  { pattern: /OrderAlreadyFilled/i, message: "This order has already been filled" },
  { pattern: /InvalidConduit/i, message: "Invalid marketplace conduit" },
  { pattern: /MissingOriginalConsideration/i, message: "Order parameters were modified" },
  { pattern: /ConsiderationNotMet/i, message: "Payment requirements not met" },
  { pattern: /InsufficientEtherSupplied/i, message: "Not enough ETH sent" },
  { pattern: /EtherTransferGenericFailure/i, message: "ETH transfer to seller failed" },
  { pattern: /NoContract/i, message: "Target contract does not exist" },
  { pattern: /ERC721: caller is not token owner or approved/i, message: "Seller cannot transfer this NFT" },
  { pattern: /ERC721: invalid token ID/i, message: "Token does not exist" },
  { pattern: /insufficient funds/i, message: "Insufficient ETH balance" },
];

/**
 * Parse a revert reason string into a human-readable message.
 * @param {string} revertData - raw revert reason
 * @returns {string}
 */
function parseRevertReason(revertData) {
  const str = typeof revertData === "string" ? revertData : String(revertData);
  for (const { pattern, message } of REVERT_PATTERNS) {
    if (pattern.test(str)) return message;
  }
  // Try to extract a readable portion
  if (str.length > 200) return "Transaction would fail (unrecognized error)";
  return str || "Transaction would fail";
}

/**
 * Simulate the fulfillment transaction using staticCall.
 * This is the most definitive check -- it runs the exact transaction logic.
 * @param {object} ethersProvider - ethers.BrowserProvider instance
 * @param {object} order - listing object with orderData, orderHash, protocolAddress
 * @param {string} fulfillerAddress - the buyer's address
 * @returns {{ valid: boolean, reason?: string }}
 */
export async function simulateFulfillment(ethersProvider, order, fulfillerAddress) {
  if (!order?.orderData?.parameters || !fulfillerAddress) {
    return { valid: true, warning: "Incomplete data for simulation" };
  }

  try {
    const { ethers } = await import("ethers");

    // Build a minimal Seaport fulfillBasicOrder call
    // We reconstruct the order parameters for the simulation
    const params = order.orderData.parameters;
    const offer = params.offer?.[0];
    const consideration = params.consideration || [];

    if (!offer) {
      return { valid: false, reason: "Order has no offer items" };
    }

    // Calculate total ETH needed from consideration items
    const totalValue = consideration.reduce((sum, item) => {
      // itemType 0 = ETH/native
      if (String(item.itemType) === "0") {
        return sum + BigInt(item.startAmount || "0");
      }
      return sum;
    }, 0n);

    // Use the Seaport 1.5 fulfillOrder function signature
    const SEAPORT_FULFILL_ABI = [
      "function fulfillOrder((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)",
    ];

    const seaport = new ethers.Contract(
      order.protocolAddress || SEAPORT_ADDRESS,
      SEAPORT_FULFILL_ABI,
      ethersProvider
    );

    // Build the order tuple
    const orderTuple = [
      params.offerer,
      params.zone || ethers.ZeroAddress,
      (params.offer || []).map(item => [
        item.itemType,
        item.token,
        item.identifierOrCriteria,
        item.startAmount,
        item.endAmount,
      ]),
      (params.consideration || []).map(item => [
        item.itemType,
        item.token,
        item.identifierOrCriteria,
        item.startAmount,
        item.endAmount,
        item.recipient,
      ]),
      params.orderType,
      params.startTime,
      params.endTime,
      params.zoneHash || ethers.ZeroHash,
      params.salt,
      params.conduitKey || ethers.ZeroHash,
      params.totalOriginalConsiderationItems ?? consideration.length,
    ];

    // staticCall simulates without broadcasting
    await seaport.fulfillOrder.staticCall(
      orderTuple,
      ethers.ZeroHash, // fulfillerConduitKey (no conduit for buyer paying in ETH)
      { from: fulfillerAddress, value: totalValue }
    );

    return { valid: true };
  } catch (err) {
    // Extract revert reason
    const reason = err.reason || err.shortMessage || err.message || "";
    return { valid: false, reason: parseRevertReason(reason) };
  }
}

// ═══ MAIN ENTRY — 3-Layer Sequential Validation ═══

/**
 * Status values returned by validation:
 * - "green"  = all checks passed
 * - "yellow" = passed with warnings (stale, can't verify some checks)
 * - "red"    = definitively invalid (expired, cancelled, filled, etc.)
 */

/**
 * Validate whether an order can be filled. Runs layers sequentially,
 * short-circuiting on definitive failure.
 *
 * @param {object} ethersProvider - ethers.BrowserProvider instance (or null for Layer 1 only)
 * @param {object} order - listing object with orderData, orderHash, protocolAddress, price, etc.
 * @param {string} fulfillerAddress - the buyer's wallet address (or null for Layer 1 only)
 * @returns {{ status: "green"|"yellow"|"red", reason?: string, warnings: string[], layer: number }}
 */
export async function validateOrderFillability(ethersProvider, order, fulfillerAddress) {
  const warnings = [];

  // ── Layer 1: Free client-side checks ──
  const expiryCheck = checkOrderExpiry(order);
  if (!expiryCheck.valid) {
    return { status: "red", reason: expiryCheck.reason, warnings, layer: 1 };
  }
  if (expiryCheck.warning) warnings.push(expiryCheck.warning);

  const freshnessCheck = getOrderFreshnessHint(order);
  if (!freshnessCheck.fresh) {
    if (freshnessCheck.severity === "red") {
      return { status: "red", reason: freshnessCheck.hint, warnings, layer: 1 };
    }
    warnings.push(freshnessCheck.hint);
  }

  // If no provider, return Layer 1 results only
  if (!ethersProvider) {
    return {
      status: warnings.length > 0 ? "yellow" : "green",
      warnings,
      layer: 1,
    };
  }

  // ── Layer 2: RPC checks (batched) ──
  const layer2 = await runLayer2Checks(ethersProvider, order);
  if (!layer2.valid) {
    return { status: "red", reason: layer2.reason, warnings: [...warnings, ...layer2.warnings], layer: 2 };
  }
  warnings.push(...layer2.warnings);

  // If no fulfiller address, skip Layer 3
  if (!fulfillerAddress) {
    return {
      status: warnings.length > 0 ? "yellow" : "green",
      warnings,
      layer: 2,
    };
  }

  // ── Layer 3: Simulation ──
  const sim = await simulateFulfillment(ethersProvider, order, fulfillerAddress);
  if (!sim.valid) {
    return { status: "red", reason: sim.reason, warnings, layer: 3 };
  }
  if (sim.warning) warnings.push(sim.warning);

  return {
    status: warnings.length > 0 ? "yellow" : "green",
    warnings,
    layer: 3,
  };
}

/**
 * Quick Layer 1+2 validation (no simulation). Suitable for Modal pre-check.
 */
export async function validateOrderQuick(ethersProvider, order) {
  const warnings = [];

  const expiryCheck = checkOrderExpiry(order);
  if (!expiryCheck.valid) {
    return { status: "red", reason: expiryCheck.reason, warnings, layer: 1 };
  }
  if (expiryCheck.warning) warnings.push(expiryCheck.warning);

  const freshnessCheck = getOrderFreshnessHint(order);
  if (!freshnessCheck.fresh) {
    if (freshnessCheck.severity === "red") {
      return { status: "red", reason: freshnessCheck.hint, warnings, layer: 1 };
    }
    warnings.push(freshnessCheck.hint);
  }

  if (!ethersProvider) {
    return { status: warnings.length > 0 ? "yellow" : "green", warnings, layer: 1 };
  }

  const layer2 = await runLayer2Checks(ethersProvider, order);
  if (!layer2.valid) {
    return { status: "red", reason: layer2.reason, warnings: [...warnings, ...layer2.warnings], layer: 2 };
  }
  warnings.push(...layer2.warnings);

  return { status: warnings.length > 0 ? "yellow" : "green", warnings, layer: 2 };
}
