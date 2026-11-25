-- ============================================================
-- 033_venue_volume_hyperevm.sql: one more volume source, our Uniswap V3 pools on HyperEVM
--
-- The all-time volume (028_venue_volume.sql) gains one row:
--   hyperevm   swaps in the pools of our own Uniswap V3 factory on HyperEVM (chain 999,
--              factory 0xcaDc93E96De58EA554c71ca609974625615E046D, deployed 2026-11-25),
--              each at its dollar side, or its WHYPE side at HYPE's price
-- The counter (frontend/scripts/venue-volume.mjs) writes it like the others once the
-- factory is set in scripts/lib/venue-volume-chain.mjs; this only widens the check that
-- names the sources a row may have.
--
-- 🔴 Apply BEFORE the code that counts it is merged. With the factory set, the public total
-- names HyperEVM as a source and reads "unread" (no figure on the home page) until the
-- hyperevm row exists, and the counter cannot write that row until this runs. After the
-- merge, run the "Venue volume" workflow once by hand so the row is written at once rather
-- than at the next hourly run.
--
-- Apply by hand in the Supabase SQL editor (docs/TODO_OPERATOR.md). Needs 031. Touches
-- no other table and no row. Idempotent: re-running it is safe. Numbered 033 because 029 is
-- held (the open fill-scoreboard PR) and 030 to 032 are taken.
-- ============================================================

ALTER TABLE venue_volume DROP CONSTRAINT IF EXISTS venue_volume_shape;
ALTER TABLE venue_volume
  ADD CONSTRAINT venue_volume_shape
  CHECK (
    source IN ('solana-pools', 'jupiter', 'ethereum', 'base', 'robinhood', 'nft-lending', 'nft-orderbook', 'hyperevm')
    AND swaps >= 0 AND usd >= 0 AND unpriced >= 0
    AND bot_swaps >= 0 AND bot_usd >= 0
    AND unpriced <= swaps AND bot_swaps <= swaps
    AND (last_error IS NULL OR length(last_error) <= 300)
  );

INSERT INTO public.schema_migrations (filename, note)
VALUES (
  '033_venue_volume_hyperevm.sql',
  'venue_volume_shape now also allows the source hyperevm (our Uniswap V3 pools on HyperEVM in the all-time volume).'
)
ON CONFLICT (filename) DO NOTHING;

-- VERIFICATION, read-only:
--
-- select filename, applied_at from public.schema_migrations
--  where filename = '033_venue_volume_hyperevm.sql';             -- one row
--
-- select pg_get_constraintdef(oid) from pg_constraint
--  where conname = 'venue_volume_shape';                        -- names all eight sources
--
-- After the next count:
-- select source, swaps, usd, counted_to, last_error from venue_volume order by source;
