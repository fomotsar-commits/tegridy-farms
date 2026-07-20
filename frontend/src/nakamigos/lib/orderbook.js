/**
 * Native Orderbook Client SDK — interact with our own order storage.
 * Creates Seaport-compatible signed orders at a flat 1% platform fee routed
 * to the Tegridy treasury Safe. (OpenSea has charged ~1% since Sep 2025 —
 * don't market this as a fee discount; the edge is that fees fund the
 * protocol treasury and fills have no marketplace dependency.)
 * Pattern from Blur's native orderbook and Reservoir's open protocol.
 *
 * Orders are standard Seaport v1.5 orders that can be fulfilled by
 * calling Seaport.fulfillOrder() directly — no marketplace dependency.
 */

import { SEAPORT_ADDRESS, SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, CONDUIT_KEY, CONDUIT_ADDRESS, PLATFORM_FEE_RECIPIENT, PLATFORM_FEE_BPS, BUNDLE_LISTING_ENABLED, resolveSeaportTarget } from "../constants";
import { getProvider } from "../api";

const ORDERBOOK_API = "/api/orderbook";

// Max NFTs in one bundle. MUST equal the server's MAX_BUNDLE_ITEMS (api/orderbook.js) so
// the client fails fast instead of signing twice + paying approval gas for an order the
// server would reject at 400/413. Exported so the seller UI caps selection at the same value.
export const MAX_BUNDLE_ITEMS = 50;

async function withRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

/**
 * Deterministic canonical string of a bundle's NFT items, embedded in the create
 * auth message so the wallet signature binds the EXACT set of NFTs. Each item is
 * `${contract.toLowerCase()}:${tokenId}`, the list is SORTED (so item ordering can't
 * change the signature), and joined with ",".
 *
 * IN LOCKSTEP with the server: api/orderbook.js `create-bundle` rebuilds this same
 * string from params.offer (o.token.toLowerCase() + ":" + o.identifierOrCriteria,
 * sorted, joined) and recovers the signer. If you change the format here, change it
 * there too or every bundle create will 403.
 */
export function bundleAuthItemsString(items) {
  return items
    .map((it) => `${String(it.contract).toLowerCase()}:${String(it.tokenId)}`)
    .sort()
    .join(",");
}

// ═══ FETCH NATIVE LISTINGS ═══
// Query active native listings for a given contract address.

export async function fetchNativeListings(contract, { sort = "price_eth", limit = 50, bundles = false } = {}) {
  if (!contract) return { orders: [], count: 0 };
  const params = new URLSearchParams({
    action: "query",
    contract,
    sort,
    limit: String(limit),
    status: "active",
  });
  // Bundles are excluded from the default per-token feed; ask for them explicitly.
  if (bundles) params.set("bundles", "true");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    return await withRetry(async () => {
      const res = await fetch(`${ORDERBOOK_API}?${params}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to fetch");
      }
      return await res.json();
    });
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") return { orders: [], count: 0, error: "Request timed out" };
    return { orders: [], count: 0, error: e.message };
  }
}

// Fetch active BUNDLE listings (is_bundle rows) for a collection. Thin wrapper over
// fetchNativeListings — same shape, same error handling. Returns [] while the feature is
// off (the server returns empty for ?bundles=true when BUNDLE_LISTING_ENABLED is unset).
export async function fetchNativeBundles(contract, opts = {}) {
  return fetchNativeListings(contract, { ...opts, bundles: true });
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
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== 1) {
      return { error: "wrong-chain", message: "Please switch to Ethereum Mainnet to buy NFTs" };
    }
    const signer = await provider.getSigner();
    const buyerAddress = await signer.getAddress();

    // Reconstruct the Seaport order from stored parameters + signature
    const params = order.parameters;
    if (!params || !order.signature) {
      return { error: "invalid-order", message: "Order missing parameters or signature" };
    }

    // Reject expired orders client-side before sending a doomed transaction
    if (params.endTime) {
      const endMs = parseInt(params.endTime) * 1000;
      if (endMs <= Date.now()) {
        return { error: "expired", message: "This listing has expired" };
      }
    }

    // SECURITY: pin the fulfillment target before we touch it. `protocol_address`
    // arrives on the server-supplied order row, and below it becomes both the
    // contract we call and the recipient of `{ value: totalWei }`. An unpinned
    // value would let a tampered/poisoned row point the buyer's ETH at an
    // arbitrary contract. The Seaport/OpenSea sibling path already aborts on an
    // unexpected target; this closes the same hole on the native path. Fail
    // CLOSED — never fall back to the default, because a row naming a foreign
    // target is exactly the case we must refuse, not silently rewrite.
    const seaportTarget = resolveSeaportTarget(order.protocol_address);
    if (!seaportTarget) {
      return { error: "failed", message: "Unexpected transaction target — aborting for safety" };
    }

    // Pre-flight Seaport status check: the backend can miss a fill
    // notification (the post-fill POST below is best-effort), so a stored row
    // may still say "active" for an order already filled or cancelled
    // on-chain. Ask Seaport directly before broadcasting so the buyer fails
    // fast instead of burning gas on a doomed fulfillOrder.
    // FIX 2026-07-19: this used to pass `order.order_hash` — the app's OWN sha256
    // row id, which Seaport has never seen. getOrderStatus then returned all-zeros,
    // so isCancelled was always false and totalFilled always 0: the cancelled /
    // already-filled early exit was a PERMANENT NO-OP. Query the canonical
    // `seaport_order_hash` (what lib/trades.js:498-502 already does correctly), and
    // SKIP the pre-flight entirely for legacy rows where it is null rather than
    // querying with a hash that silently reports "fine".
    if (order.seaport_order_hash) {
      try {
        const statusAbi = [
          "function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)",
        ];
        const seaportRead = new ethers.Contract(seaportTarget, statusAbi, provider);
        const [, isCancelled, totalFilled] = await seaportRead.getOrderStatus(order.seaport_order_hash);
        if (isCancelled) {
          return { error: "cancelled", message: "This listing was cancelled by the seller" };
        }
        if (totalFilled > 0n) {
          return { error: "filled", message: "This NFT was already sold — the listing is stale" };
        }
      } catch {
        // Best-effort: if the status read fails, Seaport still enforces
        // validity on-chain; we just lose the cheap early exit.
      }
    }

    // Calculate total payment (sum of all consideration amounts)
    const totalWei = params.consideration.reduce(
      (sum, item) => sum + BigInt(item.startAmount || "0"),
      0n
    );

    // Build the Seaport fulfillOrder calldata
    // Seaport's fulfillOrder takes an Order struct = { parameters: OrderParameters, signature: bytes }
    const seaportAbi = [
      "function fulfillOrder(((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)",
    ];
    const seaport = new ethers.Contract(
      seaportTarget, // pinned + allowlisted above — never the raw row value
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
      endTime: BigInt(params.endTime || "0"),
      zoneHash: params.zoneHash || "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: BigInt(params.salt || "0"),
      conduitKey: params.conduitKey || CONDUIT_KEY,
      totalOriginalConsiderationItems: params.totalOriginalConsiderationItems || params.consideration.length,
    };

    // Send the fulfillOrder transaction — wrap parameters + signature into Order struct
    const tx = await seaport.fulfillOrder(
      { parameters: orderStruct, signature: order.seaportSignature || order.signature },
      "0x0000000000000000000000000000000000000000000000000000000000000000", // no conduit for buyer
      { value: totalWei }
    );

    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      return { error: "reverted", message: "Transaction was mined but reverted on-chain" };
    }

    // Mark order as filled in our backend
    // AUDIT FIX D-FE-M2: bind fill signature to chainId + a 5-minute timestamp
    // so a captured signature cannot be replayed against staging or after the
    // server window expires. Same pattern as the cancel path.
    // F631 (T5): the `signer.signMessage` notify prompt previously sat OUTSIDE
    // the try below, so rejecting it threw to the outer catch and reported the
    // already-confirmed on-chain fill as "cancelled" (and ShoppingCart's
    // break-on-rejected then dropped a bought item). Move the sign inside the
    // best-effort try so a rejected/failed notify never overturns the fill.
    const _fillTs = Math.floor(Date.now() / 1000);
    const _fillChainId = 1;

    // Retry the notification (same signature — it stays valid for the
    // server's 5-minute window, and re-signing would re-prompt the wallet).
    // If every attempt fails the row stays "active" until the seller's NFT
    // moves; the pre-flight getOrderStatus check above keeps later buyers
    // from broadcasting against the stale row.
    try {
      const fillMessage = `Fill order ${order.order_hash} tx ${tx.hash} | Chain: ${_fillChainId} | Time: ${_fillTs}`;
      const fillSignature = await signer.signMessage(fillMessage);
      await withRetry(async () => {
        const fillController = new AbortController();
        const fillTimeout = setTimeout(() => fillController.abort(), 30000);
        try {
          const res = await fetch(ORDERBOOK_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: fillController.signal,
            body: JSON.stringify({
              action: "fill",
              orderHash: order.order_hash,
              txHash: tx.hash,
              signature: fillSignature,
              chainId: _fillChainId,
              timestamp: _fillTs,
            }),
          });
          if (!res.ok) throw new Error(`fill notify failed: ${res.status}`);
        } finally {
          clearTimeout(fillTimeout);
        }
      });
    } catch {
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
// List an NFT on our orderbook at a flat 1% fee routed to the Tegridy treasury.
// (OpenSea has charged ~1% since Sep 2025 — don't market this as a fee discount;
// the edge is treasury-funding fees + no marketplace dependency. See header.)

export async function createNativeListing({ contract, tokenId, priceEth, expirationHours = 168 }) {
  const ethProvider = getProvider();
  if (!ethProvider) return { error: "no-wallet", message: "No wallet found" };

  try {
    const { ethers } = await import("ethers");
    const provider = new ethers.BrowserProvider(ethProvider);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== 1) {
      return { error: "wrong-chain", message: "Please switch to Ethereum Mainnet to list NFTs" };
    }
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
      const approveReceipt = await approveTx.wait();
      if (!approveReceipt || approveReceipt.status === 0) {
        return { error: "approval-failed", message: "NFT approval transaction reverted" };
      }
      // Re-verify approval succeeded on-chain
      const stillApproved = await nftContract.isApprovedForAll(sellerAddress, CONDUIT_ADDRESS);
      if (!stillApproved) {
        return { error: "approval-failed", message: "NFT approval did not take effect" };
      }
    }

    const priceWei = ethers.parseEther(String(priceEth));
    const now = Math.floor(Date.now() / 1000);
    const endTime = now + expirationHours * 3600;

    // Platform fee: 1% of price
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
      // AUDIT FIX (2026-06-10): was 2 with a "FULL_OPEN_VIA_CONDUIT" comment —
      // that's a Wyvern-era mental model. In Seaport's enum 2 = FULL_RESTRICTED,
      // and with zone = address(0) restricted orders revert at fulfillment
      // (validateOrder staticcall to an empty address can't return the magic
      // value), making every listing signed this way unbuyable. Seaport's
      // conduit usage is controlled by conduitKey alone; FULL_OPEN = 0 is
      // correct for public listings.
      orderType: 0,
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

    // AUDIT F10: derive Seaport's canonical orderHash (the value emitted in
    // OrderFulfilled events on-chain) so the orderbook can verify fills.
    // The hash is `hashStruct(OrderComponents)` — same OrderComponents +
    // counter the wallet just signed. We have all inputs inline, so no
    // extra RPC call beyond the getCounter we already did.
    //
    // ethers.TypedDataEncoder.from(types).hash(data) returns
    //   keccak256( typehash(OrderComponents) || encodedFields )
    // i.e. the EIP-712 struct-hash WITHOUT the \x19\x01 + domainSeparator
    // prefix. That's exactly what Seaport's `_deriveOrderHash` emits in
    // the OrderFulfilled event (verified byte-for-byte against viem's
    // `hashStruct` in the regression test).
    //
    // ethers.TypedDataEncoder.hash(domain, types, data) is the FULL digest
    // (with \x19\x01 prefix) — that's what gets signed but NOT what Seaport
    // emits. Don't confuse the two.
    const seaportOrderHash = ethers.TypedDataEncoder
      .from(SEAPORT_ORDER_TYPES)
      .hash(signData)
      .toLowerCase();

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
      res = await withRetry(async () => {
        const r = await fetch(ORDERBOOK_API, {
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
              // AUDIT F10: canonical Seaport orderHash + counter for fill
              // verification. Server re-derives from these and rejects on
              // mismatch — the client claim is just a fast path.
              seaportOrderHash,
              seaportCounter: counter.toString(),
            },
          }),
        });
        clearTimeout(createTimeout);
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || "Failed to submit order");
        }
        return r;
      });
    } catch (fetchErr) {
      clearTimeout(createTimeout);
      if (fetchErr.name === "AbortError") return { error: "timeout", message: "Order submission timed out" };
      throw fetchErr;
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

// ═══ CREATE NATIVE BUNDLE LISTING ═══
// One Seaport order offering N NFTs for one total price, fulfillable atomically via
// Seaport.fulfillOrder (buyer receives all N or none). Extends createNativeListing
// VERBATIM — identical fee split, EIP-712 signing, orderHash derivation, and submit —
// changing only: (1) a multi-item `offer` array, (2) a per-collection approval loop,
// (3) a bundle auth message that binds the full item set. Gated by BUNDLE_LISTING_ENABLED
// (client) AND the server's own env gate; either off → refused. Money-path: unaudited
// until the re-audit + migration 012 land, so it stays off.
export async function createNativeBundleListing({ items, priceEth, expirationHours = 168 }) {
  if (!BUNDLE_LISTING_ENABLED) {
    return { error: "disabled", message: "Bundle listing is not enabled yet." };
  }
  if (!Array.isArray(items) || items.length < 2) {
    return { error: "too-few-items", message: "A bundle needs at least 2 NFTs." };
  }
  // Fail fast on oversized bundles BEFORE any approval/signature — the server caps at
  // MAX_BUNDLE_ITEMS (and a 10KB body), so without this the seller pays approval gas and
  // signs twice for an order that can never be stored.
  if (items.length > MAX_BUNDLE_ITEMS) {
    return { error: "too-many-items", message: `A bundle can hold at most ${MAX_BUNDLE_ITEMS} NFTs.` };
  }
  // Reject malformed / duplicate items up front (Seaport would accept a dup offer item
  // but it's a footgun — the seller would escrow the same NFT twice in one order).
  const seenItems = new Set();
  for (const it of items) {
    if (!it || !it.contract || it.tokenId == null) {
      return { error: "bad-item", message: "Every bundle item needs a contract and tokenId." };
    }
    const key = `${String(it.contract).toLowerCase()}:${String(it.tokenId)}`;
    if (seenItems.has(key)) return { error: "dup-item", message: "The same NFT appears twice in the bundle." };
    seenItems.add(key);
  }
  // Single-collection bundles only (mirrors the server guard). The row is stored + floored
  // under one contract, so a cross-collection bundle would leak into one collection's
  // listings at a price spanning others. The seller UI only ever builds from one active
  // collection; this is fail-fast + defense-in-depth.
  if (new Set(items.map((it) => String(it.contract).toLowerCase())).size !== 1) {
    return { error: "multi-collection", message: "All NFTs in a bundle must be from the same collection." };
  }

  const ethProvider = getProvider();
  if (!ethProvider) return { error: "no-wallet", message: "No wallet found" };

  try {
    const { ethers } = await import("ethers");
    const provider = new ethers.BrowserProvider(ethProvider);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== 1) {
      return { error: "wrong-chain", message: "Please switch to Ethereum Mainnet to list NFTs" };
    }
    const signer = await provider.getSigner();
    const sellerAddress = await signer.getAddress();

    // Approve the Seaport conduit for each UNIQUE collection in the bundle (one
    // setApprovalForAll per collection, not per NFT). Same check-then-set-then-reverify
    // pattern as createNativeListing.
    const uniqueContracts = [...new Set(items.map((it) => String(it.contract).toLowerCase()))];
    for (const contractAddr of uniqueContracts) {
      const nftContract = new ethers.Contract(contractAddr, [
        "function isApprovedForAll(address,address) view returns (bool)",
        "function setApprovalForAll(address,bool)",
      ], signer);
      const isApproved = await nftContract.isApprovedForAll(sellerAddress, CONDUIT_ADDRESS);
      if (!isApproved) {
        const approveTx = await nftContract.setApprovalForAll(CONDUIT_ADDRESS, true);
        const approveReceipt = await approveTx.wait();
        if (!approveReceipt || approveReceipt.status === 0) {
          return { error: "approval-failed", message: "NFT approval transaction reverted" };
        }
        const stillApproved = await nftContract.isApprovedForAll(sellerAddress, CONDUIT_ADDRESS);
        if (!stillApproved) {
          return { error: "approval-failed", message: "NFT approval did not take effect" };
        }
      }
    }

    const priceWei = ethers.parseEther(String(priceEth));
    const now = Math.floor(Date.now() / 1000);
    const endTime = now + expirationHours * 3600;

    // Platform fee: 1% of the TOTAL bundle price (same split as a single listing).
    const platformFee = (priceWei * BigInt(PLATFORM_FEE_BPS)) / 10000n;
    const sellerReceives = priceWei - platformFee;

    // Multi-item offer: one ERC721 offer item per NFT. Consideration stays the SAME
    // 2-item split (seller receives + platform fee) — one price for the whole bundle —
    // so totalOriginalConsiderationItems is still 2.
    const offer = items.map((it) => ({
      itemType: 2, // ERC721
      token: String(it.contract),
      identifierOrCriteria: String(it.tokenId),
      startAmount: "1",
      endAmount: "1",
    }));

    const orderParameters = {
      offerer: sellerAddress,
      zone: "0x0000000000000000000000000000000000000000",
      offer,
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
      // FULL_OPEN = 0 for public listings (see createNativeListing's AUDIT note).
      orderType: 0,
      startTime: String(now),
      endTime: String(endTime),
      zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      salt: ethers.hexlify(ethers.randomBytes(32)),
      conduitKey: CONDUIT_KEY,
      totalOriginalConsiderationItems: 2,
    };

    const seaport = new ethers.Contract(SEAPORT_ADDRESS, [
      "function getCounter(address) view returns (uint256)",
    ], provider);
    const counter = await seaport.getCounter(sellerAddress);

    const signData = { ...orderParameters, counter: counter.toString() };
    const seaportSignature = await signer.signTypedData(SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, signData);
    const seaportOrderHash = ethers.TypedDataEncoder
      .from(SEAPORT_ORDER_TYPES)
      .hash(signData)
      .toLowerCase();

    // Bundle auth message: same fields as the single-listing message but binds the FULL
    // item set (deterministic sorted digest) instead of one Contract. MUST match the
    // server-side reconstruction in api/orderbook.js create-bundle exactly. Price is
    // sellerReceives (consideration[0].startAmount), matching createNativeListing.
    const itemsStr = bundleAuthItemsString(items);
    const authMessage = `Create bundle for ${sellerAddress.toLowerCase()} | Items: ${itemsStr} | Count: ${items.length} | Price: ${sellerReceives.toString()} | StartTime: ${now} | EndTime: ${endTime}`;
    const authSignature = await signer.signMessage(authMessage);

    const createController = new AbortController();
    const createTimeout = setTimeout(() => createController.abort(), 30000);
    let res;
    try {
      res = await withRetry(async () => {
        const r = await fetch(ORDERBOOK_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: createController.signal,
          body: JSON.stringify({
            action: "create-bundle",
            order: {
              parameters: orderParameters,
              signature: authSignature,
              seaportSignature,
              protocol_address: SEAPORT_ADDRESS,
              seaportOrderHash,
              seaportCounter: counter.toString(),
            },
          }),
        });
        clearTimeout(createTimeout);
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || "Failed to submit bundle");
        }
        return r;
      });
    } catch (fetchErr) {
      clearTimeout(createTimeout);
      if (fetchErr.name === "AbortError") return { error: "timeout", message: "Bundle submission timed out" };
      throw fetchErr;
    }

    let result;
    try { result = await res.json(); } catch { return { error: "post-failed", message: "Invalid response from orderbook" }; }
    return { success: true, orderHash: result.orderHash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Bundle listing cancelled by user" };
    }
    console.error("Native bundle listing error:", err);
    return { error: "failed", message: err.shortMessage || err.message || "Failed to create bundle listing" };
  }
}
