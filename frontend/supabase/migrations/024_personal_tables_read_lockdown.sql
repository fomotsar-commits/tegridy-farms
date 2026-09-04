-- ============================================================
-- 024 — user_watchlist / user_favorites: close the anon read side
--
-- This is 015 §2, resolved for the two tables where it was never really a
-- product decision. 015 left four read-side `USING (true)` policies commented
-- out and asked for a per-table call. Two of them are now made:
--
--   user_watchlist  — DROPPED here. `target_price` and `note` are a statement
--                     of trading intent, keyed to a wallet column that joins
--                     straight onto on-chain history. 015's own header calls
--                     this "the most sensitive of the four".
--   user_favorites  — DROPPED here. A behavioural profile of a wallet.
--   user_profiles   — LEFT PUBLIC. A profile is a public identity; that is the
--                     feature, not a leak.
--   votes           — LEFT PUBLIC, and this one is load-bearing. getVoteTally
--                     (userdata.js:522) counts EVERY wallet's votes for a week
--                     with no wallet filter. An owner-scoped policy would
--                     return only the caller's own row and the public tally
--                     would silently read 1. Closing this needs an aggregate
--                     (a SECURITY DEFINER count function or a view), which is
--                     a feature, not a DROP — do not uncomment it here.
--
-- WHY IT IS NOT MERELY A PRODUCT DECISION
--   PrivacyPage §3 already tells every visitor, in the published policy:
--   "Row-Level Security is enforced on every row by the wallet claim in your
--   SIWE-issued JWT". For these two tables that was not true. Anyone who
--   pulled VITE_SUPABASE_ANON_KEY out of the shipped JS bundle could read the
--   whole table. This migration makes the product match its own privacy policy.
--
-- ⚠️ ORDERING — THE CODE MUST SHIP FIRST, AND IT ALREADY HAS
--   The anon key carries no wallet claim, so once the permissive policy is
--   gone the owner-scoped twin can only match a request that arrives with the
--   SIWE JWT — which lives in an httpOnly cookie only /api/supabase-proxy can
--   read. Applying this DROP while the browser still read with the anon key
--   would have returned ZERO ROWS to every user, with no error: the silent
--   zero this codebase refuses.
--
--   So the read moved first (AUDIT FIX TF-004 / TF-007):
--     - frontend/api/supabase-proxy.js       SELECT_TABLES gained both tables
--     - frontend/src/nakamigos/lib/supabaseProxy.js   new proxyRead()
--     - frontend/src/nakamigos/lib/userdata.js        syncFavorites /
--       syncWatchlist read via proxyRead, not the anon client
--   pinned by src/nakamigos/userdataWriteHonesty.test.js, which now FAILS if
--   either read goes back to the anon key.
--
--   Deploy that frontend BEFORE applying this file. In the gap the tables are
--   merely still readable — the state they have been in all along — so there
--   is no window where the feature is broken.
--
-- ⛔ PREFLIGHT — DO NOT APPLY BLIND.
--
--      # 1. Is the anon read open today? (200 = open, this file matters)
--      curl -s -o /dev/null -w '%{http_code}\n' \
--        -H "apikey: $SUPABASE_ANON_KEY" \
--        "$SUPABASE_URL/rest/v1/user_watchlist?select=wallet&limit=1"
--
--      # 2. Is the owner-scoped twin actually present? It is what survives.
--      #    Expect one row per table; if it is missing, STOP — dropping the
--      #    permissive policy would leave no SELECT policy at all.
--      select tablename, policyname, qual from pg_policies
--       where schemaname = 'public'
--         and cmd = 'SELECT'
--         and tablename in ('user_watchlist','user_favorites');
--
--      # 3. Does the DEPLOYED bundle still read these tables from PostgREST?
--      #    Grep the LIVE bundle (not the source) for 'rest/v1/user_watchlist'
--      #    and 'rest/v1/user_favorites'. Zero hits = the proxy is the only
--      #    reader and this DROP breaks nothing.
--
-- IDEMPOTENCY
--   Statements here are applied by hand and get re-run. Both DROPs are
--   `IF EXISTS` and the ledger insert is `ON CONFLICT DO NOTHING`, so
--   re-running is safe.
--
--   (There IS a ledger — `public.schema_migrations`, created by 000 §0 and
--   written by 9 of the 25 migrations. Earlier files, 015 included, say there
--   is none; that was true before 000 was rewritten and is not true now. This
--   file writes its row, per audit TF-020.)
-- ============================================================

BEGIN;

-- The owner-scoped twins ("Owner reads watchlist" / "Owner reads favorites")
-- are created by 000 §4 / §3 and are NOT touched here. They are the policy
-- that survives, and they match on the SIWE wallet claim the proxy forwards.

DROP POLICY IF EXISTS "Anyone can read watchlist"  ON public.user_watchlist;
DROP POLICY IF EXISTS "Anyone can read favorites"  ON public.user_favorites;

-- ── Record this file in the ledger ────────────────────────────────────
-- AUDIT FIX TF-020: `public.schema_migrations` exists (000 §0) and 9 of the 25
-- migrations write to it. A migration that applies silently is a migration
-- nobody can prove ran, and this one is order-sensitive against a frontend
-- deploy — exactly the case the ledger is for.
INSERT INTO public.schema_migrations (filename, note)
VALUES (
  '024_personal_tables_read_lockdown.sql',
  'anon SELECT revoked on user_watchlist + user_favorites; the SIWE proxy is the only read path. votes/user_profiles deliberately untouched.'
)
ON CONFLICT (filename) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ── VERIFICATION ─────────────────────────────────────────────────────
-- (a) Must return ZERO rows — no unconditional SELECT policy survives on the
--     two personal tables.
--
-- select tablename, policyname, coalesce(qual, with_check) as expr
--   from pg_policies
--  where schemaname = 'public'
--    and cmd = 'SELECT'
--    and permissive = 'PERMISSIVE'
--    and coalesce(qual, with_check) = 'true'
--    and tablename in ('user_watchlist','user_favorites');
--
-- (b) Must return exactly one row per table — the owner-scoped policy is
--     still there. An empty result here means the tables are now unreadable
--     by anyone, which is a different outage, not a fix.
--
-- select tablename, policyname from pg_policies
--  where schemaname = 'public'
--    and cmd = 'SELECT'
--    and tablename in ('user_watchlist','user_favorites');
--
-- (c) From a shell, with only the anon key: must now return an empty array,
--     where before it returned every wallet's rows.
--
-- curl -s -H "apikey: $SUPABASE_ANON_KEY" \
--   "$SUPABASE_URL/rest/v1/user_watchlist?select=wallet&limit=5"
