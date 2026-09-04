-- ============================================================
-- 025 — user_profiles / user_favorites / user_watchlist / votes:
--       take the anon role's WRITE verbs away entirely
--
-- WHAT THIS IS FOR
--   Migration 015 §1 DROPs the permissive `qual = true` WRITE policies on
--   these four tables, leaving only the owner-scoped ones that compare `wallet`
--   against the SIWE JWT claim. That is the right fix and it is not enough on
--   its own, because it makes RLS the ONLY thing standing between the published
--   anon key and every user's rows.
--
--   Two ways that single layer fails, both already real in this repo:
--     * 015 §1 may never have been applied. It writes no ledger row, so the
--       repo genuinely cannot tell (audit TF-020).
--     * 008's `ALTER DEFAULT PRIVILEGES` re-grants anon INSERT/UPDATE/DELETE on
--       every table, current and future, and it is idempotent-by-re-running.
--       Anyone re-running 008 to fix a 42501 silently undoes 015 §1 (audit
--       TF-056). 022's header already lists this hazard; this file joins it.
--
--   A GRANT is not a policy. Revoking the verb means a mistake in the policy
--   layer cannot become a write, and re-running 015 §1 is no longer the only
--   thing keeping anon out.
--
--   ⛔ NEVER RUN 008 AFTER THIS FILE. Same hazard 022 carries, same reason.
--
-- WHY THIS BREAKS NOTHING
--   userdata.js performs NO direct anon-key mutation on these tables — every
--   write already leaves through /api/supabase-proxy on the SIWE JWT, which
--   authenticates as `authenticated`, not `anon`. That is not an assumption:
--   src/nakamigos/userdataWriteHonesty.test.js is a source-level tripwire that
--   FAILS if a mutating PostgREST verb reappears in that file, and
--   lib/userdata.test.js pins the behaviour. `authenticated` and `service_role`
--   are deliberately untouched here.
--
--   SELECT is deliberately untouched too. The read side is 015 §2, and 024
--   settles it for the two personal tables by dropping their permissive read
--   POLICY — not by revoking the verb, because `authenticated` and `anon` share
--   the same grant and the public tables still need it.
--
-- ⛔ PREFLIGHT
--
--      # 1. Confirm anon currently HOLDS the write verbs (else this is a no-op
--      #    and something already revoked them).
--      select grantee, privilege_type, table_name
--        from information_schema.role_table_grants
--       where table_schema = 'public'
--         and grantee = 'anon'
--         and privilege_type in ('INSERT','UPDATE','DELETE')
--         and table_name in ('user_profiles','user_favorites','user_watchlist','votes')
--       order by table_name, privilege_type;
--
--      # 2. Confirm the DEPLOYED bundle writes these tables only via the proxy.
--      #    Grep the LIVE bundle for 'rest/v1/user_favorites' etc. with a
--      #    non-GET verb. Zero hits = the proxy is the only writer.
--
-- IDEMPOTENCY
--   REVOKE on a privilege that is not held is a no-op, and the ledger insert is
--   `ON CONFLICT DO NOTHING`. Re-running is safe.
-- ============================================================

REVOKE INSERT, UPDATE, DELETE ON public.user_profiles  FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.user_favorites FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.user_watchlist FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.votes          FROM anon;

NOTIFY pgrst, 'reload schema';

-- ── Record this file in the ledger ────────────────────────────────────
INSERT INTO public.schema_migrations (filename, note)
VALUES (
  '025_user_tables_anon_write_lockdown.sql',
  'anon INSERT/UPDATE/DELETE revoked on the four user-owned tables; the SIWE proxy (authenticated) is the only write path. Defence in depth behind 015 §1.'
)
ON CONFLICT (filename) DO NOTHING;

-- ── VERIFICATION — must return ZERO rows once applied ────────────────
--
-- select grantee, privilege_type, table_name
--   from information_schema.role_table_grants
--  where table_schema = 'public'
--    and grantee = 'anon'
--    and privilege_type in ('INSERT','UPDATE','DELETE')
--    and table_name in ('user_profiles','user_favorites','user_watchlist','votes');
--
-- And confirm `authenticated` KEPT them — an empty result here means the SIWE
-- write path is now broken, which is a different outage, not a fix:
--
-- select grantee, privilege_type, table_name
--   from information_schema.role_table_grants
--  where table_schema = 'public'
--    and grantee = 'authenticated'
--    and privilege_type in ('INSERT','UPDATE','DELETE')
--    and table_name in ('user_profiles','user_favorites','user_watchlist','votes')
--  order by table_name, privilege_type;
