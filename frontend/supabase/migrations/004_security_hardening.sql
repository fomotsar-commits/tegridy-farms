-- ============================================================
-- Migration 004: Security Hardening (R059)
--
-- Source findings (audit agent 080, batch R059):
--   1. MED — toggle_like is SECURITY DEFINER without SET search_path
--      (001_siwe_auth_rls.sql:90-110). Schema-hijack risk on
--      array_remove / array_append resolution: if an attacker (or
--      faulty role) prepends a malicious schema to search_path,
--      they can shadow built-ins.
--   2. MED — prune_revoked_jwts has the same defect AND default
--      EXECUTE TO PUBLIC was never revoked (003_revoked_jwts.sql:40-48).
--   3. MED — RLS on `messages.author` lowercases JWT side only, not
--      row side; mixed-case bypass possible if the proxy is sidestepped
--      (001_siwe_auth_rls.sql:26-30).
--   4. LOW — Legacy "Anyone can read trades" public-read policy from
--      001_siwe_auth_rls.sql:118-120 was never dropped in 002, so the
--      participant-only SELECT policy from 002 is OR-combined with
--      public-read (PostgreSQL evaluates permissive policies as OR).
--      Net effect: trade_offers SELECT is effectively public.
--   5. LOW — `rate_limit_messages` BEFORE INSERT trigger is documented
--      in supabase.js:25-43 but absent from migration files.
--
-- Battle-tested patterns applied:
--   - SECURITY DEFINER functions ALWAYS pin search_path = public, pg_temp
--     to prevent schema-hijack on built-in resolution.
--   - RLS comparisons normalize case on BOTH sides (lower(row) = lower(jwt)).
--   - Policy hygiene: explicit DROP + CREATE — never leave overlapping
--     permissive policies, since PostgreSQL OR-combines them.
--
-- Migrations are append-only. This file does not edit 001-003; it only
-- ALTERs / DROPs / re-CREATEs the affected objects in place.
--
-- Run in Supabase SQL Editor AFTER 003_revoked_jwts.sql.
-- ============================================================

-- ── 1. Pin search_path on SECURITY DEFINER functions ──
-- Without `SET search_path`, a SECURITY DEFINER function resolves
-- unqualified names against the caller's search_path. An attacker
-- with CREATE on any schema in that path can shadow `array_remove`,
-- `array_append`, `now()`, etc. Pinning to `public, pg_temp` makes
-- schema-hijack impossible for these two functions.

ALTER FUNCTION public.toggle_like(uuid, text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.prune_revoked_jwts()
  SET search_path = public, pg_temp;

-- ── 2. Lock down EXECUTE on prune_revoked_jwts ──
-- PostgreSQL's default for CREATE FUNCTION is GRANT EXECUTE TO PUBLIC,
-- which means anonymous (anon role) Supabase clients can call this
-- function via PostgREST. As SECURITY DEFINER it runs with the owner's
-- privileges and modifies the JWT revocation list. Restrict to the
-- service_role only — the only legitimate caller is /api/auth/siwe
-- (and the optional cron) using the service key.
REVOKE EXECUTE ON FUNCTION public.prune_revoked_jwts() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prune_revoked_jwts() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.prune_revoked_jwts() TO   service_role;

-- toggle_like is intentionally callable by `authenticated` (the JWT
-- check inside the function gates the action), but should not be
-- callable by `anon`. The internal RAISE EXCEPTION when jwt_wallet
-- IS NULL already covers the anon path, but defense-in-depth: revoke
-- the public default and grant only what's needed.
REVOKE EXECUTE ON FUNCTION public.toggle_like(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.toggle_like(uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.toggle_like(uuid, text) TO   authenticated, service_role;

-- ── 3. Drop legacy permissive policy on trade_offers ──
-- 001_siwe_auth_rls.sql:118-120 created an "Anyone can read trades"
-- public-read policy. 002_native_orders_trades_push.sql:88-91 added a
-- "Participants read trades" participant-only policy but did NOT
-- drop the public one. Permissive policies OR together, so the public
-- read still wins. Drop it now so only participants can SELECT.
DROP POLICY IF EXISTS "Anyone can read trades" ON public.trade_offers;

-- 001 also created "Owner can insert trades" / "Participants can update trades"
-- with column names (from_wallet / to_wallet) that don't match the schema
-- 002 actually created (offerer / target_owner). 002 created its own correct
-- policies on the right columns, but the 001 policies still exist and either:
--   (a) reference non-existent columns and silently fail-deny, or
--   (b) exist as orphan policies that confuse the catalog.
-- Either way, drop them so the policy set on trade_offers is exactly
-- what 002 declared.
DROP POLICY IF EXISTS "Owner can insert trades" ON public.trade_offers;
DROP POLICY IF EXISTS "Participants can update trades" ON public.trade_offers;

-- ── 4. Symmetric case-normalization on messages.author ──
-- 001_siwe_auth_rls.sql:26-30 lowercases the JWT side but trusts the
-- row's `author` field as-is. If an INSERT arrives with author='0xABCD...'
-- (mixed case) and the JWT wallet is '0xabcd...' (lowercase), the
-- equality `author = lower(jwt)` fails. The proxy does normalize input,
-- but if a future code path (or direct PostgREST hit with the user's
-- token) skips normalization, mixed-case author bypasses the check or
-- locks the user out of their own messages depending on direction.
-- Compare lowercased on BOTH sides so case can't matter.
DROP POLICY IF EXISTS "Verified can insert" ON public.messages;
CREATE POLICY "Verified can insert" ON public.messages FOR INSERT WITH CHECK (
  lower(author) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  AND char_length(text) <= 280
  AND char_length(slug) <= 64
);

-- Same fix for every other table whose RLS compares a wallet column
-- against the JWT claim. The JWT side is already lower()'d in 001/002;
-- we now lower() the row side too. Mixed-case row data would only land
-- there via a write path that bypassed normalization, but defense-in-depth.
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

-- Symmetric lowering for the SELECT-side policies declared in 002.
DROP POLICY IF EXISTS "Owner reads favorites" ON public.user_favorites;
CREATE POLICY "Owner reads favorites" ON public.user_favorites FOR SELECT USING (
  lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

DROP POLICY IF EXISTS "Owner reads watchlist" ON public.user_watchlist;
CREATE POLICY "Owner reads watchlist" ON public.user_watchlist FOR SELECT USING (
  lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- trade_offers (offerer/target_owner columns from 002).
DROP POLICY IF EXISTS "Participants read trades" ON public.trade_offers;
CREATE POLICY "Participants read trades" ON public.trade_offers FOR SELECT USING (
  lower(offerer)      = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  OR lower(target_owner) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

DROP POLICY IF EXISTS "Offerer creates trade" ON public.trade_offers;
CREATE POLICY "Offerer creates trade" ON public.trade_offers FOR INSERT WITH CHECK (
  lower(offerer) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

DROP POLICY IF EXISTS "Participants update trade status" ON public.trade_offers;
CREATE POLICY "Participants update trade status" ON public.trade_offers FOR UPDATE USING (
  lower(offerer)      = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  OR lower(target_owner) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- push_subscriptions.
DROP POLICY IF EXISTS "Owner reads push subs" ON public.push_subscriptions;
CREATE POLICY "Owner reads push subs" ON public.push_subscriptions FOR SELECT USING (
  lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

DROP POLICY IF EXISTS "Owner registers push sub" ON public.push_subscriptions;
CREATE POLICY "Owner registers push sub" ON public.push_subscriptions FOR INSERT WITH CHECK (
  lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

DROP POLICY IF EXISTS "Owner removes push sub" ON public.push_subscriptions;
CREATE POLICY "Owner removes push sub" ON public.push_subscriptions FOR DELETE USING (
  lower(wallet) = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- And the 001-era duplicate created at line 144-149 with FOR ALL.
DROP POLICY IF EXISTS "Owner can manage own subs" ON public.push_subscriptions;

-- ── 5. rate_limit_messages trigger (per supabase.js:25-43) ──
-- The supabase.js docstring describes a 5-second-per-author rate-limit
-- BEFORE INSERT trigger that was never written into the migrations. Add
-- it here so the database itself enforces the cooldown — currently this
-- is only enforced in the proxy (supabase-proxy.js), so a leaked
-- service-role key or a future direct-PostgREST path would skip it.
--
-- This function ALSO uses SET search_path to be safe; even though it's
-- just a SECURITY INVOKER trigger, hardening trigger functions is cheap.
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

-- DROP first so re-runs are idempotent (CREATE TRIGGER has no IF NOT EXISTS).
DROP TRIGGER IF EXISTS rate_limit_messages ON public.messages;
CREATE TRIGGER rate_limit_messages
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.check_message_rate_limit();

-- ── 6. Sanity comments on trade_offers' final policy set ──
-- After this migration, trade_offers has exactly:
--   SELECT  → participants only          ("Participants read trades")
--   INSERT  → offerer = JWT wallet       ("Offerer creates trade")
--   UPDATE  → either participant         ("Participants update trade status")
--   (no DELETE policy → DELETE denied to non-superusers)
-- The 001-era policies referencing from_wallet/to_wallet are gone.
