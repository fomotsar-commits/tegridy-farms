-- ============================================================
-- Migration 002: native_orders, trade_offers, push_subscriptions
--
-- Creates the three tables referenced by /api/orderbook.js and by
-- the RLS policies declared in 001_siwe_auth_rls.sql but never
-- backed by a CREATE TABLE. Until this migration runs, any POST
-- against /api/orderbook 500s on the first insert.
--
-- Run in Supabase SQL editor AFTER 001_siwe_auth_rls.sql.
-- ============================================================

-- ── 1. native_orders ──
-- Schema mirrors the contract in frontend/api/orderbook.js:42-63.
CREATE TABLE IF NOT EXISTS native_orders (
  order_hash text PRIMARY KEY,
  order_type text NOT NULL DEFAULT 'listing',
  contract_address text NOT NULL,
  token_id text,
  maker text NOT NULL,
  price_wei text NOT NULL,
  price_eth numeric NOT NULL,
  currency text NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  zone text,
  parameters jsonb NOT NULL,
  signature text NOT NULL,
  protocol_address text NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active',
  filled_by text,
  filled_at timestamptz,
  tx_hash text,
  cancelled_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_contract ON native_orders(contract_address, status);
CREATE INDEX IF NOT EXISTS idx_orders_maker    ON native_orders(maker, status);
CREATE INDEX IF NOT EXISTS idx_orders_token    ON native_orders(contract_address, token_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_price    ON native_orders(price_eth ASC) WHERE status = 'active';

ALTER TABLE native_orders ENABLE ROW LEVEL SECURITY;

-- Anyone can read active orders (public orderbook).
DROP POLICY IF EXISTS "Anyone can read orders" ON native_orders;
CREATE POLICY "Anyone can read orders" ON native_orders FOR SELECT USING (true);

-- Writes restricted to service_role — all client writes must go through /api/orderbook,
-- which verifies the maker's signature before INSERTing with the service key.
DROP POLICY IF EXISTS "Service role can insert" ON native_orders;
CREATE POLICY "Service role can insert" ON native_orders FOR INSERT TO service_role WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can update" ON native_orders;
CREATE POLICY "Service role can update" ON native_orders FOR UPDATE TO service_role USING (true);

-- Explicitly drop any legacy open write policies that may have leaked through anon key.
DROP POLICY IF EXISTS "Anyone can insert orders" ON native_orders;
DROP POLICY IF EXISTS "Anyone can update orders" ON native_orders;


-- ── 2. trade_offers ──
-- Referenced by 001_siwe_auth_rls.sql:115. Used by peer-to-peer trade offer UI
-- (frontend/src/nakamigos/components/MakeOfferModal.jsx).
CREATE TABLE IF NOT EXISTS trade_offers (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_hash    text        UNIQUE NOT NULL,
  offerer       text        NOT NULL,            -- wallet creating the offer
  target_owner  text        NOT NULL,            -- wallet who owns the requested NFT
  offered       jsonb       NOT NULL,            -- array of {contract,tokenId} tokens offered
  requested     jsonb       NOT NULL,            -- array of {contract,tokenId} tokens requested
  eth_topup_wei text        NOT NULL DEFAULT '0',
  signature     text        NOT NULL,
  status        text        NOT NULL DEFAULT 'active',  -- active|accepted|rejected|expired|cancelled
  expires_at    timestamptz NOT NULL,
  accepted_tx   text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trades_offerer  ON trade_offers(offerer, status);
CREATE INDEX IF NOT EXISTS idx_trades_target   ON trade_offers(target_owner, status);
CREATE INDEX IF NOT EXISTS idx_trades_expires  ON trade_offers(expires_at) WHERE status = 'active';

ALTER TABLE trade_offers ENABLE ROW LEVEL SECURITY;

-- SELECT: offerer OR target_owner can see their side of the trade.
DROP POLICY IF EXISTS "Participants read trades" ON trade_offers;
CREATE POLICY "Participants read trades" ON trade_offers FOR SELECT USING (
  offerer      = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  OR target_owner = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- INSERT: only the offerer may create their own offer.
DROP POLICY IF EXISTS "Offerer creates trade" ON trade_offers;
CREATE POLICY "Offerer creates trade" ON trade_offers FOR INSERT WITH CHECK (
  offerer = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- UPDATE: only offerer (cancel) or target_owner (accept/reject) may mutate status.
DROP POLICY IF EXISTS "Participants update trade status" ON trade_offers;
CREATE POLICY "Participants update trade status" ON trade_offers FOR UPDATE USING (
  offerer      = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  OR target_owner = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);


-- ── 3. push_subscriptions ──
-- Referenced by 001_siwe_auth_rls.sql:140. Backs Web-Push notifications
-- (frontend/src/nakamigos/lib/notifications.js).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet      text        NOT NULL,            -- subscriber wallet
  endpoint    text        NOT NULL,            -- PushSubscription endpoint URL
  p256dh      text        NOT NULL,            -- public key from PushSubscription
  auth        text        NOT NULL,            -- auth secret from PushSubscription
  user_agent  text,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (wallet, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_wallet ON push_subscriptions(wallet);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- SELECT: only the subscriber can read their own rows.
DROP POLICY IF EXISTS "Owner reads push subs" ON push_subscriptions;
CREATE POLICY "Owner reads push subs" ON push_subscriptions FOR SELECT USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- INSERT: only as self.
DROP POLICY IF EXISTS "Owner registers push sub" ON push_subscriptions;
CREATE POLICY "Owner registers push sub" ON push_subscriptions FOR INSERT WITH CHECK (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- DELETE: only as self (unsubscribe).
DROP POLICY IF EXISTS "Owner removes push sub" ON push_subscriptions;
CREATE POLICY "Owner removes push sub" ON push_subscriptions FOR DELETE USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);


-- ── 4. Explicit SELECT policies for previously-default-permit tables ──
-- Detective #23 flagged that 001_siwe_auth_rls.sql enables RLS without declaring
-- an explicit SELECT rule on `messages`, `user_profiles`, `user_favorites`,
-- `user_watchlist`, `votes`. Supabase's default is deny, so these tables were
-- actually unreadable — we spell out the intent here.
DROP POLICY IF EXISTS "Anyone can read messages" ON messages;
CREATE POLICY "Anyone can read messages" ON messages FOR SELECT USING (true);

DROP POLICY IF EXISTS "Anyone can read profiles" ON user_profiles;
CREATE POLICY "Anyone can read profiles" ON user_profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS "Owner reads favorites" ON user_favorites;
CREATE POLICY "Owner reads favorites" ON user_favorites FOR SELECT USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

DROP POLICY IF EXISTS "Owner reads watchlist" ON user_watchlist;
CREATE POLICY "Owner reads watchlist" ON user_watchlist FOR SELECT USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

DROP POLICY IF EXISTS "Anyone can read votes" ON votes;
CREATE POLICY "Anyone can read votes" ON votes FOR SELECT USING (true);
