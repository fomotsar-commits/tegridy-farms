-- ═══ 007: P2P Seaport-settled trades + chat DMs/reactions ═══
-- Run AFTER 001-006 in the Supabase SQL editor.
--
-- Part A upgrades trade_offers (created in 002 as an off-chain intent
-- tracker) to carry a FULL signed Seaport swap order so acceptance settles
-- atomically on-chain via Seaport.fulfillOrder — no custom escrow contract
-- (lesson from the Dec-2023 NFT Trader approval exploit: the only contract
-- surface is canonical Seaport + the OpenSea conduit, both battle-tested).
--
-- Design (locked 2026-06-10 from the deep-research pass):
--   maker side  (offer):         their NFTs (itemType 2) + optional WETH
--                                sweetener (itemType 1 — Seaport cannot pull
--                                native ETH from a maker)
--   taker side  (consideration): the requested NFTs to the maker + optional
--                                native ETH to the maker (paid as msg.value)
--   counterparty restriction:    ownership-gating — only the owner of the
--                                requested NFTs can fulfill. target_owner is
--                                a SOFT pin enforced by API + UI.
--   orderType:                   0 (FULL_OPEN). NOT 2 — that is
--                                FULL_RESTRICTED and reverts with a zero zone.

-- ── A1. trade_offers: Seaport order payload ──
ALTER TABLE trade_offers ADD COLUMN IF NOT EXISTS parameters         jsonb;
ALTER TABLE trade_offers ADD COLUMN IF NOT EXISTS protocol_address   text NOT NULL DEFAULT '0x00000000000000adc04c56bf30ac9d3c0aaf14dc';
ALTER TABLE trade_offers ADD COLUMN IF NOT EXISTS seaport_order_hash text;
ALTER TABLE trade_offers ADD COLUMN IF NOT EXISTS weth_topup_wei     text NOT NULL DEFAULT '0';
ALTER TABLE trade_offers ADD COLUMN IF NOT EXISTS counter_of         uuid REFERENCES trade_offers(id);
ALTER TABLE trade_offers ADD COLUMN IF NOT EXISTS declined_at        timestamptz;
ALTER TABLE trade_offers ADD COLUMN IF NOT EXISTS cancelled_at       timestamptz;

-- `signature` (NOT NULL, from 002) now stores the Seaport EIP-712 order
-- signature needed for fulfillment. The create-time auth signature is
-- verified by the API and not persisted.
COMMENT ON COLUMN trade_offers.signature          IS 'Seaport EIP-712 order signature (fulfillment payload)';
COMMENT ON COLUMN trade_offers.parameters         IS 'Full Seaport OrderParameters as signed (counter NOT included)';
COMMENT ON COLUMN trade_offers.seaport_order_hash IS 'Canonical Seaport struct-hash (OrderFulfilled event value) for fill verification';
COMMENT ON COLUMN trade_offers.eth_topup_wei      IS 'TAKER native ETH paid to maker on fulfillment (msg.value leg)';
COMMENT ON COLUMN trade_offers.weth_topup_wei     IS 'MAKER WETH sweetener included in the offer side';
COMMENT ON COLUMN trade_offers.counter_of         IS 'If set, this offer is a counter to the referenced trade';

CREATE INDEX IF NOT EXISTS idx_trades_order_hash ON trade_offers(seaport_order_hash);

-- All trade_offers writes flow through /api/orderbook (service role) so the
-- Seaport signature + maker ownership are verified server-side before any
-- row exists. Client-side RLS writes from 001/002 are therefore revoked —
-- parity with the native_orders hardening in 004.
DROP POLICY IF EXISTS "Owner can insert trades"          ON trade_offers;
DROP POLICY IF EXISTS "Offerer creates trade"            ON trade_offers;
DROP POLICY IF EXISTS "Participants can update trades"   ON trade_offers;
DROP POLICY IF EXISTS "Participants update trade status" ON trade_offers;
DROP POLICY IF EXISTS "Service role inserts trades" ON trade_offers;
CREATE POLICY "Service role inserts trades" ON trade_offers FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS "Service role updates trades" ON trade_offers;
CREATE POLICY "Service role updates trades" ON trade_offers FOR UPDATE TO service_role USING (true);
-- Reads stay open (trades are signed offers on public NFTs, like listings).
DROP POLICY IF EXISTS "Participants read trades" ON trade_offers;
DROP POLICY IF EXISTS "Anyone can read trades"   ON trade_offers;
CREATE POLICY "Anyone can read trades" ON trade_offers FOR SELECT USING (true);

-- ── B1. Direct messages ──
-- channel_key = lower(walletA)||'_'||lower(walletB) with A < B lexically, so
-- both participants derive the same key. ('_' not ':' — the proxy's
-- SAFE_MATCH_VALUE filter charset excludes ':'.) Reads/writes go through
-- /api/supabase-proxy which attaches the SIWE JWT from the httpOnly cookie —
-- the anon key alone can see nothing (RLS below).
CREATE TABLE IF NOT EXISTS dm_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_key text        NOT NULL,
  sender      text        NOT NULL,
  recipient   text        NOT NULL,
  text        text        NOT NULL CHECK (char_length(text) <= 500),
  trade_id    uuid        REFERENCES trade_offers(id),  -- set when message is a trade card
  created_at  timestamptz DEFAULT now(),
  read_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_dm_channel ON dm_messages(channel_key, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_recipient_unread ON dm_messages(recipient) WHERE read_at IS NULL;

ALTER TABLE dm_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Participants read DMs" ON dm_messages;
CREATE POLICY "Participants read DMs" ON dm_messages FOR SELECT USING (
  sender    = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  OR recipient = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

DROP POLICY IF EXISTS "Sender writes DMs" ON dm_messages;
CREATE POLICY "Sender writes DMs" ON dm_messages FOR INSERT WITH CHECK (
  sender = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
  AND sender <> recipient
  AND channel_key = CASE WHEN sender < recipient
                         THEN sender || '_' || recipient
                         ELSE recipient || '_' || sender END
);

-- Recipient may mark their messages read.
DROP POLICY IF EXISTS "Recipient marks read" ON dm_messages;
CREATE POLICY "Recipient marks read" ON dm_messages FOR UPDATE USING (
  recipient = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- ── B2. Reactions on community messages ──
-- Same atomic-RPC pattern as toggle_like (read-then-write from clients
-- would TOCTOU-race concurrent reactions).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN messages.reactions IS 'emoji -> [lowercase wallets], maintained via toggle_reaction RPC';

CREATE OR REPLACE FUNCTION toggle_reaction(msg_id uuid, wallet text, emoji text)
RETURNS SETOF messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  w text := lower(wallet);
  current jsonb;
  arr jsonb;
BEGIN
  -- Fixed emoji set keeps the jsonb bounded and the picker honest.
  IF emoji NOT IN ('👍','🔥','💎','😂','🫡','📈') THEN
    RAISE EXCEPTION 'unsupported emoji';
  END IF;
  IF w IS NULL OR w !~ '^0x[0-9a-f]{40}$' THEN
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
