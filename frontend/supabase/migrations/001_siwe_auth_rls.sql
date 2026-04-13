-- ============================================================
-- SIWE Auth RLS Migration
-- Run in Supabase SQL Editor AFTER deploying the SIWE auth
-- endpoint and frontend changes.
--
-- This migration:
-- 1. Creates the siwe_nonces table for nonce management
-- 2. Drops the old open RLS policies (WITH CHECK (true))
-- 3. Creates JWT-enforced policies that check the wallet claim
-- 4. Updates the toggle_like RPC to verify JWT ownership
-- ============================================================

-- ── 1. SIWE Nonces Table ──
CREATE TABLE IF NOT EXISTS siwe_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nonces_expires ON siwe_nonces(expires_at);
ALTER TABLE siwe_nonces ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role only" ON siwe_nonces
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 2. Messages Table ──
DROP POLICY IF EXISTS "Anyone can insert" ON messages;
CREATE POLICY "Verified can insert" ON messages FOR INSERT WITH CHECK (
  author = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  AND char_length(text) <= 280
  AND char_length(slug) <= 64
);
-- "Anyone can read" policy stays (public reads are fine)

-- ── 3. User Profiles Table ──
DROP POLICY IF EXISTS "Anyone can upsert own profile" ON user_profiles;
DROP POLICY IF EXISTS "Anyone can update own profile" ON user_profiles;
DROP POLICY IF EXISTS "Owner can upsert own profile" ON user_profiles;
DROP POLICY IF EXISTS "Owner can update own profile" ON user_profiles;
CREATE POLICY "Owner can upsert own profile" ON user_profiles
  FOR INSERT WITH CHECK (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );
CREATE POLICY "Owner can update own profile" ON user_profiles
  FOR UPDATE USING (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

-- ── 4. User Favorites Table ──
DROP POLICY IF EXISTS "Anyone can insert favorites" ON user_favorites;
DROP POLICY IF EXISTS "Anyone can delete favorites" ON user_favorites;
DROP POLICY IF EXISTS "Owner can insert favorites" ON user_favorites;
DROP POLICY IF EXISTS "Owner can delete favorites" ON user_favorites;
CREATE POLICY "Owner can insert favorites" ON user_favorites
  FOR INSERT WITH CHECK (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );
CREATE POLICY "Owner can delete favorites" ON user_favorites
  FOR DELETE USING (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

-- ── 5. User Watchlist Table ──
DROP POLICY IF EXISTS "Anyone can insert watchlist" ON user_watchlist;
DROP POLICY IF EXISTS "Anyone can delete watchlist" ON user_watchlist;
DROP POLICY IF EXISTS "Owner can insert watchlist" ON user_watchlist;
DROP POLICY IF EXISTS "Owner can delete watchlist" ON user_watchlist;
CREATE POLICY "Owner can insert watchlist" ON user_watchlist
  FOR INSERT WITH CHECK (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );
CREATE POLICY "Owner can delete watchlist" ON user_watchlist
  FOR DELETE USING (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

-- ── 6. Votes Table ──
DROP POLICY IF EXISTS "Anyone can insert votes" ON votes;
DROP POLICY IF EXISTS "Anyone can update own vote" ON votes;
DROP POLICY IF EXISTS "Owner can insert votes" ON votes;
DROP POLICY IF EXISTS "Owner can update own vote" ON votes;
CREATE POLICY "Owner can insert votes" ON votes
  FOR INSERT WITH CHECK (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );
CREATE POLICY "Owner can update own vote" ON votes
  FOR UPDATE USING (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

-- ── 7. Update toggle_like RPC to verify JWT wallet ──
CREATE OR REPLACE FUNCTION toggle_like(msg_id uuid, wallet text)
RETURNS messages AS $$
DECLARE
  result messages;
  jwt_wallet text;
BEGIN
  jwt_wallet := lower(current_setting('request.jwt.claims', true)::json->>'wallet');
  IF jwt_wallet IS NULL OR lower(wallet) != jwt_wallet THEN
    RAISE EXCEPTION 'Unauthorized: wallet does not match JWT';
  END IF;

  UPDATE messages
  SET likes = CASE
    WHEN wallet = ANY(likes) THEN array_remove(likes, wallet)
    ELSE array_append(likes, wallet)
  END
  WHERE id = msg_id
  RETURNING * INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 8. Trade Offers Table (SECURITY FIX: Missing from original migration) ──
-- Without RLS, any anonymous client can modify any trade's status, forge trade
-- offers from other wallets, or delete trades.
ALTER TABLE trade_offers ENABLE ROW LEVEL SECURITY;

-- Anyone can read trade offers (needed for marketplace display)
DROP POLICY IF EXISTS "Anyone can read trades" ON trade_offers;
CREATE POLICY "Anyone can read trades" ON trade_offers
  FOR SELECT USING (true);

-- Only the sender can create trade offers (verified via JWT wallet)
DROP POLICY IF EXISTS "Owner can insert trades" ON trade_offers;
CREATE POLICY "Owner can insert trades" ON trade_offers
  FOR INSERT WITH CHECK (
    from_wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

-- Only trade participants can update status (accept/decline/cancel)
DROP POLICY IF EXISTS "Participants can update trades" ON trade_offers;
CREATE POLICY "Participants can update trades" ON trade_offers
  FOR UPDATE USING (
    from_wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
    OR to_wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );

-- ── 9. Push Subscriptions Table (SECURITY FIX: Missing from original migration) ──
-- Without RLS, any anonymous client can read ALL push subscription endpoints/keys,
-- delete other users' subscriptions, or inject fake subscription data.
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can only manage their own push subscriptions
DROP POLICY IF EXISTS "Owner can manage own subs" ON push_subscriptions;
CREATE POLICY "Owner can manage own subs" ON push_subscriptions
  FOR ALL USING (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  ) WITH CHECK (
    wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  );
