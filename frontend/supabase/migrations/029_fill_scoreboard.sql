-- ============================================================
-- 029_fill_scoreboard.sql: quote against fill, one row per site Jupiter swap
--
-- .github/workflows/fill-scoreboard.yml (frontend/scripts/fill-scoreboard.mjs) reads the
-- swaps that paid the site's fee since its last run, every hour, and
-- api/_lib/fillScoreboard.js summarizes the last 30 days for the Solana swap page.
--
-- fill_scoreboard, one row per swap, keyed by its signature (a rerun rewrites it):
--   quoted_out       what Jupiter quoted, from its own route instruction in the swap
--   delivered_out    what reached the trader (the route's own figure for SOL)
--   slippage_bps     the slippage the swap allowed; platform_fee_bps, the site's fee
--   fill_bps         (delivered - quoted) / quoted, in basis points
--   deposit_lamports SOL the trader put into accounts the route opened and left open,
--                    other than their own account for the token bought
--   bot              a known arbitrage bot: counted nowhere on the page
--   unread_reason    set when the swap paid our fee but could not be scored; the page
--                    says how many, never leaves them out silently
-- fill_scoreboard_cursor, one row: where the next run starts, and when it last finished.
-- No wallet address is stored.
--
-- Apply by hand in the Supabase SQL editor (docs/TODO_OPERATOR.md). Needs the ledger,
-- public.schema_migrations (000_base_schema.sql section 0). Touches no other table, so it
-- does not depend on 027 or 028. Idempotent: re-running it is safe. Until it runs, the
-- workflow notes that and writes nothing, and the page shows no fill line.
-- ============================================================

CREATE TABLE IF NOT EXISTS fill_scoreboard (
  signature        text        PRIMARY KEY,
  block_time       timestamptz NOT NULL,
  bot              boolean     NOT NULL DEFAULT false,
  in_mint          text,
  out_mint         text,
  in_amount        numeric,
  quoted_out       numeric,
  delivered_out    numeric,
  slippage_bps     integer,
  platform_fee_bps integer,
  fill_bps         numeric,
  deposit_lamports numeric,
  unread_reason    text
);

ALTER TABLE fill_scoreboard DROP CONSTRAINT IF EXISTS fill_scoreboard_shape;
ALTER TABLE fill_scoreboard
  ADD CONSTRAINT fill_scoreboard_shape
  CHECK (
    length(signature) BETWEEN 64 AND 90
    AND (
      (unread_reason IS NOT NULL AND length(unread_reason) <= 200)
      OR (
        unread_reason IS NULL
        AND in_mint IS NOT NULL AND out_mint IS NOT NULL
        AND in_amount >= 0 AND quoted_out > 0 AND delivered_out >= 0
        AND slippage_bps BETWEEN 0 AND 10000 AND platform_fee_bps BETWEEN 0 AND 255
        AND fill_bps IS NOT NULL AND deposit_lamports >= 0
      )
    )
  );

CREATE INDEX IF NOT EXISTS fill_scoreboard_block_time ON fill_scoreboard (block_time DESC);

CREATE TABLE IF NOT EXISTS fill_scoreboard_cursor (
  source        text        PRIMARY KEY CHECK (source = 'jupiter'),
  cursor        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  counted_to    timestamptz,
  last_ok_at    timestamptz,
  last_error    text        CHECK (last_error IS NULL OR length(last_error) <= 300),
  last_error_at timestamptz,
  version       bigint      NOT NULL DEFAULT 0
);

-- RLS on with no policy: no browser reads or writes these tables. The workflow writes and
-- api/_lib/fillScoreboard.js reads, both as service_role, which bypasses RLS.
ALTER TABLE fill_scoreboard ENABLE ROW LEVEL SECURITY;
ALTER TABLE fill_scoreboard_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fill_scoreboard FROM anon, authenticated;
REVOKE ALL ON fill_scoreboard_cursor FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON fill_scoreboard TO service_role;
GRANT SELECT, INSERT, UPDATE ON fill_scoreboard_cursor TO service_role;

-- Without this the tables exist and PostgREST answers PGRST205 (014's header).
NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (filename, note)
VALUES (
  '029_fill_scoreboard.sql',
  'fill_scoreboard + fill_scoreboard_cursor created for the hourly fill scoreboard (fill-scoreboard.yml): RLS on, no policies, anon/authenticated revoked, service_role SELECT/INSERT/UPDATE only.'
)
ON CONFLICT (filename) DO NOTHING;

-- VERIFICATION, read-only:
--
-- select filename, applied_at from public.schema_migrations
--  where filename = '029_fill_scoreboard.sql';                       -- one row
--
-- select relname, relrowsecurity from pg_class
--  where relname in ('fill_scoreboard', 'fill_scoreboard_cursor');    -- both true
--
-- select table_name, grantee, privilege_type from information_schema.role_table_grants
--  where table_name in ('fill_scoreboard', 'fill_scoreboard_cursor')
--    and grantee in ('anon', 'authenticated');                         -- zero rows
--
-- After the first run of the workflow (Actions > Fill Scoreboard > Run workflow):
-- select count(*), min(fill_bps), max(fill_bps) from fill_scoreboard where unread_reason is null;
-- select counted_to, last_ok_at, last_error from fill_scoreboard_cursor;
