-- ============================================================
-- 010_reaction_auth_hardening.sql
-- (renumbered from 005 to resolve a duplicate-005 collision with
--  005_add_seaport_order_hash.sql — BOTH must be applied; numbers are unique now)
--
-- F714: toggle_reaction trusted its `wallet` ARGUMENT and was callable by the
-- anon role, so anyone holding the public anon key could add/remove reactions
-- as ANY wallet (PostgREST exposes functions to anon by default). toggle_like
-- already gated on the JWT wallet + had anon EXECUTE revoked in 004; reactions
-- were missed.
--
-- Fix (defense in depth — no function-body rewrite required):
--   1. /api/supabase-proxy now INJECTS the JWT-verified wallet into the RPC
--      args server-side, so a caller can never pass someone else's wallet.
--   2. This migration REVOKEs anon EXECUTE so the proxy (which runs as the
--      `authenticated` role via the SIWE JWT) is the ONLY caller — a direct
--      anon RPC call with a forged wallet now fails outright.
--   3. Pin search_path on the SECURITY DEFINER function (same hardening 004
--      applied to toggle_like) to block schema-hijack on built-in resolution.
--
-- Run in the Supabase SQL Editor AFTER 004_security_hardening.sql.
-- Migrations are append-only; this only ALTERs / REVOKEs / GRANTs in place.
--
-- NOTE: the signature below assumes toggle_reaction(msg_id uuid, wallet text,
-- emoji text) — the shape the client calls. If it was deployed with different
-- parameter types, adjust the three signatures to match (\df toggle_reaction).
-- ============================================================

-- ── 1. Pin search_path on the SECURITY DEFINER function ──
ALTER FUNCTION public.toggle_reaction(uuid, text, text)
  SET search_path = public, pg_temp;

-- ── 2. Lock down EXECUTE: proxy (authenticated) only, never anon ──
REVOKE EXECUTE ON FUNCTION public.toggle_reaction(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.toggle_reaction(uuid, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.toggle_reaction(uuid, text, text) TO   authenticated, service_role;
