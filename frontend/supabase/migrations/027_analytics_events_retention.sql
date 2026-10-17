-- ============================================================
-- 027_analytics_events_retention.sql: let the 90-day purge delete analytics events
--
-- WHY
-- ---
-- The owner's decision of 2026-10-03: an analytics event is kept for 90 days and then
-- deleted automatically, and the Privacy page (sections 3 and 5) now says so. Until now
-- nothing deleted these rows: every event analytics_events ever stored was kept forever.
--
-- The delete runs hourly from .github/workflows/error-retention.yml and, as a backstop,
-- from api/analytics.js after a stored batch: both through api/_lib/errorPurge.js, as
-- service_role, as `DELETE ... WHERE received_at < now() - 90 days`. received_at is set by
-- the database on insert (013: `DEFAULT now()`), so a browser's clock cannot make an event
-- outlive its 90 days. 013 needs two things changed for that:
--
--   * 013 granted service_role INSERT and SELECT only. This adds DELETE, and nothing else.
--     (In production 008's default privileges may already have given service_role every
--     privilege on tables created after it; this makes the grant explicit and reviewable,
--     and is a no-op if it is already there.)
--   * 013 indexed occurred_at, the client's time, not received_at. This indexes
--     received_at, so the hourly delete does not read the whole table.
--
-- anon and authenticated stay at nothing: 013 revoked everything from them, and this file
-- grants them nothing. RLS stays on with no policies.
--
-- The weekly backup (supabase-backup.yml) does not copy analytics_events, so no event
-- outlives its 90 days in a backup either.
--
-- BEFORE IT RUNS, the purge gets 42501 (permission denied) from PostgREST, and the hourly
-- run is red, naming this file: events past 90 days are not being deleted, so it says so.
--
-- PREREQUISITES
--   * 013_analytics_events.sql. If analytics_events does not exist, this file stops at its
--     first statement with a plain message and changes nothing. In that case no event can
--     have been stored, the hourly purge is green with a notice, and this file can wait
--     until 013 is applied: apply it straight after.
--   * public.schema_migrations, the ledger this file writes its own row into at the end
--     (000_base_schema.sql section 0). If
--       select to_regclass('public.schema_migrations');
--     returns null, run the nine statements in supabase/MIGRATIONS.md section 1 first.
--
-- Run in the Supabase SQL editor, never `supabase db push`. It does not depend on 024,
-- 025 or 026. Idempotent: re-running it is safe.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.analytics_events') IS NULL THEN
    RAISE EXCEPTION 'analytics_events does not exist. Apply 013_analytics_events.sql first, then this file. Nothing was changed.';
  END IF;
END
$$;

-- DELETE is for the 90-day purge, which filters on received_at. Nothing else is granted.
GRANT DELETE ON analytics_events TO service_role;

-- The 90-day purge deletes WHERE received_at < now() - 90 days, every hour.
CREATE INDEX IF NOT EXISTS idx_analytics_received
  ON analytics_events(received_at);

-- Reload the PostgREST schema cache so the new grant is seen at once, not after the next
-- restart (014's header records a migration that looked like it did nothing for this).
NOTIFY pgrst, 'reload schema';

-- Record this file in the ledger (000 section 0), as 016 to 026 do, so "was 027 applied?"
-- is a query and not a guess.
INSERT INTO public.schema_migrations (filename, note)
VALUES (
  '027_analytics_events_retention.sql',
  'analytics_events: service_role DELETE for the 90-day purge, and an index on received_at. anon/authenticated unchanged (nothing).'
)
ON CONFLICT (filename) DO NOTHING;

-- VERIFICATION, read-only:
--
-- select filename, applied_at from public.schema_migrations
--  where filename = '027_analytics_events_retention.sql';            -- one row
--
-- select privilege_type from information_schema.role_table_grants
--  where table_name = 'analytics_events' and grantee = 'service_role';
--                                                   -- includes DELETE
--
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_name = 'analytics_events' and grantee in ('anon','authenticated');
--                                                   -- zero rows
--
-- select indexname from pg_indexes
--  where tablename = 'analytics_events' and indexname = 'idx_analytics_received';
--                                                   -- one row
--
-- select count(*) from analytics_events
--  where received_at < now() - interval '90 days';
--                       -- 0 once the next hourly Data Retention run is green
