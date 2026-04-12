/**
 * WARNING: OPEN RLS POLICIES — REVIEW BEFORE PRODUCTION
 *
 * TODO(security): The messages table INSERT policy uses `WITH CHECK (true)` with
 * only length constraints. While the UPDATE policy is locked (`USING (false)`),
 * any anonymous client can insert messages as any `author` address without
 * cryptographic verification. For production, require an EIP-4361 (SIWE)
 * signature verified server-side before allowing inserts, and bind the `author`
 * field to the verified wallet address.
 *
 * Supabase chat backend with localStorage fallback.
 *
 * --- Required Supabase table schema (run this in the SQL editor): ---
 *
 *   CREATE TABLE messages (
 *     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
 *     slug text NOT NULL DEFAULT 'nakamigos',
 *     author text NOT NULL,
 *     text text NOT NULL CHECK (char_length(text) <= 280),
 *     token_id text,
 *     likes text[] DEFAULT '{}',
 *     created_at timestamptz DEFAULT now()
 *   );
 *
 *   CREATE INDEX idx_messages_slug ON messages(slug);
 *
 *   -- Rate-limit: prevent inserts if the same author posted within 5 seconds (per collection)
 *   CREATE OR REPLACE FUNCTION check_message_rate_limit()
 *   RETURNS TRIGGER AS $$
 *   BEGIN
 *     IF EXISTS (
 *       SELECT 1 FROM messages
 *       WHERE author = NEW.author
 *         AND slug = NEW.slug
 *         AND created_at > now() - interval '5 seconds'
 *     ) THEN
 *       RAISE EXCEPTION 'Rate limit exceeded';
 *     END IF;
 *     RETURN NEW;
 *   END;
 *   $$ LANGUAGE plpgsql;
 *
 *   CREATE TRIGGER rate_limit_messages
 *     BEFORE INSERT ON messages
 *     FOR EACH ROW EXECUTE FUNCTION check_message_rate_limit();
 *
 *   ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
 *
 *   -- Anyone can read messages
 *   CREATE POLICY "Anyone can read" ON messages FOR SELECT USING (true);
 *
 *   -- Anyone can insert (author is stored but not auth-verified; see SIWE note below)
 *   -- TODO(security): Replace with SIWE-verified JWT check:
 *   --   CREATE POLICY "Verified can insert" ON messages FOR INSERT WITH CHECK (
 *   --     author = current_setting('request.jwt.claims', true)::json->>'wallet'
 *   --     AND char_length(text) <= 280 AND char_length(slug) <= 64
 *   --   );
 *   CREATE POLICY "Anyone can insert" ON messages FOR INSERT WITH CHECK (
 *     char_length(text) <= 280 AND char_length(author) <= 42
 *     AND char_length(slug) <= 64
 *   );
 *
 *   -- Updates restricted to the likes column only
 *   -- Use an RPC function for atomic like toggling instead of direct UPDATE
 *   CREATE POLICY "No direct updates" ON messages FOR UPDATE USING (false);
 *
 *   -- Atomic like toggle via RPC (avoids race conditions)
 *   CREATE OR REPLACE FUNCTION toggle_like(msg_id uuid, wallet text)
 *   RETURNS messages AS $$
 *   DECLARE
 *     result messages;
 *   BEGIN
 *     UPDATE messages
 *     SET likes = CASE
 *       WHEN wallet = ANY(likes) THEN array_remove(likes, wallet)
 *       ELSE array_append(likes, wallet)
 *     END
 *     WHERE id = msg_id
 *     RETURNING * INTO result;
 *     RETURN result;
 *   END;
 *   $$ LANGUAGE plpgsql;
 *
 *   -- NOTE: Author identity is NOT cryptographically verified.
 *   -- For production, consider requiring an EIP-4361 (SIWE) signature
 *   -- and verifying it server-side before inserting messages.
 *
 */

import { createClient } from "@supabase/supabase-js";
import { getStoredToken } from "./siweAuth";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const CHAT_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

// When a SIWE JWT is available, Supabase uses it for the Authorization header,
// enabling RLS policies that check `current_setting('request.jwt.claims')::json->>'wallet'`.
// When no JWT is stored, falls back to anon key (read-only access via public SELECT policies).
export const supabase = CHAT_ENABLED
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          get Authorization() {
            const token = getStoredToken();
            return token ? `Bearer ${token}` : `Bearer ${SUPABASE_ANON_KEY}`;
          },
        },
      },
    })
  : null;

/* ── localStorage helpers (fallback) ──────────────────────────────── */

function chatStorageKey(slug) {
  if (!slug) throw new Error("[supabase] chatStorageKey requires a collection slug");
  return `${slug}_chat`;
}

function loadLocal(slug) {
  try {
    const raw = localStorage.getItem(chatStorageKey(slug));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocal(msgs, slug) {
  try {
    localStorage.setItem(chatStorageKey(slug), JSON.stringify(msgs));
  } catch {
    /* quota exceeded */
  }
}

/* ── helpers ──────────────────────────────────────────────────────── */

/** Convert a Supabase row to the shape the component expects. */
function rowToMsg(row) {
  return {
    id: row.id,
    slug: row.slug ?? "",
    author: row.author,
    text: row.text,
    tokenId: row.token_id ?? null,
    likes: row.likes ?? [],
    timestamp: new Date(row.created_at).getTime(),
  };
}

function generateLocalId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ── API functions ────────────────────────────────────────────────── */

/**
 * Fetch recent messages.
 * @param {{ tokenId?: string, limit?: number, offset?: number }} options
 * @returns {Promise<Array>}
 */
export async function fetchMessages({ tokenId = null, limit = 100, offset = 0, slug } = {}) {
  if (!slug) {
    console.error("[supabase] fetchMessages requires a collection slug");
    return [];
  }
  if (!CHAT_ENABLED) {
    const all = loadLocal(slug);
    const filtered = tokenId != null
      ? all.filter((m) => m.tokenId === tokenId)
      : all;
    return filtered.slice(offset, offset + limit);
  }

  let query = supabase
    .from("messages")
    .select("*")
    .eq("slug", slug)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (tokenId != null) {
    query = query.eq("token_id", tokenId);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[supabase] fetchMessages error:", error);
    return [];
  }
  return (data || []).map(rowToMsg);
}

/**
 * Send a message.
 * @param {{ author: string, text: string, tokenId?: string }} params
 * @returns {Promise<object|null>} The created message, or null on failure.
 */
export async function sendMessage({ author, text, tokenId = null, slug }) {
  if (!slug) {
    console.error("[supabase] sendMessage requires a collection slug");
    return null;
  }
  if (!author) {
    console.error("[supabase] sendMessage requires an author");
    return null;
  }
  author = author.toLowerCase();
  if (!CHAT_ENABLED) {
    const msg = {
      id: generateLocalId(),
      slug,
      author,
      text,
      tokenId,
      likes: [],
      timestamp: Date.now(),
    };
    const all = loadLocal(slug);
    all.push(msg);
    saveLocal(all, slug);
    return msg;
  }

  const { data, error } = await supabase
    .from("messages")
    .insert({ author, text, token_id: tokenId, slug })
    .select()
    .single();

  if (error) {
    console.error("[supabase] sendMessage error:", error);
    return null;
  }
  return rowToMsg(data);
}

/**
 * Toggle a like on a message.
 * @param {{ messageId: string, wallet: string }} params
 * @returns {Promise<object|null>}
 */
export async function toggleLike({ messageId, wallet, slug }) {
  wallet = wallet ? wallet.toLowerCase() : wallet;
  if (!CHAT_ENABLED) {
    const all = loadLocal(slug);
    const updated = all.map((m) => {
      if (m.id !== messageId) return m;
      const already = m.likes.some((w) => w.toLowerCase() === wallet.toLowerCase());
      return {
        ...m,
        likes: already
          ? m.likes.filter((w) => w.toLowerCase() !== wallet.toLowerCase())
          : [...m.likes, wallet],
      };
    });
    saveLocal(updated, slug);
    const msg = updated.find((m) => m.id === messageId);
    return msg || null;
  }

  // Use atomic RPC function to avoid race conditions when
  // multiple users like the same message simultaneously.
  const { data, error } = await supabase
    .rpc("toggle_like", { msg_id: messageId, wallet })
    .single();

  if (error) {
    // The RPC function is the only safe way to toggle likes atomically.
    // A read-then-write fallback would have a TOCTOU race condition where
    // concurrent likes could overwrite each other. Fail gracefully instead.
    console.error("[supabase] toggleLike RPC unavailable:", error.message);
    return null;
  }
  return rowToMsg(data);
}

/**
 * Subscribe to real-time message inserts and updates.
 * @param {(payload: { eventType: string, new: object, old: object }) => void} callback
 * @returns {{ unsubscribe: () => void }} A handle with an unsubscribe method.
 */
export function subscribeToMessages(callback, { slug } = {}) {
  if (!slug) {
    console.error("[supabase] subscribeToMessages requires a collection slug");
    return { unsubscribe: () => {} };
  }
  if (!CHAT_ENABLED) {
    // No real-time in local mode; return a no-op handle.
    return { unsubscribe: () => {} };
  }

  const filterSlug = slug;
  const channel = supabase
    .channel(`messages-realtime-${filterSlug}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "messages",
        filter: `slug=eq.${filterSlug}`,
      },
      (payload) => {
        callback({
          eventType: payload.eventType,
          new: payload.new ? rowToMsg(payload.new) : null,
          old: payload.old ? rowToMsg(payload.old) : null,
        });
      }
    )
    .subscribe();

  return {
    unsubscribe: () => {
      supabase.removeChannel(channel);
    },
  };
}
