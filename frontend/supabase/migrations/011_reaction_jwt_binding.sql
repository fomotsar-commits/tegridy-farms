-- ============================================================
-- 011_reaction_jwt_binding.sql
--
-- AUDIT 2026-07-12 (backend audit, M-1): toggle_reaction was a SECURITY DEFINER
-- function that derived the acting wallet from its `wallet` ARGUMENT
-- (007_p2p_trades_and_chat.sql:123), NEVER from the JWT. Migration 010 revoked
-- anon EXECUTE and relied on /api/supabase-proxy injecting the JWT-verified
-- wallet server-side (supabase-proxy.js:345). But the SIWE JWT minted by
-- api/auth/siwe.js is a first-class `authenticated` PostgREST token, so ANY
-- logged-in user can POST /rest/v1/rpc/toggle_reaction DIRECTLY (public anon key
-- + their own Bearer JWT), bypassing the proxy's wallet injection, and pass a
-- forged `wallet` arg to add/remove reactions attributed to ANY wallet. The proxy
-- is a convenience layer, NOT a trust boundary — the DB must bind identity itself.
-- Its sibling toggle_like already does exactly this (006_audit_2026_05_26.sql:46-60);
-- reactions were missed.
--
-- Blast radius is cosmetic (messages.reactions jsonb: emoji -> [wallets]) — a
-- cross-user impersonation WRITE, no funds/PII — but it is a real authorization
-- bypass the sister function was explicitly hardened against.
--
-- Fix: rewrite the body to take the wallet ONLY from `request.jwt.claims` (mirror
-- toggle_like), reject a mismatched `wallet` arg loudly, and otherwise ignore it.
-- The exact emoji set + atomic FOR UPDATE jsonb-toggle logic from 007 and the
-- pinned search_path + grants from 010 are preserved. No client change — the call
-- signature (msg_id, wallet, emoji) is unchanged, and the proxy still passes the
-- (now redundant, matching) wallet.
--
-- Run in the Supabase SQL Editor AFTER 010_reaction_auth_hardening.sql.
-- Migrations are append-only; this CREATE OR REPLACEs the function in place.
-- ============================================================

CREATE OR REPLACE FUNCTION toggle_reaction(msg_id uuid, wallet text, emoji text)
RETURNS SETOF messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  jwt_wallet text := lower(current_setting('request.jwt.claims', true)::json->>'wallet');
  w text;
  current jsonb;
  arr jsonb;
BEGIN
  -- Identity comes ONLY from the verified JWT claim, never the client arg.
  IF jwt_wallet IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: JWT missing wallet claim';
  END IF;
  -- Defense: if the caller passed a `wallet` arg it MUST match the JWT
  -- (case-insensitive) — surfaces frontend bugs loudly. Mirrors toggle_like H-29.
  IF wallet IS NOT NULL AND lower(wallet) <> jwt_wallet THEN
    RAISE EXCEPTION 'Unauthorized: wallet does not match JWT';
  END IF;
  w := jwt_wallet;

  -- Fixed emoji set keeps the jsonb bounded and the picker honest.
  IF emoji NOT IN ('👍','🔥','💎','😂','🫡','📈') THEN
    RAISE EXCEPTION 'unsupported emoji';
  END IF;
  -- jwt_wallet is already lowercased + SIWE-verified; keep the shape guard.
  IF w !~ '^0x[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'invalid wallet';
  END IF;

  SELECT COALESCE(reactions, '{}'::jsonb) INTO current FROM messages WHERE id = msg_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  arr := COALESCE(current->emoji, '[]'::jsonb);
  IF arr ? w THEN
    arr := (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb)
            FROM jsonb_array_elements_text(arr) AS t(x) WHERE x <> w);
  ELSE
    arr := arr || to_jsonb(w);
  END IF;
  IF arr = '[]'::jsonb THEN
    current := current - emoji;
  ELSE
    current := jsonb_set(current, ARRAY[emoji], arr);
  END IF;
  RETURN QUERY UPDATE messages SET reactions = current WHERE id = msg_id RETURNING *;
END $$;

-- Re-assert the 010 lockdown. CREATE OR REPLACE preserves existing grants, but be
-- explicit so this migration is self-contained + idempotent.
REVOKE EXECUTE ON FUNCTION public.toggle_reaction(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.toggle_reaction(uuid, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.toggle_reaction(uuid, text, text) TO   authenticated, service_role;
