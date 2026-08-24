-- ============================================================
-- 020 — telegram_links: the Telegram chat ↔ wallet binding
--
-- ⚠️ NOT APPLIED. This repo has no migration ledger; statements are applied by
--    hand against the Supabase project. Until an operator runs this file,
--    PostgREST answers 404/PGRST205 for `telegram_links` and
--    frontend/api/_lib/botLink.js reports `code: "schema-missing"` — never
--    `linked: false`, because "this chat is not linked" and "no chat could ever
--    have been linked" are different facts and only one of them is about the user.
--
-- ORDERING: independent of every migration before it. One new table, nothing
-- existing touched. Safe to apply at any time.
--
-- WHAT A ROW IS, AND WHAT IT IS EMPHATICALLY NOT
--   A row says: the holder of one Telegram chat proved control of one wallet by
--   signing a SIWE message in the web app. That is the ENTIRE grant. It confers
--   read-only answers in chat and nothing else.
--
--   There is no column here for a private key, a mnemonic, an encrypted key
--   blob, a KDF salt, or a session-key grant, and there must never be one. The
--   two largest bots on this surface (Trojan, Banana Gun) were both drained
--   through server-held or server-derived keys; this table is the shape that
--   makes that class of loss impossible rather than unlikely. A migration that
--   adds key-shaped material to it is a breach of the venue's one hard rule, and
--   frontend/api/__tests__/bot-noncustodial.test.js fails the build over it.
--
-- WHY THE TELEGRAM ID IS NOT STORED
--   `chat_ref` is HMAC-SHA256(BOT_LINK_SECRET, 'tg:' || telegram_user_id), which
--   is what both the bot and the API derive before they ever talk about a chat.
--   A dump of this table is therefore a list of wallets beside opaque digests,
--   not a wallet-to-Telegram-identity map. The bot cannot enumerate it either:
--   every read is pinned to one chat_ref (see the queries in botLink.js).
--
-- AUTHORITY
--   RLS keyed to the SIWE JWT wallet claim, same shape as alert_rules (016).
--   The two writes that create and claim a pending row run under the SERVICE
--   ROLE with pinned filters, because a pending row has no owner yet — there is
--   no wallet on it for a policy to match. Deliberately, `authenticated` gets
--   SELECT and DELETE only: a user may read and destroy their own bindings and
--   may not mint or re-home one.
-- ============================================================

CREATE TABLE IF NOT EXISTS telegram_links (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC of the Telegram user id under the venue's bot secret. 64 lowercase hex.
  -- UNIQUE so one chat holds at most one binding: re-linking replaces, and a
  -- second wallet can never be silently attached to the same chat.
  chat_ref        text        NOT NULL UNIQUE CHECK (chat_ref ~ '^[0-9a-f]{64}$'),
  -- Lower-cased owner wallet. NULL while the link is pending — that is the whole
  -- reason the claim is a service-role write.
  wallet          text        CHECK (wallet IS NULL OR wallet ~ '^0x[0-9a-f]{40}$'),
  -- The one-time code the user carries from the chat to the browser. NULLed the
  -- moment it is claimed, so a code is spent exactly once.
  link_code       text        UNIQUE,
  code_expires_at timestamptz,
  linked_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- A wallet and the moment it was proven arrive together or not at all. Without
  -- this, a row could carry a wallet with no linked_at and read as an ancient
  -- binding, or a linked_at with no wallet and read as a binding to nobody.
  CONSTRAINT telegram_links_bound_together CHECK ((wallet IS NULL) = (linked_at IS NULL)),
  -- A pending row must carry both halves of its expiry or neither. A code with no
  -- expiry never dies.
  CONSTRAINT telegram_links_pending_shape CHECK ((link_code IS NULL) = (code_expires_at IS NULL))
);

-- The owner's own lookup (`?action=mine`) and revoke both filter on wallet.
CREATE INDEX IF NOT EXISTS idx_telegram_links_wallet ON telegram_links(wallet);

ALTER TABLE telegram_links ENABLE ROW LEVEL SECURITY;

-- SELECT: only the owner, and only their own rows. There is no public read: a
-- row names a wallet somebody reaches over Telegram, which is information about
-- the person, not about the chain.
DROP POLICY IF EXISTS "Owner reads own telegram links" ON telegram_links;
CREATE POLICY "Owner reads own telegram links" ON telegram_links FOR SELECT USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- DELETE: only the owner. This is the revocation path, and it is deliberately
-- the ONE mutation a user's own JWT can perform. Killing the binding kills every
-- answer the bot can give about that wallet, immediately and without an operator.
DROP POLICY IF EXISTS "Owner deletes own telegram links" ON telegram_links;
CREATE POLICY "Owner deletes own telegram links" ON telegram_links FOR DELETE USING (
  wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
);

-- No INSERT and no UPDATE policy exists, on purpose. A pending row has no wallet,
-- so no owner-keyed policy could admit its creation; both writes run under the
-- service role with filters pinned to one chat_ref or one link_code. Adding a
-- permissive INSERT/UPDATE policy here would let any authenticated caller mint a
-- binding for a chat they do not control.

-- Role grants mirror 008_grant_new_table_roles.sql. `anon` gets nothing: an
-- unauthenticated caller owns no binding and has no business reading any.
GRANT SELECT, DELETE ON telegram_links TO authenticated;
REVOKE ALL ON telegram_links FROM anon;

-- PostgREST caches the schema. Without this the table exists in Postgres and
-- still answers PGRST205 until the connection pool is bounced by hand.
NOTIFY pgrst, 'reload schema';

-- ── Record this file in the ledger ────────────────────────────────────
-- Added 2026-08-24: the self-recording INSERT MIGRATIONS.md describes was
-- missing from every file after 000 — the ledger was fiction for 016-021.
INSERT INTO public.schema_migrations (filename, note)
VALUES ('020_telegram_links.sql', 'telegram bot link store; BOT_LINK_SECRET must match on both hosts')
ON CONFLICT (filename) DO NOTHING;
