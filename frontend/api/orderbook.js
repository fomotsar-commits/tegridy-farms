// ═══ NATIVE ORDERBOOK API ═══
// Stores and queries Seaport-compatible signed orders.
// Battle-tested pattern from Reservoir Protocol's open orderbook.
//
// Endpoints:
//   GET  /api/orderbook?action=query&contract=0x...        → active orders
//   GET  /api/orderbook?action=query&maker=0x...           → orders by maker
//   GET  /api/orderbook?action=query&tokenId=123&contract= → orders for token
//   POST /api/orderbook  body: { action: "create", order } → submit signed order
//   POST /api/orderbook  body: { action: "cancel", hash }  → cancel order

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "crypto";
import { recoverMessageAddress } from "viem";

// Whitelist allowed contract addresses (lowercase)
const ALLOWED_CONTRACTS = new Set([
  "0xd774557b647330c91bf44cfeab205095f7e6c367", // Nakamigos
  "0xa1de9f93c56c290c48849b1393b09eb616d55dbb", // GNSS Art
  "0xd37264c71e9af940e49795f0d3a8336afaafdda9", // Jungle Bay
]);

// Token decimals for price calculation (lowercase address → decimals)
const TOKEN_DECIMALS = {
  "0x0000000000000000000000000000000000000000": 18, // ETH
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": 18, // WETH
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6,  // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 6,  // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f": 18, // DAI
};

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
// SECURITY: Must use service_role key for server-side operations. The anon key is public
// and would bypass RLS policies. Never fall back to VITE_SUPABASE_ANON_KEY here.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

/**
 * Required Supabase table:
 *
 *   CREATE TABLE native_orders (
 *     order_hash text PRIMARY KEY,
 *     order_type text NOT NULL DEFAULT 'listing',
 *     contract_address text NOT NULL,
 *     token_id text,
 *     maker text NOT NULL,
 *     price_wei text NOT NULL,
 *     price_eth numeric NOT NULL,
 *     currency text NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
 *     zone text,
 *     parameters jsonb NOT NULL,
 *     signature text NOT NULL,
 *     protocol_address text NOT NULL,
 *     start_time timestamptz NOT NULL,
 *     end_time timestamptz NOT NULL,
 *     status text NOT NULL DEFAULT 'active',
 *     filled_by text,
 *     filled_at timestamptz,
 *     tx_hash text,
 *     cancelled_at timestamptz,
 *     created_at timestamptz DEFAULT now()
 *   );
 *
 *   ALTER TABLE native_orders ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "Anyone can read orders" ON native_orders FOR SELECT USING (true);
 *   -- SECURITY: INSERT/UPDATE restricted to service_role only (all writes go through this API)
 *   CREATE POLICY "Service role can insert" ON native_orders FOR INSERT TO service_role WITH CHECK (true);
 *   CREATE POLICY "Service role can update" ON native_orders FOR UPDATE TO service_role USING (true);
 *   -- WARNING: The old policies below allowed ANY anonymous client to write directly via
 *   -- the public anon key, bypassing all signature verification. They must be dropped:
 *   --   DROP POLICY IF EXISTS "Anyone can insert orders" ON native_orders;
 *   --   DROP POLICY IF EXISTS "Anyone can update orders" ON native_orders;
 *
 *   CREATE INDEX idx_orders_contract ON native_orders(contract_address, status);
 *   CREATE INDEX idx_orders_maker ON native_orders(maker, status);
 *   CREATE INDEX idx_orders_token ON native_orders(contract_address, token_id, status);
 *   CREATE INDEX idx_orders_price ON native_orders(price_eth ASC) WHERE status = 'active';
 */

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://nakamigos.gallery";

// ── Shared validation helpers ──
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const NUMERIC_ID_RE = /^\d{1,10}$/;
const MAX_BODY_SIZE = 10 * 1024; // 10 KB

function isValidAddress(addr) { return typeof addr === "string" && ETH_ADDRESS_RE.test(addr); }
function isValidTokenId(id) { return typeof id === "string" && NUMERIC_ID_RE.test(id); }

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const ALLOWED_ORIGINS = new Set([
    "https://nakamigos.gallery", "https://www.nakamigos.gallery",
    "https://tegridyfarms.vercel.app",
  ]);
  // Only allow localhost origins in non-production environments
  if (process.env.NODE_ENV !== "production") {
    ALLOWED_ORIGINS.add("http://localhost:8742");
    ALLOWED_ORIGINS.add("http://localhost:3000");
    ALLOWED_ORIGINS.add("http://localhost:5173");
  }
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.has(origin) ? origin : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

function setRateLimitHeaders(res, { limit = 60, remaining = 59, reset = 60 } = {}) {
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + reset));
}

export default async function handler(req, res) {
  setCors(req, res);
  setRateLimitHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!supabase) {
    return res.status(503).json({ error: "Orderbook database not configured" });
  }

  // ── Body size guard (POST only) ──
  if (req.method === "POST") {
    const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    if (bodyStr.length > MAX_BODY_SIZE) {
      return res.status(413).json({ error: "Request body too large (max 10KB)" });
    }
  }

  // ── GET: Query orders ──
  if (req.method === "GET") {
    const { action, contract, maker, tokenId, status = "active", limit = "50", sort = "price_eth" } = req.query;

    if (action !== "query") return res.status(400).json({ error: "Use action=query for GET" });

    // Whitelist allowed sort columns to prevent injection
    const ALLOWED_SORTS = new Set(["price_eth", "created_at", "end_time"]);
    const safeSort = ALLOWED_SORTS.has(sort) ? sort : "price_eth";

    // Whitelist allowed status values
    const ALLOWED_STATUSES = new Set(["active", "filled", "cancelled"]);
    const safeStatus = ALLOWED_STATUSES.has(status) ? status : "active";

    // Cap limit to prevent DoS via unbounded queries
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 50), 200);

    let query = supabase
      .from("native_orders")
      .select("*")
      .eq("status", safeStatus);

    // Only filter by end_time for active orders — filled/cancelled orders are historical
    if (safeStatus === "active") {
      query = query.gt("end_time", new Date().toISOString());
    }

    query = query
      .order(safeSort, { ascending: safeSort === "price_eth" })
      .limit(safeLimit);

    // Contract is required — never return orders across all collections
    if (!contract) return res.status(400).json({ error: "contract parameter is required" });
    if (!isValidAddress(contract)) return res.status(400).json({ error: "Invalid contract address format" });
    const lc = contract.toLowerCase();
    if (!ALLOWED_CONTRACTS.has(lc)) return res.status(403).json({ error: "Contract not supported" });
    query = query.eq("contract_address", lc);

    if (maker) {
      if (!isValidAddress(maker)) return res.status(400).json({ error: "Invalid maker address" });
      query = query.eq("maker", maker.toLowerCase());
    }
    if (tokenId) {
      if (!isValidTokenId(tokenId)) return res.status(400).json({ error: "Invalid tokenId — must be numeric (max 10 digits)" });
      query = query.eq("token_id", tokenId);
    }

    const { data, error } = await query;
    if (error) { console.error("Orderbook error:", error.message); return res.status(500).json({ error: "Internal error" }); }

    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
    return res.json({ orders: data || [], count: (data || []).length });
  }

  // ── POST: Create or cancel orders ──
  // All write operations require wallet signature for authentication.
  // Pattern: client signs a message with their wallet, server verifies the signer.
  if (req.method === "POST") {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Missing or malformed JSON body" });
    }
    const { action } = req.body;

    if (action === "create") {
      const { order } = req.body;
      if (!order?.parameters || !order?.signature) {
        return res.status(400).json({ error: "Missing order parameters or signature" });
      }

      const params = order.parameters;

      // Validate all required Seaport fields
      if (!params.offerer || typeof params.offerer !== "string") {
        return res.status(400).json({ error: "Missing or invalid offerer" });
      }
      if (!params.offer || !Array.isArray(params.offer) || params.offer.length === 0) {
        return res.status(400).json({ error: "Missing or empty offer array" });
      }
      if (!params.consideration || !Array.isArray(params.consideration) || params.consideration.length === 0) {
        return res.status(400).json({ error: "Missing or empty consideration array" });
      }
      if (!params.startTime || !params.endTime) {
        return res.status(400).json({ error: "Missing startTime or endTime" });
      }
      const startSec = parseInt(params.startTime);
      const endSec = parseInt(params.endTime);
      if (isNaN(startSec) || isNaN(endSec) || endSec <= startSec) {
        return res.status(400).json({ error: "Invalid startTime/endTime" });
      }
      // Reject orders that already expired
      if (endSec * 1000 < Date.now()) {
        return res.status(400).json({ error: "Order already expired" });
      }

      const offerItem = params.offer[0];
      const considerationItem = params.consideration[0];

      // Determine order type: listing (offering NFT) vs offer (offering ERC20)
      const isListing = offerItem?.itemType >= 2; // ERC721 or ERC1155
      const orderType = isListing ? "listing" : "offer";

      // Extract total price: for listings, sum ALL consideration items (seller receives + fees = total price)
      // consideration[0] is seller receives, consideration[1..N] are fee items
      let priceWei;
      let currencyAddr;
      if (isListing) {
        // Sum all consideration items to get the total listing price
        const totalWei = params.consideration.reduce(
          (sum, item) => sum + BigInt(item.startAmount || "0"), 0n
        );
        priceWei = totalWei.toString();
        currencyAddr = (considerationItem?.token)?.toLowerCase() || "0x0000000000000000000000000000000000000000";
      } else {
        priceWei = offerItem?.startAmount || "0";
        currencyAddr = (offerItem?.token)?.toLowerCase() || "0x0000000000000000000000000000000000000000";
      }
      const decimals = TOKEN_DECIMALS[currencyAddr];
      if (decimals === undefined) {
        return res.status(400).json({ error: `Unsupported currency: ${currencyAddr}` });
      }
      // Compute price in human-readable units for the token's decimals.
      // Use 8 decimal places of precision to avoid loss on large values.
      const divisor = BigInt(10) ** BigInt(decimals);
      const priceBig = BigInt(priceWei);
      const priceEth = Number((priceBig * 100000000n) / divisor) / 100000000;

      // Extract contract + tokenId
      const nftItem = isListing ? offerItem : considerationItem;
      const contract = nftItem?.token?.toLowerCase() || "";
      const tokenId = nftItem?.identifierOrCriteria || null;

      // Validate contract belongs to an allowed collection
      if (!contract || !ALLOWED_CONTRACTS.has(contract)) {
        return res.status(403).json({ error: "Contract not supported" });
      }

      // Verify wallet signature to authenticate the order creator.
      // The client signs with consideration[0].startAmount (sellerReceives, not total price)
      // to match the auth message format in lib/orderbook.js createNativeListing.
      const authPriceWei = considerationItem?.startAmount || "0";
      const createMessage = `Create order for ${params.offerer.toLowerCase()} | Contract: ${contract} | Price: ${authPriceWei} | StartTime: ${startSec} | EndTime: ${endSec}`;
      let recoveredCreator;
      try {
        recoveredCreator = (await recoverMessageAddress({ message: createMessage, signature: order.signature })).toLowerCase();
      } catch (e) {
        return res.status(400).json({ error: "Invalid signature" });
      }
      if (recoveredCreator !== params.offerer.toLowerCase()) {
        return res.status(403).json({ error: "Signer does not match offerer" });
      }

      // Prevent duplicate active listings for the same token by the same maker.
      // If one already exists, auto-cancel it so the new listing replaces it (relist flow).
      if (isListing && tokenId) {
        const { data: existingListings } = await supabase
          .from("native_orders")
          .select("order_hash")
          .eq("contract_address", contract)
          .eq("token_id", String(tokenId))
          .eq("maker", recoveredCreator)
          .eq("status", "active");

        if (existingListings && existingListings.length > 0) {
          for (const existing of existingListings) {
            await supabase
              .from("native_orders")
              .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
              .eq("order_hash", existing.order_hash)
              .eq("status", "active");
          }
        }
      }

      // Rate limit: max 20 orders per maker per hour (persists across cold starts)
      const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
      const { count: makerOrderCount } = await supabase
        .from("native_orders")
        .select("*", { count: "exact", head: true })
        .eq("maker", recoveredCreator)
        .gte("created_at", oneHourAgo);
      if (makerOrderCount != null && makerOrderCount >= 20) {
        return res.status(429).json({ error: "Rate limit exceeded — max 20 orders per hour" });
      }

      // Generate a deterministic order hash from the order parameters.
      // Uses SHA-256 of the canonical JSON to produce a proper 66-char hex hash.
      const hashInput = JSON.stringify({
        offerer: params.offerer?.toLowerCase(),
        offer: params.offer,
        consideration: params.consideration,
        startTime: params.startTime,
        endTime: params.endTime,
        salt: params.salt || randomUUID(),
      });
      const orderHash = "0x" + createHash("sha256").update(hashInput).digest("hex");

      const { error } = await supabase.from("native_orders").insert({
        order_hash: orderHash,
        order_type: orderType,
        contract_address: contract,
        token_id: tokenId ? String(tokenId) : null,
        maker: params.offerer?.toLowerCase() || "",
        price_wei: priceWei,
        price_eth: priceEth,
        currency: currencyAddr,
        zone: params.zone || null,
        parameters: params,
        signature: order.seaportSignature || order.signature,
        protocol_address: order.protocol_address || "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
        start_time: new Date(startSec * 1000).toISOString(),
        end_time: new Date(endSec * 1000).toISOString(),
        status: "active",
      });

      if (error) { console.error("Orderbook error:", error.message); return res.status(500).json({ error: "Internal error" }); }
      return res.status(201).json({ success: true, orderHash, orderType });
    }

    if (action === "cancel") {
      const { orderHash, signature } = req.body;
      if (!orderHash || !signature) return res.status(400).json({ error: "Missing orderHash or signature" });
      if (typeof orderHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(orderHash)) {
        return res.status(400).json({ error: "Invalid orderHash format" });
      }

      // Verify wallet signature to prove the caller controls the maker wallet
      const cancelMessage = `Cancel order ${orderHash}`;
      let recoveredAddress;
      try {
        recoveredAddress = (await recoverMessageAddress({ message: cancelMessage, signature })).toLowerCase();
      } catch (e) {
        return res.status(400).json({ error: "Invalid signature" });
      }

      // Verify the recovered signer owns this order
      const { data: existing, error: lookupError } = await supabase
        .from("native_orders")
        .select("maker, status")
        .eq("order_hash", orderHash)
        .single();

      if (lookupError) { console.error("Orderbook lookup error:", lookupError.message); return res.status(500).json({ error: "Internal error" }); }
      if (!existing) return res.status(404).json({ error: "Order not found" });
      if (existing.maker !== recoveredAddress) {
        return res.status(403).json({ error: "Signer is not the order maker" });
      }
      if (existing.status !== "active") {
        return res.status(409).json({ error: `Order is already ${existing.status}` });
      }

      const { error } = await supabase
        .from("native_orders")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("order_hash", orderHash)
        .eq("status", "active"); // Prevent race condition

      if (error) { console.error("Orderbook error:", error.message); return res.status(500).json({ error: "Internal error" }); }
      return res.json({ success: true });
    }

    if (action === "fill") {
      const { orderHash, txHash, signature } = req.body;
      if (!orderHash || !signature) return res.status(400).json({ error: "Missing orderHash or signature" });
      if (typeof orderHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(orderHash)) {
        return res.status(400).json({ error: "Invalid orderHash format" });
      }

      if (!txHash || typeof txHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        return res.status(400).json({ error: "Missing or invalid txHash — provide the on-chain transaction hash" });
      }

      // Verify wallet signature to authenticate the filler
      const fillMessage = `Fill order ${orderHash} tx ${txHash}`;
      let filledBy;
      try {
        filledBy = (await recoverMessageAddress({ message: fillMessage, signature })).toLowerCase();
      } catch (e) {
        return res.status(400).json({ error: "Invalid signature" });
      }

      // Verify the transaction on-chain via Alchemy RPC
      const alchemyKey = process.env.ALCHEMY_API_KEY;
      if (alchemyKey && alchemyKey !== "demo") {
        try {
          const rpcRes = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
          });
          const rpcData = await rpcRes.json();
          const receipt = rpcData?.result;
          if (!receipt) {
            return res.status(400).json({ error: "Transaction not found on-chain — it may still be pending" });
          }
          if (receipt.status !== "0x1") {
            return res.status(400).json({ error: "Transaction reverted on-chain" });
          }
          // Verify that the tx contains a Seaport OrderFulfilled event for this order hash
          // OrderFulfilled topic0 = keccak256("OrderFulfilled(bytes32,address,address,tuple[])")
          const ORDER_FULFILLED_TOPIC = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31";
          const hasMatchingLog = receipt.logs.some(log =>
            log.topics?.[0] === ORDER_FULFILLED_TOPIC &&
            log.topics?.[1]?.toLowerCase() === orderHash.toLowerCase()
          );
          if (!hasMatchingLog) {
            return res.status(400).json({ error: "Transaction does not contain a matching Seaport OrderFulfilled event" });
          }
        } catch (rpcErr) {
          console.error("On-chain verification failed, rejecting fill:", rpcErr.message);
          // Fail closed: if RPC is unavailable, do NOT mark as filled without verification.
          // The buyer can retry once RPC is back up.
          return res.status(503).json({ error: "On-chain verification temporarily unavailable — please retry in a few minutes" });
        }
      }

      // Prevent duplicate txHash usage — one on-chain tx should only fill one order
      const { count: txUsageCount } = await supabase
        .from("native_orders")
        .select("*", { count: "exact", head: true })
        .eq("tx_hash", txHash)
        .eq("status", "filled");
      if (txUsageCount != null && txUsageCount > 0) {
        return res.status(409).json({ error: "This transaction hash has already been used to fill an order" });
      }

      // Atomic update: set status to filled only if currently active.
      const { data: updated, error } = await supabase
        .from("native_orders")
        .update({
          status: "filled",
          filled_by: filledBy,
          filled_at: new Date().toISOString(),
          tx_hash: txHash,
        })
        .eq("order_hash", orderHash)
        .eq("status", "active")
        .select();

      if (error) { console.error("Orderbook error:", error.message); return res.status(500).json({ error: "Internal error" }); }

      if (!updated || updated.length === 0) {
        const { data: existing } = await supabase
          .from("native_orders")
          .select("status")
          .eq("order_hash", orderHash)
          .single();
        if (!existing) return res.status(404).json({ error: "Order not found" });
        return res.status(409).json({ error: `Order is already ${existing.status}` });
      }

      return res.json({ success: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
