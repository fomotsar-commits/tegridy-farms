-- ============================================================
-- 023 — prune_revoked_jwts lockdown, standalone
--
-- ⚠️ NOT APPLIED. This is 004 §2, re-issued as its own file. The live-DB
--    reconciliation (docs/audits, 2026-08-12 ledger read) found 004 only
--    PARTIALLY applied, and the un-applied half is exactly this lockdown; the
--    standalone re-run then fell out of every planning list. Idempotent:
--    running it when 004 §2 already applied changes nothing.
--
-- WHY IT MATTERS: prune_revoked_jwts() deletes rows from the JWT revocation
-- list. With EXECUTE open to anon/authenticated (the Postgres default via
-- PUBLIC), anyone with the published anon key can un-revoke every revoked
-- session the moment its natural expiry math allows — the revocation list is
-- only as strong as the weakest role that can prune it. SECURITY DEFINER +
-- pinned search_path (004 §1) makes the function safe to HAVE; this makes it
-- safe from being CALLED by the public.
--
-- ORDERING: requires 003 (the function) — live since the beginning. Safe any
-- time after. ⛔ Same 008 rule as 022: never run 008 after this.
-- ============================================================

ALTER FUNCTION public.prune_revoked_jwts()
  SECURITY DEFINER
  SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.prune_revoked_jwts() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prune_revoked_jwts() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_revoked_jwts() TO service_role;

-- ── Record this file in the ledger ────────────────────────────────────
INSERT INTO public.schema_migrations (filename, note)
VALUES ('023_prune_revoked_jwts_lockdown.sql', '004 §2 re-issued standalone: prune EXECUTE service-role only')
ON CONFLICT (filename) DO NOTHING;

-- ── VERIFICATION — run after applying ─────────────────────────────────
--
--   select proname, proacl from pg_proc where proname = 'prune_revoked_jwts';
--   -- proacl must show service_role and NOT anon/authenticated/PUBLIC (=X grants).
--
--   # From a shell with the ANON key — must be 401/403/404, NOT 200:
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     -H "apikey: $SUPABASE_ANON_KEY" \
--     -X POST "$SUPABASE_URL/rest/v1/rpc/prune_revoked_jwts"
