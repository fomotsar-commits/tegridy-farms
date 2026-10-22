-- ============================================================
-- 028_venue_volume.sql: the venue's all-time volume, one row per source
--
-- .github/workflows/venue-volume.yml (frontend/scripts/venue-volume.mjs) adds the
-- swaps that are new since its last run, every hour, and api/_lib/venueVolume.js
-- sums the rows for the home page. A row holds a source's running totals AND its
-- cursor, written together in one request, so a run that fails changes nothing.
--
--   source       solana-pools, jupiter, ethereum, base or robinhood
--   swaps, usd   all-time count and dollars; each swap's dollars are fixed the
--                hour it is first counted, never revalued
--   unpriced     swaps with no SOL, USDC or WETH leg to value (counted, not in usd)
--   bot_swaps,   the part of swaps and usd made by the known arbitrage bots, kept
--   bot_usd      so a "without bots" figure needs no rescan; not shown today
--   cursor       where the next run starts: the last signature per Solana address,
--                or the last finalized block and the pairs seen per EVM chain
--   counted_to   every swap up to this time is in the totals
--   version      bumped on every write; a run writes only the version it read, so
--                two runs at once cannot add the same swaps twice
--
-- Not in the weekly backup: a lost table is rebuilt by one run from empty, which
-- reads all of history again (at that run's prices).
--
-- Apply by hand in the Supabase SQL editor (docs/TODO_OPERATOR.md). Needs the
-- ledger, public.schema_migrations (000_base_schema.sql section 0). Touches no
-- other table, so it does not depend on 027. Idempotent: re-running it is safe.
-- Until it runs, the workflow notes that and counts nothing, and the home page
-- line says the volume has not been counted.
-- ============================================================

CREATE TABLE IF NOT EXISTS venue_volume (
  source        text        PRIMARY KEY,
  swaps         bigint      NOT NULL DEFAULT 0,
  usd           numeric     NOT NULL DEFAULT 0,
  unpriced      bigint      NOT NULL DEFAULT 0,
  bot_swaps     bigint      NOT NULL DEFAULT 0,
  bot_usd       numeric     NOT NULL DEFAULT 0,
  cursor        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  counted_to    timestamptz,
  last_ok_at    timestamptz,
  last_error    text,
  last_error_at timestamptz,
  version       bigint      NOT NULL DEFAULT 0
);

ALTER TABLE venue_volume DROP CONSTRAINT IF EXISTS venue_volume_shape;
ALTER TABLE venue_volume
  ADD CONSTRAINT venue_volume_shape
  CHECK (
    source IN ('solana-pools', 'jupiter', 'ethereum', 'base', 'robinhood')
    AND swaps >= 0 AND usd >= 0 AND unpriced >= 0
    AND bot_swaps >= 0 AND bot_usd >= 0
    AND unpriced <= swaps AND bot_swaps <= swaps
    AND (last_error IS NULL OR length(last_error) <= 300)
  );

-- RLS on with no policy: no browser reads or writes this table. The workflow writes
-- and api/_lib/venueVolume.js reads, both as service_role, which bypasses RLS.
ALTER TABLE venue_volume ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON venue_volume FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON venue_volume TO service_role;

-- Without this the table exists and PostgREST answers PGRST205 (014's header).
NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (filename, note)
VALUES (
  '028_venue_volume.sql',
  'venue_volume created for the hourly volume counter (venue-volume.yml): RLS on, no policies, anon/authenticated revoked, service_role SELECT/INSERT/UPDATE only.'
)
ON CONFLICT (filename) DO NOTHING;

-- VERIFICATION, read-only:
--
-- select filename, applied_at from public.schema_migrations
--  where filename = '028_venue_volume.sql';                     -- one row
--
-- select relrowsecurity from pg_class where relname = 'venue_volume';  -- true
--
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_name = 'venue_volume' and grantee in ('anon','authenticated');
--                                                                -- zero rows
--
-- After the first run of the workflow (Actions > Venue Volume > Run workflow):
-- select source, swaps, usd, counted_to, last_error from venue_volume order by source;
