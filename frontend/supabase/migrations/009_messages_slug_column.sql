-- ═══ 009: messages.slug column (per-collection chat) ═══
-- The prod `messages` table (created via the "Full Supabase Schema" raw-SQL
-- query) was missing the `slug` column the chat code filters/inserts on
-- (id, author, text, token_id, likes, created_at, reactions only). Every
-- fetchMessages 42703'd ("column messages.slug does not exist") → the UI
-- showed "Chat Unreachable". Default 'nakamigos' backfills any legacy rows.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT 'nakamigos';
CREATE INDEX IF NOT EXISTS idx_messages_slug ON messages(slug, created_at);
