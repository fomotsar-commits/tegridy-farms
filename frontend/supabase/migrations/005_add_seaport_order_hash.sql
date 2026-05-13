-- ============================================================
-- Migration 005: Add seaport_order_hash to native_orders
--
-- Source finding: F10 (Tegridy Farms monster code audit, scan8)
--
-- Pre-fix the orderbook fill verification was structurally broken:
--
--   const hasMatchingLog = receipt.logs.some(log =>
--     log.topics?.[0] === ORDER_FULFILLED_TOPIC &&
--     log.topics?.[1]?.toLowerCase() === orderHash.toLowerCase() &&  -- WRONG
--     SEAPORT_ADDRESSES.has(log.address?.toLowerCase())
--   );
--
-- Two compounding bugs:
--   1. Seaport's OrderFulfilled event is `OrderFulfilled(bytes32 orderHash,
--      address indexed offerer, address indexed zone, ...)`. topics[1] is
--      the indexed `offerer`, NOT the orderHash. The orderHash is the FIRST
--      non-indexed argument, encoded into the `data` field.
--   2. The application's stored `order_hash` (PRIMARY KEY) is
--      sha256(JSON(parameters)), which has no relationship to Seaport's
--      EIP-712 OrderComponents struct hash.
--
-- Net effect: NO legitimate Seaport fill ever satisfied the verification.
-- Every fill returned 400 "Transaction does not contain a matching Seaport
-- OrderFulfilled event", leaving rows stuck in `active` until end_time.
--
-- Fix: store Seaport's canonical struct-hash of OrderComponents in a NEW
-- column `seaport_order_hash`. The fill verifier ABI-decodes the
-- OrderFulfilled `data` field — first 32 bytes are orderHash — and
-- compares to this stored value.
--
-- Backwards compat: column is NULLABLE so existing rows survive the
-- migration. The fill handler falls back to a presence-only Seaport-log
-- check for legacy NULL rows; those rows will sunset at end_time
-- (orderbook listings have a 7-day default TTL).
--
-- Run in Supabase SQL editor AFTER 004_security_hardening.sql.
-- ============================================================

ALTER TABLE native_orders
  ADD COLUMN IF NOT EXISTS seaport_order_hash text;

-- Lookups during the fill handler match by seaport_order_hash. Index it
-- so verification stays cheap even with millions of historical rows.
-- Partial index on non-null values: (a) skips legacy null rows that
-- can't match anyway, (b) keeps the index small.
CREATE INDEX IF NOT EXISTS idx_orders_seaport_hash
  ON native_orders(seaport_order_hash)
  WHERE seaport_order_hash IS NOT NULL;

-- Sanity check on column shape: 0x-prefixed lowercase hex, 66 chars total
-- (0x + 64 hex digits = bytes32). Defense-in-depth — the API already
-- validates client input but a CHECK constraint protects against any
-- future code path that bypasses the API.
ALTER TABLE native_orders
  DROP CONSTRAINT IF EXISTS native_orders_seaport_hash_format;
ALTER TABLE native_orders
  ADD CONSTRAINT native_orders_seaport_hash_format
  CHECK (
    seaport_order_hash IS NULL
    OR seaport_order_hash ~ '^0x[0-9a-f]{64}$'
  );
