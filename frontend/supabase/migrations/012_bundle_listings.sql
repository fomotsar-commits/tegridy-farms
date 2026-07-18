-- ============================================================
-- Migration 012: Bundle listings (multi-NFT "list as a package")
--
-- Adds support for a native listing that offers N NFTs for one total price,
-- fulfillable atomically via a single Seaport order (buyer gets all N or none).
-- Server path: api/orderbook.js `action: "create-bundle"` (env-gated behind
-- BUNDLE_LISTING_ENABLED). Client path: src/nakamigos/lib/orderbook.js
-- createNativeBundleListing (gated behind constants BUNDLE_LISTING_ENABLED).
--
-- A single listing stores ONE token_id. A bundle can't, so:
--   * token_id       -> NULL for bundles (already nullable)
--   * is_bundle       -> true for bundles, false (default) for singles
--   * token_ids       -> jsonb array of { contract, token_id } for bundles; NULL otherwise
-- All the NFTs also live inside `parameters.offer` (already stored), so `token_ids`
-- is a denormalized, query-friendly projection of the offer set.
--
-- SAFETY: purely additive. Existing rows get is_bundle=false + token_ids=NULL and
-- keep working unchanged. The create-bundle handler is OFF until
-- BUNDLE_LISTING_ENABLED=true is set on the server, so no bundle row can be written
-- before this migration is applied AND the flag is flipped AND a re-audit passes.
--
-- Run in the Supabase SQL editor AFTER 011_reaction_jwt_binding.sql.
-- ============================================================

ALTER TABLE native_orders
  ADD COLUMN IF NOT EXISTS is_bundle boolean NOT NULL DEFAULT false;

ALTER TABLE native_orders
  ADD COLUMN IF NOT EXISTS token_ids jsonb;

-- Shape invariant (defense-in-depth; the API already enforces this):
--   * bundle rows      -> is_bundle = true,  token_ids IS NOT NULL, token_id IS NULL
--   * non-bundle rows  -> is_bundle = false, token_ids IS NULL
ALTER TABLE native_orders
  DROP CONSTRAINT IF EXISTS native_orders_bundle_shape;
ALTER TABLE native_orders
  ADD CONSTRAINT native_orders_bundle_shape
  CHECK (
    (is_bundle = true  AND token_ids IS NOT NULL AND token_id IS NULL)
    OR
    (is_bundle = false AND token_ids IS NULL)
  );

-- Cheap "does any active bundle exist for this collection" style filtering.
-- Partial index keeps it tiny (bundles are the rare case).
CREATE INDEX IF NOT EXISTS idx_orders_bundle
  ON native_orders(contract_address, status)
  WHERE is_bundle = true;
