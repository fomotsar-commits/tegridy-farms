-- ============================================================
-- 014 — siwe_nonces (LIVE LOGIN OUTAGE FIX)
--
-- WHY THIS FILE EXISTS
--   `public.siwe_nonces` does not exist in production. PostgREST answers
--   PGRST205 ("Could not find the table 'public.siwe_nonces' in the schema
--   cache") for it, so the INSERT in `api/auth/siwe.js` (GET ?action=nonce)
--   returns an error and every login attempt 500s. SIWE login has therefore
--   never worked in production.
--
--   The table was *supposed* to come from `001_siwe_auth_rls.sql`, but 001
--   aborts partway through (it references tables/policies that do not all
--   exist), so everything after its first failing statement — including,
--   in practice, the nonce table — never landed. Do NOT "just re-run 001"
--   to fix this: it will abort again.
--
-- IDEMPOTENCY IS MANDATORY
--   This database has no migration ledger. Statements are applied by hand,
--   out of order, and get re-run. Every statement below is therefore
--   safe to execute any number of times:
--     - CREATE TABLE / CREATE INDEX use IF NOT EXISTS
--     - ENABLE ROW LEVEL SECURITY is idempotent
--     - GRANT/REVOKE are idempotent
--     - the policy is DROP ... IF EXISTS'd before CREATE
--
--   Object names deliberately match `001_siwe_auth_rls.sql` exactly
--   (table `siwe_nonces`, index `idx_nonces_expires`, policy
--   "Service role only") so that if 001 is ever repaired and re-run the two
--   files converge on ONE set of objects instead of creating duplicates.
--
-- SECURITY POSTURE — SERVICE ROLE ONLY
--   Nonces are the CSRF token for the SIWE login flow. If `anon` could read
--   this table an attacker could harvest a live nonce; if `anon` could write
--   it they could mint their own. RLS is enabled with a single service_role
--   policy, and the table-level grants that migration 008's
--   ALTER DEFAULT PRIVILEGES hands to anon/authenticated on every new public
--   table are explicitly revoked below. Two independent gates, both closed.
--
-- 🚨 DO NOT APPLY THIS FILE BEFORE `015_drop_permissive_policy_overrides.sql`
--
--   Verified against the live database 2026-08-12: RLS is enabled on all 10
--   public tables, but every owner-scoped policy on user_favorites,
--   user_profiles, user_watchlist and votes is OR'd with a PERMISSIVE
--   "Anyone can ..." policy whose qual is literally `true`. PostgreSQL
--   OR-combines permissive policies, so ownership is enforced NOWHERE on
--   those tables.
--
--   Those tables are empty and therefore harmless ONLY because SIWE login has
--   never worked. THIS FILE FIXES LOGIN. Apply it first and the moment users
--   arrive, every user's favourites, watchlist, profile and votes are
--   world-readable and world-writable by anyone holding the anon key.
--
--   Run 015 first (a no-op on empty tables), then this file.
--
-- SAFE TO RUN: creates one new table; touches no existing object.
-- ============================================================

-- ── Table ──
-- Column definitions are byte-identical to 001 §1 on purpose.
CREATE TABLE IF NOT EXISTS public.siwe_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- The opportunistic sweep in api/auth/siwe.js deletes on `expires_at < now()`,
-- and the atomic nonce claim filters on `expires_at > now()`.
CREATE INDEX IF NOT EXISTS idx_nonces_expires ON public.siwe_nonces (expires_at);

-- ── RLS ──
-- Enabling RLS with no permissive policy for a role = that role sees and
-- writes nothing. Only service_role gets a policy.
ALTER TABLE public.siwe_nonces ENABLE ROW LEVEL SECURITY;

-- ── Grants (defense in depth behind RLS) ──
-- Migration 008 set ALTER DEFAULT PRIVILEGES so every new public table is
-- auto-granted SELECT/INSERT/UPDATE/DELETE to anon + authenticated. That is
-- the wrong posture for a CSRF-token table, so take it straight back.
REVOKE ALL ON public.siwe_nonces FROM anon, authenticated;
GRANT ALL ON public.siwe_nonces TO service_role;

-- ── Policy ──
DROP POLICY IF EXISTS "Service role only" ON public.siwe_nonces;
CREATE POLICY "Service role only" ON public.siwe_nonces
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- PostgREST caches the schema. Without this the table exists but the REST
-- layer keeps answering PGRST205 until the next connection recycle — i.e.
-- login would stay broken and the migration would look like it did nothing.
NOTIFY pgrst, 'reload schema';
