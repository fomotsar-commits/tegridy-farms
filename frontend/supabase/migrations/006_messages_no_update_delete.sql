-- ═══════════════════════════════════════════════════════════════════
-- 006_messages_no_update_delete.sql
-- AUDIT FIX 2026-05-13 — M-API-2 — explicit-deny UPDATE/DELETE on messages.
-- ═══════════════════════════════════════════════════════════════════
--
-- Background:
-- Migration 001 enables RLS on `messages` and adds INSERT + SELECT
-- policies (gated on `author = jwt.wallet` for INSERT). NO UPDATE or
-- DELETE policies exist, which under default Postgres RLS semantics
-- means UPDATE and DELETE are implicitly denied.
--
-- The 2026-05-13 audit (M-API-2) flagged this as a defense-in-depth
-- gap: a future migration that adds a permissive UPDATE policy
-- without checking `author = jwt.wallet` would silently re-enable
-- write paths the supabase-proxy already permits (the proxy gates
-- `match`-filter chars but does NOT pin `wallet=jwt.wallet` for
-- writes — it relies on RLS).
--
-- Fix: add explicit `USING (false)` deny policies for UPDATE and
-- DELETE on `messages`. Service role still bypasses RLS (it can
-- moderate/delete via backend tooling), but no JWT-authenticated
-- client can ever update or delete a message — even if a future
-- permissive policy is accidentally added (PostgreSQL evaluates
-- multiple permissive policies with OR, but `USING (false)` is
-- restrictive when written as RESTRICTIVE — see below).
--
-- Pattern of record:
--   - Supabase's own RLS docs recommend explicit deny policies for
--     immutable tables (audit logs, append-only message streams).
--   - Discord's chat backend uses append-only with no UPDATE/DELETE
--     at the application layer.
-- ═══════════════════════════════════════════════════════════════════

-- Defense-in-depth: explicit RESTRICTIVE deny on UPDATE.
-- RESTRICTIVE policies are AND'd with PERMISSIVE policies — so even if a
-- future permissive UPDATE policy gets added, this restrictive deny still
-- applies and the operation is rejected.
DROP POLICY IF EXISTS "messages_deny_update" ON public.messages;
CREATE POLICY "messages_deny_update" ON public.messages
  AS RESTRICTIVE
  FOR UPDATE
  USING (false);

DROP POLICY IF EXISTS "messages_deny_delete" ON public.messages;
CREATE POLICY "messages_deny_delete" ON public.messages
  AS RESTRICTIVE
  FOR DELETE
  USING (false);

-- Note: service_role bypasses RLS entirely, so backend moderation
-- (e.g., spam removal) still works via the service-role client. Only
-- JWT-authenticated clients are blocked, which is the intent.
