-- ============================================================
-- 016 — alert_rules: the per-wallet alert-rule store
--
-- ⚠️ NOT APPLIED. This repo has no migration ledger; statements are applied by
--    hand against the Supabase project. Until an operator runs this file,
--    PostgREST answers 404/PGRST205 for `alert_rules` and
--    frontend/api/_lib/alerts.js reports `code: "schema-missing"` — deliberately
--    NOT an empty rule list, because "you have no rules" and "no rule could ever
--    have been saved" are different facts.
--
-- ORDERING: independent of 014/015. Safe to apply at any time; it creates one
-- new table and touches nothing existing.
--
-- WHAT A ROW IS
--   A question the owner asked about an address. It is not a promise that
--   anything watches it. Nothing in this schema evaluates a rule, and no
--   background service exists that does (docs/BATTLE_PLAN.md F9). Rules are
--   evaluated in the browser while the app is open. Do not add a `last_fired_at`
--   or `status` column implying otherwise until a real evaluator writes to it —
--   a column that is always NULL reads as "never fired", which is a claim.
--
-- AUTHORITY
--   RLS keyed to the SIWE JWT wallet claim, identical in shape to
--   push_subscriptions in 002 / 004. The API forwards the USER's JWT to
--   PostgREST; the service role is never used to forward a user write.
-- ============================================================

CREATE TABLE IF NOT EXISTS alert_rules (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lower-cased owner wallet. Every policy below keys on this.
  wallet      text        NOT NULL,
  -- Mirrors ALERT_RULE_KINDS in frontend/api/_lib/alerts.js and
  -- frontend/src/lib/alerts/rules.ts. A CHECK rather than an enum type so adding
  -- a kind is one ALTER, not a type migration — but it IS constrained here, so a
  -- direct-to-database write cannot create a rule no evaluator understands.
  kind        text        NOT NULL CHECK (kind IN (
                            'whale-move',
                            'deployer-reputation',
                            'lp-unlock',
                            'launch-live',
                            'heat-tier',
                            'loan-deadline'
                          )),
  -- The address the rule watches: token contract, deployer, or wallet depending
  -- on `kind`. Lower-cased 0x-prefixed EVM address; the API validates the shape.
  subject     text        NOT NULL CHECK (subject ~ '^0x[0-9a-f]{40}$'),
  -- USD threshold. Meaningful only for 'whale-move'; NULL for every other kind,
  -- and the CHECK enforces that rather than trusting the caller — a stray
  -- threshold on a kind that ignores it would read as an active filter.
  threshold   numeric,
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT alert_rules_threshold_matches_kind CHECK (
    (kind = 'whale-move' AND threshold IS NOT NULL AND threshold > 0)
    OR (kind <> 'whale-move' AND threshold IS NULL)
  ),
  -- One question per (owner, kind, subject, threshold). Makes a double-tapped
  -- "Add" a 409 instead of two rows that both fire for the same fact.
  CONSTRAINT alert_rules_unique_question UNIQUE (wallet, kind, subject, threshold)
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_wallet ON alert_rules(wallet);

ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;

-- SELECT: only the owner reads their own rules. There is no public read: a rule
-- names an address someone is watching, which is information about the watcher.
DROP POLICY IF EXISTS "Owner reads own alert rules" ON alert_rules;
CREATE POLICY "Owner reads own alert rules" ON alert_rules FOR SELECT USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- INSERT: only as self.
DROP POLICY IF EXISTS "Owner creates own alert rules" ON alert_rules;
CREATE POLICY "Owner creates own alert rules" ON alert_rules FOR INSERT WITH CHECK (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- UPDATE: only as self, and the row may not be re-homed to another wallet
-- (USING gates which rows are visible to update, WITH CHECK gates what they may
-- become — both are needed or an owner could hand a rule to someone else).
DROP POLICY IF EXISTS "Owner updates own alert rules" ON alert_rules;
CREATE POLICY "Owner updates own alert rules" ON alert_rules FOR UPDATE USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
) WITH CHECK (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- DELETE: only as self.
DROP POLICY IF EXISTS "Owner deletes own alert rules" ON alert_rules;
CREATE POLICY "Owner deletes own alert rules" ON alert_rules FOR DELETE USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- Role grants mirror 008_grant_new_table_roles.sql: PostgREST reaches the table
-- as `authenticated` (the SIWE JWT's role) and RLS does the scoping. `anon` gets
-- nothing — an unauthenticated caller has no rules and no business reading any.
GRANT SELECT, INSERT, UPDATE, DELETE ON alert_rules TO authenticated;
REVOKE ALL ON alert_rules FROM anon;

-- ── Record this file in the ledger ────────────────────────────────────
-- Added 2026-08-24: the self-recording INSERT MIGRATIONS.md describes was
-- missing from every file after 000 — the ledger was fiction for 016-021.
INSERT INTO public.schema_migrations (filename, note)
VALUES ('016_alert_rules.sql', 'alert_rules store for the alerts resource; fails closed as schema-missing until applied')
ON CONFLICT (filename) DO NOTHING;
