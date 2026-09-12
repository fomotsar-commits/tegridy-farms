-- ============================================================
-- 026_error_events.sql — first-party client-error sink
--
-- WHY
-- ---
-- This is the second time this project has shipped a finished, careful
-- telemetry client and never given it somewhere to send. Read the header of
-- 013_analytics_events.sql: "VITE_ANALYTICS_ENDPOINT was never set, so every
-- event it batched was discarded." The same sentence has been true of
-- VITE_ERROR_ENDPOINT and src/lib/errorReporting.ts the entire time.
--
-- The cost came due on 2026-09-04: an Alchemy key rotation took the frontend
-- and the indexer dark together, and the operator learned about it from a
-- user, because every client-side error was being written to a write-only
-- localStorage buffer that nothing ever reads.
--
-- PRIVACY SHAPE — this table is the enforcement point for a published promise.
-- PrivacyPage §3 describes the error reporter; §5 enumerates the server-side
-- tables as a CLOSED list, and `error_events` is added to it in the same
-- change that creates this table. A table absent from §5 is a broken promise,
-- not an oversight.
--
--   * there is NO wallet column and NO session column. ErrorEntry carries
--     neither — the record is strictly LESS linkable than §3 currently
--     describes ("with the same session identifier"), and that sentence is
--     corrected in the same change rather than left to overstate what we hold.
--   * the API redacts address-shaped values BEFORE insert. The likeliest
--     carrier is `url`: the client's sanitizeUrl() clears query and hash but
--     never scrubs the PATH, and App.tsx routes include `read/:address`.
--   * the CHECK below is the fail-closed backstop for anything reaching
--     PostgREST by another path.
--
-- Run in the Supabase SQL editor AFTER 025_user_tables_anon_write_lockdown.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS error_events (
  id              bigserial PRIMARY KEY,
  message         text        NOT NULL,
  stack           text,
  component_stack text,
  url             text,
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);

-- Bound the obvious abuse shapes. The API truncates to these same ceilings
-- before inserting; this is the backstop, not the primary control.
ALTER TABLE error_events
  DROP CONSTRAINT IF EXISTS error_events_shape;
ALTER TABLE error_events
  ADD CONSTRAINT error_events_shape
  CHECK (
    length(message) BETWEEN 1 AND 2000
    AND (stack IS NULL OR length(stack) <= 8000)
    AND (component_stack IS NULL OR length(component_stack) <= 8000)
    AND (url IS NULL OR length(url) <= 500)
  );

-- THE PRIVACY INVARIANT — backstop only. The real check is in api/errors.js.
--
-- Rejects any row carrying an EVM address in a free-text column. `0x` followed
-- by exactly 40 hex characters is unambiguous: no ordinary error text has that
-- shape, so the false-positive rate is ~0.
--
-- A base58 / Solana-pubkey check is DELIBERATELY NOT HERE, for the reason
-- 013's header sets out at length: the obvious pattern matches as a SUBSTRING,
-- so any 32-char run of ordinary alphanumerics inside a longer value trips it.
-- In a CHECK constraint that is not a dropped row — the INSERT raises and the
-- endpoint 503s. Stack traces are FULL of long alphanumeric runs (minified
-- symbol names, content hashes, source-map ids), so the false-positive rate
-- here would be far worse than it is on analytics properties.
--
-- STATED LIMIT, not an oversight: a Solana pubkey embedded mid-stack-trace is
-- caught by neither side. The client's scrub has no base58 rule, and
-- containsAddress's SOLANA_PUBKEY is anchored ^...$ so it only fires on a
-- whole value. Closing it needs a whole-token scan in the API, not a regex here.
ALTER TABLE error_events
  DROP CONSTRAINT IF EXISTS error_events_no_addresses;
ALTER TABLE error_events
  ADD CONSTRAINT error_events_no_addresses
  CHECK (
    coalesce(message, '')        !~ '0x[a-fA-F0-9]{40}'
    AND coalesce(stack, '')           !~ '0x[a-fA-F0-9]{40}'
    AND coalesce(component_stack, '') !~ '0x[a-fA-F0-9]{40}'
    AND coalesce(url, '')             !~ '0x[a-fA-F0-9]{40}'
  );

-- Time-ordered reads are the only access pattern that matters: "what broke in
-- the last hour", and "is this spiking right now". Grouping by message is how
-- a crash loop is recognised, so it gets its own index.
CREATE INDEX IF NOT EXISTS idx_error_occurred
  ON error_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_message_time
  ON error_events(message, occurred_at DESC);

-- RLS: writes arrive ONLY through api/errors.js using the service role, which
-- bypasses RLS. Enabling RLS with no policy therefore denies every anon/authed
-- client by default — deliberate, and required by rlsCoverage.test.ts, which
-- fails the build for any CREATEd table without it. There is no legitimate
-- reason for a browser to read this table.
ALTER TABLE error_events ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT/UPDATE/DELETE policies are created on purpose. If a read
-- surface is ever needed, add an aggregate VIEW rather than opening this table.
REVOKE ALL ON error_events FROM anon, authenticated;

-- 008_grant_new_table_roles.sql established that new tables need explicit
-- sequence grants for the roles that use them. service_role bypasses RLS but
-- still needs table + sequence privileges.
GRANT INSERT, SELECT ON error_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE error_events_id_seq TO service_role;

-- Reload the PostgREST schema cache. Without this the table EXISTS and
-- PostgREST keeps answering PGRST205, so the migration looks like it did
-- nothing and the route 503s on every insert - the same "built but invisible"
-- shape that put this whole change on the board. 014's header documents it
-- first-hand; supabase-restore.test.mjs fails any table-creating migration
-- that neither does this nor is named in RESTORE.md.
NOTIFY pgrst, 'reload schema';
