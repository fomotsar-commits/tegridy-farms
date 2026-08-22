-- ============================================================
-- 013_analytics_events.sql — first-party analytics sink
--
-- WHY
-- ---
-- frontend/src/lib/analytics.ts has been built, consent-gated and sanitised
-- since well before this migration, but VITE_ANALYTICS_ENDPOINT was never set,
-- so every event it batched was discarded. The practical effect: this protocol
-- has NO traffic number of any kind. Every claim about adoption, every funnel,
-- and every "is anyone arriving" decision has had no denominator.
--
-- PRIVACY SHAPE — this table is the enforcement point for a published promise.
-- PrivacyPage.tsx §3 states that event records "do NOT include your wallet
-- address" and that the session identifier "is not linked to any identity".
-- So:
--   * there is NO wallet column, and none may be added without amending §3
--     (which also triggers §9's 14-day notice requirement)
--   * session_id is an opaque per-tab id generated client-side; it is not a
--     user id and must never be joined to one
--   * a CHECK constraint below rejects rows whose properties contain anything
--     shaped like an EVM or Solana address, so the promise fails CLOSED at the
--     database rather than relying on every future caller to remember it
--
-- Run in the Supabase SQL editor AFTER 012_bundle_listings.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS analytics_events (
  id           bigserial PRIMARY KEY,
  event        text        NOT NULL,
  properties   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  session_id   text        NOT NULL,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- Bound the obvious abuse shapes. The API validates these too; this is the
-- backstop for anything that reaches PostgREST by another path.
ALTER TABLE analytics_events
  DROP CONSTRAINT IF EXISTS analytics_events_shape;
ALTER TABLE analytics_events
  ADD CONSTRAINT analytics_events_shape
  CHECK (
    length(event) BETWEEN 1 AND 64
    AND length(session_id) BETWEEN 1 AND 128
    AND pg_column_size(properties) <= 4096
  );

-- THE PRIVACY INVARIANT — backstop only. The real check is in api/analytics.js.
--
-- Rejects any row whose serialised properties contain an EVM address. `0x`
-- followed by exactly 40 hex characters is unambiguous: there is no ordinary
-- analytics value with that shape, so the false-positive rate is ~0.
--
-- A base58 / Solana-pubkey check is DELIBERATELY NOT HERE. The obvious pattern
-- (`[1-9A-HJ-NP-Za-km-z]{32,44}`) matches as a SUBSTRING, so any 32-char run of
-- ordinary alphanumerics inside a longer property value trips it. In a CHECK
-- constraint that is not a dropped event — the INSERT raises, the endpoint 500s,
-- and the client re-queues the batch forever. Substring matching over serialised
-- JSON is the wrong tool; the API instead tests whole VALUES, where "is this
-- entire string a pubkey" is answerable without guessing.
ALTER TABLE analytics_events
  DROP CONSTRAINT IF EXISTS analytics_events_no_addresses;
ALTER TABLE analytics_events
  ADD CONSTRAINT analytics_events_no_addresses
  CHECK (properties::text !~ '0x[a-fA-F0-9]{40}');

-- Time-ordered reads are the only access pattern that matters (daily uniques,
-- funnel steps over a window). Session lookup is secondary.
CREATE INDEX IF NOT EXISTS idx_analytics_occurred
  ON analytics_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_event_time
  ON analytics_events(event, occurred_at DESC);

-- RLS: writes arrive ONLY through api/analytics.js using the service role, which
-- bypasses RLS. Enabling RLS with no policy therefore denies every anon/authed
-- client by default — deliberate. There is no legitimate reason for a browser to
-- read this table, and PrivacyPage §5's guarantee is that RLS is on everywhere.
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT/UPDATE/DELETE policies are created on purpose. If a read
-- surface is ever needed, add an aggregate VIEW rather than opening this table.
REVOKE ALL ON analytics_events FROM anon, authenticated;

-- 008_grant_new_table_roles.sql established that new tables need explicit
-- sequence grants for the roles that use them. service_role bypasses RLS but
-- still needs table + sequence privileges.
GRANT INSERT, SELECT ON analytics_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE analytics_events_id_seq TO service_role;
