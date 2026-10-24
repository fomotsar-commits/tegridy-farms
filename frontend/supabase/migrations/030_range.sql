-- 030_range.sql: the venue's hourly count of every range pool's swaps. range-stats.yml
-- writes it, api/_lib/rangeStats.js reads it; COMMENT ON TABLE below says what each holds.
-- Numbers past 2^53 are numeric(40,0): read them as ::text. No column holds a wallet.
-- Apply by hand in the Supabase SQL editor (docs/TODO_OPERATOR.md); it needs only
-- public.schema_migrations. Idempotent. Until it runs, the job counts nothing and says so.

CREATE TABLE IF NOT EXISTS range_pool (
  address        text        PRIMARY KEY,
  mint_0         text        NOT NULL,
  mint_1         text        NOT NULL,
  vault_0        text        NOT NULL,
  vault_1        text        NOT NULL,
  decimals_0     smallint    NOT NULL,
  decimals_1     smallint    NOT NULL,
  amm_config     text        NOT NULL,
  tick_spacing   integer     NOT NULL,
  registry       boolean     NOT NULL DEFAULT false,
  opened_slot    bigint,
  opened_at      timestamptz,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS range_cursor (
  pool             text        PRIMARY KEY,
  last_signature   text,
  through_slot     bigint      NOT NULL DEFAULT 0,
  totals           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  open_hour        jsonb,
  last_price       text,
  last_price_slot  bigint,
  last_rates       jsonb,
  opened           jsonb,
  last_ok_at       timestamptz,
  last_error       text,
  last_error_at    timestamptz,
  version          bigint      NOT NULL DEFAULT 0,
  CHECK (last_error IS NULL OR length(last_error) <= 300)
);

CREATE TABLE IF NOT EXISTS range_swap (
  signature       text           NOT NULL,
  pool            text           NOT NULL,
  event_index     integer        NOT NULL CHECK (event_index >= 0),
  slot            bigint         NOT NULL,
  block_time      timestamptz    NOT NULL,
  zero_for_one    boolean        NOT NULL,
  amount_0        numeric(40, 0) NOT NULL CHECK (amount_0 >= 0),
  amount_1        numeric(40, 0) NOT NULL CHECK (amount_1 >= 0),
  fee_0           numeric(40, 0) NOT NULL CHECK (fee_0 >= 0),
  fee_1           numeric(40, 0) NOT NULL CHECK (fee_1 >= 0),
  sqrt_price_x64  numeric(40, 0) NOT NULL CHECK (sqrt_price_x64 > 0),
  liquidity       numeric(40, 0) NOT NULL CHECK (liquidity >= 0),
  tick            integer        NOT NULL,
  PRIMARY KEY (signature, pool, event_index)
);
CREATE INDEX IF NOT EXISTS range_swap_pool_slot_idx ON range_swap (pool, slot DESC);

CREATE TABLE IF NOT EXISTS range_collection (
  signature    text           NOT NULL,
  pool         text           NOT NULL,
  event_index  integer        NOT NULL CHECK (event_index >= 0),
  slot         bigint         NOT NULL,
  block_time   timestamptz    NOT NULL,
  by_whom      text           NOT NULL CHECK (by_whom IN ('vault', 'workshop')),
  amount_0     numeric(40, 0) NOT NULL CHECK (amount_0 >= 0),
  amount_1     numeric(40, 0) NOT NULL CHECK (amount_1 >= 0),
  PRIMARY KEY (signature, pool, event_index)
);
CREATE INDEX IF NOT EXISTS range_collection_pool_slot_idx ON range_collection (pool, slot DESC);

CREATE TABLE IF NOT EXISTS range_hour (
  pool        text           NOT NULL,
  hour        timestamptz    NOT NULL CHECK (extract(epoch FROM hour) % 3600 = 0),
  swaps       integer        NOT NULL CHECK (swaps > 0),
  volume_0    numeric(40, 0) NOT NULL CHECK (volume_0 >= 0),
  volume_1    numeric(40, 0) NOT NULL CHECK (volume_1 >= 0),
  fees_0      numeric(40, 0) NOT NULL CHECK (fees_0 >= 0),
  fees_1      numeric(40, 0) NOT NULL CHECK (fees_1 >= 0),
  open_price  numeric(40, 0) NOT NULL,
  high_price  numeric(40, 0) NOT NULL,
  low_price   numeric(40, 0) NOT NULL,
  close_price numeric(40, 0) NOT NULL,
  PRIMARY KEY (pool, hour)
);

CREATE TABLE IF NOT EXISTS range_venue_snapshot (
  pool                    text           NOT NULL,
  slot                    bigint         NOT NULL,
  block_time              timestamptz    NOT NULL,
  at_open           boolean        NOT NULL DEFAULT false,
  protocol_fees_0         numeric(40, 0) NOT NULL CHECK (protocol_fees_0 >= 0),
  protocol_fees_1         numeric(40, 0) NOT NULL CHECK (protocol_fees_1 >= 0),
  fund_fees_0             numeric(40, 0) NOT NULL CHECK (fund_fees_0 >= 0),
  fund_fees_1             numeric(40, 0) NOT NULL CHECK (fund_fees_1 >= 0),
  sqrt_price_x64          numeric(40, 0) NOT NULL,
  trade_fee_rate          integer,
  protocol_fee_rate       integer,
  fund_fee_rate           integer,
  cum_swaps               bigint         NOT NULL CHECK (cum_swaps >= 0),
  cum_volume_0            numeric(40, 0) NOT NULL,
  cum_volume_1            numeric(40, 0) NOT NULL,
  cum_fees_0              numeric(40, 0) NOT NULL,
  cum_fees_1              numeric(40, 0) NOT NULL,
  cum_vault_collected_0   numeric(40, 0) NOT NULL,
  cum_vault_collected_1   numeric(40, 0) NOT NULL,
  cum_workshop_collected_0 numeric(40, 0) NOT NULL,
  cum_workshop_collected_1 numeric(40, 0) NOT NULL,
  PRIMARY KEY (pool, slot)
);
CREATE INDEX IF NOT EXISTS range_venue_snapshot_pool_time_idx ON range_venue_snapshot (pool, block_time DESC);

-- `standing` true is a limit of the design, true on a healthy day; false is a hole that
-- should not be there. A window that a hole overlaps gives no number. `pool` holds the
-- program id for a gap about the pool list itself. `gap_key` makes a re-run idempotent.
CREATE TABLE IF NOT EXISTS range_gap (
  id           bigserial   PRIMARY KEY,
  pool         text        NOT NULL,
  gap_key      text        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN (
                 'log-truncated', 'tx-unavailable', 'event-undecodable', 'backlog-truncated',
                 'history-not-backfilled', 'tier-changed', 'pool-list-unread')),
  standing     boolean     NOT NULL DEFAULT false,
  signature    text,
  from_slot    bigint,
  to_slot      bigint,
  from_time    timestamptz,
  to_time      timestamptz,
  detail       text        NOT NULL CHECK (length(detail) <= 300),
  detected_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  UNIQUE (pool, gap_key),
  CHECK (from_slot IS NULL OR to_slot IS NULL OR from_slot <= to_slot)
);
CREATE INDEX IF NOT EXISTS range_gap_open_idx ON range_gap (pool) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS range_run (
  id              bigserial   PRIMARY KEY,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz NOT NULL,
  ok              boolean     NOT NULL,
  list_read       boolean     NOT NULL,
  pools_listed    integer     NOT NULL DEFAULT 0,
  pools_counted   integer     NOT NULL DEFAULT 0,
  pools_backlog   integer     NOT NULL DEFAULT 0,
  transactions    integer     NOT NULL DEFAULT 0,
  error           text        CHECK (error IS NULL OR length(error) <= 300)
);
CREATE INDEX IF NOT EXISTS range_run_finished_idx ON range_run (finished_at DESC);

COMMENT ON TABLE range_pool IS
  'Each pool of the range program the count has found, from the program''s own accounts; registry: listed in scripts/addresses.json as a range-pool-* row.';
COMMENT ON TABLE range_cursor IS
  'One per pool: the last signature counted, the slot every transaction is counted through, and every running total, written in one request so a failed run changes nothing.';
COMMENT ON TABLE range_swap IS
  'Each SwapEvent our program logged for the pool, raw: amounts, the total fee (positions, vault and Workshop together), the price and liquidity after it.';
COMMENT ON TABLE range_collection IS
  'Each collection of the venue''s take from the pool: by_whom vault is collect_protocol_fee (the team''s vault), workshop is collect_fund_fee (the island Workshop).';
COMMENT ON TABLE range_hour IS
  'Closed UTC hours with at least one swap: count, volume and fees per coin, and the price (sqrt, Q64.64) after the first, highest, lowest and last swap.';
COMMENT ON TABLE range_venue_snapshot IS
  'The pool''s four venue counters read at one slot, with the running totals through that slot. A window is the difference of two rows. at_open: the zero point just before the pool opened.';
COMMENT ON TABLE range_gap IS
  'What the count could not read, as a row, never a zero. standing true: a design limit; false: a hole, and a window it overlaps gives no number.';
COMMENT ON TABLE range_run IS 'One row per run of range-stats.yml.';

-- RLS on with no policy: no browser reads or writes these tables. The workflow writes and
-- api/_lib/rangeStats.js reads, both as service_role, which bypasses RLS.
ALTER TABLE range_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE range_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE range_swap ENABLE ROW LEVEL SECURITY;
ALTER TABLE range_collection ENABLE ROW LEVEL SECURITY;
ALTER TABLE range_hour ENABLE ROW LEVEL SECURITY;
ALTER TABLE range_venue_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE range_gap ENABLE ROW LEVEL SECURITY;
ALTER TABLE range_run ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON range_pool, range_cursor, range_swap, range_collection,
  range_hour, range_venue_snapshot, range_gap, range_run FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON range_pool, range_cursor, range_swap, range_collection,
  range_hour, range_venue_snapshot, range_gap, range_run TO service_role;
GRANT USAGE, SELECT ON SEQUENCE range_gap_id_seq, range_run_id_seq TO service_role;

-- Without this the tables exist and PostgREST answers PGRST205 (014's header).
NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (filename, note)
VALUES (
  '030_range.sql',
  'range_* tables created for the hourly range-pool count (range-stats.yml): RLS on, no policies, anon/authenticated revoked, service_role SELECT/INSERT/UPDATE only.'
)
ON CONFLICT (filename) DO NOTHING;

-- Check, read-only: the ledger row; relrowsecurity true on all eight; no anon grant.
-- select filename from public.schema_migrations where filename = '030_range.sql';
-- select relname, relrowsecurity from pg_class where relname like 'range\_%';
-- select table_name from information_schema.role_table_grants
--  where table_name like 'range\_%' and grantee in ('anon', 'authenticated');
