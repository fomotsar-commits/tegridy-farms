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
import { verifySeaportSignature, verifyNftOwnership, verifyBundleOwnership, fetchNftOwner, MAX_PRICE_WEI, priceWeiToEthNumber } from "./_lib/seaport-verify.js";
import { computeSeaportOrderHash, isValidSeaportOrderHash } from "./_lib/seaportHash.js";
// AUDIT FIX 2026-05-26 [H-20]: bound the Alchemy RPC response so a hostile /
// compromised RPC cannot OOM the lambda or rack up memory-time billing with a
// 100MB receipt or a gzip-bomb. Parity with the aggregator-proxy hardening.
import { readBoundedText, MAX_RESPONSE_BYTES } from "./_lib/bodycap.js";
import { sendPushToWallet } from "./_lib/push.js";

// Whitelist allowed contract addresses (lowercase)
const ALLOWED_CONTRACTS = new Set([
  "0xd774557b647330c91bf44cfeab205095f7e6c367", // Nakamigos
  "0xa1de9f93c56c290c48849b1393b09eb616d55dbb", // GNSS Art
  "0xd37264c71e9af940e49795f0d3a8336afaafdda9", // Jungle Bay
]);

// Max NFTs in one bundle listing. Bounds the per-item ownership RPC fan-out (one
// ownerOf call each) and the signed-message size. 50 is generous vs any real bundle.
const MAX_BUNDLE_ITEMS = 50;

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

    // ── P2P trades inbox/outbox ──
    // Trades are signed Seaport swap offers on public NFTs (same privacy
    // class as listings), so reads are open; writes are verified below.
    if (action === "trade-query") {
      const { wallet, role = "incoming" } = req.query;
      // The public board and feed need no wallet; inbox/outbox views do.
      if (role !== "board" && role !== "feed" && !isValidAddress(wallet || "")) {
        return res.status(400).json({ error: "Missing or invalid wallet" });
      }
      const tStatus = String(req.query.status || "active");
      const TRADE_STATUSES = new Set(["active", "accepted", "declined", "cancelled", "expired", "countered", "all"]);
      if (!TRADE_STATUSES.has(tStatus)) {
        return res.status(400).json({ error: "Invalid status filter" });
      }
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
      try {
        let q = supabase.from("trade_offers").select("*");
        if (role === "feed") {
          // Public per-collection feed of EXECUTED trades (activity surface).
          const feedContract = String(req.query.contract || "").toLowerCase();
          if (!ALLOWED_CONTRACTS.has(feedContract)) {
            return res.status(400).json({ error: "Missing or unsupported contract" });
          }
          const probe = JSON.stringify([{ contract: feedContract }]);
          q = q.eq("status", "accepted").or(`offered.cs.${probe},requested.cs.${probe}`);
        } else if (role === "board") {
          q = q.eq("is_open", true);
          if (tStatus !== "all") q = q.eq("status", tStatus);
        } else {
          q = role === "outgoing"
            ? q.eq("offerer", wallet.toLowerCase())
            : q.eq("target_owner", wallet.toLowerCase());
          if (tStatus !== "all") q = q.eq("status", tStatus);
        }
        const { data, error } = await q.order("created_at", { ascending: false }).limit(lim);
        if (error) throw new Error(error.message);
        // Surface expiry without a write: callers treat expired-but-active
        // rows as dead; the row itself sunsets via expires_at.
        const nowIso = new Date().toISOString();
        const trades = (data || []).map(t =>
          t.status === "active" && t.expires_at && t.expires_at < nowIso
            ? { ...t, status: "expired" }
            : t
        );
        res.setHeader("Cache-Control", "no-store");
        return res.json({ trades, count: trades.length });
      } catch (err) {
        console.error("Trade query degraded:", err?.message ?? err);
        res.setHeader("Cache-Control", "no-store");
        return res.json({ trades: [], count: 0, degraded: true });
      }
    }

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

    // Exclude bundle rows from the per-token listings feed (this handler also powers the
    // floor stat via fetchNativeListings), so a package-priced bundle can't poison the
    // per-token price_eth sort / collection floor. ENV-GATED because the is_bundle column
    // only exists after migration 012 — and enabling bundles REQUIRES that migration — so
    // a pre-enable deployment never references a missing column. (Bundle re-audit wf_ed656ebf.)
    if (process.env.BUNDLE_LISTING_ENABLED === "true") {
      query = query.eq("is_bundle", false);
    }

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

    // DEGRADED READS (2026-06-09): when the Supabase project is paused or
    // unreachable, the SDK burns ~7s of internal retries and resolves with
    // error 'TypeError: fetch failed' — and every marketplace listings view
    // hung behind this before erroring. Reads now race a short deadline and
    // degrade to an empty order list with `degraded: true`, so UIs render
    // external (OpenSea) listings immediately instead of stalling. WRITE
    // paths below intentionally stay loud (4xx/5xx) — silently dropping
    // order creates/cancels/fills would be worse than failing.
    const QUERY_DEADLINE_MS = 2500;
    let data, error;
    try {
      ({ data, error } = await Promise.race([
        query,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("orderbook read deadline exceeded")), QUERY_DEADLINE_MS)
        ),
      ]));
    } catch (err) {
      console.error("Orderbook degraded (read):", err?.message ?? err);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ orders: [], count: 0, degraded: true });
    }
    if (error) {
      console.error("Orderbook degraded (read):", error.message);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ orders: [], count: 0, degraded: true });
    }

    // PERF: a 5s edge TTL gave a near-zero hit ratio on the most-hit read, so
    // almost every listings view hit Supabase cold (which races a 2500ms
    // deadline). Active orders change on a seconds-to-minutes scale, so a 20s
    // shared cache + 60s stale-while-revalidate serves instant stale data and
    // revalidates in the background, collapsing the Supabase round-trip out of
    // perceived latency for the vast majority of reads.
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60");
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
      // AUDIT FIX F10-FOLLOWUP (2026-05-25): seaportOrderHash is now REQUIRED.
      // The fill verifier rejects every row whose seaport_order_hash is NULL
      // (the old "legacy fallback" that matched on indexed offerer was removed
      // because it let anyone replay a maker's past Seaport sale to mark an
      // unrelated active listing as filled). Accepting a NULL-hash create
      // therefore only produces a dead, unfilable listing that clutters the
      // book until its TTL — a free griefing/footgun vector. Reject at create
      // time instead. The frontend always supplies it
      // (src/nakamigos/lib/orderbook.js), so legitimate flows are unaffected.
      let seaportOrderHash = null;
      const clientSeaportHash = order.seaportOrderHash;
      if (clientSeaportHash === undefined || clientSeaportHash === null) {
        return res.status(400).json({ error: "Missing seaportOrderHash — required so the order can be verified at fill time" });
      }
      {
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

      if (error) { console.error("Orderbook error:", error.message); return res.status(500).json({ error: "Internal error" }); }
      return res.status(201).json({ success: true, orderHash, orderType });
    }

    // ═══ CREATE BUNDLE ═══
    // One Seaport order offering N NFTs for one total price (atomic all-or-none fill).
    // Isolated from the audited single `create` above so that path's blast radius stays
    // zero. Reuses the SAME audited helpers (verifySeaportSignature, computeSeaportOrderHash,
    // priceWeiToEthNumber) plus verifyBundleOwnership (per-item). NEW money-path: gated by
    // the BUNDLE_LISTING_ENABLED env kill-switch AND depends on migration 012 columns
    // (is_bundle, token_ids) — so a deployed-but-un-migrated build refuses bundles here
    // before any DB write.
    if (action === "create-bundle") {
      if (process.env.BUNDLE_LISTING_ENABLED !== "true") {
        return res.status(403).json({ error: "Bundle listing is not enabled" });
      }
      const { order } = req.body;
      if (!order?.parameters || !order?.signature) {
        return res.status(400).json({ error: "Missing order parameters or signature" });
      }
      const params = order.parameters;

      if (!params.offerer || typeof params.offerer !== "string") {
        return res.status(400).json({ error: "Missing or invalid offerer" });
      }
      if (!params.offer || !Array.isArray(params.offer) || params.offer.length < 2) {
        return res.status(400).json({ error: "A bundle must offer at least 2 NFTs" });
      }
      if (params.offer.length > MAX_BUNDLE_ITEMS) {
        return res.status(400).json({ error: `Bundle exceeds max ${MAX_BUNDLE_ITEMS} items` });
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
      if (endSec * 1000 < Date.now()) {
        return res.status(400).json({ error: "Order already expired" });
      }
      // Replay window — identical to `create` (startTime IS the sign timestamp).
      const MAX_SIGNATURE_AGE_SEC = 300;
      const nowSec = Math.floor(Date.now() / 1000);
      if (startSec < nowSec - MAX_SIGNATURE_AGE_SEC) {
        return res.status(400).json({ error: "Order signature is stale — resign with a fresh startTime" });
      }
      if (startSec > nowSec + MAX_SIGNATURE_AGE_SEC) {
        return res.status(400).json({ error: "Order startTime is too far in the future" });
      }

      // Every offer item must be a distinct ERC721 from an allowed collection.
      const bundleKeys = new Set();
      const bundleItems = [];
      for (const item of params.offer) {
        if (Number(item.itemType) !== 2) {
          return res.status(400).json({ error: "Bundle items must all be ERC721" });
        }
        const c = (item.token || "").toLowerCase();
        const tid = item.identifierOrCriteria;
        if (!c || !ALLOWED_CONTRACTS.has(c)) {
          return res.status(403).json({ error: "Bundle contains an unsupported collection" });
        }
        if (tid == null || !/^[0-9]+$/.test(String(tid))) {
          return res.status(400).json({ error: "Bundle item has an invalid tokenId" });
        }
        const key = `${c}:${tid}`;
        if (bundleKeys.has(key)) {
          return res.status(400).json({ error: "Bundle contains a duplicate NFT" });
        }
        bundleKeys.add(key);
        bundleItems.push({ contract: c, token_id: String(tid) });
      }

      // Single-collection bundles only. The row is stored + floored under
      // bundleItems[0].contract, so a cross-collection bundle would leak into one
      // collection's listings/floor at a price spanning others. Mirrors the audited
      // single path's H-4 mixed-currency guard. (Bundle re-audit finding 6.)
      if (new Set(bundleItems.map((i) => i.contract)).size !== 1) {
        return res.status(400).json({ error: "All NFTs in a bundle must be from the same collection" });
      }

      // Price: sum consideration (same as `create`'s listing branch), single currency, cap.
      const parseAmount = (raw) => {
        if (raw == null) return 0n;
        if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") throw new Error("amount out of range");
        const s = String(raw).trim();
        if (!/^[0-9]+$/.test(s)) throw new Error("amount out of range");
        return BigInt(s);
      };
      const considerationItem = params.consideration[0];
      const baseToken = (considerationItem?.token || "").toLowerCase();
      let priceWeiBig;
      try {
        let totalWei = 0n;
        for (const item of params.consideration) {
          if ((item?.token || "").toLowerCase() !== baseToken) {
            return res.status(400).json({ error: "Mixed-currency consideration not supported" });
          }
          const amt = parseAmount(item.startAmount);
          if (amt > MAX_PRICE_WEI) throw new Error("amount out of range");
          totalWei += amt;
        }
        priceWeiBig = totalWei;
      } catch (e) {
        return res.status(400).json({ error: "startAmount out of range or non-numeric" });
      }
      if (priceWeiBig > MAX_PRICE_WEI) {
        return res.status(400).json({ error: "priceWei out of range (exceeds MAX_PRICE_WEI cap)" });
      }
      const currencyAddr = baseToken || "0x0000000000000000000000000000000000000000";
      const decimals = TOKEN_DECIMALS[currencyAddr];
      if (decimals === undefined) {
        return res.status(400).json({ error: `Unsupported currency: ${currencyAddr}` });
      }
      const priceWei = priceWeiBig.toString();
      const priceEth = priceWeiToEthNumber(priceWeiBig, decimals);

      // Rebuild the deterministic items digest the client signed (bundleAuthItemsString)
      // from params.offer. IN LOCKSTEP with src/nakamigos/lib/orderbook.js — same format
      // (`${token.toLowerCase()}:${identifierOrCriteria}`, sorted, comma-joined).
      const itemsStr = params.offer
        .map((o) => `${(o.token || "").toLowerCase()}:${o.identifierOrCriteria}`)
        .sort()
        .join(",");
      const authPriceWei = considerationItem?.startAmount || "0";
      const createMessage = `Create bundle for ${params.offerer.toLowerCase()} | Items: ${itemsStr} | Count: ${params.offer.length} | Price: ${authPriceWei} | StartTime: ${startSec} | EndTime: ${endSec}`;
      let recoveredCreator;
      try {
        recoveredCreator = (await recoverMessageAddress({ message: createMessage, signature: order.signature })).toLowerCase();
      } catch (e) {
        return res.status(400).json({ error: "Invalid signature" });
      }
      if (recoveredCreator !== params.offerer.toLowerCase()) {
        return res.status(403).json({ error: "Signer does not match offerer" });
      }

      // Independently verify the Seaport EIP-712 signature over the FULL multi-item order.
      const seaportSig = order.seaportSignature || order.signature;
      const sigCheck = await verifySeaportSignature({ parameters: params, signature: seaportSig });
      if (!sigCheck.ok) {
        const status = sigCheck.error === "rpc-unavailable" ? 503 : 403;
        return res.status(status).json({ error: `Seaport signature verification failed: ${sigCheck.error}` });
      }

      // On-chain ownership for EVERY item — offerer must own all N.
      const ownerCheck = await verifyBundleOwnership({ parameters: params });
      if (!ownerCheck.ok) {
        let status, message;
        if (ownerCheck.error === "rpc-unavailable") {
          status = 503; message = "On-chain ownership verification temporarily unavailable";
        } else if (ownerCheck.error === "token-not-found" || ownerCheck.error === "no-offer-item" || ownerCheck.error === "no-token-id") {
          status = 400; message = `NFT ownership check failed: ${ownerCheck.error}`;
        } else {
          status = 403; message = "Offerer does not own every NFT in the bundle";
        }
        return res.status(status).json({ error: message });
      }

      // Rate limit: same 20/maker/hour as `create`.
      const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
      const { count: makerOrderCount } = await supabase
        .from("native_orders")
        .select("*", { count: "exact", head: true })
        .eq("maker", recoveredCreator)
        .gte("created_at", oneHourAgo);
      if (makerOrderCount != null && makerOrderCount >= 20) {
        return res.status(429).json({ error: "Rate limit exceeded — max 20 orders per hour" });
      }

      // App primary-key hash (sha256 of canonical params) — same scheme as `create`.
      const hashInput = JSON.stringify({
        offerer: params.offerer?.toLowerCase(),
        offer: params.offer,
        consideration: params.consideration,
        startTime: params.startTime,
        endTime: params.endTime,
        salt: params.salt || randomUUID(),
      });
      const orderHash = "0x" + createHash("sha256").update(hashInput).digest("hex");

      // Canonical Seaport orderHash — REQUIRED (fill verifier rejects NULL). Same
      // client-provides + server-re-derives defense-in-depth as `create`; multi-item
      // is handled by computeSeaportOrderHash (hashes the full offer array).
      const clientSeaportHash = order.seaportOrderHash;
      if (clientSeaportHash === undefined || clientSeaportHash === null) {
        return res.status(400).json({ error: "Missing seaportOrderHash — required so the order can be verified at fill time" });
      }
      if (!isValidSeaportOrderHash(clientSeaportHash)) {
        return res.status(400).json({ error: "Invalid seaportOrderHash format (expected 0x + 64 lowercase hex)" });
      }
      const counter = order.seaportCounter;
      if (counter == null) {
        return res.status(400).json({ error: "Missing seaportCounter — required to derive canonical orderHash" });
      }
      let counterBig;
      try {
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
      let derivedHash;
      try {
        derivedHash = computeSeaportOrderHash(params, counterBig);
      } catch (e) {
        return res.status(400).json({ error: "Could not derive Seaport orderHash from parameters" });
      }
      if (derivedHash !== clientSeaportHash.toLowerCase()) {
        return res.status(400).json({ error: "seaportOrderHash mismatch — client hash does not match server-derived hash" });
      }

      // Store: token_id NULL (a bundle spans many); is_bundle true; token_ids = the full
      // set (migration 012 columns). contract_address is the first item's collection as a
      // representative — every item also lives in `parameters.offer` and `token_ids`.
      const { error: insertErr } = await supabase.from("native_orders").insert({
        order_hash: orderHash,
        order_type: "listing",
        contract_address: bundleItems[0].contract,
        token_id: null,
        is_bundle: true,
        token_ids: bundleItems,
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
        seaport_order_hash: derivedHash,
      });
      if (insertErr) {
        // 23505 = unique_violation: the same signed order was already stored (retry
        // after a lost response) — idempotent success rather than a spurious 500.
        if (insertErr.code === "23505") {
          return res.status(200).json({ success: true, orderHash, duplicate: true });
        }
        console.error("Bundle insert failed:", insertErr.message);
        return res.status(500).json({ error: "Failed to store bundle order" });
      }
      return res.status(201).json({ success: true, orderHash, orderType: "listing", bundle: true });
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

      if (error) { console.error("Orderbook error:", error.message); return res.status(500).json({ error: "Internal error" }); }
      return res.json({ success: true });
    }

    if (action === "cancel-all") {
      // Single-signature blanket cancel of every active order by ONE maker — used
      // after the on-chain Seaport incrementCounter() (which already invalidates
      // all of the maker's orders atomically). One signature replaces the old
      // one-signature-per-listing flow that popped N wallet prompts AFTER the
      // on-chain cancel had already succeeded. Same chainId+timestamp replay
      // protection as the single cancel above, and the update is scoped to the
      // RECOVERED signer, so a maker can only ever cancel their own orders.
      const { maker, signature, chainId, timestamp } = req.body;
      if (!maker || !signature) return res.status(400).json({ error: "Missing maker or signature" });
      if (!isValidAddress(maker)) return res.status(400).json({ error: "Invalid maker address" });
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

      const cancelMessage = `Cancel all orders | Chain: ${chainId} | Time: ${timestamp}`;
      let recoveredAddress;
      try {
        recoveredAddress = (await recoverMessageAddress({ message: cancelMessage, signature })).toLowerCase();
      } catch (e) {
        return res.status(400).json({ error: "Invalid signature" });
      }
      if (recoveredAddress !== maker.toLowerCase()) {
        return res.status(403).json({ error: "Signer is not the maker" });
      }

      const { data: cancelled, error } = await supabase
        .from("native_orders")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("maker", recoveredAddress)
        .eq("status", "active")
        .select("order_hash");

      if (error) { console.error("Orderbook cancel-all error:", error.message); return res.status(500).json({ error: "Internal error" }); }
      return res.json({ success: true, cancelled: cancelled?.length ?? 0 });
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
          // AUDIT FIX 2026-05-26 [H-20]: bounded read. A 100MB receipt or gzip-bomb
          // upstream would otherwise OOM the lambda. readBoundedText cancels mid-stream.
          const { text: rpcBodyText, truncated } = await readBoundedText(rpcRes, MAX_RESPONSE_BYTES);
          if (truncated) {
            console.error("Alchemy RPC response over cap:", txHash);
            return res.status(502).json({ error: "On-chain verification temporarily unavailable — please retry in a few minutes" });
          }
          let rpcData;
          try { rpcData = JSON.parse(rpcBodyText); } catch {
            return res.status(502).json({ error: "On-chain verification temporarily unavailable — please retry in a few minutes" });
          }
          const receipt = rpcData?.result;
          if (!receipt) {
            return res.status(400).json({ error: "Transaction not found on-chain — it may still be pending" });
          }
          if (receipt.status !== "0x1") {
            return res.status(400).json({ error: "Transaction reverted on-chain" });
          }
          // AUDIT FIX 2026-05-26 [H-23]: cap log-count to prevent a 100k-log receipt
          // from stalling per-request CPU budget. Real Seaport fills have <10 logs;
          // 256 is generous headroom for batched fills sharing one tx.
          if (Array.isArray(receipt.logs) && receipt.logs.length > 256) {
            return res.status(400).json({ error: "Transaction log count exceeds verification budget" });
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
            }
            // No legacy fallback: rows without `seaport_order_hash` cannot be
            // marked filled via this endpoint. The prior fallback compared the
            // event's indexed offerer to the row's `maker`, which let any
            // attacker who could observe ANY past Seaport sale by `maker`
            // submit that tx hash and mark an unrelated active legacy listing
            // as filled. Pre-migration rows expire on their own 7-day TTL.
          }
          if (!hasMatchingLog) {
            return res.status(400).json({
              error: storedSeaportHash
                ? "Transaction does not contain a matching Seaport OrderFulfilled event"
                : "Legacy listing without canonical order hash cannot be marked filled; please re-list",
            });
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

    // ═══ P2P TRADE ACTIONS ═══
    // A trade is ONE signed Seaport swap order (offer = maker NFTs + optional
    // WETH; consideration = requested NFTs to maker + optional native ETH to
    // maker). Settlement is canonical Seaport.fulfillOrder — no custom escrow
    // (NFT Trader Dec-2023 lesson). Counterparty restriction is ownership-
    // gated on-chain; target_owner is the soft pin this API verifies.

    if (action === "trade-create") {
      const { trade } = req.body;
      if (!trade?.parameters || !trade?.seaportSignature || !trade?.authSignature) {
        return res.status(400).json({ error: "Missing trade parameters or signatures" });
      }
      const params = trade.parameters;
      const isOpen = trade.open === true;
      const taker = isOpen ? null : String(trade.taker || "").toLowerCase();
      if (!isOpen && !isValidAddress(taker)) return res.status(400).json({ error: "Missing or invalid taker" });
      if (!params.offerer || typeof params.offerer !== "string" || !isValidAddress(params.offerer)) {
        return res.status(400).json({ error: "Missing or invalid offerer" });
      }
      const offerer = params.offerer.toLowerCase();
      if (!isOpen && taker === offerer) return res.status(400).json({ error: "Cannot trade with yourself" });
      if (!Array.isArray(params.offer) || !Array.isArray(params.consideration)) {
        return res.status(400).json({ error: "Malformed offer/consideration" });
      }

      // Same replay window as listing creation: startTime ≈ sign time.
      const startSec = parseInt(params.startTime);
      const endSec = parseInt(params.endTime);
      if (isNaN(startSec) || isNaN(endSec) || endSec <= startSec) {
        return res.status(400).json({ error: "Invalid startTime/endTime" });
      }
      if (endSec * 1000 < Date.now()) return res.status(400).json({ error: "Trade already expired" });
      const nowSecT = Math.floor(Date.now() / 1000);
      if (startSec < nowSecT - 300 || startSec > nowSecT + 300) {
        return res.status(400).json({ error: "Trade signature is stale — re-sign with a fresh startTime" });
      }
      // 30-day ceiling keeps zombie signed orders bounded.
      if (endSec - startSec > 30 * 24 * 3600) {
        return res.status(400).json({ error: "Trade expiry too far out (max 30 days)" });
      }

      // Pin the protocol shape: FULL_OPEN + zero zone + canonical conduit.
      // (orderType 2 is FULL_RESTRICTED — unfulfillable with a zero zone.)
      const CANONICAL_CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";
      if (Number(params.orderType) !== 0) return res.status(400).json({ error: "Trades must use orderType 0 (FULL_OPEN)" });
      if ((params.zone || "").toLowerCase() !== "0x0000000000000000000000000000000000000000") {
        return res.status(400).json({ error: "Trades must use the zero zone" });
      }
      if ((params.conduitKey || "").toLowerCase() !== CANONICAL_CONDUIT_KEY) {
        return res.status(400).json({ error: "Trades must use the canonical conduit" });
      }

      // ── Item shape validation ──
      const WETH_ADDR = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
      const MAX_TRADE_ITEMS = 6;
      const parseAmt = (raw) => {
        const s = String(raw ?? "").trim();
        if (!/^[0-9]+$/.test(s)) throw new Error("non-numeric amount");
        const v = BigInt(s);
        if (v > MAX_PRICE_WEI) throw new Error("amount over cap");
        return v;
      };

      const givenNfts = [];
      let wethTopupWei = 0n;
      // Dutch legs: cash items may interpolate startAmount→endAmount (Seaport
      // does this natively); NFT legs must stay exactly 1/1. Stored topup
      // columns carry the MAX of each leg — the maker's full commitment.
      const maxLeg = (item) => {
        const a = parseAmt(item.startAmount);
        const b = parseAmt(item.endAmount);
        return a > b ? a : b;
      };
      const assertStaticNft = (item) => {
        if (String(item.startAmount) !== "1" || String(item.endAmount) !== "1") {
          throw new Error("nft amount not 1");
        }
      };
      try {
        for (const item of params.offer) {
          const t = Number(item.itemType);
          if (t === 2) {
            const token = (item.token || "").toLowerCase();
            if (!ALLOWED_CONTRACTS.has(token)) return res.status(403).json({ error: "Offered collection not supported" });
            if (!isValidTokenId(String(item.identifierOrCriteria))) return res.status(400).json({ error: "Invalid offered tokenId" });
            assertStaticNft(item);
            givenNfts.push({ contract: token, tokenId: String(item.identifierOrCriteria) });
          } else if (t === 1) {
            if ((item.token || "").toLowerCase() !== WETH_ADDR) return res.status(400).json({ error: "Maker cash leg must be WETH" });
            wethTopupWei += maxLeg(item);
          } else {
            // Native ETH cannot be an offer item — Seaport can't pull it from a maker.
            return res.status(400).json({ error: "Unsupported offer itemType" });
          }
        }
        if (givenNfts.length === 0) return res.status(400).json({ error: "Trade must offer at least one NFT" });
        if (givenNfts.length > MAX_TRADE_ITEMS) return res.status(400).json({ error: "Too many offered NFTs" });

        const requestedNfts = [];
        let ethTopupWei = 0n;
        for (const item of params.consideration) {
          const t = Number(item.itemType);
          const recipient = (item.recipient || "").toLowerCase();
          if (recipient !== offerer) {
            // Every consideration leg must pay the maker — anything else is
            // value leaking to a third party hidden inside the signed order.
            return res.status(400).json({ error: "All consideration must route to the trade creator" });
          }
          if (t === 2) {
            // Directed trades only: a specific token implies a specific owner
            // to pin; open (board) trades must be all-wildcard.
            if (isOpen) return res.status(400).json({ error: "Open trades must request collections, not specific tokens" });
            const token = (item.token || "").toLowerCase();
            if (!ALLOWED_CONTRACTS.has(token)) return res.status(403).json({ error: "Requested collection not supported" });
            if (!isValidTokenId(String(item.identifierOrCriteria))) return res.status(400).json({ error: "Invalid requested tokenId" });
            assertStaticNft(item);
            requestedNfts.push({ contract: token, tokenId: String(item.identifierOrCriteria) });
          } else if (t === 4) {
            // Wildcard criteria slot — board trades only, and ONLY the
            // "criteria root 0 = any token from collection" form. Non-zero
            // roots (trait merkle trees) are not supported in v1.
            if (!isOpen) return res.status(400).json({ error: "Wildcard slots are only allowed on open trades" });
            const token = (item.token || "").toLowerCase();
            if (!ALLOWED_CONTRACTS.has(token)) return res.status(403).json({ error: "Requested collection not supported" });
            if (String(item.identifierOrCriteria) !== "0") {
              return res.status(400).json({ error: "Only any-token wildcards are supported" });
            }
            assertStaticNft(item);
            requestedNfts.push({ contract: token, tokenId: null, any: true });
          } else if (t === 0) {
            ethTopupWei += maxLeg(item);
          } else {
            return res.status(400).json({ error: "Unsupported consideration itemType" });
          }
        }
        if (requestedNfts.length === 0) return res.status(400).json({ error: "Trade must request at least one NFT" });
        if (requestedNfts.length > MAX_TRADE_ITEMS) return res.status(400).json({ error: "Too many requested NFTs" });
        if (isOpen && !requestedNfts.every((n) => n.any)) {
          return res.status(400).json({ error: "Open trades must be all-wildcard" });
        }

        // ── Auth signature binds offerer + taker + canonical hash + window ──
        const tHash = String(trade.seaportOrderHash || "");
        if (!isValidSeaportOrderHash(tHash)) {
          return res.status(400).json({ error: "Invalid seaportOrderHash format" });
        }
        const takerTag = isOpen ? "open" : taker;
        const authMessage = `Create trade for ${offerer} | Taker: ${takerTag} | Hash: ${tHash.toLowerCase()} | StartTime: ${startSec} | EndTime: ${endSec}`;
        let recovered;
        try {
          recovered = (await recoverMessageAddress({ message: authMessage, signature: trade.authSignature })).toLowerCase();
        } catch {
          return res.status(400).json({ error: "Invalid auth signature" });
        }
        if (recovered !== offerer) return res.status(403).json({ error: "Signer does not match offerer" });

        // ── Seaport EIP-712 signature must validate against the SAME params ──
        const sigCheck = await verifySeaportSignature({ parameters: params, signature: trade.seaportSignature });
        if (!sigCheck.ok) {
          const status = sigCheck.error === "rpc-unavailable" ? 503 : 403;
          return res.status(status).json({ error: `Seaport signature verification failed: ${sigCheck.error}` });
        }

        // ── Canonical hash re-derivation (F10 parity) ──
        const counterRaw = trade.seaportCounter;
        if (counterRaw == null || !/^[0-9]+$/.test(String(counterRaw))) {
          return res.status(400).json({ error: "Missing or invalid seaportCounter" });
        }
        let derivedHash;
        try {
          derivedHash = computeSeaportOrderHash(params, BigInt(String(counterRaw)));
        } catch {
          return res.status(400).json({ error: "Could not derive Seaport orderHash from parameters" });
        }
        if (derivedHash !== tHash.toLowerCase()) {
          return res.status(400).json({ error: "seaportOrderHash mismatch" });
        }

        // ── Live ownership: maker owns every offered NFT, taker owns every
        //    requested NFT (also proves target_owner is the right wallet).
        //    fetchNftOwner THROWS: OWNER_OF_REVERT/EMPTY → bad token (4xx);
        //    anything else (RPC/config) → fail closed with 503.
        const ownerOf = async (nft) => {
          try {
            return await fetchNftOwner(nft.contract, nft.tokenId);
          } catch (err) {
            if (err.code === "OWNER_OF_REVERT" || err.code === "OWNER_OF_EMPTY") {
              const e = new Error(`Token ${nft.contract.slice(0, 8)}… #${nft.tokenId} not found`);
              e.httpStatus = 400;
              throw e;
            }
            const e = new Error("Ownership verification temporarily unavailable");
            e.httpStatus = 503;
            throw e;
          }
        };
        try {
          for (const nft of givenNfts) {
            if ((await ownerOf(nft)) !== offerer) {
              return res.status(403).json({ error: `You do not own ${nft.contract.slice(0, 8)}… #${nft.tokenId}` });
            }
          }
          // Open trades have no taker and no specific tokens to pin.
          if (!isOpen) {
            for (const nft of requestedNfts) {
              if ((await ownerOf(nft)) !== taker) {
                return res.status(400).json({ error: `Counterparty does not own ${nft.contract.slice(0, 8)}… #${nft.tokenId}` });
              }
            }
          }
        } catch (err) {
          return res.status(err.httpStatus || 503).json({ error: err.message });
        }

        // Per-maker creation throttle (parity with listings: 20/hr)
        const oneHourAgoT = new Date(Date.now() - 3600000).toISOString();
        const { count: makerTradeCount } = await supabase
          .from("trade_offers")
          .select("*", { count: "exact", head: true })
          .eq("offerer", offerer)
          .gte("created_at", oneHourAgoT);
        if (makerTradeCount != null && makerTradeCount >= 20) {
          return res.status(429).json({ error: "Rate limit exceeded — max 20 trades per hour" });
        }

        // Counter-offer linkage: valid only when the new maker is the parent's
        // taker and vice versa; parent flips to `countered`.
        let counterOf = null;
        if (trade.counterOf && !isOpen) {
          const cid = String(trade.counterOf);
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cid)) {
            const { data: parent } = await supabase
              .from("trade_offers")
              .select("id, offerer, target_owner, status")
              .eq("id", cid)
              .maybeSingle();
            if (parent && parent.status === "active" && parent.offerer === taker && parent.target_owner === offerer) {
              counterOf = parent.id;
              await supabase
                .from("trade_offers")
                .update({ status: "countered", updated_at: new Date().toISOString() })
                .eq("id", parent.id)
                .eq("status", "active");
            }
          }
        }

        const offerHash = "0x" + createHash("sha256").update(JSON.stringify({
          offerer, taker, offer: params.offer, consideration: params.consideration,
          startTime: params.startTime, endTime: params.endTime, salt: params.salt,
        })).digest("hex");

        const row = {
          offer_hash: offerHash,
          offerer,
          target_owner: taker, // null for open (board) trades
          is_open: isOpen,
          offered: givenNfts,
          requested: requestedNfts,
          eth_topup_wei: ethTopupWei.toString(),
          weth_topup_wei: wethTopupWei.toString(),
          signature: trade.seaportSignature,
          parameters: params,
          protocol_address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
          seaport_order_hash: derivedHash,
          counter_of: counterOf,
          status: "active",
          expires_at: new Date(endSec * 1000).toISOString(),
        };
        const { data: inserted, error } = await supabase.from("trade_offers").insert(row).select().single();
        if (error) {
          // Graceful pre-migration message instead of a bare 500
          if (/column|relation/i.test(error.message)) {
            console.error("trade-create schema missing:", error.message);
            return res.status(503).json({ error: "Trades are not enabled yet (migration 007 pending)" });
          }
          console.error("trade-create error:", error.message);
          return res.status(500).json({ error: "Internal error" });
        }
        // Push to the named taker (open board posts have no recipient).
        // Bounded + never throws — a push hiccup must not fail the trade.
        if (!isOpen) {
          await sendPushToWallet(supabase, taker, {
            title: "New trade offer ⇄",
            body: `${offerer.slice(0, 6)}…${offerer.slice(-4)} wants to trade ${givenNfts.length} NFT${givenNfts.length !== 1 ? "s" : ""} with you`,
            url: "/nakamigos/nakamigos/trades",
            tag: `trade-${inserted.id}`,
          });
        }
        return res.json({ success: true, trade: inserted });
      } catch (e) {
        if (e.message === "non-numeric amount" || e.message === "amount over cap") {
          return res.status(400).json({ error: "Topup amount out of range" });
        }
        if (e.message === "nft amount not 1") {
          return res.status(400).json({ error: "NFT legs must be exactly 1/1 — only cash legs may be dynamic" });
        }
        console.error("trade-create error:", e?.message ?? e);
        return res.status(500).json({ error: "Internal error" });
      }
    }

    if (action === "trade-decline" || action === "trade-cancel") {
      const { tradeId, signature, timestamp } = req.body;
      if (!tradeId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(tradeId))) {
        return res.status(400).json({ error: "Missing or invalid tradeId" });
      }
      if (typeof timestamp !== "number" || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) {
        return res.status(400).json({ error: "Signature expired or clock-skewed; please re-sign" });
      }
      const verb = action === "trade-decline" ? "Decline" : "Cancel";
      let signer;
      try {
        signer = (await recoverMessageAddress({
          message: `${verb} trade ${tradeId} | Chain: 1 | Time: ${timestamp}`,
          signature,
        })).toLowerCase();
      } catch {
        return res.status(400).json({ error: "Invalid signature" });
      }
      const { data: row } = await supabase
        .from("trade_offers")
        .select("id, offerer, target_owner, status")
        .eq("id", tradeId)
        .maybeSingle();
      if (!row) return res.status(404).json({ error: "Trade not found" });
      if (row.status !== "active") return res.status(409).json({ error: `Trade is already ${row.status}` });
      if (action === "trade-decline" && !row.target_owner) {
        // Open board posts have no recipient — only the maker can cancel.
        return res.status(400).json({ error: "Open trades cannot be declined" });
      }
      const allowed = action === "trade-decline" ? row.target_owner : row.offerer;
      if (signer !== allowed) {
        return res.status(403).json({ error: action === "trade-decline" ? "Only the recipient can decline" : "Only the creator can cancel" });
      }
      const patch = action === "trade-decline"
        ? { status: "declined", declined_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        : { status: "cancelled", cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const { error } = await supabase.from("trade_offers").update(patch).eq("id", tradeId).eq("status", "active");
      if (error) { console.error("trade status error:", error.message); return res.status(500).json({ error: "Internal error" }); }
      if (action === "trade-decline") {
        await sendPushToWallet(supabase, row.offerer, {
          title: "Trade declined",
          body: "Your trade offer was declined — counter with different terms?",
          url: "/nakamigos/nakamigos/trades",
          tag: `trade-${tradeId}`,
        });
      }
      return res.json({ success: true });
    }

    if (action === "trade-fill") {
      const { tradeId, txHash, signature, timestamp } = req.body;
      if (!tradeId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(tradeId))) {
        return res.status(400).json({ error: "Missing or invalid tradeId" });
      }
      if (!txHash || typeof txHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        return res.status(400).json({ error: "Missing or invalid txHash" });
      }
      if (typeof timestamp !== "number" || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) {
        return res.status(400).json({ error: "Signature expired or clock-skewed; please re-sign" });
      }
      let filler;
      try {
        filler = (await recoverMessageAddress({
          message: `Fill trade ${tradeId} tx ${txHash} | Chain: 1 | Time: ${timestamp}`,
          signature,
        })).toLowerCase();
      } catch {
        return res.status(400).json({ error: "Invalid signature" });
      }

      const { data: row } = await supabase
        .from("trade_offers")
        .select("id, offerer, target_owner, status, seaport_order_hash")
        .eq("id", tradeId)
        .maybeSingle();
      if (!row) return res.status(404).json({ error: "Trade not found" });
      // Directed trades pin the filler to the named taker. Open (board)
      // trades have no taker — anyone may report the fill, and the
      // OrderFulfilled receipt check below is the real gate on truth.
      if (row.target_owner && filler !== row.target_owner) {
        return res.status(403).json({ error: "Only the trade recipient can mark it filled" });
      }
      if (filler === row.offerer) {
        return res.status(403).json({ error: "The trade creator cannot mark their own trade filled" });
      }
      if (!row.seaport_order_hash) return res.status(400).json({ error: "Trade lacks canonical order hash" });

      // Same fail-closed on-chain verification as listing fills (H-2/F10):
      // the OrderFulfilled event in the receipt must carry this exact hash.
      const alchemyKey = process.env.ALCHEMY_API_KEY;
      const hasAlchemy = alchemyKey && alchemyKey !== "demo";
      if (!hasAlchemy && process.env.NODE_ENV === "production") {
        return res.status(503).json({ error: "On-chain verification temporarily unavailable — please retry in a few minutes" });
      }
      if (hasAlchemy) {
        try {
          const rpcRes = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
          });
          const { text: rpcBodyText, truncated } = await readBoundedText(rpcRes, MAX_RESPONSE_BYTES);
          if (truncated) return res.status(502).json({ error: "On-chain verification temporarily unavailable" });
          let rpcData;
          try { rpcData = JSON.parse(rpcBodyText); } catch {
            return res.status(502).json({ error: "On-chain verification temporarily unavailable" });
          }
          const receipt = rpcData?.result;
          if (!receipt) return res.status(400).json({ error: "Transaction not found on-chain — it may still be pending" });
          if (receipt.status !== "0x1") return res.status(400).json({ error: "Transaction reverted on-chain" });
          if (Array.isArray(receipt.logs) && receipt.logs.length > 256) {
            return res.status(400).json({ error: "Transaction log count exceeds verification budget" });
          }
          const ORDER_FULFILLED_TOPIC = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31";
          const SEAPORT_ADDRESSES = new Set([
            "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
            "0x0000000000000068f116a894984e2db1123eb395",
          ]);
          let matched = false;
          for (const log of (receipt.logs || [])) {
            if (log.topics?.[0] !== ORDER_FULFILLED_TOPIC) continue;
            if (!SEAPORT_ADDRESSES.has(log.address?.toLowerCase())) continue;
            try {
              const decoded = decodeAbiParameters(
                parseAbiParameters("bytes32, address, (uint8,address,uint256,uint256)[], (uint8,address,uint256,uint256,address)[]"),
                log.data,
              );
              if ((decoded[0] || "").toLowerCase() === row.seaport_order_hash) { matched = true; break; }
            } catch { continue; }
          }
          if (!matched) {
            return res.status(400).json({ error: "Transaction does not contain a matching Seaport OrderFulfilled event" });
          }
        } catch (rpcErr) {
          console.error("Trade fill verification failed, rejecting:", rpcErr.message);
          return res.status(503).json({ error: "On-chain verification temporarily unavailable — please retry in a few minutes" });
        }
      }

      // One tx fills one trade
      const { count: txUsed } = await supabase
        .from("trade_offers")
        .select("*", { count: "exact", head: true })
        .eq("accepted_tx", txHash)
        .eq("status", "accepted");
      if (txUsed != null && txUsed > 0) {
        return res.status(409).json({ error: "This transaction hash has already been used" });
      }

      const { data: updated, error } = await supabase
        .from("trade_offers")
        .update({ status: "accepted", accepted_tx: txHash, updated_at: new Date().toISOString() })
        .eq("id", tradeId)
        .eq("status", "active")
        .select();
      if (error) { console.error("trade-fill error:", error.message); return res.status(500).json({ error: "Internal error" }); }
      if (!updated || updated.length === 0) {
        return res.status(409).json({ error: "Trade is no longer active" });
      }
      await sendPushToWallet(supabase, row.offerer, {
        title: "Trade executed ✓",
        body: "Your trade was accepted and settled on-chain",
        url: "/nakamigos/nakamigos/trades",
        tag: `trade-${tradeId}`,
      });
      return res.json({ success: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
