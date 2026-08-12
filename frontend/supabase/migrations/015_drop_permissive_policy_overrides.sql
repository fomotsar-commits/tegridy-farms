-- ============================================================
-- 015 — DROP the permissive policy overrides that defeat row ownership
--
-- ⚠️ APPLY THIS **BEFORE** `014_siwe_nonces.sql`. See ORDERING below.
--
-- WHAT IS ACTUALLY WRONG IN PRODUCTION
--   Read out of the live database on 2026-08-12 (role `postgres`):
--   RLS *is* enabled on all 10 public tables and there are 40 policies — so
--   the long-standing worry that "RLS was never switched on" is WRONG.
--
--   The defect is subtler and worse. Every user-owned table carries TWO
--   policies per command: the owner-scoped one from `001_siwe_auth_rls.sql`
--   ("Owner can …", qual `wallet = lower(current_setting('request.jwt.claims')…)`)
--   AND a legacy permissive one ("Anyone can …") whose qual/with_check is
--   literally `true`. Both are PERMISSIVE and both are granted to `public`.
--
--   PostgreSQL OR-combines PERMISSIVE policies for the same command. The
--   effective rule is therefore:
--
--       true OR (wallet = jwt.wallet)   ≡   true
--
--   The owner policies are dead weight. Anyone holding the anon key can read,
--   insert, update and delete ANY user's rows on user_favorites,
--   user_profiles, user_watchlist and votes.
--
--   `004_security_hardening.sql` was supposed to DROP these legacy policies
--   and never ran, so both generations coexist and the weaker one wins.
--   THE FIX IS THEREFORE A **DROP**, NOT AN ADD. Do not "add RLS" — it is on.
--   Do not add a RESTRICTIVE policy either: dropping is simpler and leaves a
--   schema that says what it means.
--
-- ⚠️ ORDERING — THIS IS THE WHOLE POINT
--   Nothing is exposed *today* only because SIWE login has never worked, so
--   every one of these tables is empty. `014_siwe_nonces.sql` fixes login and
--   starts populating them. Applying 014 first would publish every user's
--   favourites, watchlist, profile and votes to anyone with the anon key on
--   day one. Run 015 first (it is a no-op on empty tables), then 014.
--
-- IDEMPOTENCY
--   This database has no migration ledger; statements are applied by hand and
--   get re-run. Every DROP below is `IF EXISTS`, so re-running is safe. It is
--   also safe if 004 is ever repaired and applied — 004 drops the same names.
--
-- WHAT THIS DELIBERATELY DOES **NOT** TOUCH
--   Public-by-design reads stay public. `messages` ("Anyone can read",
--   "Anyone can read messages"), `native_orders` ("Anyone can read orders")
--   and `trade_offers` ("Anyone can read trades") are a public chat and a
--   public orderbook; their permissive SELECT is intended, not a defect.
--   `revoked_jwts` ("Service role only") and the `Service role can …` policies
--   on native_orders/trade_offers also read `true`, but they are gated by
--   table GRANTs rather than by RLS — changing them here would break the
--   service-role write paths. Left alone on purpose.
--
-- VERIFY AFTER RUNNING — the query at the bottom must return ZERO rows.
-- ============================================================

BEGIN;

-- ── SECTION 1 — MANDATORY. Write-side ownership defeats. ──────────────
-- Each of these lets any caller write a row belonging to any wallet. There
-- is no legitimate reading of these; the "Owner can …" twin already
-- expresses the intended rule and survives untouched.

-- user_favorites
DROP POLICY IF EXISTS "Anyone can delete favorites"   ON public.user_favorites;
DROP POLICY IF EXISTS "Anyone can insert favorites"   ON public.user_favorites;

-- user_profiles
DROP POLICY IF EXISTS "Anyone can upsert own profile" ON public.user_profiles;
DROP POLICY IF EXISTS "Anyone can update own profile" ON public.user_profiles;

-- user_watchlist
DROP POLICY IF EXISTS "Anyone can delete watchlist"   ON public.user_watchlist;
DROP POLICY IF EXISTS "Anyone can insert watchlist"   ON public.user_watchlist;

-- votes
DROP POLICY IF EXISTS "Anyone can insert votes"       ON public.votes;
DROP POLICY IF EXISTS "Anyone can update own vote"    ON public.votes;

-- ── SECTION 2 — PRODUCT DECISION. Read-side exposure. ─────────────────
-- These four make one user's rows readable by anyone. That may be intended
-- for some of them, so they are NOT dropped by default:
--
--   votes          — vote COUNTS are almost certainly meant to be public,
--                    but this exposes WHO voted for WHAT, per wallet.
--   user_profiles  — public profiles are a normal product choice.
--   user_favorites — a wallet's favourites are a behavioural profile.
--   user_watchlist — a watchlist leaks trading intent; the most sensitive
--                    of the four.
--
-- The owner-scoped SELECT twin ("Owner reads watchlist" etc.) already exists
-- for each, so uncommenting a line makes that table owner-only immediately —
-- no other change required. Decide per table; do not blanket-uncomment.
--
-- DROP POLICY IF EXISTS "Anyone can read favorites"  ON public.user_favorites;
-- DROP POLICY IF EXISTS "Anyone can read profiles"   ON public.user_profiles;
-- DROP POLICY IF EXISTS "Anyone can read watchlist"  ON public.user_watchlist;
-- DROP POLICY IF EXISTS "Anyone can read votes"      ON public.votes;

COMMIT;

-- ── VERIFICATION — must return ZERO rows once Section 1 has applied ───
-- Any row here is a write-side policy that still grants unconditional access.
--
-- select tablename, cmd, policyname
--   from pg_policies
--  where schemaname = 'public'
--    and permissive = 'PERMISSIVE'
--    and cmd <> 'SELECT'
--    and coalesce(qual, with_check) = 'true'
--    and tablename in ('user_favorites','user_profiles','user_watchlist','votes')
--  order by tablename, cmd;
--
-- And confirm the owner policies survived (expect one row per command/table):
--
-- select tablename, cmd, policyname, coalesce(qual, with_check) as expr
--   from pg_policies
--  where schemaname = 'public'
--    and tablename in ('user_favorites','user_profiles','user_watchlist','votes')
--  order by tablename, cmd, policyname;
