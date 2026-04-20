-- ============================================================
-- Revoked JWTs Migration
-- Run in Supabase SQL Editor AFTER deploying the siwe.js + me.js
-- updates that add a `jti` claim and check this table on /auth/me.
--
-- Purpose:
--   Previously DELETE /api/auth/siwe only cleared the browser cookie.
--   Any copy of the token (captured from device, logs, or extension
--   memory before logout) stayed valid for the remainder of its 24h
--   lifetime. This migration creates a per-jti revocation list so
--   logged-out tokens are rejected immediately, everywhere.
--
-- Rollout:
--   - Tokens issued BEFORE this deploy have no `jti` claim. For those,
--     logout still only clears the cookie (same as before). They age
--     out naturally at their 24h exp.
--   - Tokens issued AFTER this deploy carry a UUID `jti`. Logout
--     writes { jti, exp } into this table; /auth/me rejects any token
--     whose jti appears here.
-- ============================================================

CREATE TABLE IF NOT EXISTS revoked_jwts (
  jti text PRIMARY KEY,
  exp timestamptz NOT NULL,
  revoked_at timestamptz DEFAULT now()
);

-- /auth/me queries by jti on every authenticated request. PK covers it,
-- but add an exp index so the opportunistic cleanup DELETE below is fast.
CREATE INDEX IF NOT EXISTS idx_revoked_jwts_exp ON revoked_jwts(exp);

-- Only the service role (i.e. /api routes) should read/write this.
ALTER TABLE revoked_jwts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only" ON revoked_jwts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Cleanup helper — remove rows whose underlying token has already
-- expired and therefore can't be used anyway. Safe to call from the
-- logout handler opportunistically, or from a scheduled cron.
CREATE OR REPLACE FUNCTION prune_revoked_jwts() RETURNS int AS $$
DECLARE
  deleted int;
BEGIN
  DELETE FROM revoked_jwts WHERE exp < now() RETURNING 1 INTO deleted;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
