-- ============================================================
-- 031_venue_volume_nft_sources.sql: two more volume sources, NFT loans and NFT sales
--
-- The all-time volume (028_venue_volume.sql) gains two rows:
--   nft-lending     new loans on NFT Lending (our Gondi v3.2 loan contract on
--                   Ethereum), each at the WETH its lender paid out
--   nft-orderbook   sales on our own NFT order book (native_orders rows the order
--                   book marked filled after reading the sale on chain), each at its
--                   price
-- The counter (frontend/scripts/venue-volume.mjs) writes them like the others; this
-- only widens the check that names the sources a row may have.
--
-- 🔴 Apply BEFORE the code that counts them is deployed. The home page shows no volume
-- figure while any source has never been counted, and the counter cannot write these
-- two rows until this runs: deployed first, the line would read "could not be read"
-- until this is applied.
--
-- Apply by hand in the Supabase SQL editor (docs/TODO_OPERATOR.md). Needs 028. Touches
-- no other table and no row. Idempotent: re-running it is safe. Numbered 031 because
-- 029 and 030 are held (the open fill-scoreboard PR; 030_nft_loan_offers.sql).
-- ============================================================

ALTER TABLE venue_volume DROP CONSTRAINT IF EXISTS venue_volume_shape;
ALTER TABLE venue_volume
  ADD CONSTRAINT venue_volume_shape
  CHECK (
    source IN ('solana-pools', 'jupiter', 'ethereum', 'base', 'robinhood', 'nft-lending', 'nft-orderbook')
    AND swaps >= 0 AND usd >= 0 AND unpriced >= 0
    AND bot_swaps >= 0 AND bot_usd >= 0
    AND unpriced <= swaps AND bot_swaps <= swaps
    AND (last_error IS NULL OR length(last_error) <= 300)
  );

INSERT INTO public.schema_migrations (filename, note)
VALUES (
  '031_venue_volume_nft_sources.sql',
  'venue_volume_shape now also allows the sources nft-lending and nft-orderbook (NFT loans and NFT order-book sales in the all-time volume).'
)
ON CONFLICT (filename) DO NOTHING;

-- VERIFICATION, read-only:
--
-- select filename, applied_at from public.schema_migrations
--  where filename = '031_venue_volume_nft_sources.sql';          -- one row
--
-- select pg_get_constraintdef(oid) from pg_constraint
--  where conname = 'venue_volume_shape';                        -- names all seven sources
--
-- After the next count (every five minutes):
-- select source, swaps, usd, counted_to, last_error from venue_volume order by source;
