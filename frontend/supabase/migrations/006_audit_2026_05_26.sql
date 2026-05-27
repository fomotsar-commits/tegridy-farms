-- AUDIT FIX 2026-05-26 swarm audit batch
--
-- H-28 [HIGH] messages explicit deny on UPDATE/DELETE — pre-fix, RLS denied by
-- default (no policy = deny for `authenticated` role) but the convention was
-- documented in code comments rather than enforced. Any future migration that
-- adds an UPDATE policy without `WITH CHECK (false)` would silently flip the
-- table open. Explicit deny-policies are the OZ-style "kill switch" pattern.
--
-- H-29 [HIGH] toggle_like RPC wallet case normalization — pre-fix, the JWT
-- check normalized (`lower(wallet) != jwt_wallet`) but the array mutation used
-- the raw `wallet` argument. Case-permutation spam (`0xABCD...` vs `0xabcd...`)
-- could double-count likes and balloon the `likes` column unbounded (DoS on
-- row size). Now normalized to lowercase before write AND read.

-- ─── H-28: explicit DENY on UPDATE/DELETE for messages ──────────────────────
DROP POLICY IF EXISTS "No direct updates" ON public.messages;
CREATE POLICY "No direct updates" ON public.messages
  FOR UPDATE USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "No direct deletes" ON public.messages;
CREATE POLICY "No direct deletes" ON public.messages
  FOR DELETE USING (false);

-- ─── H-29: toggle_like case normalization ───────────────────────────────────
-- Replace the prior implementation. Wallet argument is now derived implicitly
-- from the JWT (eliminating the case-mismatch attack vector entirely). API
-- callers MUST stop passing the `wallet` arg; the old signature is kept as a
-- compatibility wrapper that ignores the parameter and only trusts the JWT.

-- H-29 SELF-AUDIT FIX 2026-05-26: original migration returned `void` which
-- broke the JS caller at frontend/src/nakamigos/lib/supabase.js:251-262
-- (`.single()` + `rowToMsg(data)` expects the updated row). RETURNS messages
-- restores the row-return contract; case normalization fix is preserved.
CREATE OR REPLACE FUNCTION toggle_like(msg_id uuid, wallet text)
RETURNS messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  jwt_wallet text;
  norm_wallet text;
  result messages;
BEGIN
  -- Pull the JWT wallet claim. Lowercase it for canonical storage.
  jwt_wallet := lower(current_setting('request.jwt.claims', true)::json->>'wallet');
  IF jwt_wallet IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: JWT missing wallet claim';
  END IF;

  -- H-29: ignore the caller-supplied `wallet` arg for authorization; normalize
  -- the canonical form. Backwards-compatible signature; new semantic uses ONLY
  -- the JWT-derived wallet.
  norm_wallet := jwt_wallet;
  -- Defense: if caller DID pass a wallet, it MUST match the JWT (case-insensitive).
  -- Reject mismatch loudly so any frontend bug surfaces rather than silently
  -- writing the wrong wallet.
  IF wallet IS NOT NULL AND lower(wallet) != jwt_wallet THEN
    RAISE EXCEPTION 'Unauthorized: wallet does not match JWT';
  END IF;

  UPDATE messages
  SET likes = CASE
    WHEN norm_wallet = ANY(likes) THEN array_remove(likes, norm_wallet)
    ELSE array_append(likes, norm_wallet)
  END
  WHERE id = msg_id
  RETURNING * INTO result;

  IF result.id IS NULL THEN
    RAISE EXCEPTION 'Message not found: %', msg_id;
  END IF;

  RETURN result;
END;
$$;

-- Re-grant after CREATE OR REPLACE (postgres semantics may keep prior grants
-- but defensive re-grant ensures the function is callable from anon).
GRANT EXECUTE ON FUNCTION toggle_like(uuid, text) TO anon, authenticated;

-- ─── INDEXES: H-28 / H-29 covering indexes if not present ─────────────────
-- (No new indexes required — `messages.id` is already the PK; `likes` is an
-- array column not indexed for membership lookup, which is intentional given
-- the small per-message expected scale.)

-- ─── Sanity: confirm migration applied ────────────────────────────────────
DO $$
DECLARE
  upd_count int;
  del_count int;
BEGIN
  SELECT COUNT(*) INTO upd_count FROM pg_policy
    WHERE polrelid = 'public.messages'::regclass AND polcmd = 'w';  -- UPDATE
  SELECT COUNT(*) INTO del_count FROM pg_policy
    WHERE polrelid = 'public.messages'::regclass AND polcmd = 'd';  -- DELETE
  IF upd_count = 0 THEN
    RAISE EXCEPTION 'H-28: messages UPDATE deny policy missing';
  END IF;
  IF del_count = 0 THEN
    RAISE EXCEPTION 'H-28: messages DELETE deny policy missing';
  END IF;
  RAISE NOTICE 'H-28/H-29 migration applied successfully';
END$$;
