-- ============================================================
-- 000 — BASE SCHEMA. The five tables no migration ever created.
--
-- ⚠️ NOT APPLIED. Nothing in this repo applies SQL. See supabase/RESTORE.md
--    for the order this file belongs in and the traps around it.
--
-- WHY THIS FILE EXISTS
--   Migrations 001–018 create eleven tables: siwe_nonces, native_orders,
--   trade_offers, push_subscriptions, revoked_jwts, dm_messages,
--   analytics_events, alert_rules, api_keys, airdrop_manifests and
--   airdrop_manifest_entries. (The finding that opened this said seven; three
--   more migrations landed on 2026-08-19. The count moved, the gap did not.)
--
--   They create NONE of `messages`, `user_profiles`, `user_favorites`,
--   `user_watchlist`, `votes` — and all five are live in production, written
--   by frontend/api/supabase-proxy.js on every chat message, profile save,
--   favourite, watchlist entry and vote.
--
--   Those five were created by hand in the Supabase SQL editor (009's header
--   names the culprit: a raw "Full Supabase Schema" query) and the statements
--   were never committed. The consequence is not cosmetic: a fresh Supabase
--   project built from this repo comes up with 001 aborting, five tables
--   missing, and a weekly backup bundle that has nothing to restore INTO.
--
-- ⚠️ HOW THESE DEFINITIONS WERE OBTAINED — READ BEFORE TRUSTING A TYPE
--   The live database was NOT read to write this file; it was derived from
--   what the shipped code demands. Three tiers of confidence are marked
--   inline and they are not the same thing:
--
--     [DDL]      Copied from a CREATE TABLE that exists in the tree as the
--                documented schema for this table:
--                  src/nakamigos/lib/supabase.js:14-20   → messages
--                  src/nakamigos/lib/userdata.js:14-74   → the other four
--                These are the closest thing to a source of truth that
--                survives, and 009's column list independently corroborates
--                the `messages` one.
--     [CODE]     Proven by a migration or by application code that would
--                break without it (a column read, an RLS expression, an
--                index, a trigger).
--     [INFERRED] NOT determinable from the tree. The choice made here is
--                stated with its reasoning. If the live database disagrees,
--                the live database is right and this line is the bug.
--
--   Nothing below is a silent guess. Where a length limit is enforced only by
--   frontend/api/_lib/proxy-schemas.js and no CHECK constraint is provable,
--   the column is created WITHOUT the constraint and the bound is recorded in
--   a comment — inventing a CHECK that prod does not have would make a
--   restore reject rows the backup legitimately contains.
--
-- WHICH STATE THIS REPRODUCES
--   The INTENDED state, i.e. after 015 §1. The eight legacy permissive write
--   policies ("Anyone can insert favorites" and its siblings) are deliberately
--   NOT created here — recreating them would rebuild the exposure that
--   015_drop_permissive_policy_overrides.sql exists to remove. Running 015
--   after this file is a no-op, which is the intent: both files converge on
--   one policy set.
--
--   The four permissive READ policies ARE created, because they are live and
--   because 015 §2 leaves them as an open product decision. Removing them here
--   would be that decision, taken quietly, in the wrong file — and it would
--   break real read paths (see the note above each one).
--
-- IDEMPOTENCY IS MANDATORY
--   This database has no migration ledger. Statements are applied by hand,
--   out of order, and get re-run. Every statement below is safe to execute any
--   number of times: CREATE ... IF NOT EXISTS, DROP POLICY IF EXISTS before
--   CREATE POLICY, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before
--   CREATE TRIGGER, idempotent GRANTs. That also makes this file safe to run
--   against the EXISTING production database: every one of the five tables is
--   already there, so it creates nothing and only converges the policy set.
--
-- SAFE TO RUN: creates tables that do not exist and re-asserts policies on
-- them. Touches no table owned by another migration.
-- ============================================================

BEGIN;

-- ── §0. The migration ledger ──────────────────────────────────────────
--
-- Not one of the five. It is here because a database rebuilt from this repo
-- should have a ledger from birth, and because this is the only file in the
-- set whose number cannot collide with a parallel author's.
--
-- This is the recording half of the fix described in supabase/MIGRATIONS.md:
-- every migration ends by inserting its own filename, so "did 016 land?" is a
-- question the database can answer instead of a thing someone remembers. It
-- records; it does not enforce. Nothing here refuses to run a file twice —
-- idempotency is still each file's own job.
--
-- Service-role only, like siwe_nonces: an operational record is not user data
-- and anon has no business reading which migrations a project is missing.
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename    text        PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  -- Free text. Who/where, for the case where two people are applying by hand.
  applied_by  text,
  note        text
);

ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.schema_migrations FROM anon, authenticated;
GRANT ALL ON public.schema_migrations TO service_role;

DROP POLICY IF EXISTS "Service role only" ON public.schema_migrations;
CREATE POLICY "Service role only" ON public.schema_migrations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── §1. messages ──────────────────────────────────────────────────────
--
-- The community/per-collection chat. Rooms are `slug` partitions of this one
-- table; there is no rooms table and adding one is not required by anything.
--
-- Column provenance:
--   id          [DDL]  supabase.js:14
--   slug        [CODE] 009 adds it with exactly this NOT NULL DEFAULT after
--                      prod 42703'd on it. Every read filters `.eq("slug", …)`
--                      (supabase.js:167) and the INSERT policy bounds it at 64.
--   author      [DDL]  supabase.js:16. Lowercased by the write path
--                      (supabase.js sendMessage) and compared case-insensitively
--                      by RLS since 004 §4. No CHECK is provable; none added,
--                      because one would reject legacy mixed-case rows that a
--                      backup may legitimately carry.
--   text        [DDL]  supabase.js:17 — the 280 CHECK is corroborated by the
--                      RLS INSERT policy and by proxy-schemas.js:32.
--   token_id    [DDL]  supabase.js:18. Nullable: null = room-level message,
--                      set = per-NFT thread. proxy-schemas bounds it at 64
--                      chars; no column CHECK is provable, so none is added.
--   likes       [CODE] text[] is forced by toggle_like's array_remove /
--                      array_append / `= ANY(likes)` (006:64-65). NULLABLE on
--                      purpose, matching supabase.js:19 — the read path does
--                      `row.likes ?? []` (supabase.js:134), which is what a
--                      column that can be NULL looks like from the client. A
--                      NOT NULL here would reject restored rows carrying null.
--   reactions   [CODE] 007 §B2 adds it, jsonb NOT NULL DEFAULT '{}'.
--                      toggle_reaction (011) is the only writer.
--   created_at  [DDL]  supabase.js:20. Ordering key for every read.
CREATE TABLE IF NOT EXISTS public.messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text        NOT NULL DEFAULT 'nakamigos',
  author      text        NOT NULL,
  text        text        NOT NULL CHECK (char_length(text) <= 280),
  token_id    text,
  likes       text[]      DEFAULT '{}',
  reactions   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz DEFAULT now()
);

COMMENT ON COLUMN public.messages.reactions IS 'emoji -> [lowercase wallets], maintained via toggle_reaction RPC';

-- [CODE] 009's definition, not supabase.js's. The two disagree — the docstring
-- says (slug), 009 says (slug, created_at) — and 009 is both later and the one
-- that matches the query shape (filter on slug, order by created_at).
CREATE INDEX IF NOT EXISTS idx_messages_slug ON public.messages(slug, created_at);

-- [CODE] The 5-second per-author cooldown. Lifted verbatim from
-- 004_security_hardening.sql §5 so `messages` is complete without it: 004 is
-- the one file the runbook forbids applying as a unit against the live
-- database, and a table whose only integrity rule lives inside a forbidden
-- file is a table that gets rebuilt without the rule. Re-running 004 §5 after
-- this is a no-op.
CREATE OR REPLACE FUNCTION public.check_message_rate_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.messages
    WHERE author = NEW.author
      AND slug   = NEW.slug
      AND created_at > now() - interval '5 seconds'
  ) THEN
    RAISE EXCEPTION 'Rate limit exceeded';
  END IF;
  RETURN NEW;
END;
$$;

-- ⚠️ CONDITIONAL RESTORE HAZARD — read the predicate before assuming either way.
-- The EXISTS above tests the created_at of rows ALREADY in the table, not
-- NEW.created_at. A restore that carries each row's original created_at
-- through (which the backup bundle does, and which scripts/supabase-restore.mjs
-- posts verbatim) therefore never trips it: no historical timestamp is newer
-- than now() - 5s. But any load path that DROPS created_at and lets the DEFAULT
-- fire — a hand-written INSERT, a column-filtered import — trips it on the
-- second row of every author, and the table comes back holding one message per
-- person. Check that created_at is in your payload; do not disable the trigger
-- on a guess.
DROP TRIGGER IF EXISTS rate_limit_messages ON public.messages;
CREATE TRIGGER rate_limit_messages
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.check_message_rate_limit();

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Public read. [CODE] 002:149-150. Chat is public by design and 015's header
-- says so in terms — this permissive SELECT is intended, not a defect.
--
-- NOTE: the live database also carries a second, redundant read policy named
-- "Anyone can read" from the original raw-SQL schema (015's header lists both
-- names). It is not reproduced here: two permissive SELECT policies with qual
-- `true` have exactly the effect of one, and recreating catalogue clutter is
-- not restoration.
DROP POLICY IF EXISTS "Anyone can read messages" ON public.messages;
CREATE POLICY "Anyone can read messages" ON public.messages
  FOR SELECT USING (true);

-- [CODE] 004 §4's form — lower() on BOTH sides. 001's version lowercased only
-- the JWT side; do not restore that one.
DROP POLICY IF EXISTS "Verified can insert" ON public.messages;
CREATE POLICY "Verified can insert" ON public.messages FOR INSERT WITH CHECK (
  lower(author) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  AND char_length(text) <= 280
  AND char_length(slug) <= 64
);

-- [INFERRED] Declared in src/nakamigos/lib/supabase.js:57 and in no migration,
-- so it cannot be confirmed live. Created anyway because it is free: with RLS
-- on and no permissive UPDATE policy, UPDATE is already denied — this policy
-- only makes the denial say why. Likes and reactions move through the two
-- SECURITY DEFINER RPCs, which bypass RLS on purpose.
DROP POLICY IF EXISTS "No direct updates" ON public.messages;
CREATE POLICY "No direct updates" ON public.messages
  FOR UPDATE USING (false);

-- No DELETE policy, in this file or any migration: nothing in the app deletes
-- a message. RLS denies it. Absence here is the rule, not an omission.

-- ── §2. user_profiles ─────────────────────────────────────────────────
--
-- Column provenance: all [DDL] from userdata.js:14-21.
--   avatar_url  proxy-schemas.js:42 bounds it at 512 chars and requires a URL
--               shape; neither is provable as a column constraint, so neither
--               is created. The proxy is the enforcement point.
--   updated_at  written explicitly by saveProfile (userdata.js:259); the
--               DEFAULT only covers rows written by some other path.
-- Primary key on `wallet` is what makes the proxy's UPSERT
-- (Prefer: resolution=merge-duplicates) resolve — without it every profile
-- save would insert a duplicate row instead of updating.
CREATE TABLE IF NOT EXISTS public.user_profiles (
  wallet        text PRIMARY KEY,
  display_name  text CHECK (char_length(display_name) <= 32),
  bio           text CHECK (char_length(bio) <= 160),
  twitter       text CHECK (char_length(twitter) <= 40),
  avatar_url    text,
  updated_at    timestamptz DEFAULT now()
);

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- ⚠️ 015 §2 — OPEN PRODUCT DECISION, NOT SETTLED HERE.
-- getProfile (userdata.js:200) reads this table with the ANON key. Drop this
-- policy and every profile in the app renders blank for signed-out visitors.
-- If profiles are to become owner-only, that decision belongs in 015 §2 where
-- it is written down, not in a silent difference between prod and a rebuild.
DROP POLICY IF EXISTS "Anyone can read profiles" ON public.user_profiles;
CREATE POLICY "Anyone can read profiles" ON public.user_profiles
  FOR SELECT USING (true);

-- [CODE] 004 §4 form.
DROP POLICY IF EXISTS "Owner can upsert own profile" ON public.user_profiles;
CREATE POLICY "Owner can upsert own profile" ON public.user_profiles
  FOR INSERT WITH CHECK (
    lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

DROP POLICY IF EXISTS "Owner can update own profile" ON public.user_profiles;
CREATE POLICY "Owner can update own profile" ON public.user_profiles
  FOR UPDATE USING (
    lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

-- ── §3. user_favorites ────────────────────────────────────────────────
--
-- Column provenance: all [DDL] from userdata.js:32-38. The composite primary
-- key is load-bearing twice over: it is the UPSERT conflict target for the
-- batched sync (userdata.js:298-302, up to 200 rows in one call) and it is
-- what makes a favourite idempotent.
CREATE TABLE IF NOT EXISTS public.user_favorites (
  wallet           text        NOT NULL,
  token_id         text        NOT NULL,
  collection_slug  text        NOT NULL DEFAULT 'nakamigos',
  created_at       timestamptz DEFAULT now(),
  PRIMARY KEY (wallet, token_id, collection_slug)
);

ALTER TABLE public.user_favorites ENABLE ROW LEVEL SECURITY;

-- ⚠️ 015 §2 — OPEN PRODUCT DECISION. syncFavorites (userdata.js:283) reads
-- with the ANON key. Dropping this makes every signed-out favourites list
-- render empty rather than unavailable — a silent zero, which is the one
-- failure this codebase does not accept. The owner-scoped twin below already
-- covers the authenticated path.
DROP POLICY IF EXISTS "Anyone can read favorites" ON public.user_favorites;
CREATE POLICY "Anyone can read favorites" ON public.user_favorites
  FOR SELECT USING (true);

-- [CODE] 002:155 + 004 §4 form.
DROP POLICY IF EXISTS "Owner reads favorites" ON public.user_favorites;
CREATE POLICY "Owner reads favorites" ON public.user_favorites FOR SELECT USING (
  lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

DROP POLICY IF EXISTS "Owner can insert favorites" ON public.user_favorites;
CREATE POLICY "Owner can insert favorites" ON public.user_favorites
  FOR INSERT WITH CHECK (
    lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

DROP POLICY IF EXISTS "Owner can delete favorites" ON public.user_favorites;
CREATE POLICY "Owner can delete favorites" ON public.user_favorites
  FOR DELETE USING (
    lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

-- No UPDATE policy. removeFavoriteRemote deletes; nothing updates a favourite.

-- ── §4. user_watchlist ────────────────────────────────────────────────
--
-- Column provenance: all [DDL] from userdata.js:49-57.
--   target_price  numeric [DDL]. The proxy accepts a finite non-negative
--                 number (proxy-schemas.js:56) and the read maps it straight
--                 back (userdata.js:373). No precision is provable, so plain
--                 `numeric` — a fixed numeric(p,s) would silently round a
--                 restored price.
--   note          proxy-schemas.js:57 bounds it at 500 chars. Not provable as
--                 a column CHECK; not created. See the header.
CREATE TABLE IF NOT EXISTS public.user_watchlist (
  wallet           text        NOT NULL,
  token_id         text        NOT NULL,
  collection_slug  text        NOT NULL DEFAULT 'nakamigos',
  target_price     numeric,
  note             text,
  created_at       timestamptz DEFAULT now(),
  PRIMARY KEY (wallet, token_id, collection_slug)
);

ALTER TABLE public.user_watchlist ENABLE ROW LEVEL SECURITY;

-- ⚠️ 015 §2 — OPEN PRODUCT DECISION, and 015 calls this the most sensitive of
-- the four: a watchlist leaks trading intent. syncWatchlist (userdata.js:355)
-- reads it with the ANON key. Same rule as the others — decide in 015 §2.
DROP POLICY IF EXISTS "Anyone can read watchlist" ON public.user_watchlist;
CREATE POLICY "Anyone can read watchlist" ON public.user_watchlist
  FOR SELECT USING (true);

-- [CODE] 002:160 + 004 §4 form.
DROP POLICY IF EXISTS "Owner reads watchlist" ON public.user_watchlist;
CREATE POLICY "Owner reads watchlist" ON public.user_watchlist FOR SELECT USING (
  lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

DROP POLICY IF EXISTS "Owner can insert watchlist" ON public.user_watchlist;
CREATE POLICY "Owner can insert watchlist" ON public.user_watchlist
  FOR INSERT WITH CHECK (
    lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

DROP POLICY IF EXISTS "Owner can delete watchlist" ON public.user_watchlist;
CREATE POLICY "Owner can delete watchlist" ON public.user_watchlist
  FOR DELETE USING (
    lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

-- ⚠️ NO UPDATE POLICY, and this is a known asymmetry rather than an omission.
-- addWatchlistRemote (userdata.js:413) UPSERTs, so editing a target_price on
-- an existing row is an UPDATE that RLS denies. No migration ever created an
-- "Owner can update watchlist" policy and none is invented here — adding one
-- would be a behaviour change smuggled in as a restore. Flagged in
-- supabase/RESTORE.md; fix it in a numbered migration if it is real.

-- ── §5. votes ─────────────────────────────────────────────────────────
--
-- Column provenance: all [DDL] from userdata.js:68-74.
--   week  text, format `YYYY-Www`. getCurrentWeek (userdata.js:440) produces
--         it and proxy-schemas.js:63 enforces /^\d{4}-W\d{2}$/ on the way in.
--         Not created as a column CHECK: not provable, and a CHECK here would
--         reject restored rows from any earlier format.
--
-- ⚠️ The primary key is (wallet, week) and NOT (wallet, token_id, week). That
-- is the whole voting rule: one vote per wallet per week, and changing your
-- vote is an UPDATE of token_id on the existing row — which is why an
-- "Owner can update own vote" policy exists at all and why castVote UPSERTs.
-- Widening this key would silently turn one-vote-per-week into ballot
-- stuffing, and every tally in the app would still look plausible.
CREATE TABLE IF NOT EXISTS public.votes (
  wallet      text        NOT NULL,
  token_id    text        NOT NULL,
  week        text        NOT NULL,
  created_at  timestamptz DEFAULT now(),
  PRIMARY KEY (wallet, week)
);

ALTER TABLE public.votes ENABLE ROW LEVEL SECURITY;

-- ⚠️ 015 §2 — OPEN PRODUCT DECISION, and the trap of the four. getWeekVotes
-- (userdata.js:522) is an ANON SELECT that builds the public tally. Drop this
-- policy and the tally does not error, it renders ZERO for every token — an
-- outage that reads as a legitimate result. 015 §2 says an aggregate view has
-- to exist first. Until it does, this policy stays.
DROP POLICY IF EXISTS "Anyone can read votes" ON public.votes;
CREATE POLICY "Anyone can read votes" ON public.votes
  FOR SELECT USING (true);

-- [CODE] 004 §4 form.
DROP POLICY IF EXISTS "Owner can insert votes" ON public.votes;
CREATE POLICY "Owner can insert votes" ON public.votes
  FOR INSERT WITH CHECK (
    lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

DROP POLICY IF EXISTS "Owner can update own vote" ON public.votes;
CREATE POLICY "Owner can update own vote" ON public.votes
  FOR UPDATE USING (
    lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

-- No DELETE policy: a vote is changed, never withdrawn.

-- ── §6. Grants ────────────────────────────────────────────────────────
--
-- The verbs. RLS above decides which rows. These duplicate what migration 008
-- later grants across the whole schema; they are here so this file stands
-- alone — a base schema that needs a later migration to become reachable over
-- REST is not a base schema.
--
-- ⛔ 008 must never be applied AFTER 014: its blanket GRANT reverses 014's
--    REVOKE on siwe_nonces. That constraint is about 008, and it is why these
--    grants are scoped to five named tables instead of ON ALL TABLES.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.messages, public.user_profiles, public.user_favorites,
     public.user_watchlist, public.votes
  TO anon, authenticated;

GRANT ALL
  ON public.messages, public.user_profiles, public.user_favorites,
     public.user_watchlist, public.votes
  TO service_role;

COMMIT;

-- ── §7. Optional indexes — NOT part of the reproduction ───────────────
--
-- Left commented because none of them is provable against the live database,
-- and a base schema that quietly adds objects prod does not have stops being
-- a description of prod. Each one serves a query that exists today; uncomment
-- deliberately, in a numbered migration, if a plan shows it is needed.
--
-- CREATE INDEX IF NOT EXISTS idx_votes_week ON public.votes(week);
--   -- getWeekVotes: .eq("week", week) full-table scan today.
-- CREATE INDEX IF NOT EXISTS idx_favorites_wallet ON public.user_favorites(wallet, collection_slug);
-- CREATE INDEX IF NOT EXISTS idx_watchlist_wallet ON public.user_watchlist(wallet, collection_slug);
--   -- syncFavorites / syncWatchlist: .eq(wallet).eq(collection_slug). The
--   -- composite PK already leads on wallet, so these are near-duplicates —
--   -- measure before adding.

-- PostgREST caches the schema. Without this the tables exist and the REST
-- layer keeps answering PGRST205, i.e. the rebuild looks like it did nothing.
NOTIFY pgrst, 'reload schema';

-- ── Record this file in the ledger ────────────────────────────────────
-- The pattern every migration should end with. See supabase/MIGRATIONS.md.
INSERT INTO public.schema_migrations (filename, note)
VALUES ('000_base_schema.sql', 'five hand-created tables, derived from code; see file header')
ON CONFLICT (filename) DO NOTHING;

-- ── VERIFICATION — run after applying ─────────────────────────────────
--
-- 1. All five tables exist, with RLS on:
--
-- select c.relname, c.relrowsecurity
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public'
--    and c.relname in ('messages','user_profiles','user_favorites','user_watchlist','votes')
--  order by c.relname;
--   -- expect 5 rows, relrowsecurity = true on every one.
--
-- 2. NO permissive write-side policy grants unconditional access (the same
--    query 015 ends with — it must return ZERO rows here too):
--
-- select tablename, cmd, policyname
--   from pg_policies
--  where schemaname = 'public'
--    and permissive = 'PERMISSIVE'
--    and cmd <> 'SELECT'
--    and coalesce(qual, with_check) = 'true'
--    and tablename in ('messages','user_favorites','user_profiles','user_watchlist','votes')
--  order by tablename, cmd;
--
-- 3. PostgREST can see them — from a shell, with the ANON key:
--
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     -H "apikey: $SUPABASE_ANON_KEY" \
--     "$SUPABASE_URL/rest/v1/votes?select=token_id&limit=1"
--   -- 200 = visible. 404/PGRST205 = the NOTIFY above did not take effect.
