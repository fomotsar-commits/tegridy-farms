/**
 * SIWE-VERIFIED RLS POLICIES
 *
 * The messages table INSERT policy now requires SIWE JWT verification.
 * The `author` field must match the `wallet` claim in the JWT issued by
 * /api/auth/siwe. See supabase/migrations/001_siwe_auth_rls.sql for the
 * secure policy definitions that replace the old open `WITH CHECK (true)` policies.
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
 *   -- SIWE-verified insert (see supabase/migrations/001_siwe_auth_rls.sql)
 *   CREATE POLICY "Verified can insert" ON messages FOR INSERT WITH CHECK (
 *     author = lower(current_setting('request.jwt.claims', true)::json->>'wallet')
 *     AND char_length(text) <= 280 AND char_length(slug) <= 64
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
import { proxyWrite, proxyRpc, firstRow } from "./supabaseProxy";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const CHAT_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

// The SIWE JWT is stored in an httpOnly cookie (inaccessible to client JS).
// The Supabase client uses the anon key for READ operations only.
// All WRITE operations (insert/update/delete) should go through the
// /api/supabase-proxy endpoint which reads the httpOnly cookie and forwards
// the JWT to Supabase, satisfying the RLS wallet verification policies.
export const supabase = CHAT_ENABLED
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
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
    reactions: row.reactions ?? {},
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
    if (import.meta.env.DEV) console.error("[supabase] fetchMessages requires a collection slug");
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
    if (import.meta.env.DEV) console.error("[supabase] fetchMessages error:", error);
    // null (not []) so the caller can tell "backend unreachable" apart from
    // "no messages yet" — rendering the cheerful be-the-first empty state
    // over a fetch failure would misreport a chat that actually has history.
    return null;
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
    if (import.meta.env.DEV) console.error("[supabase] sendMessage requires a collection slug");
    return null;
  }
  if (!author) {
    if (import.meta.env.DEV) console.error("[supabase] sendMessage requires an author");
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

  // F711: route the write through the SIWE proxy. The anon client's insert is
  // rejected by the messages RLS (author must equal the JWT wallet), so chat
  // send failed for everyone. The proxy attaches the cookie JWT server-side.
  try {
    const data = await proxyWrite({
      table: "messages",
      method: "INSERT",
      // Coerce token_id to a string: the proxy schema is z.string().nullable(),
      // so a numeric tokenId (per-NFT chat) would be rejected as "Invalid payload
      // shape". Mirrors the String(id) coercion used throughout userdata.js.
      body: { author, text, token_id: tokenId == null ? null : String(tokenId), slug },
    });
    const row = firstRow(data);
    return row ? rowToMsg(row) : null;
  } catch (err) {
    if (err.needsAuth) throw err; // caller prompts SIWE sign-in
    if (import.meta.env.DEV) console.error("[supabase] sendMessage error:", err.message);
    return null;
  }
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

  // F713: route through the SIWE proxy. toggle_like requires the JWT wallet
  // (anon EXECUTE revoked in migration 004), so the anon client's call was a
  // silent no-op. The proxy injects the verified wallet server-side; the RPC is
  // still atomic so concurrent likes can't clobber each other.
  try {
    const data = await proxyRpc("toggle_like", { msg_id: messageId });
    const row = firstRow(data);
    return row ? rowToMsg(row) : null;
  } catch (err) {
    if (err.needsAuth) throw err; // caller prompts SIWE sign-in
    if (import.meta.env.DEV) console.error("[supabase] toggleLike unavailable:", err.message);
    return null;
  }
}

// Fixed set, mirrored in the toggle_reaction RPC's allowlist.
export const REACTION_EMOJIS = ["👍", "🔥", "💎", "😂", "🫡", "📈"];

/**
 * Toggle an emoji reaction on a message. Atomic via the toggle_reaction RPC
 * (same pattern as toggle_like). Local mode mirrors the likes fallback.
 * Returns the updated message, or null when unavailable (e.g. migration 007
 * not applied yet — callers degrade silently).
 */
export async function toggleReaction({ messageId, wallet, emoji, slug }) {
  if (!REACTION_EMOJIS.includes(emoji) || !wallet) return null;
  const w = wallet.toLowerCase();
  if (!CHAT_ENABLED) {
    const all = loadLocal(slug);
    const updated = all.map((m) => {
      if (m.id !== messageId) return m;
      const reactions = { ...(m.reactions || {}) };
      const arr = reactions[emoji] || [];
      const has = arr.some((x) => x.toLowerCase() === w);
      const next = has ? arr.filter((x) => x.toLowerCase() !== w) : [...arr, w];
      if (next.length === 0) delete reactions[emoji]; else reactions[emoji] = next;
      return { ...m, reactions };
    });
    saveLocal(updated, slug);
    return updated.find((m) => m.id === messageId) || null;
  }
  // F714: route through the SIWE proxy, which injects the JWT-verified wallet —
  // the anon RPC trusted its `wallet` arg (spoofable as any wallet) and migration
  // 005 revokes anon EXECUTE so the proxy is the only call path. `w` (the local
  // lower-cased wallet) is still used for the local-mode fallback above.
  try {
    const data = await proxyRpc("toggle_reaction", { msg_id: messageId, emoji });
    const row = firstRow(data);
    return row ? rowToMsg(row) : null;
  } catch (err) {
    if (err.needsAuth) throw err; // caller prompts SIWE sign-in
    if (import.meta.env.DEV) console.error("[supabase] toggleReaction unavailable:", err.message);
    return null;
  }
}

/**
 * Presence for a collection room: who's online right now. Supabase Presence
 * ships with Realtime — no extra infra. No-op handle in local mode.
 * @param {string} slug
 * @param {string|null} wallet  tracked key; anonymous viewers count too
 * @param {(count: number) => void} onCount
 */
export function joinPresence(slug, wallet, onCount) {
  if (!CHAT_ENABLED || !slug) return { leave: () => {} };
  const channel = supabase.channel(`presence-${slug}`, {
    config: { presence: { key: wallet ? wallet.toLowerCase() : `anon-${Math.random().toString(36).slice(2, 10)}` } },
  });
  channel
    .on("presence", { event: "sync" }, () => {
      try {
        onCount(Object.keys(channel.presenceState()).length);
      } catch { /* count is cosmetic */ }
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") channel.track({ at: Date.now() });
    });
  return { leave: () => { supabase.removeChannel(channel); } };
}

/**
 * Subscribe to real-time message inserts and updates.
 * @param {(payload: { eventType: string, new: object, old: object }) => void} callback
 * @returns {{ unsubscribe: () => void }} A handle with an unsubscribe method.
 */
export function subscribeToMessages(callback, { slug } = {}) {
  if (!slug) {
    if (import.meta.env.DEV) console.error("[supabase] subscribeToMessages requires a collection slug");
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
