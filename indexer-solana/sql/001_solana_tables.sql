-- Solana leg of the data spine. Runs against the SAME Postgres as the Ponder
-- app (indexer/), in the same schema, under a `solana_` prefix so one query
-- surface serves both chains without either service owning the other's tables.
--
-- Ponder OWNS its own tables and drops/recreates them on a schema change. It
-- does not know these exist and will not touch them, because Ponder only
-- manages the tables declared in ponder.schema.ts. That is the entire reason
-- for the prefix: a name collision would put a live Solana table inside
-- Ponder's reconciliation set, and a re-index would take it with it.
--
-- Idempotent. Apply with `npm run migrate` (indexer-solana/) or by hand; it is
-- safe to run against a database that already has these tables.

BEGIN;

-- ─── Watch set ───────────────────────────────────────────────────────────────
--
-- One row per DBC pool this service follows. Seeded from SOLANA_WATCH by the
-- process at boot (see src/store.js `syncWatches`) — the env is the source of
-- truth so a pool cannot be added by writing a row nobody reviewed. Rows for
-- pools no longer in the env are marked `retired_at`, never deleted: their
-- trades, claims and gaps stay readable and stay attributable.
CREATE TABLE IF NOT EXISTS solana_watch (
  pool             text PRIMARY KEY,
  label            text,
  base_mint        text NOT NULL,
  quote_mint       text NOT NULL,
  -- Token-account owner that receives claimed partner fees (the Squads v4
  -- vault, per frontend/src/lib/launcher/solana/dbc.ts doctrine). NULL means
  -- the operator did not supply one, and fee claims for this pool are
  -- therefore NOT indexed — which is recorded as an open gap, not as zero.
  fee_receiver     text,
  quote_decimals   smallint,
  base_decimals    smallint,
  added_at         timestamptz NOT NULL DEFAULT now(),
  retired_at       timestamptz
);

-- ─── Cursor ──────────────────────────────────────────────────────────────────
--
-- Resume point per pool. `last_signature` is the NEWEST signature whose
-- transaction has been fully committed — it is advanced one signature at a
-- time, after the write, never for a batch. A crash mid-batch therefore
-- re-reads a few signatures (every writer here is idempotent) instead of
-- skipping the tail of one.
CREATE TABLE IF NOT EXISTS solana_cursor (
  pool             text PRIMARY KEY REFERENCES solana_watch(pool) ON DELETE RESTRICT,
  last_signature   text,
  last_slot        bigint,
  last_block_time  bigint,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ─── Trades ──────────────────────────────────────────────────────────────────
--
-- Derived from the transaction's own pre/post token balances, NOT from a
-- decoded program event. The DBC program's event layout is not vendored in
-- this repo and guessing it is how a plausible wrong number gets written
-- (docs: frontend/src/lib/launcher/solana/liveConfig.ts makes the same call
-- for account layouts and guards it with a computed discriminator). Balance
-- deltas are arithmetic on what the RPC returned.
--
-- amounts are RAW base units (never uiAmount — that is a float and this is
-- money). numeric(40,0) holds any u64 with room to spare.
CREATE TABLE IF NOT EXISTS solana_dbc_trade (
  signature        text NOT NULL,
  pool             text NOT NULL REFERENCES solana_watch(pool) ON DELETE RESTRICT,
  slot             bigint NOT NULL,
  -- Solana `blockTime` is nullable on the RPC. NULL here means the cluster did
  -- not report one; it must not be rendered as the epoch.
  block_time       bigint,
  -- The transaction's FEE PAYER, which is the trader for a wallet-signed swap
  -- and a relayer for an aggregator-routed one. Named for what it is: calling
  -- it `trader` would invite a per-user rollup that silently attributes every
  -- routed trade to one router.
  payer            text NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('buy', 'sell')),
  base_amount      numeric(40, 0) NOT NULL CHECK (base_amount > 0),
  quote_amount     numeric(40, 0) NOT NULL CHECK (quote_amount > 0),
  indexed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signature, pool)
);

CREATE INDEX IF NOT EXISTS solana_dbc_trade_pool_slot_idx ON solana_dbc_trade (pool, slot DESC);
CREATE INDEX IF NOT EXISTS solana_dbc_trade_payer_idx ON solana_dbc_trade (payer);

-- ─── Partner-fee claims ──────────────────────────────────────────────────────
--
-- REALIZED fees only: a claim is a token transfer into the fee receiver, which
-- is observable. UNREALIZED accrual lives in the pool's account state and is
-- deliberately NOT indexed here — see the known-unknown note in DEPLOY.md and
-- the `solana_gap` row of kind 'accrual-not-indexed' that every watched pool
-- carries. Summing this table gives fees COLLECTED, never fees EARNED.
CREATE TABLE IF NOT EXISTS solana_fee_claim (
  signature        text NOT NULL,
  pool             text NOT NULL REFERENCES solana_watch(pool) ON DELETE RESTRICT,
  slot             bigint NOT NULL,
  block_time       bigint,
  receiver         text NOT NULL,
  mint             text NOT NULL,
  amount           numeric(40, 0) NOT NULL CHECK (amount > 0),
  indexed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signature, pool, mint)
);

CREATE INDEX IF NOT EXISTS solana_fee_claim_pool_slot_idx ON solana_fee_claim (pool, slot DESC);

-- ─── Known-unknowns ──────────────────────────────────────────────────────────
--
-- The point of this service. Anything the indexer could not read is a ROW, not
-- a silence: a pruned signature range, a transaction the RPC would not return,
-- a transaction whose token movements do not resolve to one unambiguous trade.
-- A consumer that ignores this table will read an outage as a quiet market,
-- which is the one failure this whole leg exists to prevent.
--
-- `kind` values, all produced by src/ingest.js:
--   history-not-backfilled — cold start with no startSignature: history older
--                         than the first bounded walk was never requested.
--   backlog-truncated   — the resume signature was not reached inside one
--                         tick's page budget; the span between is unread.
--   pruned-history      — the RPC refused the range as no longer retained.
--   tx-unavailable      — getTransaction returned null or a pruned error.
--   undecodable         — the transaction was read but its token movements do
--                         not resolve to one trade or one claim.
--   fee-receiver-unset  — no fee_receiver configured, so claims are not indexed.
--   accrual-not-indexed — unrealized partner-fee accrual is not derivable
--                         without decoding pool state.
--
-- `standing` splits the two populations that must never be summed together:
-- a FALSE row is a hole that should not be there and might be repairable; a
-- TRUE row is a limit of the design, true on a perfectly healthy day. Folding
-- them into one count would either make a healthy service look broken forever
-- or train a reader to ignore the number.
CREATE TABLE IF NOT EXISTS solana_gap (
  id               bigserial PRIMARY KEY,
  pool             text NOT NULL REFERENCES solana_watch(pool) ON DELETE RESTRICT,
  kind             text NOT NULL,
  standing         boolean NOT NULL DEFAULT false,
  -- The signature this gap is about, when it is about exactly one.
  signature        text,
  from_slot        bigint,
  to_slot          bigint,
  detail           text NOT NULL,
  detected_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);

-- One open gap per (pool, kind, signature, from_slot). A retry loop that
-- re-hits the same unreadable transaction every 15 seconds must not grow the
-- table without bound — the second detection is not new information.
--
-- `from_slot` is in the key because span gaps (backlog-truncated,
-- pruned-history) carry no signature and are NOT interchangeable: two
-- truncations at different slots are two different missing spans, and folding
-- them into one row would silently drop the second hole.
CREATE UNIQUE INDEX IF NOT EXISTS solana_gap_open_uniq
-- The parentheses around each COALESCE are required, not stylistic: Postgres
-- parses COALESCE as a SQL construct rather than a function call, so an index
-- expression built from one has to be wrapped. The ON CONFLICT target in
-- src/store.js is written the same way so the inference matches this index.
  ON solana_gap (pool, kind, (COALESCE(signature, '')), (COALESCE(from_slot, -1)))
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS solana_gap_open_idx ON solana_gap (pool) WHERE resolved_at IS NULL;

-- ─── Liveness ────────────────────────────────────────────────────────────────
--
-- Single row. Written every tick, including ticks that failed, so "the service
-- stopped" and "the market stopped" are distinguishable from SQL alone.
CREATE TABLE IF NOT EXISTS solana_tick (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_tick_at     timestamptz,
  last_ok_at       timestamptz,
  head_slot        bigint,
  last_error       text
);

INSERT INTO solana_tick (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ─── Read surface ────────────────────────────────────────────────────────────
--
-- Per-pool rollup that CANNOT be read as authoritative by accident. Every
-- aggregate ships beside the two facts that qualify it: how many gaps are
-- open, and how stale the cursor is. `claimed_fee_total_observed` is named for
-- what it is — the sum of the claims this service actually saw — because a
-- column called `fees` would be believed.
CREATE OR REPLACE VIEW solana_launch_summary AS
SELECT
  w.pool,
  w.label,
  w.base_mint,
  w.quote_mint,
  w.fee_receiver,
  w.retired_at,
  c.last_signature                                   AS cursor_signature,
  c.last_slot                                        AS cursor_slot,
  c.updated_at                                       AS cursor_updated_at,
  (SELECT count(*) FROM solana_dbc_trade t WHERE t.pool = w.pool)      AS trades_observed,
  (SELECT count(*) FROM solana_fee_claim f WHERE f.pool = w.pool)      AS fee_claims_observed,
  (SELECT coalesce(sum(f.amount), 0) FROM solana_fee_claim f WHERE f.pool = w.pool)
                                                                      AS claimed_fee_total_observed,
  (SELECT count(*) FROM solana_gap g
     WHERE g.pool = w.pool AND g.resolved_at IS NULL AND NOT g.standing)
                                                                      AS open_gaps,
  (SELECT count(*) FROM solana_gap g
     WHERE g.pool = w.pool AND g.resolved_at IS NULL AND g.standing)
                                                                      AS standing_limitations
FROM solana_watch w
LEFT JOIN solana_cursor c ON c.pool = w.pool;

COMMIT;
