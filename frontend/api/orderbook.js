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
import { recoverMessageAddress, decodeAbiParameters, parseAbiParameters } from "viem";
import { checkRateLimit } from "./_lib/ratelimit.js";
import { verifySeaportSignature, verifyNftOwnership, MAX_PRICE_WEI, priceWeiToEthNumber } from "./_lib/seaport-verify.js";
import { computeSeaportOrderHash, isValidSeaportOrderHash } from "./_lib/seaportHash.js";
// AUDIT FIX 2026-05-13 — LOW-S1 — every other API handler wraps error logs
// in `logSafe` to redact embedded API keys / sensitive values. Orderbook
// was the outlier — Supabase error messages occasionally include row data,
// and the embedded Alchemy key in the fill-verification fetch (line 676)
// could leak through a future error-path regression. Defense-in-depth.
import { logSafe } from "./_lib/logSafe.js";

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
 *     created_at timestamptz DEFAULT now(),
 *     -- AUDIT F10: canonical Seaport struct-hash of OrderComponents,
 *     -- emitted in the on-chain OrderFulfilled event. Used to verify
 *     -- fills. NULLABLE for legacy pre-migration rows; new rows must
 *     -- supply it. See migrations/005_add_seaport_order_hash.sql.
 *     seaport_order_hash text
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
    "https://tegridyfarms.xyz",
    "https://www.tegridyfarms.xyz",
    "https://nakamigos.gallery", "https://www.nakamigos.gallery",
    "https://tegridyfarms.vercel.app",
  ]);
  // AUDIT API-SEC: fail-closed — only admit localhost when NODE_ENV === "development".
  if (process.env.NODE_ENV === "development") {
    ALLOWED_ORIGINS.add("http://localhost:8742");
    ALLOWED_ORIGINS.add("http://localhost:3000");
    ALLOWED_ORIGINS.add("http://localhost:5173");
  }
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.has(origin) ? origin : ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

// AUDIT API-M1: real rate limiting lives in _lib/ratelimit.js.

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // AUDIT API-M1: orderbook is the most write-heavy proxy (orders, cancels,
  // fills) and also the most abuse-attractive (spam-listing griefing). We
  // apply 40 req/min per IP — generous for humans browsing, restrictive
  // enough to slow an attacker spamming fake orders.
  const allowed = await checkRateLimit(req, res, {
    limit: 40, windowSec: 60, identifier: "orderbook",
  });
  if (!allowed) return;

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
    if (error) { console.error("Orderbook error:", logSafe(error)); return res.status(500).json({ error: "Internal error" }); }

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

      // AUDIT ORDERBOOK-SEC-REPLAY: bind the create signature to a recent
      // wall-clock time by enforcing that startTime is close to now. The
      // signed auth message below includes `StartTime: ${startSec}`, so an
      // attacker who captures a valid signature cannot replay it more than
      // a few minutes later — startSec no longer falls within the window
      // and the server rejects before any DB write.
      //
      // Why startTime: client sets startSec = Math.floor(Date.now()/1000)
      // at sign time, so it effectively IS the sign timestamp. If that
      // changes, add a dedicated `signedAt` field to both the message
      // and this check.
      //
      // Window: 5 min past / 5 min future. Past side absorbs slow network
      // + retry. Future side absorbs wallet clock skew but stays tight
      // enough to prevent stockpiling pre-signed orders.
      const MAX_SIGNATURE_AGE_SEC = 300;
      const nowSec = Math.floor(Date.now() / 1000);
      if (startSec < nowSec - MAX_SIGNATURE_AGE_SEC) {
        return res.status(400).json({ error: "Order signature is stale — resign with a fresh startTime" });
      }
      if (startSec > nowSec + MAX_SIGNATURE_AGE_SEC) {
        return res.status(400).json({ error: "Order startTime is too far in the future" });
      }

      const offerItem = params.offer[0];
      const considerationItem = params.consideration[0];

      // Determine order type: listing (offering NFT) vs offer (offering ERC20)
      const isListing = offerItem?.itemType >= 2; // ERC721 or ERC1155
      const orderType = isListing ? "listing" : "offer";

      // Extract total price: for listings, sum ALL consideration items (seller receives + fees = total price)
      // consideration[0] is seller receives, consideration[1..N] are fee items
      let priceWeiBig;
      let priceWei;
      let currencyAddr;

      // Parse a single startAmount as BigInt with strict validation. Returns
      // the BigInt or throws — caller maps to 400.
      const parseAmount = (raw) => {
        if (raw == null) return 0n;
        if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") {
          throw new Error("amount out of range");
        }
        const s = String(raw).trim();
        if (!/^[0-9]+$/.test(s)) {
          throw new Error("amount out of range");
        }
        return BigInt(s);
      };

      try {
        if (isListing) {
          // AUDIT FIX H-4: all consideration items must share the same currency.
          // Summing startAmount across mixed currencies produces a meaningless
          // priceWei (e.g. WETH wei + USDC base units) and lets an attacker
          // post listings with arbitrary `price_eth` to poison the floor sort.
          const baseToken = (considerationItem?.token || "").toLowerCase();
          for (let i = 1; i < params.consideration.length; i++) {
            const itemToken = (params.consideration[i]?.token || "").toLowerCase();
            if (itemToken !== baseToken) {
              return res.status(400).json({ error: "Mixed-currency consideration not supported" });
            }
          }
          // Sum all consideration items to get the total listing price.
          // Each item is range-validated; cap on sum is enforced below.
          let totalWei = 0n;
          for (const item of params.consideration) {
            const amt = parseAmount(item.startAmount);
            if (amt > MAX_PRICE_WEI) throw new Error("amount out of range");
            totalWei += amt;
          }
          priceWeiBig = totalWei;
          currencyAddr = baseToken || "0x0000000000000000000000000000000000000000";
        } else {
          priceWeiBig = parseAmount(offerItem?.startAmount);
          currencyAddr = (offerItem?.token)?.toLowerCase() || "0x0000000000000000000000000000000000000000";
        }
      } catch (e) {
        return res.status(400).json({ error: "startAmount out of range or non-numeric" });
      }

      // AUDIT FIX H-4 / R053: cap aggregate price so a single overflowing
      // listing can't pollute the `price_eth ASC` floor sort. 10**24 wei =
      // 1,000,000 ETH equivalent — generous by ~6 orders of magnitude vs the
      // actual collection floors.
      if (priceWeiBig > MAX_PRICE_WEI) {
        return res.status(400).json({ error: "priceWei out of range (exceeds MAX_PRICE_WEI cap)" });
      }
      priceWei = priceWeiBig.toString();

      const decimals = TOKEN_DECIMALS[currencyAddr];
      if (decimals === undefined) {
        return res.status(400).json({ error: `Unsupported currency: ${currencyAddr}` });
      }
      // Compute price in human-readable units for the token's decimals.
      // Uses the shared helper so precision rules stay in one place.
      const priceEth = priceWeiToEthNumber(priceWeiBig, decimals);

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

      // AUDIT FIX H-1: independently verify the Seaport EIP-712 signature so
      // an attacker cannot keep their own personal_sign auth while substituting
      // another user's tokenId / contract / consideration in `params`. The
      // personal_sign check above only binds offerer + contract + price + times;
      // every other field of the Seaport order was unauthenticated before.
      const seaportSig = order.seaportSignature || order.signature;
      const sigCheck = await verifySeaportSignature({ parameters: params, signature: seaportSig });
      if (!sigCheck.ok) {
        // rpc-unavailable → 503 (caller should retry); everything else (signature-mismatch,
        // bad-signature, bad-parameters) is a client-side problem → 403.
        const status = sigCheck.error === "rpc-unavailable" ? 503 : 403;
        return res.status(status).json({ error: `Seaport signature verification failed: ${sigCheck.error}` });
      }

      // AUDIT FIX H-1: enforce on-chain ownership for ERC721 listings so an
      // attacker cannot list NFTs they don't actually own. Skipped for offers
      // (itemType < 2) and for ERC1155 (handled inside verifyNftOwnership).
      if (isListing) {
        const ownerCheck = await verifyNftOwnership({ parameters: params });
        if (!ownerCheck.ok) {
          // Map error → status:
          //   rpc-unavailable                                       → 503
          //   token-not-found / no-offer-item / no-token-id         → 400 (client supplied bad data)
          //   not-owner (and any other auth failure)                → 403
          let status, message;
          if (ownerCheck.error === "rpc-unavailable") {
            status = 503;
            message = "On-chain ownership verification temporarily unavailable";
          } else if (
            ownerCheck.error === "token-not-found" ||
            ownerCheck.error === "no-offer-item" ||
            ownerCheck.error === "no-token-id"
          ) {
            status = 400;
            message = `NFT ownership check failed: ${ownerCheck.error}`;
          } else {
            // not-owner et al.
            status = 403;
            message = "Offerer does not own this NFT";
          }
          return res.status(status).json({ error: message });
        }
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
      // NOTE: this is the application's PRIMARY KEY for the row — unrelated to
      // Seaport's on-chain orderHash. Both are stored: this one is used for
      // every API lookup (cancel/fill/query), and `seaport_order_hash` is
      // used to match against the OrderFulfilled event in the fill verifier.
      const hashInput = JSON.stringify({
        offerer: params.offerer?.toLowerCase(),
        offer: params.offer,
        consideration: params.consideration,
        startTime: params.startTime,
        endTime: params.endTime,
        salt: params.salt || randomUUID(),
      });
      const orderHash = "0x" + createHash("sha256").update(hashInput).digest("hex");

      // ── AUDIT F10: capture the canonical Seaport orderHash ──
      // Pre-fix the fill verifier checked `topics[1] === orderHash` which
      // matched the indexed offerer (a zero-padded address), AND compared
      // it to a sha256(JSON) hash that has no relationship to Seaport's
      // EIP-712 struct hash. NO legitimate fill ever satisfied the check.
      //
      // Fix: derive Seaport's canonical hashStruct(OrderComponents) and
      // store it in a dedicated column. The client provides its own
      // computed hash (it has counter inline at sign-time, no extra RPC
      // round-trip needed) and the server re-derives from the same
      // parameters as defense-in-depth. If the client tampers, the fill
      // path will reject anyway (Seaport emits the canonical hash on chain),
      // so this re-check is belt-and-suspenders to fail fast at create-time
      // rather than silently accept a wrong hash and DoS later fills.
      let seaportOrderHash = null;
      const clientSeaportHash = order.seaportOrderHash;
      if (clientSeaportHash !== undefined && clientSeaportHash !== null) {
        if (!isValidSeaportOrderHash(clientSeaportHash)) {
          return res.status(400).json({ error: "Invalid seaportOrderHash format (expected 0x + 64 lowercase hex)" });
        }
        // The client also passes the Seaport counter it used at sign-time.
        // It's part of the OrderComponents typed-data so the wallet had to
        // know it; we accept the claim and re-derive.
        const counter = order.seaportCounter;
        if (counter == null) {
          return res.status(400).json({ error: "Missing seaportCounter — required to derive canonical orderHash" });
        }
        let counterBig;
        try {
          // Accept string/number/bigint; reject anything else.
          if (typeof counter === "string") {
            if (!/^[0-9]+$/.test(counter)) throw new Error("non-numeric");
            counterBig = BigInt(counter);
          } else if (typeof counter === "number" && Number.isInteger(counter) && counter >= 0) {
            counterBig = BigInt(counter);
          } else if (typeof counter === "bigint") {
            counterBig = counter;
          } else {
            throw new Error("bad-type");
          }
        } catch (e) {
          return res.status(400).json({ error: "Invalid seaportCounter — must be a non-negative integer" });
        }
        // Re-derive server-side. If derivation throws (malformed param) →
        // 400; that's a client-side problem.
        let derivedHash;
        try {
          derivedHash = computeSeaportOrderHash(params, counterBig);
        } catch (e) {
          return res.status(400).json({ error: "Could not derive Seaport orderHash from parameters" });
        }
        // Constant-time-ish equality on lowercase hex strings.
        if (derivedHash !== clientSeaportHash.toLowerCase()) {
          return res.status(400).json({ error: "seaportOrderHash mismatch — client hash does not match server-derived hash" });
        }
        seaportOrderHash = derivedHash;
      }

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
        seaport_order_hash: seaportOrderHash,
      });

      if (error) { console.error("Orderbook error:", logSafe(error)); return res.status(500).json({ error: "Internal error" }); }
      return res.status(201).json({ success: true, orderHash, orderType });
    }

    if (action === "cancel") {
      const { orderHash, signature, chainId, timestamp } = req.body;
      if (!orderHash || !signature) return res.status(400).json({ error: "Missing orderHash or signature" });
      if (typeof orderHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(orderHash)) {
        return res.status(400).json({ error: "Invalid orderHash format" });
      }

      // AUDIT FIX D-FE-M2: bind cancel signatures to chainId + a 5-minute
      // timestamp window. Pre-fix the signed payload was just `Cancel order
      // ${orderHash}`, so a captured signature could be replayed against a
      // staging orderbook with the same hash, OR replayed against the same
      // backend AFTER the maker re-listed (deterministic-hash flows). The
      // chainId binding eliminates cross-environment replay; the timestamp
      // bounds same-environment replay to a 5-minute window. Mirrors the
      // SIWE auth pattern (chainId + nonce + expiresAt). Server compares
      // against the canonical mainnet chain (Seaport orders are mainnet-only
      // per SEAPORT_DOMAIN.chainId = 1 in the listing flow).
      if (typeof chainId !== "number" || chainId !== 1) {
        return res.status(400).json({ error: "Invalid or missing chainId" });
      }
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
        return res.status(400).json({ error: "Invalid or missing timestamp" });
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - timestamp) > 300) {
        return res.status(400).json({ error: "Signature expired or clock-skewed; please re-sign" });
      }

      // Verify wallet signature to prove the caller controls the maker wallet
      const cancelMessage = `Cancel order ${orderHash} | Chain: ${chainId} | Time: ${timestamp}`;
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

      if (error) { console.error("Orderbook error:", logSafe(error)); return res.status(500).json({ error: "Internal error" }); }
      return res.json({ success: true });
    }

    if (action === "fill") {
      const { orderHash, txHash, signature, chainId, timestamp } = req.body;
      if (!orderHash || !signature) return res.status(400).json({ error: "Missing orderHash or signature" });
      if (typeof orderHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(orderHash)) {
        return res.status(400).json({ error: "Invalid orderHash format" });
      }

      if (!txHash || typeof txHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        return res.status(400).json({ error: "Missing or invalid txHash — provide the on-chain transaction hash" });
      }

      // AUDIT FIX D-FE-M2: same chainId + 5-minute timestamp binding as the
      // cancel path. Without these fields a captured fill signature could be
      // replayed against a staging orderbook with the same orderHash + txHash
      // pair, marking the wrong environment's record as filled.
      if (typeof chainId !== "number" || chainId !== 1) {
        return res.status(400).json({ error: "Invalid or missing chainId" });
      }
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
        return res.status(400).json({ error: "Invalid or missing timestamp" });
      }
      const _nowSecFill = Math.floor(Date.now() / 1000);
      if (Math.abs(_nowSecFill - timestamp) > 300) {
        return res.status(400).json({ error: "Signature expired or clock-skewed; please re-sign" });
      }

      // Verify wallet signature to authenticate the filler
      const fillMessage = `Fill order ${orderHash} tx ${txHash} | Chain: ${chainId} | Time: ${timestamp}`;
      let filledBy;
      try {
        filledBy = (await recoverMessageAddress({ message: fillMessage, signature })).toLowerCase();
      } catch (e) {
        return res.status(400).json({ error: "Invalid signature" });
      }

      // Verify the transaction on-chain via Alchemy RPC
      const alchemyKey = process.env.ALCHEMY_API_KEY;
      const hasAlchemy = alchemyKey && alchemyKey !== "demo";

      // AUDIT FIX H-2: fail closed in production when Alchemy is unavailable.
      // The on-chain receipt + topic check is load-bearing — without it, an
      // attacker can sign `Fill order <real-hash> tx <any-random-hash>` and
      // mark a legitimate active order as `filled`, denying the real buyer.
      // Mirrors the policy in `_lib/seaport-verify.js` and `_lib/ratelimit.js`.
      const IS_PRODUCTION = process.env.NODE_ENV === "production";
      if (!hasAlchemy && IS_PRODUCTION) {
        return res.status(503).json({ error: "On-chain verification temporarily unavailable — please retry in a few minutes" });
      }

      // ── AUDIT F10: look up the canonical Seaport hash for this row ──
      // Verification logic:
      //   - row has seaport_order_hash → strict ABI-decode of OrderFulfilled
      //     `data` field (first bytes32 = orderHash) and bytes32 equality
      //   - row has NULL (legacy, pre-migration) → fall back to a presence
      //     check (canonical Seaport address + matching offerer in topic[1]).
      //     Legacy rows sunset at end_time — listings have a 7-day TTL, so
      //     this fallback is bounded.
      let storedSeaportHash = null;
      let orderMaker = null;
      {
        const { data: rowForVerify } = await supabase
          .from("native_orders")
          .select("seaport_order_hash, maker")
          .eq("order_hash", orderHash)
          .maybeSingle();
        if (rowForVerify) {
          storedSeaportHash = rowForVerify.seaport_order_hash || null;
          orderMaker = (rowForVerify.maker || "").toLowerCase();
        }
        // Don't 404 here — the atomic update below handles missing rows
        // with a single race-free path. If the row doesn't exist it'll
        // fail at the `update().eq("status","active")` step.
      }

      if (hasAlchemy) {
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
          // Verify the tx contains a Seaport OrderFulfilled event for this order.
          // OrderFulfilled signature:
          //   OrderFulfilled(bytes32 orderHash, address indexed offerer,
          //                  address indexed zone, address recipient,
          //                  SpentItem[] offer, ReceivedItem[] consideration)
          // → topic[0] = signature hash,
          //   topic[1] = indexed offerer (32-byte left-padded address),
          //   topic[2] = indexed zone,
          //   data     = ABI-encoded (orderHash, recipient, offer[], consideration[])
          const ORDER_FULFILLED_TOPIC = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31";
          // AUDIT API-M7 + REVIEW H-2-FINDING-1: pin the event origin to a CANONICAL
          // Seaport allowlist so a malicious contract emitting the same topic
          // signature from its own address cannot forge a fill record. Both Seaport
          // 1.5 (the default verifyingContract for client signatures) AND Seaport 1.6
          // (used by some fulfill routes) are accepted — the prior single-address
          // pin (1.6 only) DoS'd every fill that landed on Seaport 1.5.
          const SEAPORT_ADDRESSES = new Set([
            "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", // Seaport 1.5
            "0x0000000000000068f116a894984e2db1123eb395", // Seaport 1.6
          ]);

          // AUDIT F10: structural fix. The pre-fix logic was:
          //   topics[1].toLowerCase() === orderHash.toLowerCase()
          // …which compared an indexed-address topic (zero-padded) to the
          // application's sha256(JSON) hash — those types are unrelated and
          // could never match. Now we ABI-decode the `data` field and pull
          // the canonical orderHash from the first 32 bytes.
          let hasMatchingLog = false;
          for (const log of (receipt.logs || [])) {
            if (log.topics?.[0] !== ORDER_FULFILLED_TOPIC) continue;
            if (!SEAPORT_ADDRESSES.has(log.address?.toLowerCase())) continue;

            if (storedSeaportHash) {
              // Strict path: ABI-decode `data`, compare bytes32 orderHash.
              let decodedHash;
              try {
                const decoded = decodeAbiParameters(
                  parseAbiParameters(
                    "bytes32, address, (uint8,address,uint256,uint256)[], (uint8,address,uint256,uint256,address)[]"
                  ),
                  log.data,
                );
                decodedHash = (decoded[0] || "").toLowerCase();
              } catch {
                // Malformed log data — skip this log, try the next.
                continue;
              }
              if (decodedHash === storedSeaportHash) { hasMatchingLog = true; break; }
            } else {
              // Legacy fallback: presence-only — same Seaport-allowlisted
              // contract emitted OrderFulfilled with topic[1] (indexed
              // offerer) matching the row's recorded `maker`. This is
              // weaker than the strict path (any fill by the same maker
              // in the same tx satisfies it), but bounded by the row's
              // 7-day TTL and only applies to pre-migration rows.
              if (orderMaker) {
                const topicOfferer = ("0x" + (log.topics?.[1] || "").slice(-40)).toLowerCase();
                if (topicOfferer === orderMaker) { hasMatchingLog = true; break; }
              } else {
                // No stored hash AND no recorded maker — surface match
                // failure rather than guessing.
                hasMatchingLog = false;
              }
            }
          }
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

      if (error) { console.error("Orderbook error:", logSafe(error)); return res.status(500).json({ error: "Internal error" }); }

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
