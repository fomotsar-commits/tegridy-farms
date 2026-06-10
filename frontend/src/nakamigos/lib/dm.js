/**
 * Direct messages — server-mediated through /api/supabase-proxy.
 *
 * Why not Supabase Realtime: the SIWE JWT lives in an httpOnly cookie that
 * client JS (and therefore the Realtime socket) can never read, and DM rows
 * are RLS-hidden from the anon key. The proxy attaches the cookie JWT
 * server-side, so RLS scopes every read/write to the authenticated wallet.
 * Threads poll while open (15s — inside the proxy's 20/min wallet budget).
 *
 * Requires: SIWE sign-in (401 surfaces as needsAuth) and migration 007
 * (absence surfaces as a generic failure → callers show "not enabled yet").
 */

const PROXY = "/api/supabase-proxy";

export const dmChannelKey = (a, b) => {
  const x = (a || "").toLowerCase();
  const y = (b || "").toLowerCase();
  return x < y ? `${x}_${y}` : `${y}_${x}`;
};

async function proxyCall(payload) {
  const res = await fetch(PROXY, {
    method: "POST",
    credentials: "include", // the SIWE httpOnly cookie
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    const err = new Error("Sign-in required");
    err.needsAuth = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Proxy ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const rowToDm = (row) => ({
  id: row.id,
  channelKey: row.channel_key,
  sender: row.sender,
  recipient: row.recipient,
  text: row.text,
  tradeId: row.trade_id || null,
  readAt: row.read_at || null,
  timestamp: new Date(row.created_at).getTime(),
});

/** Messages in one thread (RLS already limits to the caller's threads). */
export async function fetchThread(me, other) {
  const rows = await proxyCall({
    table: "dm_messages",
    method: "SELECT",
    match: { channel_key: dmChannelKey(me, other) },
  });
  return (Array.isArray(rows) ? rows : []).map(rowToDm);
}

/**
 * Conversation list: union of sent + received, grouped by channel, newest
 * first. Two filtered reads because the minimal SELECT path has no or=().
 */
export async function fetchConversations(me) {
  const w = (me || "").toLowerCase();
  const [sent, received] = await Promise.all([
    proxyCall({ table: "dm_messages", method: "SELECT", match: { sender: w } }),
    proxyCall({ table: "dm_messages", method: "SELECT", match: { recipient: w } }),
  ]);
  const byChannel = new Map();
  for (const row of [...(sent || []), ...(received || [])]) {
    const m = rowToDm(row);
    const existing = byChannel.get(m.channelKey);
    const peer = m.sender.toLowerCase() === w ? m.recipient : m.sender;
    if (!existing || m.timestamp > existing.last.timestamp) {
      byChannel.set(m.channelKey, {
        channelKey: m.channelKey,
        peer,
        last: m,
        unread: existing?.unread || 0,
      });
    }
    if (m.recipient.toLowerCase() === w && !m.readAt) {
      const slot = byChannel.get(m.channelKey);
      slot.unread = (slot.unread || 0) + 1;
    }
  }
  return [...byChannel.values()].sort((a, b) => b.last.timestamp - a.last.timestamp);
}

export async function sendDm({ me, other, text, tradeId = null }) {
  const sender = (me || "").toLowerCase();
  const recipient = (other || "").toLowerCase();
  const row = await proxyCall({
    table: "dm_messages",
    method: "INSERT",
    body: {
      sender,
      recipient,
      channel_key: dmChannelKey(sender, recipient),
      text,
      ...(tradeId ? { trade_id: tradeId } : {}),
    },
  });
  const inserted = Array.isArray(row) ? row[0] : row;
  return inserted ? rowToDm(inserted) : null;
}

/** Mark everything the peer sent me in this thread as read (one PATCH). */
export async function markThreadRead(me, other) {
  try {
    await proxyCall({
      table: "dm_messages",
      method: "UPDATE",
      body: { read_at: new Date().toISOString() },
      match: { channel_key: dmChannelKey(me, other), recipient: (me || "").toLowerCase() },
    });
  } catch { /* cosmetic — unread badges self-heal on next send */ }
}
